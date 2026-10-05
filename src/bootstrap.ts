// The handoff from the bootstrapper (arcanum-bootstrapper,
// start.kaboutersoft.be). It uploads this installer onto the visitor's own
// Cloudflare account with one secret, BOOTSTRAP_CONFIG, and sends the
// browser to /handoff?code=… — the page posts the code to /api/handoff:
//
//   BOOTSTRAP_CONFIG = {
//     version: 1,
//     cloudflareToken, accountId, accountName, subdomain,
//     login: { issuer, clientId, clientSecret } | null,   // null: keep the one this installer has
//     owner: { email, sub },
//     handoffCodeHash,    // hex SHA-256 of the one-time code in the link
//     handoffExpiresAt,   // ISO time; the link works until then, once
//     instance?: { kind: 'single'|'admins'|'internal', channel: 'stable'|'dev' },
//                         // only from the bootstrapper for the platform's own
//                         // installations; absent: this installer's own stays
//   }
//
// A valid code imports the config into the state (the token sealed like a
// remembered one; the client as both Arcanum's login provider and this
// page's sign-in; the owner as admin), starts a session, and returns a new
// recovery code — shown once, the way in when the login provider can't be
// reached. The config's secrets are then replaced by a stub on the Worker,
// so the token lives only (sealed) in the state. A later handoff (the
// bootstrapper run again for this account) refreshes the token, adds the
// owner as admin and issues a new recovery code; it never replaces a login
// provider this installer already has. README.md documents the contract.
import type { Env } from './env';
import { Cloudflare } from './cloudflare';
import { randomBytes, safeEqual, sha256Hex } from './crypto';
import { newSessionCookie, normalizeRecoveryCode } from './auth';
import { installationStarted, isAdmin, sealValue, type InstallerState, type InstanceSettings } from './state';
import type { Messages } from './i18n';

export interface BootstrapConfig {
  version: 1;
  cloudflareToken: string;
  accountId: string;
  accountName: string;
  subdomain: string;
  login: { issuer: string; clientId: string; clientSecret: string } | null;
  owner: { email: string; sub: string };
  handoffCodeHash: string;
  handoffExpiresAt: string;
  instance?: InstanceSettings;
}

const KINDS = ['single', 'admins', 'internal'];
const CHANNELS = ['stable', 'dev'];

// What BOOTSTRAP_CONFIG becomes once imported: nothing left to hand over.
const IMPORTED_STUB = { version: 1, imported: true };

type Parsed = { config: BootstrapConfig } | { imported: true } | null;

export function readBootstrapConfig(env: Env): Parsed {
  if (!env.BOOTSTRAP_CONFIG) return null;
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(env.BOOTSTRAP_CONFIG);
  } catch {
    return null;
  }
  if (value?.version !== 1) return null;
  if (value.imported === true) return { imported: true };
  const text = (v: unknown) => typeof v === 'string' && v.length > 0;
  const owner = value.owner as BootstrapConfig['owner'] | undefined;
  const login = value.login as BootstrapConfig['login'] | undefined;
  const ok =
    text(value.cloudflareToken) && text(value.accountId) && text(value.subdomain) && text(value.handoffCodeHash) && text(value.handoffExpiresAt) &&
    !!owner && text(owner.email) && text(owner.sub) &&
    (login === null || (!!login && text(login.issuer) && text(login.clientId) && text(login.clientSecret))) &&
    (value.instance === undefined || (KINDS.includes((value.instance as InstanceSettings)?.kind) && CHANNELS.includes((value.instance as InstanceSettings)?.channel)));
  return ok ? { config: value as unknown as BootstrapConfig } : null;
}

// Whether this installer came from the bootstrapper at all (before or after the handoff).
export const isBootstrapped = (env: Env, state: InstallerState) => !!state.bootstrap || readBootstrapConfig(env) !== null;

// 20 characters from 32 unambiguous ones (100 bits), as XXXX-XXXX-XXXX-XXXX-XXXX.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function newRecoveryCode(): string {
  const chars = [...randomBytes(20)].map((b) => ALPHABET[b & 31]).join('');
  return chars.match(/.{4}/g)!.join('-');
}

export type HandoffOutcome =
  | { ok: true; recoveryCode: string; email: string; cookie: string; firstImport: boolean }
  | { ok: false; status: number; error: string; reason: 'none' | 'used' | 'expired' | 'wrong' | 'account' };

export async function handoff(env: Env, state: InstallerState, code: string, installerScript: string, t: Messages): Promise<HandoffOutcome> {
  const parsed = readBootstrapConfig(env);
  const used = { ok: false as const, status: 410, reason: 'used' as const, error: t.handoff.used };
  if (!parsed) return { ok: false, status: 404, reason: 'none', error: t.handoff.none };
  if ('imported' in parsed) return used;
  const { config } = parsed;
  if (state.bootstrap?.handoffs.includes(config.handoffCodeHash)) return used;
  if (!code || !safeEqual(await sha256Hex(new TextEncoder().encode(code)), config.handoffCodeHash)) {
    return { ok: false, status: 401, reason: 'wrong', error: t.handoff.wrong };
  }
  if (!(Date.parse(config.handoffExpiresAt) > Date.now())) {
    return { ok: false, status: 410, reason: 'expired', error: t.handoff.expired };
  }
  if (state.cloudflare && installationStarted(state) && state.cloudflare.accountId !== config.accountId) {
    return { ok: false, status: 409, reason: 'account', error: t.handoff.otherAccount(state.cloudflare.accountName, config.accountName) };
  }

  const firstImport = !state.bootstrap;
  const owner = { email: config.owner.email.trim().toLowerCase(), sub: config.owner.sub };
  state.cloudflare = {
    accountId: config.accountId,
    accountName: config.accountName,
    subdomain: config.subdomain,
    remember: true,
    token: await sealValue(env, state, config.cloudflareToken),
  };
  const login = config.login
    ? { issuer: config.login.issuer.replace(/\/+$/, ''), clientId: config.login.clientId, clientSecret: await sealValue(env, state, config.login.clientSecret) }
    : state.bootstrap?.login;
  // Arcanum's own login provider starts as the same client — unless this
  // installer already has one (set under "Geavanceerd").
  if (login && !state.login) {
    state.login = { issuer: login.issuer, clientId: login.clientId, clientSecret: login.clientSecret, authorizationEndpoint: `${login.issuer}/authorize` };
  }
  if (!isAdmin(state, owner.email)) {
    state.admins = [state.admins, owner.email].filter(Boolean).join(', ');
    // Installed already: the backend gets the new list with "Verder installeren".
    if (state.installed) for (const step of ['worker:arcanum-backend', 'verify']) delete state.steps[step];
  }
  // The kind of installation and its channel, when the bootstrapper says
  // (the platform's own installations). Another kind on an installed one:
  // the backend gets its ORG_CREATION with "Verder installeren".
  if (config.instance) {
    if (state.installed && state.instance?.kind !== config.instance.kind && (state.instance || config.instance.kind !== 'single')) {
      for (const step of ['worker:arcanum-backend', 'verify']) delete state.steps[step];
    }
    state.instance = { kind: config.instance.kind, channel: config.instance.channel };
  }
  const recoveryCode = newRecoveryCode();
  state.bootstrap = {
    importedAt: state.bootstrap?.importedAt ?? new Date().toISOString(),
    owner: state.bootstrap?.owner ?? owner,
    login,
    handoffs: [...(state.bootstrap?.handoffs ?? []), config.handoffCodeHash].slice(-20),
    recoveryHash: await sha256Hex(new TextEncoder().encode(normalizeRecoveryCode(recoveryCode))),
  };

  // The token (and client secret) now live sealed in the state; take them
  // off the Worker. Not fatal: the handoff code is spent either way.
  try {
    await new Cloudflare(config.cloudflareToken, env.CLOUDFLARE_API_BASE).putSecret(config.accountId, installerScript, 'BOOTSTRAP_CONFIG', JSON.stringify(IMPORTED_STUB));
  } catch (err) {
    console.warn('arcanum-installer: could not replace BOOTSTRAP_CONFIG after the handoff', (err as Error).message);
  }
  const session = await newSessionCookie(env, owner.email);
  return { ok: true, recoveryCode, email: owner.email, cookie: session.cookie, firstImport };
}
