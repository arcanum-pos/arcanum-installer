// The setup page is one template string in src/ui.ts; its <script> must
// parse exactly as served — a template-literal escape (\/ becoming /) once
// turned a regex into a comment and blanked the whole page. Runs in Node
// (the Workers runtime used by vitest doesn't allow new Function).
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/ui.ts', import.meta.url), 'utf8');
const marker = 'export const PAGE = /* html */ `';
const raw = src.slice(src.indexOf(marker) + marker.length, src.lastIndexOf('`;'));
const html = new Function('return `' + raw + '`')(); // exactly what the Worker serves
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
if (scripts.length === 0) throw new Error('no <script> in the page');
for (const script of scripts) {
  try {
    new Function(script); // parse only, never run
  } catch (err) {
    console.error(`The setup page's script does not parse: ${err.message}`);
    process.exit(1);
  }
}
console.log(`setup page: ${scripts.length} script(s) parse`);
