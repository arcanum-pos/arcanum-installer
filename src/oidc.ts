// Signing admins in to a bootstrapped installer with their account: OIDC
// authorization code + PKCE against the login provider the bootstrapper
// handed over (state.bootstrap.login — login.kaboutersoft.be, with this
// installation's own client), callback /auth/callback. Who may: the same
// allowlist as Arcanum's instance admins (state.ts isAdmin), and only with
// a verified e-mail address. The id_token comes straight from the token
// endpoint over TLS, so iss/aud/nonce are checked without verifying its
// signature (OIDC Core §3.1.3.7) — like the bootstrapper does.
import type { Env } from './env';
import { newSessionCookie } from './auth';
import { randomBytes, safeEqual, toBase64 } from './crypto';
import { isAdmin, loadState, unsealValue, type InstallerState } from './state';

export const CALLBACK_PATH = '/auth/callback';
const PENDING_COOKIE = 'arcanum_installer_oidc';
const PENDING_TTL_S = 600;

export const base64url = (bytes: Uint8Array) => toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const random = (n: number) => base64url(randomBytes(n));

export async function discovery(issuer: string): Promise<{ authorization_endpoint: string; token_endpoint: string } | null> {
  const res = await fetch(`${issuer}/.well-known/openid-configuration`).catch(() => null);
  const doc = res?.ok ? ((await res.json().catch(() => null)) as Record<string, unknown> | null) : null;
  return doc && typeof doc.authorization_endpoint === 'string' && typeof doc.token_endpoint === 'string'
    ? { authorization_endpoint: doc.authorization_endpoint, token_endpoint: doc.token_endpoint }
    : null;
}

const redirect = (location: string, cookies: string[] = []) => {
  const headers = new Headers({ Location: location, 'Cache-Control': 'no-store' });
  for (const c of cookies) headers.append('Set-Cookie', c);
  return new Response(null, { status: 302, headers });
};

// Back to the page with a reason it shows (ui.ts reads ?fout=).
const failed = (reason: string, extra: Record<string, string> = {}) =>
  redirect(`/?${new URLSearchParams({ fout: reason, ...extra })}`, [`${PENDING_COOKIE}=; Path=/auth; HttpOnly; Secure; SameSite=Lax; Max-Age=0`]);

// "https://x.eu.auth0.com/" (Auth0's iss) is the issuer "https://x.eu.auth0.com".
export const sameIssuer = (a: unknown, b: string) => typeof a === 'string' && a.replace(/\/+$/, '') === b.replace(/\/+$/, '');

export const pkceChallenge = async (verifier: string) => base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));

export const canSignInWithAccount = (state: InstallerState) => !!state.bootstrap?.login;

export async function startSignIn(request: Request, env: Env): Promise<Response> {
  const state = await loadState(env);
  const login = state.bootstrap?.login;
  if (!login) return failed('geen-account-aanmelding');
  const provider = await discovery(login.issuer);
  if (!provider) return failed('provider-onbereikbaar');
  const pending = random(24);
  const verifier = random(48);
  const nonce = random(16);
  await env.INSTALLER_STATE.put(`oidc-pending:${pending}`, JSON.stringify({ verifier, nonce }), { expirationTtl: PENDING_TTL_S });
  const target = new URL(provider.authorization_endpoint);
  target.search = new URLSearchParams({
    response_type: 'code',
    client_id: login.clientId,
    redirect_uri: `${new URL(request.url).origin}${CALLBACK_PATH}`,
    scope: 'openid profile email',
    state: pending,
    nonce,
    code_challenge: await pkceChallenge(verifier),
    code_challenge_method: 'S256',
  }).toString();
  // Ties the answer to this browser (SameSite=Lax: sent on the provider's redirect back).
  return redirect(target.toString(), [`${PENDING_COOKIE}=${pending}; Path=/auth; HttpOnly; Secure; SameSite=Lax; Max-Age=${PENDING_TTL_S}`]);
}

export function claimsOf(idToken: string): Record<string, unknown> | null {
  try {
    const part = idToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(part + '='.repeat((4 - (part.length % 4)) % 4)), (c) => c.charCodeAt(0))));
  } catch {
    return null;
  }
}

export async function finishSignIn(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const pending = url.searchParams.get('state') ?? '';
  const cookie = (request.headers.get('Cookie') ?? '').split(/;\s*/).find((c) => c.startsWith(`${PENDING_COOKIE}=`))?.slice(PENDING_COOKIE.length + 1);
  const saved = pending ? await env.INSTALLER_STATE.get<{ verifier: string; nonce: string }>(`oidc-pending:${pending}`, 'json') : null;
  if (pending) await env.INSTALLER_STATE.delete(`oidc-pending:${pending}`);
  if (!saved || !cookie || !safeEqual(cookie, pending)) return failed('aanmelden-verlopen');
  const code = url.searchParams.get('code');
  if (!code) return failed('aanmelden-geweigerd');

  const state = await loadState(env);
  const login = state.bootstrap?.login;
  const provider = login ? await discovery(login.issuer) : null;
  if (!login || !provider) return failed('provider-onbereikbaar');
  const res = await fetch(provider.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: `${url.origin}${CALLBACK_PATH}`,
      client_id: login.clientId,
      client_secret: await unsealValue(env, state, login.clientSecret),
      code_verifier: saved.verifier,
    }).toString(),
  }).catch(() => null);
  const tokens = res?.ok ? ((await res.json().catch(() => null)) as { id_token?: string } | null) : null;
  const claims = tokens?.id_token ? claimsOf(tokens.id_token) : null;
  const audience = Array.isArray(claims?.aud) ? claims.aud : [claims?.aud];
  if (!claims || !sameIssuer(claims.iss, login.issuer) || !audience.includes(login.clientId) || claims.nonce !== saved.nonce) return failed('aanmelden-mislukt');
  const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '';
  if (!email || claims.email_verified !== true) return failed('niet-bevestigd');
  if (!isAdmin(state, email)) return failed('geen-beheerder', { email });
  const session = await newSessionCookie(env, email);
  return redirect('/', [session.cookie, `${PENDING_COOKIE}=; Path=/auth; HttpOnly; Secure; SameSite=Lax; Max-Age=0`]);
}
