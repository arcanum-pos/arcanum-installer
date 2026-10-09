// The installation's mail account (MAIL.md): Geavanceerd → E-mail. One
// service, its settings; kept sealed in the installer's state and given to
// arcanum-backend as the secret MAIL_CONFIG ({ provider, …settings }) —
// right away when the installation exists, and on every later upload.
//
// A service here = its fields; the mailer (arcanum-mailer src/providers)
// does the sending. A new service: its fields here, its texts in
// messages/*.ts (page.mailFields), its plug-in in the mailer.

export interface MailField {
  name: string;
  // A key or password: never sent back to the page; left empty = kept.
  secret?: boolean;
  optional?: boolean;
  number?: boolean;
  // Google's service account file (JSON): picked on the page, read there,
  // sent as its text; becomes clientEmail + privateKey (the key never shown).
  serviceAccountFile?: boolean;
}

export const MAIL_SERVICES: Record<string, MailField[]> = {
  smtp: [
    { name: 'host' },
    { name: 'port', number: true },
    { name: 'username' },
    { name: 'password', secret: true },
    { name: 'fromAddress' },
    { name: 'fromName', optional: true },
  ],
  gmail_api: [{ name: 'serviceAccount', secret: true, serviceAccountFile: true }, { name: 'impersonatedUser' }, { name: 'fromName', optional: true }],
  brevo: [{ name: 'apiKey', secret: true }, { name: 'fromAddress' }, { name: 'fromName', optional: true }],
  resend: [{ name: 'apiKey', secret: true }, { name: 'fromAddress' }, { name: 'fromName', optional: true }],
};

export type MailConfig = { provider: string } & Record<string, string | number>;

// The form's values (+ the previous config, whose secrets are kept when a
// secret field is left empty for the same service) → the config, or what's missing.
export function buildMailConfig(input: Record<string, unknown>, previous: MailConfig | null): { config: MailConfig } | { missing: string[] } {
  const provider = String(input.provider ?? '');
  const fields = MAIL_SERVICES[provider];
  if (!fields) return { missing: ['provider'] };
  const config: MailConfig = { provider };
  const missing: string[] = [];
  for (const f of fields) {
    if (f.serviceAccountFile) {
      const file = readServiceAccount(input[f.name]);
      if (file) Object.assign(config, file);
      else if (!input[f.name] && previous?.provider === provider && previous.clientEmail && previous.privateKey) Object.assign(config, { clientEmail: previous.clientEmail, privateKey: previous.privateKey });
      else missing.push(f.name);
      continue;
    }
    let value = typeof input[f.name] === 'string' ? (input[f.name] as string).trim() : typeof input[f.name] === 'number' ? String(input[f.name]) : '';
    if (!value && f.secret && previous?.provider === provider && previous[f.name]) value = String(previous[f.name]);
    if (!value) {
      if (!f.optional) missing.push(f.name);
      continue;
    }
    if (f.number) {
      const n = Number(value);
      if (!Number.isInteger(n) || n <= 0 || n > 65535) {
        missing.push(f.name);
        continue;
      }
      config[f.name] = n;
    } else config[f.name] = value;
  }
  return missing.length ? { missing } : { config };
}

// Google's service account JSON → what the mailer needs; null when it isn't one.
function readServiceAccount(text: unknown): { clientEmail: string; privateKey: string } | null {
  if (typeof text !== 'string' || !text.trim()) return null;
  try {
    const json = JSON.parse(text) as { type?: unknown; client_email?: unknown; private_key?: unknown };
    if (typeof json.client_email !== 'string' || typeof json.private_key !== 'string' || !json.private_key.includes('PRIVATE KEY')) return null;
    return { clientEmail: json.client_email, privateKey: json.private_key };
  } catch {
    return null;
  }
}

// What the page may see: the service, its plain values, which secrets are
// set — for Gmail the service account's address, never its key.
export function mailSummary(config: MailConfig | null) {
  if (!config) return null;
  const fields = MAIL_SERVICES[config.provider] ?? [];
  const values: Record<string, string> = Object.fromEntries(fields.filter((f) => !f.secret && config[f.name] !== undefined).map((f) => [f.name, String(config[f.name])]));
  if (config.clientEmail) values.clientEmail = String(config.clientEmail);
  return {
    provider: config.provider,
    values,
    secretsSet: fields.filter((f) => f.secret && (f.serviceAccountFile ? config.privateKey : config[f.name])).map((f) => f.name),
  };
}

// The old hand-set fallback (2026-10-06, the demo): gone once MAIL_CONFIG is set.
export const OLD_SMTP_SECRETS = ['DEFAULT_SMTP_HOST', 'DEFAULT_SMTP_PORT', 'DEFAULT_SMTP_USER', 'DEFAULT_SMTP_PASS', 'DEFAULT_SMTP_FROM_ADDRESS', 'DEFAULT_SMTP_FROM_NAME'];
