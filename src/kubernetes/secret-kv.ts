// The installer's KV (its state, sign-in sessions, pending sign-ins) in a
// Kubernetes Secret, for the installer running in the cluster
// (SELF_HOSTING.md) — the same calls as Workers KV: get (text or JSON),
// put with an expiry, delete. One Secret, every key in it; a write only
// lands on the version it read (else it reads again and retries), so two
// requests never overwrite each other's keys. Expired keys go on the next write.
import type { Kube } from './client';

interface Entry {
  v: string;
  // Expiry, ms since the epoch.
  e?: number;
}

// Secret keys allow only [-._a-zA-Z0-9]: a KV key ("session-email:…") as base64url.
const encodeKey = (key: string) => btoa(String.fromCharCode(...new TextEncoder().encode(key))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const toBase64 = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));
const fromBase64 = (b64: string) => new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));

export class KubeSecretKV {
  constructor(
    private readonly kube: Kube,
    private readonly name: string
  ) {}

  private async read(): Promise<{ secret: any | null; entries: Record<string, Entry> }> {
    const secret = await this.kube.get('v1', 'Secret', this.name);
    const entries: Record<string, Entry> = {};
    for (const [k, v] of Object.entries((secret?.data ?? {}) as Record<string, string>)) {
      try {
        entries[k] = JSON.parse(fromBase64(v));
      } catch {
        // not ours: left as is
      }
    }
    return { secret, entries };
  }

  async get<T = string>(key: string, type?: 'text' | 'json'): Promise<T | null> {
    const entry = (await this.read()).entries[encodeKey(key)];
    if (!entry || (entry.e !== undefined && entry.e <= Date.now())) return null;
    return (type === 'json' ? JSON.parse(entry.v) : entry.v) as T;
  }

  private async change(apply: (entries: Record<string, Entry>) => void): Promise<void> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const { secret, entries } = await this.read();
      apply(entries);
      const now = Date.now();
      const data: Record<string, string> = {};
      for (const [k, entry] of Object.entries(entries)) if (entry.e === undefined || entry.e > now) data[k] = toBase64(JSON.stringify(entry));
      const { conflict } = await this.kube.replace({
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: { name: this.name, ...(secret ? { resourceVersion: secret.metadata.resourceVersion, labels: secret.metadata.labels } : { labels: { 'app.kubernetes.io/part-of': 'tresjr' } }) },
        type: 'Opaque',
        data,
      });
      if (!conflict) return;
    }
    throw new Error(`The installer's state (${this.name}) kept changing underneath - try again`);
  }

  async put(key: string, value: string, options: { expirationTtl?: number } = {}): Promise<void> {
    await this.change((entries) => {
      entries[encodeKey(key)] = { v: value, ...(options.expirationTtl ? { e: Date.now() + options.expirationTtl * 1000 } : {}) };
    });
  }

  async delete(key: string): Promise<void> {
    await this.change((entries) => {
      delete entries[encodeKey(key)];
    });
  }
}
