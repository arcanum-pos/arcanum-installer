// A small Kubernetes API for the Kubernetes target's tests: server-side
// apply (merged, containers by name), Deployments that roll out once
// `ready`, pods that can be stuck, and Secrets written only on the version
// read (resourceVersion) — what kubernetes/client.ts and secret-kv.ts use.
import { Kube, type KubeTransport } from '../src/kubernetes/client';

type Obj = Record<string, any>;

function merge(a: any, b: any): any {
  if (Array.isArray(a) && Array.isArray(b) && b.every((x) => x && typeof x === 'object' && 'name' in x)) {
    const out = a.map((x: any) => ({ ...x }));
    for (const item of b) {
      const at = out.findIndex((x: any) => x.name === item.name);
      if (at >= 0) out[at] = merge(out[at], item);
      else out.push(item);
    }
    return out;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const out: Obj = { ...a };
    for (const [k, v] of Object.entries(b)) out[k] = k in a ? merge(a[k], v) : v;
    return out;
  }
  return b;
}

export class FakeKubeApi {
  objects = new Map<string, Obj>();
  applies: Obj[] = [];
  // Deployments come up at once; false: they stay pending.
  ready = true;
  // Pods' waiting reasons, by app name.
  stuck: Record<string, { reason: string; message: string }> = {};
  // A write that loses the race once (another writer got there first).
  conflictOnce = false;
  private version = 1;

  transport: KubeTransport = async (method, path, body) => {
    const [base] = path.split('?');
    if (method === 'GET' && /\/pods$/.test(base)) {
      const selector = decodeURIComponent(path.split('labelSelector=')[1] ?? '');
      const app = /app\.kubernetes\.io\/name=([^,]+)/.exec(selector)?.[1] ?? '';
      const problem = this.stuck[app];
      return { status: 200, body: { items: problem ? [{ status: { containerStatuses: [{ name: app, state: { waiting: problem }, restartCount: 0 } ] } }] : [] } };
    }
    if (method === 'GET') {
      const obj = this.objects.get(base);
      if (!obj) return { status: 404, body: { message: 'not found' } };
      if (obj.kind === 'Deployment' && this.ready) {
        obj.status = { observedGeneration: obj.metadata.generation, replicas: 1, updatedReplicas: 1, availableReplicas: 1 };
      }
      return { status: 200, body: structuredClone(obj) };
    }
    if (method === 'PATCH') {
      const existing = this.objects.get(base);
      const merged = existing ? merge(existing, body) : structuredClone(body as Obj);
      merged.metadata.generation = (existing?.metadata.generation ?? 0) + 1;
      merged.metadata.resourceVersion = String(++this.version);
      if (merged.kind === 'Deployment') merged.status = { observedGeneration: merged.metadata.generation - 1, replicas: 1, updatedReplicas: 0, availableReplicas: 0 };
      this.objects.set(base, merged);
      this.applies.push(structuredClone(body as Obj));
      return { status: 200, body: merged };
    }
    if (method === 'PUT' || method === 'POST') {
      const obj = structuredClone(body as Obj);
      const key = method === 'POST' ? `${base}/${obj.metadata.name}` : base;
      const existing = this.objects.get(key);
      if (this.conflictOnce || (method === 'POST' && existing) || (method === 'PUT' && existing?.metadata.resourceVersion !== obj.metadata.resourceVersion)) {
        this.conflictOnce = false;
        return { status: 409, body: { message: 'conflict' } };
      }
      obj.metadata.resourceVersion = String(++this.version);
      this.objects.set(key, obj);
      return { status: method === 'POST' ? 201 : 200, body: obj };
    }
    if (method === 'DELETE') {
      this.objects.delete(base);
      return { status: 200, body: {} };
    }
    return { status: 405, body: { message: method } };
  };

  kube(namespace = 'tresjr') {
    return new Kube(this.transport, namespace);
  }

  get(kind: string, name: string, namespace = 'tresjr'): Obj | undefined {
    const plural: Record<string, string> = { Secret: 'secrets', Service: 'services', PersistentVolumeClaim: 'persistentvolumeclaims', Deployment: 'deployments' };
    const base = kind === 'Deployment' ? `/apis/apps/v1` : '/api/v1';
    return this.objects.get(`${base}/namespaces/${namespace}/${plural[kind]}/${name}`);
  }

  // A Deployment as the Helm chart makes the installer's.
  seedInstaller(name = 'tresjr-installer') {
    this.objects.set(`/apis/apps/v1/namespaces/tresjr/deployments/${name}`, {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name, generation: 1, resourceVersion: '1' },
      spec: { replicas: 1, template: { spec: { containers: [{ name: 'installer', image: 'ghcr.io/arcanum-pos/tresjr-installer:0.1.1' }] } } },
    });
  }
}
