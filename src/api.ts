// The setup page's JSON API. Everything but /api/login needs a session.
// Nothing here ever returns the Cloudflare token, the client secret or a
// generated secret — only whether they're set.
import type { Env } from './env';
import { checkLoginAllowed, clearedCookie, newSessionCookie, passwordMatches, recordLoginFailure, sessionFrom } from './auth';
import { Cloudflare, CloudflareError } from './cloudflare';
import type { WorkerDescriptor } from './contract';
import { fetchIndex, fetchManifest, fetchReleaseJson, installable, ReleaseError } from './releases';
import { installationStarted, loadState, publicUrl, saveState, sealValue, unsealValue, type InstallerState } from './state';
import { blueprintFrom, planSteps, runStep } from './steps';

const TOKEN_PERMISSIONS = [
  { key: 'workers_scripts', type: 'edit' },
  { key: 'd1', type: 'edit' },
  { key: 'workers_kv_storage', type: 'edit' },
  { key: 'account_settings', type: 'read' },
];

export const TOKEN_TEMPLATE_URL =
  'https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=' +
  encodeURIComponent(JSON.stringify(TOKEN_PERMISSIONS)) +
  '&accountId=*&zoneId=all&name=arcanum-installer';

const SESSION_TOKEN_TTL_S = 2 * 60 * 60;

// "Scouts Elewijt's Account" → "scouts-elewijt".
export function suggestSubdomain(accountName: string): string {
  const base = accountName
    .toLowerCase()
    .replace(/'s account$|\baccount\b/g, '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return base || 'arcanum';
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });
}

async function body(request: Request): Promise<Record<string, unknown>> {
  if (!(request.headers.get('Content-Type') ?? '').includes('application/json')) return {};
  return ((await request.json().catch(() => ({}))) || {}) as Record<string, unknown>;
}

async function tokenFor(env: Env, state: InstallerState, sessionId: string): Promise<string | null> {
  if (state.cloudflare?.remember && state.cloudflare.token) return unsealValue(env, state, state.cloudflare.token);
  const sealed = await env.INSTALLER_STATE.get<{ iv: string; data: string }>(`session-token:${sessionId}`, 'json');
  return sealed ? unsealValue(env, state, sealed) : null;
}

function cloudflareFor(env: Env, token: string) {
  return new Cloudflare(token, env.CLOUDFLARE_API_BASE);
}

export async function status(env: Env, state: InstallerState, sessionId: string) {
  const url = publicUrl(state);
  const steps = state.release ? planSteps(state.release.blueprint).map((s) => ({ ...s, ...(state.steps[s.id] ?? { status: 'todo' }) })) : [];
  return {
    tokenTemplateUrl: TOKEN_TEMPLATE_URL,
    cloudflare: state.cloudflare
      ? { accountId: state.cloudflare.accountId, accountName: state.cloudflare.accountName, subdomain: state.cloudflare.subdomain, remember: state.cloudflare.remember, tokenAvailable: !!(await tokenFor(env, state, sessionId)) }
      : null,
    address: url ? { publicUrl: url, callbackUrl: `${url}/callback`, logoutUrl: url } : null,
    login: state.login ? { issuer: state.login.issuer, clientId: state.login.clientId, connectionName: state.login.connectionName ?? null, clientSecretSet: true } : null,
    admins: state.admins ?? null,
    release: state.release ? { version: state.release.version, components: state.release.manifest.components } : null,
    locked: installationStarted(state),
    steps,
    installed: state.installed ?? null,
    probeUrl: url && state.probePath ? `${url}${state.probePath}` : null,
  };
}

export async function handleApi(request: Request, env: Env, path: string): Promise<Response> {
  if (!env.INSTALLER_PASSWORD) return json({ error: 'INSTALLER_PASSWORD is niet ingesteld op deze Worker' }, 500);

  if (path === '/api/login' && request.method === 'POST') {
    const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
    if (!(await checkLoginAllowed(env, ip))) return json({ error: 'Te veel mislukte pogingen — probeer het over 15 minuten opnieuw' }, 429);
    const { password } = await body(request);
    if (typeof password !== 'string' || !passwordMatches(env, password)) {
      await recordLoginFailure(env, ip);
      return json({ error: 'Onjuist wachtwoord' }, 401);
    }
    const session = await newSessionCookie(env);
    return json({ ok: true }, 200, { 'Set-Cookie': session.cookie });
  }

  const sessionId = await sessionFrom(env, request);
  if (!sessionId) return json({ error: 'Niet aangemeld' }, 401);

  if (path === '/api/logout' && request.method === 'POST') {
    await env.INSTALLER_STATE.delete(`session-token:${sessionId}`);
    return json({ ok: true }, 200, { 'Set-Cookie': clearedCookie });
  }

  const state = await loadState(env);

  if (path === '/api/status' && request.method === 'GET') return json(await status(env, state, sessionId));

  try {
    if (path === '/api/cloudflare' && request.method === 'POST') {
      const { token, remember, accountId, subdomain: wantedSubdomain } = await body(request);
      if (typeof token !== 'string' || token.trim().length < 20) return json({ error: 'Plak het API-token van Cloudflare' }, 400);
      const cf = cloudflareFor(env, token.trim());
      const accounts = await cf.listAccounts();
      if (accounts.length === 0) return json({ error: 'Dit token ziet geen enkel account — geef het "Account Settings: Read"' }, 400);
      const account = accountId ? accounts.find((a) => a.id === accountId) : accounts.length === 1 ? accounts[0] : null;
      if (!account) return json({ needsAccount: true, accounts: accounts.map((a) => ({ id: a.id, name: a.name })) });
      if (installationStarted(state) && state.cloudflare && state.cloudflare.accountId !== account.id) {
        return json({ error: `Arcanum is al (deels) geïnstalleerd op account ${state.cloudflare.accountName} — gebruik een token voor dat account` }, 409);
      }
      let subdomain = await cf.getWorkersSubdomain(account.id);
      if (!subdomain) {
        // A brand-new account: register its workers.dev subdomain here instead
        // of sending the admin to the dashboard.
        if (typeof wantedSubdomain !== 'string' || !wantedSubdomain) {
          return json({ needsSubdomain: true, suggestion: suggestSubdomain(account.name) });
        }
        const name = wantedSubdomain.trim().toLowerCase();
        if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name)) {
          return json({ error: 'Gebruik alleen kleine letters, cijfers en koppeltekens (niet aan het begin of einde), max. 63 tekens' }, 400);
        }
        try {
          subdomain = await cf.registerWorkersSubdomain(account.id, name);
        } catch (err) {
          if (err instanceof CloudflareError) return json({ error: `Dat workers.dev-subdomein kon niet geregistreerd worden: ${err.message}` }, 400);
          throw err;
        }
      }
      // A cheap read of D1 checks the token reaches D1 at all; write rights show during the install.
      await cf.findD1(account.id, 'arcanum-backend');
      const keep = remember !== false;
      state.cloudflare = {
        accountId: account.id,
        accountName: account.name,
        subdomain,
        remember: keep,
        ...(keep ? { token: await sealValue(env, state, token.trim()) } : {}),
      };
      if (!keep) await env.INSTALLER_STATE.put(`session-token:${sessionId}`, JSON.stringify(await sealValue(env, state, token.trim())), { expirationTtl: SESSION_TOKEN_TTL_S });
      else await env.INSTALLER_STATE.delete(`session-token:${sessionId}`);
      await saveState(env, state);
      return json(await status(env, state, sessionId));
    }

    if (path === '/api/login-provider' && request.method === 'POST') {
      const b = await body(request);
      const issuer = typeof b.issuer === 'string' ? b.issuer.trim().replace(/\/+$/, '') : '';
      const clientId = typeof b.clientId === 'string' ? b.clientId.trim() : '';
      const clientSecret = typeof b.clientSecret === 'string' ? b.clientSecret.trim() : '';
      const connectionName = typeof b.connectionName === 'string' && b.connectionName.trim() ? b.connectionName.trim() : undefined;
      if (!/^https:\/\/[^/]+/.test(issuer)) return json({ error: 'De issuer-URL moet met https:// beginnen' }, 400);
      if (!clientId) return json({ error: 'Client ID ontbreekt' }, 400);
      if (!clientSecret && !state.login) return json({ error: 'Client secret ontbreekt' }, 400);
      // The same check the platform does at login: discovery must work and
      // offer the device login the kassa uses.
      const res = await fetch(`${issuer}/.well-known/openid-configuration`).catch(() => null);
      const discovery = res?.ok ? ((await res.json().catch(() => null)) as Record<string, unknown> | null) : null;
      if (!discovery || typeof discovery.authorization_endpoint !== 'string') {
        return json({ error: `Geen geldige OpenID-configuratie op ${issuer}/.well-known/openid-configuration` }, 400);
      }
      if (typeof discovery.device_authorization_endpoint !== 'string') {
        return json({ error: 'Deze login-provider ondersteunt geen apparaat-aanmelding (device authorization) — die is nodig voor de kassa' }, 400);
      }
      state.login = {
        issuer,
        clientId,
        clientSecret: clientSecret ? await sealValue(env, state, clientSecret) : state.login!.clientSecret,
        connectionName,
        authorizationEndpoint: discovery.authorization_endpoint,
      };
      await saveState(env, state);
      return json(await status(env, state, sessionId));
    }

    if (path === '/api/admins' && request.method === 'POST') {
      const { emails } = await body(request);
      const list = (typeof emails === 'string' ? emails : '')
        .split(/[,;\s]+/)
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean);
      if (list.length === 0) return json({ error: 'Geef minstens één e-mailadres (of *@jouwdomein.be)' }, 400);
      const bad = list.filter((e) => !/^(\*|[^@\s]+)@[^@\s]+\.[^@\s]+$/.test(e));
      if (bad.length) return json({ error: `Geen geldig adres: ${bad.join(', ')}` }, 400);
      state.admins = list.join(', ');
      await saveState(env, state);
      return json(await status(env, state, sessionId));
    }

    if (path === '/api/releases' && request.method === 'GET') {
      const index = await fetchIndex(env.RELEASES_INDEX_URL);
      return json({ latest: index.latest, releases: installable(index).map((r) => ({ version: r.version, prerelease: r.prerelease, releasedAt: r.released_at, notesUrl: r.notes_url })) });
    }

    if (path === '/api/release' && request.method === 'POST') {
      const { version } = await body(request);
      if (state.installed) return json({ error: 'Arcanum is al geïnstalleerd — bijwerken komt in een volgende versie van de installer' }, 409);
      const index = await fetchIndex(env.RELEASES_INDEX_URL);
      const entry = installable(index).find((r) => r.version === version);
      if (!entry) return json({ error: `Release ${String(version)} bestaat niet of kan niet door deze installer geïnstalleerd worden` }, 400);
      const manifest = await fetchManifest(entry.manifest_url);
      const names = Object.keys(manifest.components);
      const descriptors = await Promise.all(names.map((n) => fetchReleaseJson<WorkerDescriptor>(entry.manifest_url, manifest, `${n}.json`)));
      const database = await fetchReleaseJson<{ databases: { name: string; tracked: boolean }[] }>(entry.manifest_url, manifest, 'database.json');
      state.release = { version: manifest.version, manifestUrl: entry.manifest_url, manifest, blueprint: blueprintFrom(manifest, descriptors, database) };
      await saveState(env, state);
      return json(await status(env, state, sessionId));
    }

    const stepMatch = path.match(/^\/api\/steps\/(.+)$/);
    if (stepMatch && request.method === 'POST') {
      const id = decodeURIComponent(stepMatch[1]);
      const missing = [!state.cloudflare && 'Cloudflare-token', !state.login && 'login-provider', !state.admins && 'beheerders', !state.release && 'release'].filter(Boolean);
      if (missing.length) return json({ error: `Eerst nog: ${missing.join(', ')}` }, 409);
      if (!planSteps(state.release!.blueprint).some((s) => s.id === id)) return json({ error: `Onbekende stap ${id}` }, 404);
      const token = await tokenFor(env, state, sessionId);
      if (!token) return json({ error: 'Plak het Cloudflare-token opnieuw (het werd niet onthouden)', needsToken: true }, 409);
      try {
        const outcome = await runStep(id, { env, state, cf: cloudflareFor(env, token) });
        if (outcome.status === 'done') state.steps[id] = { status: 'done', at: new Date().toISOString(), detail: outcome.detail };
        await saveState(env, state);
        return json({ id, ...outcome });
      } catch (err) {
        state.steps[id] = { status: 'failed', at: new Date().toISOString(), detail: (err as Error).message };
        await saveState(env, state);
        return json({ id, status: 'failed', detail: (err as Error).message }, 200);
      }
    }
  } catch (err) {
    if (err instanceof CloudflareError) return json({ error: `Cloudflare: ${err.message}` }, err.status === 401 || err.status === 403 ? 400 : 502);
    if (err instanceof ReleaseError) return json({ error: err.message }, 502);
    throw err;
  }

  return json({ error: 'Not found' }, 404);
}
