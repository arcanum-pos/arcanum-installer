// Tests the login provider's clients before anything is installed, using
// errors that tell a right client from a wrong one without anyone logging in:
//
//   kassa client  → device endpoint: a device code = right id, type and scopes
//                 → token endpoint with that code: "authorization_pending"
//                   (nobody approved it yet) = right secret
//   browser client → token endpoint with a made-up code: "invalid_grant"
//                   (bad code, accepted client) = right id and secret
//
// Only unambiguous refusals block saving (invalid_client,
// unauthorized_client, invalid_scope); an outage or an unexpected answer
// is a note, because providers differ. The unused device code just expires.
// What can't be tested this way: whether the callback URL is registered.
import type { Messages } from './i18n';

export interface ClientCheck {
  name: string;
  ok: boolean;
  blocking: boolean;
  message: string;
}

interface Input {
  deviceEndpoint: string;
  tokenEndpoint: string;
  isGoogle: boolean;
  clientId: string;
  clientSecret: string;
  scopes: string;
  authCode?: { clientId: string; clientSecret: string; redirectUri: string };
}

const REFUSALS = new Set(['invalid_client', 'unauthorized_client', 'invalid_scope']);

async function post(url: string, params: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> | null }> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(params).toString(),
    });
    return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
  } catch {
    return { status: 0, body: null };
  }
}

const describe = (body: Record<string, unknown> | null) => (body?.error_description ? `${body.error} — ${body.error_description}` : String(body?.error ?? ''));

function unexpected(t: Messages, name: string, what: string, r: { status: number; body: Record<string, unknown> | null }): ClientCheck {
  const detail = r.status === 0 ? t.checks.noConnection : `HTTP ${r.status}${r.body?.error ? `, ${describe(r.body)}` : ''}`;
  return { name, ok: false, blocking: false, message: t.checks.unchecked(what, detail) };
}

export async function checkClients(input: Input, t: Messages): Promise<ClientCheck[]> {
  const checks: ClientCheck[] = [];
  const kassaType = input.isGoogle ? t.checks.kassaTypeGoogle : t.checks.kassaTypeOther;

  // 1. The kassa client: id, type and scopes.
  const device = await post(input.deviceEndpoint, { client_id: input.clientId, client_secret: input.clientSecret, scope: input.scopes });
  const deviceCode = typeof device.body?.device_code === 'string' ? device.body.device_code : null;
  if (deviceCode) {
    checks.push({ name: 'kassa-client', ok: true, blocking: false, message: t.checks.kassaOk });
  } else if (device.body?.error === 'invalid_scope') {
    checks.push({ name: 'kassa-client', ok: false, blocking: true, message: t.checks.scopesRefused(describe(device.body)) + (input.isGoogle ? t.checks.googleScopes : '') });
  } else if (REFUSALS.has(String(device.body?.error))) {
    checks.push({ name: 'kassa-client', ok: false, blocking: true, message: t.checks.kassaRefused(describe(device.body)) + kassaType });
  } else {
    checks.push(unexpected(t, 'kassa-client', t.checks.kassaClient, device));
  }

  // 2. Its secret — only testable with a device code.
  if (deviceCode) {
    const token = await post(input.tokenEndpoint, {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: deviceCode,
      client_id: input.clientId,
      client_secret: input.clientSecret,
    });
    const code = String(token.body?.error ?? '');
    if (code === 'authorization_pending' || code === 'slow_down') checks.push({ name: 'kassa-secret', ok: true, blocking: false, message: t.checks.secretOk });
    else if (REFUSALS.has(code)) checks.push({ name: 'kassa-secret', ok: false, blocking: true, message: t.checks.secretWrong(describe(token.body)) });
    else checks.push(unexpected(t, 'kassa-secret', t.checks.kassaSecret, token));
  }

  // 3. The separate browser-login client, if any.
  if (input.authCode) {
    const token = await post(input.tokenEndpoint, {
      grant_type: 'authorization_code',
      code: 'arcanum-installer-check',
      redirect_uri: input.authCode.redirectUri,
      client_id: input.authCode.clientId,
      client_secret: input.authCode.clientSecret,
    });
    const code = String(token.body?.error ?? '');
    if (code === 'invalid_grant') checks.push({ name: 'browser-client', ok: true, blocking: false, message: t.checks.browserOk });
    else if (REFUSALS.has(code)) checks.push({ name: 'browser-client', ok: false, blocking: true, message: t.checks.browserRefused(describe(token.body)) });
    else checks.push(unexpected(t, 'browser-client', t.checks.browserClient, token));
  }
  return checks;
}
