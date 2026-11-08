// The setup page is one template string in src/ui.ts; its <script> must
// parse exactly as served — a template-literal escape (\/ becoming /) once
// turned a regex into a comment and blanked the whole page. Runs in Node
// (the Workers runtime used by vitest doesn't allow new Function), once per
// language, with the real message tables (src/messages/*.ts load straight
// into Node: they have no runtime imports).
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/ui.ts', import.meta.url), 'utf8');
const marker = '/* html */ `';
const raw = src.slice(src.indexOf(marker) + marker.length, src.lastIndexOf('`;'));
// ui.ts's render(lang, p, texts) and its helper, as the Worker runs them.
const render = new Function('lang', 'p', 'texts', 'current', 'return `' + raw + '`');
const current = (lang, l) => (lang === l ? ' aria-current="true"' : '');

for (const lang of ['nl', 'fr', 'en']) {
  const { default: messages } = await import(new URL(`../src/messages/${lang}.ts`, import.meta.url));
  const html = render(lang, messages.page, JSON.stringify(messages.script).replace(/</g, '\\u003c'), current);
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  // Two: light/dark in the <head> (before the page is drawn — no flash), and the page's own.
  if (scripts.length !== 2) throw new Error(`${lang}: expected two <script>s in the page, found ${scripts.length}`);
  for (const script of scripts) {
    try {
      new Function(script); // parse only, never run
    } catch (err) {
      console.error(`The setup page's script (${lang}) does not parse: ${err.message}`);
      process.exit(1);
    }
  }
  if (!html.includes(`<html lang="${lang}">`)) throw new Error(`${lang}: no <html lang="${lang}">`);
  // Which failures the page retries by itself (a step's own error never).
  const rule = scripts[1].match(/function restarting\(e\) \{[\s\S]*?\n\}/)[0];
  const restarting = (platform, e) => new Function('status', `${rule}; return restarting`)(platform)(e);
  const http = (status, data = {}) => Object.assign(new Error('x'), { status, data });
  const cases = [
    [{}, http(502, { error: 'Installer unavailable' }), true], // the bff: the installer cut off
    [{}, http(503), true], // Cloudflare: the Worker over its limits
    [{}, new TypeError('Failed to fetch'), true], // no answer at all
    [{}, http(409, { error: 'token' }), false],
    [{}, http(500, { error: 'bug' }), false],
    [{}, new Error('Niet aangemeld'), false], // 401: signed out, not retried
    [{ kubernetes: {} }, new Error('no answer'), true],
    [{ docker: {} }, http(504), true],
    [{ docker: {} }, http(409, { error: 'x' }), false],
  ];
  for (const [platform, e, expected] of cases) {
    if (restarting(platform, e) !== expected) throw new Error(`${lang}: restarting(${JSON.stringify(platform)}, ${e.status ?? e.name}) should be ${expected}`);
  }
}
console.log('setup page: the script parses in nl, fr and en');
