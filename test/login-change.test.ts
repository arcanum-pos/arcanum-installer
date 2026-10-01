// "Aanmelding wijzigen" on an installed, bootstrapped instance: stage a new
// provider, test-sign-in there, apply (snapshot, backend re-deploy + re-seed,
// the tester bound to the new (issuer, sub), everyone else pending by
// e-mail), undo for 7 days, and the recovery code as break glass. The
// backend's memberships live in a real SQLite database (TEST_BACKEND_DB),
// which the fake Cloudflare D1 API runs the installer's SQL against.
import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { INSTANCE_CLIENT, installFakes, NEXT_VERSION, PUBLIC_URL, SUBDOMAIN, TOKEN, type Fakes } from './fakes';

const ORIGIN = `https://arcanum-installer.${SUBDOMAIN}.workers.dev`;
const STATE_KEY = 'test-state-key-0123456789abcdef0123456789abcdef';
const CODE = 'handoff-code-0123456789abcdefghijklmnopqrstuv';
const OWNER = { email: 'jan@example.test', sub: 'user-123' };
const NEW_PROVIDER = { issuer: 'https://nieuw.test', clientId: 'nieuw-client', clientSecret: 'nieuw-client-secret-value' };
// Who Jan is at the new provider: another address.
const JAN_NEW = { sub: 'nieuw-sub-jan', email: 'Jan@Nieuw.test', email_verified: true };

async function sha256Hex(text: string) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

let fakes: Fakes;
let cookie = '';
let recoveryCode = '';
let workerEnv: Record<string, unknown> = {};
const db = () => env.TEST_BACKEND_DB;

async function call(method: string, path: string, body?: unknown, opts: { cookie?: string | null; headers?: Record<string, string> } = {}) {
  const sent = opts.cookie === undefined ? cookie : opts.cookie;
  const res = await worker.fetch(
    new Request(`${ORIGIN}${path}`, {
      method,
      redirect: 'manual',
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(sent ? { Cookie: sent } : {}), ...opts.headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
    workerEnv as never
  );
  const setCookie = res.headers.getSetCookie?.() ?? [];
  const session = setCookie.find((c) => c.startsWith('arcanum_installer='));
  if (session && opts.cookie === undefined) cookie = session.split(';')[0];
  const text = res.headers.get('Content-Type')?.includes('json') ? await res.text() : '';
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers, setCookie };
}

async function runAll() {
  const status = (await call('GET', '/api/status')).body;
  for (const step of status.steps) {
    for (let attempt = 0; attempt < 10; attempt++) {
      const r = await call('POST', '/api/step', { id: step.id });
      if (r.body.status === 'done') break;
      if (r.body.status === 'failed') throw new Error(`${step.id}: ${r.body.detail}`);
    }
  }
}

const binding = (script: string, name: string) => (fakes.cf.scripts.get(script)!.metadata.bindings as any[]).find((b) => b.name === name);
const backendDb = () => [...fakes.cf.d1.values()].find((d) => d.name === 'arcanum-backend')!;
const rows = async () => (await db().prepare('SELECT * FROM memberships ORDER BY id').all<Record<string, unknown>>()).results;
const row = async (id: string) => (await db().prepare('SELECT * FROM memberships WHERE id = ?').bind(id).first<Record<string, unknown>>())!;

// The backend's tables, as arcanum-backend schema.sql has them (the columns used here).
async function seedMemberships() {
  for (const t of ['memberships', 'identity_providers', 'organizations']) await db().prepare(`DROP TABLE IF EXISTS ${t}`).run();
  await db().batch([
    db().prepare('CREATE TABLE organizations (id TEXT PRIMARY KEY, name TEXT NOT NULL)'),
    db().prepare('CREATE TABLE identity_providers (org_id TEXT PRIMARY KEY, issuer_url TEXT, client_id TEXT, updated_at TEXT NOT NULL)'),
    db().prepare(
      'CREATE TABLE memberships (id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), user_sub TEXT, issuer TEXT, invited_email TEXT NOT NULL, role TEXT NOT NULL, status TEXT NOT NULL, invited_at TEXT NOT NULL, accepted_at TEXT)'
    ),
    db().prepare('CREATE UNIQUE INDEX idx_memberships_org_email ON memberships(org_id, invited_email)'),
    db().prepare("INSERT INTO organizations VALUES ('org-1', 'Scouts Elewijt'), ('org-2', 'Eigen IdP vzw')"),
    // An org with an identity provider of its own: not the instance's provider's business.
    db().prepare("INSERT INTO identity_providers VALUES ('org-2', 'https://eigen.test', 'eigen', '2026-09-01')"),
    db().prepare(
      "INSERT INTO memberships VALUES " +
        "('m1', 'org-1', 'user-123', 'https://login.test', 'jan@example.test', 'admin', 'active', '2026-09-01', '2026-09-01T10:00:00Z'), " +
        "('m2', 'org-1', 'piet-sub', 'https://login.test', 'piet@example.test', 'cashier', 'active', '2026-09-02', '2026-09-02T10:00:00Z'), " +
        "('m3', 'org-1', NULL, NULL, 'an@example.test', 'cashier', 'pending', '2026-09-03', NULL), " +
        "('m4', 'org-2', 'eigen-sub', 'https://eigen.test', 'jan@example.test', 'admin', 'active', '2026-09-04', '2026-09-04T10:00:00Z')"
    ),
  ]);
}

beforeEach(async () => {
  for (const key of (await env.INSTALLER_STATE.list()).keys) await env.INSTALLER_STATE.delete(key.name);
  fakes = await installFakes();
  fakes.cf.sqlDb = env.TEST_BACKEND_DB;
  cookie = '';
  workerEnv = {
    ...env,
    INSTALLER_STATE_KEY: STATE_KEY,
    BOOTSTRAP_CONFIG: JSON.stringify({
      version: 1,
      cloudflareToken: TOKEN,
      accountId: 'acc-1',
      accountName: 'Scouts Elewijt',
      subdomain: SUBDOMAIN,
      login: { issuer: 'https://login.test', clientId: INSTANCE_CLIENT.id, clientSecret: INSTANCE_CLIENT.secret },
      owner: OWNER,
      handoffCodeHash: await sha256Hex(CODE),
      handoffExpiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    }),
  };
  fakes.cf.kv.set('kv-installer', 'arcanum-installer-INSTALLER_STATE');
  fakes.cf.scripts.set('arcanum-installer', { metadata: { bindings: [{ type: 'kv_namespace', name: 'INSTALLER_STATE', namespace_id: 'kv-installer' }] }, modules: {}, order: 0 });
  const handoff = await call('POST', '/api/handoff', { code: CODE }, { cookie: null });
  expect(handoff.status).toBe(200);
  cookie = handoff.setCookie.find((c) => c.startsWith('arcanum_installer='))!.split(';')[0];
  recoveryCode = handoff.body.recoveryCode;
});

afterEach(() => vi.restoreAllMocks());

async function install() {
  await call('POST', '/api/release', { version: '0.1.1' });
  await runAll();
  expect((await call('GET', '/api/status')).body.installed).toBeTruthy();
  await seedMemberships();
}

const stage = (body: Record<string, unknown> = NEW_PROVIDER) => call('POST', '/api/login-change/stage', body);

// The admin's browser: /auth/test-login (with the installer session) → the new
// provider, where they sign in → back to /auth/test-callback (without the
// Strict session cookie — only the pending cookie).
async function testSignIn(claims: Record<string, unknown>, opts: { pendingCookie?: string } = {}) {
  const start = await call('GET', '/auth/test-login');
  expect(start.status).toBe(302);
  const authorize = start.headers.get('Location')!;
  const pending = start.setCookie.find((c) => c.startsWith('arcanum_installer_test='))!.split(';')[0];
  const code = fakes.newIssuer.approve(authorize, claims);
  const back = await call('GET', `/auth/test-callback?code=${code}&state=${new URL(authorize).searchParams.get('state')}`, undefined, { cookie: opts.pendingCookie ?? pending });
  return { authorize: new URL(authorize), back: back.headers.get('Location') };
}

async function stageAndTest(claims: Record<string, unknown> = JAN_NEW) {
  expect((await stage()).status).toBe(200);
  expect((await testSignIn(claims)).back).toBe('/?aanmeldtest=ok');
}

describe('the direct switch', () => {
  it('stays as today before the first install, and is refused once installed (another provider or client)', async () => {
    // Before the install: choosing a provider is just saving it; there's nothing to stage.
    const before = await call('POST', '/api/login-provider', NEW_PROVIDER);
    expect(before.status, JSON.stringify(before.body)).toBe(200);
    expect(before.body.login.issuer).toBe('https://nieuw.test');
    expect((await stage()).status).toBe(409);
    await call('POST', '/api/login-provider', { issuer: 'https://login.test', clientId: INSTANCE_CLIENT.id, clientSecret: INSTANCE_CLIENT.secret });
    await install();

    const refused = await call('POST', '/api/login-provider', NEW_PROVIDER);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ useLoginChange: true });
    expect(refused.body.error).toMatch(/Aanmelding wijzigen/);
    const otherClient = await call('POST', '/api/login-provider', { issuer: 'https://login.test', clientId: 'arcanum-client', clientSecret: 'idp-client-secret-value-xyz' });
    expect(otherClient.status).toBe(409);
    expect((await call('GET', '/api/status')).body.login.issuer).toBe('https://login.test');
    expect(binding('arcanum-backend', 'DEFAULT_IDP_ISSUER_URL').text).toBe('https://login.test');
    // The same provider and client (other scopes) is still saved directly.
    expect((await call('POST', '/api/login-provider', { issuer: 'https://login.test', clientId: INSTANCE_CLIENT.id, scopes: 'openid profile email' })).status).toBe(200);
  });
});

describe('stage and test sign-in', () => {
  beforeEach(install);

  it('stages the new provider after the same checks as step 2 — nothing is applied', async () => {
    const wrong = await stage({ ...NEW_PROVIDER, clientSecret: 'fout' });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toMatch(/secret/i);
    expect((await stage({ issuer: 'https://nodevice.test', clientId: 'x', clientSecret: 'y' })).body.error).toMatch(/apparaat-aanmelding/);

    const staged = await stage();
    expect(staged.status, JSON.stringify(staged.body)).toBe(200);
    expect(staged.body.staged).toMatchObject({ issuer: 'https://nieuw.test', clientId: 'nieuw-client', browserClientId: 'nieuw-client' });
    expect(staged.body.checks.every((c: any) => c.ok)).toBe(true);
    // Exactly the callbacks to register at the new provider.
    expect(staged.body.callbackUrls).toEqual([`${ORIGIN}/auth/test-callback`, `${ORIGIN}/auth/callback`, `${PUBLIC_URL}/callback`]);
    // Before the test: who'd have to sign in again (the session's own memberships stay bound).
    expect(staged.body.preview).toEqual({ tester: [{ email: 'jan@example.test', role: 'admin', org: 'Scouts Elewijt' }], resign: [{ email: 'piet@example.test', role: 'cashier', org: 'Scouts Elewijt' }], problem: null });
    expect(staged.body.test).toBeNull();
    // Nothing changed.
    const status = (await call('GET', '/api/status')).body;
    expect(status.login.issuer).toBe('https://login.test');
    expect(status.loginChange).toEqual({ staged: { issuer: 'https://nieuw.test' }, applied: null });
    expect(binding('arcanum-backend', 'DEFAULT_IDP_ISSUER_URL').text).toBe('https://login.test');
    expect((await row('m2')).status).toBe('active');
  });

  it('test sign-in: from an installer session only, with the test callback, and shows e-mail, sub and email_verified', async () => {
    await stage();
    // Without an installer session: no test.
    const anonymous = await call('GET', '/auth/test-login', undefined, { cookie: null });
    expect(anonymous.headers.get('Location')).toBe('/?aanmeldtest=geen-sessie');

    const { authorize, back } = await testSignIn(JAN_NEW);
    expect(`${authorize.origin}${authorize.pathname}`).toBe('https://nieuw.test/authorize');
    expect(Object.fromEntries(authorize.searchParams)).toMatchObject({ response_type: 'code', client_id: 'nieuw-client', redirect_uri: `${ORIGIN}/auth/test-callback`, code_challenge_method: 'S256', scope: 'openid profile email' });
    expect(authorize.searchParams.get('nonce')).toBeTruthy();
    expect(back).toBe('/?aanmeldtest=ok');
    expect(fakes.newIssuer.tokenRequests.at(-1)).toMatchObject({ client_id: 'nieuw-client', client_secret: NEW_PROVIDER.clientSecret, redirect_uri: `${ORIGIN}/auth/test-callback` });
    const info = (await call('GET', '/api/login-change')).body;
    expect(info.test).toMatchObject({ email: 'jan@nieuw.test', sub: 'nieuw-sub-jan', emailVerified: true, thisSession: true });
    // Jan is found by his installer address and his new one.
    expect(info.preview.tester).toEqual([{ email: 'jan@example.test', role: 'admin', org: 'Scouts Elewijt' }]);
    // A test is not a sign-in: no installer session came out of it, nothing switched.
    expect(binding('arcanum-backend', 'DEFAULT_IDP_ISSUER_URL').text).toBe('https://login.test');

    // Another browser's answer, an unverified address: refused / not enough.
    expect((await testSignIn(JAN_NEW, { pendingCookie: 'arcanum_installer_test=iemand-anders' })).back).toBe('/?aanmeldtest=verlopen');
    expect((await testSignIn({ ...JAN_NEW, email_verified: false })).back).toBe('/?aanmeldtest=niet-bevestigd');
    expect((await call('GET', '/api/login-change')).body.test.emailVerified).toBe(false);
    const apply = await call('POST', '/api/login-change/apply', {});
    expect(apply.status).toBe(409);
    expect(apply.body.error).toMatch(/niet bevestigd/);
  });

  it('a session that does not know who it is (the recovery code) may only test as an address on the admin list', async () => {
    await stage();
    cookie = '';
    expect((await call('POST', '/api/login', { recoveryCode: recoveryCode })).status).toBe(200);
    expect((await testSignIn(JAN_NEW)).back).toBe('/?aanmeldtest=geen-beheerder');
    expect((await testSignIn({ sub: 'nieuw-sub-jan', email: OWNER.email, email_verified: true })).back).toBe('/?aanmeldtest=ok');
  });
});

describe('apply', () => {
  beforeEach(install);

  it('needs the test first, from the same session', async () => {
    await stage();
    const early = await call('POST', '/api/login-change/apply', {});
    expect(early.status).toBe(409);
    expect(early.body.error).toMatch(/test-aanmelding/);
    await testSignIn(JAN_NEW);
    const other = await call('POST', '/api/login-change/apply', {}, { cookie: (await call('POST', '/api/login', { recoveryCode: recoveryCode }, { cookie: null })).setCookie[0].split(';')[0] });
    expect(other.status).toBe(409);
    expect(other.body.error).toMatch(/dezelfde sessie/);
  });

  it('snapshots, switches the backend (DEFAULT_IDP_* + re-seed), binds the tester, sets everyone else pending, and lists them', async () => {
    const before = await rows();
    await stageAndTest();
    const backendOrder = fakes.cf.scripts.get('arcanum-backend')!.order;
    const queriesBefore = backendDb().queries.length;
    const fetchesBefore = fakes.fetchCalls();

    const applied = await call('POST', '/api/login-change/apply', {});
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    expect(applied.body.applied).toMatchObject({
      phase: 'done',
      from: { issuer: 'https://login.test' },
      to: { issuer: 'https://nieuw.test' },
      tester: { email: 'jan@nieuw.test', sub: 'nieuw-sub-jan', orgs: [{ email: 'jan@example.test', role: 'admin', org: 'Scouts Elewijt' }] },
      resign: [{ email: 'piet@example.test', role: 'cashier', org: 'Scouts Elewijt' }],
    });
    expect(Date.parse(applied.body.applied.undoUntil) - Date.parse(applied.body.applied.at)).toBe(7 * 24 * 60 * 60 * 1000);
    expect(applied.body.staged).toBeNull();

    // The backend: re-deployed with the new provider (and Jan's new address as admin), its seeded row cleared.
    expect(fakes.cf.scripts.get('arcanum-backend')!.order).toBeGreaterThan(backendOrder);
    expect(binding('arcanum-backend', 'DEFAULT_IDP_ISSUER_URL').text).toBe('https://nieuw.test');
    expect(binding('arcanum-backend', 'DEFAULT_IDP_CLIENT_ID').text).toBe('nieuw-client');
    expect(binding('arcanum-backend', 'DEFAULT_IDP_CLIENT_SECRET').text).toBe(NEW_PROVIDER.clientSecret);
    expect(binding('arcanum-backend', 'INSTANCE_ADMIN_EMAILS').text).toBe('jan@example.test, jan@nieuw.test');
    const newQueries = backendDb().queries.slice(queriesBefore);
    expect(newQueries.filter((q) => q.includes("DELETE FROM identity_providers WHERE org_id = 'default'"))).toHaveLength(1);
    // Three queries on the backend database in all: the snapshot read, the re-seed, one UPDATE.
    expect(newQueries).toHaveLength(3);
    expect(newQueries.filter((q) => /^UPDATE memberships/.test(q))).toHaveLength(1);
    expect(fakes.fetchCalls() - fetchesBefore).toBeLessThan(15);

    // The memberships.
    expect(await row('m1')).toMatchObject({ user_sub: 'nieuw-sub-jan', issuer: 'https://nieuw.test', status: 'active', invited_email: 'jan@nieuw.test', role: 'admin', accepted_at: applied.body.applied.at });
    expect(await row('m2')).toMatchObject({ user_sub: null, issuer: null, status: 'pending', invited_email: 'piet@example.test', role: 'cashier', accepted_at: null });
    expect(await row('m3')).toEqual(before.find((r) => r.id === 'm3'));
    expect(await row('m4')).toEqual(before.find((r) => r.id === 'm4'));

    // The snapshot is sealed: no sub or address of it in the stored state.
    const stored = (await env.INSTALLER_STATE.get('state'))!;
    expect(JSON.parse(stored).loginChange.applied.snapshot).toMatchObject({ iv: expect.any(String), data: expect.any(String) });
    for (const secret of ['piet-sub', 'piet@example.test', NEW_PROVIDER.clientSecret]) expect(stored).not.toContain(secret);

    // This page's own sign-in moved to the new provider — and Jan gets in with his new account.
    const start = await call('GET', '/auth/login', undefined, { cookie: null });
    const authorize = start.headers.get('Location')!;
    expect(new URL(authorize).host).toBe('nieuw.test');
    const code = fakes.newIssuer.approve(authorize, JAN_NEW);
    const pending = start.setCookie.find((c) => c.startsWith('arcanum_installer_oidc='))!.split(';')[0];
    const signedIn = await call('GET', `/auth/callback?code=${code}&state=${new URL(authorize).searchParams.get('state')}`, undefined, { cookie: pending });
    expect(signedIn.headers.get('Location')).toBe('/');
    expect((await call('GET', '/api/login-options', undefined, { cookie: null })).body.account).toEqual({ issuer: 'https://nieuw.test' });
    // Not the bootstrapper's client any more: no /clients/self at the new provider.
    await call('POST', '/api/address', { customDomain: 'arcanum.scouts-elewijt.be' });
    expect((await call('GET', '/api/status')).body.steps.some((s: any) => s.id === 'login:uris')).toBe(false);
  });

  it('every membership write is one statement with its data as JSON parameters', async () => {
    await stageAndTest();
    await call('POST', '/api/login-change/apply', {});
    await call('POST', '/api/login-change/undo', {});
    const writes = backendDb().queries.filter((q) => /^UPDATE memberships/.test(q));
    expect(writes).toHaveLength(3); // apply 1, undo 2
    for (const q of writes) expect(q).not.toContain(';');
    expect(writes.every((q) => q.includes('json_each(?'))).toBe(true);
    for (const params of backendDb().params) expect(params.length).toBeLessThanOrEqual(6);
  });

  it('refuses when the tester has no membership in Arcanum — and changes nothing', async () => {
    await db().prepare("DELETE FROM memberships WHERE id = 'm1'").run();
    const before = await rows();
    await stageAndTest();
    const r = await call('POST', '/api/login-change/apply', {});
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/geen lidmaatschap voor jan@example\.test of jan@nieuw\.test/);
    expect(await rows()).toEqual(before);
    expect(binding('arcanum-backend', 'DEFAULT_IDP_ISSUER_URL').text).toBe('https://login.test');
    expect((await call('GET', '/api/status')).body.loginChange.applied).toBeNull();
  });

  it('a switch that stops half way keeps its snapshot and is finished by applying again', async () => {
    const before = await rows();
    await stageAndTest();
    fakes.cf.failOnce(/^PUT \/accounts\/acc-1\/workers\/scripts\/arcanum-backend$/, 'Upload failed');
    const first = await call('POST', '/api/login-change/apply', {});
    expect(first.status).toBe(502);
    expect(first.body.error).toMatch(/halverwege.*Upload failed/);
    expect(first.body.info.applied.phase).toBe('started');
    expect(await rows()).toEqual(before);
    const again = await call('POST', '/api/login-change/apply', {});
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body.applied.phase).toBe('done');
    expect((await row('m1')).issuer).toBe('https://nieuw.test');
    // The snapshot is the one from before the first attempt: undo restores everything.
    expect((await call('POST', '/api/login-change/undo', {})).status).toBe(200);
    expect(await rows()).toEqual(before);
  });
});

describe('undo', () => {
  beforeEach(install);

  it('"Terugzetten" restores the previous provider and every membership exactly', async () => {
    const before = await rows();
    await stageAndTest();
    await call('POST', '/api/login-change/apply', {});
    // Since the switch: Piet signed in at the new provider (reconciled), and someone new was invited and signed in.
    await db().prepare("UPDATE memberships SET user_sub = 'piet-nieuw', issuer = 'https://nieuw.test', status = 'active', accepted_at = '2026-09-30T12:00:00Z' WHERE id = 'm2'").run();
    await db().prepare("INSERT INTO memberships VALUES ('m5', 'org-1', 'mie-nieuw', 'https://nieuw.test', 'mie@example.test', 'cashier', 'active', '2026-09-30', '2026-09-30T12:00:00Z')").run();

    const undone = await call('POST', '/api/login-change/undo', {});
    expect(undone.status, JSON.stringify(undone.body)).toBe(200);
    expect(undone.body.applied).toBeNull();
    const after = await rows();
    expect(after.filter((r) => r.id !== 'm5')).toEqual(before);
    // Not in the snapshot: back to pending, to re-activate under the old provider.
    expect(after.find((r) => r.id === 'm5')).toMatchObject({ user_sub: null, issuer: null, status: 'pending', invited_email: 'mie@example.test', role: 'cashier' });

    expect(binding('arcanum-backend', 'DEFAULT_IDP_ISSUER_URL').text).toBe('https://login.test');
    expect(binding('arcanum-backend', 'DEFAULT_IDP_CLIENT_ID').text).toBe(INSTANCE_CLIENT.id);
    expect(backendDb().queries.filter((q) => q.includes("DELETE FROM identity_providers WHERE org_id = 'default'")).length).toBe(3); // install, apply, undo
    const status = (await call('GET', '/api/status')).body;
    expect(status.login.issuer).toBe('https://login.test');
    expect(status.loginChange).toEqual({ staged: null, applied: null });
    // This page signs in at the old provider again, with the bootstrapper's client.
    const start = await call('GET', '/auth/login', undefined, { cookie: null });
    expect(new URL(start.headers.get('Location')!).searchParams.get('client_id')).toBe(INSTANCE_CLIENT.id);
    expect((await call('POST', '/api/login-change/undo', {})).status).toBe(409);
  });

  it('is possible for 7 days; then the snapshot is dropped', async () => {
    await stageAndTest();
    await call('POST', '/api/login-change/apply', {});
    const state = await env.INSTALLER_STATE.get<any>('state', 'json');
    state.loginChange.applied.undoUntil = new Date(Date.now() - 1000).toISOString();
    await env.INSTALLER_STATE.put('state', JSON.stringify(state));
    expect((await call('GET', '/api/status')).body.loginChange.applied).toBeNull();
    expect((await env.INSTALLER_STATE.get<any>('state', 'json')).loginChange.applied).toBeUndefined();
    const undo = await call('POST', '/api/login-change/undo', {});
    expect(undo.status).toBe(409);
    expect(binding('arcanum-backend', 'DEFAULT_IDP_ISSUER_URL').text).toBe('https://nieuw.test');
  });

  it('break glass: with both providers unreachable, the recovery code gets in and undo works', async () => {
    const before = await rows();
    await stageAndTest();
    await call('POST', '/api/login-change/apply', {});
    fakes.unreachable.add('login.test');
    fakes.unreachable.add('nieuw.test');
    cookie = '';
    // Signing in with an account can't work now…
    expect((await call('GET', '/auth/login', undefined, { cookie: null })).headers.get('Location')).toBe('/?fout=provider-onbereikbaar');
    // …the recovery code can.
    expect((await call('POST', '/api/login', { recoveryCode: recoveryCode })).status).toBe(200);
    const info = await call('GET', '/api/login-change');
    expect(info.body.applied.resign).toEqual([{ email: 'piet@example.test', role: 'cashier', org: 'Scouts Elewijt' }]);
    expect((await call('POST', '/api/login-change/undo', {})).status).toBe(200);
    expect(await rows()).toEqual(before);
    expect(binding('arcanum-backend', 'DEFAULT_IDP_ISSUER_URL').text).toBe('https://login.test');
  });
});

describe("the installer's own address during a change", () => {
  it('staging switches it back on; it stays on while the change is under way, and closing waits for it', async () => {
    // A release whose bff forwards /installer/*: the installer is linked when the bff is deployed.
    fakes.releases.offerUpdate = true;
    await call('POST', '/api/release', { version: NEXT_VERSION });
    await runAll();
    await seedMemberships();
    expect(binding('arcanum-bff', 'ARCANUM_INSTALLER_SERVICE').service).toBe('arcanum-installer');
    const via = { cookie: null, headers: { 'X-Installer-Key': binding('arcanum-bff', 'INSTALLER_INTERNAL_KEY').text, 'X-User-Email': OWNER.email } };
    fakes.cf.workersDev.set('arcanum-installer', true);
    expect((await call('POST', '/api/public-access/close', {}, via)).status).toBe(200);
    expect(fakes.cf.workersDev.get('arcanum-installer')).toBe(false);

    const staged = await call('POST', '/api/login-change/stage', NEW_PROVIDER, via);
    expect(staged.status, JSON.stringify(staged.body)).toBe(200);
    expect(fakes.cf.workersDev.get('arcanum-installer')).toBe(true);
    expect((await call('GET', '/api/public-access', undefined, via)).body).toMatchObject({ directEnabled: true, loginChange: true, shouldClose: false });
    const close = await call('POST', '/api/public-access/close', {}, via);
    expect(close.status).toBe(409);
    expect(close.body.error).toMatch(/aanmelding/);
    expect(fakes.cf.workersDev.get('arcanum-installer')).toBe(true);

    await call('POST', '/api/login-change/cancel', {}, via);
    expect((await call('GET', '/api/public-access', undefined, via)).body).toMatchObject({ loginChange: false, shouldClose: true });
  });
});
