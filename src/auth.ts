// Sessions for the setup page on the installer's own address. That address
// is public until the installer moves behind Arcanum, and it holds a
// powerful Cloudflare token — so: a constant-time recovery-code check, a
// lockout after repeated failures, and a signed, short-lived, HttpOnly
// session cookie (SameSite=Strict, so no other site can drive the API).
// Ways in: signing in with an admin's account (oidc.ts), the handoff
// (bootstrap.ts) or the recovery code.
import type { Env } from './env';
import { hmac, randomBytes, safeEqual, sha256Hex, toHex } from './crypto';
import { rootSecret, type InstallerState } from './state';

const COOKIE = 'arcanum_installer';
const SESSION_TTL_S = 2 * 60 * 60;
const MAX_FAILURES = 10;
const LOCKOUT_S = 15 * 60;

export async function checkLoginAllowed(env: Env, ip: string): Promise<boolean> {
  const failures = Number((await env.INSTALLER_STATE.get(`login-failures:${ip}`)) ?? 0);
  return failures < MAX_FAILURES;
}

export async function recordLoginFailure(env: Env, ip: string): Promise<void> {
  const key = `login-failures:${ip}`;
  const failures = Number((await env.INSTALLER_STATE.get(key)) ?? 0);
  await env.INSTALLER_STATE.put(key, String(failures + 1), { expirationTtl: LOCKOUT_S });
}

// "ABCD-EFGH-…", however it's typed back (case, spaces, dashes).
export const normalizeRecoveryCode = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, '');

export async function recoveryCodeMatches(state: InstallerState, code: string): Promise<boolean> {
  const hash = state.bootstrap?.recoveryHash;
  const normalized = normalizeRecoveryCode(code);
  return !!hash && normalized.length >= 20 && safeEqual(await sha256Hex(new TextEncoder().encode(normalized)), hash);
}

// A new session; `email` (who signed in, when known) is shown on the page.
export async function newSessionCookie(env: Env, email?: string): Promise<{ id: string; cookie: string }> {
  const id = toHex(randomBytes(16));
  const expires = Math.floor(Date.now() / 1000) + SESSION_TTL_S;
  const value = `${id}.${expires}`;
  const signature = await hmac(rootSecret(env), value);
  if (email) await env.INSTALLER_STATE.put(`session-email:${id}`, email, { expirationTtl: SESSION_TTL_S });
  return { id, cookie: `${COOKIE}=${value}.${signature}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_TTL_S}` };
}

export const sessionEmail = (env: Env, id: string) => env.INSTALLER_STATE.get(`session-email:${id}`);

export const clearedCookie = `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;

// The session id, or null when there's no valid, unexpired session.
export async function sessionFrom(env: Env, request: Request): Promise<string | null> {
  const cookie = (request.headers.get('Cookie') ?? '').split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`));
  if (!cookie) return null;
  const [id, expires, signature] = cookie.slice(COOKIE.length + 1).split('.');
  if (!id || !expires || !signature || Number(expires) < Date.now() / 1000) return null;
  return safeEqual(signature, await hmac(rootSecret(env), `${id}.${expires}`)) ? id : null;
}
