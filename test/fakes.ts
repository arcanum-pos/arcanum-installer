// In-memory stand-ins for everything the installer talks to: the Cloudflare
// API (enforcing the rules the real one has — bindings must point at
// existing resources and already-uploaded Workers, DO migration tags must
// line up, assets need a completion JWT), a published release built from
// the real v0.1.1 descriptors (test/fixtures), a login provider, and the
// installed Arcanum's public address. Installed via vi.spyOn(fetch).
import { vi } from 'vitest';
import fixture from './fixtures/release-0.1.1.json';

export const TOKEN = 'cf-test-token-0123456789abcdefghij';
export const OTHER_ACCOUNT_TOKEN = 'cf-other-account-token-0123456789ab';
export const SUBDOMAIN = 'scouts';
export const PUBLIC_URL = `https://arcanum-bff.${SUBDOMAIN}.workers.dev`;
export const RELEASE_BASE = 'https://releases.test/download/v0.1.1';

const enc = new TextEncoder();

async function sha256(data: Uint8Array) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function ok(result: unknown, status = 200) {
  return Response.json({ success: true, errors: [], messages: [], result }, { status });
}

function fail(status: number, message: string, code = 10000) {
  return Response.json({ success: false, errors: [{ code, message }], messages: [], result: null }, { status });
}

export interface UploadedScript {
  metadata: any;
  modules: Record<string, { type: string; text: string }>;
  order: number;
}

export class FakeCloudflare {
  accounts = [{ id: 'acc-1', name: 'Scouts Elewijt' }];
  d1 = new Map<string, { name: string; queries: string[] }>();
  kv = new Map<string, string>(); // id -> title
  scripts = new Map<string, UploadedScript>();
  migrationTags = new Map<string, string>();
  workersDev = new Map<string, boolean>();
  assets = new Set<string>(); // uploaded hashes
  sessions = new Map<string, { needed: Set<string>; completion: string }>();
  completionJwts = new Set<string>();
  failures: { match: RegExp; message: string }[] = [];
  uploads = 0;
  private seq = 0;

  failOnce(match: RegExp, message = 'Simulated failure') {
    this.failures.push({ match, message });
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/client\/v4/, '');
    const method = request.method;
    const f = this.failures.findIndex((x) => x.match.test(`${method} ${path}`));
    if (f !== -1) {
      const [failure] = this.failures.splice(f, 1);
      return fail(500, failure.message);
    }

    const auth = request.headers.get('Authorization') ?? '';
    const assetUpload = path.endsWith('/workers/assets/upload');
    if (!assetUpload && auth !== `Bearer ${TOKEN}` && auth !== `Bearer ${OTHER_ACCOUNT_TOKEN}`) return fail(403, 'Authentication error', 10000);
    const accounts = auth === `Bearer ${OTHER_ACCOUNT_TOKEN}` ? [{ id: 'acc-2', name: 'Ander account' }] : this.accounts;

    if (method === 'GET' && path === '/accounts') return ok(accounts);
    const m = path.match(/^\/accounts\/([^/]+)(\/.*)$/);
    if (!m) return fail(404, 'Not found');
    const [, accountId, rest] = m;
    if (!accounts.some((a) => a.id === accountId)) return fail(403, 'Not allowed on this account');

    if (method === 'GET' && rest === '/workers/subdomain') return ok({ subdomain: SUBDOMAIN });

    if (rest === '/d1/database') {
      if (method === 'GET') return ok([...this.d1].filter(([, d]) => !url.searchParams.get('name') || d.name === url.searchParams.get('name')).map(([uuid, d]) => ({ uuid, name: d.name })));
      const { name } = (await request.json()) as { name: string };
      if ([...this.d1.values()].some((d) => d.name === name)) return fail(409, 'A database with that name already exists', 7502);
      const uuid = `d1-${++this.seq}`;
      this.d1.set(uuid, { name, queries: [] });
      return ok({ uuid, name });
    }
    const q = rest.match(/^\/d1\/database\/([^/]+)\/query$/);
    if (q && method === 'POST') {
      const db = this.d1.get(q[1]);
      if (!db) return fail(404, 'Database not found', 7404);
      db.queries.push(((await request.json()) as { sql: string }).sql);
      return ok([{ success: true, results: [], meta: {} }]);
    }

    if (rest === '/storage/kv/namespaces') {
      if (method === 'GET') return ok([...this.kv].map(([id, title]) => ({ id, title })));
      const { title } = (await request.json()) as { title: string };
      if ([...this.kv.values()].includes(title)) return fail(400, 'a namespace with this account ID and title already exists', 10014);
      const id = `kv-${++this.seq}`;
      this.kv.set(id, title);
      return ok({ id, title });
    }

    const svc = rest.match(/^\/workers\/services\/([^/]+)$/);
    if (svc && method === 'GET') {
      if (!this.scripts.has(svc[1])) return fail(404, 'This Worker does not exist on your account.', 10007);
      const tag = this.migrationTags.get(svc[1]);
      return ok({ id: svc[1], default_environment: { script: tag ? { migration_tag: tag } : {} } });
    }

    const script = rest.match(/^\/workers\/scripts\/([^/]+)$/);
    if (script && method === 'PUT') return this.putScript(script[1], request);

    const sub = rest.match(/^\/workers\/scripts\/([^/]+)\/subdomain$/);
    if (sub && method === 'POST') {
      if (!this.scripts.has(sub[1])) return fail(404, 'Worker not found', 10007);
      this.workersDev.set(sub[1], ((await request.json()) as { enabled: boolean }).enabled);
      return ok({ enabled: this.workersDev.get(sub[1]) });
    }

    const session = rest.match(/^\/workers\/scripts\/([^/]+)\/assets-upload-session$/);
    if (session && method === 'POST') {
      const { manifest } = (await request.json()) as { manifest: Record<string, { hash: string; size: number }> };
      const needed = [...new Set(Object.values(manifest).map((f) => f.hash))].filter((h) => !this.assets.has(h));
      const jwt = `upload-${++this.seq}`;
      const completion = `complete-${this.seq}`;
      this.sessions.set(jwt, { needed: new Set(needed), completion });
      if (needed.length === 0) {
        this.completionJwts.add(jwt);
        return ok({ jwt, buckets: [] });
      }
      const buckets: string[][] = [];
      for (let i = 0; i < needed.length; i += 2) buckets.push(needed.slice(i, i + 2));
      return ok({ jwt, buckets });
    }

    if (assetUpload && method === 'POST') {
      const jwt = auth.replace(/^Bearer /, '');
      const s = this.sessions.get(jwt);
      if (!s || url.searchParams.get('base64') !== 'true') return fail(401, 'Invalid upload token', 10401);
      const form = await request.formData();
      for (const [hash, value] of form.entries()) {
        if (!s.needed.has(hash)) return fail(400, `Unexpected file ${hash}`);
        const text = typeof value === 'string' ? value : await (value as Blob).text();
        if (!/^[A-Za-z0-9+/=]+$/.test(text)) return fail(400, 'Not base64');
        this.assets.add(hash);
        s.needed.delete(hash);
      }
      if (s.needed.size === 0) {
        this.completionJwts.add(s.completion);
        return ok({ jwt: s.completion }, 201);
      }
      return ok({}, 202);
    }

    return fail(404, `Fake Cloudflare has no ${method} ${path}`);
  }

  private async putScript(name: string, request: Request): Promise<Response> {
    const form = await request.formData();
    const metadata = JSON.parse(String(form.get('metadata')));
    const modules: UploadedScript['modules'] = {};
    for (const [key, value] of form.entries()) {
      if (key === 'metadata') continue;
      const file = value as File;
      modules[key] = { type: file.type, text: await file.text() };
    }
    if (!modules[metadata.main_module]) return fail(400, `No such module "${metadata.main_module}"`, 10021);
    for (const b of metadata.bindings) {
      if (b.type === 'd1' && !this.d1.has(b.id)) return fail(400, `D1 database ${b.id} not found`, 10021);
      if (b.type === 'kv_namespace' && !this.kv.has(b.namespace_id)) return fail(400, `KV namespace ${b.namespace_id} not found`, 10041);
      if (b.type === 'service' && !this.scripts.has(b.service)) return fail(400, `Could not resolve service binding '${b.name}'. Target script '${b.service}' not found.`, 10143);
      if ((b.type === 'plain_text' || b.type === 'secret_text') && typeof b.text !== 'string') return fail(400, `binding ${b.name} needs text`);
    }
    const current = this.migrationTags.get(name);
    if (metadata.migrations) {
      if ((metadata.migrations.old_tag ?? null) !== (current ?? null)) return fail(400, `Migration old_tag ${metadata.migrations.old_tag} does not match the current tag ${current}`, 10079);
      this.migrationTags.set(name, metadata.migrations.new_tag);
    }
    if (metadata.assets && !this.completionJwts.has(metadata.assets.jwt)) return fail(400, 'Invalid assets completion token', 10401);
    this.scripts.set(name, { metadata, modules, order: ++this.uploads });
    return ok({ id: name });
  }
}

// A published release, byte-for-byte what the installer verifies.
export class FakeReleases {
  files = new Map<string, Uint8Array>();
  manifest: any;
  tampered = new Set<string>();
  assetFiles: Record<string, { hash: string; size: number; contentType: string; chunk: string }> = {};

  static async create() {
    const r = new FakeReleases();
    const put = (name: string, value: unknown) => r.files.set(name, enc.encode(typeof value === 'string' ? value : JSON.stringify(value)));
    for (const [name, descriptor] of Object.entries(fixture.workers)) put(`${name}.json`, descriptor);
    put('database.json', fixture.database);
    // Three small assets in two chunks.
    const b64 = (s: string) => btoa(s);
    r.assetFiles = {
      '/admin.html': { hash: 'a'.repeat(32), size: 20, contentType: 'text/html', chunk: 'arcanum-frontends-assets-01.json' },
      '/assets/app.js': { hash: 'b'.repeat(32), size: 30, contentType: 'text/javascript', chunk: 'arcanum-frontends-assets-01.json' },
      '/kassa.html': { hash: 'c'.repeat(32), size: 25, contentType: 'text/html', chunk: 'arcanum-frontends-assets-02.json' },
    };
    put('arcanum-frontends-assets.json', { config: fixture.assets_config, files: r.assetFiles });
    put('arcanum-frontends-assets-01.json', { ['a'.repeat(32)]: b64('<html>admin</html>'), ['b'.repeat(32)]: b64('console.log(1)') });
    put('arcanum-frontends-assets-02.json', { ['c'.repeat(32)]: b64('<html>kassa</html>') });
    put('LICENSE', 'AGPL-3.0-or-later');
    const files: Record<string, { size: number; sha256: string }> = {};
    for (const [name, bytes] of [...r.files].sort()) files[name] = { size: bytes.length, sha256: await sha256(bytes) };
    r.manifest = { format: 'arcanum-release', format_version: 1, version: '0.1.1', released_at: '2026-09-25T12:00:00.000Z', license: 'AGPL-3.0-or-later', components: fixture.components, files };
    return r;
  }

  index() {
    return {
      format: 'arcanum-releases-index',
      latest: null,
      releases: [
        { version: '0.1.1', tag: 'v0.1.1', prerelease: true, released_at: this.manifest.released_at, format_version: 1, manifest_url: `${RELEASE_BASE}/manifest.json`, notes_url: 'https://releases.test/tag/v0.1.1' },
        // An older layout the installer must not offer.
        { version: '0.1.0', tag: 'v0.1.0', prerelease: true, released_at: '2026-09-25T10:00:00.000Z', manifest_url: 'https://releases.test/download/v0.1.0/manifest.json', notes_url: '' },
      ],
    };
  }

  handle(url: URL): Response {
    if (url.href === 'https://releases.test/releases.json') return Response.json(this.index());
    if (url.href === `${RELEASE_BASE}/manifest.json`) return Response.json(this.manifest);
    if (url.href.startsWith(`${RELEASE_BASE}/`)) {
      const name = decodeURIComponent(url.pathname.split('/').pop()!);
      const bytes = this.files.get(name);
      if (!bytes) return new Response('Not found', { status: 404 });
      if (this.tampered.has(name)) return new Response(enc.encode(new TextDecoder().decode(bytes).replace(/.$/, ' ')));
      return new Response(bytes);
    }
    return new Response('Not found', { status: 404 });
  }
}

export interface Fakes {
  cf: FakeCloudflare;
  releases: FakeReleases;
  fetchCalls: () => number;
  // How many more /version checks answer "not yet" before the installation is reachable.
  notReadyYet: { count: number };
}

// Routes every outbound fetch of the Worker under test to the fakes.
export async function installFakes(): Promise<Fakes> {
  const cf = new FakeCloudflare();
  const releases = await FakeReleases.create();
  const notReadyYet = { count: 0 };
  let calls = 0;
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input as RequestInfo, init);
    const url = new URL(request.url);
    if (url.hostname === 'installer.test') return realFetch(input as RequestInfo, init); // SELF
    calls++;
    if (url.hostname === 'cf.test') return cf.handle(request);
    if (url.hostname === 'releases.test') return releases.handle(url);
    if (url.hostname === 'login.test' && url.pathname === '/.well-known/openid-configuration') {
      return Response.json({ issuer: 'https://login.test', authorization_endpoint: 'https://login.test/authorize', token_endpoint: 'https://login.test/token', device_authorization_endpoint: 'https://login.test/device' });
    }
    if (url.hostname === 'nodevice.test') return Response.json({ issuer: 'https://nodevice.test', authorization_endpoint: 'https://nodevice.test/authorize' });
    if (url.origin === PUBLIC_URL) {
      if (!cf.scripts.has('arcanum-bff') || !cf.workersDev.get('arcanum-bff')) return new Response('There is nothing here yet', { status: 404 });
      if (notReadyYet.count > 0) {
        notReadyYet.count--;
        return new Response('not yet', { status: 404 });
      }
      if (url.pathname === '/version') return Response.json({ version: 'x', source_url: 'https://github.com/arcanum-pos' });
      if (url.pathname === '/login') return new Response(null, { status: 302, headers: { Location: 'https://login.test/authorize?client_id=x' } });
    }
    throw new Error(`Unexpected outbound fetch in test: ${request.method} ${request.url}`);
  });
  return { cf, releases, fetchCalls: () => calls, notReadyYet };
}
