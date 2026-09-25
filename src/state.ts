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
  login?: {
    issuer: string;
    clientId: string;
    clientSecret: Sealed;
    connectionName?: string;
    authorizationEndpoint: string;
    // Google rejects `offline_access`; unset = the platform default scopes.
    scopes?: string;
    // A separate client for browser login (Google: "Web application"); the
    // primary client then only does the kassa's device login.
    authCodeClientId?: string;
    authCodeClientSecret?: Sealed;
  };
  admins?: string;
  // The installation's own domain (a Workers Custom Domain on the bff, in a
  // zone of this account — no Cloudflare for SaaS). Unset = workers.dev only.
  customDomain?: string;
  release?: { version: string; manifestUrl: string; manifest: Manifest; blueprint: Blueprint };
  secrets?: Sealed;
  resources: { d1: Record<string, string>; kv: Record<string, string>; ratelimitNamespaceId?: string };
  steps: Record<string, StepRecord>;
  assets?: { jwt: string; needed: string[]; completionJwt?: string; startedAt: string };
  // A real asset of the installation (the hashed logo) — the setup page
  // loads it to see the installation is live end to end.
  probePath?: string;
  installed?: { version: string; at: string };
  // After install, the installer can move behind Arcanum: the bff gets a
  // service binding to this Worker (`script`) and forwards /installer/* for
  // logged-in admins, with a shared key (INSTALLER_INTERNAL_KEY in
  // `secrets`). `publicAccessRemoved`: its own workers.dev address was
  // switched off from there.
  behindArcanum?: { script: string; publicAccessRemoved?: boolean };
}

const KEY = 'state';

// The shared key the bff sends with every forwarded /installer/* request.
export const INSTALLER_KEY_SECRET = 'INSTALLER_INTERNAL_KEY';

export async function loadState(env: Env): Promise<InstallerState> {
  const stored = await env.INSTALLER_STATE.get<InstallerState>(KEY, 'json');
  return stored ?? { v: 1, salt: toBase64(randomBytes(16)), resources: { d1: {}, kv: {} }, steps: {} };
}

export async function saveState(env: Env, state: InstallerState): Promise<void> {
  await env.INSTALLER_STATE.put(KEY, JSON.stringify(state));
}

export const sealValue = (env: Env, state: InstallerState, value: string) => seal(value, env.INSTALLER_PASSWORD, state.salt);
export const unsealValue = (env: Env, state: InstallerState, value: Sealed) => unseal(value, env.INSTALLER_PASSWORD, state.salt);

// The bff on the account's workers.dev subdomain — always there, also as a fallback.
export function workersDevUrl(state: InstallerState): string | null {
  return state.cloudflare?.subdomain ? `https://arcanum-bff.${state.cloudflare.subdomain}.workers.dev` : null;
}

// The installation's address: its own domain if it has one, else workers.dev.
export function publicUrl(state: InstallerState): string | null {
  if (!state.cloudflare) return null;
  return state.customDomain ? `https://${state.customDomain}` : workersDevUrl(state);
}

// Once anything exists on the account, the account and address are locked:
// changing them would orphan what's there.
export function installationStarted(state: InstallerState): boolean {
  return Object.keys(state.resources.d1).length > 0 || Object.keys(state.steps).some((s) => s.startsWith('worker:'));
}

// "Bert@X.be" against "bert@x.be, *@leiding.be" — the same allowlist the
// platform uses for INSTANCE_ADMIN_EMAILS.
export function isAdmin(state: InstallerState, email: string): boolean {
  const address = email.trim().toLowerCase();
  const domain = address.split('@')[1];
  if (!domain) return false;
  return (state.admins ?? '')
    .split(/[,;\s]+/)
    .filter(Boolean)
    .some((entry) => entry === address || entry === `*@${domain}`);
}
