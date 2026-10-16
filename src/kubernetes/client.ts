// The Kubernetes API, the few calls the installer's Kubernetes target makes
// (SELF_HOSTING.md) — in its own namespace only: server-side apply (every
// step can run again; the installer is the field manager), read an object,
// and see whether a Deployment has rolled out. The transport is given: in
// the cluster, Node's https with the service account's token and CA
// (node/kube-transport.ts); in tests, a fake API server.
import { MANAGED_BY } from './manifests';

export interface KubeResponse {
  status: number;
  body: any;
}

export type KubeTransport = (method: string, path: string, body?: unknown, contentType?: string) => Promise<KubeResponse>;

export class KubeError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

const PLURAL: Record<string, string> = {
  Secret: 'secrets',
  Service: 'services',
  PersistentVolumeClaim: 'persistentvolumeclaims',
  ConfigMap: 'configmaps',
  Deployment: 'deployments',
  Job: 'jobs',
  Pod: 'pods',
};

export class Kube {
  constructor(
    private readonly transport: KubeTransport,
    readonly namespace: string
  ) {}

  path(apiVersion: string, kind: string, name?: string): string {
    const plural = PLURAL[kind];
    if (!plural) throw new Error(`Unknown kind ${kind}`);
    const base = apiVersion === 'v1' ? '/api/v1' : `/apis/${apiVersion}`;
    return `${base}/namespaces/${encodeURIComponent(this.namespace)}/${plural}${name ? `/${encodeURIComponent(name)}` : ''}`;
  }

  private async call(method: string, path: string, body?: unknown, contentType?: string): Promise<KubeResponse> {
    const res = await this.transport(method, path, body, contentType);
    if (res.status >= 400 && res.status !== 404) throw new KubeError(res.status, res.body?.message || `Kubernetes said ${res.status} to ${method} ${path}`);
    return res;
  }

  // Server-side apply: creates or updates, idempotent.
  async apply(manifest: Record<string, any>): Promise<any> {
    const { apiVersion, kind } = manifest;
    const name = manifest.metadata?.name;
    const res = await this.call('PATCH', `${this.path(apiVersion, kind, name)}?fieldManager=${MANAGED_BY}&force=true`, { ...manifest, metadata: { ...manifest.metadata, namespace: this.namespace } }, 'application/apply-patch+yaml');
    if (res.status === 404) throw new KubeError(404, `Kubernetes doesn't know ${kind} here (namespace ${this.namespace})`);
    return res.body;
  }

  async get(apiVersion: string, kind: string, name: string): Promise<any | null> {
    const res = await this.call('GET', this.path(apiVersion, kind, name));
    return res.status === 404 ? null : res.body;
  }

  // A whole object, only if it's still the version read (resourceVersion):
  // 409 when someone changed it in between — read again and retry.
  async replace(manifest: Record<string, any>): Promise<{ conflict: boolean; body?: any }> {
    const { apiVersion, kind } = manifest;
    const name = manifest.metadata.name;
    const exists = !!manifest.metadata.resourceVersion;
    const res = await this.transport(exists ? 'PUT' : 'POST', exists ? this.path(apiVersion, kind, name) : this.path(apiVersion, kind), { ...manifest, metadata: { ...manifest.metadata, namespace: this.namespace } }, 'application/json');
    if (res.status === 409) return { conflict: true };
    if (res.status >= 400) throw new KubeError(res.status, res.body?.message || `Kubernetes said ${res.status} to writing ${kind} ${name}`);
    return { conflict: false, body: res.body };
  }

  async remove(apiVersion: string, kind: string, name: string): Promise<void> {
    await this.call('DELETE', this.path(apiVersion, kind, name));
  }

  // Rolled out: the newest spec seen, every replica of it up to date and ready.
  async rollout(name: string): Promise<{ done: boolean; detail: string }> {
    const d = await this.get('apps/v1', 'Deployment', name);
    if (!d) return { done: false, detail: 'not there yet' };
    const want = d.spec?.replicas ?? 1;
    const s = d.status ?? {};
    const failed = (s.conditions ?? []).find((c: any) => c.type === 'Progressing' && c.reason === 'ProgressDeadlineExceeded');
    if (failed) throw new KubeError(500, `${name}: ${failed.message}`);
    const done = (s.observedGeneration ?? 0) >= (d.metadata?.generation ?? 1) && (s.updatedReplicas ?? 0) === want && (s.availableReplicas ?? 0) === want && (s.replicas ?? 0) === want;
    return { done, detail: `${s.updatedReplicas ?? 0}/${want} ready` };
  }

  // Why a Worker's pods don't come up, if they're stuck: an image that
  // can't be pulled, a container that keeps crashing, a missing setting.
  async podProblems(labelSelector: string): Promise<string[]> {
    const res = await this.call('GET', `${this.path('v1', 'Pod')}?labelSelector=${encodeURIComponent(labelSelector)}`);
    const problems: string[] = [];
    for (const pod of res.body?.items ?? []) {
      for (const c of [...(pod.status?.initContainerStatuses ?? []), ...(pod.status?.containerStatuses ?? [])]) {
        const waiting = c.state?.waiting;
        if (waiting && waiting.reason !== 'ContainerCreating' && waiting.reason !== 'PodInitializing') problems.push(`${c.name}: ${waiting.reason}${waiting.message ? ` — ${String(waiting.message).slice(0, 200)}` : ''}`);
        const ended = c.lastState?.terminated;
        if (ended && ended.exitCode !== 0 && c.restartCount > 0) problems.push(`${c.name}: stopped (${ended.reason ?? 'exit ' + ended.exitCode})`);
      }
    }
    return [...new Set(problems)];
  }
}
