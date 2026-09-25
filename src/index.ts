// arcanum-installer — deployed with the "Deploy to Cloudflare" button onto
// the account that will host Arcanum. Its setup page installs the five
// Arcanum Workers from a published release (arcanum-pos/arcanum-releases).
// See README.md and INSTALLER_PLAN.md.
import type { Env } from './env';
import { handleApi } from './api';
import { PAGE } from './ui';

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
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
    if (url.pathname === '/' && request.method === 'GET') {
      return new Response(PAGE, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS } });
    }
    return new Response('Not found', { status: 404 });
  },
};
