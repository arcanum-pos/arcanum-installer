// From a release's Worker descriptor to the container that runs it with
// Docker or Podman (SELF_HOSTING.md, compose) — the same settings as on
// Kubernetes (kubernetes/manifests.ts workerEnv: every var and secret, the
// other Workers by name), in a container on the installation's network:
// `<instance>-<worker>`, its data in a named volume, restarted unless
// stopped. Only the bff is published on the machine (PUBLISH_BFF). Pure —
// tested in test/docker.test.ts.
import type { InstallContext, WorkerDescriptor } from '../contract';
import { migrateArgs, objectName, PORT, shortName, workerEnv, type KubeContext } from '../kubernetes/manifests';

export const LABEL = 'be.tresjr';

export interface ContainerSpec {
  name: string;
  image: string;
  // Docker's create body.
  config: Record<string, unknown>;
  // Its named volume (/data), when it keeps data.
  volume?: string;
  // The backend: its database brought up to date first, in a one-off container.
  migrate?: Record<string, unknown>;
  // Of everything above: a change means a new container.
  digest: string;
}

// `127.0.0.1:8000` → where the bff listens on the machine; a bare port is on every address.
export function publishOf(value: string | undefined): { HostIp?: string; HostPort: string } | null {
  if (!value) return null;
  const m = /^(?:\[?([0-9a-fA-F.:]+)\]?:)?(\d{1,5})$/.exec(value.trim());
  return m ? { ...(m[1] ? { HostIp: m[1] } : {}), HostPort: m[2] } : null;
}

async function digestOf(value: unknown): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value))));
  return [...hash.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const keepsData = (descriptor: WorkerDescriptor) => descriptor.bindings.some((b) => b.type === 'd1' || b.type === 'kv_namespace');

export async function containerSpec(
  descriptor: WorkerDescriptor,
  ctx: InstallContext,
  instance: KubeContext,
  network: string,
  options: { extraEnv?: Record<string, string>; publish?: { HostIp?: string; HostPort: string } | null } = {}
): Promise<ContainerSpec> {
  const name = objectName(instance, descriptor.name);
  const short = shortName(descriptor.name);
  const env = { ...workerEnv(descriptor, ctx, instance), ...(options.extraEnv ?? {}) };
  const image = instance.image(short);
  const volume = keepsData(descriptor) ? `${name}-data` : undefined;
  const publish = descriptor.public_entry ? options.publish ?? null : null;
  const envList = Object.keys(env)
    .sort()
    .map((k) => `${k}=${env[k]}`);
  const host = {
    RestartPolicy: { Name: 'unless-stopped' },
    ReadonlyRootfs: true,
    CapDrop: ['ALL'],
    SecurityOpt: ['no-new-privileges'],
    ...(volume ? { Mounts: [{ Type: 'volume', Source: volume, Target: '/data' }] } : {}),
  };
  const digest = await digestOf({ image, envList, volume, publish });
  const labels = { [`${LABEL}.instance`]: instance.instance, [`${LABEL}.worker`]: short, [`${LABEL}.managed-by`]: 'tresjr-installer', [`${LABEL}.settings`]: digest, [`${LABEL}.version`]: instance.version };
  const config = {
    Image: image,
    Env: envList,
    Labels: labels,
    ExposedPorts: { [`${PORT}/tcp`]: {} },
    HostConfig: { ...host, ...(publish ? { PortBindings: { [`${PORT}/tcp`]: [publish] } } : {}) },
    NetworkingConfig: { EndpointsConfig: { [network]: { Aliases: [name] } } },
  };
  const migrates = short === 'backend' && descriptor.bindings.some((b) => b.type === 'd1');
  const migrate = migrates
    ? {
        Image: image,
        Env: envList,
        Labels: { ...labels, [`${LABEL}.job`]: 'migrate' },
        Cmd: migrateArgs(instance.version, instance.restoreFrom),
        HostConfig: { ...host, RestartPolicy: { Name: 'no' } },
        NetworkingConfig: { EndpointsConfig: { [network]: {} } },
      }
    : undefined;
  return { name, image, config, volume, migrate, digest };
}
