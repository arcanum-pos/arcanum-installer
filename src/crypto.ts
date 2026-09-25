// Small crypto helpers. Everything the installer stores that could hurt
// (the Cloudflare token, the login provider's client secret, the generated
// Arcanum secrets) is AES-GCM-encrypted with a key derived from the
// INSTALLER_PASSWORD secret via HKDF — cheap enough for the Free plan's
// ~10 ms CPU per request (PBKDF2 with a real iteration count isn't). This
// protects against anyone who can only read the KV namespace; the secret
// itself lives in the Worker's encrypted secret store.

const enc = new TextEncoder();
const dec = new TextDecoder();

export function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// A generated Arcanum secret. `base64-32` is what ENCRYPTION_KEY must be
// (never hex: a hex string silently decodes to the wrong length).
export function generateSecret(format: string | undefined): string {
  if (format === 'base64-32') return toBase64(randomBytes(32));
  return toHex(randomBytes(32));
}

async function hkdfKey(secret: string, salt: string, info: string, usage: 'encrypt' | 'sign'): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', enc.encode(secret), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode(salt), info: enc.encode(info) },
    base,
    usage === 'encrypt' ? { name: 'AES-GCM', length: 256 } : { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    usage === 'encrypt' ? ['encrypt', 'decrypt'] : ['sign', 'verify']
  );
}

export interface Sealed {
  iv: string;
  data: string;
}

export async function seal(plaintext: string, password: string, salt: string): Promise<Sealed> {
  const key = await hkdfKey(password, salt, 'arcanum-installer:state', 'encrypt');
  const iv = randomBytes(12);
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plaintext)));
  return { iv: toBase64(iv), data: toBase64(data) };
}

export async function unseal(sealed: Sealed, password: string, salt: string): Promise<string> {
  const key = await hkdfKey(password, salt, 'arcanum-installer:state', 'encrypt');
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(sealed.iv) }, key, fromBase64(sealed.data));
  return dec.decode(plain);
}

export async function hmac(password: string, message: string): Promise<string> {
  const key = await hkdfKey(password, 'session', 'arcanum-installer:session', 'sign');
  return toHex(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message))));
}

// Constant-time comparison for passwords and signatures.
export function safeEqual(a: string, b: string): boolean {
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', data)));
}
