// An installer made by the bootstrapper (arcanum.kaboutersoft.be): the
// handoff, the one-time import of BOOTSTRAP_CONFIG, signing in with an
// account (OIDC against a fake issuer) or the recovery code, the one-screen
// install, the custom domain registered at the login provider, and the
// self-update before an update. The Worker runs with its bootstrapped
// secrets (INSTALLER_STATE_KEY + BOOTSTRAP_CONFIG).
import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { DEV_VERSION, INSTALLER_LOGO, INSTANCE_CLIENT, installFakes, PUBLIC_URL, SELF_UPDATE_VERSION, SUBDOMAIN, TOKEN, type Fakes } from './fakes';

const ORIGIN = `https://arcanum-installer.${SUBDOMAIN}.workers.dev`;
const STATE_KEY = 'test-state-key-0123456789abcdef0123456789abcdef';
const CODE = 'handoff-code-0123456789abcdefghijklmnopqrstuv';
const OWNER = { email: 'jan@example.test', sub: 'user-123' };
const KV_ID = 'kv-installer';

async function sha256Hex(text: string) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// What the bootstrapper puts in the secret (arcanum-bootstrapper src/install.ts).
async function bootstrapConfig(overrides: Record<string, unknown> = {}, code = CODE) {
  return JSON.stringify({
    version: 1,
    cloudflareToken: TOKEN,
    accountId: 'acc-1',
    accountName: 'Scouts Elewijt',
    subdomain: SUBDOMAIN,
    login: { issuer: 'https://login.test', clientId: INSTANCE_CLIENT.id, clientSecret: INSTANCE_CLIENT.secret },
    owner: OWNER,
    handoffCodeHash: await sha256Hex(code),
    handoffExpiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    ...overrides,
  });
}

let fakes: Fakes;
let cookie = '';
let workerEnv: Record<string, unknown> = {};
const bodies: string[] = [];

async function useConfig(config: string | undefined, extra: Record<string, unknown> = {}) {
  workerEnv = { ...env, INSTALLER_STATE_KEY: STATE_KEY, BOOTSTRAP_CONFIG: config, ...extra };
}

beforeEach(async () => {
  for (const key of (await env.INSTALLER_STATE.list()).keys) await env.INSTALLER_STATE.delete(key.name);
  fakes = await installFakes();
  cookie = '';
  bodies.length = 0;
  await useConfig(await bootstrapConfig());
  // The installer as the bootstrapper uploaded it: its KV and its two secrets.
  fakes.cf.kv.set(KV_ID, 'arcanum-installer-INSTALLER_STATE');
  fakes.cf.scripts.set('arcanum-installer', {
    metadata: {
      compatibility_date: '2026-09-11',
      bindings: [
        { type: 'kv_namespace', name: 'INSTALLER_STATE', namespace_id: KV_ID },
        { type: 'secret_text', name: 'INSTALLER_STATE_KEY', text: STATE_KEY },
        { type: 'secret_text', name: 'BOOTSTRAP_CONFIG', text: workerEnv.BOOTSTRAP_CONFIG },
      ],
    },
    modules: {},
    order: 0,
  });
});

afterEach(() => vi.restoreAllMocks());

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
  bodies.push(text);
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers, setCookie };
}

// Like the page at /handoff: posts the code; a success signs this "browser" in.
async function handoff(code = CODE) {
  const r = await call('POST', '/api/handoff', { code }, { cookie: null });
  const session = r.setCookie.find((c) => c.startsWith('arcanum_installer='));
  if (session) cookie = session.split(';')[0];
  return r;
}

async function runAll() {
  const status = (await call('GET', '/api/status')).body;
  for (const step of status.steps) {
    for (let attempt = 0; attempt < 10; attempt++) {
      const r = await call('POST', '/api/step', { id: step.id });
      if (r.body.status === 'done') break;
      if (r.body.status === 'failed') return { failed: step.id, detail: r.body.detail };
    }
  }
  return { failed: null, detail: null };
}

const binding = (script: string, name: string) => (fakes.cf.scripts.get(script)!.metadata.bindings as any[]).find((b) => b.name === name);

describe('the handoff', () => {
  it('a valid code imports the config, signs the owner in and shows a recovery code once', async () => {
    const page = await worker.fetch(new Request(`${ORIGIN}/handoff?code=${CODE}`), workerEnv as never);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("api('api/handoff', { code })");

    const r = await handoff();
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.recoveryCode).toMatch(/^([A-Z2-9]{4}-){4}[A-Z2-9]{4}$/);
    expect(r.body).toMatchObject({ email: OWNER.email, firstImport: true });
    expect(cookie).toMatch(/^arcanum_installer=/);

    const status = (await call('GET', '/api/status')).body;
    expect(status.bootstrapped).toEqual({ owner: OWNER.email, issuer: 'https://login.test', startClient: { issuer: 'https://login.test', clientId: INSTANCE_CLIENT.id } });
    expect(status.access).toEqual({ via: 'session', email: OWNER.email });
    expect(status.cloudflare).toMatchObject({ accountId: 'acc-1', accountName: 'Scouts Elewijt', subdomain: SUBDOMAIN, remember: true, tokenAvailable: true });
    expect(status.login).toMatchObject({ issuer: 'https://login.test', clientId: INSTANCE_CLIENT.id, clientSecretSet: true });
    expect(status.admins).toBe(OWNER.email);
    expect(status.address.publicUrl).toBe(PUBLIC_URL);
  });

  it('keeps the token and client secret only sealed: not in KV in plain text, and taken off the Worker', async () => {
    const r = await handoff();
    const stored: string[] = [];
    for (const key of (await env.INSTALLER_STATE.list()).keys) stored.push((await env.INSTALLER_STATE.get(key.name)) ?? '');
    for (const secret of [TOKEN, INSTANCE_CLIENT.secret, CODE, r.body.recoveryCode]) expect(stored.join('\n')).not.toContain(secret);
    // BOOTSTRAP_CONFIG is replaced by a stub without anything in it.
    expect(fakes.cf.secretPuts).toEqual([{ script: 'arcanum-installer', name: 'BOOTSTRAP_CONFIG', text: JSON.stringify({ version: 1, imported: true }) }]);
    // Nothing the API answered contains the token or the client secret.
    for (const secret of [TOKEN, INSTANCE_CLIENT.secret]) expect(bodies.join('\n')).not.toContain(secret);
  });

  it('works once: the same code again is refused', async () => {
    expect((await handoff()).status).toBe(200);
    const again = await handoff();
    expect(again.status).toBe(410);
    expect(again.body.reason).toBe('used');
    // Also once the Worker's config is the stub.
    await useConfig(JSON.stringify({ version: 1, imported: true }));
    expect((await handoff()).body.reason).toBe('used');
  });

  it('refuses a wrong code and an expired one, and without a config there is nothing to hand over', async () => {
    const wrong = await handoff('not-the-code');
    expect(wrong.status).toBe(401);
    expect(wrong.body.reason).toBe('wrong');
    await useConfig(await bootstrapConfig({ handoffExpiresAt: new Date(Date.now() - 1000).toISOString() }));
    const expired = await handoff();
    expect(expired.status).toBe(410);
    expect(expired.body.reason).toBe('expired');
    expect((await call('GET', '/api/status', undefined, { cookie: null })).status).toBe(401);
    await useConfig(undefined);
    expect((await handoff()).status).toBe(404);
  });

  it('locks out after repeated wrong codes', async () => {
    for (let i = 0; i < 10; i++) await handoff(`wrong-${i}`);
    expect((await handoff()).status).toBe(429);
  });

  it('imports the config once: a later handoff refreshes the token and adds the owner, but keeps the login provider and what was set', async () => {
    const first = await handoff();
    expect((await call('POST', '/api/admins', { emails: 'iemand@scouts.test' })).status).toBe(200);
    const before = (await call('GET', '/api/status')).body;

    // The bootstrapper run again for this account: a new code, the client reused (login: null).
    const code2 = 'second-handoff-code-0123456789abcdefghijklmnop';
    await useConfig(await bootstrapConfig({ login: null, owner: { email: 'Jan@Example.test', sub: 'user-123' } }, code2));
    const second = await handoff(code2);
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body.firstImport).toBe(false);
    const after = (await call('GET', '/api/status')).body;
    expect(after.login).toEqual(before.login);
    expect(after.admins).toBe(`iemand@scouts.test, ${OWNER.email}`);
    // A new recovery code; the first one no longer works.
    expect(second.body.recoveryCode).not.toBe(first.body.recoveryCode);
    expect((await call('POST', '/api/login', { recoveryCode: first.body.recoveryCode }, { cookie: null })).status).toBe(401);
    expect((await call('POST', '/api/login', { recoveryCode: second.body.recoveryCode }, { cookie: null })).status).toBe(200);
    // A config with another client never replaces the login provider it has.
    const code3 = 'third-handoff-code-0123456789abcdefghijklmnopq';
    await useConfig(await bootstrapConfig({ login: { issuer: 'https://login.test', clientId: 'arc_other', clientSecret: 'other-secret' } }, code3));
    expect((await handoff(code3)).status).toBe(200);
    expect((await call('GET', '/api/status')).body.login.clientId).toBe(INSTANCE_CLIENT.id);
  });
});

describe('signing in', () => {
  it('with the recovery code (any case, with or without dashes)', async () => {
    const { recoveryCode } = (await handoff()).body;
    const options = (await call('GET', '/api/login-options', undefined, { cookie: null })).body;
    expect(options).toEqual({ recoveryCode: true, account: { issuer: 'https://login.test' }, awaitingHandoff: false });
    expect((await call('POST', '/api/login', { recoveryCode: 'WRONG-CODE-0000-0000-0000' }, { cookie: null })).status).toBe(401);
    expect((await call('POST', '/api/login', { password: 'test-installer-password' }, { cookie: null })).status).toBe(401);
    cookie = '';
    const ok = await call('POST', '/api/login', { recoveryCode: recoveryCode.toLowerCase().replace(/-/g, ' ') });
    expect(ok.status).toBe(200);
    expect((await call('GET', '/api/status')).status).toBe(200);
  });

  it("signing in with an account is a link (a GET navigation to the provider), never a form redirected cross-origin", async () => {
    const page = await worker.fetch(new Request(`${ORIGIN}/`), workerEnv as never);
    const html = await page.text();
    expect(page.headers.get('Content-Security-Policy')).toContain("form-action 'self'");
    expect(html).toContain('<a class="button" href="auth/login">');
    // Every form on the page is sent by its script (fetch, same origin) — none has a method or action of its own.
    expect(html.match(/<form[^>]*>/g)!.every((f) => !/\b(method|action)=/.test(f))).toBe(true);
  });

  it('before the handoff, only the link gets in', async () => {
    expect((await call('GET', '/api/login-options', undefined, { cookie: null })).body).toEqual({ recoveryCode: false, account: null, awaitingHandoff: true });
  });

  async function signIn(claims: Record<string, unknown>, opts: { cookie?: string } = {}) {
    const start = await call('GET', '/auth/login', undefined, { cookie: null });
    expect(start.status).toBe(302);
    const authorize = start.headers.get('Location')!;
    const pending = start.setCookie.find((c) => c.startsWith('arcanum_installer_oidc='))!.split(';')[0];
    const code = fakes.issuer.approve(authorize, claims);
    const state = new URL(authorize).searchParams.get('state');
    return call('GET', `/auth/callback?code=${code}&state=${state}`, undefined, { cookie: opts.cookie ?? pending });
  }

  it('with an account at the login provider: authorization code + PKCE with the installation\'s own client', async () => {
    await handoff();
    const start = await call('GET', '/auth/login', undefined, { cookie: null });
    const authorize = new URL(start.headers.get('Location')!);
    expect(`${authorize.origin}${authorize.pathname}`).toBe('https://login.test/authorize');
    expect(Object.fromEntries(authorize.searchParams)).toMatchObject({ response_type: 'code', client_id: INSTANCE_CLIENT.id, redirect_uri: `${ORIGIN}/auth/callback`, code_challenge_method: 'S256' });
    expect(authorize.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const done = await signIn({ sub: OWNER.sub, email: 'Jan@Example.test', email_verified: true });
    expect(done.status).toBe(302);
    expect(done.headers.get('Location')).toBe('/');
    const session = done.setCookie.find((c) => c.startsWith('arcanum_installer='))!.split(';')[0];
    const status = await call('GET', '/api/status', undefined, { cookie: session });
    expect(status.status).toBe(200);
    expect(status.body.access).toEqual({ via: 'session', email: OWNER.email });
    expect(fakes.issuer.tokenRequests.at(-1)).toMatchObject({ client_id: INSTANCE_CLIENT.id, client_secret: INSTANCE_CLIENT.secret, redirect_uri: `${ORIGIN}/auth/callback` });
  });

  it('refuses another e-mail address, an unverified one, and an answer without its browser cookie', async () => {
    await handoff();
    const stranger = await signIn({ sub: 'x', email: 'stranger@elders.test', email_verified: true });
    expect(stranger.headers.get('Location')).toBe('/?fout=geen-beheerder&email=stranger%40elders.test');
    expect(stranger.setCookie.some((c) => c.startsWith('arcanum_installer='))).toBe(false);
    const unverified = await signIn({ sub: OWNER.sub, email: OWNER.email, email_verified: false });
    expect(unverified.headers.get('Location')).toBe('/?fout=niet-bevestigd');
    const otherBrowser = await signIn({ sub: OWNER.sub, email: OWNER.email, email_verified: true }, { cookie: 'arcanum_installer_oidc=someone-elses' });
    expect(otherBrowser.headers.get('Location')).toBe('/?fout=aanmelden-verlopen');
  });
});

describe('the one-screen install', () => {
  async function installLatest() {
    await handoff();
    const releases = (await call('GET', '/api/releases')).body;
    expect((await call('POST', '/api/release', { version: releases.releases[0].version })).status).toBe(200);
    return runAll();
  }

  it('runs every step with what the bootstrapper handed over: its client as the login provider, the owner as admin', async () => {
    const run = await installLatest();
    expect(run.failed, run.detail ?? '').toBeNull();
    const status = (await call('GET', '/api/status')).body;
    expect(status.installed.version).toBe('0.1.1');
    expect(status.steps.every((s: any) => s.status === 'done')).toBe(true);
    const arcanum = [...fakes.cf.scripts].filter(([n]) => n !== 'arcanum-installer').sort((a, b) => a[1].order - b[1].order).map(([n]) => n);
    expect(arcanum).toEqual(['arcanum-mailer', 'arcanum-devicehub', 'arcanum-frontends', 'arcanum-backend', 'arcanum-bff']);
    expect(binding('arcanum-backend', 'DEFAULT_IDP_ISSUER_URL').text).toBe('https://login.test');
    expect(binding('arcanum-backend', 'DEFAULT_IDP_CLIENT_ID').text).toBe(INSTANCE_CLIENT.id);
    expect(binding('arcanum-backend', 'DEFAULT_IDP_CLIENT_SECRET').text).toBe(INSTANCE_CLIENT.secret);
    expect(binding('arcanum-backend', 'INSTANCE_ADMIN_EMAILS').text).toBe(OWNER.email);
    expect(binding('arcanum-bff', 'FRONTEND_URL').text).toBe(PUBLIC_URL);
    // A fresh install brings no self-update, and needs no client change on workers.dev.
    expect(status.steps.some((s: any) => s.id === 'installer:self' || s.id === 'login:uris')).toBe(false);
    expect(fakes.issuer.selfCalls).toHaveLength(0);
  });

  it('a custom domain (Geavanceerd): attached to the bff, then added to the client with its own credentials — keeping the workers.dev addresses', async () => {
    await handoff();
    await call('POST', '/api/address', { customDomain: 'arcanum.scouts-elewijt.be' });
    await call('POST', '/api/release', { version: '0.1.1' });
    const plan = (await call('GET', '/api/status')).body.steps.map((s: any) => s.id);
    expect(plan.indexOf('login:uris')).toBe(plan.indexOf('worker:arcanum-bff') + 1);
    const run = await runAll();
    expect(run.failed, run.detail ?? '').toBeNull();
    expect(Object.fromEntries(fakes.cf.domains)).toEqual({ 'arcanum.scouts-elewijt.be': 'arcanum-bff' });
    const basic = `Basic ${btoa(`${INSTANCE_CLIENT.id}:${INSTANCE_CLIENT.secret}`)}`;
    expect(fakes.issuer.selfCalls.map((c) => [c.method, c.auth])).toEqual([['GET', basic], ['PATCH', basic]]);
    expect(fakes.issuer.selfCalls[1].body).toEqual({
      redirect_uris: [`${PUBLIC_URL}/callback`, `${ORIGIN}/auth/callback`, 'https://arcanum.scouts-elewijt.be/callback'],
      post_logout_redirect_uris: [PUBLIC_URL, 'https://arcanum.scouts-elewijt.be'],
    });
    // Running it again adds nothing.
    expect((await call('POST', '/api/step', { id: 'login:uris' })).body).toMatchObject({ status: 'done', detail: 'stond er al' });
    expect(fakes.issuer.selfCalls.filter((c) => c.method === 'PATCH')).toHaveLength(1);
  });

  it('a refused client change fails that step with the reason', async () => {
    await handoff();
    await call('POST', '/api/address', { customDomain: 'arcanum.scouts-elewijt.be' });
    await call('POST', '/api/release', { version: '0.1.1' });
    const state = await env.INSTALLER_STATE.get<any>('state', 'json');
    // A client the provider doesn't know (deleted there, say).
    state.bootstrap.login.clientId = 'arc_unknown';
    await env.INSTALLER_STATE.put('state', JSON.stringify(state));
    const run = await runAll();
    expect(run.failed).toBe('login:uris');
    expect(run.detail).toMatch(/HTTP 401/);
  });

  it('updates itself first: the release\'s installer over this one, with its KV and secrets, then the rest', async () => {
    expect((await installLatest()).failed).toBeNull();
    fakes.releases.offerSelfUpdate = true;
    const uploadsBefore = fakes.cf.uploads;
    const chosen = await call('POST', '/api/release', { version: SELF_UPDATE_VERSION });
    expect(chosen.status, JSON.stringify(chosen.body)).toBe(200);
    expect(chosen.body.steps[0].id).toBe('installer:self');
    const run = await runAll();
    expect(run.failed, run.detail ?? '').toBeNull();

    const installer = fakes.cf.scripts.get('arcanum-installer')!;
    expect(installer.order).toBe(uploadsBefore + 1); // before any Arcanum Worker
    expect(binding('arcanum-installer', 'INSTALLER_STATE')).toEqual({ type: 'kv_namespace', name: 'INSTALLER_STATE', namespace_id: KV_ID });
    expect(binding('arcanum-installer', 'INSTALLER_RELEASE')).toEqual({ type: 'plain_text', name: 'INSTALLER_RELEASE', text: SELF_UPDATE_VERSION });
    expect(binding('arcanum-installer', 'RELEASES_INDEX_URL').text).toBe('https://releases.test/releases.json');
    expect(binding('arcanum-installer', 'INSTALLER_STATE_KEY')).toEqual({ type: 'secret_text', name: 'INSTALLER_STATE_KEY', text: STATE_KEY });
    expect(binding('arcanum-installer', 'BOOTSTRAP_CONFIG').text).toBe(workerEnv.BOOTSTRAP_CONFIG);
    expect(binding('arcanum-installer', 'INSTALLER_PASSWORD')).toBeUndefined();
    // The logo as a Data module, byte for byte.
    expect(installer.modules['abc-kabouter.png'].type).toBe('application/octet-stream');
    expect(installer.modules['abc-kabouter.png'].bytes).toEqual(INSTALLER_LOGO);
    expect(installer.modules['index.js'].type).toBe('application/javascript+module');
    const status = (await call('GET', '/api/status')).body;
    expect(status.installed.version).toBe(SELF_UPDATE_VERSION);
    expect(status.installer.selfUpdate).toMatchObject({ from: null, to: SELF_UPDATE_VERSION, previousDeploymentId: 'dep-arcanum-installer-0', previousVersionId: 'ver-arcanum-installer-0' });
  });

  it('stops when the self-update fails: nothing of Arcanum changes, the old installer keeps running', async () => {
    expect((await installLatest()).failed).toBeNull();
    fakes.releases.offerSelfUpdate = true;
    await call('POST', '/api/release', { version: SELF_UPDATE_VERSION });
    // Nothing else may run before it.
    const early = await call('POST', '/api/step', { id: 'worker:arcanum-backend' });
    expect(early.status).toBe(409);
    const orders = Object.fromEntries([...fakes.cf.scripts].map(([n, s]) => [n, s.order]));
    fakes.cf.failOnce(/^PUT \/accounts\/acc-1\/workers\/scripts\/arcanum-installer$/, 'Script too large');
    const run = await runAll();
    expect(run.failed).toBe('installer:self');
    expect(run.detail).toMatch(/Script too large.*niets gewijzigd/);
    expect(Object.fromEntries([...fakes.cf.scripts].map(([n, s]) => [n, s.order]))).toEqual(orders);
    expect((await call('GET', '/api/status')).body.installed.version).toBe('0.1.1');
    // Once it works, the update continues.
    expect((await runAll()).failed).toBeNull();
    expect((await call('GET', '/api/status')).body.installed.version).toBe(SELF_UPDATE_VERSION);
  });

  it('no self-update when this installer already comes from that release', async () => {
    expect((await installLatest()).failed).toBeNull();
    fakes.releases.offerSelfUpdate = true;
    workerEnv = { ...workerEnv, INSTALLER_RELEASE: SELF_UPDATE_VERSION };
    const chosen = await call('POST', '/api/release', { version: SELF_UPDATE_VERSION });
    expect(chosen.body.steps.some((s: any) => s.id === 'installer:self')).toBe(false);
    expect((await runAll()).failed).toBeNull();
    expect(fakes.cf.scripts.get('arcanum-installer')!.order).toBe(0);
  });
});

describe('the kind of installation and its channel (only from the bootstrapper)', () => {
  it('without them: one organization, stable releases — ORG_CREATION=single, no development builds offered', async () => {
    await handoff();
    const status = (await call('GET', '/api/status')).body;
    expect(status.instance).toEqual({ kind: 'single', channel: 'stable' });
    const releases = (await call('GET', '/api/releases')).body.releases.map((r: any) => r.version);
    expect(releases.some((v: string) => v.includes('-dev.'))).toBe(false);
  });

  it('several organizations + development builds: kept in the state, ORG_CREATION=admins on the backend, development builds offered newest first', async () => {
    await useConfig(await bootstrapConfig({ instance: { kind: 'admins', channel: 'dev' } }));
    expect((await handoff()).status).toBe(200);
    expect((await call('GET', '/api/status')).body.instance).toEqual({ kind: 'admins', channel: 'dev' });
    const releases = (await call('GET', '/api/releases')).body.releases.map((r: any) => r.version);
    expect(releases.slice(0, 2)).toEqual([DEV_VERSION, '0.1.5-dev.1']);
    expect((await call('POST', '/api/release', { version: DEV_VERSION })).status).toBe(200);
    expect((await runAll()).failed).toBeNull();
    expect(binding('arcanum-backend', 'ORG_CREATION')).toEqual({ type: 'plain_text', name: 'ORG_CREATION', text: 'admins' });
    expect((await call('GET', '/api/status')).body.installed.version).toBe(DEV_VERSION);
    // Every later update keeps it (it lives in the installer's state, not on the Worker).
    expect((await call('POST', '/api/step', { id: 'worker:arcanum-backend' })).body.status).toBe('done');
    expect(binding('arcanum-backend', 'ORG_CREATION').text).toBe('admins');
  });

  it('a later handover can change the kind: the backend is redeployed with it; without one, the kind stays', async () => {
    await handoff();
    const releases = (await call('GET', '/api/releases')).body;
    await call('POST', '/api/release', { version: releases.releases[0].version });
    expect((await runAll()).failed).toBeNull();
    expect(binding('arcanum-backend', 'ORG_CREATION').text).toBe('single');

    const second = 'handoff-code-second-0123456789abcdefghijkl';
    await useConfig(await bootstrapConfig({ login: null, instance: { kind: 'internal', channel: 'stable' } }, second));
    expect((await handoff(second)).status).toBe(200);
    const pending = (await call('GET', '/api/status')).body.steps.filter((s: any) => s.status !== 'done').map((s: any) => s.id);
    expect(pending).toEqual(['worker:arcanum-backend', 'verify']);
    expect((await runAll()).failed).toBeNull();
    expect(binding('arcanum-backend', 'ORG_CREATION').text).toBe('internal');

    // A handover without it (anyone else running the bootstrapper again) leaves it as it is.
    const third = 'handoff-code-third-0123456789abcdefghijklmn';
    await useConfig(await bootstrapConfig({ login: null }, third));
    expect((await handoff(third)).status).toBe(200);
    expect((await call('GET', '/api/status')).body.instance).toEqual({ kind: 'internal', channel: 'stable' });
  });

  it("the demo: ORG_CREATION=internal and its console's install link (DEMO_INSTALL_URL) from the bootstrapper's address", async () => {
    await useConfig(await bootstrapConfig({ instance: { kind: 'internal', channel: 'stable', startUrl: 'https://start.example.test' } }));
    expect((await handoff()).status).toBe(200);
    const releases = (await call('GET', '/api/releases')).body;
    await call('POST', '/api/release', { version: releases.releases[0].version });
    expect((await runAll()).failed).toBeNull();
    expect(binding('arcanum-backend', 'ORG_CREATION').text).toBe('internal');
    expect(binding('arcanum-backend', 'DEMO_INSTALL_URL')).toEqual({ type: 'plain_text', name: 'DEMO_INSTALL_URL', text: 'https://start.example.test' });
  });

  it('several organizations get no demo link', async () => {
    await useConfig(await bootstrapConfig({ instance: { kind: 'admins', channel: 'stable', startUrl: 'https://start.example.test' } }));
    await handoff();
    const releases = (await call('GET', '/api/releases')).body;
    await call('POST', '/api/release', { version: releases.releases[0].version });
    expect((await runAll()).failed).toBeNull();
    expect(binding('arcanum-backend', 'DEMO_INSTALL_URL')).toBeUndefined();
  });

  it('an unknown kind or channel in the handover is refused as a whole', async () => {
    await useConfig(await bootstrapConfig({ instance: { kind: 'everything', channel: 'stable' } }));
    expect((await handoff()).status).toBe(404);
    await useConfig(await bootstrapConfig({ instance: { kind: 'internal', channel: 'stable', startUrl: 'javascript:alert(1)' } }));
    expect((await handoff()).status).toBe(404);
  });
});
