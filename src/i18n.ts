// The installer in Dutch, French and English. One typed table per language
// (src/messages/{nl,fr,en}.ts; nl is the source, fr/en have the same keys),
// no i18n library — like arcanum-frontends.
//
// Which language: `?lang=` (the page's NL · FR · EN picker; the choice is
// also remembered in the browser, and the page puts it back in the URL),
// else the Accept-Language header — the browser's own for the page itself,
// the page's language for its API calls (it sets the header on every fetch;
// Arcanum's bff forwards it unchanged at /installer/*) — else Dutch.
import nl, { type Messages } from './messages/nl';
import fr from './messages/fr';
import en from './messages/en';

export const LOCALES = ['nl', 'fr', 'en'] as const;
export type Locale = (typeof LOCALES)[number];
export type { Messages };

export const MESSAGES: Record<Locale, Messages> = { nl, fr, en };

export const isLocale = (value: unknown): value is Locale => (LOCALES as readonly unknown[]).includes(value);

export function localeOf(request: Request): Locale {
  const asked = new URL(request.url).searchParams.get('lang');
  if (isLocale(asked)) return asked;
  // The first language we speak, in the order the browser lists them ("fr-BE,fr;q=0.9" → fr).
  for (const part of (request.headers.get('Accept-Language') ?? '').split(',')) {
    const base = part.trim().split(';')[0].split('-')[0].toLowerCase();
    if (isLocale(base)) return base;
  }
  return 'nl';
}

export const textsFor = (request: Request): Messages => MESSAGES[localeOf(request)];

// An error thrown where no request's language is at hand (a release file,
// a Worker descriptor, the login provider's client API): it carries its
// text for every language, and says it in Dutch as a plain Error.
export class TextError extends Error {
  constructor(readonly text: (t: Messages) => string) {
    super(text(nl));
  }
}

// An error's message in the request's language. Anything else (Cloudflare's
// errors, a login provider's) is passed through as it is.
export const messageOf = (err: unknown, t: Messages): string => (err instanceof TextError ? err.text(t) : (err as Error).message);
