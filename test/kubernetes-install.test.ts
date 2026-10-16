// The Kubernetes target end to end (SELF_HOSTING.md): the installer in a
// cluster (a fake API, test/fake-kube.ts) installs a release through its
// own API, the way the page does — every Worker's Secret, volume,
// Deployment and Service; the bff linked to the installer; done once it's
// rolled out, and why not when a pod is stuck; settings that reach the
// backend's Secret; the installer's own update; its state in a Secret.
import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { newSessionCookie } from '../src/auth';
import { KubeSecretKV } from '../src/kubernetes/secret-kv';
import { FakeKubeApi } from './fake-kube';
import { installFakes, NEXT_VERSION, SELF_UPDATE_VERSION, type Fakes } from './fakes';

let fakes: Fakes;
let api: FakeKubeApi;
let cookie = '';
let health: string[];

beforeEach(async () => {
  for (const key of (await env.INSTALLER_STATE.list()).keys) await env.INSTALLER_STATE.delete(key.name);
  fakes = await installFakes();
  api = new FakeKubeApi();
  api.seedInstaller();
  health = [];
  // The bff's health check, inside the cluster.
  const outer = (globalThis.fetch as any).getMockImplementation();
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: any) => {
    const url = new URL(new Request(input, init).url);
    if (url.host === 'tresjr-bff:8080') {
      health.push(url.pathname);
      return Response.json({ status: 'healthy' });
    }
    return outer(input, init);
  });
  cookie = (await newSessionCookie(env as never)).cookie.split(';')[0];
});
afterEach(() => vi.restoreAllMocks());

const kubeEnv = () => ({ ...(env as object), KUBE: api.kube(), INSTALLER_DEPLOYMENT: 'tresjr-installer' });

async function call(method: string, path: string, body?: unknown) {
  const res = await worker.fetch(
    new Request(`https://installer.test${path}`, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) }),
    kubeEnv() as never
  );
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function configure() {
  expect((await call('POST', '/api/address', { publicUrl: 'https://kassa.scouts.test' })).status).toBe(200);
  const login = await call('POST', '/api/login-provider', { issuer: 'https://login.test/', clientId: 'arcanum-client', clientSecret: 'idp-client-secret-value-xyz' });
  expect(login.status, JSON.stringify(login.body)).toBe(200);
  expect((await call('POST', '/api/admins', { emails: 'bert@scouts.test' })).status).toBe(200);
  // A release whose bff can forward to the installer (fakes.ts).
  fakes.releases.offerUpdate = true;
  const release = await call('POST', '/api/release', { version: NEXT_VERSION });
  expect(release.status, JSON.stringify(release.body)).toBe(200);
}

async function runAll() {
  const steps = (await call('GET', '/api/status')).body.steps as { id: string }[];
  const outcomes: Record<string, string> = {};
  for (const step of steps) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const r = (await call('POST', '/api/step', { id: step.id })).body;
      outcomes[step.id] = r.status === 'done' ? 'done' : `${r.status}: ${r.detail}`;
      if (r.status !== 'retry') break;
    }
    if (outcomes[step.id] !== 'done') return { stoppedAt: step.id, outcomes };
  }
  return { stoppedAt: null, outcomes };
}

const envOf = (worker: string) => api.get('Secret', `tresjr-${worker}-env`)!.stringData as Record<string, string>;

describe('installing on Kubernetes', () => {
  it('the steps: no Cloudflare in sight; the public address instead of a domain', async () => {
    const status = (await call('GET', '/api/status')).body;
    expect(status.kubernetes).toEqual({ namespace: 'tresjr', publicUrl: null });
    expect((await call('POST', '/api/address', { publicUrl: 'http://kassa.scouts.test' })).status).toBe(400);
    expect((await call('POST', '/api/address', { publicUrl: 'https://kassa.scouts.test/pad' })).status).toBe(400);
    await configure();
    const ids = (await call('GET', '/api/status')).body.steps.map((s: any) => s.id);
    expect(ids).toEqual(['secrets', 'worker:arcanum-mailer', 'worker:arcanum-devicehub', 'worker:arcanum-frontends', 'worker:arcanum-backend', 'worker:arcanum-bff', 'verify']);
  });

  it('every Worker as a Deployment of its image with its Secret, volumes where they keep data; then verified', async () => {
    await configure();
    const run = await runAll();
    expect(run.stoppedAt, JSON.stringify(run.outcomes)).toBeNull();
    for (const w of ['mailer', 'devicehub', 'frontends', 'backend', 'bff']) {
      const d = api.get('Deployment', `tresjr-${w}`)!;
      expect(d.spec.template.spec.containers[0].image, w).toBe(`ghcr.io/arcanum-pos/tresjr-${w}:${NEXT_VERSION}`);
      expect(api.get('Service', `tresjr-${w}`), w).toBeDefined();
    }
    expect(['backend', 'devicehub', 'bff'].map((w) => !!api.get('PersistentVolumeClaim', `tresjr-${w}-data`))).toEqual([true, true, true]);
    expect(api.get('PersistentVolumeClaim', 'tresjr-mailer-data')).toBeUndefined();
    // The same generated secrets everywhere they're shared.
    expect(envOf('backend').INTERNAL_API_KEY).toBe(envOf('devicehub').INTERNAL_API_KEY);
    expect(envOf('backend').MAILER_INTERNAL_KEY).toBe(envOf('mailer').MAILER_INTERNAL_KEY);
    expect(atob(envOf('backend').ENCRYPTION_KEY)).toHaveLength(32);
    // The bff behind the public address, and linked to the installer.
    expect(envOf('bff')).toMatchObject({ FRONTEND_URL: 'https://kassa.scouts.test', BACKEND_URL: 'http://tresjr-backend:8080', INSTALLER_URL: 'http://tresjr-installer:8080' });
    expect(envOf('bff').INSTALLER_INTERNAL_KEY).toMatch(/^[0-9a-f]{64}$/);
    expect(envOf('backend')).toMatchObject({ ORG_CREATION: 'single', INSTANCE_ADMIN_EMAILS: 'bert@scouts.test', BACKEND_DB: '/data/backend.db' });
    expect(health).toEqual(['/health']);
    expect((await call('GET', '/api/status')).body.installed.version).toBe(NEXT_VERSION);
    // Again: nothing new to generate, the same keys.
    const key = envOf('backend').ENCRYPTION_KEY;
    expect((await runAll()).stoppedAt).toBeNull();
    expect(envOf('backend').ENCRYPTION_KEY).toBe(key);
  });

  it("a Worker that doesn't come up: the step waits, and says why", async () => {
    await configure();
    api.ready = false;
    api.stuck.mailer = { reason: 'ImagePullBackOff', message: 'pull access denied for ghcr.io/arcanum-pos/tresjr-mailer' };
    await call('POST', '/api/step', { id: 'secrets' });
    const r = (await call('POST', '/api/step', { id: 'worker:arcanum-mailer' })).body;
    expect(r.status).toBe('retry');
    expect(r.detail).toContain('ImagePullBackOff');
    expect(r.detail).toContain('pull access denied');
    api.ready = true;
    expect((await call('POST', '/api/step', { id: 'worker:arcanum-mailer' })).body.status).toBe('done');
  });

  it("a setting changed once installed goes straight into the backend's Secret (its pods roll)", async () => {
    await configure();
    await runAll();
    const before = api.get('Deployment', 'tresjr-backend')!.spec.template.metadata.annotations['tresjr/settings'];
    const res = await call('POST', '/api/admins', { emails: 'bert@scouts.test, an@scouts.test' });
    expect(res.body.adminsApplied).toBe('applied');
    expect(envOf('backend').INSTANCE_ADMIN_EMAILS).toBe('bert@scouts.test, an@scouts.test');
    expect(api.get('Deployment', 'tresjr-backend')!.spec.template.metadata.annotations['tresjr/settings']).not.toBe(before);
  });

  it("an update with a newer installer: its own Deployment first, to the release's image", async () => {
    await configure();
    await runAll();
    fakes.releases.offerSelfUpdate = true;
    const chosen = await call('POST', '/api/release', { version: SELF_UPDATE_VERSION });
    expect(chosen.body.steps[0].id).toBe('installer:self');
    expect((await call('POST', '/api/step', { id: 'installer:self' })).body.status).toBe('done');
    const container = api.get('Deployment', 'tresjr-installer')!.spec.template.spec.containers[0];
    expect(container.image).toBe(`ghcr.io/arcanum-pos/tresjr-installer:${SELF_UPDATE_VERSION}`);
    expect(container.env).toEqual([{ name: 'INSTALLER_RELEASE', value: SELF_UPDATE_VERSION }]);
  });
});

describe('the handoff for a Kubernetes installation', () => {
  it("signs the owner in with a recovery code, takes the login provider, and empties the chart's Secret", async () => {
    const code = 'K8S-HANDOFF-CODE-123';
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code)))].map((b) => b.toString(16).padStart(2, '0')).join('');
    const config = {
      version: 1,
      target: 'kubernetes',
      login: { issuer: 'https://login.test', clientId: 'arc_k8s', clientSecret: 'k8s-client-secret' },
      owner: { email: 'Bert@Scouts.test', sub: 'sub-bert' },
      handoffCodeHash: hash,
      handoffExpiresAt: new Date(Date.now() + 600_000).toISOString(),
    };
    const handoffEnv = { ...kubeEnv(), BOOTSTRAP_CONFIG: JSON.stringify(config), BOOTSTRAP_SECRET: 'tresjr-installer-bootstrap' };
    const post = (body: unknown) =>
      worker.fetch(new Request('https://installer.test/api/handoff', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), handoffEnv as never);
    expect((await post({ code: 'wrong' })).status).toBe(401);
    const res = await post({ code });
    expect(res.status).toBe(200);
    expect((await res.json()) as any).toMatchObject({ email: 'bert@scouts.test', firstImport: true, recoveryCode: expect.stringMatching(/^([A-Z2-9]{4}-){4}[A-Z2-9]{4}$/) });
    const state = await env.INSTALLER_STATE.get<any>('state', 'json');
    expect(state.cloudflare).toBeUndefined();
    expect(state.kubernetes).toEqual({ namespace: 'tresjr' });
    expect(state.instanceName).toBe('tresjr');
    expect(state.login).toMatchObject({ issuer: 'https://login.test', clientId: 'arc_k8s' });
    expect(state.admins).toBe('bert@scouts.test');
    expect(JSON.parse(api.get('Secret', 'tresjr-installer-bootstrap')!.stringData.BOOTSTRAP_CONFIG)).toEqual({ version: 1, imported: true });
    // Not twice.
    expect((await post({ code })).status).toBe(410);
  });

  it('a Cloudflare handoff on a Kubernetes installer (or the other way round): refused', async () => {
    const config = { version: 1, cloudflareToken: 't', accountId: 'a', accountName: 'A', subdomain: 's', login: null, owner: { email: 'b@s.test', sub: 's' }, handoffCodeHash: 'x'.repeat(64), handoffExpiresAt: new Date(Date.now() + 600_000).toISOString() };
    const code = 'CODE';
    config.handoffCodeHash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code)))].map((b) => b.toString(16).padStart(2, '0')).join('');
    const res = await worker.fetch(new Request('https://installer.test/api/handoff', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) }), { ...kubeEnv(), BOOTSTRAP_CONFIG: JSON.stringify(config) } as never);
    expect(res.status).toBe(409);
  });
});

describe("the installer's state in a Secret", () => {
  it('get, put with an expiry, delete — and a write that lost a race tries again', async () => {
    const kv = new KubeSecretKV(api.kube(), 'tresjr-installer-state');
    expect(await kv.get('state')).toBeNull();
    await kv.put('state', JSON.stringify({ v: 1 }));
    await kv.put('session-email:abc', 'bert@scouts.test', { expirationTtl: 60 });
    expect(await kv.get('state', 'json')).toEqual({ v: 1 });
    expect(await kv.get('session-email:abc')).toBe('bert@scouts.test');
    api.conflictOnce = true;
    await kv.put('oidc-pending:x', '{}');
    expect(await kv.get('oidc-pending:x')).toBe('{}');
    await kv.delete('oidc-pending:x');
    expect(await kv.get('oidc-pending:x')).toBeNull();
    await kv.put('old', 'x', { expirationTtl: -1 });
    expect(await kv.get('old')).toBeNull();
    // Keys as Secret data keys.
    expect(Object.keys(api.get('Secret', 'tresjr-installer-state')!.data).every((k) => /^[-._a-zA-Z0-9]+$/.test(k))).toBe(true);
  });
});
