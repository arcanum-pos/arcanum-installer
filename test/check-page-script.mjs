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
  if (scripts.length !== 1) throw new Error(`${lang}: expected one <script> in the page, found ${scripts.length}`);
  for (const script of scripts) {
    try {
      new Function(script); // parse only, never run
    } catch (err) {
      console.error(`The setup page's script (${lang}) does not parse: ${err.message}`);
      process.exit(1);
    }
  }
  if (!html.includes(`<html lang="${lang}">`)) throw new Error(`${lang}: no <html lang="${lang}">`);
}
console.log('setup page: the script parses in nl, fr and en');
