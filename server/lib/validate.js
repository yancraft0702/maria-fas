import { ValidationError, badRequest } from './errors.js';

export function str(value, { field = 'value', min = 0, max = 10000, trim = true, required = true, pattern = null, patternMessage = null, allow = null } = {}) {
  let v = value === undefined || value === null ? '' : String(value);
  if (trim) v = v.normalize('NFC').trim();
  if (allow && allow.includes(v)) return v;
  if (!v) {
    if (required) throw new ValidationError([{ field, message: 'Campo obrigatorio' }]);
    return '';
  }
  if (v.length < min) throw new ValidationError([{ field, message: `Minimo de ${min} caracteres` }]);
  if (v.length > max) throw new ValidationError([{ field, message: `Maximo de ${max} caracteres` }]);
  if (/\u0000/.test(v)) throw new ValidationError([{ field, message: 'Caracter invalido' }]);
  if (pattern && !pattern.test(v)) {
    throw new ValidationError([{ field, message: patternMessage || 'Formato invalido' }]);
  }
  return v;
}

export function int(value, { field = 'value', min = -Infinity, max = Infinity, required = true, fallback = 0 } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new ValidationError([{ field, message: 'Campo obrigatorio' }]);
    return fallback;
  }
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new ValidationError([{ field, message: 'Numero inteiro invalido' }]);
  }
  if (n < min || n > max) throw new ValidationError([{ field, message: `Valor fora do intervalo (${min}..${max})` }]);
  return n;
}

export function num(value, { field = 'value', min = -Infinity, max = Infinity, required = true, fallback = 0 } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new ValidationError([{ field, message: 'Campo obrigatorio' }]);
    return fallback;
  }
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(n)) throw new ValidationError([{ field, message: 'Numero invalido' }]);
  if (n < min || n > max) throw new ValidationError([{ field, message: `Valor fora do intervalo (${min}..${max})` }]);
  return n;
}

export function bool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const v = String(value).trim().toLowerCase();
  return ['1', 'true', 'yes', 'on', 'sim'].includes(v);
}

export function oneOf(value, allowed, { field = 'value', required = true, fallback = null } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new ValidationError([{ field, message: 'Campo obrigatorio' }]);
    return fallback;
  }
  const v = String(value);
  if (!allowed.includes(v)) {
    throw new ValidationError([{ field, message: `Valor invalido. Permitidos: ${allowed.join(', ')}` }]);
  }
  return v;
}

const USERNAME_RE = /^[a-z0-9._]{3,24}$/i;
const RESERVED_USERNAMES = new Set([
  'admin', 'administrador', 'root', 'system', 'support', 'help', 'api', 'www', 'pulse',
  'moderator', 'staff', 'official', 'pulseoficial', 'everyone', 'seguindo', 'explore',
  'explorar', 'live', 'ao-vivo', 'mensagens', 'perfil', 'login', 'entrar', 'cadastro',
  'settings', 'config', 'static', 'assets', 'media', 'u', 'about', 'terms', 'privacy',
]);

export function username(value, { field = 'username' } = {}) {
  const raw = String(value ?? '').trim();
  // Item 5: o comprimento e conferido ANTES do formato, para a mensagem
  // dizer o motivo exato ("entre 3 e 24") em vez de reclamar do formato.
  if (raw.length < 3 || raw.length > 24) {
    throw new ValidationError([
      { field, message: 'Usuario deve ter entre 3 e 24 caracteres.' },
    ]);
  }
  const v = raw.toLowerCase();
  if (!USERNAME_RE.test(v)) {
    throw new ValidationError([
      { field, message: 'Use apenas letras, numeros, ponto e underscore.' },
    ]);
  }
  if (RESERVED_USERNAMES.has(v)) {
    throw new ValidationError([{ field, message: 'Nome de usuario reservado.' }]);
  }
  if (/^\.+$/.test(v) || v.includes('..')) {
    throw new ValidationError([{ field, message: 'Nome de usuario invalido.' }]);
  }
  return v;
}

export function email(value, { field = 'email' } = {}) {
  const v = str(value, { field, max: 254 }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(v)) {
    throw new ValidationError([{ field, message: 'Email invalido' }]);
  }
  return v;
}

export function password(value, { field = 'password' } = {}) {
  const v = String(value ?? '');
  if (v.length < 8) throw new ValidationError([{ field, message: 'A senha precisa de ao menos 8 caracteres' }]);
  if (v.length > 200) throw new ValidationError([{ field, message: 'Senha muito longa' }]);
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter((r) => r.test(v)).length;
  if (classes < 2) {
    throw new ValidationError([{ field, message: 'A senha precisa combinar letras, numeros ou simbolos' }]);
  }
  return v;
}

/** Remove qualquer HTML/script; usado em textos livres (bio, comentario, chat). */
export function plainText(value, { field = 'text', max = 2200, required = true, min = 0 } = {}) {
  const v = str(value, { field, max, required });
  if (!v) {
    if (required && min === 0 && !v) throw new ValidationError([{ field, message: 'Campo obrigatorio' }]);
    return '';
  }
  if (v.length < min) throw new ValidationError([{ field, message: `Minimo de ${min} caracteres` }]);
  // Remove caracteres de controle exceto newline/tab
  return v.replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

export function id(value, { field = 'id', required = true } = {}) {
  const v = str(value, { field, max: 64, required });
  if (!/^[A-Za-z0-9_-]+$/.test(v)) {
    throw new ValidationError([{ field, message: 'Identificador invalido' }]);
  }
  return v;
}

export function uuidLike(value, { field = 'id' } = {}) {
  const v = str(value, { field, max: 128, required: false });
  return v || null;
}

/**
 * Limite/offset/cursor padronizados.
 * `offset` e SEMPRE inteiro >= 0 (nunca null): `LIMIT ?/OFFSET ?` no SQLite
 * falha com "datatype mismatch" se receber null.
 */
export function pagination(query, { defaultLimit = 20, maxLimit = 50, defaultOffset = 0 } = {}) {
  const limit = int(query.limit, { field: 'limit', min: 1, max: maxLimit, required: false, fallback: defaultLimit });
  const cursor = query.cursor ? str(query.cursor, { field: 'cursor', max: 200, required: false }) : null;
  const offsetRaw = query.offset;
  const offset = offsetRaw === undefined || offsetRaw === '' || offsetRaw === null
    ? defaultOffset
    : int(offsetRaw, { field: 'offset', min: 0, max: 1_000_000, fallback: defaultOffset });
  return { limit, cursor, offset };
}

/** Normaliza valores usados em LIMIT/OFFSET (sempre inteiros). */
export function toIntOr(value, fallback = 0, { min = 0, max = 1_000_000 } = {}) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

export function requireFields(body, fields) {
  const errors = [];
  for (const f of fields) {
    const v = body?.[f];
    if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) {
      errors.push({ field: f, message: 'Campo obrigatorio' });
    }
  }
  if (errors.length) throw new ValidationError(errors);
}

export function assertObject(value, message = 'Objeto esperado') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw badRequest('invalid_body', message);
  }
  return value;
}
