// The Kubernetes target's manifests (src/kubernetes/manifests.ts), from the
// real release descriptors (test/fixtures): every Worker's settings as a
// Secret — the same values its Cloudflare upload gets — its bindings as the
// URLs and files its Node runtime reads, a volume only where it keeps data,
// and the backend's migration before its new version starts.
import { describe, expect, it } from 'vitest';
import type { InstallContext, WorkerDescriptor } from '../src/contract';
import { migrateArgs, workerEnv, workerManifests, type KubeContext } from '../src/kubernetes/manifests';
import fixture from './fixtures/release-0.1.2.json';

const workers = fixture.workers as unknown as Record<string, WorkerDescriptor>;

const ctx: InstallContext = {
  publicUrl: 'https://kassa.scouts.test',
  issuerUrl: 'https://login.test/',
  answers: { 'login.issuer': 'https://login.test/', 'login.clientId': 'c', 'login.clientSecret': 's', admins: 'bert@scouts.test' },
  optional: { SOURCE_URL: 'https://github.com/arcanum-pos/arcanum-releases/releases/tag/v0.1.70' },
  secrets: new Proxy({}, { get: (_t, name) => `secret-${String(name)}` }) as Record<string, string>,
  resources: { d1: {}, kv: {}, ratelimitNamespaceId: '' },
  currentMigrationTag: null,
};
const kube: KubeContext = { instance: 'tresjr', image: (short) => `ghcr.io/arcanum-pos/tresjr-${short}:0.1.70`, version: '0.1.70' };

const byKind = (manifests: Record<string, unknown>[], kind: string) => manifests.filter((m) => m.kind === kind) as any[];

describe('a Worker on Kubernetes', () => {
  it('the bff: the other Workers by their Service, its sessions in a file, its vars and secrets', () => {
    const env = workerEnv(workers['arcanum-bff'], ctx, kube);
    expect(env).toMatchObject({
      PORT: '8080',
      BACKEND_URL: 'http://tresjr-backend:8080',
      DEVICEHUB_URL: 'http://tresjr-devicehub:8080',
      FRONTENDS_URL: 'http://tresjr-frontends:8080',
      SESSIONS_DB: '/data/sessions.db',
      FRONTEND_URL: 'https://kassa.scouts.test',
      BFF_INTERNAL_KEY: 'secret-BFF_INTERNAL_KEY',
      // A JSON var as text.
      SESSION_TTL: '604800',
    });
    // Nothing Cloudflare-only.
    expect(Object.keys(env).some((k) => /RATE_LIMITER|VERSION_METADATA|ARCANUM_.*_SERVICE/.test(k))).toBe(false);
  });

  it("the backend: its database file, devicehub and the mailer by URL, an own instance's ORG_CREATION", () => {
    expect(workerEnv(workers['arcanum-backend'], ctx, kube)).toMatchObject({
      BACKEND_DB: '/data/backend.db',
      DEVICEHUB_URL: 'http://tresjr-devicehub:8080',
      MAILER_URL: 'http://tresjr-mailer:8080',
      ORG_CREATION: 'single',
    });
  });

  it('settings in a Secret; a Deployment of the release image, non-root, with a Service', async () => {
    const m = await workerManifests(workers['arcanum-mailer'], ctx, kube);
    expect(m.map((x) => x.kind)).toEqual(['Secret', 'Deployment', 'Service']);
    const [secret] = byKind(m, 'Secret');
    expect(secret.metadata.name).toBe('tresjr-mailer-env');
    expect(secret.stringData.MAILER_INTERNAL_KEY).toBe('secret-MAILER_INTERNAL_KEY');
    const [deployment] = byKind(m, 'Deployment');
    const pod = deployment.spec.template.spec;
    expect(pod.containers[0]).toMatchObject({ image: 'ghcr.io/arcanum-pos/tresjr-mailer:0.1.70', envFrom: [{ secretRef: { name: 'tresjr-mailer-env' } }] });
    expect(pod.securityContext).toMatchObject({ runAsNonRoot: true });
    expect(pod.automountServiceAccountToken).toBe(false);
    expect(deployment.spec.strategy.type).toBe('RollingUpdate');
    expect(byKind(m, 'Service')[0].spec.ports).toEqual([{ name: 'http', port: 8080, targetPort: 'http' }]);
  });

  it('a Worker with data: its volume, replaced not rolled (one SQLite writer)', async () => {
    const m = await workerManifests(workers['arcanum-devicehub'], ctx, kube);
    expect(m.map((x) => x.kind)).toEqual(['Secret', 'PersistentVolumeClaim', 'Deployment', 'Service']);
    const [deployment] = byKind(m, 'Deployment');
    expect(deployment.spec.strategy).toEqual({ type: 'Recreate' });
    expect(deployment.spec.template.spec.volumes).toEqual([{ name: 'data', persistentVolumeClaim: { claimName: 'tresjr-devicehub-data' } }]);
    expect(deployment.spec.template.spec.initContainers).toBeUndefined();
  });

  it('the backend migrates first, in an init container of the new version — after copying its files', async () => {
    const [deployment] = byKind(await workerManifests(workers['arcanum-backend'], ctx, kube), 'Deployment');
    const [init] = deployment.spec.template.spec.initContainers;
    expect(init.image).toBe('ghcr.io/arcanum-pos/tresjr-backend:0.1.70');
    // No shell (the distroless image has none): arguments to the image's own entrypoint, node.
    expect(init.command).toEqual(['/nodejs/bin/node']);
    expect(init.args).toEqual(['dist/node.mjs', 'migrate', '--backup-as', '0.1.70', '--reset-login']);
    // Going back: the copies put back before anything runs.
    expect(migrateArgs('0.1.69', '0.1.70')).toEqual(['dist/node.mjs', 'migrate', '--restore-from', '0.1.70', '--reset-login']);
  });

  it('a change of settings rolls the pods; the same settings do not', async () => {
    const annotation = async (c: InstallContext) => byKind(await workerManifests(workers['arcanum-mailer'], c, kube), 'Deployment')[0].spec.template.metadata.annotations['tresjr/settings'];
    expect(await annotation(ctx)).toBe(await annotation(ctx));
    expect(await annotation({ ...ctx, secrets: { MAILER_INTERNAL_KEY: 'another' } })).not.toBe(await annotation(ctx));
  });
});
