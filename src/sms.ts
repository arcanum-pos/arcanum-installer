// The installation's SMS account (MESSAGING.md): Geavanceerd → Sms. Twilio,
// its settings, the countries numbers may be from and a daily maximum; kept
// sealed in the installer's state and given to arcanum-backend as the
// secret MESSAGING_CONFIG — right away when the installation exists, and
// on every later upload. arcanum-backend does the sending (messaging.ts);
// the installer only checks the account and sends a test SMS.

export interface SmsConfig {
  provider: 'twilio';
  accountSid: string;
  apiKeySid?: string;
  authToken: string;
  sender: string;
  countries: string[];
  dailyCap: number;
}

export const DEFAULT_COUNTRIES = ['+32'];
export const DEFAULT_DAILY_CAP = 300;
const MAX_DAILY_CAP = 100_000;

// The form's values (+ the previous config, whose token is kept when left
// empty) → the config, or which fields are missing or wrong.
export function buildSmsConfig(input: Record<string, unknown>, previous: SmsConfig | null): { config: SmsConfig } | { missing: string[] } {
  const str = (name: string) => (typeof input[name] === 'string' ? (input[name] as string).trim() : typeof input[name] === 'number' ? String(input[name]) : '');
  const missing: string[] = [];
  const accountSid = str('accountSid');
  if (!/^AC[0-9a-f]{32}$/i.test(accountSid)) missing.push('accountSid');
  const apiKeySid = str('apiKeySid');
  if (apiKeySid && !/^SK[0-9a-f]{32}$/i.test(apiKeySid)) missing.push('apiKeySid');
  const authToken = str('authToken') || (previous && previous.accountSid === accountSid && (previous.apiKeySid ?? '') === apiKeySid ? previous.authToken : '');
  if (!authToken) missing.push('authToken');
  const sender = str('sender');
  // A number (+32…), a Messaging Service (MG…), or a name of up to 11 letters and digits.
  if (!/^(\+\d{8,15}|MG[0-9a-f]{32}|[A-Za-z0-9 ]{1,11})$/i.test(sender) || /^\d+$/.test(sender)) missing.push('sender');
  const countriesText = str('countries');
  const countries = countriesText ? countriesText.split(/[\s,;]+/).filter(Boolean).map((c) => (c.startsWith('+') ? c : `+${c}`)) : DEFAULT_COUNTRIES;
  if (!countries.length || countries.some((c) => !/^\+\d{1,4}$/.test(c))) missing.push('countries');
  const capText = str('dailyCap');
  const dailyCap = capText ? Number(capText) : DEFAULT_DAILY_CAP;
  if (!Number.isInteger(dailyCap) || dailyCap < 0 || dailyCap > MAX_DAILY_CAP) missing.push('dailyCap');
  if (missing.length) return { missing };
  return { config: { provider: 'twilio', accountSid, ...(apiKeySid ? { apiKeySid } : {}), authToken, sender, countries: [...new Set(countries)], dailyCap } };
}

// What the page may see: everything but the token.
export function smsSummary(config: SmsConfig | null) {
  if (!config) return null;
  return {
    provider: config.provider,
    values: { accountSid: config.accountSid, apiKeySid: config.apiKeySid ?? '', sender: config.sender, countries: config.countries.join(', '), dailyCap: String(config.dailyCap) },
    secretsSet: ['authToken'],
  };
}

const auth = (c: SmsConfig) => `Basic ${btoa(`${c.apiKeySid || c.accountSid}:${c.authToken}`)}`;
const TWILIO = 'https://api.twilio.com/2010-04-01/Accounts';

// Does Twilio take these credentials? null when it does, else its reason.
export async function checkTwilio(config: SmsConfig): Promise<string | null> {
  try {
    const res = await fetch(`${TWILIO}/${encodeURIComponent(config.accountSid)}.json`, { headers: { Authorization: auth(config) } });
    if (res.ok) return null;
    const data = (await res.json().catch(() => ({}))) as { message?: string };
    return `${res.status}: ${data.message ?? res.statusText}`;
  } catch (err) {
    return String(err);
  }
}

// A test SMS, straight from the installer to the number given.
export async function sendTestSms(config: SmsConfig, to: string, body: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const form = new URLSearchParams({ To: to, Body: body });
  if (/^MG[0-9a-f]{32}$/i.test(config.sender)) form.set('MessagingServiceSid', config.sender);
  else form.set('From', config.sender);
  try {
    const res = await fetch(`${TWILIO}/${encodeURIComponent(config.accountSid)}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: auth(config), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
    });
    if (res.ok) return { ok: true };
    const data = (await res.json().catch(() => ({}))) as { message?: string; code?: number };
    return { ok: false, error: `${res.status}${data.code ? ` ${data.code}` : ''}: ${data.message ?? res.statusText}` };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// A number as typed → E.164 in one of the allowed countries (the first is
// the default for a national number, 0470…), or null — like the backend's.
export function normalizePhone(raw: unknown, countries: string[]): string | null {
  if (typeof raw !== 'string') return null;
  let n = raw.trim().replace(/[\s./()-]/g, '');
  if (n.startsWith('00')) n = `+${n.slice(2)}`;
  else if (/^0\d/.test(n)) n = `${countries[0] ?? '+32'}${n.slice(1)}`;
  if (!/^\+\d{8,15}$/.test(n)) return null;
  return countries.some((c) => n.startsWith(c)) ? n : null;
}
