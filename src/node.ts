// The installer self-hosted on Kubernetes (SELF_HOSTING.md): the same
// installer (index.ts), served by Node, its KV in a Secret
// (kubernetes/secret-kv.ts), talking to its own cluster. Settings from the
// environment (the Helm chart sets them):
//   INSTALLER_STATE_KEY   random, never changed: seals its state (required)
//   BOOTSTRAP_CONFIG      the bootstrapper's handoff, imported once
//   INSTALLER_RELEASE     the release this installer comes from
//   INSTALLER_DEPLOYMENT  its own Deployment/Service (default <instance>-installer)
//   BOOTSTRAP_SECRET      the Secret BOOTSTRAP_CONFIG comes from (emptied after the handoff)
//   STATE_SECRET          the Secret its state lives in (default tresjr-installer-state)
//   RELEASES_INDEX_URL    the releases (default arcanum-releases' releases.json)
//   IMAGE_PREFIX / IMAGE_TAG   where the images come from (a test cluster)
//   KUBE_API_URL + KUBE_NAMESPACE   outside a cluster: through `kubectl proxy`
// With Docker or Podman instead (compose.yaml, INSTALLER_TARGET=docker):
//   DOCKER_SOCKET         the engine's socket (default /var/run/docker.sock; DOCKER_HOST=tcp://… instead)
//   DOCKER_NETWORK        the network every container joins (default tresjr)
//   INSTALLER_CONTAINER   its own container (default tresjr-installer)
//   PUBLISH_BFF           where the bff is published on the machine (default 127.0.0.1:8000)
//   DATA_DIR              its state and key (default /data); INSTALLER_STATE_KEY made there once if not given
//   PORT                  to listen on (default 8080)
import { serve } from '@hono/node-server';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { Docker } from './docker/client';
import { FileKV } from './node/file-kv';
import { dockerTransport } from './node/docker-transport';
import worker from './index';
import type { Env } from './env';
import { Kube } from './kubernetes/client';
import { KubeSecretKV } from './kubernetes/secret-kv';
import { inClusterNamespace, inClusterTransport, proxyTransport } from './node/transport';

export const DEFAULT_RELEASES_INDEX = 'https://raw.githubusercontent.com/arcanum-pos/arcanum-releases/main/releases.json';

// With Docker: the state key in the installer's volume, made the first time.
function stateKeyOf(environment: NodeJS.ProcessEnv, dataDir: string): string {
  if (environment.INSTALLER_STATE_KEY) return environment.INSTALLER_STATE_KEY;
  const file = `${dataDir}/installer-state.key`;
  if (!existsSync(file)) {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(file, btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(48)))), { mode: 0o600, flag: 'wx' });
  }
  return readFileSync(file, 'utf8').trim();
}

export function dockerEnv(environment: NodeJS.ProcessEnv, docker?: Docker): Env {
  const dataDir = environment.DATA_DIR || '/data';
  return {
    INSTALLER_STATE: new FileKV(`${dataDir}/installer-state.json`) as unknown as KVNamespace,
    INSTALLER_STATE_KEY: stateKeyOf(environment, dataDir),
    BOOTSTRAP_CONFIG: environment.BOOTSTRAP_CONFIG,
    INSTALLER_RELEASE: environment.INSTALLER_RELEASE,
    RELEASES_INDEX_URL: environment.RELEASES_INDEX_URL || DEFAULT_RELEASES_INDEX,
    DOCKER: docker ?? new Docker(dockerTransport(environment), environment.DOCKER_NETWORK || 'tresjr'),
    INSTALLER_CONTAINER: environment.INSTALLER_CONTAINER || 'tresjr-installer',
    PUBLISH_BFF: environment.PUBLISH_BFF,
    DOCKER_HOST: environment.DOCKER_HOST,
    IMAGE_PREFIX: environment.IMAGE_PREFIX,
    IMAGE_TAG: environment.IMAGE_TAG,
  };
}

export function nodeEnv(environment: NodeJS.ProcessEnv, kube?: Kube): Env {
  if (environment.INSTALLER_TARGET === 'docker') return dockerEnv(environment);
  if (!environment.INSTALLER_STATE_KEY) throw new Error('INSTALLER_STATE_KEY is required');
  const cluster =
    kube ??
    (environment.KUBE_API_URL
      ? new Kube(proxyTransport(environment.KUBE_API_URL), environment.KUBE_NAMESPACE || 'default')
      : new Kube(inClusterTransport(), inClusterNamespace()));
  return {
    INSTALLER_STATE: new KubeSecretKV(cluster, environment.STATE_SECRET || 'tresjr-installer-state') as unknown as KVNamespace,
    INSTALLER_STATE_KEY: environment.INSTALLER_STATE_KEY,
    BOOTSTRAP_CONFIG: environment.BOOTSTRAP_CONFIG,
    INSTALLER_RELEASE: environment.INSTALLER_RELEASE,
    RELEASES_INDEX_URL: environment.RELEASES_INDEX_URL || DEFAULT_RELEASES_INDEX,
    KUBE: cluster,
    INSTALLER_DEPLOYMENT: environment.INSTALLER_DEPLOYMENT,
    BOOTSTRAP_SECRET: environment.BOOTSTRAP_SECRET,
    IMAGE_PREFIX: environment.IMAGE_PREFIX,
    IMAGE_TAG: environment.IMAGE_TAG,
  };
}

export function start(environment: NodeJS.ProcessEnv = process.env, kube?: Kube) {
  const env = nodeEnv(environment, kube);
  const port = Number(environment.PORT || 8080);
  return serve({ fetch: (request) => worker.fetch(request, env), port }, () => console.log(`tresjr installer listening on :${port}`));
}
