// The install as a list of small, idempotent steps, run one per request by
// the setup page. One request per step keeps every step far inside the
// Workers Free plan's limits (50 subrequests, ~10 ms CPU): at most a few
// Cloudflare API calls and one release file each. Every step can be re-run
// safely, so a failed or interrupted install simply continues.
import type { Env } from './env';
import { Cloudflare } from './cloudflare';
import { generateSecret, randomBytes } from './crypto';
import { secretsNeeded, uploadMetadata, type InstallContext, type WorkerDescriptor } from './contract';
import { fetchReleaseJson, type Manifest } from './releases';
import { publicUrl, sealValue, unsealValue, type Blueprint, type InstallerState } from './state';

export interface StepDef {
  id: string;
  title: string;
}

export function planSteps(blueprint: Blueprint): StepDef[] {
  const steps: StepDef[] = [{ id: 'secrets', title: 'Geheime sleutels aanmaken' }];
  for (const db of blueprint.databases) steps.push({ id: `d1:${db.name}`, title: `Database ${db.name} aanmaken` });
  for (const ns of blueprint.kv) steps.push({ id: `kv:${ns}`, title: `Opslag ${ns.split(':').pop()} aanmaken` });
  for (const db of blueprint.databases) steps.push({ id: `schema:${db.name}`, title: `Database ${db.name} inrichten` });
  for (const w of blueprint.workers) {
    if (w.assets) {
      steps.push({ id: 'assets:session', title: 'Schermen voorbereiden' });
      blueprint.assetChunks.forEach((chunk, i) => steps.push({ id: `assets:${chunk}`, title: `Schermen uploaden (${i + 1}/${blueprint.assetChunks.length})` }));
    }
    steps.push({ id: `worker:${w.name}`, title: `${w.name} installeren` });
  }
  steps.push({ id: 'verify', title: 'Controleren of alles werkt' });
  return steps;
}

// Built once when a release is chosen, from its descriptors (not their code).
export function blueprintFrom(manifest: Manifest, descriptors: WorkerDescriptor[], database: { databases: { name: string; tracked: boolean }[] }): Blueprint {
  const order = Object.keys(manifest.components);
  const byName = new Map(descriptors.map((d) => [d.name, d]));
  const seen = new Set<string>();
  const workers: Blueprint['workers'] = [];
  for (const name of order) {
    const d = byName.get(name);
    if (!d) throw new Error(`Release mist ${name}.json`);
    for (const b of d.bindings) if (b.type === 'service' && !seen.has(b.service)) throw new Error(`${name} verwijst naar ${b.service}, dat nog niet geïnstalleerd is`);
    seen.add(name);
    workers.push({ name, public_entry: d.public_entry, assets: !!d.assets, file: `${name}.json` });
  }
  if (workers.filter((w) => w.public_entry).length !== 1) throw new Error('Release heeft geen (of meer dan één) publieke Worker');
  const kv = [...new Set(descriptors.flatMap((d) => d.bindings.filter((b) => b.type === 'kv_namespace').map((b) => (b as { namespace: string }).namespace)))];
  const assetWorker = workers.find((w) => w.assets);
  const assetManifest = assetWorker ? `${assetWorker.name}-assets.json` : null;
  const assetChunks = assetWorker ? Object.keys(manifest.files).filter((f) => f.startsWith(`${assetWorker.name}-assets-`)).sort() : [];
  return { workers, databases: database.databases.map((d) => ({ name: d.name, tracked: d.tracked })), kv, assetManifest, assetChunks };
}

export interface StepContext {
  env: Env;
  state: InstallerState;
  cf: Cloudflare;
}

export type StepOutcome = { status: 'done' | 'retry'; detail?: string };

const ASSET_SESSION_MAX_AGE_MS = 50 * 60 * 1000; // upload JWTs are valid for an hour

async function secretsOf(ctx: StepContext): Promise<Record<string, string>> {
  return ctx.state.secrets ? JSON.parse(await unsealValue(ctx.env, ctx.state, ctx.state.secrets)) : {};
}

async function answersOf(ctx: StepContext): Promise<Record<string, string>> {
  const login = ctx.state.login!;
  return {
    'login.issuer': login.issuer,
    'login.clientId': login.clientId,
    'login.clientSecret': await unsealValue(ctx.env, ctx.state, login.clientSecret),
    admins: ctx.state.admins ?? '',
  };
}

export async function runStep(id: string, ctx: StepContext): Promise<StepOutcome> {
  const { state, cf } = ctx;
  const release = state.release!;
  const accountId = state.cloudflare!.accountId;

  if (id === 'secrets') {
    // Generated once, never regenerated: ENCRYPTION_KEY in particular must
    // never change after install.
    const existing = await secretsOf(ctx);
    const needed = secretsNeeded(await Promise.all(release.blueprint.workers.map((w) => fetchReleaseJson<WorkerDescriptor>(release.manifestUrl, release.manifest, w.file))));
    let added = 0;
    for (const [name, format] of Object.entries(needed)) {
      if (!existing[name]) {
        existing[name] = generateSecret(format);
        added++;
      }
    }
    state.secrets = await sealValue(ctx.env, state, JSON.stringify(existing));
    // Any number that's unique within the account; 1000–9999 stays clear of hand-picked ids like 1001/1002.
    state.resources.ratelimitNamespaceId ??= String(1000 + (new DataView(randomBytes(2).buffer).getUint16(0) % 9000));
    return { status: 'done', detail: `${added} nieuw, ${Object.keys(existing).length} in totaal` };
  }

  if (id.startsWith('d1:')) {
    const name = id.slice(3);
    if (state.resources.d1[name]) return { status: 'done', detail: 'bestaat al' };
    const found = await cf.findD1(accountId, name);
    state.resources.d1[name] = found ?? (await cf.createD1(accountId, name));
    return { status: 'done', detail: found ? 'bestond al, wordt gebruikt' : 'aangemaakt' };
  }

  if (id.startsWith('kv:')) {
    const ns = id.slice(3);
    if (state.resources.kv[ns]) return { status: 'done', detail: 'bestaat al' };
    const title = ns.replace(':', '-');
    const found = await cf.findKv(accountId, title);
    state.resources.kv[ns] = found ?? (await cf.createKv(accountId, title));
    return { status: 'done', detail: found ? 'bestond al, wordt gebruikt' : 'aangemaakt' };
  }

  if (id.startsWith('schema:')) {
    // schema.sql is idempotent (IF NOT EXISTS / INSERT OR IGNORE) and marks
    // every tracked migration as applied for a fresh database.
    const name = id.slice(7);
    const dbId = state.resources.d1[name];
    if (!dbId) throw new Error(`Database ${name} bestaat nog niet`);
    const database = await fetchReleaseJson<{ databases: { name: string; schema: string }[] }>(release.manifestUrl, release.manifest, 'database.json');
    const schema = database.databases.find((d) => d.name === name)?.schema;
    if (!schema) throw new Error(`Geen schema voor ${name} in de release`);
    await cf.queryD1(accountId, dbId, schema);
    return { status: 'done' };
  }

  if (id === 'assets:session') {
    const assetWorker = release.blueprint.workers.find((w) => w.assets)!;
    const manifest = await fetchReleaseJson<{ files: Record<string, { hash: string; size: number }> }>(release.manifestUrl, release.manifest, release.blueprint.assetManifest!);
    const paths = Object.keys(manifest.files);
    state.probePath = paths.find((p) => /^\/assets\/kabouter[^/]*\.png$/.test(p)) ?? paths.find((p) => /^\/assets\/.*\.(png|svg)$/.test(p));
    const session = await cf.assetsUploadSession(
      accountId,
      assetWorker.name,
      Object.fromEntries(Object.entries(manifest.files).map(([path, f]) => [path, { hash: f.hash, size: f.size }]))
    );
    const needed = (session.buckets ?? []).flat();
    state.assets = { jwt: session.jwt, needed, startedAt: new Date().toISOString(), ...(needed.length === 0 ? { completionJwt: session.jwt } : {}) };
    return { status: 'done', detail: needed.length === 0 ? 'alle bestanden staan er al' : `${needed.length} bestanden te uploaden` };
  }

  if (id.startsWith('assets:')) {
    const chunk = id.slice(7);
    const assets = state.assets;
    if (!assets) throw new Error('Start eerst "Schermen voorbereiden"');
    if (Date.now() - Date.parse(assets.startedAt) > ASSET_SESSION_MAX_AGE_MS) throw new Error('De uploadsessie is verlopen — voer "Schermen voorbereiden" opnieuw uit');
    if (assets.completionJwt || assets.needed.length === 0) return { status: 'done', detail: 'niets meer te uploaden' };
    const manifest = await fetchReleaseJson<{ files: Record<string, { hash: string; contentType: string; chunk: string }> }>(release.manifestUrl, release.manifest, release.blueprint.assetManifest!);
    const inChunk = new Map(Object.values(manifest.files).filter((f) => f.chunk === chunk).map((f) => [f.hash, f.contentType]));
    const todo = assets.needed.filter((h) => inChunk.has(h));
    if (todo.length === 0) return { status: 'done', detail: 'niets in dit deel' };
    const contents = await fetchReleaseJson<Record<string, string>>(release.manifestUrl, release.manifest, chunk);
    const result = await cf.uploadAssets(
      accountId,
      assets.jwt,
      todo.map((hash) => ({ hash, base64: contents[hash], contentType: inChunk.get(hash)! }))
    );
    assets.needed = assets.needed.filter((h) => !todo.includes(h));
    if (result?.jwt && assets.needed.length === 0) assets.completionJwt = result.jwt;
    return { status: 'done', detail: `${todo.length} bestanden` };
  }

  if (id.startsWith('worker:')) {
    const name = id.slice(7);
    const worker = release.blueprint.workers.find((w) => w.name === name);
    if (!worker) throw new Error(`${name} hoort niet bij deze release`);
    const descriptor = await fetchReleaseJson<WorkerDescriptor>(release.manifestUrl, release.manifest, worker.file);
    const url = publicUrl(state)!;
    const context: InstallContext = {
      publicUrl: url,
      issuerUrl: state.login!.issuer,
      answers: await answersOf(ctx),
      optional: {
        // AGPL §13: where users find the source of exactly what runs here.
        SOURCE_URL: `https://github.com/arcanum-pos/arcanum-releases/releases/tag/v${release.version}`,
        GIT_COMMIT_SHA: release.manifest.components[name]?.commit ?? '',
        ...(state.login?.connectionName ? { DEFAULT_IDP_CONNECTION_NAME: state.login.connectionName } : {}),
      },
      secrets: await secretsOf(ctx),
      resources: { d1: state.resources.d1, kv: state.resources.kv, ratelimitNamespaceId: state.resources.ratelimitNamespaceId! },
      currentMigrationTag: descriptor.durable_object_migrations.length ? await cf.getMigrationTag(accountId, name) : null,
      assetsJwt: worker.assets ? state.assets?.completionJwt : undefined,
    };
    if (worker.assets && !context.assetsJwt) throw new Error('De schermen zijn nog niet volledig geüpload');
    await cf.uploadScript(accountId, name, uploadMetadata(descriptor, context), descriptor.modules ?? []);
    // Only the public entry gets a workers.dev address; everything else is
    // reachable solely through service bindings.
    await cf.setWorkersDev(accountId, name, worker.public_entry);
    return { status: 'done', detail: worker.public_entry ? url : 'intern (geen publiek adres)' };
  }

  if (id === 'verify') {
    // Through the Cloudflare API only: a Worker can't fetch another Worker
    // of the same account via its workers.dev URL (Cloudflare error 1042,
    // seen as a 404) — the setup page checks it's live from the browser.
    const missing: string[] = [];
    for (const w of release.blueprint.workers) if (!(await cf.scriptExists(accountId, w.name))) missing.push(w.name);
    if (missing.length) throw new Error(`Ontbreekt nog: ${missing.join(', ')}`);
    const entry = release.blueprint.workers.find((w) => w.public_entry)!;
    if (!(await cf.isOnWorkersDev(accountId, entry.name))) throw new Error(`${entry.name} staat niet op workers.dev — het publieke adres is uitgeschakeld`);
    const database = await fetchReleaseJson<{ databases: { name: string; tracked: boolean; migrations: unknown[] }[] }>(release.manifestUrl, release.manifest, 'database.json');
    for (const db of database.databases.filter((d) => d.tracked)) {
      const redo = `voer "Database ${db.name} inrichten" opnieuw uit`;
      const result = (await cf.queryD1(accountId, state.resources.d1[db.name], 'SELECT COUNT(*) AS n FROM d1_migrations').catch(() => {
        throw new Error(`Database ${db.name} is nog niet ingericht (geen migraties gevonden) — ${redo}`);
      })) as { results?: { n: number }[] }[];
      const recorded = result?.[0]?.results?.[0]?.n ?? 0;
      if (recorded < db.migrations.length) throw new Error(`Database ${db.name} heeft ${recorded} van de ${db.migrations.length} migraties — voer "Database ${db.name} inrichten" opnieuw uit`);
    }
    state.installed = { version: release.version, at: new Date().toISOString() };
    return { status: 'done', detail: `${release.blueprint.workers.length} Workers, publiek adres en databases in orde` };
  }

  throw new Error(`Onbekende stap ${id}`);
}
