// The installer's state, one JSON document in KV. Sensitive values are
// sealed (crypto.ts): the Cloudflare token (only when "onthouden"), the
// login provider's client secret, and the generated Arcanum secrets —
// ENCRYPTION_KEY among them, which must survive for the installation's
// whole life (it wraps every org's data key).
import type { Env } from './env';
import { randomBytes, seal, toBase64, unseal, type Sealed } from './crypto';
import type { Manifest } from './releases';

export interface Blueprint {
  // In deploy order (a Worker's service bindings point at Workers before it).
  workers: { name: string; public_entry: boolean; assets: boolean; file: string }[];
  databases: { name: string; tracked: boolean }[];
  kv: string[];
  assetManifest: string | null;
  assetChunks: string[];
}

export interface StepRecord {
  status: 'done' | 'failed';
  at: string;
  detail?: string;
}

export interface InstallerState {
  v: 1;
  salt: string;
  cloudflare?: { accountId: string; accountName: string; subdomain: string; remember: boolean; token?: Sealed };
  login?: { issuer: string; clientId: string; clientSecret: Sealed; connectionName?: string; authorizationEndpoint: string };
  admins?: string;
  release?: { version: string; manifestUrl: string; manifest: Manifest; blueprint: Blueprint };
  secrets?: Sealed;
  resources: { d1: Record<string, string>; kv: Record<string, string>; ratelimitNamespaceId?: string };
  steps: Record<string, StepRecord>;
  assets?: { jwt: string; needed: string[]; completionJwt?: string; startedAt: string };
  // A real asset of the installation (the hashed logo) — the setup page
  // loads it to see the installation is live end to end.
  probePath?: string;
  installed?: { version: string; at: string };
}

const KEY = 'state';

export async function loadState(env: Env): Promise<InstallerState> {
  const stored = await env.INSTALLER_STATE.get<InstallerState>(KEY, 'json');
  return stored ?? { v: 1, salt: toBase64(randomBytes(16)), resources: { d1: {}, kv: {} }, steps: {} };
}

export async function saveState(env: Env, state: InstallerState): Promise<void> {
  await env.INSTALLER_STATE.put(KEY, JSON.stringify(state));
}

export const sealValue = (env: Env, state: InstallerState, value: string) => seal(value, env.INSTALLER_PASSWORD, state.salt);
export const unsealValue = (env: Env, state: InstallerState, value: Sealed) => unseal(value, env.INSTALLER_PASSWORD, state.salt);

// The public address of the installation: the bff on the account's workers.dev subdomain.
export function publicUrl(state: InstallerState): string | null {
  return state.cloudflare?.subdomain ? `https://arcanum-bff.${state.cloudflare.subdomain}.workers.dev` : null;
}

// Once anything exists on the account, the account and address are locked:
// changing them would orphan what's there.
export function installationStarted(state: InstallerState): boolean {
  return Object.keys(state.resources.d1).length > 0 || Object.keys(state.steps).some((s) => s.startsWith('worker:'));
}
