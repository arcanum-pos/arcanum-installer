// The install as a list of small, idempotent steps, run one per request by
// the setup page. One request per step keeps every step far inside the
// Workers Free plan's limits (50 subrequests, ~10 ms CPU): at most a few
// Cloudflare API calls and one release file each. Every step can be re-run
// safely, so a failed or interrupted install simply continues.
import type { Env } from './env';
import { Cloudflare, CloudflareError } from './cloudflare';
import { generateSecret, randomBytes } from './crypto';
import { installerUploadMetadata, secretsNeeded, uploadMetadata, type InstallContext, type WorkerDescriptor } from './contract';
import { fetchReleaseJson, type Manifest } from './releases';
import { addClientUris } from './auth-client';
import { directShouldClose, INSTALLER_KEY_SECRET, publicUrl, sealValue, unsealValue, type Blueprint, type InstallerState } from './state';
import { messageOf, type Messages } from './i18n';

export interface StepDef {
  id: string;
  title: string;
}

// A bootstrapped installation on its own domain: that domain's callback and
// logout URL are added to its client at the login provider (auth-client.ts).
// Not after "Aanmelding wijzigen" moved the sign-in to another provider.
export const needsClientUris = (state: InstallerState) => !!state.bootstrap?.login && state.bootstrap.login.selfService !== false && !!state.customDomain;

// The titles in the request's language: they're worded for every status, never stored.
export function planSteps(blueprint: Blueprint, state: InstallerState | undefined, t: Messages): StepDef[] {
  const s = t.steps;
  const steps: StepDef[] = [];
  // An update with a newer installer: that one first, over this one — the
  // installer that knows the new release is the one applying it.
  if (blueprint.installer) steps.push({ id: 'installer:self', title: s.selfUpdate });
  steps.push({ id: 'secrets', title: s.secrets });
  for (const db of blueprint.databases) steps.push({ id: `d1:${db.name}`, title: s.d1(db.name) });
  for (const ns of blueprint.kv) steps.push({ id: `kv:${ns}`, title: s.kv(ns.split(':').pop()!) });
  for (const db of blueprint.databases) steps.push({ id: `schema:${db.name}`, title: s.schema(db.name) });
  for (const w of blueprint.workers) {
    if (w.assets) {
      steps.push({ id: 'assets:session', title: s.assetsSession });
      blueprint.assetChunks.forEach((chunk, i) => steps.push({ id: `assets:${chunk}`, title: s.assetsUpload(i + 1, blueprint.assetChunks.length) }));
    }
    steps.push({ id: `worker:${w.name}`, title: s.worker(w.name) });
    if (w.name === 'arcanum-backend' && blueprint.databases.some((d) => d.name === 'arcanum-backend')) {
      steps.push({ id: 'login:reset', title: s.loginReset });
    }
    if (w.public_entry && state && needsClientUris(state)) steps.push({ id: 'login:uris', title: s.loginUris(state.customDomain!) });
  }
  steps.push({ id: 'verify', title: s.verify });
  return steps;
}

// Built once when a release is chosen, from its descriptors (not their code).
export function blueprintFrom(manifest: Manifest, descriptors: WorkerDescriptor[], database: { databases: { name: string; tracked: boolean }[] }, t: Messages): Blueprint {
  const order = Object.keys(manifest.components);
  const byName = new Map(descriptors.map((d) => [d.name, d]));
  const seen = new Set<string>();
  const workers: Blueprint['workers'] = [];
  for (const name of order) {
    const d = byName.get(name);
    if (!d) throw new Error(t.steps.releaseMissing(`${name}.json`));
    for (const b of d.bindings) if (b.type === 'service' && !seen.has(b.service)) throw new Error(t.steps.serviceNotYet(name, b.service));
    seen.add(name);
    workers.push({ name, public_entry: d.public_entry, assets: !!d.assets, file: `${name}.json` });
  }
  if (workers.filter((w) => w.public_entry).length !== 1) throw new Error(t.steps.publicWorkers);
  const kv = [...new Set(descriptors.flatMap((d) => d.bindings.filter((b) => b.type === 'kv_namespace').map((b) => (b as { namespace: string }).namespace)))];
  const assetWorker = workers.find((w) => w.assets);
  const assetManifest = assetWorker ? `${assetWorker.name}-assets.json` : null;
  const assetChunks = assetWorker ? Object.keys(manifest.files).filter((f) => f.startsWith(`${assetWorker.name}-assets-`)).sort() : [];
  return { workers, databases: database.databases.map((d) => ({ name: d.name, tracked: d.tracked })), kv, assetManifest, assetChunks };
}

// The migrations a database records as applied, or null when it has no
// d1_migrations table yet (a fresh database).
async function appliedMigrations(cf: Cloudflare, accountId: string, dbId: string): Promise<Set<string> | null> {
  try {
    const result = (await cf.queryD1(accountId, dbId, 'SELECT name FROM d1_migrations')) as { results?: { name: string }[] }[];
    return new Set((result?.[0]?.results ?? []).map((r) => r.name));
  } catch (err) {
    if (err instanceof CloudflareError && /no such table/i.test(err.message)) return null;
    throw err;
  }
}

// Whether a release's bff can forward /installer/* (declares the shared key).
export const bffSupportsInstaller = (descriptor: WorkerDescriptor) => 'INSTALLER_INTERNAL_KEY' in descriptor.env;

// The optional secrets this installer sets itself (from its own settings),
// and so also removes once they no longer apply.
export const INSTALLER_MANAGED_SECRETS = new Set([
  'DEFAULT_IDP_CONNECTION_NAME',
  'DEFAULT_IDP_SCOPES',
  'DEFAULT_IDP_AUTH_CODE_CLIENT_ID',
  'DEFAULT_IDP_AUTH_CODE_CLIENT_SECRET',
  INSTALLER_KEY_SECRET,
]);

export interface StepContext {
  env: Env;
  state: InstallerState;
  cf: Cloudflare;
  t: Messages;
  // This installer's own Worker name (api.ts installerScript): what the bff
  // is linked to. Without it the bff is deployed as it was.
  installerScript?: string;
  // The step was asked for through Arcanum (so the own address may go off).
  viaArcanum?: boolean;
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
  const s = ctx.t.steps;
  const release = state.release!;
  const accountId = state.cloudflare!.accountId;

  if (id === 'installer:self') {
    // Uploads the release's installer over this one: same Worker, same KV
    // (read from the running script), every secret it has re-sent as is.
    // The request finishes on this code; the next one runs the new
    // installer. Failing here changes nothing — this installer keeps running.
    const target = release.blueprint.installer!;
    const descriptor = await fetchReleaseJson<WorkerDescriptor>(release.manifestUrl, release.manifest, target.file);
    const bindings = await cf.scriptBindings(accountId, target.script);
    if (!bindings) throw new Error(s.noInstallerScript(target.script));
    const kv = bindings.find((b) => b.type === 'kv_namespace' && b.name === 'INSTALLER_STATE')?.namespace_id;
    if (!kv) throw new Error(s.noInstallerState(target.script));
    // Recorded first: the deployment to roll back to from the dashboard.
    const previous = await cf.currentDeployment(accountId, target.script).catch(() => null);
    const env = ctx.env as unknown as Record<string, string | undefined>;
    const secrets = Object.fromEntries(Object.entries(descriptor.env).filter(([, spec]) => spec.kind === 'secret').map(([name]) => [name, env[name]]));
    const metadata = installerUploadMetadata(descriptor, { kvNamespaceId: kv, releaseVersion: release.version, secrets });
    try {
      await cf.uploadScript(accountId, target.script, metadata, descriptor.modules ?? []);
    } catch (err) {
      throw new Error(s.selfUpdateFailed(messageOf(err, ctx.t)));
    }
    state.selfUpdate = { from: ctx.env.INSTALLER_RELEASE ?? null, to: release.version, at: new Date().toISOString(), previousDeploymentId: previous?.id ?? null, previousVersionId: previous?.versionId ?? null };
    // Behind Arcanum: the upload may have switched the own address back on.
    if (ctx.viaArcanum && directShouldClose(state)) {
      await cf.setWorkersDev(accountId, target.script, false);
      state.behindArcanum!.publicAccessRemoved = true;
    }
    return { status: 'done', detail: s.selfUpdated(release.version) };
  }

  if (id === 'login:uris') {
    const login = state.bootstrap!.login!;
    const url = `https://${state.customDomain}`;
    const { added } = await addClientUris(login.issuer, { id: login.clientId, secret: await unsealValue(ctx.env, state, login.clientSecret) }, { redirectUris: [`${url}/callback`], postLogoutRedirectUris: [url] });
    return { status: 'done', detail: added.length ? s.urisAdded(added.length, new URL(login.issuer).host) : s.urisThere };
  }

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
    return { status: 'done', detail: s.secretsMade(added, Object.keys(existing).length) };
  }

  if (id.startsWith('d1:')) {
    const name = id.slice(3);
    if (state.resources.d1[name]) return { status: 'done', detail: s.exists };
    const found = await cf.findD1(accountId, name);
    state.resources.d1[name] = found ?? (await cf.createD1(accountId, name));
    return { status: 'done', detail: found ? s.reused : s.created };
  }

  if (id.startsWith('kv:')) {
    const ns = id.slice(3);
    if (state.resources.kv[ns]) return { status: 'done', detail: s.exists };
    const title = ns.replace(':', '-');
    const found = await cf.findKv(accountId, title);
    state.resources.kv[ns] = found ?? (await cf.createKv(accountId, title));
    return { status: 'done', detail: found ? s.reused : s.created };
  }

  if (id.startsWith('schema:')) {
    const name = id.slice(7);
    const dbId = state.resources.d1[name];
    if (!dbId) throw new Error(s.noDatabase(name));
    const database = await fetchReleaseJson<{ databases: { name: string; schema: string; tracked: boolean; migrations: { name: string; sql: string }[] }[] }>(release.manifestUrl, release.manifest, 'database.json');
    const db = database.databases.find((d) => d.name === name);
    if (!db?.schema) throw new Error(s.noSchema(name));
    // A database that already records migrations (an update, or a re-run):
    // apply only the ones it doesn't have yet, each with its record — never
    // schema.sql, which would mark new migrations applied without running them.
    const applied = db.tracked ? await appliedMigrations(cf, accountId, dbId) : null;
    if (applied && applied.size > 0) {
      const pending = db.migrations.filter((m) => !applied.has(m.name));
      for (const m of pending) {
        await cf.queryD1(accountId, dbId, `${m.sql.trim().replace(/;?$/, ';')}\nINSERT OR IGNORE INTO d1_migrations (name) VALUES ('${m.name.replace(/'/g, "''")}');`);
      }
      return { status: 'done', detail: pending.length ? s.migrationsApplied(pending.length, pending.map((m) => m.name).join(', ')) : s.upToDate };
    }
    // A fresh database: schema.sql is idempotent (IF NOT EXISTS / INSERT OR
    // IGNORE) and marks every tracked migration as applied.
    await cf.queryD1(accountId, dbId, db.schema);
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
    return { status: 'done', detail: needed.length === 0 ? s.allFilesThere : s.filesToUpload(needed.length) };
  }

  if (id.startsWith('assets:')) {
    const chunk = id.slice(7);
    const assets = state.assets;
    if (!assets) throw new Error(s.prepareFirst);
    if (Date.now() - Date.parse(assets.startedAt) > ASSET_SESSION_MAX_AGE_MS) throw new Error(s.uploadExpired);
    if (assets.completionJwt || assets.needed.length === 0) return { status: 'done', detail: s.nothingLeft };
    const manifest = await fetchReleaseJson<{ files: Record<string, { hash: string; contentType: string; chunk: string }> }>(release.manifestUrl, release.manifest, release.blueprint.assetManifest!);
    const inChunk = new Map(Object.values(manifest.files).filter((f) => f.chunk === chunk).map((f) => [f.hash, f.contentType]));
    const todo = assets.needed.filter((h) => inChunk.has(h));
    if (todo.length === 0) return { status: 'done', detail: s.nothingInPart };
    const contents = await fetchReleaseJson<Record<string, string>>(release.manifestUrl, release.manifest, chunk);
    const result = await cf.uploadAssets(
      accountId,
      assets.jwt,
      todo.map((hash) => ({ hash, base64: contents[hash], contentType: inChunk.get(hash)! }))
    );
    assets.needed = assets.needed.filter((h) => !todo.includes(h));
    if (result?.jwt && assets.needed.length === 0) assets.completionJwt = result.jwt;
    return { status: 'done', detail: s.files(todo.length) };
  }

  if (id.startsWith('worker:')) {
    const name = id.slice(7);
    const worker = release.blueprint.workers.find((w) => w.name === name);
    if (!worker) throw new Error(s.notInRelease(name));
    const descriptor = await fetchReleaseJson<WorkerDescriptor>(release.manifestUrl, release.manifest, worker.file);
    const url = publicUrl(state)!;
    const secrets = await secretsOf(ctx);
    // The installer moves behind Arcanum by itself: the first bff that can
    // forward /installer/* is linked to this installer, with a new shared key.
    if (worker.public_entry && !state.behindArcanum && bffSupportsInstaller(descriptor) && ctx.installerScript && (await cf.scriptExists(accountId, ctx.installerScript))) {
      secrets[INSTALLER_KEY_SECRET] ??= generateSecret('hex32');
      state.secrets = await sealValue(ctx.env, state, JSON.stringify(secrets));
      state.behindArcanum = { script: ctx.installerScript };
    }
    // Behind Arcanum: the bff forwards /installer/* to this installer.
    const linkInstaller = worker.public_entry && !!state.behindArcanum && bffSupportsInstaller(descriptor);
    const context: InstallContext = {
      publicUrl: url,
      issuerUrl: state.login!.issuer,
      answers: await answersOf(ctx),
      optional: {
        // AGPL §13: where users find the source of exactly what runs here.
        SOURCE_URL: `https://github.com/arcanum-pos/arcanum-releases/releases/tag/v${release.version}`,
        GIT_COMMIT_SHA: release.manifest.components[name]?.commit ?? '',
        // Shown in the console footer.
        ARCANUM_VERSION: release.version,
        ...(state.login?.connectionName ? { DEFAULT_IDP_CONNECTION_NAME: state.login.connectionName } : {}),
        ...(state.login?.scopes ? { DEFAULT_IDP_SCOPES: state.login.scopes } : {}),
        ...(state.login?.authCodeClientId && state.login.authCodeClientSecret
          ? {
              DEFAULT_IDP_AUTH_CODE_CLIENT_ID: state.login.authCodeClientId,
              DEFAULT_IDP_AUTH_CODE_CLIENT_SECRET: await unsealValue(ctx.env, state, state.login.authCodeClientSecret),
            }
          : {}),
        ...(linkInstaller ? { [INSTALLER_KEY_SECRET]: secrets[INSTALLER_KEY_SECRET] } : {}),
      },
      secrets,
      resources: { d1: state.resources.d1, kv: state.resources.kv, ratelimitNamespaceId: state.resources.ratelimitNamespaceId! },
      currentMigrationTag: descriptor.durable_object_migrations.length ? await cf.getMigrationTag(accountId, name) : null,
      assetsJwt: worker.assets ? state.assets?.completionJwt : undefined,
      orgCreation: state.instance?.kind,
    };
    if (worker.assets && !context.assetsJwt) throw new Error(s.assetsIncomplete);
    const metadata = uploadMetadata(descriptor, context);
    if (linkInstaller) (metadata.bindings as unknown[]).push({ type: 'service', name: 'ARCANUM_INSTALLER_SERVICE', service: state.behindArcanum!.script });
    await cf.uploadScript(accountId, name, metadata, descriptor.modules ?? []);
    // Cloudflare keeps a Worker's secrets that an upload doesn't mention: an
    // optional one this installer set before but no longer does (Google's
    // separate browser client and scopes after moving to another provider,
    // say) has to go explicitly — or it would still be used. Only the ones
    // the installer manages itself: never what an admin set by hand
    // (DEFAULT_SMTP_*, BOOTSTRAP_API_KEY…).
    const sent = new Set((metadata.bindings as { name: string }[]).map((b) => b.name));
    const optionalSecrets = Object.entries(descriptor.env)
      .filter(([n, spec]) => spec.kind === 'secret' && spec.source === 'optional' && INSTALLER_MANAGED_SECRETS.has(n) && !sent.has(n))
      .map(([n]) => n);
    if (optionalSecrets.length) {
      const existing = new Set(((await cf.scriptBindings(accountId, name)) ?? []).filter((b) => b.type === 'secret_text').map((b) => b.name));
      for (const stale of optionalSecrets.filter((n) => existing.has(n))) await cf.deleteSecret(accountId, name, stale);
    }
    // Only the public entry gets a workers.dev address; everything else is
    // reachable solely through service bindings.
    await cf.setWorkersDev(accountId, name, worker.public_entry);
    if (worker.public_entry && state.customDomain) {
      try {
        await cf.attachCustomDomain(accountId, state.customDomain, name);
      } catch (err) {
        const denied = err instanceof CloudflareError && (err.status === 401 || err.status === 403);
        throw new Error(
          s.domainFailed(state.customDomain, messageOf(err, ctx.t)) + (denied ? s.domainDenied : s.domainZone)
        );
      }
    }
    return { status: 'done', detail: worker.public_entry ? url : s.internal };
  }

  if (id === 'login:reset') {
    // The backend seeds the default login provider from DEFAULT_IDP_* once,
    // at the first login. Clearing that seeded row makes it re-seed from the
    // current settings — a no-op on a fresh install, and how a changed login
    // provider (e.g. Google's scopes) takes effect on an existing one. It's
    // only the platform-default row: org-specific providers are untouched.
    await cf.queryD1(accountId, state.resources.d1['arcanum-backend'], "DELETE FROM identity_providers WHERE org_id = 'default'");
    return { status: 'done', detail: s.loginResetDone };
  }

  if (id === 'verify') {
    // Through the Cloudflare API only: a Worker can't fetch another Worker
    // of the same account via its workers.dev URL (Cloudflare error 1042,
    // seen as a 404) — the setup page checks it's live from the browser.
    const missing: string[] = [];
    for (const w of release.blueprint.workers) if (!(await cf.scriptExists(accountId, w.name))) missing.push(w.name);
    if (missing.length) throw new Error(s.stillMissing(missing.join(', ')));
    const entry = release.blueprint.workers.find((w) => w.public_entry)!;
    if (!(await cf.isOnWorkersDev(accountId, entry.name))) throw new Error(s.notOnWorkersDev(entry.name));
    if (state.customDomain && (await cf.customDomainService(accountId, state.customDomain)) !== entry.name) {
      throw new Error(s.domainNotLinked(state.customDomain, entry.name));
    }
    const database = await fetchReleaseJson<{ databases: { name: string; tracked: boolean; migrations: unknown[] }[] }>(release.manifestUrl, release.manifest, 'database.json');
    for (const db of database.databases.filter((d) => d.tracked)) {
      const result = (await cf.queryD1(accountId, state.resources.d1[db.name], 'SELECT COUNT(*) AS n FROM d1_migrations').catch(() => {
        throw new Error(s.notSetUp(db.name));
      })) as { results?: { n: number }[] }[];
      const recorded = result?.[0]?.results?.[0]?.n ?? 0;
      if (recorded < db.migrations.length) throw new Error(s.migrationsMissing(db.name, recorded, db.migrations.length));
    }
    state.installed = { version: release.version, at: new Date().toISOString() };
    return { status: 'done', detail: s.verified(release.blueprint.workers.length) };
  }

  throw new Error(ctx.t.api.unknownStep(id));
}
