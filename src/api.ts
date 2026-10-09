// The setup page's JSON API. Everything but signing in (/api/login,
// /api/login-options, /api/handoff) needs a session.
// Nothing here ever returns the Cloudflare token, the client secret or a
// generated secret — only whether they're set.
import type { Env } from './env';
import { checkLoginAllowed, clearedCookie, newSessionCookie, recordLoginFailure, recoveryCodeMatches, sessionEmail, sessionFrom } from './auth';
import { handoff, isBootstrapped } from './bootstrap';
import { canSignInWithAccount } from './oidc';
import { Cloudflare, CloudflareError } from './cloudflare';
import type { WorkerDescriptor } from './contract';
import { compareVersions, fetchManifest, fetchReleaseJson, installable, ReleaseError, releaseIndexFor } from './releases';
import { directShouldClose, startClientOf, INSTALLER_KEY_SECRET, installationStarted, isAdmin, loadState, loginChangeActive, publicUrl, rootSecret, saveState, sealValue, unsealValue, workersDevUrl, type InstallerState } from './state';
import { blueprintFrom, planSteps, runStep } from './steps';
import { safeEqual } from './crypto';
import { applyChange, changeInfo, changesIdentity, dropExpiredSnapshot, providerIdentity, readLoginProvider, TEST_CALLBACK_PATH, undoChange } from './login-change';
import { addClientUris } from './auth-client';
import { messageOf, textsFor, type Messages } from './i18n';
import { buildMailConfig, MAIL_SERVICES, mailSummary, OLD_SMTP_SECRETS, type MailConfig } from './mail';

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
// (recovery code, handoff or account sign-in — with who, when
// known), or forwarded by Arcanum's bff for a logged-in admin.
export type Access = { via: 'session'; sessionId: string; email: string | null } | { via: 'arcanum'; sessionId: string; email: string };

// Arcanum's bff forwards /installer/* with the shared key and the user's
// identity (it strips both from what the browser sends). A wrong key is
// refused outright; the session cookie isn't looked at then.
async function arcanumAccess(env: Env, state: InstallerState, request: Request, t: Messages): Promise<Access | Response | null> {
  const key = request.headers.get('X-Installer-Key');
  if (key === null) return null;
  const expected = state.behindArcanum && state.secrets ? (JSON.parse(await unsealValue(env, state, state.secrets)) as Record<string, string>)[INSTALLER_KEY_SECRET] : undefined;
  if (!expected || !safeEqual(key, expected)) return json({ error: t.api.badArcanumKey }, 401);
  const email = (request.headers.get('X-User-Email') ?? '').trim().toLowerCase();
  if (!email || !isAdmin(state, email)) return json({ error: t.api.notAdmin(email || t.api.thisAccount), forbidden: true }, 403);
  // The admin list is by e-mail: an address the login provider says isn't
  // verified proves nothing (absent = the provider doesn't say, as for the invites).
  if (request.headers.get('X-User-Email-Verified') === 'false') return json({ error: t.api.emailNotVerified(email), forbidden: true }, 403);
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

export async function mailConfigOf(env: Env, state: InstallerState): Promise<MailConfig | null> {
  return state.mail ? (JSON.parse(await unsealValue(env, state, state.mail.config)) as MailConfig) : null;
}

// MAIL_CONFIG on arcanum-backend right away, when it exists and the token's
// at hand (else the next Installeren/Bijwerken gives it — the backend's step
// is redone). The old hand-set DEFAULT_SMTP_* go once it's set.
async function applyMail(env: Env, state: InstallerState, sessionId: string, config: MailConfig | null): Promise<'applied' | 'later'> {
  const token = await tokenFor(env, state, sessionId);
  const accountId = state.cloudflare?.accountId;
  const cf = token && accountId ? cloudflareFor(env, token) : null;
  if (!cf || !accountId || !state.installed || !(await cf.scriptExists(accountId, 'arcanum-backend'))) {
    delete state.steps['worker:arcanum-backend'];
    return 'later';
  }
  const existing = new Set(((await cf.scriptBindings(accountId, 'arcanum-backend')) ?? []).filter((b) => b.type === 'secret_text').map((b) => b.name));
  if (config) {
    await cf.putSecret(accountId, 'arcanum-backend', 'MAIL_CONFIG', JSON.stringify(config));
    for (const old of OLD_SMTP_SECRETS.filter((n) => existing.has(n))) await cf.deleteSecret(accountId, 'arcanum-backend', old);
  } else if (existing.has('MAIL_CONFIG')) {
    await cf.deleteSecret(accountId, 'arcanum-backend', 'MAIL_CONFIG');
  }
  return 'applied';
}

export async function status(env: Env, state: InstallerState, sessionId: string, access: Access | undefined, t: Messages) {
  const url = publicUrl(state);
  const steps = state.release ? planSteps(state.release.blueprint, state, t).map((s) => ({ ...s, ...(state.steps[s.id] ?? { status: 'todo' }) })) : [];
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
    // The service and its plain values — never a key or password.
    mail: mailSummary(await mailConfigOf(env, state)),
    mailServices: MAIL_SERVICES,
    release: state.release ? { version: state.release.version, components: state.release.manifest.components } : null,
    locked: installationStarted(state),
    steps,
    installed: state.installed ?? null,
    probeUrl: url && state.probePath ? `${url}${state.probePath}` : null,
    access: access ? { via: access.via, email: access.email } : null,
    // Who the bootstrapper set it up for, and the provider admins sign in to this page with.
    bootstrapped: state.bootstrap
      ? {
          owner: state.bootstrap.owner.email,
          issuer: state.bootstrap.login?.issuer ?? null,
          // Its own client at login.kaboutersoft.be ("Terug naar …"), while it still is that one.
          startClient: startClientOf(state) ? { issuer: startClientOf(state)!.issuer, clientId: startClientOf(state)!.clientId } : null,
        }
      : null,
    installer: { release: env.INSTALLER_RELEASE ?? null, selfUpdate: state.selfUpdate ?? null },
    // Set by the bootstrapper only (shown, never changed here).
    instance: state.instance ?? { kind: 'single', channel: 'stable' },
    // "Aanmelding wijzigen": a staged provider, or a change that can still be undone.
    loginChange: {
      staged: state.loginChange?.staged ? { issuer: state.loginChange.staged.login.issuer } : null,
      applied: state.loginChange?.applied ? { at: state.loginChange.applied.at, undoUntil: state.loginChange.applied.undoUntil, phase: state.loginChange.applied.phase } : null,
    },
    behindArcanum: state.behindArcanum
      ? { installerUrl: url ? `${url}/installer/` : null, publicAccessRemoved: !!state.behindArcanum.publicAccessRemoved, keptOpen: !!state.behindArcanum.keptOpen }
      : null,
  };
}

export async function handleApi(request: Request, env: Env, path: string): Promise<Response> {
  // The request's language (the page sends its own as Accept-Language, i18n.ts).
  const t = textsFor(request);
  if (!rootSecret(env)) return json({ error: t.api.noStateKey }, 500);

  // No cross-site requests, and JSON bodies only: another site must never
  // drive this API with the admin's cookie — the installer session's, or
  // Arcanum's behind /installer (SameSite=Lax; this doesn't rely on that).
  if (request.method !== 'GET') {
    if (request.headers.get('Sec-Fetch-Site') === 'cross-site') return json({ error: t.api.crossSite }, 403);
    if (!(request.headers.get('Content-Type') ?? '').includes('application/json')) return json({ error: t.api.expectJson }, 415);
  }

  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';

  // Which ways in this installer has (the page shows those).
  if (path === '/api/login-options' && request.method === 'GET') {
    const state = await loadState(env);
    return json({
      recoveryCode: !!state.bootstrap?.recoveryHash,
      account: canSignInWithAccount(state) ? { issuer: state.bootstrap!.login!.issuer } : null,
      // Uploaded by the bootstrapper, not handed over yet: only its link gets in.
      awaitingHandoff: !state.bootstrap && isBootstrapped(env, state),
    });
  }

  // The recovery code: the way in when signing in with an account can't.
  if (path === '/api/login' && request.method === 'POST') {
    if (!(await checkLoginAllowed(env, ip))) return json({ error: t.api.tooManyAttempts }, 429);
    const { recoveryCode } = await body(request);
    const state = await loadState(env);
    if (typeof recoveryCode !== 'string' || !(await recoveryCodeMatches(state, recoveryCode))) {
      await recordLoginFailure(env, ip);
      return json({ error: t.api.wrongRecoveryCode }, 401);
    }
    const session = await newSessionCookie(env);
    return json({ ok: true }, 200, { 'Set-Cookie': session.cookie });
  }

  // The bootstrapper's link: /handoff?code=… → the page posts the code here.
  if (path === '/api/handoff' && request.method === 'POST') {
    if (!(await checkLoginAllowed(env, ip))) return json({ error: t.api.tooManyAttempts }, 429);
    const { code } = await body(request);
    const state = await loadState(env);
    const outcome = await handoff(env, state, typeof code === 'string' ? code.trim() : '', installerScript(state, request), t);
    if (!outcome.ok) {
      if (outcome.reason === 'wrong') await recordLoginFailure(env, ip);
      return json({ error: outcome.error, reason: outcome.reason }, outcome.status);
    }
    await saveState(env, state);
    return json({ ok: true, recoveryCode: outcome.recoveryCode, email: outcome.email, firstImport: outcome.firstImport }, 200, { 'Set-Cookie': outcome.cookie });
  }

  const state = await loadState(env);
  const viaArcanum = await arcanumAccess(env, state, request, t);
  if (viaArcanum instanceof Response) return viaArcanum;
  let access: Access | null = viaArcanum;
  if (!access) {
    const id = await sessionFrom(env, request);
    if (!id) return json({ error: t.api.notSignedIn }, 401);
    access = { via: 'session', sessionId: id, email: await sessionEmail(env, id) };
  }
  const sessionId = access.sessionId;
  // "Terugzetten" is possible for 7 days after a login change, then the snapshot goes.
  if (dropExpiredSnapshot(state)) await saveState(env, state);

  if (path === '/api/logout' && request.method === 'POST') {
    await env.INSTALLER_STATE.delete(`session-token:${sessionId}`);
    return json({ ok: true }, 200, access.via === 'session' ? { 'Set-Cookie': clearedCookie } : {});
  }

  if (path === '/api/status' && request.method === 'GET') return json(await status(env, state, sessionId, access, t));

  try {
    if (path === '/api/cloudflare' && request.method === 'POST') {
      const { token, remember, accountId, subdomain: wantedSubdomain } = await body(request);
      if (typeof token !== 'string' || token.trim().length < 20) return json({ error: t.api.pasteToken }, 400);
      const cf = cloudflareFor(env, token.trim());
      const accounts = await cf.listAccounts();
      if (accounts.length === 0) return json({ error: t.api.noAccounts }, 400);
      const account = accountId ? accounts.find((a) => a.id === accountId) : accounts.length === 1 ? accounts[0] : null;
      if (!account) return json({ needsAccount: true, accounts: accounts.map((a) => ({ id: a.id, name: a.name })) });
      if (installationStarted(state) && state.cloudflare && state.cloudflare.accountId !== account.id) {
        return json({ error: t.api.otherAccount(state.cloudflare.accountName) }, 409);
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
          return json({ error: t.api.badSubdomain }, 400);
        }
        try {
          subdomain = await cf.registerWorkersSubdomain(account.id, name);
        } catch (err) {
          if (err instanceof CloudflareError) return json({ error: t.api.subdomainFailed(err.message) }, 400);
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
      return json(await status(env, state, sessionId, access, t));
    }

    if (path === '/api/login-provider' && request.method === 'POST') {
      const b = await body(request);
      // Installed: another provider (or client) means other (issuer, sub)
      // values for everyone — only through "Aanmelding wijzigen" (stage,
      // test, apply). The same provider and clients (a new secret, scopes)
      // are still saved here.
      if (state.installed && state.login && changesIdentity(providerIdentity(b), state.login)) {
        return json({ error: t.api.useLoginChange, useLoginChange: true }, 409);
      }
      const read = await readLoginProvider(env, state, b, state.login, t);
      if (!read.ok) return json({ error: read.error, ...(read.checks ? { checks: read.checks } : {}) }, read.status);
      state.login = read.login;
      // Already installed? Re-deploy the backend with the new settings and
      // let it re-seed the login provider, and the bff (which signs people in
      // with them) — "Verder installeren" applies it.
      for (const step of ['worker:arcanum-backend', 'login:reset', 'worker:arcanum-bff', 'verify']) delete state.steps[step];
      await saveState(env, state);
      return json({ ...(await status(env, state, sessionId, access, t)), checks: read.checks });
    }

    // "Aanmelding wijzigen" (login-change.ts).
    if (path.startsWith('/api/login-change')) {
      const token = await tokenFor(env, state, sessionId);
      const cf = token ? cloudflareFor(env, token) : null;
      const origin = installerOrigin(state, request);
      if (path === '/api/login-change' && request.method === 'GET') return json(await changeInfo(env, state, sessionId, origin, cf, t));
      if (!state.installed) return json({ error: t.api.notInstalledYet }, 409);

      if (path === '/api/login-change/stage' && request.method === 'POST') {
        if (state.loginChange?.applied?.phase === 'started') return json({ error: t.api.finishChangeFirst }, 409);
        let b = await body(request);
        let fallback = state.loginChange?.staged?.login.issuer === providerIdentity(b).issuer ? state.loginChange.staged.login : state.login;
        // "Terug naar login.kaboutersoft.be": this installation's own client
        // there — the one the bootstrapper made, that this page signs in
        // with. Its secret is only known here (sealed), so nothing is typed.
        // First the addresses the switch needs are registered with it: this
        // page's test sign-in, and Arcanum's own domain.
        if (b.startClient === true) {
          const own = startClientOf(state);
          if (!own) return json({ error: t.api.noStartClient }, 409);
          const url = publicUrl(state);
          const workersDev = workersDevUrl(state);
          try {
            await addClientUris(own.issuer, { id: own.clientId, secret: await unsealValue(env, state, own.clientSecret) }, {
              redirectUris: [`${origin}${TEST_CALLBACK_PATH}`, ...[url, workersDev].filter(Boolean).map((u) => `${u}/callback`)],
              postLogoutRedirectUris: [url, workersDev].filter(Boolean) as string[],
            });
          } catch (err) {
            return json({ error: messageOf(err, t) }, 502);
          }
          b = { issuer: own.issuer, clientId: own.clientId };
          fallback = { issuer: own.issuer, clientId: own.clientId, clientSecret: own.clientSecret, authorizationEndpoint: `${own.issuer}/authorize` };
        }
        const read = await readLoginProvider(env, state, b, fallback, t);
        if (!read.ok) return json({ error: read.error, ...(read.checks ? { checks: read.checks } : {}) }, read.status);
        // The test sign-in and the recovery code need the installer's own
        // address: open it again for the change (closed again afterwards,
        // the next time it's opened through Arcanum).
        if (state.behindArcanum?.publicAccessRemoved) {
          if (!cf) return json({ error: t.api.tokenAgain, needsToken: true }, 409);
          await cf.setWorkersDev(state.cloudflare!.accountId, state.behindArcanum.script, true);
          state.behindArcanum.publicAccessRemoved = false;
        }
        state.loginChange = { ...state.loginChange, staged: { login: read.login, at: new Date().toISOString() } };
        delete state.loginChange.test;
        await saveState(env, state);
        return json({ ...(await changeInfo(env, state, sessionId, origin, cf, t)), checks: read.checks });
      }

      if (path === '/api/login-change/cancel' && request.method === 'POST') {
        if (state.loginChange?.applied?.phase === 'started') return json({ error: t.api.changeHalfway }, 409);
        if (state.loginChange) {
          delete state.loginChange.staged;
          delete state.loginChange.test;
        }
        await saveState(env, state);
        return json(await changeInfo(env, state, sessionId, origin, cf, t));
      }

      if (path === '/api/login-change/apply' || path === '/api/login-change/undo') {
        if (request.method !== 'POST') return json({ error: 'Not found' }, 404);
        if (!cf) return json({ error: t.api.tokenAgain, needsToken: true }, 409);
        const ctx = { env, state, cf, sessionId, t };
        const outcome = path.endsWith('/apply') ? await applyChange(ctx) : await undoChange(ctx);
        if (!outcome.ok) return json({ error: outcome.error, info: await changeInfo(env, state, sessionId, origin, cf, t).catch(() => null) }, outcome.status);
        return json(await changeInfo(env, state, sessionId, origin, cf, t));
      }
    }

    if (path === '/api/address' && request.method === 'POST') {
      const { customDomain } = await body(request);
      const host = typeof customDomain === 'string' ? customDomain.trim().toLowerCase().replace(/\.$/, '') : '';
      if (host && !/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host)) {
        return json({ error: t.api.badDomain }, 400);
      }
      if ((state.customDomain ?? '') !== host) {
        if (host) state.customDomain = host;
        else delete state.customDomain;
        // Already installed: re-deploy with the new address (the bff step
        // attaches the domain; login:uris registers it at the login provider).
        for (const step of ['worker:arcanum-backend', 'worker:arcanum-bff', 'login:uris', 'verify']) delete state.steps[step];
      }
      await saveState(env, state);
      return json(await status(env, state, sessionId, access, t));
    }

    if (path === '/api/admins' && request.method === 'POST') {
      const { emails } = await body(request);
      const list = (typeof emails === 'string' ? emails : '')
        .split(/[,;\s]+/)
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean);
      if (list.length === 0) return json({ error: t.api.noEmails }, 400);
      const bad = list.filter((e) => !/^(\*|[^@\s]+)@[^@\s]+\.[^@\s]+$/.test(e));
      if (bad.length) return json({ error: t.api.badEmails(bad.join(', ')) }, 400);
      state.admins = list.join(', ');
      await saveState(env, state);
      return json(await status(env, state, sessionId, access, t));
    }

    // Geavanceerd → E-mail (MAIL.md): a service and its settings, or off.
    if (path === '/api/mail' && request.method === 'POST') {
      const input = await body(request);
      const built = buildMailConfig(input, await mailConfigOf(env, state));
      if ('missing' in built) return json({ error: t.api.mailMissing(built.missing.join(', ')) }, 400);
      state.mail = { config: await sealValue(env, state, JSON.stringify(built.config)), updatedAt: new Date().toISOString() };
      const applied = await applyMail(env, state, sessionId, built.config);
      await saveState(env, state);
      return json({ ...(await status(env, state, sessionId, access, t)), mailApplied: applied });
    }
    if (path === '/api/mail/off' && request.method === 'POST') {
      delete state.mail;
      const applied = await applyMail(env, state, sessionId, null);
      await saveState(env, state);
      return json({ ...(await status(env, state, sessionId, access, t)), mailApplied: applied });
    }

    if (path === '/api/releases' && request.method === 'GET') {
      const index = await releaseIndexFor(env.RELEASES_INDEX_URL, state.instance?.channel);
      return json({ latest: index.latest, installed: state.installed?.version ?? null, releases: installable(index).map((r) => ({ version: r.version, prerelease: r.prerelease, releasedAt: r.released_at, notesUrl: r.notes_url })) });
    }

    if (path === '/api/release' && request.method === 'POST') {
      const { version } = await body(request);
      // Installed: only a newer version (an update — every step runs again).
      if (state.installed && compareVersions(String(version), state.installed.version) <= 0) {
        return json({ error: t.api.notNewer(state.installed.version) }, 409);
      }
      const index = await releaseIndexFor(env.RELEASES_INDEX_URL, state.instance?.channel);
      const entry = installable(index).find((r) => r.version === version);
      if (!entry) return json({ error: t.api.unknownRelease(String(version)) }, 400);
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
      const blueprint = blueprintFrom(manifest, descriptors, database, t);
      // An update that brings a different installer: it goes first, over
      // this one (HOSTING_PLAN.md decision 4). A fresh install already runs
      // the installer it needs.
      if (state.installed && manifest.installer && env.INSTALLER_RELEASE !== manifest.version) {
        blueprint.installer = { file: manifest.installer.file, script: installerScript(state, request) };
      }
      state.release = { version: manifest.version, manifestUrl: entry.manifest_url, manifest, blueprint };
      await saveState(env, state);
      return json(await status(env, state, sessionId, access, t));
    }

    // The installer's own address. It moves behind Arcanum by itself: the
    // bff is linked when it's deployed (steps.ts), and the first request
    // that comes through Arcanum — "Open je Arcanum" passes by — closes
    // the own address (POST close, from the page). That request is the
    // proof the installer stays reachable. Geavanceerd can open it again
    // ("kept open" — until the next "Open je Arcanum", or closed there); a
    // login change opens it for as long as it lasts (state.ts directShouldClose).
    if (path.startsWith('/api/public-access')) {
      if (!state.installed || !state.cloudflare) return json({ error: t.api.installFirst }, 409);
      const token = await tokenFor(env, state, sessionId);
      const cf = token ? cloudflareFor(env, token) : null;
      const script = state.behindArcanum?.script ?? installerScript(state, request);
      const directUrl = `https://${script}.${state.cloudflare.subdomain}.workers.dev`;

      if (path === '/api/public-access' && request.method === 'GET') {
        return json({
          linked: !!state.behindArcanum,
          installerUrl: `${publicUrl(state)}/installer/`,
          directUrl,
          // Live from Cloudflare: a re-upload of the installer (the bootstrapper again) turns it back on.
          directEnabled: cf ? await cf.isOnWorkersDev(state.cloudflare.accountId, script).catch(() => null) : null,
          keptOpen: !!state.behindArcanum?.keptOpen,
          loginChange: loginChangeActive(state),
          // Closed by itself on a visit through Arcanum…
          shouldClose: directShouldClose(state),
          // …and in any case by "Open je Arcanum" (also when it was switched back on by hand).
          closable: !!state.behindArcanum && !loginChangeActive(state),
          via: access.via,
        });
      }
      if (!state.behindArcanum) return json({ error: t.api.notLinked }, 409);
      if (!cf) return json({ error: t.api.tokenAgain, needsToken: true }, 409);

      if (path === '/api/public-access/close' && request.method === 'POST') {
        // Only from a request that came through Arcanum: that's the proof
        // the installer stays reachable once its own address is gone.
        if (access.via !== 'arcanum') return json({ error: t.api.closeThroughArcanum(`${publicUrl(state)}/installer/`) }, 409);
        if (loginChangeActive(state)) return json({ error: t.api.closeAfterLoginChange }, 409);
        await cf.setWorkersDev(state.cloudflare.accountId, state.behindArcanum.script, false);
        state.behindArcanum.publicAccessRemoved = true;
        delete state.behindArcanum.keptOpen;
        await saveState(env, state);
        return json(await status(env, state, sessionId, access, t));
      }

      if (path === '/api/public-access/open' && request.method === 'POST') {
        await cf.setWorkersDev(state.cloudflare.accountId, state.behindArcanum.script, true);
        state.behindArcanum.publicAccessRemoved = false;
        state.behindArcanum.keptOpen = true;
        await saveState(env, state);
        return json(await status(env, state, sessionId, access, t));
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
      if (typeof stepId !== 'string') return json({ error: t.api.giveStep }, 400);
      const id = stepId;
      const missing = [!state.cloudflare && t.api.missing.cloudflare, !state.login && t.api.missing.login, !state.admins && t.api.missing.admins, !state.release && t.api.missing.release].filter(Boolean);
      if (missing.length) return json({ error: t.api.firstStill(missing.join(', ')) }, 409);
      if (!planSteps(state.release!.blueprint, state, t).some((s) => s.id === id)) return json({ error: t.api.unknownStep(id) }, 404);
      // The self-update comes first; nothing of Arcanum changes until it's done.
      if (state.release!.blueprint.installer && id !== 'installer:self' && state.steps['installer:self']?.status !== 'done') {
        return json({ error: t.api.selfUpdateFirst }, 409);
      }
      const token = await tokenFor(env, state, sessionId);
      if (!token) return json({ error: t.api.tokenAgain, needsToken: true }, 409);
      try {
        const outcome = await runStep(id, { env, state, cf: cloudflareFor(env, token), t, installerScript: installerScript(state, request), viaArcanum: access.via === 'arcanum' });
        if (outcome.status === 'done') state.steps[id] = { status: 'done', at: new Date().toISOString(), detail: outcome.detail };
        await saveState(env, state);
        return json({ id, ...outcome });
      } catch (err) {
        const detail = messageOf(err, t);
        state.steps[id] = { status: 'failed', at: new Date().toISOString(), detail };
        await saveState(env, state);
        return json({ id, status: 'failed', detail }, 200);
      }
    }
  } catch (err) {
    if (err instanceof CloudflareError) return json({ error: t.api.cloudflare(err.message) }, err.status === 401 || err.status === 403 ? 400 : 502);
    if (err instanceof ReleaseError) return json({ error: messageOf(err, t) }, 502);
    throw err;
  }

  return json({ error: 'Not found' }, 404);
}
