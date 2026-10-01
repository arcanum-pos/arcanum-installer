// arcanum-installer — on the account that will host Arcanum, uploaded there
// by the bootstrapper (start.kaboutersoft.be, handed over via /handoff). Its setup page installs the five
// Arcanum Workers from a published release (arcanum-pos/arcanum-releases),
// and updates them — itself first. See README.md and HOSTING_PLAN.md.
import type { Env } from './env';
import { handleApi } from './api';
import { page } from './ui';
import { localeOf, MESSAGES } from './i18n';
import { loadState, publicUrl, rootSecret } from './state';
import { CALLBACK_PATH, finishSignIn, startSignIn } from './oidc';
import { finishTest, startTest, TEST_CALLBACK_PATH } from './login-change';
import kabouter from './assets/kabouter.png';
import geist from './assets/fonts/geist-latin-wght.woff2';
import montserrat from './assets/fonts/montserrat-latin-700.woff2';

// The platform's own brand assets (see arcanum-frontends src/shared): the
// kabouter logo, Geist for text, Montserrat Bold for the "arcanum" wordmark.
// Fonts: SIL Open Font License, see src/assets/fonts/LICENSE-*.txt.
const ASSETS: Record<string, { body: ArrayBuffer; type: string }> = {
  '/assets/kabouter.png': { body: kabouter, type: 'image/png' },
  '/assets/geist.woff2': { body: geist, type: 'font/woff2' },
  '/assets/montserrat-700.woff2': { body: montserrat, type: 'font/woff2' },
};

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const locale = localeOf(request);
    if (url.pathname.startsWith('/api/')) {
      const res = await handleApi(request, env, url.pathname);
      for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.headers.set(k, v);
      return res;
    }
    const asset = ASSETS[url.pathname];
    if (asset && request.method === 'GET') {
      return new Response(asset.body, { headers: { 'Content-Type': asset.type, 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff' } });
    }
    // Signing in with an admin's account.
    if (url.pathname.startsWith('/auth/') && !rootSecret(env)) return new Response(MESSAGES[locale].api.noStateKey, { status: 500 });
    if (url.pathname === '/auth/login' && request.method === 'GET') return startSignIn(request, env);
    if (url.pathname === CALLBACK_PATH && request.method === 'GET') return finishSignIn(request, env);
    // "Aanmelding wijzigen": the test sign-in at a staged provider.
    if (url.pathname === '/auth/test-login' && request.method === 'GET') return startTest(request, env);
    if (url.pathname === TEST_CALLBACK_PATH && request.method === 'GET') return finishTest(request, env);
    // The page itself — also at /handoff, the bootstrapper's link (its script posts the code).
    // In the language of ?lang= (the page's picker) or the browser (i18n.ts).
    if ((url.pathname === '/' || url.pathname === '/handoff') && request.method === 'GET') {
      // The page may load one image from the installation itself (the live check).
      const installation = publicUrl(await loadState(env));
      const csp = installation ? SECURITY_HEADERS['Content-Security-Policy'].replace("img-src 'self'", `img-src 'self' ${installation}`) : SECURITY_HEADERS['Content-Security-Policy'];
      return new Response(page(locale), { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Language': locale, 'Cache-Control': 'no-store', ...SECURITY_HEADERS, 'Content-Security-Policy': csp } });
    }
    return new Response('Not found', { status: 404 });
  },
};
