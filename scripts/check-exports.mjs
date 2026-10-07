/**
 * Verifica que todo import nomeado corresponde a um export real do modulo.
 * Detecta o boot-breaking "does not provide an export named X" sem subir o servidor.
 */
import { readdirSync, existsSync, readFileSync, statSync } from 'node:fs';
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

function resolveModule(fromFile, spec) {
  const target = path.resolve(path.dirname(fromFile), spec);
  if (existsSync(target) && statSync(target).isFile()) return target;
  if (existsSync(`${target}.js`)) return `${target}.js`;
  if (existsSync(`${target}.mjs`)) return `${target}.mjs`;
  if (existsSync(path.join(target, 'index.js'))) return path.join(target, 'index.js');
  return null;
}

/** Extrai nomes exportados de um modulo ESM (heuristica segura para codigo nosso). */
function exportsOf(file) {
  const text = readFileSync(file, 'utf8');
  const names = new Set();

  // export function foo / export async function foo / export function* foo
  for (const m of text.matchAll(/export\s+(?:async\s+)?function\s*\*?\s*([A-Za-z0-9_$]+)/g)) names.add(m[1]);
  // export class Foo
  for (const m of text.matchAll(/export\s+class\s+([A-Za-z0-9_$]+)/g)) names.add(m[1]);
  // export const/let/var foo
  for (const m of text.matchAll(/export\s+(?:const|let|var)\s+([A-Za-z0-9_$]+)/g)) names.add(m[1]);
  // export { a, b as c }
  for (const m of text.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const t = part.trim();
      if (!t) continue;
      const asMatch = /as\s+([A-Za-z0-9_$]+)$/.exec(t);
      names.add(asMatch ? asMatch[1] : t);
    }
  }
  // export default
  if (/export\s+default\b/.test(text)) names.add('default');
  // export * from './x.js'
  const stars = [...text.matchAll(/export\s*\*\s*from\s*['"]([^'"]+)['"]/g)];
  return { names, stars };
}

const roots = ['server', 'web', 'tests', 'scripts'].map((r) => path.join(ROOT, r)).filter(existsSync);
const files = roots.flatMap((r) => walk(r)).filter((f) => ['.js', '.mjs'].includes(path.extname(f)));

const IMPORT_RE = /import\s+([\s\S]*?)\s+from\s*['"]([^'"]+)['"]/g;
const errors = [];
const cache = new Map();

function allExports(file, seen = new Set()) {
  if (cache.has(file)) return cache.get(file);
  if (seen.has(file)) return new Set();
  seen.add(file);
  const { names, stars } = exportsOf(file);
  const out = new Set(names);
  for (const star of stars) {
    const resolved = resolveModule(file, star[1]);
    if (resolved) for (const n of allExports(resolved, seen)) out.add(n);
  }
  cache.set(file, out);
  return out;
}

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  IMPORT_RE.lastIndex = 0;
  let m;
  while ((m = IMPORT_RE.exec(text)) !== null) {
    const clause = m[1].trim();
    const spec = m[2];
    if (!spec.startsWith('.')) continue;
    const resolved = resolveModule(file, spec);
    if (!resolved) continue; // ja reportado por check-imports
    const available = allExports(resolved);
    if (available.has('default') && clause.startsWith('*')) continue;

    const braceMatch = /\{([\s\S]*)\}/.exec(clause);
    if (braceMatch) {
      for (const part of braceMatch[1].split(',')) {
        const t = part.trim();
        if (!t) continue;
        const name = t.split(/\s+as\s+/)[0].trim();
        if (!name) continue;
        if (!available.has(name)) {
          errors.push({ file: path.relative(ROOT, file), spec, name });
        }
      }
    }
    const defaultName = clause.replace(/\{[\s\S]*\}/, '').replace(/^\s*,|,\s*$/g, '').trim();
    if (defaultName && !defaultName.startsWith('*') && !available.has('default')) {
      errors.push({ file: path.relative(ROOT, file), spec, name: 'default' });
    }
  }
}

console.log(`Exports: ${files.length} arquivo(s), ${errors.length} import(s) invalido(s)`);
for (const e of errors) console.log(`  ERRO ${e.file}: "${e.name}" nao e exportado por ${e.spec}`);
if (errors.length) process.exit(1);
