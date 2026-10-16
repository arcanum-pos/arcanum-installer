// The installer's KV (its state, sign-in sessions, pending sign-ins) in one
// JSON file on its own volume, for the installer running with Docker or
// Podman (SELF_HOSTING.md, compose) — the same calls as Workers KV: get
// (text or JSON), put with an expiry, delete. One process: writes go one
// after the other, each to a new file renamed over the old (never half a
// file). Expired keys go on the next write.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

interface Entry {
  v: string;
  // Expiry, ms since the epoch.
  e?: number;
}

export class FileKV {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }

  private read(): Record<string, Entry> {
    try {
      return JSON.parse(readFileSync(this.path, 'utf8'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw err;
    }
  }

  async get<T = string>(key: string, type?: 'text' | 'json'): Promise<T | null> {
    await this.queue;
    const entry = this.read()[key];
    if (!entry || (entry.e !== undefined && entry.e <= Date.now())) return null;
    return (type === 'json' ? JSON.parse(entry.v) : entry.v) as T;
  }

  private change(apply: (entries: Record<string, Entry>) => void): Promise<void> {
    const next = this.queue.then(() => {
      const entries = this.read();
      apply(entries);
      const now = Date.now();
      for (const [k, entry] of Object.entries(entries)) if (entry.e !== undefined && entry.e <= now) delete entries[k];
      const temp = `${this.path}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify(entries), { mode: 0o600 });
      renameSync(temp, this.path);
    });
    // A failed write doesn't block the ones after it.
    this.queue = next.catch(() => undefined);
    return next;
  }

  put(key: string, value: string, options: { expirationTtl?: number } = {}): Promise<void> {
    return this.change((entries) => {
      entries[key] = { v: value, ...(options.expirationTtl ? { e: Date.now() + options.expirationTtl * 1000 } : {}) };
    });
  }

  delete(key: string): Promise<void> {
    return this.change((entries) => {
      delete entries[key];
    });
  }
}
