// The installer's texts: fr and en have exactly nl's messages (no missing or
// extra key, no empty text, functions with the same parameters), the page
// texts keep nl's markup (the script fills the elements in them), and the
// script's texts are plain strings with nl's {placeholders}.
import { describe, expect, it } from 'vitest';
import { localeOf, MESSAGES, type Messages } from '../src/i18n';

function shapeProblems(source: unknown, other: unknown, path: string): string[] {
  if (typeof source !== typeof other) return [`${path}: ${typeof other}, expected ${typeof source}`];
  if (typeof source === 'string') return (other as string).trim() ? [] : [`${path}: empty`];
  if (typeof source === 'function') {
    const [a, b] = [source as (...args: unknown[]) => unknown, other as (...args: unknown[]) => unknown];
    if (a.length !== b.length) return [`${path}: takes ${b.length} arguments, expected ${a.length}`];
    const sample = Array.from({ length: a.length }, (_, i) => `x${i}`);
    return String(b(...sample)).trim() ? [] : [`${path}: empty`];
  }
  const [a, b] = [source as Record<string, unknown>, other as Record<string, unknown>];
  return [
    ...Object.keys(a).filter((k) => !(k in b)).map((k) => `${path}.${k}: missing`),
    ...Object.keys(b).filter((k) => !(k in a)).map((k) => `${path}.${k}: not in nl`),
    ...Object.keys(a).filter((k) => k in b).flatMap((k) => shapeProblems(a[k], b[k], `${path}.${k}`)),
  ];
}

// The elements in a text, with their attributes: `<code data-callback>`, `</code>`, `<br>`, …
const markup = (text: string) => text.match(/<[^>]+>/g) ?? [];
const placeholders = (text: string) => (text.match(/[{][a-zA-Z]+[}]/g) ?? []).sort();

describe.each(['fr', 'en'] as const)('%s messages', (locale) => {
  const nl = MESSAGES.nl;
  const other: Messages = MESSAGES[locale];

  it('has exactly the nl messages, none empty', () => {
    expect(shapeProblems(nl, other, locale)).toEqual([]);
  });

  it('keeps the markup of every page text', () => {
    for (const key of Object.keys(nl.page) as (keyof Messages['page'])[]) {
      expect(markup(other.page[key]), key).toEqual(markup(nl.page[key]));
    }
  });

  it("gives the script plain strings with nl's placeholders", () => {
    for (const key of Object.keys(nl.script) as (keyof Messages['script'])[]) {
      expect(typeof other.script[key], key).toBe('string');
      expect(placeholders(other.script[key]), key).toEqual(placeholders(nl.script[key]));
    }
  });

  it('needs no escaping in attributes and CSS', () => {
    // Used as placeholder="…", title="…", aria-label="…" and content: "…".
    for (const key of ['title', 'language', 'done', 'customDomainPlaceholder', 'emailsPlaceholder', 'clientId', 'clientSecret', 'freeSoftware', 'installerVersion'] as const) {
      expect(other.page[key], key).not.toMatch(/["<>&\\]/);
    }
  });
});

describe('the language of a request', () => {
  const req = (url: string, acceptLanguage?: string) => new Request(url, acceptLanguage ? { headers: { 'Accept-Language': acceptLanguage } } : {});

  it('is ?lang=, else the first language we speak in Accept-Language, else Dutch', () => {
    expect(localeOf(req('https://i.test/'))).toBe('nl');
    expect(localeOf(req('https://i.test/', 'fr-BE,fr;q=0.9,en;q=0.8'))).toBe('fr');
    expect(localeOf(req('https://i.test/', 'de-DE,en-GB;q=0.8'))).toBe('en');
    expect(localeOf(req('https://i.test/', 'de-DE,es'))).toBe('nl');
    expect(localeOf(req('https://i.test/?lang=en', 'fr-BE'))).toBe('en');
    expect(localeOf(req('https://i.test/?lang=xx', 'fr-BE'))).toBe('fr');
  });
});
