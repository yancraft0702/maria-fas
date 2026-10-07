/**
 * Detecta o padrao perigoso do query builder: um objeto de parametros com
 * a MESMA chave repetida para varios placeholders. Como as chaves sao
 * deduplicadas, isso gera "NOT NULL constraint failed" ou "column index out
 * of range" em runtime.
 *
 * Heuristica: para cada `run(`/`all(`/`get(` com objeto literal, compara a
 * quantidade de `?` na SQL com a quantidade de chaves unicas do objeto.
 */
import { readdirSync, readFileSync } from 'node:fs';
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

const files = walk(path.join(ROOT, 'server')).filter((f) => f.endsWith('.js'));
const warnings = [];

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');

  lines.forEach((line, index) => {
    // Procura calls cujo objeto de parametros repete valores simples
    const callMatch = /\b(run|all|get|pluck|scalar)\s*\(/.exec(line);
    if (!callMatch) return;
    // Chave repetida no mesmo objeto: "now, now" / "ts: now" com mesmo valor
    const shorthandRepeats = /\b(now|ts|nowFloat)\s*,\s*(now|ts|nowFloat)\b/.exec(line);
    if (shorthandRepeats) {
      warnings.push({
        file: path.relative(ROOT, file),
        line: index + 1,
        detail: `valor repetido em objeto de parametros: "${line.trim().slice(0, 90)}"`,
      });
    }
  });
}

console.log(`Parametros: ${files.length} arquivo(s), ${warnings.length} risco(s) de colisao`);
for (const w of warnings) console.log(`  ${w.file}:${w.line} - ${w.detail}`);
if (warnings.length) process.exit(1);
