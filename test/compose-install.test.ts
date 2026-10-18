// Compose mode end to end (SELF_HOSTING.md): no engine socket — the
// installer writes compose.yaml (every Worker and itself) into its folder, and
// waits until its owner ran `compose up -d` there: this installer is the
// release's, the bff shows the file's fingerprint, every container answers.
// A settings change writes it anew at the next Installeren.
import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import worker from '../src/index';
import { newSessionCookie } from '../src/auth';
import { installFakes, NEXT_VERSION, type Fakes } from './fakes';

let fakes: Fakes;
let cookie = '';
// The folder: what the installer wrote.
let files: Record<string, string>;
// What runs, as `compose up -d` left it (null: never run).
let running: { installer: string; bff: { release: string; settings: string } } | null;
const WORKERS = ['mailer', 'devicehub', 'frontends', 'backend', 'bff'];

beforeEach(async () => {
  for (const key of (await env.INSTALLER_STATE.list()).keys) await env.INSTALLER_STATE.delete(key.name);
  fakes = await installFakes();
  files = {};
  running = null;
  // The containers by name, on the network: there once compose ran.
  const outer = (globalThis.fetch as any).getMockImplementation();
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: any) => {
    const url = new URL(new Request(input, init).url);
    if (/^tresjr-[a-z]+:8080$/.test(url.host)) {
      if (!running) throw new TypeError('fetch failed');
      if (url.hostname === 'tresjr-bff' && url.pathname === '/version') return Response.json(running.bff);
      return Response.json({ status: 'healthy' });
    }
    return outer(input, init);
  });
  cookie = (await newSessionCookie(env as never)).cookie.split(';')[0];
});
afterEach(() => vi.restoreAllMocks());

const compose = () => parse(files['compose.yaml']);

// `compose up -d` in the folder: what's in compose.yaml now runs.
function composeUp() {
  const c = compose();
  running = {
    installer: c.services.installer.environment.INSTALLER_RELEASE,
    bff: { release: c.services['tresjr-bff'].environment.ARCANUM_VERSION, settings: c.services['tresjr-bff'].environment.TRESJR_SETTINGS },
  };
}

const composeEnv = () => ({
  ...(env as object),
  COMPOSE: { write: async (written: Record<string, string>) => Object.assign(files, written) },
  COMPOSE_COMMAND: 'nerdctl compose up -d',
  // The installer that runs: the starter's, until compose ran a newer one.
  INSTALLER_RELEASE: running?.installer ?? '0.1.0',
  INSTALLER_ENV: { INSTALLER_TARGET: 'compose', BOOTSTRAP_CONFIG: '{"version":1,"target":"docker"}', COMPOSE_COMMAND: 'nerdctl compose up -d' },
});

async function call(method: string, path: string, body?: unknown) {
  const res = await worker.fetch(
    new Request(`https://installer.test${path}`, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) }),
    composeEnv() as never
  );
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function configure() {
  expect((await call('POST', '/api/address', { publicUrl: 'http://localhost:8000' })).status).toBe(200);
  const login = await call('POST', '/api/login-provider', { issuer: 'https://login.test/', clientId: 'arcanum-client', clientSecret: 'idp-client-secret-value-xyz' });
  expect(login.status, JSON.stringify(login.body)).toBe(200);
  expect((await call('POST', '/api/admins', { emails: 'bert@scouts.test' })).status).toBe(200);
  fakes.releases.offerUpdate = true;
  const release = await call('POST', '/api/release', { version: NEXT_VERSION });
  expect(release.status, JSON.stringify(release.body)).toBe(200);
}

async function step(id: string) {
  return (await call('POST', '/api/step', { id })).body as { status: string; detail?: string };
}

describe('installing in compose mode', () => {
  it('the steps: compose.yaml written, then applied by its owner — no container steps', async () => {
    const status = (await call('GET', '/api/status')).body;
    expect(status.docker).toEqual({ publicUrl: null, publish: '127.0.0.1:8000', compose: true, command: 'nerdctl compose up -d' });
    await configure();
    const ids = (await call('GET', '/api/status')).body.steps.map((s: any) => s.id);
    expect(ids).toEqual(['secrets', 'compose:write', 'compose:apply', 'verify']);
  });

  it('writes every Worker and itself into compose.yaml; waits for `compose up -d`; then verified', async () => {
    await configure();
    const secrets = await call('POST', '/api/step', { id: 'secrets' });
    expect(secrets.body?.status, JSON.stringify(secrets)).toBe('done');
    const written = await step('compose:write');
    expect(written).toMatchObject({ status: 'done', detail: expect.stringContaining('nerdctl compose up -d') });

    const c = compose();
    expect(c.name).toBe('tresjr');
    expect(c.networks.default.name).toBe('tresjr');
    expect(Object.keys(c.services).sort()).toEqual(['installer', ...WORKERS.map((w) => `tresjr-${w}`)].sort());
    for (const w of WORKERS) {
      const s = c.services[`tresjr-${w}`];
      expect(s.image, w).toBe(`ghcr.io/arcanum-pos/tresjr-${w}:${NEXT_VERSION}`);
      expect(s, w).toMatchObject({ container_name: `tresjr-${w}`, restart: 'unless-stopped', read_only: true, cap_drop: ['ALL'] });
      expect(s.ports, w).toEqual(w === 'bff' ? ['127.0.0.1:8000:8080'] : undefined);
    }
    expect(c.services['tresjr-backend'].volumes).toEqual(['tresjr-backend-data:/data']);
    expect(c.volumes['tresjr-backend-data']).toEqual({ name: 'tresjr-backend-data' });
    // The backend migrates as it starts (no step before it); the bff carries the fingerprint.
    expect(c.services['tresjr-backend'].environment).toMatchObject({ TRESJR_MIGRATE: '1', TRESJR_VERSION: NEXT_VERSION });
    expect(c.services['tresjr-bff'].environment.TRESJR_SETTINGS).toMatch(/^[0-9a-f]{16}$/);
    expect(c.services['tresjr-bff'].environment.FRONTEND_URL).toBe('http://localhost:8000');
    // The installer itself: the release's image, compose mode, its folder — and no engine socket anywhere.
    expect(c.services.installer).toMatchObject({ image: `ghcr.io/arcanum-pos/tresjr-installer:${NEXT_VERSION}`, container_name: 'tresjr-installer', volumes: ['./:/project', 'installer:/data'] });
    expect(c.services.installer.environment).toMatchObject({ INSTALLER_TARGET: 'compose', INSTALLER_RELEASE: NEXT_VERSION, COMPOSE_COMMAND: 'nerdctl compose up -d', BOOTSTRAP_CONFIG: '{"version":1,"target":"docker"}' });
    expect(files['compose.yaml']).not.toContain('docker.sock');

    // Not run yet: it says what to run, and asks again.
    expect(await step('compose:apply')).toMatchObject({ status: 'retry', detail: expect.stringContaining('nerdctl compose up -d') });
    composeUp();
    expect((await step('compose:apply')).status).toBe('done');
    expect((await step('verify')).status).toBe('done');
    expect((await call('GET', '/api/status')).body.installed?.version).toBe(NEXT_VERSION);
  });

  it("a `$` in a setting stays a `$` (compose would read ${…} as its own variable)", async () => {
    await configure();
    await call('POST', '/api/mail', { provider: 'brevo', apiKey: 'sec$ret-${HOME}-key', fromAddress: 'info@scouts.test' });
    await step('secrets');
    await step('compose:write');
    expect(files['compose.yaml']).toContain('sec$$ret-$${HOME}-key');
    // As compose reads it ($$ → $): the key as it was given.
    const mail = JSON.parse(String(compose().services['tresjr-backend'].environment.MAIL_CONFIG).replace(/\$\$/g, '$'));
    expect(mail.apiKey).toBe('sec$ret-${HOME}-key');
  });

  it('a settings change: saved for the next Installeren, which writes compose.yaml anew and waits again', async () => {
    await configure();
    for (const id of ['secrets', 'compose:write']) await step(id);
    composeUp();
    for (const id of ['compose:apply', 'verify']) expect((await step(id)).status).toBe('done');
    const before = compose().services['tresjr-bff'].environment.TRESJR_SETTINGS;

    const mail = await call('POST', '/api/mail', { provider: 'brevo', apiKey: 'xkeysib-brevo-key', fromAddress: 'info@scouts.test' });
    expect(mail.status, JSON.stringify(mail.body)).toBe(200);
    const pending = (await call('GET', '/api/status')).body.steps.filter((s: any) => s.status !== 'done').map((s: any) => s.id);
    expect(pending).toEqual(['compose:write', 'compose:apply', 'verify']);
    await step('compose:write');
    expect(compose().services['tresjr-bff'].environment.TRESJR_SETTINGS).not.toBe(before);
    // The running one still has the old fingerprint: not applied until compose runs.
    expect((await step('compose:apply')).status).toBe('retry');
    composeUp();
    expect((await step('compose:apply')).status).toBe('done');
  });
});
