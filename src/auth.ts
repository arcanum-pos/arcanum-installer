// Password login for the setup page. The installer's workers.dev URL is
// public, and it holds a powerful Cloudflare token — so: constant-time
// password check, a lockout after repeated failures, and a signed,
// short-lived, HttpOnly session cookie (SameSite=Strict, so no other site
// can drive the API).
import type { Env } from './env';
import { hmac, randomBytes, safeEqual, toHex } from './crypto';

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

export function passwordMatches(env: Env, password: string): boolean {
  return !!env.INSTALLER_PASSWORD && safeEqual(password, env.INSTALLER_PASSWORD);
}

export async function newSessionCookie(env: Env): Promise<{ id: string; cookie: string }> {
  const id = toHex(randomBytes(16));
  const expires = Math.floor(Date.now() / 1000) + SESSION_TTL_S;
  const value = `${id}.${expires}`;
  const signature = await hmac(env.INSTALLER_PASSWORD, value);
  return { id, cookie: `${COOKIE}=${value}.${signature}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_TTL_S}` };
}

export const clearedCookie = `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;

// The session id, or null when there's no valid, unexpired session.
export async function sessionFrom(env: Env, request: Request): Promise<string | null> {
  const cookie = (request.headers.get('Cookie') ?? '').split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`));
  if (!cookie) return null;
  const [id, expires, signature] = cookie.slice(COOKIE.length + 1).split('.');
  if (!id || !expires || !signature || Number(expires) < Date.now() / 1000) return null;
  return safeEqual(signature, await hmac(env.INSTALLER_PASSWORD, `${id}.${expires}`)) ? id : null;
}
