// From a release's Worker descriptor (arcanum-releases scripts/lib.mjs
// describeWorker) + this installation's answers and resources to the
// metadata of a Cloudflare script upload. Pure — tested in test/contract.test.ts.
import { TextError } from './i18n';

export interface EnvSpec {
  kind: 'secret' | 'var';
  // The last three only on the installer's own descriptor (installerUploadMetadata).
  source: 'fixed' | 'public_url' | 'public_host' | 'zone_id' | 'issuer_host' | 'generate' | 'shared' | 'install' | 'optional' | 'keep' | 'bootstrap' | 'release_version';
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
  modules?: { name: string; type: 'esm' | 'compiled_wasm' | 'text' | 'data'; content?: string; base64?: string }[];
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

export class ContractError extends TextError {}

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
      if (!value) throw new ContractError((t) => t.contract.noGenerated(name));
      return text(value);
    }
    case 'shared': {
      const value = ctx.secrets[spec.key ?? name];
      if (!value) throw new ContractError((t) => t.contract.noShared(String(spec.key), name));
      return text(value);
    }
    case 'install': {
      const value = ctx.answers[spec.question ?? name];
      if (value === undefined || value === '') throw new ContractError((t) => t.contract.noAnswer(String(spec.question), name));
      return text(value);
    }
    case 'optional':
    case 'zone_id':
      return ctx.optional[name] ? text(ctx.optional[name]) : null;
    default:
      throw new ContractError((t) => t.contract.unknownSource(name, String((spec as EnvSpec).source)));
  }
}

function resourceBinding(b: DescriptorBinding, ctx: InstallContext): ApiBinding {
  switch (b.type) {
    case 'd1': {
      const id = ctx.resources.d1[b.database];
      if (!id) throw new ContractError((t) => t.contract.noDatabase(b.database));
      return { type: 'd1', name: b.name, id };
    }
    case 'kv_namespace': {
      const id = ctx.resources.kv[b.namespace];
      if (!id) throw new ContractError((t) => t.contract.noKv(b.namespace));
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
      throw new ContractError((t) => t.contract.unknownBinding((b as { type: string }).type));
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
        throw new ContractError((t) => t.contract.migrationUnsupported(key, step.tag));
      }
    }
    for (const c of list(step.new_classes)) classes.set(String(c), 'kv');
    for (const c of list(step.new_sqlite_classes)) classes.set(String(c), 'sqlite');
    for (const r of list(step.renamed_classes) as { from: string; to: string }[]) {
      const storage = classes.get(r.from);
      if (!storage) throw new ContractError((t) => t.contract.renamesMissing(step.tag, r.from));
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

// Every installation this installer makes is an own instance (one org —
// HOSTING_PLAN.md section 1), whatever a release's descriptor says: a
// release built before ORG_CREATION existed doesn't carry it, and a
// mistake in the contract could hand over the shared demo tenant's
// "internal". Applied last, replacing any descriptor value.
export const OWN_INSTANCE_VARS: Record<string, Record<string, string>> = {
  'arcanum-backend': { ORG_CREATION: 'single' },
};

export function uploadMetadata(descriptor: WorkerDescriptor, ctx: InstallContext): Record<string, unknown> {
  const forced = OWN_INSTANCE_VARS[descriptor.name] ?? {};
  const bindings = [
    ...descriptor.bindings.map((b) => resourceBinding(b, ctx)),
    ...Object.entries(descriptor.env)
      .filter(([name]) => !(name in forced))
      .map(([name, spec]) => envBinding(name, spec, ctx))
      .filter((b): b is ApiBinding => b !== null),
    ...Object.entries(forced).map(([name, text]): ApiBinding => ({ type: 'plain_text', name, text })),
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
    if (!ctx.assetsJwt) throw new ContractError((t) => t.contract.assetsNotUploaded(descriptor.name));
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

// The installer's own upload (arcanum-releases manifest.installer) — what
// this installer sends when it uploads a release's installer over itself.
// The bootstrapper (arcanum-bootstrapper src/installer-upload.ts) builds
// the same metadata for a new account. Its only resource is its KV; its
// secrets are whatever the running installer has (`keep`, `bootstrap`),
// re-sent unchanged — a script upload replaces every binding, so a secret
// left out would be gone.
export interface InstallerUploadContext {
  kvNamespaceId: string;
  releaseVersion: string;
  secrets: Record<string, string | undefined>;
}

export function installerUploadMetadata(descriptor: WorkerDescriptor, ctx: InstallerUploadContext): Record<string, unknown> {
  const bindings: ApiBinding[] = descriptor.bindings.map((b) => {
    if (b.type !== 'kv_namespace') throw new ContractError((t) => t.contract.installerBinding(b.type));
    return { type: 'kv_namespace', name: b.name, namespace_id: ctx.kvNamespaceId };
  });
  for (const [name, spec] of Object.entries(descriptor.env)) {
    if (spec.source === 'fixed') bindings.push(typeof spec.value === 'string' ? { type: 'plain_text', name, text: spec.value } : { type: 'json', name, json: spec.value });
    else if (spec.source === 'release_version') bindings.push({ type: 'plain_text', name, text: ctx.releaseVersion });
    else if (spec.source === 'keep' || spec.source === 'bootstrap') {
      const value = ctx.secrets[name];
      if (value) bindings.push({ type: 'secret_text', name, text: value });
    } else if (spec.source !== 'optional') throw new ContractError((t) => t.contract.installerSource(name, String(spec.source)));
  }
  const metadata: Record<string, unknown> = {
    main_module: descriptor.main_module,
    compatibility_date: descriptor.compatibility_date,
    compatibility_flags: descriptor.compatibility_flags,
    bindings,
  };
  if (descriptor.observability) metadata.observability = descriptor.observability;
  return metadata;
}
