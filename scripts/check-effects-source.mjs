import fs from 'node:fs';
import path from 'node:path';

/**
 * Confere que os efeitos da LIVE vem do diretorio NOVO do projeto e que
 * nenhuma referencia ao caminho antigo ficou no codigo.
 */
import { ROOT } from '../server/config.js';
import { EFFECT_CATALOG } from '../server/domain/effects.js';

const OLD_MARKER = 'Documents/app2';
let fail = 0;

console.log('Catalogo de efeitos:\n');
for (const item of EFFECT_CATALOG) {
  const inside = item.source.startsWith(ROOT);
  const exists = fs.existsSync(item.source);
  const rel = path.relative(ROOT, item.source);
  const ok = inside && exists;
  if (!ok) fail += 1;
  console.log(`  [${ok ? 'OK  ' : 'FALHA'}] ${item.slug.padEnd(10)} ${rel}`);
  if (!inside) console.log(`         fora da raiz do projeto: ${item.source}`);
  if (!exists) console.log(`         arquivo ausente: ${item.source}`);
}

const used = path.dirname(EFFECT_CATALOG[0].source);
console.log(`\nDiretorio de origem: ${used}`);
console.log(`Existe: ${fs.existsSync(used)}`);
console.log(`Arquivos: ${fs.existsSync(used) ? fs.readdirSync(used).join(', ') : '(nenhum)'}`);

// Nenhuma referencia ao caminho antigo pode sobrar.
const SELF = path.relative(ROOT, new URL(import.meta.url).pathname.replace(/^\//, ''));
const refs = [];
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'data', 'storage', 'animacao'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.(js|mjs|json|md)$/.test(entry.name)) {
      const rel = path.relative(ROOT, full);
      if (rel === SELF) continue;
      if (fs.readFileSync(full, 'utf8').includes(OLD_MARKER)) refs.push(rel);
    }
  }
};
walk(ROOT);
console.log(`\nReferencias ao caminho antigo: ${refs.length ? refs.join(', ') : 'nenhuma'}`);
if (refs.length) fail += refs.length;

console.log(fail ? `\n${fail} problema(s)` : '\nCatalogo 100% no novo caminho');
process.exit(fail ? 1 : 0);