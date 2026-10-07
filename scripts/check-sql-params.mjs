/**
 * Verifica que todo `run(sql, {obj})` / `get` / `all` tem:
 *  - mesma quantidade de `?` na SQL e de chaves no objeto;
 *  - sem chaves duplicadas (que se perderiam na deduplicacao).
 *
 * O query builder liga os valores pela ORDEM das chaves do objeto, logo a
 * ordem das chaves precisa seguir a ordem dos placeholders da SQL.
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

/** Extrai chamadas `run|all|get( ... )` com 2 argumentos. */
function findCalls(text) {
  const results = [];
  const re = /\b(run|all|get|pluck|scalar)\s*\(/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const start = m.index + m[0].length;
    let depth = 1;
    let i = start;
    while (i < text.length && depth > 0) {
      const ch = text[i];
      if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
      else if (ch === '`') {
        i += 1;
        while (i < text.length && text[i] !== '`') {
          if (text[i] === '\\') i += 1;
          i += 1;
        }
      } else if (ch === "'" || ch === '"') {
        const quote = ch;
        i += 1;
        while (i < text.length && text[i] !== quote) {
          if (text[i] === '\\') i += 1;
          i += 1;
        }
      }
      i += 1;
    }
    const body = text.slice(start, i - 1);
    results.push({ fn: m[1], body, index: m.index, line: text.slice(0, m.index).split('\n').length });
  }
  return results;
}

/** Divide argumentos de nivel superior. */
function splitArgs(body) {
  const args = [];
  let depth = 0;
  let current = '';
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === '(' || ch === '{' || ch === '[') depth += 1;
    if (ch === ')' || ch === '}' || ch === ']') depth -= 1;
    if (ch === '`') {
      current += ch; i += 1;
      while (i < body.length && body[i] !== '`') {
        current += body[i];
        if (body[i] === '\\') { current += body[i]; i += 1; }
        i += 1;
      }
      current += body[i] ?? '';
      continue;
    }
    if (ch === ',' && depth === 0) { args.push(current); current = ''; continue; }
    current += ch;
  }
  if (current.trim()) args.push(current);
  return args;
}

const files = walk(path.join(ROOT, 'server')).filter((f) => f.endsWith('.js'));
const problems = [];

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  for (const call of findCalls(text)) {
    const args = splitArgs(call.body);
    if (args.length < 2) continue;
    const sqlArg = args[0].trim();
    const paramArg = args[1].trim();
    if (!sqlArg.startsWith('`') && !sqlArg.startsWith("'") && !sqlArg.startsWith('"')) continue;
    if (!paramArg.startsWith('{')) continue;

    const sql = sqlArg.slice(1, -1);
    // placeholders nomeados (:nome) sao resolvidos pela chave correspondente
    const named = [...sql.matchAll(/:([a-z_][a-z0-9_]*)/gi)].map((m) => m[1]);
    const qmark = (sql.match(/\?/g) || []).length;

    const objBody = paramArg.slice(1, -1);
    const keys = [];
    let depth = 0;
    let current = '';
    for (let i = 0; i < objBody.length; i += 1) {
      const ch = objBody[i];
      if (ch === '{' || ch === '[' || ch === '(') depth += 1;
      if (ch === '}' || ch === ']' || ch === ')') depth -= 1;
      if (ch === ',' && depth === 0) { keys.push(current); current = ''; continue; }
      current += ch;
    }
    keys.push(current);
    const keyNames = keys
      .map((k) => k.trim())
      .filter(Boolean)
      .map((k) => {
        const colon = k.indexOf(':');
        const bare = colon === -1 ? k : k.slice(0, colon);
        return bare.trim();
      });

    const unique = new Set(keyNames);
    const rel = path.relative(ROOT, file);
    const missingNamed = named.filter((n) => !unique.has(n));
    const missingPositional = qmark > 0 && !named.length
      ? Math.abs(qmark - keyNames.length)
      : 0;

    const mixedPlaceholders = qmark > 0 && named.length > 0;
    if (mixedPlaceholders) {
      problems.push({ rel, line: call.line, kind: 'mixed', detail: 'mistura ? com :nomeado no mesmo statement' });
    } else if (missingNamed.length) {
      problems.push({ rel, line: call.line, kind: 'named', detail: `placeholders nomeados sem chave: ${missingNamed.join(', ')}` });
    } else if (missingPositional) {
      problems.push({ rel, line: call.line, kind: 'count', detail: `${qmark} placeholders vs ${keyNames.length} chaves` });
    } else if (unique.size !== keyNames.length) {
      problems.push({ rel, line: call.line, kind: 'dup', detail: `chaves repetidas: ${keyNames.join(', ')}` });
    } else {
      // Risco de ORDEM: com `SET ${sets.join(', ')}` as colunas dinamicas vem
      // primeiro na SQL. Se as chaves fixas (updated_at/id/userId) foram
      // declaradas ANTES delas no objeto, o bind usa a posicao errada.
      const dynamicSet = sql.includes('${');
      const FIXED = ['id', 'ts', 'now', 'nowMs', 'userId', 'postId', 'commentId', 'targetId', 'roomId'];
      if (dynamicSet && qmark > 0 && !named.length) {
        const lastFixedIndex = Math.max(...keyNames.map((k, i) => (FIXED.includes(k) ? i : -1)));
        const firstDynamic = keyNames.findIndex((k) => !FIXED.includes(k));
        if (lastFixedIndex > -1 && firstDynamic > -1 && lastFixedIndex < firstDynamic) {
          problems.push({
            rel,
            line: call.line,
            kind: 'order',
            detail: `chaves fixas (${keyNames.slice(0, firstDynamic).join(', ')}) declaradas antes das colunas dinamicas de SET`,
          });
        }
      }
    }
  }
}

console.log(`SQL/params: ${files.length} arquivo(s), ${problems.length} problema(s)`);
for (const p of problems) console.log(`  ${p.rel}:${p.line} [${p.kind}] ${p.detail}`);
if (problems.length) process.exit(1);
