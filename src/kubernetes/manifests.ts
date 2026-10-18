// From a release's Worker descriptor to what runs it on Kubernetes
// (SELF_HOSTING.md): its settings as a Secret (every var and secret — the
// same values the Cloudflare upload gets, contract.ts), a volume for its
// SQLite files when it keeps any, a Deployment of the release's image and a
// Service. Pure — tested in test/kubernetes.test.ts.
//
// What the Worker reaches through a binding on Cloudflare becomes an
// environment variable here, the way its Node runtime reads it:
//   service ARCANUM_<X>_SERVICE → <X>_URL = http://<instance>-<x>:8080
//   d1 (its database)           → <WORKER>_DB = /data/<worker>.db
//   kv (the bff's sessions)     → SESSIONS_DB = /data/sessions.db
//   Durable Objects, rate limit, assets, version metadata, send_email → in the process, the image, or not available.
// The backend's database is brought up to date by an init container before
// the new version starts — the old pod stopped first (a Worker with a volume
// is replaced, not rolled): its files copied, then `migrate`. Going back to an
// earlier version puts those copies back first (RESTORE_FROM).
import { envBinding, ownInstanceVars, type InstallContext, type WorkerDescriptor } from '../contract';

export const PORT = 8080;
export const MANAGED_BY = 'tresjr-installer';

export interface KubeContext {
  // The prefix of every name (state.ts INSTANCE_NAME): `<instance>-bff` …
  instance: string;
  // The release's image for a Worker, e.g. ghcr.io/arcanum-pos/tresjr-bff:0.1.70.
  image: (short: string) => string;
  version: string;
  storageSize?: string;
  storageClassName?: string;
  // Going back to an earlier version: the database copies made before `version`'s migrations.
  restoreFrom?: string;
}

// `arcanum-backend` → `backend`.
export const shortName = (logical: string) => logical.replace(/^arcanum-/, '');
export const objectName = (kube: KubeContext, logical: string) => `${kube.instance}-${shortName(logical)}`;
export const serviceUrl = (kube: KubeContext, logical: string) => `http://${objectName(kube, logical)}:${PORT}`;

const labels = (kube: KubeContext, logical: string) => ({
  'app.kubernetes.io/name': shortName(logical),
  'app.kubernetes.io/instance': kube.instance,
  'app.kubernetes.io/part-of': 'tresjr',
  'app.kubernetes.io/managed-by': MANAGED_BY,
});

// Every environment variable the Worker gets, as strings.
export function workerEnv(descriptor: WorkerDescriptor, ctx: InstallContext, kube: KubeContext): Record<string, string> {
  const env: Record<string, string> = { PORT: String(PORT) };
  const short = shortName(descriptor.name);
  for (const b of descriptor.bindings) {
    if (b.type === 'service') {
      const match = /^ARCANUM_(.+)_SERVICE$/.exec(b.name);
      if (match) env[`${match[1]}_URL`] = serviceUrl(kube, b.service);
    } else if (b.type === 'd1') env[`${short.toUpperCase()}_DB`] = `/data/${short}.db`;
    else if (b.type === 'kv_namespace') env.SESSIONS_DB = '/data/sessions.db';
  }
  const forced = ownInstanceVars(descriptor.name, ctx.orgCreation, ctx.demoInstallUrl);
  for (const [name, spec] of Object.entries(descriptor.env)) {
    if (name in forced) continue;
    const binding = envBinding(name, spec, ctx);
    if (!binding) continue;
    env[name] = typeof binding.text === 'string' ? binding.text : JSON.stringify(binding.json);
  }
  return { ...env, ...forced };
}

const keepsData = (descriptor: WorkerDescriptor) => descriptor.bindings.some((b) => b.type === 'd1' || b.type === 'kv_namespace');

// A short, stable digest of the settings: a change to them rolls the pods.
async function digest(env: Record<string, string>): Promise<string> {
  const text = JSON.stringify(Object.keys(env).sort().map((k) => [k, env[k]]));
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return [...hash.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// The backend's init container (and its one-off container with Docker): its
// database files copied aside (the old one has stopped), or an earlier copy
// put back; then migrate — all in the backend itself (node-main.ts), as
// arguments to the image's own entrypoint: the distroless image has no
// shell. (An image from before it, Alpine, starts `dist/node.mjs` with node
// all the same; the installer is always the release's own version, so it
// never asks an old image for what it can't do.)
// The distroless images' node. Set explicitly (with force, it's the
// installer's field): a command someone left on the init container by hand
// (an earlier `sh -c`) would otherwise stay and win over the arguments.
export const NODE = '/nodejs/bin/node';

export function migrateArgs(version: string, restoreFrom?: string): string[] {
  // --reset-login: the default login provider re-seeds from the current
  // settings (the Cloudflare target's login:reset step).
  return ['dist/node.mjs', 'migrate', ...(restoreFrom ? ['--restore-from', restoreFrom] : ['--backup-as', version]), '--reset-login'];
}

// `extraEnv`: what the installer adds itself (the bff's INSTALLER_URL).
export async function workerManifests(descriptor: WorkerDescriptor, ctx: InstallContext, kube: KubeContext, extraEnv: Record<string, string> = {}): Promise<Record<string, unknown>[]> {
  const name = objectName(kube, descriptor.name);
  const short = shortName(descriptor.name);
  const meta = (suffix = '') => ({ name: `${name}${suffix}`, labels: labels(kube, descriptor.name) });
  const env = { ...workerEnv(descriptor, ctx, kube), ...extraEnv };
  const data = keepsData(descriptor);
  const image = kube.image(short);
  const container = {
    name: short,
    image,
    imagePullPolicy: 'IfNotPresent',
    ports: [{ name: 'http', containerPort: PORT }],
    envFrom: [{ secretRef: { name: `${name}-env` } }],
    readinessProbe: { tcpSocket: { port: PORT }, periodSeconds: 5 },
    livenessProbe: { tcpSocket: { port: PORT }, periodSeconds: 20, failureThreshold: 6 },
    securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } },
    resources: { requests: { cpu: '20m', memory: '64Mi' }, limits: { memory: '256Mi' } },
    ...(data ? { volumeMounts: [{ name: 'data', mountPath: '/data' }] } : {}),
  };
  const migrates = descriptor.bindings.some((b) => b.type === 'd1') && short === 'backend';
  const manifests: Record<string, unknown>[] = [
    { apiVersion: 'v1', kind: 'Secret', metadata: meta('-env'), type: 'Opaque', stringData: env },
  ];
  if (data) {
    manifests.push({
      apiVersion: 'v1',
      kind: 'PersistentVolumeClaim',
      metadata: meta('-data'),
      spec: { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: kube.storageSize ?? '1Gi' } }, ...(kube.storageClassName ? { storageClassName: kube.storageClassName } : {}) },
    });
  }
  manifests.push({
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: meta(),
    spec: {
      replicas: 1,
      // SQLite on a volume: one writer, never two pods at once.
      strategy: data ? { type: 'Recreate' } : { type: 'RollingUpdate' },
      selector: { matchLabels: { 'app.kubernetes.io/name': short, 'app.kubernetes.io/instance': kube.instance } },
      template: {
        metadata: { labels: labels(kube, descriptor.name), annotations: { 'tresjr/settings': await digest(env), 'tresjr/version': kube.version } },
        spec: {
          automountServiceAccountToken: false,
          securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000, seccompProfile: { type: 'RuntimeDefault' } },
          ...(migrates
            ? { initContainers: [{ ...container, name: 'migrate', command: [NODE], args: migrateArgs(kube.version, kube.restoreFrom), ports: undefined, readinessProbe: undefined, livenessProbe: undefined }] }
            : {}),
          containers: [container],
          ...(data ? { volumes: [{ name: 'data', persistentVolumeClaim: { claimName: `${name}-data` } }] } : {}),
        },
      },
    },
  });
  manifests.push({
    apiVersion: 'v1',
    kind: 'Service',
    metadata: meta(),
    spec: { selector: { 'app.kubernetes.io/name': short, 'app.kubernetes.io/instance': kube.instance }, ports: [{ name: 'http', port: PORT, targetPort: 'http' }] },
  });
  return manifests;
}
