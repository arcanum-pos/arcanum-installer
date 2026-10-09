// In-memory stand-ins for everything the installer talks to: the Cloudflare
// API (enforcing the rules the real one has — bindings must point at
// existing resources and already-uploaded Workers, DO migration tags must
// line up, assets need a completion JWT), a published release built from
// the real v0.1.1 descriptors (test/fixtures), a login provider, and the
// installed Arcanum's public address. Installed via vi.spyOn(fetch).
import { vi } from 'vitest';
import fixture from './fixtures/release-0.1.2.json';

export const TOKEN = 'cf-test-token-0123456789abcdefghij';
export const OTHER_ACCOUNT_TOKEN = 'cf-other-account-token-0123456789ab';
export const SUBDOMAIN = 'scouts';
export const PUBLIC_URL = `https://arcanum-bff.${SUBDOMAIN}.workers.dev`;

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
  modules: Record<string, { type: string; text: string; bytes?: number[] }>;
  order: number;
}

export class FakeCloudflare {
  accounts = [{ id: 'acc-1', name: 'Scouts Elewijt' }];
  d1 = new Map<string, { name: string; queries: string[]; params: string[][] }>();
  // Where membership queries really run (see the D1 query handler).
  sqlDb: D1Database | null = null;
  kv = new Map<string, string>(); // id -> title
  scripts = new Map<string, UploadedScript>();
  migrationTags = new Map<string, string>();
  // Durable Object classes exported by each script's deployed version.
  doClasses = new Map<string, Set<string>>();
  // null = the account has no workers.dev subdomain yet (a brand-new account).
  subdomain: string | null = SUBDOMAIN;
  // Zones on the account (Workers Custom Domains must be in one of them) and attached domains.
  zones = ['scouts-elewijt.be'];
  domains = new Map<string, string>(); // hostname -> service
  // Cloudflare Email Service: per zone, its domains onboarded for sending;
  // false = the token lacks the Zone read permissions.
  sendingDomains: Record<string, { name: string; enabled: boolean }[]> = {};
  zoneRead = true;
  workersDev = new Map<string, boolean>();
  assets = new Set<string>(); // uploaded hashes
  sessions = new Map<string, { needed: Set<string>; completion: string }>();
  completionJwts = new Set<string>();
  failures: { match: RegExp; message: string }[] = [];
  // Secrets removed one by one (DELETE …/secrets/:name).
  secretDeletes: { script: string; name: string }[] = [];
  // Secrets set one by one (PUT …/secrets, what `wrangler secret put` does).
  secretPuts: { script: string; name: string; text: string }[] = [];
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
    if (method === 'GET' && path === '/zones') {
      if (!this.zoneRead) return fail(403, 'Unauthorized to access requested resource', 9109);
      if (!accounts.some((acc) => acc.id === url.searchParams.get('account.id'))) return ok([]);
      return ok(this.zones.map((name) => ({ id: `zone-${name}`, name })));
    }
    const sending = path.match(/^\/zones\/zone-([^/]+)\/email\/sending\/subdomains$/);
    if (sending && method === 'GET') return this.zoneRead ? ok(this.sendingDomains[sending[1]] ?? []) : fail(403, 'Unauthorized to access requested resource', 9109);
    const m = path.match(/^\/accounts\/([^/]+)(\/.*)$/);
    if (!m) return fail(404, 'Not found');
    const [, accountId, rest] = m;
    if (!accounts.some((a) => a.id === accountId)) return fail(403, 'Not allowed on this account');

    if (rest === '/workers/subdomain') {
      if (method === 'GET') return this.subdomain ? ok({ subdomain: this.subdomain }) : fail(404, 'This account does not have a workers.dev subdomain', 10007);
      if (method === 'PUT') {
        const { subdomain } = (await request.json()) as { subdomain: string };
        if (this.subdomain) return fail(409, 'A subdomain is already registered for this account', 10036);
        if (subdomain === 'taken') return fail(409, 'This subdomain is not available', 10032);
        this.subdomain = subdomain;
        return ok({ subdomain });
      }
    }

    if (rest === '/d1/database') {
      if (method === 'GET') return ok([...this.d1].filter(([, d]) => !url.searchParams.get('name') || d.name === url.searchParams.get('name')).map(([uuid, d]) => ({ uuid, name: d.name })));
      const { name } = (await request.json()) as { name: string };
      if ([...this.d1.values()].some((d) => d.name === name)) return fail(409, 'A database with that name already exists', 7502);
      const uuid = `d1-${++this.seq}`;
      this.d1.set(uuid, { name, queries: [], params: [] });
      return ok({ uuid, name });
    }
    const q = rest.match(/^\/d1\/database\/([^/]+)\/query$/);
    if (q && method === 'POST') {
      const db = this.d1.get(q[1]);
      if (!db) return fail(404, 'Database not found', 7404);
      const { sql, params } = (await request.json()) as { sql: string; params?: unknown[] };
      db.queries.push(sql);
      if (params !== undefined) {
        // The installer binds params only to a single statement (how the real
        // endpoint combines params with several statements isn't verified).
        if (sql.trim().replace(/;$/, '').includes(';')) return fail(400, 'params with several statements', 7500);
        if (!Array.isArray(params) || params.some((p) => typeof p !== 'string')) return fail(400, 'params must be strings', 7400);
        db.params.push(params as string[]);
      }
      // The backend's memberships (and what they join) live in a real SQLite
      // database (a D1 binding of the test), so the SQL really runs.
      if (this.sqlDb && /\bmemberships\b/.test(sql)) {
        try {
          const result = await this.sqlDb.prepare(sql).bind(...((params as string[]) ?? [])).all();
          return ok([{ success: true, results: result.results, meta: result.meta }]);
        } catch (err) {
          return fail(400, `D1_ERROR: ${(err as Error).message}`, 7500);
        }
      }
      // Enough SQL to answer the installer's questions: which migrations are recorded.
      const count = /SELECT COUNT\(\*\) AS n FROM d1_migrations/i.test(sql);
      if (count || /^SELECT name FROM d1_migrations$/i.test(sql)) {
        const names = [...new Set(db.queries.flatMap((q) => [...q.matchAll(/INSERT OR IGNORE INTO d1_migrations \(name\) VALUES \('([^']+)'\)/g)].map((m) => m[1])))];
        if (!names.length && !db.queries.some((q) => /CREATE TABLE IF NOT EXISTS d1_migrations/i.test(q))) return fail(400, 'D1_ERROR: no such table: d1_migrations: SQLITE_ERROR', 7500);
        return ok([{ success: true, results: count ? [{ n: names.length }] : names.map((name) => ({ name })), meta: {} }]);
      }
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

    if (rest === '/workers/domains' && method === 'PUT') {
      const { hostname, service } = (await request.json()) as { hostname: string; service: string };
      if (!this.scripts.has(service)) return fail(404, 'Worker not found', 10007);
      if (!this.zones.some((z) => hostname === z || hostname.endsWith(`.${z}`))) return fail(400, 'Could not find zone for hostname', 100117);
      const other = this.domains.get(hostname);
      if (other && other !== service) return fail(409, 'Hostname already has externally managed DNS records', 100116);
      this.domains.set(hostname, service);
      return ok({ id: `dom-${hostname}`, hostname, service, environment: 'production' });
    }
    if (rest === '/workers/domains' && method === 'GET') {
      const host = url.searchParams.get('hostname');
      return ok([...this.domains].filter(([h]) => !host || h === host).map(([hostname, service]) => ({ id: `dom-${hostname}`, hostname, service })));
    }

    const svc = rest.match(/^\/workers\/services\/([^/]+)$/);
    if (svc && method === 'GET') {
      if (!this.scripts.has(svc[1])) return fail(404, 'This Worker does not exist on your account.', 10007);
      const tag = this.migrationTags.get(svc[1]);
      return ok({ id: svc[1], default_environment: { script: tag ? { migration_tag: tag } : {} } });
    }

    const script = rest.match(/^\/workers\/scripts\/([^/]+)$/);
    if (script && method === 'PUT') return this.putScript(script[1], request);

    // A script's settings: its bindings, secrets without their values.
    const settings = rest.match(/^\/workers\/scripts\/([^/]+)\/settings$/);
    if (settings && method === 'GET') {
      const s = this.scripts.get(settings[1]);
      if (!s) return fail(404, 'This Worker does not exist on your account.', 10007);
      return ok({ bindings: (s.metadata.bindings ?? []).map((b: any) => (b.type === 'secret_text' ? { type: b.type, name: b.name } : b)), compatibility_date: s.metadata.compatibility_date });
    }
    // One deployment per upload, newest first.
    const deployments = rest.match(/^\/workers\/scripts\/([^/]+)\/deployments$/);
    if (deployments && method === 'GET') {
      const s = this.scripts.get(deployments[1]);
      if (!s) return fail(404, 'This Worker does not exist on your account.', 10007);
      return ok({ deployments: [{ id: `dep-${deployments[1]}-${s.order}`, source: 'api', strategy: 'percentage', versions: [{ version_id: `ver-${deployments[1]}-${s.order}`, percentage: 100 }] }] });
    }
    const secrets = rest.match(/^\/workers\/scripts\/([^/]+)\/secrets$/);
    if (secrets && method === 'PUT') {
      const s = this.scripts.get(secrets[1]);
      if (!s) return fail(404, 'This Worker does not exist on your account.', 10007);
      const { name, text, type } = (await request.json()) as { name: string; text: string; type: string };
      if (type !== 'secret_text' || typeof text !== 'string') return fail(400, 'bad secret');
      this.secretPuts.push({ script: secrets[1], name, text });
      s.metadata.bindings = [...(s.metadata.bindings ?? []).filter((b: any) => b.name !== name), { type: 'secret_text', name, text }];
      return ok({ name, type });
    }

    const secret = rest.match(/^\/workers\/scripts\/([^/]+)\/secrets\/([^/]+)$/);
    if (secret && method === 'DELETE') {
      const s = this.scripts.get(secret[1]);
      if (!s) return fail(404, 'This Worker does not exist on your account.', 10007);
      const name = decodeURIComponent(secret[2]);
      if (!(s.metadata.bindings ?? []).some((b: any) => b.type === 'secret_text' && b.name === name)) return fail(404, 'Secret not found', 10056);
      s.metadata.bindings = s.metadata.bindings.filter((b: any) => b.name !== name);
      this.secretDeletes.push({ script: secret[1], name });
      return ok(null);
    }

    const sub = rest.match(/^\/workers\/scripts\/([^/]+)\/subdomain$/);
    if (sub && method === 'GET') {
      if (!this.scripts.has(sub[1])) return fail(404, 'Worker not found', 10007);
      return ok({ enabled: this.workersDev.get(sub[1]) ?? false, previews_enabled: false });
    }
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
      modules[key] = { type: file.type, text: await file.text(), ...(file.type === 'application/octet-stream' ? { bytes: [...new Uint8Array(await file.arrayBuffer())] } : {}) };
    }
    if (!modules[metadata.main_module]) return fail(400, `No such module "${metadata.main_module}"`, 10021);
    for (const b of metadata.bindings) {
      if (b.type === 'd1' && !this.d1.has(b.id)) return fail(400, `D1 database ${b.id} not found`, 10021);
      if (b.type === 'kv_namespace' && !this.kv.has(b.namespace_id)) return fail(400, `KV namespace ${b.namespace_id} not found`, 10041);
      if (b.type === 'service' && !this.scripts.has(b.service)) return fail(400, `Could not resolve service binding '${b.name}'. Target script '${b.service}' not found.`, 10143);
      if ((b.type === 'plain_text' || b.type === 'secret_text') && typeof b.text !== 'string') return fail(400, `binding ${b.name} needs text`);
    }
    const current = this.migrationTags.get(name);
    let classes = new Set(this.doClasses.get(name) ?? []);
    if (metadata.migrations) {
      if ((metadata.migrations.old_tag ?? null) !== (current ?? null)) return fail(400, `Migration old_tag ${metadata.migrations.old_tag} does not match the current tag ${current}`, 10079);
      // Like the real API: deletes and renames are checked against the
      // classes the *previously deployed* version exported — not against
      // earlier steps in the same upload.
      const previous = this.doClasses.get(name) ?? new Set<string>();
      for (const step of metadata.migrations.steps ?? []) {
        for (const c of step.deleted_classes ?? []) {
          if (!previous.has(c)) return fail(400, `Cannot apply delete-class migration to class '${c}' which was not exported in the previous version of the script`, 10074);
          classes.delete(c);
        }
        for (const r of step.renamed_classes ?? []) {
          if (!previous.has(r.from)) return fail(400, `Cannot apply rename-class migration to class '${r.from}' which was not exported in the previous version of the script`, 10074);
          classes.delete(r.from);
          classes.add(r.to);
        }
        for (const c of [...(step.new_classes ?? []), ...(step.new_sqlite_classes ?? [])]) classes.add(c);
      }
      this.migrationTags.set(name, metadata.migrations.new_tag);
    }
    this.doClasses.set(name, classes);
    if (metadata.assets && !this.completionJwts.has(metadata.assets.jwt)) return fail(400, 'Invalid assets completion token', 10401);
    // Like Cloudflare: a secret the new upload doesn't mention stays on the Worker.
    const sent = new Set((metadata.bindings ?? []).map((b: any) => b.name));
    const kept = (this.scripts.get(name)?.metadata.bindings ?? []).filter((b: any) => b.type === 'secret_text' && !sent.has(b.name));
    metadata.bindings = [...(metadata.bindings ?? []), ...kept];
    this.scripts.set(name, { metadata, modules, order: ++this.uploads });
    return ok({ id: name });
  }
}

// A published release, byte-for-byte what the installer verifies: 0.1.1
// (the real descriptors of test/fixtures) and, once `offerUpdate` is set,
// 0.1.3 — the same plus what an update has to handle: a bff that can
// forward /installer/*, and one new backend migration.
export const NEXT_VERSION = '0.1.3';
// A release that also carries the installer (manifest.installer).
export const SELF_UPDATE_VERSION = '0.1.4';
// A development build (releases-dev.json only), newer than everything above.
export const DEV_VERSION = '0.1.5-dev.2';
export const NEXT_MIGRATION = { name: '0018_update_test.sql', sql: 'ALTER TABLE tabs ADD COLUMN update_test TEXT' };
const releaseBase = (version: string) => `https://releases.test/download/v${version}`;

interface Published {
  files: Map<string, Uint8Array>;
  manifest: any;
}

export class FakeReleases {
  versions = new Map<string, Published>();
  tampered = new Set<string>();
  offerUpdate = false;
  offerSelfUpdate = false;
  // The fetch cache mode of every releases.json request.
  indexCacheModes: (RequestInit['cache'] | undefined)[] = [];
  assetFiles: Record<string, { hash: string; size: number; contentType: string; chunk: string }> = {};

  get files() {
    return this.versions.get('0.1.1')!.files;
  }
  get manifest() {
    return this.versions.get('0.1.1')!.manifest;
  }

  static async create() {
    const r = new FakeReleases();
    // Three small assets in two chunks.
    r.assetFiles = {
      '/admin.html': { hash: 'a'.repeat(32), size: 20, contentType: 'text/html', chunk: 'arcanum-frontends-assets-01.json' },
      '/assets/app.js': { hash: 'b'.repeat(32), size: 30, contentType: 'text/javascript', chunk: 'arcanum-frontends-assets-01.json' },
      '/kassa.html': { hash: 'c'.repeat(32), size: 25, contentType: 'text/html', chunk: 'arcanum-frontends-assets-02.json' },
      // The real build's hashed logo — what the setup page loads to see the installation is live.
      [fixture.asset_paths_sample[0]]: { hash: 'd'.repeat(32), size: 30111, contentType: 'image/png', chunk: 'arcanum-frontends-assets-02.json' },
    };
    r.versions.set('0.1.1', await r.publish('0.1.1', fixture.workers, fixture.database));
    const workers = structuredClone(fixture.workers) as any;
    workers['arcanum-bff'].env.INSTALLER_INTERNAL_KEY = { kind: 'secret', source: 'optional' };
    workers['arcanum-bff'].env.ARCANUM_VERSION = { kind: 'var', source: 'optional' };
    // The login provider, the bff's own too (it no longer asks the backend).
    Object.assign(workers['arcanum-bff'].env, {
      DEFAULT_IDP_ISSUER_URL: { kind: 'secret', source: 'install', question: 'login.issuer' },
      DEFAULT_IDP_CLIENT_ID: { kind: 'secret', source: 'install', question: 'login.clientId' },
      DEFAULT_IDP_CLIENT_SECRET: { kind: 'secret', source: 'install', question: 'login.clientSecret' },
      DEFAULT_IDP_SCOPES: { kind: 'secret', source: 'optional' },
      DEFAULT_IDP_AUTH_CODE_CLIENT_ID: { kind: 'secret', source: 'optional' },
      DEFAULT_IDP_AUTH_CODE_CLIENT_SECRET: { kind: 'secret', source: 'optional' },
    });
    const database = structuredClone(fixture.database) as any;
    const backend = database.databases.find((d: any) => d.name === 'arcanum-backend');
    backend.migrations.push(NEXT_MIGRATION);
    backend.schema += `\nINSERT OR IGNORE INTO d1_migrations (name) VALUES ('${NEXT_MIGRATION.name}');\n`;
    r.versions.set(NEXT_VERSION, await r.publish(NEXT_VERSION, workers, database));
    r.versions.set(SELF_UPDATE_VERSION, await r.publish(SELF_UPDATE_VERSION, workers, database, INSTALLER_ARTIFACT));
    r.versions.set(DEV_VERSION, await r.publish(DEV_VERSION, workers, database));
    return r;
  }

  private async publish(version: string, workers: Record<string, unknown>, database: unknown, installer?: unknown): Promise<Published> {
    const files = new Map<string, Uint8Array>();
    const put = (name: string, value: unknown) => files.set(name, enc.encode(typeof value === 'string' ? value : JSON.stringify(value)));
    for (const [name, descriptor] of Object.entries(workers)) put(`${name}.json`, descriptor);
    put('database.json', database);
    const b64 = (s: string) => btoa(s);
    put('arcanum-frontends-assets.json', { config: fixture.assets_config, files: this.assetFiles });
    put('arcanum-frontends-assets-01.json', { ['a'.repeat(32)]: b64('<html>admin</html>'), ['b'.repeat(32)]: b64('console.log(1)') });
    put('arcanum-frontends-assets-02.json', { ['c'.repeat(32)]: b64('<html>kassa</html>'), ['d'.repeat(32)]: b64('PNG') });
    put('LICENSE', 'AGPL-3.0-or-later');
    if (installer) put('arcanum-installer.json', installer);
    const sums: Record<string, { size: number; sha256: string }> = {};
    for (const [name, bytes] of [...files].sort()) sums[name] = { size: bytes.length, sha256: await sha256(bytes) };
    const manifest: any = { format: 'arcanum-release', format_version: 1, version, released_at: '2026-09-25T12:00:00.000Z', license: 'AGPL-3.0-or-later', components: fixture.components, files: sums };
    if (installer) manifest.installer = { file: 'arcanum-installer.json', commit: 'c0ffee0000000000000000000000000000000000', sha256: sums['arcanum-installer.json'].sha256 };
    return { files, manifest };
  }

  index() {
    const entry = (version: string) => ({ version, tag: `v${version}`, prerelease: true, released_at: '2026-09-25T12:00:00.000Z', format_version: 1, manifest_url: `${releaseBase(version)}/manifest.json`, notes_url: `https://releases.test/tag/v${version}` });
    return {
      format: 'arcanum-releases-index',
      latest: null,
      releases: [
        ...(this.offerSelfUpdate ? [entry(SELF_UPDATE_VERSION)] : []),
        ...(this.offerUpdate ? [entry(NEXT_VERSION)] : []),
        entry('0.1.1'),
        // An older layout the installer must not offer.
        { version: '0.1.0', tag: 'v0.1.0', prerelease: true, released_at: '2026-09-25T10:00:00.000Z', manifest_url: 'https://releases.test/download/v0.1.0/manifest.json', notes_url: '' },
      ],
    };
  }

  handle(url: URL): Response {
    if (url.href === 'https://releases.test/releases.json') return Response.json(this.index());
    if (url.href === 'https://releases.test/releases-dev.json') {
      const entry = (version: string) => ({ version, tag: `v${version}`, prerelease: true, released_at: '2026-09-26T12:00:00.000Z', format_version: 1, manifest_url: `${releaseBase(version)}/manifest.json`, notes_url: '' });
      return Response.json({ format: 'arcanum-releases-index', latest: null, releases: [entry(DEV_VERSION), entry('0.1.5-dev.1')] });
    }
    for (const [version, published] of this.versions) {
      const base = releaseBase(version);
      if (url.href === `${base}/manifest.json`) return Response.json(published.manifest);
      if (url.href.startsWith(`${base}/`)) {
        const name = decodeURIComponent(url.pathname.split('/').pop()!);
        const bytes = published.files.get(name);
        if (!bytes) return new Response('Not found', { status: 404 });
        if (this.tampered.has(name)) return new Response(enc.encode(new TextDecoder().decode(bytes).replace(/.$/, ' ')));
        return new Response(bytes);
      }
    }
    return new Response('Not found', { status: 404 });
  }
}

// The installer as a release carries it (arcanum-releases arcanum-installer.json):
// the shape build-release.mjs writes, with a stub for its code and a tiny
// "logo" as a Data module.
export const INSTALLER_LOGO = [0x89, 0x50, 0x4e, 0x47, 0x00, 0xff];
export const INSTALLER_ARTIFACT = {
  name: 'arcanum-installer',
  compatibility_date: '2026-09-11',
  compatibility_flags: [],
  public_entry: false,
  observability: { enabled: true },
  bindings: [{ type: 'kv_namespace', name: 'INSTALLER_STATE', namespace: 'arcanum-installer:INSTALLER_STATE' }],
  durable_object_migrations: [],
  assets: null,
  env: {
    RELEASES_INDEX_URL: { kind: 'var', source: 'fixed', value: 'https://releases.test/releases.json' },
    INSTALLER_RELEASE: { kind: 'var', source: 'release_version' },
    INSTALLER_PASSWORD: { kind: 'secret', source: 'keep' },
    INSTALLER_STATE_KEY: { kind: 'secret', source: 'bootstrap' },
    BOOTSTRAP_CONFIG: { kind: 'secret', source: 'bootstrap' },
  },
  main_module: 'index.js',
  modules: [
    { name: 'index.js', type: 'esm', content: '// arcanum-installer (test stub)\nimport logo from "./abc-kabouter.png";\nexport default { fetch() { return new Response(logo); } };\n' },
    { name: 'abc-kabouter.png', type: 'data', base64: btoa(String.fromCharCode(...INSTALLER_LOGO)) },
  ],
};

// The login provider the bootstrapper hands over (login.test stands in for
// login.kaboutersoft.be) and this installation's own client there.
export const INSTANCE_CLIENT = { id: 'arc_instance', secret: 'instance-client-secret-value-xyz' };

// A login provider's clients, by host: `device` clients can do the kassa's
// device login, `web` clients only browser login (Google's two types).
export const PROVIDER_CLIENTS: Record<string, Record<string, { secret: string; type: 'device' | 'web' }>> = {
  'login.test': { 'arcanum-client': { secret: 'idp-client-secret-value-xyz', type: 'device' }, [INSTANCE_CLIENT.id]: { secret: INSTANCE_CLIENT.secret, type: 'device' } },
  // Another provider to change to ("Aanmelding wijzigen").
  'nieuw.test': { 'nieuw-client': { secret: 'nieuw-client-secret-value', type: 'device' } },
  'accounts.google.com': {
    'tv-client.apps.googleusercontent.com': { secret: 'tv-secret-value-123', type: 'device' },
    'web-client.apps.googleusercontent.com': { secret: 'web-secret-value-456', type: 'web' },
  },
};

// The provider's device and token endpoints, answering like real ones do.
async function providerEndpoint(host: string, kind: 'device' | 'token', request: Request, broken: { value: boolean }): Promise<Response> {
  if (broken.value) return new Response('upstream error', { status: 503 });
  const form = new URLSearchParams(await request.text());
  const clients = PROVIDER_CLIENTS[host] ?? {};
  const client = clients[form.get('client_id') ?? ''];
  const error = (status: number, code: string, description = code) => Response.json({ error: code, error_description: description }, { status });
  if (!client) return error(401, 'invalid_client', 'The OAuth client was not found.');
  if (kind === 'device') {
    if (client.type !== 'device') return error(401, 'invalid_client', 'Invalid client type.');
    if (host === 'accounts.google.com' && (form.get('scope') ?? '').split(' ').includes('offline_access')) return error(400, 'invalid_scope', 'Some requested scopes were invalid.');
    return Response.json({ device_code: 'dc-123', user_code: 'ABCD-EFGH', verification_uri: `https://${host}/device`, expires_in: 1800, interval: 5 });
  }
  if (form.get('client_secret') !== client.secret) return error(401, 'invalid_client', 'Unauthorized');
  if (form.get('grant_type') === 'urn:ietf:params:oauth:grant-type:device_code') return error(428, 'authorization_pending', 'Precondition Required');
  if (form.get('grant_type') === 'authorization_code') return error(400, 'invalid_grant', 'Malformed auth code.');
  return error(400, 'unsupported_grant_type');
}

// The provider's side of a browser sign-in (authorization code + PKCE) and
// of client self-service (arcanum-auth /clients/self).
export class FakeIssuer {
  // Codes the test "approved" at /authorize, with who signed in.
  codes = new Map<string, { challenge: string; redirectUri: string; clientId: string; claims: Record<string, unknown> }>();
  tokenRequests: Record<string, string>[] = [];
  client = { redirect_uris: [`${PUBLIC_URL}/callback`, `https://arcanum-installer.${SUBDOMAIN}.workers.dev/auth/callback`], post_logout_redirect_uris: [PUBLIC_URL] };
  selfCalls: { method: string; auth: string | null; body: any }[] = [];

  constructor(readonly host = 'login.test') {}

  // What the test does in the browser: sign in at the provider, which redirects back with a code.
  approve(authorizeUrl: string, claims: Record<string, unknown>): string {
    const u = new URL(authorizeUrl);
    if (u.host !== this.host) throw new Error(`${authorizeUrl} is not at ${this.host}`);
    const code = `code-${this.host}-${this.codes.size + 1}`;
    this.codes.set(code, { challenge: u.searchParams.get('code_challenge')!, redirectUri: u.searchParams.get('redirect_uri')!, clientId: u.searchParams.get('client_id')!, claims: { iss: `https://${this.host}`, aud: u.searchParams.get('client_id'), nonce: u.searchParams.get('nonce'), ...claims } });
    return code;
  }

  async token(form: URLSearchParams): Promise<Response | null> {
    if (form.get('grant_type') !== 'authorization_code' || !this.codes.has(form.get('code') ?? '')) return null;
    this.tokenRequests.push(Object.fromEntries(form));
    const grant = this.codes.get(form.get('code')!)!;
    this.codes.delete(form.get('code')!);
    const client = PROVIDER_CLIENTS[this.host][form.get('client_id') ?? ''];
    const challenge = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(form.get('code_verifier') ?? '')))))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    if (!client || client.secret !== form.get('client_secret') || grant.clientId !== form.get('client_id')) return Response.json({ error: 'invalid_client' }, { status: 401 });
    if (grant.redirectUri !== form.get('redirect_uri') || grant.challenge !== challenge) return Response.json({ error: 'invalid_grant' }, { status: 400 });
    const part = (o: object) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return Response.json({ access_token: 'at', token_type: 'Bearer', id_token: `${part({ alg: 'RS256' })}.${part(grant.claims)}.sig` });
  }

  async clientsSelf(request: Request): Promise<Response> {
    const auth = request.headers.get('Authorization');
    const body = request.method === 'PATCH' ? await request.json() : null;
    this.selfCalls.push({ method: request.method, auth, body });
    const [id, secret] = atob((auth ?? '').replace(/^Basic /, '')).split(':').map(decodeURIComponent);
    if (id !== INSTANCE_CLIENT.id || secret !== INSTANCE_CLIENT.secret) return Response.json({ error: 'invalid_client' }, { status: 401 });
    if (request.method === 'PATCH') this.client = { ...this.client, ...(body as object) };
    return Response.json({ client_id: id, name: 'Arcanum', ...this.client });
  }
}

export interface Fakes {
  cf: FakeCloudflare;
  releases: FakeReleases;
  issuer: FakeIssuer;
  // The provider an installation changes to (nieuw.test).
  newIssuer: FakeIssuer;
  // Hosts that don't answer at all (a provider that's gone).
  unreachable: Set<string>;
  fetchCalls: () => number;
  // Fetches the installer made to the installation's own workers.dev URL.
  publicUrlFetches: () => number;
  // Makes the provider's device/token endpoints answer 503 (an outage, not a refusal).
  providerBroken: { value: boolean };
}

// Routes every outbound fetch of the Worker under test to the fakes.
export async function installFakes(): Promise<Fakes> {
  const cf = new FakeCloudflare();
  const releases = await FakeReleases.create();
  const issuer = new FakeIssuer();
  const newIssuer = new FakeIssuer('nieuw.test');
  const issuers: Record<string, FakeIssuer> = { 'login.test': issuer, 'nieuw.test': newIssuer };
  const unreachable = new Set<string>();
  let calls = 0;
  let publicFetches = 0;
  const providerBroken = { value: false };
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input as RequestInfo, init);
    const url = new URL(request.url);
    if (url.hostname === 'installer.test') return realFetch(input as RequestInfo, init); // SELF
    calls++;
    if (url.hostname === 'cf.test') return cf.handle(request);
    if (url.hostname === 'releases.test') {
      if (url.pathname === '/releases.json') releases.indexCacheModes.push(request.cache);
      return releases.handle(url);
    }
    if (unreachable.has(url.hostname)) throw new TypeError(`fetch failed: ${url.hostname} unreachable`);
    const own = issuers[url.hostname];
    if (url.hostname === 'login.test' && url.pathname === '/clients/self') return issuer.clientsSelf(request);
    if (own && url.pathname === '/token') {
      const answer = await own.token(new URLSearchParams(await request.clone().text()));
      if (answer) return answer;
    }
    if ((own && (url.pathname === '/device' || url.pathname === '/token')) || (url.hostname === 'oauth2.googleapis.com' && (url.pathname === '/device/code' || url.pathname === '/token'))) {
      const host = url.hostname === 'oauth2.googleapis.com' ? 'accounts.google.com' : url.hostname;
      return providerEndpoint(host, url.pathname.includes('device') ? 'device' : 'token', request, providerBroken);
    }
    if (own && url.pathname === '/.well-known/openid-configuration') {
      const base = `https://${url.hostname}`;
      return Response.json({ issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, device_authorization_endpoint: `${base}/device` });
    }
    if (url.href === 'https://accounts.google.com/.well-known/openid-configuration') {
      return Response.json({ issuer: 'https://accounts.google.com', authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth', token_endpoint: 'https://oauth2.googleapis.com/token', device_authorization_endpoint: 'https://oauth2.googleapis.com/device/code' });
    }
    if (url.hostname === 'nodevice.test') return Response.json({ issuer: 'https://nodevice.test', authorization_endpoint: 'https://nodevice.test/authorize' });
    if (url.origin === PUBLIC_URL) {
      // Like the real Cloudflare: a Worker can't fetch another Worker of the
      // same account through its workers.dev URL (error 1042) — it gets a
      // 404, even though a browser loads the same URL fine.
      publicFetches++;
      return new Response('error code: 1042', { status: 404 });
    }
    throw new Error(`Unexpected outbound fetch in test: ${request.method} ${request.url}`);
  });
  return { cf, releases, issuer, newIssuer, unreachable, fetchCalls: () => calls, publicUrlFetches: () => publicFetches, providerBroken };
}
