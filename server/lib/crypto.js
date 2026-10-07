import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);
const DEFAULT_COST = 16384;

/**
 * Hash de senha com scrypt (memory-hard, nativo do Node, sem dependencia nativa).
 * Formato: scrypt$N$r$p$saltBase64$hashBase64
 */
export async function hashPassword(password, cost = DEFAULT_COST) {
  const salt = crypto.randomBytes(16);
  const N = cost;
  const r = 8;
  const p = 1;
  const derived = await scrypt(String(password).normalize('NFKC'), salt, 64, { N, r, p, maxmem: 256 * 1024 * 1024 });
  return ['scrypt', N, r, p, salt.toString('base64'), derived.toString('base64')].join('$');
}

/** Verificacao em tempo constante. Retorna false para hashes malformados. */
export async function verifyPassword(password, stored) {
  try {
    if (typeof stored !== 'string') return false;
    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const N = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    const salt = Buffer.from(parts[4], 'base64');
    const expected = Buffer.from(parts[5], 'base64');
    const derived = await scrypt(String(password).normalize('NFKC'), salt, expected.length, {
      N, r, p, maxmem: 256 * 1024 * 1024,
    });
    return crypto.timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/** Necessita re-hash quando o custo/params mudaram. */
export function needsRehash(stored, cost = DEFAULT_COST) {
  if (typeof stored !== 'string') return true;
  const parts = stored.split('$');
  if (parts.length !== 6) return true;
  return Number(parts[1]) < cost;
}

export function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

export function hmacSha256(key, value) {
  return crypto.createHmac('sha256', key).update(String(value)).digest();
}

export function base64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

// ---------------------------------- TOTP -----------------------------------
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input) {
  const clean = String(input).toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret(bytes = 20) {
  return base32Encode(crypto.randomBytes(bytes));
}

function totpCode(secretBuf, counter) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', secretBuf).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(bin % 1_000_000).padStart(6, '0');
}

/** Gera codigo TOTP (RFC 6238, 30s, 6 digitos, SHA1). */
export function totpAt(secretBase32, timestampMs = Date.now(), step = 30, digits = 6) {
  const key = base32Decode(secretBase32);
  const counter = Math.floor(timestampMs / 1000 / step);
  let code = totpCode(key, counter);
  if (digits !== 6) code = code.padStart(digits, '0').slice(-digits);
  return code;
}

/** Valida com janela de tolerancia (±1 passo). */
export function verifyTotp(secretBase32, token, window = 1) {
  const clean = String(token ?? '').replace(/\D/g, '');
  if (clean.length !== 6) return false;
  const now = Math.floor(Date.now() / 1000 / 30);
  for (let i = -window; i <= window; i += 1) {
    const candidate = totpCode(base32Decode(secretBase32), now + i);
    if (crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(clean.padStart(6, '0').slice(-6)))) return true;
  }
  return false;
}

export function otpauthUrl({ secret, label, issuer }) {
  const enc = encodeURIComponent;
  return `otpauth://totp/${enc(issuer)}:${enc(label)}?secret=${secret}&issuer=${enc(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

export function generateRecoveryCodes(count = 10) {
  const codes = [];
  for (let i = 0; i < count; i += 1) {
    const raw = crypto.randomBytes(5).toString('hex').toUpperCase();
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5, 10)}`);
  }
  return codes;
}
