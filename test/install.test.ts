// End-to-end: the setup page's API driving a full install against the fake
// Cloudflare API and the fake release (built from the real v0.1.1
// descriptors) — what gets created, how every binding and secret ends up,
// idempotency, resuming, and that secrets never leak.
import { env, SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakes, OTHER_ACCOUNT_TOKEN, PUBLIC_URL, TOKEN, type Fakes } from './fakes';

const PASSWORD = 'test-installer-password';
const CLIENT_SECRET = 'idp-client-secret-value-xyz';
let fakes: Fakes;
let cookie = '';
const bodies: string[] = [];

beforeEach(async () => {
  // Fresh installer state per test.
  for (const key of (await env.INSTALLER_STATE.list()).keys) await env.INSTALLER_STATE.delete(key.name);
  fakes = await installFakes();
  cookie = '';
  bodies.length = 0;
});

afterEach(() => vi.restoreAllMocks());

async function call(method: string, path: string, body?: unknown, withCookie = true) {
  const res = await SELF.fetch(`https://installer.test${path}`, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(withCookie && cookie ? { Cookie: cookie } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get('Set-Cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const text = await res.text();
  bodies.push(text);
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}

async function configure(opts: { remember?: boolean } = {}) {
  expect((await call('POST', '/api/login', { password: PASSWORD })).status).toBe(200);
  expect((await call('POST', '/api/cloudflare', { token: TOKEN, remember: opts.remember ?? true })).status).toBe(200);
  expect((await call('POST', '/api/login-provider', { issuer: 'https://login.test/', clientId: 'arcanum-client', clientSecret: CLIENT_SECRET })).status).toBe(200);
  expect((await call('POST', '/api/admins', { emails: 'Bert@Scouts.test, *@leiding.test' })).status).toBe(200);
  const release = await call('POST', '/api/release', { version: '0.1.1' });
  expect(release.status, JSON.stringify(release.body)).toBe(200);
  return release.body;
}

// Runs every step the way the page does (retrying 'retry' outcomes).
async function runAll() {
  const status = (await call('GET', '/api/status')).body;
  const perStep: Record<string, number> = {};
  for (const step of status.steps) {
    for (let attempt = 0; attempt < 10; attempt++) {
      const before = fakes.fetchCalls();
      const r = await call('POST', `/api/steps/${encodeURIComponent(step.id)}`, {});
      perStep[step.id] = Math.max(perStep[step.id] ?? 0, fakes.fetchCalls() - before);
      if (r.body.status === 'done') break;
      if (r.body.status === 'failed') return { failed: step.id, detail: r.body.detail, perStep };
    }
  }
  return { failed: null, perStep };
}

// Secret bindings that are actually sensitive. Admin addresses, the issuer
// URL and client id are stored as Worker secrets too, but the admin sees them
// on the page — they're not secret to them.
const NOT_SENSITIVE = new Set(['INSTANCE_ADMIN_EMAILS', 'DEFAULT_IDP_ISSUER_URL', 'DEFAULT_IDP_CLIENT_ID']);
function sensitiveSecrets(): string[] {
  return [...fakes.cf.scripts.values()].flatMap((s) => s.metadata.bindings.filter((b: any) => b.type === 'secret_text' && !NOT_SENSITIVE.has(b.name)).map((b: any) => b.text));
}

const bindingsOf = (name: string) => fakes.cf.scripts.get(name)!.metadata.bindings as any[];
const binding = (name: string, binding: string) => bindingsOf(name).find((b) => b.name === binding);

describe('setup page access', () => {
  it('serves the page, and the API only after logging in with the password', async () => {
    const page = await SELF.fetch('https://installer.test/');
    expect(page.status).toBe(200);
    expect(page.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
    expect((await call('GET', '/api/status', undefined, false)).status).toBe(401);
    expect((await call('POST', '/api/login', { password: 'fout' })).status).toBe(401);
    expect((await call('POST', '/api/login', { password: PASSWORD })).status).toBe(200);
    expect(cookie).toMatch(/^arcanum_installer=/);
    expect((await call('GET', '/api/status')).status).toBe(200);
    await call('POST', '/api/logout', {});
    expect((await call('GET', '/api/status')).status).toBe(401);
  });

  it("serves the platform's logo and fonts itself, and the page uses only those", async () => {
    for (const [path, type] of [
      ['/assets/kabouter.png', 'image/png'],
      ['/assets/geist.woff2', 'font/woff2'],
      ['/assets/montserrat-700.woff2', 'font/woff2'],
    ]) {
      const res = await SELF.fetch(`https://installer.test${path}`);
      expect(res.status, path).toBe(200);
      expect(res.headers.get('Content-Type')).toBe(type);
      expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(10_000);
    }
    const page = await SELF.fetch('https://installer.test/');
    const html = await page.text();
    expect(html).toContain('/assets/kabouter.png');
    expect(html).toContain('<span>arcanum</span>');
    expect(page.headers.get('Content-Security-Policy')).toContain("font-src 'self'");
    expect(html).not.toMatch(/https?:\/\/(fonts\.|cdn|unpkg)/);
  });

  it('locks out after 10 wrong passwords', async () => {
    for (let i = 0; i < 10; i++) await call('POST', '/api/login', { password: `fout-${i}` });
    expect((await call('POST', '/api/login', { password: PASSWORD })).status).toBe(429);
  });

  it('rejects a forged or expired session cookie', async () => {
    await call('POST', '/api/login', { password: PASSWORD });
    const [, value] = cookie.split('=');
    const [id, expires, sig] = value.split('.');
    cookie = `arcanum_installer=${id}.${Number(expires) + 9999}.${sig}`;
    expect((await call('GET', '/api/status')).status).toBe(401);
    cookie = `arcanum_installer=${id}.${Math.floor(Date.now() / 1000) - 10}.${sig}`;
    expect((await call('GET', '/api/status')).status).toBe(401);
  });
});

describe('configuration', () => {
  it("registers the account's workers.dev subdomain when a brand-new account has none", async () => {
    fakes.cf.subdomain = null;
    await call('POST', '/api/login', { password: PASSWORD });
    const first = await call('POST', '/api/cloudflare', { token: TOKEN });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ needsSubdomain: true, suggestion: 'scouts-elewijt' });
    expect((await call('POST', '/api/cloudflare', { token: TOKEN, subdomain: 'Geen Geldige!' })).status).toBe(400);
    const taken = await call('POST', '/api/cloudflare', { token: TOKEN, subdomain: 'taken' });
    expect(taken.status).toBe(400);
    expect(taken.body.error).toMatch(/not available/);
    const done = await call('POST', '/api/cloudflare', { token: TOKEN, subdomain: 'scouts-elewijt' });
    expect(done.status).toBe(200);
    expect(done.body.address.publicUrl).toBe('https://arcanum-bff.scouts-elewijt.workers.dev');
    expect(fakes.cf.subdomain).toBe('scouts-elewijt');
  });

  it('shows the callback URL to register once the account is known', async () => {
    await call('POST', '/api/login', { password: PASSWORD });
    const status = (await call('POST', '/api/cloudflare', { token: TOKEN })).body;
    expect(status.address).toEqual({ publicUrl: PUBLIC_URL, callbackUrl: `${PUBLIC_URL}/callback`, logoutUrl: PUBLIC_URL });
    expect(status.cloudflare).toMatchObject({ accountName: 'Scouts Elewijt', subdomain: 'scouts', tokenAvailable: true });
  });

  it('refuses a login provider without discovery, without device login, or not on https', async () => {
    await call('POST', '/api/login', { password: PASSWORD });
    expect((await call('POST', '/api/login-provider', { issuer: 'http://login.test', clientId: 'x', clientSecret: 'y' })).status).toBe(400);
    const noDevice = await call('POST', '/api/login-provider', { issuer: 'https://nodevice.test', clientId: 'x', clientSecret: 'y' });
    expect(noDevice.status).toBe(400);
    expect(noDevice.body.error).toMatch(/apparaat-aanmelding/);
  });

  it('validates admin addresses', async () => {
    await call('POST', '/api/login', { password: PASSWORD });
    expect((await call('POST', '/api/admins', { emails: 'geen-adres' })).status).toBe(400);
    expect((await call('POST', '/api/admins', { emails: '' })).status).toBe(400);
  });

  it('only offers releases this installer understands', async () => {
    await call('POST', '/api/login', { password: PASSWORD });
    const r = await call('GET', '/api/releases');
    expect(r.body.releases.map((x: any) => x.version)).toEqual(['0.1.1']);
    expect((await call('POST', '/api/release', { version: '0.1.0' })).status).toBe(400);
  });

  it('refuses to run steps before everything is configured', async () => {
    await call('POST', '/api/login', { password: PASSWORD });
    const r = await call('POST', '/api/steps/secrets', {});
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/Cloudflare-token/);
  });
});

describe('fresh install', () => {
  it('creates the databases and storage, applies both schemas, and installs all five Workers in dependency order', async () => {
    await configure();
    const run = await runAll();
    expect(run.failed, run.detail).toBeNull();

    expect([...fakes.cf.d1.values()].map((d) => d.name).sort()).toEqual(['arcanum-backend', 'arcanum-devices']);
    for (const db of fakes.cf.d1.values()) expect(db.queries.join('\n')).toContain('CREATE TABLE IF NOT EXISTS');
    expect([...fakes.cf.kv.values()]).toEqual(['arcanum-bff-ARCANUM_SESSIONS']);
    const order = [...fakes.cf.scripts].sort((a, b) => a[1].order - b[1].order).map(([n]) => n);
    expect(order).toEqual(['arcanum-mailer', 'arcanum-devicehub', 'arcanum-frontends', 'arcanum-backend', 'arcanum-bff']);

    const status = (await call('GET', '/api/status')).body;
    expect(status.installed.version).toBe('0.1.1');
    expect(status.steps.every((s: any) => s.status === 'done')).toBe(true);
  });

  it('wires every binding to the resources it created', async () => {
    await configure();
    await runAll();
    const d1 = Object.fromEntries([...fakes.cf.d1].map(([id, d]) => [d.name, id]));
    expect(binding('arcanum-backend', 'DB')).toEqual({ type: 'd1', name: 'DB', id: d1['arcanum-backend'] });
    expect(binding('arcanum-devicehub', 'DB')).toEqual({ type: 'd1', name: 'DB', id: d1['arcanum-devices'] });
    expect(binding('arcanum-bff', 'ARCANUM_SESSIONS')).toMatchObject({ type: 'kv_namespace', namespace_id: [...fakes.cf.kv.keys()][0] });
    expect(binding('arcanum-bff', 'ARCANUM_BACKEND_SERVICE')).toEqual({ type: 'service', name: 'ARCANUM_BACKEND_SERVICE', service: 'arcanum-backend' });
    expect(binding('arcanum-bff', 'LOGIN_RATE_LIMITER')).toMatchObject({ type: 'ratelimit', simple: { limit: 5, period: 60 } });
    expect(binding('arcanum-backend', 'CHARGE_POLLER')).toEqual({ type: 'durable_object_namespace', name: 'CHARGE_POLLER', class_name: 'ChargePoller' });
    expect(binding('arcanum-frontends', 'ASSETS')).toEqual({ type: 'assets', name: 'ASSETS' });
  });

  it('sets vars from the address and login provider, with the right binding types', async () => {
    await configure();
    await runAll();
    expect(binding('arcanum-backend', 'PUBLIC_BASE_URL')).toEqual({ type: 'plain_text', name: 'PUBLIC_BASE_URL', text: PUBLIC_URL });
    expect(binding('arcanum-bff', 'FRONTEND_URL')).toEqual({ type: 'plain_text', name: 'FRONTEND_URL', text: PUBLIC_URL });
    expect(binding('arcanum-bff', 'AUTH0_DOMAIN')).toEqual({ type: 'plain_text', name: 'AUTH0_DOMAIN', text: 'login.test' });
    expect(binding('arcanum-bff', 'SESSION_TTL')).toEqual({ type: 'json', name: 'SESSION_TTL', json: 604800 });
    expect(binding('arcanum-backend', 'AUTH_SCHEME')).toEqual({ type: 'plain_text', name: 'AUTH_SCHEME', text: 'Bearer' });
    expect(binding('arcanum-backend', 'DEFAULT_IDP_ISSUER_URL')).toMatchObject({ type: 'secret_text', text: 'https://login.test' });
    expect(binding('arcanum-backend', 'DEFAULT_IDP_CLIENT_SECRET')).toMatchObject({ type: 'secret_text', text: CLIENT_SECRET });
    expect(binding('arcanum-backend', 'INSTANCE_ADMIN_EMAILS')).toMatchObject({ type: 'secret_text', text: 'bert@scouts.test, *@leiding.test' });
    expect(binding('arcanum-bff', 'SOURCE_URL').text).toBe('https://github.com/arcanum-pos/arcanum-releases/releases/tag/v0.1.1');
    // Never: dev-only settings, or optional ones nobody gave.
    const all = [...fakes.cf.scripts.values()].flatMap((s) => s.metadata.bindings.map((b: any) => b.name));
    for (const absent of ['DEVICEHUB_LOCAL_URL', 'MAILER_LOCAL_URL', 'CONSOLE_LOCAL_URL', 'DEFAULT_SMTP_HOST', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ZONE_ID']) expect(all).not.toContain(absent);
  });

  it('generates each secret once and shares it exactly between the Workers that need it', async () => {
    await configure();
    await runAll();
    const secret = (worker: string, name: string) => binding(worker, name)?.text as string;
    expect(secret('arcanum-backend', 'INTERNAL_API_KEY')).toBe(secret('arcanum-devicehub', 'INTERNAL_API_KEY'));
    expect(secret('arcanum-backend', 'BFF_INTERNAL_KEY')).toBe(secret('arcanum-bff', 'BFF_INTERNAL_KEY'));
    expect(secret('arcanum-backend', 'MAILER_INTERNAL_KEY')).toBe(secret('arcanum-mailer', 'MAILER_INTERNAL_KEY'));
    const distinct = new Set([secret('arcanum-backend', 'INTERNAL_API_KEY'), secret('arcanum-backend', 'BFF_INTERNAL_KEY'), secret('arcanum-backend', 'MAILER_INTERNAL_KEY'), secret('arcanum-devicehub', 'WS_TOKEN_SECRET')]);
    expect(distinct.size).toBe(4);
    // ENCRYPTION_KEY must be base64 of exactly 32 bytes — never hex.
    expect(atob(secret('arcanum-backend', 'ENCRYPTION_KEY')).length).toBe(32);
    expect(secret('arcanum-devicehub', 'WS_TOKEN_SECRET')).toMatch(/^[0-9a-f]{64}$/);
    for (const [, s] of fakes.cf.scripts) for (const b of s.metadata.bindings) if (b.type === 'secret_text') expect(b.text, b.name).toBeTruthy();
  });

  it('gives only the bff a workers.dev address', async () => {
    await configure();
    await runAll();
    expect(Object.fromEntries(fakes.cf.workersDev)).toEqual({
      'arcanum-mailer': false,
      'arcanum-devicehub': false,
      'arcanum-frontends': false,
      'arcanum-backend': false,
      'arcanum-bff': true,
    });
  });

  it("gives a new script its Durable Object history's net effect as one step, under the latest tag", async () => {
    // Replaying the history (create → delete → create) on a new script is
    // refused by Cloudflare: a delete is checked against the previously
    // deployed version, and a new script has none (error 10074).
    await configure();
    const run = await runAll();
    expect(run.failed, run.detail).toBeNull();
    const devicehub = fakes.cf.scripts.get('arcanum-devicehub')!.metadata.migrations;
    expect(devicehub).toEqual({ new_tag: 'v3', steps: [{ new_sqlite_classes: ['DeviceHub'] }] });
    const backend = fakes.cf.scripts.get('arcanum-backend')!.metadata.migrations;
    expect(backend).toEqual({ new_tag: 'v4', steps: [{ new_sqlite_classes: ['ChargePoller'] }] });
    expect(fakes.cf.doClasses.get('arcanum-backend')).toEqual(new Set(['ChargePoller']));
  });

  it('uploads every asset and deploys the frontends with the completion token', async () => {
    await configure();
    await runAll();
    expect([...fakes.cf.assets].sort()).toEqual(['a'.repeat(32), 'b'.repeat(32), 'c'.repeat(32)]);
    const assets = fakes.cf.scripts.get('arcanum-frontends')!.metadata.assets;
    expect(fakes.cf.completionJwts.has(assets.jwt)).toBe(true);
  });

  it('uploads the module code as ES modules', async () => {
    await configure();
    await runAll();
    const backend = fakes.cf.scripts.get('arcanum-backend')!;
    expect(backend.metadata.main_module).toBe('index.js');
    expect(backend.modules['index.js'].type).toBe('application/javascript+module');
    expect(backend.modules['index.js'].text).toContain('arcanum-backend (test stub)');
  });

  it('stays well within the Free plan limit of 50 subrequests in every step', async () => {
    await configure();
    const run = await runAll();
    const worst = Math.max(...Object.values(run.perStep));
    expect(worst, JSON.stringify(run.perStep)).toBeLessThanOrEqual(10);
  });
});

describe('resilience', () => {
  it('is idempotent: running every step again creates nothing new and re-sends no migrations', async () => {
    await configure();
    await runAll();
    const d1 = fakes.cf.d1.size;
    const kv = fakes.cf.kv.size;
    const status = (await call('GET', '/api/status')).body;
    for (const step of status.steps) {
      const r = await call('POST', `/api/steps/${encodeURIComponent(step.id)}`, {});
      expect(r.body.status, `${step.id}: ${r.body.detail}`).toBe('done');
    }
    expect([fakes.cf.d1.size, fakes.cf.kv.size]).toEqual([d1, kv]);
    expect(fakes.cf.scripts.get('arcanum-backend')!.metadata.migrations).toBeUndefined();
  });

  it('keeps the generated secrets when steps run again (ENCRYPTION_KEY must never change)', async () => {
    await configure();
    await runAll();
    const before = binding('arcanum-backend', 'ENCRYPTION_KEY').text;
    await call('POST', '/api/steps/secrets', {});
    await call('POST', '/api/steps/worker%3Aarcanum-backend', {});
    expect(binding('arcanum-backend', 'ENCRYPTION_KEY').text).toBe(before);
  });

  it('reports a failed step and simply continues on the next run', async () => {
    await configure();
    fakes.cf.failOnce(/^PUT \/accounts\/acc-1\/workers\/scripts\/arcanum-backend$/, 'Workers API is druk');
    const first = await runAll();
    expect(first.failed).toBe('worker:arcanum-backend');
    expect(first.detail).toContain('Workers API is druk');
    const status = (await call('GET', '/api/status')).body;
    expect(status.steps.find((s: any) => s.id === 'worker:arcanum-backend')).toMatchObject({ status: 'failed' });
    const second = await runAll();
    expect(second.failed).toBeNull();
    expect((await call('GET', '/api/status')).body.installed.version).toBe('0.1.1');
  });

  it('adopts a database that already exists with the same name instead of failing', async () => {
    await configure();
    fakes.cf.d1.set('d1-existing', { name: 'arcanum-backend', queries: [] });
    const run = await runAll();
    expect(run.failed).toBeNull();
    expect(binding('arcanum-backend', 'DB').id).toBe('d1-existing');
  });

  it('waits for the new address to answer before calling it done', async () => {
    await configure();
    fakes.notReadyYet.count = 2;
    const run = await runAll();
    expect(run.failed).toBeNull();
    expect((await call('GET', '/api/status')).body.installed).toBeTruthy();
  });

  it('refuses a release file that does not match its checksum', async () => {
    await configure();
    fakes.releases.tampered.add('arcanum-backend.json');
    const run = await runAll();
    expect(run.failed).toBe('secrets');
    expect(run.detail).toMatch(/controlesom/);
    expect(fakes.cf.scripts.size).toBe(0);
  });

  it('refuses a token for another account once something is installed', async () => {
    await configure();
    await runAll();
    const r = await call('POST', '/api/cloudflare', { token: OTHER_ACCOUNT_TOKEN });
    expect(r.status).toBe(409);
  });
});

describe('secrets', () => {
  it('never returns the token, the client secret or a generated secret from the API', async () => {
    await configure();
    await runAll();
    const generated = sensitiveSecrets();
    const all = bodies.join('\n');
    for (const value of [TOKEN, CLIENT_SECRET, ...generated.filter((v: string) => v.length > 20)]) expect(all).not.toContain(value);
  });

  it('stores nothing sensitive in KV in plain text', async () => {
    await configure();
    await runAll();
    const generated = sensitiveSecrets();
    const stored: string[] = [];
    for (const key of (await env.INSTALLER_STATE.list()).keys) stored.push((await env.INSTALLER_STATE.get(key.name)) ?? '');
    const all = stored.join('\n');
    for (const value of [TOKEN, CLIENT_SECRET, ...generated.filter((v: string) => v.length > 20)]) expect(all).not.toContain(value);
  });

  it('without "onthouden", keeps the token only for the session — a new session must paste it again', async () => {
    await configure({ remember: false });
    await call('POST', '/api/steps/secrets', {});
    await call('POST', '/api/logout', {});
    await call('POST', '/api/login', { password: PASSWORD });
    expect((await call('GET', '/api/status')).body.cloudflare.tokenAvailable).toBe(false);
    const r = await call('POST', '/api/steps/d1%3Aarcanum-backend', {});
    expect(r.status).toBe(409);
    expect(r.body.needsToken).toBe(true);
  });
});
