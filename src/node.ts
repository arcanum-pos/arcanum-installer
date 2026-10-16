// The installer self-hosted on Kubernetes (SELF_HOSTING.md): the same
// installer (index.ts), served by Node, its KV in a Secret
// (kubernetes/secret-kv.ts), talking to its own cluster. Settings from the
// environment (the Helm chart sets them):
//   INSTALLER_STATE_KEY   random, never changed: seals its state (required)
//   BOOTSTRAP_CONFIG      the bootstrapper's handoff, imported once
//   INSTALLER_RELEASE     the release this installer comes from
//   INSTALLER_DEPLOYMENT  its own Deployment/Service (default <instance>-installer)
//   STATE_SECRET          the Secret its state lives in (default tresjr-installer-state)
//   RELEASES_INDEX_URL    the releases (default arcanum-releases' releases.json)
//   IMAGE_PREFIX / IMAGE_TAG   where the images come from (a test cluster)
//   KUBE_API_URL + KUBE_NAMESPACE   outside a cluster: through `kubectl proxy`
//   PORT                  to listen on (default 8080)
import { serve } from '@hono/node-server';
import worker from './index';
import type { Env } from './env';
import { Kube } from './kubernetes/client';
import { KubeSecretKV } from './kubernetes/secret-kv';
import { inClusterNamespace, inClusterTransport, proxyTransport } from './node/transport';

export const DEFAULT_RELEASES_INDEX = 'https://raw.githubusercontent.com/arcanum-pos/arcanum-releases/main/releases.json';

export function nodeEnv(environment: NodeJS.ProcessEnv, kube?: Kube): Env {
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
    IMAGE_PREFIX: environment.IMAGE_PREFIX,
    IMAGE_TAG: environment.IMAGE_TAG,
  };
}

export function start(environment: NodeJS.ProcessEnv = process.env, kube?: Kube) {
  const env = nodeEnv(environment, kube);
  const port = Number(environment.PORT || 8080);
  return serve({ fetch: (request) => worker.fetch(request, env), port }, () => console.log(`tresjr installer listening on :${port}`));
}
