// From a release's Worker descriptor (arcanum-releases scripts/lib.mjs
// describeWorker) + this installation's answers and resources to the
// metadata of a Cloudflare script upload. Pure — tested in test/contract.test.ts.

export interface EnvSpec {
  kind: 'secret' | 'var';
  source: 'fixed' | 'public_url' | 'public_host' | 'zone_id' | 'issuer_host' | 'generate' | 'shared' | 'install' | 'optional';
  value?: unknown;
  key?: string;
  format?: string;
  question?: string;
}

export type DescriptorBinding =
  | { type: 'd1'; name: string; database: string }
  | { type: 'kv_namespace'; name: string; namespace: string }
  | { type: 'durable_object_namespace'; name: string; class_name: string }
  | { type: 'service'; name: string; service: string }
  | { type: 'ratelimit'; name: string; simple: { limit: number; period: number } }
  | { type: 'assets'; name: string }
  | { type: 'version_metadata'; name: string };

export interface WorkerDescriptor {
  name: string;
  main_module: string;
  compatibility_date: string;
  compatibility_flags: string[];
  public_entry: boolean;
  observability: Record<string, unknown> | null;
  bindings: DescriptorBinding[];
  durable_object_migrations: ({ tag: string } & Record<string, unknown>)[];
  assets: { config: Record<string, unknown> } | null;
  env: Record<string, EnvSpec>;
  modules?: { name: string; type: 'esm' | 'compiled_wasm' | 'text'; content?: string; base64?: string }[];
}

export interface InstallContext {
  publicUrl: string; // https://arcanum-bff.<subdomain>.workers.dev
  issuerUrl: string;
  // Answers to 'install' questions, by question id (login.issuer, login.clientId, …).
  answers: Record<string, string>;
  // Optional settings the installer fills in (SOURCE_URL, GIT_COMMIT_SHA, DEFAULT_IDP_CONNECTION_NAME, …).
  optional: Record<string, string>;
  // Generated secrets by name — 'generate' entries by their own name, 'shared' ones by `key`.
  secrets: Record<string, string>;
  resources: { d1: Record<string, string>; kv: Record<string, string>; ratelimitNamespaceId: string };
  currentMigrationTag: string | null;
  assetsJwt?: string;
}

export class ContractError extends Error {}

type ApiBinding = Record<string, unknown> & { type: string; name: string };

function envBinding(name: string, spec: EnvSpec, ctx: InstallContext): ApiBinding | null {
  const text = (value: string): ApiBinding => ({ type: spec.kind === 'secret' ? 'secret_text' : 'plain_text', name, text: value });
  switch (spec.source) {
    case 'fixed':
      // A non-string var (e.g. SESSION_TTL: 604800) is a JSON binding, like wrangler sends it.
      return typeof spec.value === 'string' ? text(spec.value) : { type: 'json', name, json: spec.value };
    case 'public_url':
      return text(ctx.publicUrl);
    case 'public_host':
      return text(new URL(ctx.publicUrl).host);
    case 'issuer_host':
      return text(new URL(ctx.issuerUrl).host);
    case 'generate': {
      const value = ctx.secrets[name];
      if (!value) throw new ContractError(`Geen gegenereerde waarde voor ${name}`);
      return text(value);
    }
    case 'shared': {
      const value = ctx.secrets[spec.key ?? name];
      if (!value) throw new ContractError(`Geen gedeelde waarde ${spec.key} voor ${name}`);
      return text(value);
    }
    case 'install': {
      const value = ctx.answers[spec.question ?? name];
      if (value === undefined || value === '') throw new ContractError(`Nog geen antwoord op ${spec.question} (${name})`);
      return text(value);
    }
    case 'optional':
    case 'zone_id':
      return ctx.optional[name] ? text(ctx.optional[name]) : null;
    default:
      throw new ContractError(`${name}: onbekende bron "${(spec as EnvSpec).source}" — werk de installer bij`);
  }
}

function resourceBinding(b: DescriptorBinding, ctx: InstallContext): ApiBinding {
  switch (b.type) {
    case 'd1': {
      const id = ctx.resources.d1[b.database];
      if (!id) throw new ContractError(`Database ${b.database} bestaat nog niet`);
      return { type: 'd1', name: b.name, id };
    }
    case 'kv_namespace': {
      const id = ctx.resources.kv[b.namespace];
      if (!id) throw new ContractError(`KV-namespace ${b.namespace} bestaat nog niet`);
      return { type: 'kv_namespace', name: b.name, namespace_id: id };
    }
    case 'durable_object_namespace':
      return { type: 'durable_object_namespace', name: b.name, class_name: b.class_name };
    case 'service':
      return { type: 'service', name: b.name, service: b.service };
    case 'ratelimit':
      return { type: 'ratelimit', name: b.name, namespace_id: ctx.resources.ratelimitNamespaceId, simple: b.simple };
    case 'assets':
      return { type: 'assets', name: b.name };
    case 'version_metadata':
      return { type: 'version_metadata', name: b.name };
    default:
      throw new ContractError(`Onbekend bindingtype ${(b as { type: string }).type} — werk de installer bij`);
  }
}

// The net effect of a Durable Object migration history: which classes exist
// at the end, SQLite- or KV-backed.
export function netClasses(migrations: WorkerDescriptor['durable_object_migrations']): { sqlite: string[]; kv: string[] } {
  const classes = new Map<string, 'sqlite' | 'kv'>();
  const list = (v: unknown) => (Array.isArray(v) ? (v as unknown[]) : []);
  for (const step of migrations) {
    for (const key of Object.keys(step)) {
      if (!['tag', 'new_classes', 'new_sqlite_classes', 'renamed_classes', 'deleted_classes'].includes(key)) {
        throw new ContractError(`Durable Object-migratie "${key}" (tag ${step.tag}) wordt door de installer nog niet ondersteund`);
      }
    }
    for (const c of list(step.new_classes)) classes.set(String(c), 'kv');
    for (const c of list(step.new_sqlite_classes)) classes.set(String(c), 'sqlite');
    for (const r of list(step.renamed_classes) as { from: string; to: string }[]) {
      const storage = classes.get(r.from);
      if (!storage) throw new ContractError(`Migratie ${step.tag} hernoemt ${r.from}, dat niet bestaat`);
      classes.delete(r.from);
      classes.set(r.to, storage);
    }
    for (const c of list(step.deleted_classes)) classes.delete(String(c));
  }
  const of = (kind: 'sqlite' | 'kv') => [...classes].filter(([, k]) => k === kind).map(([c]) => c).sort();
  return { sqlite: of('sqlite'), kv: of('kv') };
}

// An existing script: exactly wrangler's logic (getMigrationsToUpload) —
// only the steps after its current tag. A NEW script can't be given the
// history itself: Cloudflare checks a delete or rename against the
// previously deployed version, which a new script doesn't have (error
// 10074 for devicehub's create → delete → create). So a new script gets
// the history's net effect as one step, under the latest tag — later
// updates then continue from that tag as if the history had been replayed.
export function migrationsPayload(migrations: WorkerDescriptor['durable_object_migrations'], currentTag: string | null) {
  if (migrations.length === 0) return undefined;
  const newTag = migrations[migrations.length - 1].tag;
  const strip = (m: { tag: string } & Record<string, unknown>) => Object.fromEntries(Object.entries(m).filter(([k]) => k !== 'tag'));
  if (!currentTag) {
    const { sqlite, kv } = netClasses(migrations);
    const step: Record<string, string[]> = {};
    if (sqlite.length) step.new_sqlite_classes = sqlite;
    if (kv.length) step.new_classes = kv;
    return { new_tag: newTag, steps: Object.keys(step).length ? [step] : [] };
  }
  const at = migrations.findIndex((m) => m.tag === currentTag);
  if (at === -1) return { old_tag: currentTag, new_tag: newTag, steps: migrations.map(strip) };
  if (at === migrations.length - 1) return undefined;
  return { old_tag: currentTag, new_tag: newTag, steps: migrations.slice(at + 1).map(strip) };
}

export function uploadMetadata(descriptor: WorkerDescriptor, ctx: InstallContext): Record<string, unknown> {
  const bindings = [
    ...descriptor.bindings.map((b) => resourceBinding(b, ctx)),
    ...Object.entries(descriptor.env)
      .map(([name, spec]) => envBinding(name, spec, ctx))
      .filter((b): b is ApiBinding => b !== null),
  ];
  const metadata: Record<string, unknown> = {
    main_module: descriptor.main_module,
    compatibility_date: descriptor.compatibility_date,
    compatibility_flags: descriptor.compatibility_flags,
    bindings,
  };
  if (descriptor.observability) metadata.observability = descriptor.observability;
  const migrations = migrationsPayload(descriptor.durable_object_migrations, ctx.currentMigrationTag);
  if (migrations) metadata.migrations = migrations;
  if (descriptor.assets) {
    if (!ctx.assetsJwt) throw new ContractError(`${descriptor.name}: de bestanden zijn nog niet geüpload`);
    metadata.assets = { jwt: ctx.assetsJwt, config: descriptor.assets.config };
  }
  return metadata;
}

// Every generated secret the release needs, by the name it's stored under.
export function secretsNeeded(descriptors: WorkerDescriptor[]): Record<string, string | undefined> {
  const needed: Record<string, string | undefined> = {};
  for (const d of descriptors) {
    for (const [name, spec] of Object.entries(d.env)) {
      if (spec.source === 'generate') needed[name] = spec.format;
      if (spec.source === 'shared') needed[spec.key ?? name] ??= spec.format;
    }
  }
  return needed;
}
