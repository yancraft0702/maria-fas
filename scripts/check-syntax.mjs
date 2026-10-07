import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../server/config.js';

const SKIP_DIRS = new Set(['node_modules', '.git', 'storage', 'data', '.tmp', 'artifacts']);
const EXTS = new Set(['.js', '.mjs', '.cjs', '.json', '.sql', '.html', '.css', '.webmanifest']);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const roots = [path.join(ROOT, 'server'), path.join(ROOT, 'web'), path.join(ROOT, 'tests'), path.join(ROOT, 'scripts')];
const files = roots.filter((r) => existsSync(r)).flatMap((r) => walk(r));

let checked = 0;
const errors = [];

for (const file of files) {
  const ext = path.extname(file).toLowerCase();
  if (!EXTS.has(ext)) continue;
  const rel = path.relative(ROOT, file);
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
    try {
      execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
      checked += 1;
    } catch (err) {
      errors.push({ file: rel, message: String(err.stderr || err.message).split('\n').slice(0, 4).join(' ') });
    }
    continue;
  }
  if (ext === '.json') {
    try {
      JSON.parse(readFileSync(file, 'utf8'));
      checked += 1;
    } catch (err) {
      errors.push({ file: rel, message: `JSON invalido: ${err.message}` });
    }
    continue;
  }
  if (ext === '.sql') {
    // UTF-8 check: sem BOM invalido e sem bytes soltos de replacement
    const raw = readFileSync(file);
    const text = raw.toString('utf8');
    if (text.includes('\uFFFD')) errors.push({ file: rel, message: 'contem caracteres de substituicao (encoding incorreto)' });
    else checked += 1;
  }
}

// UTF-8 em todos os fontes de texto
const TEXT_EXTS = new Set(['.js', '.mjs', '.html', '.css', '.sql', '.json', '.webmanifest', '.txt', '.md']);
for (const file of files) {
  if (!TEXT_EXTS.has(path.extname(file).toLowerCase())) continue;
  const text = readFileSync(file).toString('utf8');
  if (text.includes('\uFFFD')) {
    errors.push({ file: path.relative(ROOT, file), message: 'encoding UTF-8 invalido (byte de substituicao encontrado)' });
  }
}

console.log(`Verificacao de sintaxe: ${checked} arquivo(s) ok, ${errors.length} problema(s)`);
for (const e of errors) console.log(`  ERRO ${e.file}: ${e.message}`);
if (errors.length) process.exit(1);
