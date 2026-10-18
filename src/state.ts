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
  // Set when choosing an update whose release carries a newer installer.
  installer?: InstallerTarget;
}

// The self-update of an update: the release's installer is uploaded over
// this one before anything of Arcanum changes (steps.ts 'installer:self').
export interface InstallerTarget {
  file: string;
  // This installer's own Worker name.
  script: string;
}

export interface StepRecord {
  status: 'done' | 'failed';
  at: string;
  detail?: string;
}

// The login provider as the installer keeps it (Arcanum's DEFAULT_IDP_*).
export type LoginSettings = NonNullable<InstallerState['login']>;

export interface InstanceSettings {
  // The backend's ORG_CREATION: 'single' (one org), 'admins' (the admins
  // create and import several), 'internal' (the demo: the bootstrapper's demo orgs).
  kind: 'single' | 'admins' | 'internal';
  // 'dev': development builds (releases-dev.json) are offered too.
  channel: 'stable' | 'dev';
  // The demo only: where its console's "Eigen installatie" link points
  // (the backend's DEMO_INSTALL_URL) — the bootstrapper's own address.
  startUrl?: string;
}

// This page's own sign-in client (oidc.ts). `selfService: false` once
// "Aanmelding wijzigen" pointed it at another provider: then it's no longer
// the bootstrapper's client at arcanum-auth, so no /clients/self (login:uris).
export interface SignInClient {
  issuer: string;
  clientId: string;
  clientSecret: Sealed;
  selfService?: false;
}

// "Aanmelding wijzigen" (login-change.ts): a new provider is staged, tested
// by the admin doing the change, then applied — with a snapshot to undo it
// for 7 days.
export interface LoginChange {
  staged?: { login: LoginSettings; at: string };
  // A real sign-in at the staged provider, by an installer session.
  test?: { at: string; stagedAt: string; sessionId: string; sessionEmail: string | null; email: string; sub: string; emailVerified: boolean };
  applied?: {
    at: string;
    undoUntil: string;
    // 'started': the snapshot is saved, the switch may be half done (apply
    // again, or undo); 'done': everything switched.
    phase: 'started' | 'done';
    previous: { login: LoginSettings; signIn: SignInClient | null; adminsAdded: string | null };
    to: { issuer: string };
    // Sealed JSON (login-change.ts Snapshot): every membership in scope as it
    // was, the tester's binding, who has to sign in again.
    snapshot: Sealed;
  };
}

export interface InstallerState {
  v: 1;
  salt: string;
  // Several installations can live on one Cloudflare account (ROADMAP.md
  // §2): this one's name is the start of every Worker, database and KV
  // namespace it makes — `<name>-bff`, `<name>-devices`. Set once, by the
  // bootstrapper's handover, before anything exists. Unset = "arcanum", the
  // names every installation had before (nothing of theirs is renamed).
  instanceName?: string;
  cloudflare?: { accountId: string; accountName: string; subdomain: string; remember: boolean; token?: Sealed };
  // Self-hosted on Kubernetes instead (SELF_HOSTING.md, kubernetes/steps.ts):
  // the installer runs in the cluster, in `namespace`, and deploys there.
  // `publicUrl`: where the self-hoster routes Arcanum (their Ingress, a
  // Cloudflare Tunnel, …) — the bff's address, like a custom domain.
  kubernetes?: { namespace: string; publicUrl?: string; storageClassName?: string };
  // Or with Docker / Podman (compose, docker/steps.ts): the installer is a
  // container next to the ones it makes, on the same network.
  // `compose`: compose mode (docker/compose-file.ts) — it writes compose.yaml
  // instead of making the containers.
  docker?: { publicUrl?: string; compose?: boolean; fingerprint?: string };
  login?: {
    issuer: string;
    clientId: string;
    clientSecret: Sealed;
    authorizationEndpoint: string;
    // Google rejects `offline_access`; unset = the platform default scopes.
    scopes?: string;
    // clientId/clientSecret: the client for signing in in the browser — and,
    // without a separate one below, also for signing in with a QR code (the
    // device grant), as with login.kaboutersoft.be. A separate client for the
    // QR sign-in, for providers that need one (Google: "TVs and Limited Input
    // devices") — optional (2026-10-12; before, it was the other way round:
    // the primary client was the QR one, normalizeLogin swaps an old state).
    deviceClientId?: string;
    deviceClientSecret?: Sealed;
    // Read only by normalizeLogin: the separate browser client of before.
    authCodeClientId?: string;
    authCodeClientSecret?: Sealed;
  };
  admins?: string;
  // The installation's mail account (mail.ts, MAIL.md): { provider, …settings }, sealed.
  mail?: { config: Sealed; updatedAt: string };
  // The installation's SMS account (sms.ts, MESSAGING.md): Twilio's settings, sealed.
  sms?: { config: Sealed; updatedAt: string };
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
  // The installer behind Arcanum: the bff gets a service binding to this
  // Worker (`script`) when it's deployed and forwards /installer/* for
  // logged-in admins, with a shared key (INSTALLER_INTERNAL_KEY in
  // `secrets`). `publicAccessRemoved`: its own workers.dev address was
  // switched off (through Arcanum). `keptOpen`: switched back on under
  // Geavanceerd — stays on until it's closed there.
  behindArcanum?: { script: string; publicAccessRemoved?: boolean; keptOpen?: boolean };
  // What kind of installation this is, and which releases it follows — set
  // only by the bootstrapper's handover (for the platform's own
  // installations), kept here so every update and self-update keeps it.
  // Unset: one organization, stable releases.
  instance?: InstanceSettings;
  // Made by the bootstrapper (bootstrap.ts): who set it up, the OAuth client
  // at its login provider that admins sign in to this page with (oidc.ts —
  // also the one Arcanum starts with), the handoff codes already used, and
  // the recovery code (its SHA-256 only).
  bootstrap?: {
    importedAt: string;
    owner: { email: string; sub: string };
    login?: SignInClient;
    // Its own client at login.kaboutersoft.be, kept once the sign-in above
    // moved to another provider — so Arcanum can always go back to it.
    startClient?: SignInClient;
    handoffs: string[];
    recoveryHash?: string;
  };
  // The last self-update: from which installer to which, and the Cloudflare
  // deployment that was live before it (to roll back to in the dashboard).
  selfUpdate?: { from: string | null; to: string; at: string; previousDeploymentId: string | null; previousVersionId: string | null };
  loginChange?: LoginChange;
}

const KEY = 'state';

// The shared key the bff sends with every forwarded /installer/* request.
export const INSTALLER_KEY_SECRET = 'INSTALLER_INTERNAL_KEY';

// Running in a Kubernetes cluster or with Docker (node.ts): it installs
// there, under the new name (SELF_HOSTING.md: tresjr-…), unless the handoff named it.
function onKubernetes(env: Env, state: InstallerState): InstallerState {
  if (env.KUBE && !state.cloudflare && !state.kubernetes) {
    state.kubernetes = { namespace: env.KUBE.namespace };
    state.instanceName ??= 'tresjr';
  }
  if ((env.DOCKER || env.COMPOSE) && !state.cloudflare && !state.docker) {
    state.docker = env.COMPOSE ? { compose: true } : {};
    state.instanceName ??= 'tresjr';
  }
  return state;
}

// Self-hosted (Kubernetes or Docker): no Cloudflare; the self-hoster routes
// their own address to the bff.
export const selfHosted = (state: InstallerState): { publicUrl?: string } | undefined => state.kubernetes ?? state.docker;

export async function loadState(env: Env): Promise<InstallerState> {
  const stored = await env.INSTALLER_STATE.get<InstallerState>(KEY, 'json');
  if (!stored) return onKubernetes(env, { v: 1, salt: toBase64(randomBytes(16)), resources: { d1: {}, kv: {} }, steps: {} });
  onKubernetes(env, stored);
  if (stored.login) stored.login = normalizeLogin(stored.login);
  if (stored.loginChange?.staged) stored.loginChange.staged.login = normalizeLogin(stored.loginChange.staged.login);
  if (stored.loginChange?.applied?.previous) stored.loginChange.applied.previous.login = normalizeLogin(stored.loginChange.applied.previous.login);
  return stored;
}

// Settings from before 2026-10-12, when a second client was the browser's:
// that one becomes the primary client, the old primary (the kassa's QR
// client) the separate QR client. One client: nothing changes.
export function normalizeLogin(login: LoginSettings): LoginSettings {
  if (!login.authCodeClientId || !login.authCodeClientSecret) {
    const { authCodeClientId: _id, authCodeClientSecret: _secret, ...rest } = login;
    return rest;
  }
  const { authCodeClientId, authCodeClientSecret, clientId, clientSecret, ...rest } = login;
  return { ...rest, clientId: authCodeClientId, clientSecret: authCodeClientSecret, deviceClientId: clientId, deviceClientSecret: clientSecret };
}

export async function saveState(env: Env, state: InstallerState): Promise<void> {
  await env.INSTALLER_STATE.put(KEY, JSON.stringify(state));
}

// The root of every key the installer derives (sealing, session cookies):
// the bootstrapper's random state key.
export function rootSecret(env: Env): string {
  return env.INSTALLER_STATE_KEY || '';
}

export const sealValue = (env: Env, state: InstallerState, value: string) => seal(value, rootSecret(env), state.salt);
export const unsealValue = (env: Env, state: InstallerState, value: Sealed) => unseal(value, rootSecret(env), state.salt);

// Releases name their parts `arcanum-…` (the logical names, also the keys
// of this state's steps and resources); on the account they carry the
// instance's name. With the default name that's the same name.
export const DEFAULT_INSTANCE = 'arcanum';
export const INSTANCE_NAME = /^[a-z][a-z0-9-]{0,19}$/;
export const instanceOf = (state: InstallerState) => state.instanceName ?? DEFAULT_INSTANCE;
export function deployedName(state: InstallerState, logical: string): string {
  return logical.replace(/^arcanum-/, `${instanceOf(state)}-`);
}

// The bff on the account's workers.dev subdomain — always there, also as a fallback.
export function workersDevUrl(state: InstallerState): string | null {
  return state.cloudflare?.subdomain ? `https://${deployedName(state, 'arcanum-bff')}.${state.cloudflare.subdomain}.workers.dev` : null;
}

// The installation's address: its own domain if it has one, else workers.dev.
export function publicUrl(state: InstallerState): string | null {
  if (selfHosted(state)) return selfHosted(state)!.publicUrl ?? null;
  if (!state.cloudflare) return null;
  return state.customDomain ? `https://${state.customDomain}` : workersDevUrl(state);
}

// This installation's own client at login.kaboutersoft.be (the bootstrapper's):
// kept aside after a move away, else the sign-in while it still is that one.
export function startClientOf(state: InstallerState): SignInClient | undefined {
  const b = state.bootstrap;
  if (!b) return undefined;
  return b.startClient ?? (b.login && b.login.selfService !== false ? b.login : undefined);
}

// "Aanmelding wijzigen" under way: a provider staged (its test sign-in
// needs the installer's own address), or a switch that stopped half way.
// Once applied it no longer counts — undoing works through Arcanum too.
export const loginChangeActive = (state: InstallerState) => !!(state.loginChange?.staged || state.loginChange?.applied?.phase === 'started');

// Whether the installer's own address should be off: linked to Arcanum,
// not kept open on purpose, no login change under way.
export const directShouldClose = (state: InstallerState) => !!state.behindArcanum && !state.behindArcanum.keptOpen && !loginChangeActive(state);

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
