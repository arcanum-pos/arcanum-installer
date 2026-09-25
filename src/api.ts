// The setup page's JSON API. Everything but /api/login needs a session.
// Nothing here ever returns the Cloudflare token, the client secret or a
// generated secret — only whether they're set.
import type { Env } from './env';
import { checkLoginAllowed, clearedCookie, newSessionCookie, passwordMatches, recordLoginFailure, sessionFrom } from './auth';
import { Cloudflare, CloudflareError } from './cloudflare';
import type { WorkerDescriptor } from './contract';
import { compareVersions, fetchIndex, fetchManifest, fetchReleaseJson, installable, ReleaseError } from './releases';
import { INSTALLER_KEY_SECRET, installationStarted, isAdmin, loadState, publicUrl, saveState, sealValue, unsealValue, workersDevUrl, type InstallerState } from './state';
import { bffSupportsInstaller, blueprintFrom, planSteps, runStep } from './steps';
import { generateSecret, safeEqual } from './crypto';
import { checkClients } from './idp-check';

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

// How this request was let in: the password session on the installer's own
// address, or forwarded by Arcanum's bff for a logged-in admin.
export type Access = { via: 'password'; sessionId: string } | { via: 'arcanum'; sessionId: string; email: string };

// Arcanum's bff forwards /installer/* with the shared key and the user's
// identity (it strips both from what the browser sends). A wrong key is
// refused outright; the password session isn't looked at then.
async function arcanumAccess(env: Env, state: InstallerState, request: Request): Promise<Access | Response | null> {
  const key = request.headers.get('X-Installer-Key');
  if (key === null) return null;
  const expected = state.behindArcanum && state.secrets ? (JSON.parse(await unsealValue(env, state, state.secrets)) as Record<string, string>)[INSTALLER_KEY_SECRET] : undefined;
  if (!expected || !safeEqual(key, expected)) return json({ error: 'Ongeldige sleutel van Arcanum' }, 401);
  const email = (request.headers.get('X-User-Email') ?? '').trim().toLowerCase();
  if (!email || !isAdmin(state, email)) return json({ error: `${email || 'Dit account'} staat niet in de lijst met beheerders van deze installatie`, forbidden: true }, 403);
  return { via: 'arcanum', sessionId: `arcanum:${email}`, email };
}

// The installer's own Worker name, from its workers.dev address
// (<script>.<subdomain>.workers.dev) — the bff's service binding needs it.
function installerScript(state: InstallerState, request: Request): string {
  const host = new URL(request.url).hostname;
  const suffix = `.${state.cloudflare?.subdomain}.workers.dev`;
  const label = host.endsWith(suffix) ? host.slice(0, -suffix.length) : '';
  if (/^[a-z0-9-]+$/.test(label)) return label;
  return state.behindArcanum?.script ?? 'arcanum-installer';
}

export async function status(env: Env, state: InstallerState, sessionId: string, access?: Access) {
  const url = publicUrl(state);
  const steps = state.release ? planSteps(state.release.blueprint).map((s) => ({ ...s, ...(state.steps[s.id] ?? { status: 'todo' }) })) : [];
  return {
    tokenTemplateUrl: TOKEN_TEMPLATE_URL,
    cloudflare: state.cloudflare
      ? { accountId: state.cloudflare.accountId, accountName: state.cloudflare.accountName, subdomain: state.cloudflare.subdomain, remember: state.cloudflare.remember, tokenAvailable: !!(await tokenFor(env, state, sessionId)) }
      : null,
    address: url ? { publicUrl: url, callbackUrl: `${url}/callback`, logoutUrl: url, customDomain: state.customDomain ?? null, workersDevUrl: workersDevUrl(state) } : null,
    login: state.login
      ? {
          issuer: state.login.issuer,
          clientId: state.login.clientId,
          connectionName: state.login.connectionName ?? null,
          clientSecretSet: true,
          scopes: state.login.scopes ?? null,
          authCodeClientId: state.login.authCodeClientId ?? null,
          authCodeClientSecretSet: !!state.login.authCodeClientSecret,
        }
      : null,
    admins: state.admins ?? null,
    release: state.release ? { version: state.release.version, components: state.release.manifest.components } : null,
    locked: installationStarted(state),
    steps,
    installed: state.installed ?? null,
    probeUrl: url && state.probePath ? `${url}${state.probePath}` : null,
    access: access ? { via: access.via, email: access.via === 'arcanum' ? access.email : null } : null,
    behindArcanum: state.behindArcanum ? { installerUrl: url ? `${url}/installer/` : null, publicAccessRemoved: !!state.behindArcanum.publicAccessRemoved } : null,
  };
}

export async function handleApi(request: Request, env: Env, path: string): Promise<Response> {
  if (!env.INSTALLER_PASSWORD) return json({ error: 'INSTALLER_PASSWORD is niet ingesteld op deze Worker' }, 500);

  // No cross-site requests, and JSON bodies only: another site must never
  // drive this API with the admin's cookie — the password session's, or
  // Arcanum's behind /installer (SameSite=Lax; this doesn't rely on that).
  if (request.method !== 'GET') {
    if (request.headers.get('Sec-Fetch-Site') === 'cross-site') return json({ error: 'Niet toegestaan vanaf een andere site' }, 403);
    if (!(request.headers.get('Content-Type') ?? '').includes('application/json')) return json({ error: 'Verwacht JSON' }, 415);
  }

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

  const state = await loadState(env);
  const viaArcanum = await arcanumAccess(env, state, request);
  if (viaArcanum instanceof Response) return viaArcanum;
  let access: Access | null = viaArcanum;
  if (!access) {
    const id = await sessionFrom(env, request);
    if (!id) return json({ error: 'Niet aangemeld' }, 401);
    access = { via: 'password', sessionId: id };
  }
  const sessionId = access.sessionId;

  if (path === '/api/logout' && request.method === 'POST') {
    await env.INSTALLER_STATE.delete(`session-token:${sessionId}`);
    return json({ ok: true }, 200, access.via === 'password' ? { 'Set-Cookie': clearedCookie } : {});
  }

  if (path === '/api/status' && request.method === 'GET') return json(await status(env, state, sessionId, access));

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
      return json(await status(env, state, sessionId, access));
    }

    if (path === '/api/login-provider' && request.method === 'POST') {
      const b = await body(request);
      const issuer = typeof b.issuer === 'string' ? b.issuer.trim().replace(/\/+$/, '') : '';
      const clientId = typeof b.clientId === 'string' ? b.clientId.trim() : '';
      const clientSecret = typeof b.clientSecret === 'string' ? b.clientSecret.trim() : '';
      const connectionName = typeof b.connectionName === 'string' && b.connectionName.trim() ? b.connectionName.trim() : undefined;
      const isGoogle = /^https:\/\/accounts\.google\.com$/.test(issuer);
      // Google rejects the platform's default `offline_access` scope.
      const scopes = (typeof b.scopes === 'string' && b.scopes.trim().replace(/\s+/g, ' ')) || (isGoogle ? 'openid profile email' : undefined);
      if (scopes && !scopes.split(' ').includes('openid')) return json({ error: 'De scopes moeten minstens "openid" bevatten' }, 400);
      const authCodeClientId = typeof b.authCodeClientId === 'string' && b.authCodeClientId.trim() ? b.authCodeClientId.trim() : undefined;
      const authCodeClientSecret = typeof b.authCodeClientSecret === 'string' ? b.authCodeClientSecret.trim() : '';
      const keepAuthCodeSecret = authCodeClientId && !authCodeClientSecret && state.login?.authCodeClientId === authCodeClientId ? state.login.authCodeClientSecret : undefined;
      if (authCodeClientId && !authCodeClientSecret && !keepAuthCodeSecret) return json({ error: 'Geef ook het secret van de aparte browser-client' }, 400);
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
      // Test the clients with the provider before saving anything.
      const kassaSecret = clientSecret || (state.login ? await unsealValue(env, state, state.login.clientSecret) : '');
      const browserSecret = authCodeClientSecret || (keepAuthCodeSecret ? await unsealValue(env, state, keepAuthCodeSecret) : '');
      const checks =
        typeof discovery.token_endpoint === 'string'
          ? await checkClients({
              deviceEndpoint: discovery.device_authorization_endpoint,
              tokenEndpoint: discovery.token_endpoint,
              isGoogle,
              clientId,
              clientSecret: kassaSecret,
              scopes: scopes ?? 'openid profile email offline_access',
              authCode: authCodeClientId ? { clientId: authCodeClientId, clientSecret: browserSecret, redirectUri: `${publicUrl(state) ?? issuer}/callback` } : undefined,
            })
          : [];
      const refused = checks.filter((c) => c.blocking);
      if (refused.length) return json({ error: refused.map((c) => c.message).join(' '), checks }, 400);

      state.login = {
        issuer,
        clientId,
        clientSecret: clientSecret ? await sealValue(env, state, clientSecret) : state.login!.clientSecret,
        connectionName,
        authorizationEndpoint: discovery.authorization_endpoint,
        scopes,
        authCodeClientId,
        authCodeClientSecret: authCodeClientId ? (authCodeClientSecret ? await sealValue(env, state, authCodeClientSecret) : keepAuthCodeSecret) : undefined,
      };
      // Already installed? Re-deploy the backend with the new settings and
      // let it re-seed the login provider ("Verder installeren" applies it).
      for (const step of ['worker:arcanum-backend', 'login:reset', 'verify']) delete state.steps[step];
      await saveState(env, state);
      return json({ ...(await status(env, state, sessionId, access)), checks });
    }

    if (path === '/api/address' && request.method === 'POST') {
      const { customDomain } = await body(request);
      const host = typeof customDomain === 'string' ? customDomain.trim().toLowerCase().replace(/\.$/, '') : '';
      if (host && !/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host)) {
        return json({ error: 'Geef alleen de domeinnaam, bv. arcanum.jouwdomein.be (zonder https:// of pad)' }, 400);
      }
      if ((state.customDomain ?? '') !== host) {
        if (host) state.customDomain = host;
        else delete state.customDomain;
        // Already installed: re-deploy with the new address (the bff step attaches the domain).
        for (const step of ['worker:arcanum-backend', 'worker:arcanum-bff', 'verify']) delete state.steps[step];
      }
      await saveState(env, state);
      return json(await status(env, state, sessionId, access));
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
      return json(await status(env, state, sessionId, access));
    }

    if (path === '/api/releases' && request.method === 'GET') {
      const index = await fetchIndex(env.RELEASES_INDEX_URL);
      return json({ latest: index.latest, installed: state.installed?.version ?? null, releases: installable(index).map((r) => ({ version: r.version, prerelease: r.prerelease, releasedAt: r.released_at, notesUrl: r.notes_url })) });
    }

    if (path === '/api/release' && request.method === 'POST') {
      const { version } = await body(request);
      // Installed: only a newer version (an update — every step runs again).
      if (state.installed && compareVersions(String(version), state.installed.version) <= 0) {
        return json({ error: `Arcanum ${state.installed.version} is geïnstalleerd — kies een nieuwere versie om bij te werken` }, 409);
      }
      const index = await fetchIndex(env.RELEASES_INDEX_URL);
      const entry = installable(index).find((r) => r.version === version);
      if (!entry) return json({ error: `Release ${String(version)} bestaat niet of kan niet door deze installer geïnstalleerd worden` }, 400);
      const manifest = await fetchManifest(entry.manifest_url);
      const names = Object.keys(manifest.components);
      const descriptors = await Promise.all(names.map((n) => fetchReleaseJson<WorkerDescriptor>(entry.manifest_url, manifest, `${n}.json`)));
      const database = await fetchReleaseJson<{ databases: { name: string; tracked: boolean }[] }>(entry.manifest_url, manifest, 'database.json');
      // A different version before the install completed: run every step
      // again for it (resources and generated secrets are kept — all steps
      // are idempotent), so no Worker of the old version stays behind.
      if (state.release && state.release.version !== manifest.version) {
        state.steps = {};
        delete state.assets;
      }
      state.release = { version: manifest.version, manifestUrl: entry.manifest_url, manifest, blueprint: blueprintFrom(manifest, descriptors, database) };
      await saveState(env, state);
      return json(await status(env, state, sessionId, access));
    }

    if (path.startsWith('/api/public-access')) {
      if (!state.installed || !state.cloudflare) return json({ error: 'Installeer Arcanum eerst volledig' }, 409);
      const token = await tokenFor(env, state, sessionId);
      const cf = token ? cloudflareFor(env, token) : null;
      const script = state.behindArcanum?.script ?? installerScript(state, request);
      const directUrl = `https://${script}.${state.cloudflare.subdomain}.workers.dev`;

      if (path === '/api/public-access' && request.method === 'GET') {
        const bff = state.release!.blueprint.workers.find((w) => w.public_entry)!;
        const descriptor = await fetchReleaseJson<WorkerDescriptor>(state.release!.manifestUrl, state.release!.manifest, bff.file);
        return json({
          supported: bffSupportsInstaller(descriptor),
          linked: !!state.behindArcanum,
          installerUrl: `${publicUrl(state)}/installer/`,
          directUrl,
          // Live from Cloudflare: re-deploying the installer turns it back on.
          directEnabled: cf ? await cf.isOnWorkersDev(state.cloudflare.accountId, script).catch(() => null) : null,
          via: access.via,
        });
      }
      if (!cf) return json({ error: 'Plak het Cloudflare-token opnieuw (het werd niet onthouden)', needsToken: true }, 409);

      if (path === '/api/public-access/link' && request.method === 'POST') {
        const bff = state.release!.blueprint.workers.find((w) => w.public_entry)!;
        const descriptor = await fetchReleaseJson<WorkerDescriptor>(state.release!.manifestUrl, state.release!.manifest, bff.file);
        if (!bffSupportsInstaller(descriptor)) return json({ error: `Arcanum ${state.release!.version} kan de installer nog niet doorgeven — werk eerst bij naar een nieuwere versie (stap 4)` }, 409);
        const target = installerScript(state, request);
        if (!(await cf.scriptExists(state.cloudflare.accountId, target))) return json({ error: `Geen Worker ${target} gevonden op dit account — open de installer via zijn eigen workers.dev-adres en probeer opnieuw` }, 409);
        const secrets = state.secrets ? (JSON.parse(await unsealValue(env, state, state.secrets)) as Record<string, string>) : {};
        secrets[INSTALLER_KEY_SECRET] ??= generateSecret('hex32');
        state.secrets = await sealValue(env, state, JSON.stringify(secrets));
        state.behindArcanum = { script: target };
        // Re-deploy the bff with the binding and the key, right away.
        const outcome = await runStep(`worker:${bff.name}`, { env, state, cf });
        state.steps[`worker:${bff.name}`] = { status: 'done', at: new Date().toISOString(), detail: outcome.detail };
        await saveState(env, state);
        return json(await status(env, state, sessionId, access));
      }

      if (path === '/api/public-access/remove' && request.method === 'POST') {
        // Only from a request that came through Arcanum: that's the proof
        // the installer stays reachable once its own address is gone.
        if (!state.behindArcanum) return json({ error: 'Maak de installer eerst bereikbaar via Arcanum' }, 409);
        if (access.via !== 'arcanum') return json({ error: `Open de installer via ${publicUrl(state)}/installer/ en schakel het openbare adres daar uit — zo weet je zeker dat hij bereikbaar blijft` }, 409);
        await cf.setWorkersDev(state.cloudflare.accountId, state.behindArcanum.script, false);
        state.behindArcanum.publicAccessRemoved = true;
        await saveState(env, state);
        return json(await status(env, state, sessionId, access));
      }

      if (path === '/api/public-access/restore' && request.method === 'POST') {
        if (!state.behindArcanum) return json({ error: 'Het openbare adres is niet uitgeschakeld' }, 409);
        await cf.setWorkersDev(state.cloudflare.accountId, state.behindArcanum.script, true);
        state.behindArcanum.publicAccessRemoved = false;
        await saveState(env, state);
        return json(await status(env, state, sessionId, access));
      }
    }

    // POST /api/step {id} — what the page uses: the id in the body, because
    // an id like "assets:…-01.json" in the path looks like a file to
    // Arcanum's bff, which 404s unexpected extensions before routing.
    // /api/steps/:id is the older form of the same.
    const stepMatch = path.match(/^\/api\/steps\/(.+)$/);
    const isStep = request.method === 'POST' && (path === '/api/step' || !!stepMatch);
    if (isStep) {
      const stepId = stepMatch ? decodeURIComponent(stepMatch[1]) : (await body(request)).id;
      if (typeof stepId !== 'string') return json({ error: 'Geef de stap (id)' }, 400);
      const id = stepId;
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
