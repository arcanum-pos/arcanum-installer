// Property-based tests (fast-check) for what the installer reads from
// outside: release versions, what an admin types, tokens from the login
// provider, Docker's answers, and its own sealed state.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { publicUrlAllowed, suggestSubdomain } from '../src/api';
import { normalizeRecoveryCode } from '../src/auth';
import { fromBase64, safeEqual, seal, toBase64, unseal } from '../src/crypto';
import { demuxLogs, splitImage } from '../src/docker/client';
import { publishOf } from '../src/docker/containers';
import { sendsFrom } from '../src/mail';
import { base64url, claimsOf } from '../src/oidc';
import { compareVersions } from '../src/releases';
import { normalizePhone } from '../src/sms';

describe('compareVersions', () => {
  const pre = fc.array(fc.oneof(fc.nat({ max: 20 }).map(String), fc.constantFrom('dev', 'rc', 'beta')), { minLength: 1, maxLength: 3 }).map((p) => p.join('.'));
  const version = fc.tuple(fc.nat({ max: 3 }), fc.nat({ max: 3 }), fc.nat({ max: 120 }), fc.option(pre, { nil: undefined })).map(([a, b, c, p]) => `${a}.${b}.${c}${p ? `-${p}` : ''}`);

  it('a total order: reflexive, antisymmetric, transitive', () => {
    fc.assert(
      fc.property(version, version, version, (a, b, c) => {
        expect(compareVersions(a, a)).toBe(0);
        expect(compareVersions(a, b)).toBe(-compareVersions(b, a) || 0);
        if (compareVersions(a, b) <= 0 && compareVersions(b, c) <= 0) expect(compareVersions(a, c)).toBeLessThanOrEqual(0);
      }),
    );
  });

  it('a release above every pre-release of it, below the next patch', () => {
    fc.assert(
      fc.property(fc.nat({ max: 3 }), fc.nat({ max: 120 }), pre, (minor, patch, p) => {
        const release = `0.${minor}.${patch}`;
        expect(compareVersions(`${release}-${p}`, release)).toBe(-1);
        expect(compareVersions(release, `0.${minor}.${patch + 1}-${p}`)).toBe(-1);
      }),
    );
  });

  it('dev builds count numerically (dev.10 after dev.9)', () => {
    fc.assert(
      fc.property(fc.nat({ max: 1000 }), fc.nat({ max: 1000 }), (x, y) => {
        expect(compareVersions(`0.1.1-dev.${x}`, `0.1.1-dev.${y}`)).toBe(Math.sign(x - y) || 0);
      }),
    );
  });
});

describe('what an admin types', () => {
  it('suggestSubdomain: a usable subdomain for any account name', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'grapheme', maxLength: 80 }), (name) => {
        expect(suggestSubdomain(name)).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
        expect(suggestSubdomain(name).length).toBeLessThanOrEqual(40);
      }),
    );
  });

  it('normalizePhone: null or E.164 in an allowed country, idempotent', () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.stringMatching(/^(\+|00|0)?[0-9 ./()-]{6,20}$/), fc.anything()), (raw) => {
        const phone = normalizePhone(raw, ['+32']);
        if (phone === null) return;
        expect(phone).toMatch(/^\+32\d{6,13}$/);
        expect(normalizePhone(phone, ['+32'])).toBe(phone);
      }),
    );
  });

  it('a recovery code matches however it is typed back', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[A-Z0-9]{4}(-[A-Z0-9]{4}){3}$/), fc.constantFrom('', ' ', '-', '  '), fc.boolean(), (code, sep, lower) => {
        const typed = code.replace(/-/g, sep);
        expect(normalizeRecoveryCode(lower ? typed.toLowerCase() : typed)).toBe(normalizeRecoveryCode(code));
      }),
    );
    fc.assert(
      fc.property(fc.string(), (s) => {
        expect(normalizeRecoveryCode(normalizeRecoveryCode(s))).toBe(normalizeRecoveryCode(s));
      }),
    );
  });

  it('sendsFrom: an address always sends from its own domain, a wildcard covers subdomains only', () => {
    fc.assert(
      fc.property(fc.emailAddress(), fc.domain(), (address, other) => {
        const domain = address.split('@').pop()!;
        expect(sendsFrom(address, [domain.toUpperCase().toLowerCase()])).toBe(true);
        expect(sendsFrom(`x@sub.${other}`, [`*.${other}`])).toBe(true);
        expect(sendsFrom(`x@${other}`, [`*.${other}`])).toBe(false);
        expect(sendsFrom(`x@evil${other}`, [`*.${other}`])).toBe(false);
      }),
    );
  });

  it('publicUrlAllowed: https, or http on this machine only', () => {
    fc.assert(
      fc.property(fc.webUrl(), (text) => {
        const url = new URL(text);
        expect(publicUrlAllowed(url)).toBe(url.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(url.hostname));
      }),
    );
  });

  it('publishOf: a port, with or without an address, read back as given', () => {
    fc.assert(
      fc.property(fc.option(fc.oneof(fc.ipV4(), fc.ipV6().map((a) => `[${a}]`)), { nil: undefined }), fc.integer({ min: 1, max: 65535 }), (host, port) => {
        const out = publishOf(host ? `${host}:${port}` : String(port));
        expect(out).toEqual({ ...(host ? { HostIp: host.replace(/^\[|\]$/g, '') } : {}), HostPort: String(port) });
      }),
    );
    fc.assert(
      fc.property(fc.string(), (value) => {
        const out = publishOf(value);
        if (out) expect(out.HostPort).toMatch(/^\d{1,5}$/);
      }),
    );
  });
});

describe('docker', () => {
  it('splitImage: name and tag back to the reference; no tag is latest', () => {
    const part = fc.stringMatching(/^[a-z0-9][a-z0-9._-]{0,15}$/);
    fc.assert(
      fc.property(fc.option(fc.constantFrom('ghcr.io', 'localhost:5000', 'registry.test:443'), { nil: undefined }), fc.array(part, { minLength: 1, maxLength: 3 }), fc.option(part, { nil: undefined }), (registry, path, tag) => {
        const name = [registry, ...path].filter(Boolean).join('/');
        const ref = tag ? `${name}:${tag}` : name;
        expect(splitImage(ref)).toEqual({ name, tag: tag ?? 'latest' });
      }),
    );
  });

  it('demuxLogs: the frames of a log stream back to its text, however it was split', () => {
    const frame = (stream: number, bytes: Uint8Array) => {
      const out = new Uint8Array(8 + bytes.length);
      out[0] = stream;
      new DataView(out.buffer).setUint32(4, bytes.length);
      out.set(bytes, 8);
      return out;
    };
    fc.assert(
      fc.property(fc.string({ unit: 'grapheme', minLength: 1 }), fc.array(fc.nat(), { maxLength: 5 }), fc.constantFrom(1, 2), (text, cuts, stream) => {
        const bytes = new TextEncoder().encode(text);
        const at = [...new Set(cuts.map((c) => c % bytes.length))].sort((a, b) => a - b);
        const chunks = [0, ...at].map((start, i, all) => bytes.slice(start, all[i + 1] ?? bytes.length)).filter((c) => c.length);
        const stream_ = chunks.map((c) => frame(stream, c));
        const all = new Uint8Array(stream_.reduce((n, f) => n + f.length, 0));
        stream_.reduce((offset, f) => (all.set(f, offset), offset + f.length), 0);
        expect(demuxLogs(all)).toBe(text);
      }),
    );
  });

  it('demuxLogs ends on any bytes, frame sizes of 2 GB and more included', () => {
    fc.assert(
      fc.property(fc.constantFrom(0, 1, 2), fc.uint8Array({ minLength: 4, maxLength: 4 }), fc.uint8Array({ maxLength: 40 }), (stream, size, rest) => {
        demuxLogs(new Uint8Array([stream, 0, 0, 0, ...size, ...rest]));
      }),
    );
  });
});

describe('tokens and sealed state', () => {
  it('claimsOf reads back any claims (accents included) and never throws', () => {
    const part = (value: unknown) => base64url(new TextEncoder().encode(JSON.stringify(value)));
    fc.assert(
      fc.property(fc.record({ iss: fc.webUrl(), sub: fc.string(), email: fc.emailAddress(), name: fc.string({ unit: 'grapheme' }) }), (claims) => {
        expect(claimsOf(`${part({ alg: 'RS256' })}.${part(claims)}.sig`)).toEqual(claims);
      }),
    );
    fc.assert(
      fc.property(fc.string(), (token) => {
        claimsOf(token);
      }),
    );
  });

  it('base64 round-trips any bytes; safeEqual agrees with ===', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 200 }), fc.string(), fc.string(), (bytes, a, b) => {
        expect(fromBase64(toBase64(bytes))).toEqual(bytes);
        expect(safeEqual(a, b)).toBe(a === b);
      }),
    );
  });

  it('seal/unseal round-trips any text; another password or salt cannot open it', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ unit: 'grapheme' }), fc.string({ minLength: 1 }), fc.string(), async (text, password, salt) => {
        const sealed = await seal(text, password, salt);
        expect(await unseal(sealed, password, salt)).toBe(text);
        await expect(unseal(sealed, `${password}x`, salt)).rejects.toThrow();
        await expect(unseal(sealed, password, `${salt}x`)).rejects.toThrow();
      }),
      { numRuns: 30 },
    );
  });
});
