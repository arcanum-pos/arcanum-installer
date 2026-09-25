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

function unexpected(name: string, what: string, r: { status: number; body: Record<string, unknown> | null }): ClientCheck {
  const detail = r.status === 0 ? 'geen verbinding' : `HTTP ${r.status}${r.body?.error ? `, ${describe(r.body)}` : ''}`;
  return { name, ok: false, blocking: false, message: `Kon ${what} niet controleren (${detail}) — bewaard, maar kijk het na als aanmelden niet lukt.` };
}

export async function checkClients(input: Input): Promise<ClientCheck[]> {
  const checks: ClientCheck[] = [];
  const kassaType = input.isGoogle ? ' Is het een client van het type "TVs and Limited Input devices"?' : ' Mag deze client apparaat-aanmelding (device flow) gebruiken?';

  // 1. The kassa client: id, type and scopes.
  const device = await post(input.deviceEndpoint, { client_id: input.clientId, client_secret: input.clientSecret, scope: input.scopes });
  const deviceCode = typeof device.body?.device_code === 'string' ? device.body.device_code : null;
  if (deviceCode) {
    checks.push({ name: 'kassa-client', ok: true, blocking: false, message: 'Client voor de kassa aanvaard' });
  } else if (device.body?.error === 'invalid_scope') {
    checks.push({ name: 'kassa-client', ok: false, blocking: true, message: `De login-provider weigert deze scopes (${describe(device.body)}).${input.isGoogle ? ' Google aanvaardt geen offline_access — gebruik "openid profile email".' : ''}` });
  } else if (REFUSALS.has(String(device.body?.error))) {
    checks.push({ name: 'kassa-client', ok: false, blocking: true, message: `De login-provider weigert deze client voor de kassa (${describe(device.body)}).${kassaType}` });
  } else {
    checks.push(unexpected('kassa-client', 'de client voor de kassa', device));
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
    if (code === 'authorization_pending' || code === 'slow_down') checks.push({ name: 'kassa-secret', ok: true, blocking: false, message: 'Client secret voor de kassa klopt' });
    else if (REFUSALS.has(code)) checks.push({ name: 'kassa-secret', ok: false, blocking: true, message: `Het client secret voor de kassa klopt niet (${describe(token.body)}).` });
    else checks.push(unexpected('kassa-secret', 'het client secret voor de kassa', token));
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
    if (code === 'invalid_grant') checks.push({ name: 'browser-client', ok: true, blocking: false, message: 'Client voor aanmelden in de browser aanvaard' });
    else if (REFUSALS.has(code)) checks.push({ name: 'browser-client', ok: false, blocking: true, message: `De login-provider weigert de client voor aanmelden in de browser (${describe(token.body)}) — kijk client ID en secret na.` });
    else checks.push(unexpected('browser-client', 'de client voor aanmelden in de browser', token));
  }
  return checks;
}
