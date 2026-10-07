import config from '../config.js';
import { all, get, run, transaction } from '../db/index.js';
import { newId, randomToken, normalizeEmail, normalizeUsername } from '../lib/ids.js';
import {
  hashPassword, verifyPassword, needsRehash, sha256,
} from '../lib/crypto.js';
import { AppError, unauthorized, forbidden, badRequest, conflict, tooManyRequests } from '../lib/errors.js';
import { createProfile, createSettings, createNotificationSettings } from './users.js';
import { revokeSessionsForUser } from './sessions.js';

export const SESSION_COOKIE = 'pulse_session';
export const CSRF_COOKIE = 'pulse_csrf';
export const CSRF_HEADER = 'x-csrf-token';

const BANNED_MESSAGE = 'Conta bloqueada. Entre em contato com a moderacao.';

// --------------------------------------------------------------------------
// Tentativas de login/registro (rate limit especifico e persistente)
// --------------------------------------------------------------------------
export function checkAuthAttempts(key) {
  const cutoff = Date.now() - config.authAttemptWindowMs;
  const row = get(
    `SELECT COUNT(*) AS c FROM audit_log
      WHERE error_code = 'auth_attempt_failed' AND created_at > ? AND ip = ?`,
    { cutoff, ip: key },
  );
  if ((row?.c ?? 0) >= config.authMaxAttempts) {
    throw tooManyRequests('auth_rate_limited', 'Muitas tentativas. Aguarde antes de tentar novamente.');
  }
}

export function registerAuthFailure(key) {
  run(
    `INSERT INTO audit_log (id, request_id, method, path, status, ip, error_code, created_at)
     VALUES (?, '', 'POST', '/api/auth/login', 401, ?, 'auth_attempt_failed', ?)`,
    { id: newId('log'), ip: key, ts: Date.now() },
  );
}

// --------------------------------------------------------------------------
// Criacao de usuario
// --------------------------------------------------------------------------
export async function createUser({
  email: emailRaw, username: usernameRaw, password: passwordRaw, displayName, role = 'user',
}) {
  const emailNormalized = normalizeEmail(emailRaw);
  const usernameNorm = normalizeUsername(usernameRaw);

  const existingEmail = get('SELECT id FROM users WHERE email_normalized = ?', { emailNormalized });
  if (existingEmail) throw conflict('email_taken', 'Este email ja esta cadastrado');
  const existingUsername = get('SELECT id FROM users WHERE username_norm = ?', { usernameNorm });
  if (existingUsername) throw conflict('username_taken', 'Este nome de usuario ja esta em uso');

  const passwordHash = await hashPassword(passwordRaw, config.scryptCost);
  const now = Date.now();
  const id = newId('usr');

  transaction(() => {
    run(
      `INSERT INTO users (id, email, email_normalized, username, username_norm, display_name,
        password_hash, role, status, created_at, updated_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
      {
        id,
        email: emailNormalized,
        emailNormalized,
        username: usernameNorm,
        usernameNorm,
        displayName: displayName || usernameNorm,
        passwordHash,
        role,
        createdAt: now,
        updatedAt: now,
        lastSeenAt: now,
      },
    );
    createProfile(id);
    createSettings(id);
    createNotificationSettings(id);
  });

  return get('SELECT * FROM users WHERE id = ?', { id });
}

/**
 * Resolve o identificador digitado em UMA consulta indexada.
 *
 * Escolhe a coluna pelo formato do valor:
 *  - com "@" e ponto depois  -> email (`email_normalized`)
 *  - "@ana" / "ana"          -> usuario (`username_norm`, unico/indexado)
 *
 * Aceita login por usuario E por email, sem varredura na tabela.
 */
export function findUserByIdentifier(raw) {
  const value = String(raw || '').trim();
  if (!value) return null;
  const looksLikeEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  if (looksLikeEmail) {
    return get('SELECT * FROM users WHERE email_normalized = ?', {
      emailNormalized: value.toLowerCase(),
    });
  }
  const norm = value.replace(/^@/, '').toLowerCase();
  return get('SELECT * FROM users WHERE username_norm = ?', { norm });
}

/**
 * Autentica por USUARIO (com ou sem @) ou por email.
 *
 * A interface pede somente usuario e senha, mas a coluna `email_normalized`
 * continua sendo a chave de seguranca (dominio de e-mail). Por isso o
 * identificador textual e resolvido numa unica consulta indexada, escolhendo a
 * coluna pelo formato do valor informado.
 */
export async function authenticate({
  identifier, email, password, totpCode = null, backupCode = null, ip, userAgent, deviceId,
}) {
  checkAuthAttempts(ip);
  const raw = String(identifier ?? email ?? '').trim();
  const user = findUserByIdentifier(raw);

  // Gasta tempo de CPU mesmo sem usuario (evita enumeracao por tempo).
  const stored = user?.password_hash || 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==';
  const ok = await verifyPassword(password, stored);
  if (!user || !ok) {
    registerAuthFailure(ip);
    throw unauthorized('invalid_credentials', 'Usuario ou senha incorretos');
  }
  if (user.status === 'banned') {
    throw forbidden('account_banned', user.status_reason || BANNED_MESSAGE);
  }
  if (user.status === 'suspended') {
    const until = user.status_until ? new Date(user.status_until).toISOString() : 'indeterminado';
    throw forbidden('account_suspended', `Conta suspensa ate ${until}. Motivo: ${user.status_reason || 'nao informado'}`);
  }
  if (user.status === 'deleted') throw unauthorized('account_deleted', 'Conta removida');

  if (user.totp_enabled) {
    if (backupCode) {
      const consumed = consumeBackupCode(user, backupCode);
      if (!consumed) {
        registerAuthFailure(ip);
        throw unauthorized('invalid_2fa_code', 'Codigo de recuperacao invalido');
      }
    } else {
      if (!totpCode) {
        throw new AppError(401, 'totp_required', 'Codigo de autenticacao em duas etapas necessario', {
          details: { method: 'totp' },
        });
      }
      const { verifyTotp } = await import('../lib/crypto.js');
      if (!verifyTotp(user.totp_secret, totpCode)) {
        registerAuthFailure(ip);
        throw unauthorized('invalid_2fa_code', 'Codigo de autenticacao invalido');
      }
    }
  }

  return user;
}

function consumeBackupCode(user, code) {
  let codes = [];
  try { codes = JSON.parse(user.recovery_codes || '[]'); } catch { codes = []; }
  const normalized = String(code).trim().toUpperCase();
  const idx = codes.findIndex((c) => c.toUpperCase() === normalized);
  if (idx === -1) return false;
  codes.splice(idx, 1);
  run('UPDATE users SET recovery_codes = ?, updated_at = ? WHERE id = ?', {
    codes: JSON.stringify(codes), ts: Date.now(), id: user.id,
  });
  return true;
}

/** Rehash transparente do hash quando o custo mudou. */
export async function upgradePasswordHash(user, password) {
  if (!needsRehash(user.password_hash, config.scryptCost)) return;
  const hash = await hashPassword(password, config.scryptCost);
  run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', {
    hash, ts: Date.now(), id: user.id,
  });
}

// --------------------------------------------------------------------------
// Recuperacao de senha
// --------------------------------------------------------------------------
export function createPasswordReset(userId) {
  const token = randomToken(32);
  const now = Date.now();
  run('DELETE FROM password_resets WHERE user_id = ?', { userId });
  run(
    `INSERT INTO password_resets (id, user_id, token_hash, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
    { id: newId('pr'), userId, tokenHash: sha256(token), now, expiresAt: now + 30 * 60 * 1000 },
  );
  return token;
}

export function consumePasswordReset(token) {
  const tokenHash = sha256(token);
  const row = get('SELECT * FROM password_resets WHERE token_hash = ?', { tokenHash });
  if (!row) throw badRequest('invalid_reset_token', 'Codigo de recuperacao invalido');
  if (row.used_at) throw badRequest('reset_token_used', 'Este codigo de recuperacao ja foi utilizado');
  if (row.expires_at < Date.now()) throw badRequest('reset_token_expired', 'Codigo de recuperacao expirou');
  return row;
}

export function resetPasswordWithToken(token, newPasswordHash) {
  const row = consumePasswordReset(token);
  const now = Date.now();
  run(
    `UPDATE users SET password_hash = ?, updated_at = ?, totp_enabled = 0, totp_secret = NULL, recovery_codes = NULL
      WHERE id = ?`,
    { newPasswordHash, now, id: row.user_id },
  );
  run('UPDATE password_resets SET used_at = ? WHERE id = ?', { now, id: row.id });
  // Troca de senha encerra todas as sessoes por seguranca.
  revokeSessionsForUser(row.user_id, 'password_changed');
}

// --------------------------------------------------------------------------
// Segredos de 2FA
// --------------------------------------------------------------------------
export function enableTotp(userId, secret) {
  run('UPDATE users SET totp_secret = ?, totp_enabled = 1, updated_at = ? WHERE id = ?', {
    secret, ts: Date.now(), id: userId,
  });
}

export function disableTotp(userId) {
  run('UPDATE users SET totp_enabled = 0, totp_secret = NULL, recovery_codes = NULL, updated_at = ? WHERE id = ?', {
    ts: Date.now(), id: userId,
  });
}

export function setRecoveryCodes(userId, codes) {
  run('UPDATE users SET recovery_codes = ?, updated_at = ? WHERE id = ?', {
    codes: JSON.stringify(codes), ts: Date.now(), id: userId,
  });
}

// --------------------------------------------------------------------------
// Autorizacao (fonte de verdade: banco)
// --------------------------------------------------------------------------
export function assertActive(user) {
  if (!user) throw unauthorized();
  if (user.status === 'banned') throw forbidden('account_banned', user.status_reason || BANNED_MESSAGE);
  if (user.status === 'suspended') {
    if (user.status_until && user.status_until > Date.now()) {
      throw forbidden('account_suspended', 'Conta suspensa temporariamente');
    }
  }
  if (user.status === 'deleted') throw unauthorized('account_deleted', 'Conta removida');
  return user;
}

export function isStaff(user) {
  return Boolean(user && (user.role === 'admin' || user.role === 'moderator'));
}

export function requireStaff(user) {
  assertActive(user);
  if (!isStaff(user)) throw forbidden('staff_only', 'Acesso restrito a equipe de moderacao');
  return user;
}

export function requireAdmin(user) {
  assertActive(user);
  if (user.role !== 'admin') throw forbidden('admin_only', 'Acesso restrito a administradores');
  return user;
}

export function requireNotBanned(user) {
  assertActive(user);
  return user;
}

/** Normaliza papel para verificacoes no SQL. */
export function staffRoles() {
  return ['admin', 'moderator'];
}

export function listSessions(userId) {
  return all(
    `SELECT id, device_id, user_agent, ip, created_at, last_used_at, expires_at, revoked_at
       FROM sessions WHERE user_id = ? AND revoked_at IS NULL ORDER BY last_used_at DESC`,
    { userId },
  );
}
