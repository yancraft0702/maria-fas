import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import config, { ROOT } from '../config.js';
import logger from '../lib/logger.js';

const MIGRATIONS_DIR = path.join(ROOT, 'server', 'db', 'migrations');

let db = null;

export function getDb() {
  if (db) return db;
  const dir = path.dirname(config.databasePath);
  if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  db = new DatabaseSync(config.databasePath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 8000');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA temp_store = MEMORY');
  return db;
}

export function closeDb() {
  if (!db) return;
  try { db.close(); } catch { /* ignore */ }
  db = null;
}

// --------------------------------------------------------------------------
// Helpers de consulta. Todos usam prepared statements (sem interpolacao de
// valores vindos do usuario => sem SQL injection).
// --------------------------------------------------------------------------
const cache = new Map();
function stmt(sql) {
  let s = cache.get(sql);
  if (!s) {
    s = getDb().prepare(sql);
    cache.set(sql, s);
  }
  return s;
}

function clean(row) {
  if (!row || typeof row !== 'object') return row;
  if (Array.isArray(row)) return row.map(clean);
  const out = {};
  for (const [k, v] of Object.entries(row)) out[k] = v === undefined ? null : v;
  return out;
}

export function all(sql, params = {}) {
  const args = bindArgs(sql, params);
  return (Array.isArray(args) ? stmt(sql).all(...args) : stmt(sql).all(args)).map(clean);
}

export function get(sql, params = {}) {
  const args = bindArgs(sql, params);
  const row = Array.isArray(args) ? stmt(sql).get(...args) : stmt(sql).get(args);
  return row === undefined ? null : clean(row);
}

export function run(sql, params = {}) {
  const args = bindArgs(sql, params);
  return Array.isArray(args) ? stmt(sql).run(...args) : stmt(sql).run(args);
}

export function pluck(sql, params = {}) {
  const args = bindArgs(sql, params);
  const row = Array.isArray(args) ? stmt(sql).get(...args) : stmt(sql).get(args);
  if (!row) return null;
  const keys = Object.keys(row);
  return keys.length ? row[keys[0]] : null;
}

export function scalar(sql, params = {}, fallback = null) {
  const v = pluck(sql, params);
  return v === null || v === undefined ? fallback : v;
}

const NAMED_PLACEHOLDER_RE = /[?:@$]([a-zA-Z_][a-zA-Z0-9_]*)/g;
const QUESTION_PLACEHOLDER_RE = /\?/g;

/**
 * Prepara os argumentos do prepared statement.
 *
 * `node:sqlite` liga placeholders nomeados (`?` posicional, `:nome`/@/$nome
 * por NOME via objeto) - passar posicional para um statement nomeado falha com
 * "column index out of range". Por isso detectamos a forma usada na SQL e
 * entregamos exatamente o que o driver espera:
 *
 *  - SQL so com `?`      -> array de valores na ordem da SQL
 *  - SQL so com `:nome`  -> objeto (o mesmo nome pode repetir)
 *  - SQL com ambos       -> erro explicito (a ordem ficaria ambigua)
 */
function bindArgs(sql, params) {
  const hasNamed = NAMED_PLACEHOLDER_RE.test(sql);
  NAMED_PLACEHOLDER_RE.lastIndex = 0;
  const qmarks = (sql.match(QUESTION_PLACEHOLDER_RE) || []).length;

  if (params === undefined || params === null) {
    return hasNamed ? {} : [];
  }

  const bound = normalizePaging(params);

  if (hasNamed && qmarks > 0) {
    throw new Error('SQL mistura "?" com placeholders nomeados: use apenas uma forma');
  }

  if (hasNamed) {
    if (Array.isArray(params)) {
      throw new Error('SQL usa placeholders nomeados, mas os parametros vieram como array');
    }
    // Bind por NOME: o mesmo nome pode aparecer varias vezes na SQL.
    const byName = {};
    NAMED_PLACEHOLDER_RE.lastIndex = 0;
    let match;
    const seen = new Set();
    while ((match = NAMED_PLACEHOLDER_RE.exec(sql)) !== null) {
      const name = match[1];
      if (seen.has(name)) continue;
      seen.add(name);
      if (!(name in bound)) {
        throw new Error(`placeholder :${name} ausente nos parametros`);
      }
      // `node:sqlite` espera a chave pelo NOME, sem o prefixo `:@$`.
      byName[name] = normalizeParam(bound[name]);
    }
    return byName;
  }

  // Somente `?`: valores posicionais, na ordem em que aparecem na SQL.
  if (Array.isArray(params)) return params.map(normalizeParam);
  const keys = Object.keys(bound).filter((k) => bound[k] !== undefined);
  if (keys.length !== qmarks) {
    throw new Error(
      `SQL tem ${qmarks} placeholders "?" mas os parametros tem ${keys.length} chave(s): ${keys.join(', ')}`,
    );
  }
  return keys.map((k) => normalizeParam(bound[k]));
}

function normalizeParam(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'object' && v !== null) return JSON.stringify(v);
  return v;
}

/**
 * Normaliza os valores de LIMIT/OFFSET para inteiros reais.
 *
 * SQLite exige inteiro em LIMIT/OFFSET: passar string ("20"), float ou null
 * resulta em "datatype mismatch". Como `limit` e `offset` chegam da query
 * string, eles sao normalizados aqui (somente nesses dois nomes, para nao
 * alterar a semantica de outros parametros textuais).
 */
function normalizePaging(params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return params;
  if (!('limit' in params) && !('offset' in params)) return params;
  const out = { ...params };
  if ('limit' in out) out.limit = coercePaging(out.limit, 30);
  if ('offset' in out) out.offset = coercePaging(out.offset, 0);
  return out;
}

function coercePaging(value, fallback) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Executa `fn` dentro de uma transacao. Reverte em caso de erro.
 * Suporta aninhamento via savepoints.
 */
let txDepth = 0;
export function transaction(fn) {
  const conn = getDb();
  if (txDepth === 0) {
    conn.exec('BEGIN IMMEDIATE');
    txDepth += 1;
    try {
      const result = fn();
      conn.exec('COMMIT');
      txDepth -= 1;
      return result;
    } catch (err) {
      txDepth -= 1;
      try { conn.exec('ROLLBACK'); } catch { /* ignore */ }
      throw err;
    }
  }
  const name = `sp_${txDepth}`;
  conn.exec(`SAVEPOINT ${name}`);
  txDepth += 1;
  try {
    const result = fn();
    conn.exec(`RELEASE ${name}`);
    txDepth -= 1;
    return result;
  } catch (err) {
    txDepth -= 1;
    try { conn.exec(`ROLLBACK TO ${name}`); conn.exec(`RELEASE ${name}`); } catch { /* ignore */ }
    throw err;
  }
}

// --------------------------------------------------------------------------
// Migracoes
// --------------------------------------------------------------------------
export function migrate({ silent = false } = {}) {
  const conn = getDb();
  conn.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    applied_at INTEGER NOT NULL
  )`);
  const applied = new Set(
    conn.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version),
  );
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const pending = [];
  for (const file of files) {
    const version = file.replace(/\.sql$/, '');
    if (applied.has(version)) continue;
    pending.push(version);
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    conn.exec('BEGIN IMMEDIATE');
    try {
      conn.exec(sql);
      conn.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(version, Date.now());
      conn.exec('COMMIT');
    } catch (err) {
      try { conn.exec('ROLLBACK'); } catch { /* ignore */ }
      throw new Error(`Falha na migracao ${version}: ${err.message}`, { cause: err });
    }
    if (!silent) logger.info(`migracao aplicada: ${version}`);
  }
  if (!silent) {
    logger.info('migracoes concluidas', { total: files.length, aplicadasAgora: pending.length });
  }
  cache.clear();
  return { total: files.length, appliedNow: pending };
}

export function resetStatementCache() {
  cache.clear();
}

export { MIGRATIONS_DIR };
