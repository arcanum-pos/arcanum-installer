// The setup page's JSON API. Everything but signing in (/api/login,
// /api/login-options, /api/handoff) needs a session.
// Nothing here ever returns the Cloudflare token, the client secret or a
// generated secret — only whether they're set.
import type { Env } from './env';
import { checkLoginAllowed, clearedCookie, newSessionCookie, passwordMatches, recordLoginFailure, recoveryCodeMatches, sessionEmail, sessionFrom } from './auth';
import { handoff, isBootstrapped } from './bootstrap';
import { canSignInWithAccount } from './oidc';
import { Cloudflare, CloudflareError } from './cloudflare';
import type { WorkerDescriptor } from './contract';
import { compareVersions, fetchIndex, fetchManifest, fetchReleaseJson, installable, ReleaseError } from './releases';
import { INSTALLER_KEY_SECRET, installationStarted, isAdmin, loadState, publicUrl, rootSecret, saveState, sealValue, unsealValue, workersDevUrl, type InstallerState } from './state';
import { bffSupportsInstaller, blueprintFrom, planSteps, runStep } from './steps';
import { generateSecret, safeEqual } from './crypto';
import { applyChange, changeInfo, changesIdentity, dropExpiredSnapshot, providerIdentity, readLoginProvider, undoChange } from './login-change';

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

// How this request was let in: a session on the installer's own address
// (password, recovery code, handoff or account sign-in — with who, when
// known), or forwarded by Arcanum's bff for a logged-in admin.
export type Access = { via: 'session'; sessionId: string; email: string | null } | { via: 'arcanum'; sessionId: string; email: string };

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

// The installer's own address (the test sign-in's and its own sign-in's
// callbacks live there), also when the page is opened through Arcanum.
export function installerOrigin(state: InstallerState, request: Request): string {
  const own = new URL(request.url);
  if (state.cloudflare && own.hostname.endsWith(`.${state.cloudflare.subdomain}.workers.dev`)) return own.origin;
  return state.cloudflare ? `https://${installerScript(state, request)}.${state.cloudflare.subdomain}.workers.dev` : own.origin;
}

// The installer's own Worker name, from its workers.dev address
// (<script>.<subdomain>.workers.dev) — the bff's service binding needs it.
export function installerScript(state: InstallerState, request: Request): string {
  const host = new URL(request.url).hostname;
  const suffix = `.${state.cloudflare?.subdomain}.workers.dev`;
  const label = host.endsWith(suffix) ? host.slice(0, -suffix.length) : '';
  if (/^[a-z0-9-]+$/.test(label)) return label;
  return state.behindArcanum?.script ?? 'arcanum-installer';
}

export async function status(env: Env, state: InstallerState, sessionId: string, access?: Access) {
  const url = publicUrl(state);
  const steps = state.release ? planSteps(state.release.blueprint, state).map((s) => ({ ...s, ...(state.steps[s.id] ?? { status: 'todo' }) })) : [];
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
    access: access ? { via: access.via, email: access.email } : null,
    // Made by the bootstrapper: the page is one screen ("Installeren", the rest under "Geavanceerd").
    bootstrapped: state.bootstrap ? { owner: state.bootstrap.owner.email, issuer: state.bootstrap.login?.issuer ?? null } : null,
    installer: { release: env.INSTALLER_RELEASE ?? null, selfUpdate: state.selfUpdate ?? null },
    // "Aanmelding wijzigen": a staged provider, or a change that can still be undone.
    loginChange: {
      staged: state.loginChange?.staged ? { issuer: state.loginChange.staged.login.issuer } : null,
      applied: state.loginChange?.applied ? { at: state.loginChange.applied.at, undoUntil: state.loginChange.applied.undoUntil, phase: state.loginChange.applied.phase } : null,
    },
    behindArcanum: state.behindArcanum ? { installerUrl: url ? `${url}/installer/` : null, publicAccessRemoved: !!state.behindArcanum.publicAccessRemoved } : null,
  };
}

export async function handleApi(request: Request, env: Env, path: string): Promise<Response> {
  if (!rootSecret(env)) return json({ error: 'INSTALLER_PASSWORD (of INSTALLER_STATE_KEY) is niet ingesteld op deze Worker' }, 500);

  // No cross-site requests, and JSON bodies only: another site must never
  // drive this API with the admin's cookie — the password session's, or
  // Arcanum's behind /installer (SameSite=Lax; this doesn't rely on that).
  if (request.method !== 'GET') {
    if (request.headers.get('Sec-Fetch-Site') === 'cross-site') return json({ error: 'Niet toegestaan vanaf een andere site' }, 403);
    if (!(request.headers.get('Content-Type') ?? '').includes('application/json')) return json({ error: 'Verwacht JSON' }, 415);
  }

  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';

  // Which ways in this installer has (the page shows those).
  if (path === '/api/login-options' && request.method === 'GET') {
    const state = await loadState(env);
    return json({
      password: !!env.INSTALLER_PASSWORD,
      recoveryCode: !!state.bootstrap?.recoveryHash,
      account: canSignInWithAccount(state) ? { issuer: state.bootstrap!.login!.issuer } : null,
      // Uploaded by the bootstrapper, not handed over yet: only its link gets in.
      awaitingHandoff: !state.bootstrap && isBootstrapped(env, state),
    });
  }

  // The password (Deploy-button installers) or the recovery code (bootstrapped ones), one field.
  if (path === '/api/login' && request.method === 'POST') {
    if (!(await checkLoginAllowed(env, ip))) return json({ error: 'Te veel mislukte pogingen — probeer het over 15 minuten opnieuw' }, 429);
    const { password } = await body(request);
    const state = await loadState(env);
    const byPassword = typeof password === 'string' && passwordMatches(env, password);
    const byRecovery = !byPassword && typeof password === 'string' && (await recoveryCodeMatches(state, password));
    if (!byPassword && !byRecovery) {
      await recordLoginFailure(env, ip);
      return json({ error: env.INSTALLER_PASSWORD ? 'Onjuist wachtwoord' : 'Onjuiste herstelcode' }, 401);
    }
    const session = await newSessionCookie(env);
    return json({ ok: true }, 200, { 'Set-Cookie': session.cookie });
  }

  // The bootstrapper's link: /handoff?code=… → the page posts the code here.
  if (path === '/api/handoff' && request.method === 'POST') {
    if (!(await checkLoginAllowed(env, ip))) return json({ error: 'Te veel mislukte pogingen — probeer het over 15 minuten opnieuw' }, 429);
    const { code } = await body(request);
    const state = await loadState(env);
    const outcome = await handoff(env, state, typeof code === 'string' ? code.trim() : '', installerScript(state, request));
    if (!outcome.ok) {
      if (outcome.reason === 'wrong') await recordLoginFailure(env, ip);
      return json({ error: outcome.error, reason: outcome.reason }, outcome.status);
    }
    await saveState(env, state);
    return json({ ok: true, recoveryCode: outcome.recoveryCode, email: outcome.email, firstImport: outcome.firstImport }, 200, { 'Set-Cookie': outcome.cookie });
  }

  const state = await loadState(env);
  const viaArcanum = await arcanumAccess(env, state, request);
  if (viaArcanum instanceof Response) return viaArcanum;
  let access: Access | null = viaArcanum;
  if (!access) {
    const id = await sessionFrom(env, request);
    if (!id) return json({ error: 'Niet aangemeld' }, 401);
    access = { via: 'session', sessionId: id, email: await sessionEmail(env, id) };
  }
  const sessionId = access.sessionId;
  // "Terugzetten" is possible for 7 days after a login change, then the snapshot goes.
  if (dropExpiredSnapshot(state)) await saveState(env, state);

  if (path === '/api/logout' && request.method === 'POST') {
    await env.INSTALLER_STATE.delete(`session-token:${sessionId}`);
    return json({ ok: true }, 200, access.via === 'session' ? { 'Set-Cookie': clearedCookie } : {});
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
      // Installed: another provider (or client) means other (issuer, sub)
      // values for everyone — only through "Aanmelding wijzigen" (stage,
      // test, apply). The same provider and clients (a new secret, scopes)
      // are still saved here.
      if (state.installed && state.login && changesIdentity(providerIdentity(b), state.login)) {
        return json({ error: 'Arcanum is al geïnstalleerd: een andere login-provider of client gaat via "Aanmelding wijzigen" (klaarzetten, test-aanmelding, toepassen) — anders kan niemand zich nog aanmelden.', useLoginChange: true }, 409);
      }
      const read = await readLoginProvider(env, state, b, state.login);
      if (!read.ok) return json({ error: read.error, ...(read.checks ? { checks: read.checks } : {}) }, read.status);
      state.login = read.login;
      // Already installed? Re-deploy the backend with the new settings and
      // let it re-seed the login provider ("Verder installeren" applies it).
      for (const step of ['worker:arcanum-backend', 'login:reset', 'verify']) delete state.steps[step];
      await saveState(env, state);
      return json({ ...(await status(env, state, sessionId, access)), checks: read.checks });
    }

    // "Aanmelding wijzigen" (login-change.ts).
    if (path.startsWith('/api/login-change')) {
      const token = await tokenFor(env, state, sessionId);
      const cf = token ? cloudflareFor(env, token) : null;
      const origin = installerOrigin(state, request);
      if (path === '/api/login-change' && request.method === 'GET') return json(await changeInfo(env, state, sessionId, origin, cf));
      if (!state.installed) return json({ error: 'Nog niet geïnstalleerd: kies de login-provider gewoon bij stap 2' }, 409);

      if (path === '/api/login-change/stage' && request.method === 'POST') {
        if (state.loginChange?.applied?.phase === 'started') return json({ error: 'Een vorige wijziging is halverwege gestopt — maak ze eerst af (Toepassen) of zet ze terug' }, 409);
        const b = await body(request);
        const fallback = state.loginChange?.staged?.login.issuer === providerIdentity(b).issuer ? state.loginChange.staged.login : state.login;
        const read = await readLoginProvider(env, state, b, fallback);
        if (!read.ok) return json({ error: read.error, ...(read.checks ? { checks: read.checks } : {}) }, read.status);
        state.loginChange = { ...state.loginChange, staged: { login: read.login, at: new Date().toISOString() } };
        delete state.loginChange.test;
        await saveState(env, state);
        return json({ ...(await changeInfo(env, state, sessionId, origin, cf)), checks: read.checks });
      }

      if (path === '/api/login-change/cancel' && request.method === 'POST') {
        if (state.loginChange?.applied?.phase === 'started') return json({ error: 'Deze wijziging is halverwege — maak ze af (Toepassen) of zet ze terug' }, 409);
        if (state.loginChange) {
          delete state.loginChange.staged;
          delete state.loginChange.test;
        }
        await saveState(env, state);
        return json(await changeInfo(env, state, sessionId, origin, cf));
      }

      if (path === '/api/login-change/apply' || path === '/api/login-change/undo') {
        if (request.method !== 'POST') return json({ error: 'Not found' }, 404);
        if (!cf) return json({ error: 'Plak het Cloudflare-token opnieuw (het werd niet onthouden)', needsToken: true }, 409);
        const ctx = { env, state, cf, sessionId };
        const outcome = path.endsWith('/apply') ? await applyChange(ctx) : await undoChange(ctx);
        if (!outcome.ok) return json({ error: outcome.error, info: await changeInfo(env, state, sessionId, origin, cf).catch(() => null) }, outcome.status);
        return json(await changeInfo(env, state, sessionId, origin, cf));
      }
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
        // Already installed: re-deploy with the new address (the bff step
        // attaches the domain; login:uris registers it at the login provider).
        for (const step of ['worker:arcanum-backend', 'worker:arcanum-bff', 'login:uris', 'verify']) delete state.steps[step];
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
      const blueprint = blueprintFrom(manifest, descriptors, database);
      // An update that brings a different installer: it goes first, over
      // this one (HOSTING_PLAN.md decision 4). A fresh install already runs
      // the installer it needs.
      if (state.installed && manifest.installer && env.INSTALLER_RELEASE !== manifest.version) {
        blueprint.installer = { file: manifest.installer.file, script: installerScript(state, request) };
      }
      state.release = { version: manifest.version, manifestUrl: entry.manifest_url, manifest, blueprint };
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
      if (!planSteps(state.release!.blueprint, state).some((s) => s.id === id)) return json({ error: `Onbekende stap ${id}` }, 404);
      // The self-update comes first; nothing of Arcanum changes until it's done.
      if (state.release!.blueprint.installer && id !== 'installer:self' && state.steps['installer:self']?.status !== 'done') {
        return json({ error: 'Eerst moet de installer zichzelf bijwerken (de eerste stap)' }, 409);
      }
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
