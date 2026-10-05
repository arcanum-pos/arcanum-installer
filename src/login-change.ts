// "Aanmelding wijzigen": changing an installed Arcanum's login provider
// without locking anyone out (HOSTING_PLAN.md §6).
//
// Arcanum binds every active membership to the (issuer, sub) of its first
// login (arcanum-backend memberships.user_sub/issuer); a new provider gives
// everyone new values. So a change here is:
//
//   1. stage   — the new provider is entered and checked like before an
//                install (discovery, device login, the clients), and kept
//                aside: nothing is applied;
//   2. test    — the admin doing the change signs in at the new provider
//                through this installer (auth code + PKCE + nonce, callback
//                /auth/test-callback) from an installer session; the answer
//                (e-mail, sub, email_verified) is recorded;
//   3. apply   — a snapshot first (the previous settings and every
//                membership, sealed in the state), then the switch the
//                existing way (backend re-deployed with the new DEFAULT_IDP_*,
//                the seeded 'default' identity_providers row cleared so it
//                re-seeds), then in the backend database: the tester's
//                memberships bound to the new (issuer, sub), every other
//                active membership back to 'pending' by e-mail (role and
//                address kept) — arcanum-backend's reconcilePendingInvites
//                re-activates it at that person's next login. Last, this
//                page's own sign-in moves to the new provider;
//   4. undo    — "Terugzetten", for 7 days: the previous provider and every
//                membership exactly as in the snapshot. Then it's dropped.
//
// Break glass: the recovery code (auth.ts) doesn't depend on any provider,
// so the page — undo included — stays usable when a provider is gone.
//
// The D1 writes go through Cloudflare's D1 HTTP API (POST …/query). A single
// SQL statement is atomic in SQLite, so every write here is ONE statement per
// call, with its data as one JSON parameter read through json_each. Whether
// that endpoint runs several ';'-separated statements in one transaction is
// NOT verified (the Worker binding's batch() is transactional; for the HTTP
// endpoint we couldn't confirm it), so nothing here depends on it. Instead:
// the snapshot is saved before the first write, and every write is
// idempotent (absolute values, keyed by membership id) — a half-finished
// apply or undo is finished by simply running it again, and an apply that
// stopped half way can also be undone.
import type { Env } from './env';
import { sessionEmail, sessionFrom } from './auth';
import { Cloudflare } from './cloudflare';
import { safeEqual } from './crypto';
import { checkClients, type ClientCheck } from './idp-check';
import { claimsOf, discovery, pkceChallenge, random, sameIssuer } from './oidc';
import { isAdmin, loadState, publicUrl, saveState, sealValue, unsealValue, workersDevUrl, type InstallerState, type LoginSettings, startClientOf } from './state';
import { runStep } from './steps';
import { messageOf, type Messages } from './i18n';

export const TEST_CALLBACK_PATH = '/auth/test-callback';
const TEST_PENDING_COOKIE = 'arcanum_installer_test';
const PENDING_TTL_S = 600;
export const UNDO_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Entering a provider — the form of step 2, shared with /api/login-provider.

type Fields = Record<string, unknown>;

export function providerIdentity(b: Fields) {
  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  return { issuer: (text(b.issuer) ?? '').replace(/\/+$/, ''), clientId: text(b.clientId) ?? '', authCodeClientId: text(b.authCodeClientId) };
}

// Whether other settings mean other (issuer, sub) values for everyone: another
// issuer, or another client (some providers give each client its own subs).
export const changesIdentity = (a: { issuer: string; clientId: string; authCodeClientId?: string }, b: { issuer: string; clientId: string; authCodeClientId?: string }) =>
  a.issuer !== b.issuer || a.clientId !== b.clientId || (a.authCodeClientId ?? null) !== (b.authCodeClientId ?? null);

// Validates the form and tests the provider live. `current`: the settings
// whose secrets may be kept when a secret field is left empty (same issuer
// and client only).
export async function readLoginProvider(
  env: Env,
  state: InstallerState,
  b: Fields,
  current: LoginSettings | undefined,
  t: Messages
): Promise<{ ok: true; login: LoginSettings; checks: ClientCheck[] } | { ok: false; status: number; error: string; checks?: ClientCheck[] }> {
  const refuse = (error: string, checks?: ClientCheck[]) => ({ ok: false as const, status: 400, error, checks });
  const { issuer, clientId, authCodeClientId } = providerIdentity(b);
  const clientSecret = typeof b.clientSecret === 'string' ? b.clientSecret.trim() : '';
  const connectionName = typeof b.connectionName === 'string' && b.connectionName.trim() ? b.connectionName.trim() : undefined;
  const isGoogle = /^https:\/\/accounts\.google\.com$/.test(issuer);
  // Google rejects the platform's default `offline_access` scope.
  const scopes = (typeof b.scopes === 'string' && b.scopes.trim().replace(/\s+/g, ' ')) || (isGoogle ? 'openid profile email' : undefined);
  if (scopes && !scopes.split(' ').includes('openid')) return refuse(t.change.scopesOpenid);
  const authCodeClientSecret = typeof b.authCodeClientSecret === 'string' ? b.authCodeClientSecret.trim() : '';
  const same = current && current.issuer === issuer ? current : undefined;
  const keepSecret = !clientSecret && same?.clientId === clientId ? same.clientSecret : undefined;
  const keepAuthCodeSecret = authCodeClientId && !authCodeClientSecret && same?.authCodeClientId === authCodeClientId ? same.authCodeClientSecret : undefined;
  if (authCodeClientId && !authCodeClientSecret && !keepAuthCodeSecret) return refuse(t.change.browserSecret);
  if (!/^https:\/\/[^/]+/.test(issuer)) return refuse(t.change.issuerHttps);
  if (!clientId) return refuse(t.change.noClientId);
  if (!clientSecret && !keepSecret) return refuse(t.change.noClientSecret);
  // The same check the platform does at login: discovery must work and
  // offer the device login the kassa uses.
  const res = await fetch(`${issuer}/.well-known/openid-configuration`).catch(() => null);
  const doc = res?.ok ? ((await res.json().catch(() => null)) as Record<string, unknown> | null) : null;
  if (!doc || typeof doc.authorization_endpoint !== 'string') return refuse(t.change.noDiscovery(`${issuer}/.well-known/openid-configuration`));
  if (typeof doc.device_authorization_endpoint !== 'string') return refuse(t.change.noDeviceFlow);
  // Test the clients with the provider before keeping anything.
  const kassaSecret = clientSecret || (await unsealValue(env, state, keepSecret!));
  const browserSecret = authCodeClientSecret || (keepAuthCodeSecret ? await unsealValue(env, state, keepAuthCodeSecret) : '');
  const checks =
    typeof doc.token_endpoint === 'string'
      ? await checkClients({
          deviceEndpoint: doc.device_authorization_endpoint,
          tokenEndpoint: doc.token_endpoint,
          isGoogle,
          clientId,
          clientSecret: kassaSecret,
          scopes: scopes ?? 'openid profile email offline_access',
          authCode: authCodeClientId ? { clientId: authCodeClientId, clientSecret: browserSecret, redirectUri: `${publicUrl(state) ?? issuer}/callback` } : undefined,
        }, t)
      : [];
  const refused = checks.filter((c) => c.blocking);
  if (refused.length) return refuse(refused.map((c) => c.message).join(' '), checks);
  return {
    ok: true,
    checks,
    login: {
      issuer,
      clientId,
      clientSecret: clientSecret ? await sealValue(env, state, clientSecret) : keepSecret!,
      connectionName,
      authorizationEndpoint: doc.authorization_endpoint,
      scopes,
      authCodeClientId,
      authCodeClientSecret: authCodeClientId ? (authCodeClientSecret ? await sealValue(env, state, authCodeClientSecret) : keepAuthCodeSecret) : undefined,
    },
  };
}

// Arcanum's browser login (and so this page's sign-in and the test) uses the
// separate browser client when there is one.
const browserClient = (login: LoginSettings) =>
  login.authCodeClientId && login.authCodeClientSecret ? { clientId: login.authCodeClientId, clientSecret: login.authCodeClientSecret } : { clientId: login.clientId, clientSecret: login.clientSecret };

// ---------------------------------------------------------------------------
// Memberships in the backend database.

export interface MembershipRow {
  id: string;
  org_id: string;
  org_name: string | null;
  user_sub: string | null;
  issuer: string | null;
  status: string;
  invited_email: string;
  role: string;
  accepted_at: string | null;
}

// Every membership of an org on the instance's login provider. Orgs with an
// identity provider of their own (the shared platform's per-org IdPs) are
// not affected by the instance's provider, so they're left alone.
const MEMBERSHIPS_SQL =
  'SELECT m.id, m.org_id, o.name AS org_name, m.user_sub, m.issuer, m.status, m.invited_email, m.role, m.accepted_at ' +
  'FROM memberships m LEFT JOIN organizations o ON o.id = m.org_id ' +
  "WHERE m.org_id NOT IN (SELECT org_id FROM identity_providers WHERE org_id <> 'default' AND issuer_url IS NOT NULL) " +
  'ORDER BY m.invited_email, m.org_id';

// Apply, in one statement: ?1 = the tester's membership ids (JSON), bound to
// ?2 sub / ?3 issuer, active, e-mail ?4, accepted at ?5; ?6 = the ids of every
// other active membership (JSON), back to pending by e-mail. Idempotent.
const APPLY_SQL =
  'UPDATE memberships SET ' +
  'user_sub = CASE WHEN id IN (SELECT value FROM json_each(?1)) THEN ?2 ELSE NULL END, ' +
  'issuer = CASE WHEN id IN (SELECT value FROM json_each(?1)) THEN ?3 ELSE NULL END, ' +
  "status = CASE WHEN id IN (SELECT value FROM json_each(?1)) THEN 'active' ELSE 'pending' END, " +
  'invited_email = CASE WHEN id IN (SELECT value FROM json_each(?1)) THEN ?4 ELSE invited_email END, ' +
  'accepted_at = CASE WHEN id IN (SELECT value FROM json_each(?1)) THEN ?5 ELSE NULL END ' +
  'WHERE id IN (SELECT value FROM json_each(?1)) OR id IN (SELECT value FROM json_each(?6))';

// Undo, statement 1: memberships that became active under the new provider
// after the switch but aren't in the snapshot (invited since) go to pending,
// so they re-activate under the old one. ?1 = new issuer, ?2 = snapshot ids.
const UNDO_NEW_SQL =
  "UPDATE memberships SET user_sub = NULL, issuer = NULL, status = 'pending', accepted_at = NULL " +
  "WHERE issuer = ?1 AND status = 'active' AND id NOT IN (SELECT value FROM json_each(?2)) " +
  "AND org_id NOT IN (SELECT org_id FROM identity_providers WHERE org_id <> 'default' AND issuer_url IS NOT NULL)";

// Undo, statement 2: every membership of the snapshot exactly as it was. ?1 = the snapshot rows (JSON).
const UNDO_RESTORE_SQL =
  'UPDATE memberships SET user_sub = s.user_sub, issuer = s.issuer, status = s.status, invited_email = s.invited_email, accepted_at = s.accepted_at ' +
  "FROM (SELECT json_extract(value, '$.id') AS id, json_extract(value, '$.user_sub') AS user_sub, json_extract(value, '$.issuer') AS issuer, " +
  "json_extract(value, '$.status') AS status, json_extract(value, '$.invited_email') AS invited_email, json_extract(value, '$.accepted_at') AS accepted_at FROM json_each(?1)) AS s " +
  'WHERE memberships.id = s.id';

export interface Person {
  email: string;
  role: string;
  org: string;
}
const person = (r: MembershipRow): Person => ({ email: r.invited_email, role: r.role, org: r.org_name ?? r.org_id });

interface Plan {
  tester: MembershipRow[];
  resign: MembershipRow[];
  problem: string | null;
}

// Who is who, for a tester known by these e-mail addresses (the installer
// session's and the one the new provider gave).
function planFor(rows: MembershipRow[], testerEmails: string[], t: Messages): Plan {
  const emails = new Set(testerEmails.map((e) => e.trim().toLowerCase()).filter(Boolean));
  const tester = rows.filter((r) => emails.has(r.invited_email.trim().toLowerCase()));
  const resign = rows.filter((r) => r.status === 'active' && !tester.includes(r));
  const shown = [...emails].join(t.change.or);
  let problem: string | null = null;
  const perOrg = new Map<string, number>();
  for (const r of tester) perOrg.set(r.org_id, (perOrg.get(r.org_id) ?? 0) + 1);
  const doubled = tester.find((r) => (perOrg.get(r.org_id) ?? 0) > 1);
  if (tester.length === 0) {
    problem = t.change.noMembership(shown);
  } else if (doubled) {
    problem = t.change.twoMemberships(doubled.org_name ?? doubled.org_id, shown);
  }
  return { tester, resign, problem };
}

const backendDb = (state: InstallerState) => state.resources.d1['arcanum-backend'];

async function readMemberships(cf: Cloudflare, state: InstallerState): Promise<MembershipRow[]> {
  const result = (await cf.queryD1(state.cloudflare!.accountId, backendDb(state), MEMBERSHIPS_SQL)) as { results?: MembershipRow[] }[];
  return result?.[0]?.results ?? [];
}

// What's sealed in state.loginChange.applied.snapshot.
interface Snapshot {
  rows: MembershipRow[];
  testerIds: string[];
  resignIds: string[];
  tester: { email: string; sub: string; issuer: string };
}

// ---------------------------------------------------------------------------
// The test sign-in at the staged provider.

const redirect = (location: string, cookies: string[] = []) => {
  const headers = new Headers({ Location: location, 'Cache-Control': 'no-store' });
  for (const c of cookies) headers.append('Set-Cookie', c);
  return new Response(null, { status: 302, headers });
};
const clearPending = `${TEST_PENDING_COOKIE}=; Path=/auth; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
// Back to the page, which shows the outcome (ui.ts reads ?aanmeldtest=).
const back = (outcome: string) => redirect(`/?${new URLSearchParams({ aanmeldtest: outcome })}`, [clearPending]);

// GET /auth/test-login — a link on the page, so the (SameSite=Strict)
// installer session comes along: only an installer admin starts a test.
export async function startTest(request: Request, env: Env): Promise<Response> {
  const sessionId = await sessionFrom(env, request);
  if (!sessionId) return back('geen-sessie');
  const state = await loadState(env);
  const staged = state.loginChange?.staged;
  if (!staged) return back('niets-klaargezet');
  const provider = await discovery(staged.login.issuer);
  if (!provider) return back('provider-onbereikbaar');
  const pending = random(24);
  const verifier = random(48);
  const nonce = random(16);
  const record = { verifier, nonce, sessionId, sessionEmail: await sessionEmail(env, sessionId), stagedAt: staged.at };
  await env.INSTALLER_STATE.put(`login-test-pending:${pending}`, JSON.stringify(record), { expirationTtl: PENDING_TTL_S });
  const target = new URL(provider.authorization_endpoint);
  target.search = new URLSearchParams({
    response_type: 'code',
    client_id: browserClient(staged.login).clientId,
    redirect_uri: `${new URL(request.url).origin}${TEST_CALLBACK_PATH}`,
    scope: 'openid profile email',
    state: pending,
    nonce,
    code_challenge: await pkceChallenge(verifier),
    code_challenge_method: 'S256',
    // Always ask: the admin may be signed in there with another account.
    prompt: 'login',
  }).toString();
  return redirect(target.toString(), [`${TEST_PENDING_COOKIE}=${pending}; Path=/auth; HttpOnly; Secure; SameSite=Lax; Max-Age=${PENDING_TTL_S}`]);
}

// GET /auth/test-callback — the provider's redirect back. The session cookie
// doesn't come along on this cross-site redirect (SameSite=Strict); the
// pending record ties the answer to the session that started the test.
export async function finishTest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const pending = url.searchParams.get('state') ?? '';
  const cookie = (request.headers.get('Cookie') ?? '').split(/;\s*/).find((c) => c.startsWith(`${TEST_PENDING_COOKIE}=`))?.slice(TEST_PENDING_COOKIE.length + 1);
  const saved = pending
    ? await env.INSTALLER_STATE.get<{ verifier: string; nonce: string; sessionId: string; sessionEmail: string | null; stagedAt: string }>(`login-test-pending:${pending}`, 'json')
    : null;
  if (pending) await env.INSTALLER_STATE.delete(`login-test-pending:${pending}`);
  if (!saved || !cookie || !safeEqual(cookie, pending)) return back('verlopen');
  const code = url.searchParams.get('code');
  if (!code) return back('geweigerd');

  const state = await loadState(env);
  const staged = state.loginChange?.staged;
  if (!staged || staged.at !== saved.stagedAt) return back('niets-klaargezet');
  const provider = await discovery(staged.login.issuer);
  if (!provider) return back('provider-onbereikbaar');
  const client = browserClient(staged.login);
  const res = await fetch(provider.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: `${url.origin}${TEST_CALLBACK_PATH}`,
      client_id: client.clientId,
      client_secret: await unsealValue(env, state, client.clientSecret),
      code_verifier: saved.verifier,
    }).toString(),
  }).catch(() => null);
  const tokens = res?.ok ? ((await res.json().catch(() => null)) as { id_token?: string } | null) : null;
  const claims = tokens?.id_token ? claimsOf(tokens.id_token) : null;
  const audience = Array.isArray(claims?.aud) ? claims.aud : [claims?.aud];
  if (!claims || !sameIssuer(claims.iss, staged.login.issuer) || !audience.includes(client.clientId) || claims.nonce !== saved.nonce) return back('mislukt');
  const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '';
  const sub = typeof claims.sub === 'string' ? claims.sub : '';
  if (!email || !sub) return back('geen-email');
  // A session that doesn't know who it is (password, recovery code): the
  // address at the new provider must be on the admin list itself.
  if (!saved.sessionEmail && !isAdmin(state, email)) return back('geen-beheerder');
  state.loginChange!.test = { at: new Date().toISOString(), stagedAt: staged.at, sessionId: saved.sessionId, sessionEmail: saved.sessionEmail, email, sub, emailVerified: claims.email_verified === true };
  await saveState(env, state);
  return back(claims.email_verified === true ? 'ok' : 'niet-bevestigd');
}

// ---------------------------------------------------------------------------
// Apply and undo.

export interface ChangeContext {
  env: Env;
  state: InstallerState;
  cf: Cloudflare;
  sessionId: string;
  t: Messages;
}

type Outcome = { ok: true } | { ok: false; status: number; error: string };

const refuse = (error: string, status = 409): Outcome => ({ ok: false, status, error });

// The switch itself, the existing way: the backend with the new DEFAULT_IDP_*
// (and admin list), then its seeded 'default' provider row cleared — and the
// bff, which has the same DEFAULT_IDP_* (it signs people in with them).
async function redeployLogin(ctx: ChangeContext) {
  for (const id of ['worker:arcanum-backend', 'login:reset', 'worker:arcanum-bff']) {
    const outcome = await runStep(id, { env: ctx.env, state: ctx.state, cf: ctx.cf, t: ctx.t });
    ctx.state.steps[id] = { status: 'done', at: new Date().toISOString(), detail: outcome.detail };
  }
}

function preconditions(state: InstallerState, t: Messages): string | null {
  if (!state.installed || !state.release || !state.cloudflare || !backendDb(state)) return t.change.installFirst;
  // The recovery code only works on the installer's own address — it must be
  // reachable when the old provider isn't (or the new one doesn't work).
  if (state.behindArcanum?.publicAccessRemoved) return t.change.publicAccessOff;
  return null;
}

export async function applyChange(ctx: ChangeContext): Promise<Outcome & { resign?: Person[] }> {
  const { env, state, t } = ctx;
  const blocked = preconditions(state, t);
  if (blocked) return refuse(blocked);
  const change = (state.loginChange ??= {});
  const staged = change.staged;
  let snapshot: Snapshot;

  if (change.applied?.phase === 'started') {
    // A switch that stopped half way: finish it with the snapshot already
    // taken — never a new one, which could capture half-changed data.
    snapshot = JSON.parse(await unsealValue(env, state, change.applied.snapshot));
    if (!staged) return refuse(t.change.stagedGone);
  } else {
    if (!staged) return refuse(t.change.stageFirst);
    const test = change.test;
    if (!test || test.stagedAt !== staged.at) return refuse(t.change.testFirst);
    if (test.sessionId !== ctx.sessionId) return refuse(t.change.sameSession);
    if (!test.emailVerified) return refuse(t.change.notVerified(test.email));
    const rows = await readMemberships(ctx.cf, state);
    const plan = planFor(rows, [test.sessionEmail ?? test.email, test.email], t);
    if (plan.problem) return refuse(plan.problem);
    snapshot = { rows, testerIds: plan.tester.map((r) => r.id), resignIds: plan.resign.map((r) => r.id), tester: { email: test.email, sub: test.sub, issuer: staged.login.issuer } };
    const at = new Date();
    const adminsAdded = isAdmin(state, test.email) ? null : test.email;
    change.applied = {
      at: at.toISOString(),
      undoUntil: new Date(at.getTime() + UNDO_DAYS * DAY_MS).toISOString(),
      phase: 'started',
      previous: { login: state.login!, signIn: state.bootstrap?.login ?? null, adminsAdded },
      to: { issuer: staged.login.issuer },
      snapshot: await sealValue(env, state, JSON.stringify(snapshot)),
    };
    // So the tester is an admin of this page and of Arcanum with the new address too.
    if (adminsAdded) state.admins = [state.admins, adminsAdded].filter(Boolean).join(', ');
    // The snapshot is stored before anything changes.
    await saveState(env, state);
  }

  const applied = change.applied!;
  try {
    state.login = staged.login;
    await redeployLogin(ctx);
    await ctx.cf.queryD1(state.cloudflare!.accountId, backendDb(state), APPLY_SQL, [
      JSON.stringify(snapshot.testerIds),
      snapshot.tester.sub,
      snapshot.tester.issuer,
      snapshot.tester.email,
      applied.at,
      JSON.stringify(snapshot.resignIds),
    ]);
  } catch (err) {
    await saveState(env, state);
    return refuse(t.change.applyHalfway(messageOf(err, t)), 502);
  }
  // This page's own sign-in follows (bootstrapped installers) — unless
  // Arcanum moved to the very client this page already signs in with (back
  // to login.kaboutersoft.be): then it stays as it is, self-service included.
  const start = startClientOf(state);
  if (state.bootstrap) {
    if (start && start.issuer === staged.login.issuer && start.clientId === staged.login.clientId) {
      state.bootstrap.login = start;
    } else {
      state.bootstrap.startClient ??= start;
      const client = browserClient(staged.login);
      state.bootstrap.login = { issuer: staged.login.issuer, clientId: client.clientId, clientSecret: client.clientSecret, selfService: false };
    }
  }
  applied.phase = 'done';
  delete change.staged;
  delete change.test;
  await saveState(env, state);
  return { ok: true, resign: snapshot.rows.filter((r) => snapshot.resignIds.includes(r.id)).map(person) };
}

export async function undoChange(ctx: ChangeContext): Promise<Outcome> {
  const { env, state, t } = ctx;
  const applied = state.loginChange?.applied;
  if (!applied) return refuse(t.change.nothingToUndo);
  if (!state.installed || !state.cloudflare || !backendDb(state)) return refuse(t.change.installFirst);
  const snapshot: Snapshot = JSON.parse(await unsealValue(env, state, applied.snapshot));
  try {
    state.login = applied.previous.login;
    await redeployLogin(ctx);
    const accountId = state.cloudflare.accountId;
    await ctx.cf.queryD1(accountId, backendDb(state), UNDO_NEW_SQL, [applied.to.issuer, JSON.stringify(snapshot.rows.map((r) => r.id))]);
    await ctx.cf.queryD1(accountId, backendDb(state), UNDO_RESTORE_SQL, [JSON.stringify(snapshot.rows.map(({ id, user_sub, issuer, status, invited_email, accepted_at }) => ({ id, user_sub, issuer, status, invited_email, accepted_at })))]);
  } catch (err) {
    await saveState(env, state);
    return refuse(t.change.undoHalfway(messageOf(err, t)), 502);
  }
  if (state.bootstrap && applied.previous.signIn) state.bootstrap.login = applied.previous.signIn;
  delete state.loginChange;
  await saveState(env, state);
  return { ok: true };
}

// After 7 days the snapshot (and with it the undo) is dropped. Not a switch
// that stopped half way: that still needs it to be finished or undone.
export function dropExpiredSnapshot(state: InstallerState, now = Date.now()): boolean {
  const applied = state.loginChange?.applied;
  if (!applied || applied.phase !== 'done' || now < Date.parse(applied.undoUntil)) return false;
  delete state.loginChange!.applied;
  return true;
}

// ---------------------------------------------------------------------------
// What the page shows (GET /api/login-change).

export async function changeInfo(env: Env, state: InstallerState, sessionId: string, installerOrigin: string, cf: Cloudflare | null, t: Messages) {
  const change = state.loginChange ?? {};
  const staged = change.staged;
  const url = publicUrl(state);
  const callbackUrls = [
    `${installerOrigin}${TEST_CALLBACK_PATH}`,
    ...(state.bootstrap ? [`${installerOrigin}/auth/callback`] : []),
    ...(url ? [`${url}/callback`] : []),
    ...(state.customDomain && workersDevUrl(state) ? [`${workersDevUrl(state)}/callback`] : []),
  ];
  const test = staged && change.test?.stagedAt === staged.at ? change.test : undefined;
  let preview: { tester: Person[]; resign: Person[]; problem: string | null } | null = null;
  let previewError: string | null = null;
  if (staged && state.installed && backendDb(state)) {
    if (!cf) previewError = t.change.previewToken;
    else {
      try {
        const rows = await readMemberships(cf, state);
        const plan = planFor(rows, test ? [test.sessionEmail ?? test.email, test.email] : [(await sessionEmail(env, sessionId)) ?? ''], t);
        preview = { tester: plan.tester.map(person), resign: plan.resign.map(person), problem: test ? plan.problem : null };
      } catch (err) {
        previewError = t.change.membersUnreadable(messageOf(err, t));
      }
    }
  }
  let applied = null;
  if (change.applied) {
    const snapshot: Snapshot = JSON.parse(await unsealValue(env, state, change.applied.snapshot));
    applied = {
      at: change.applied.at,
      undoUntil: change.applied.undoUntil,
      phase: change.applied.phase,
      from: { issuer: change.applied.previous.login.issuer },
      to: change.applied.to,
      tester: { email: snapshot.tester.email, sub: snapshot.tester.sub, orgs: snapshot.rows.filter((r) => snapshot.testerIds.includes(r.id)).map(person) },
      resign: snapshot.rows.filter((r) => snapshot.resignIds.includes(r.id)).map(person),
    };
  }
  return {
    installed: !!state.installed,
    current: state.login ? { issuer: state.login.issuer, clientId: state.login.clientId } : null,
    staged: staged
      ? { issuer: staged.login.issuer, clientId: staged.login.clientId, authCodeClientId: staged.login.authCodeClientId ?? null, scopes: staged.login.scopes ?? null, at: staged.at, browserClientId: browserClient(staged.login).clientId }
      : null,
    test: test ? { email: test.email, sub: test.sub, emailVerified: test.emailVerified, at: test.at, thisSession: test.sessionId === sessionId } : null,
    callbackUrls,
    preview,
    previewError,
    applied,
  };
}
