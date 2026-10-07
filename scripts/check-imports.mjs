/**
 * Valida que TODOS os imports relativos resolvem para arquivos existentes.
 * Erro de caminho e falha de boot: detectamos antes de subir o servidor.
 */
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../server/config.js';

const SKIP = new Set(['node_modules', '.git', 'storage', 'data', '.tmp', 'artifacts']);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const roots = ['server', 'web', 'tests', 'scripts'].map((r) => path.join(ROOT, r)).filter(existsSync);
const files = roots.flatMap((r) => walk(r)).filter((f) => ['.js', '.mjs'].includes(path.extname(f)));

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

const errors = [];
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  IMPORT_RE.lastIndex = 0;
  let m;
  while ((m = IMPORT_RE.exec(text)) !== null) {
    const spec = m[1] || m[2];
    if (!spec) continue;
    if (!spec.startsWith('.')) {
      // pacote externo: so checa se esta instalado (skip de node_modules ja feito)
      continue;
    }
    const target = path.resolve(path.dirname(file), spec);
    if (existsSync(target)) continue;
    if (existsSync(`${target}.js`) || existsSync(`${target}.mjs`) || existsSync(path.join(target, 'index.js'))) continue;
    errors.push({ file: path.relative(ROOT, file), spec });
  }
}

console.log(`Imports: ${files.length} arquivo(s) analisado(s), ${errors.length} caminho(s) quebrado(s)`);
for (const e of errors) console.log(`  ERRO ${e.file}: "${e.spec}"`);
if (errors.length) process.exit(1);
