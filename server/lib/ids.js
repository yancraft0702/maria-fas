import crypto from 'node:crypto';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** ID ordenavel por tempo (prefixo + base36 de tempo + aleatorio). */
export function newId(prefix = '') {
  const ts = Date.now().toString(36).padStart(9, '0');
  const rand = crypto.randomBytes(10);
  let out = '';
  for (const b of rand) out += ALPHABET[b % ALPHABET.length];
  return prefix ? `${prefix}_${ts}${out}` : `${ts}${out}`;
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function randomHex(bytes = 16) {
  return crypto.randomBytes(bytes).toString('hex');
}

export function eventId() {
  return newId('ev');
}

/** Normaliza @username para comparacao case-insensitive. */
export function normalizeUsername(value) {
  return String(value ?? '').trim().replace(/^@+/, '').toLowerCase();
}

/** Normaliza email. */
export function normalizeEmail(value) {
  return String(value ?? '').trim().toLowerCase();
}

/** Normaliza hashtag (sem #, minusculo, sem acentos opcionais preservados). */
export function normalizeHashtag(value) {
  return String(value ?? '').trim().replace(/^#+/, '').toLowerCase();
}

export function constantTimeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) {
    // Ainda assim faz comparacao para nao vazar informacao por tempo.
    crypto.timingSafeEqual(ba, ba);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}
