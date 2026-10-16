// The Docker target end to end (SELF_HOSTING.md, compose): the installer as
// a container (a fake engine, test/fake-docker.ts) installs a release
// through its own API, the way the page does — every Worker's container on
// the network, volumes where they keep data, the backend's database updated
// first, only the bff published; why a container doesn't come up; settings
// that make the backend anew; the installer's own update by a helper; the handoff.
import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { newSessionCookie } from '../src/auth';
import { containerSpec, publishOf } from '../src/docker/containers';
import { replaceInstaller } from '../src/docker/replace';
import { FakeDockerEngine } from './fake-docker';
import { installFakes, NEXT_VERSION, SELF_UPDATE_VERSION, type Fakes } from './fakes';

let fakes: Fakes;
let engine: FakeDockerEngine;
let cookie = '';
let reached: string[];

beforeEach(async () => {
  for (const key of (await env.INSTALLER_STATE.list()).keys) await env.INSTALLER_STATE.delete(key.name);
  fakes = await installFakes();
  engine = new FakeDockerEngine();
  engine.seedInstaller();
  reached = [];
  // The containers by name, on the network: they answer once running.
  const outer = (globalThis.fetch as any).getMockImplementation();
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: any) => {
    const url = new URL(new Request(input, init).url);
    if (/^tresjr-[a-z]+:8080$/.test(url.host)) {
      const c = engine.get(url.hostname);
      if (!c?.State.Running || c.State.Restarting) throw new TypeError('fetch failed');
      reached.push(`${url.hostname}${url.pathname}`);
      return Response.json({ status: 'healthy' });
    }
    return outer(input, init);
  });
  cookie = (await newSessionCookie(env as never)).cookie.split(';')[0];
});
afterEach(() => vi.restoreAllMocks());

const dockerEnv = () => ({ ...(env as object), DOCKER: engine.docker(), INSTALLER_CONTAINER: 'tresjr-installer' });

async function call(method: string, path: string, body?: unknown) {
  const res = await worker.fetch(
    new Request(`https://installer.test${path}`, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) }),
    dockerEnv() as never
  );
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function configure() {
  expect((await call('POST', '/api/address', { publicUrl: 'https://kassa.scouts.test' })).status).toBe(200);
  const login = await call('POST', '/api/login-provider', { issuer: 'https://login.test/', clientId: 'arcanum-client', clientSecret: 'idp-client-secret-value-xyz' });
  expect(login.status, JSON.stringify(login.body)).toBe(200);
  expect((await call('POST', '/api/admins', { emails: 'bert@scouts.test' })).status).toBe(200);
  fakes.releases.offerUpdate = true;
  const release = await call('POST', '/api/release', { version: NEXT_VERSION });
  expect(release.status, JSON.stringify(release.body)).toBe(200);
}

async function runAll() {
  const steps = (await call('GET', '/api/status')).body.steps as { id: string }[];
  const outcomes: Record<string, string> = {};
  for (const step of steps) {
    for (let attempt = 0; attempt < 6; attempt++) {
      const r = (await call('POST', '/api/step', { id: step.id })).body;
      outcomes[step.id] = r.status === 'done' ? 'done' : `${r.status}: ${r.detail}`;
      if (r.status !== 'retry') break;
    }
    if (outcomes[step.id] !== 'done') return { stoppedAt: step.id, outcomes };
  }
  return { stoppedAt: null, outcomes };
}

const WORKERS = ['mailer', 'devicehub', 'frontends', 'backend', 'bff'];
const image = (w: string, version = NEXT_VERSION) => `ghcr.io/arcanum-pos/tresjr-${w}:${version}`;

describe('installing with Docker', () => {
  it('the steps: no Cloudflare in sight; the public address and where the bff is published', async () => {
    const status = (await call('GET', '/api/status')).body;
    expect(status.docker).toEqual({ publicUrl: null, publish: '127.0.0.1:8000' });
    expect(status.kubernetes).toBeNull();
    expect(status.cloudflare).toBeNull();
    await configure();
    const ids = (await call('GET', '/api/status')).body.steps.map((s: any) => s.id);
    expect(ids).toEqual(['secrets', 'worker:arcanum-mailer', 'worker:arcanum-devicehub', 'worker:arcanum-frontends', 'worker:arcanum-backend', 'worker:arcanum-bff', 'verify']);
  });

  it('every Worker as a container of its image on the network, volumes where they keep data, only the bff published; then verified', async () => {
    await configure();
    const run = await runAll();
    expect(run.stoppedAt, JSON.stringify(run.outcomes)).toBeNull();
    for (const w of WORKERS) {
      const c = engine.get(`tresjr-${w}`)!;
      expect(c.Config.Image, w).toBe(image(w));
      expect(c.State.Running, w).toBe(true);
      expect(c.NetworkSettings.Networks.tresjr.Aliases, w).toContain(`tresjr-${w}`);
      expect(c.HostConfig, w).toMatchObject({ RestartPolicy: { Name: 'unless-stopped' }, ReadonlyRootfs: true, CapDrop: ['ALL'] });
      expect(c.HostConfig.PortBindings, w).toEqual(w === 'bff' ? { '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '8000' }] } : undefined);
    }
    expect([...engine.volumes].sort()).toEqual(['tresjr-backend-data', 'tresjr-bff-data', 'tresjr-devicehub-data']);
    expect(engine.get('tresjr-backend')!.Mounts).toEqual([{ Type: 'volume', Source: 'tresjr-backend-data', Destination: '/data' }]);
    // Downloaded once each; the backend's database updated before it started.
    expect(engine.log.filter((l) => l.startsWith('pull')).sort()).toEqual(WORKERS.map((w) => `pull ${image(w)}`).sort());
    const backend = engine.log.indexOf(`create tresjr-backend ${image('backend')}`);
    expect(engine.log.indexOf(`create tresjr-backend-migrate ${image('backend')}`)).toBeLessThan(backend);
    expect(engine.log).toContain('remove tresjr-backend-migrate');
    // The same settings as on Kubernetes.
    expect(engine.envOf('tresjr-backend').INTERNAL_API_KEY).toBe(engine.envOf('tresjr-devicehub').INTERNAL_API_KEY);
    expect(engine.envOf('tresjr-bff')).toMatchObject({ FRONTEND_URL: 'https://kassa.scouts.test', BACKEND_URL: 'http://tresjr-backend:8080', INSTALLER_URL: 'http://tresjr-installer:8080' });
    expect(engine.envOf('tresjr-backend')).toMatchObject({ ORG_CREATION: 'single', INSTANCE_ADMIN_EMAILS: 'bert@scouts.test', BACKEND_DB: '/data/backend.db' });
    expect(reached).toContain('tresjr-bff/health');
    expect((await call('GET', '/api/status')).body.installed.version).toBe(NEXT_VERSION);
    // Again: nothing changed, nothing made anew.
    const ids = WORKERS.map((w) => engine.get(`tresjr-${w}`)!.Id);
    expect((await runAll()).stoppedAt).toBeNull();
    expect(WORKERS.map((w) => engine.get(`tresjr-${w}`)!.Id)).toEqual(ids);
  });

  it("a database update that fails: the old backend runs on, and the step says why", async () => {
    await configure();
    await runAll();
    const old = engine.get('tresjr-backend')!.Id;
    engine.exitCodes['tresjr-backend-migrate'] = 1;
    // Another admin: the backend needs new settings, so a new container (and the update first).
    // The setting is kept; the backend gets it with the next Install.
    const res = await call('POST', '/api/admins', { emails: 'bert@scouts.test, an@scouts.test' });
    expect(res.status).toBe(200);
    expect(res.body.adminsApplied).toBe('later');
    expect(res.body.admins).toBe('bert@scouts.test, an@scouts.test');
    const step = (await call('POST', '/api/step', { id: 'worker:arcanum-backend' })).body;
    expect(step.status).toBe('failed');
    expect(step.detail).toContain('the database update failed (exit 1)');
    expect(step.detail).toContain('migration 0041 failed');
    expect(engine.get('tresjr-backend')!.Id).toBe(old);
    expect(engine.get('tresjr-backend')!.State.Running).toBe(true);
    expect(engine.get('tresjr-backend-migrate')).toBeUndefined();
  });

  it("a container that keeps crashing, an image that can't be downloaded: the step says why", async () => {
    await configure();
    await call('POST', '/api/step', { id: 'secrets' });
    engine.crashing['tresjr-mailer'] = 'Error: MAILER_INTERNAL_KEY is required';
    let r: any;
    for (let i = 0; i < 4; i++) r = (await call('POST', '/api/step', { id: 'worker:arcanum-mailer' })).body;
    expect(r.status).toBe('retry');
    expect(r.detail).toContain('restarting');
    expect(r.detail).toContain('MAILER_INTERNAL_KEY is required');

    engine.pullErrors[image('devicehub')] = 'denied: requested access to the resource is denied';
    expect((await call('POST', '/api/step', { id: 'worker:arcanum-devicehub' })).body).toMatchObject({ status: 'retry', detail: expect.stringContaining('downloading') });
    const failed = (await call('POST', '/api/step', { id: 'worker:arcanum-devicehub' })).body;
    expect(failed.status).toBe('failed');
    expect(failed.detail).toContain('requested access to the resource is denied');
  });

  it('a setting changed once installed: the backend made anew with it, the others left alone', async () => {
    await configure();
    await runAll();
    const before = Object.fromEntries(WORKERS.map((w) => [w, engine.get(`tresjr-${w}`)!.Id]));
    const res = await call('POST', '/api/admins', { emails: 'bert@scouts.test, an@scouts.test' });
    expect(res.body.adminsApplied).toBe('applied');
    expect(engine.envOf('tresjr-backend').INSTANCE_ADMIN_EMAILS).toBe('bert@scouts.test, an@scouts.test');
    expect(engine.get('tresjr-backend')!.Id).not.toBe(before.backend);
    for (const w of WORKERS.filter((x) => x !== 'backend')) expect(engine.get(`tresjr-${w}`)!.Id, w).toBe(before[w]);
  });

  it("an update with a newer installer: a helper of the new image swaps the installer's container", async () => {
    await configure();
    await runAll();
    fakes.releases.offerSelfUpdate = true;
    const chosen = await call('POST', '/api/release', { version: SELF_UPDATE_VERSION });
    expect(chosen.body.steps[0].id).toBe('installer:self');
    expect((await call('POST', '/api/step', { id: 'installer:self' })).body.status).toBe('retry');
    expect((await call('POST', '/api/step', { id: 'installer:self' })).body.status).toBe('done');
    const helper = engine.get('tresjr-installer-update')!;
    expect(helper.Config).toMatchObject({ Image: image('installer', SELF_UPDATE_VERSION), User: '0', Cmd: ['node', 'dist/node.mjs', 'replace-installer', 'tresjr-installer', image('installer', SELF_UPDATE_VERSION), SELF_UPDATE_VERSION] });
    expect(helper.HostConfig.Binds).toEqual(['/var/run/docker.sock:/var/run/docker.sock']);
    expect(helper.State.Running).toBe(true);
  });
});

describe("the installer's own update (replace-installer, in the helper)", () => {
  it('the same container — settings, socket, ports, network, compose labels — of the new image', async () => {
    const docker = engine.docker('');
    engine.images.add('ghcr.io/arcanum-pos/tresjr-installer:0.2.0');
    await replaceInstaller(docker, 'tresjr-installer', 'ghcr.io/arcanum-pos/tresjr-installer:0.2.0', '0.2.0', 0);
    const c = engine.get('tresjr-installer')!;
    expect(c.Config.Image).toBe('ghcr.io/arcanum-pos/tresjr-installer:0.2.0');
    expect(c.Config.Env).toEqual(['INSTALLER_TARGET=docker', 'INSTALLER_RELEASE=0.2.0']);
    expect(c.Config.Labels).toEqual({ 'com.docker.compose.project': 'tresjr' });
    expect(c.Config.Hostname).toBeUndefined();
    expect(c.HostConfig.Binds).toEqual(['/var/run/docker.sock:/var/run/docker.sock']);
    expect(c.HostConfig.PortBindings).toEqual({ '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '8080' }] });
    expect(c.NetworkSettings.Networks.tresjr.Aliases).toContain('installer');
    expect(c.State.Running).toBe(true);
    expect(engine.get('tresjr-installer-previous')).toBeUndefined();
  });

  it("a new one that can't be made: the old one back, under its name, running", async () => {
    const docker = engine.docker('');
    const old = engine.get('tresjr-installer')!.Id;
    await expect(replaceInstaller(docker, 'tresjr-installer', 'ghcr.io/arcanum-pos/tresjr-installer:missing', '9.9.9', 0)).rejects.toThrow(/No such image/);
    expect(engine.get('tresjr-installer')!.Id).toBe(old);
    expect(engine.get('tresjr-installer')!.State.Running).toBe(true);
  });
});

describe('the container spec', () => {
  it('where the bff is published: an address and a port, or a port on every address', () => {
    expect(publishOf('127.0.0.1:8000')).toEqual({ HostIp: '127.0.0.1', HostPort: '8000' });
    expect(publishOf('8000')).toEqual({ HostPort: '8000' });
    expect(publishOf('[::1]:8000')).toEqual({ HostIp: '::1', HostPort: '8000' });
    expect(publishOf('nonsense')).toBeNull();
  });

  it('a change of settings is a new digest; the same settings the same one', async () => {
    const descriptor = { name: 'arcanum-mailer', bindings: [], env: { A: { kind: 'var', source: 'fixed', value: 'x' } } } as any;
    const ctx = { secrets: {}, vars: {} } as any;
    const k = { instance: 'tresjr', image: (s: string) => `img/${s}:1`, version: '1' };
    const a = await containerSpec(descriptor, ctx, k, 'tresjr');
    expect((await containerSpec(descriptor, ctx, k, 'tresjr')).digest).toBe(a.digest);
    expect((await containerSpec(descriptor, ctx, { ...k, image: (s: string) => `img/${s}:2` }, 'tresjr')).digest).not.toBe(a.digest);
    expect(a.volume).toBeUndefined();
    expect(a.migrate).toBeUndefined();
  });
});

describe('the handoff for a Docker installation', () => {
  const hash = async (code: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code)))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const config = async (target: string, code: string) => ({
    version: 1,
    target,
    login: { issuer: 'https://login.test', clientId: 'arc_docker', clientSecret: 'docker-client-secret' },
    owner: { email: 'Bert@Scouts.test', sub: 'sub-bert' },
    handoffCodeHash: await hash(code),
    handoffExpiresAt: new Date(Date.now() + 600_000).toISOString(),
  });
  const post = async (cfg: unknown, code: string) =>
    worker.fetch(new Request('https://installer.test/api/handoff', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) }), { ...dockerEnv(), BOOTSTRAP_CONFIG: JSON.stringify(cfg) } as never);

  it('signs the owner in with a recovery code and takes the login provider; the sign-in page knows it runs with Docker', async () => {
    const cfg = await config('docker', 'DOCKER-HANDOFF-1');
    const options = await worker.fetch(new Request('https://installer.test/api/login-options'), { ...dockerEnv(), BOOTSTRAP_CONFIG: JSON.stringify(cfg) } as never);
    expect(await options.json()).toEqual({ recoveryCode: false, account: null, awaitingHandoff: true, docker: true });
    expect((await post(cfg, 'wrong')).status).toBe(401);
    const res = await post(cfg, 'DOCKER-HANDOFF-1');
    expect(res.status).toBe(200);
    expect((await res.json()) as any).toMatchObject({ email: 'bert@scouts.test', firstImport: true });
    const state = await env.INSTALLER_STATE.get<any>('state', 'json');
    expect(state.docker).toEqual({});
    expect(state.kubernetes).toBeUndefined();
    expect(state.cloudflare).toBeUndefined();
    expect(state.instanceName).toBe('tresjr');
    expect(state.login).toMatchObject({ issuer: 'https://login.test', clientId: 'arc_docker' });
    // Not twice.
    expect((await post(cfg, 'DOCKER-HANDOFF-1')).status).toBe(410);
  });

  it('a handoff for Kubernetes on a Docker installer: refused', async () => {
    expect((await post(await config('kubernetes', 'K'), 'K')).status).toBe(409);
  });
});
