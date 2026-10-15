import { describe, expect, it } from 'vitest';
import { generateSecret, secretFits } from '../src/crypto';

describe('secretFits', () => {
  it('accepts a generated Web Push key and rejects the hex value an older installer stored', async () => {
    expect(await secretFits('p256-pkcs8', await generateSecret('p256-pkcs8'))).toBe(true);
    expect(await secretFits('p256-pkcs8', await generateSecret(undefined))).toBe(false);
    expect(await secretFits('p256-pkcs8', 'not base64!')).toBe(false);
  });

  it('never questions the other formats (ENCRYPTION_KEY must never change)', async () => {
    expect(await secretFits('base64-32', 'deadbeef')).toBe(true);
    expect(await secretFits(undefined, 'anything')).toBe(true);
  });
});
