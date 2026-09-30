// The installation's own OAuth client at arcanum-auth (login.kaboutersoft.be),
// managed with its own credentials — never the admin key (arcanum-auth
// src/clients.ts): GET /clients/self, then PATCH /clients/self with the
// lists it should have. PATCH replaces a list, so this adds to what's there:
// the workers.dev callback and logout URL keep working next to the domain's.

import { TextError } from './i18n';

export class AuthClientError extends TextError {}

export async function addClientUris(
  issuer: string,
  client: { id: string; secret: string },
  add: { redirectUris: string[]; postLogoutRedirectUris: string[] }
): Promise<{ added: string[] }> {
  const headers = {
    Authorization: `Basic ${btoa(`${encodeURIComponent(client.id)}:${encodeURIComponent(client.secret)}`)}`,
    Accept: 'application/json',
  };
  const current = await fetch(`${issuer}/clients/self`, { headers });
  if (!current.ok) throw new AuthClientError((t) => t.authClient.refused(issuer, current.status));
  const now = (await current.json()) as { redirect_uris: string[]; post_logout_redirect_uris: string[] };
  const redirects = [...new Set([...now.redirect_uris, ...add.redirectUris])];
  const logouts = [...new Set([...now.post_logout_redirect_uris, ...add.postLogoutRedirectUris])];
  const added = [...redirects.filter((u) => !now.redirect_uris.includes(u)), ...logouts.filter((u) => !now.post_logout_redirect_uris.includes(u))];
  if (added.length === 0) return { added };
  const res = await fetch(`${issuer}/clients/self`, {
    method: 'PATCH',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ redirect_uris: redirects, post_logout_redirect_uris: logouts }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new AuthClientError((t) => t.authClient.notAdded(issuer, `${res.status}${body?.error ? `: ${body.error}` : ''}`));
  }
  return { added };
}
