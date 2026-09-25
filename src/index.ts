// arcanum-installer — deployed with the "Deploy to Cloudflare" button onto
// the account that will host Arcanum. Its setup page installs the five
// Arcanum Workers from a published release (arcanum-pos/arcanum-releases).
// See README.md and INSTALLER_PLAN.md.
import type { Env } from './env';
import { handleApi } from './api';
import { PAGE } from './ui';
import { loadState, publicUrl } from './state';
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
    if (url.pathname.startsWith('/api/')) {
      const res = await handleApi(request, env, url.pathname);
      for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.headers.set(k, v);
      return res;
    }
    const asset = ASSETS[url.pathname];
    if (asset && request.method === 'GET') {
      return new Response(asset.body, { headers: { 'Content-Type': asset.type, 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff' } });
    }
    if (url.pathname === '/' && request.method === 'GET') {
      // The page may load one image from the installation itself (the live check).
      const installation = publicUrl(await loadState(env));
      const csp = installation ? SECURITY_HEADERS['Content-Security-Policy'].replace("img-src 'self'", `img-src 'self' ${installation}`) : SECURITY_HEADERS['Content-Security-Policy'];
      return new Response(PAGE, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS, 'Content-Security-Policy': csp } });
    }
    return new Response('Not found', { status: 404 });
  },
};
