import config from '../config.js';
import { all, get, run } from '../db/index.js';
import { newId, randomToken } from '../lib/ids.js';
import { sha256 } from '../lib/crypto.js';
import { SESSION_COOKIE, CSRF_COOKIE } from './auth.js';

/**
 * Cria sessao. O token bruto so existe no cookie HttpOnly; no banco fica
 * apenas o hash SHA-256 (roubo de banco nao da acesso a sessao).
 */
export function createSession({ userId, userAgent = '', ip = '', deviceId = null }) {
  const token = randomToken(32);
  const csrfToken = randomToken(24);
  const now = Date.now();
  const id = newId('ses');
  if (deviceId) {
    run(
      `INSERT INTO devices (id, user_id, device_label, device_type, last_used_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET device_label = excluded.device_label,
         device_type = excluded.device_type, last_used_at = excluded.last_used_at`,
      {
        id: deviceId, userId, label: describeDevice(userAgent), type: deviceType(userAgent),
        lastUsedAt: now, now,
      },
    );
  }
  run(
    `INSERT INTO sessions (id, user_id, token_hash, csrf_token, device_id, user_agent, ip,
       created_at, last_used_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    {
      id, userId, tokenHash: sha256(token), csrfToken, deviceId, userAgent: String(userAgent).slice(0, 500),
      ip, now, lastUsedAt: now, expiresAt: now + config.sessionTtlMs,
    },
  );
  return { id, token, csrfToken, expiresAt: now + config.sessionTtlMs };
}

export function resolveSession(token) {
  if (!token) return null;
  const row = get(
    `SELECT * FROM sessions WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?`,
    { tokenHash: sha256(token), now: Date.now() },
  );
  return row || null;
}

export function touchSession(sessionId) {
  run('UPDATE sessions SET last_used_at = ? WHERE id = ?', { ts: Date.now(), id: sessionId });
}

export function revokeSession(sessionId, reason = 'logout') {
  run(
    'UPDATE sessions SET revoked_at = ?, revoked_reason = ? WHERE id = ? AND revoked_at IS NULL',
    { ts: Date.now(), reason, id: sessionId },
  );
}

export function revokeSessionsForUser(userId, reason = 'revoked', exceptSessionId = null) {
  const params = { ts: Date.now(), reason, userId };
  let sql = 'UPDATE sessions SET revoked_at = ?, revoked_reason = ? WHERE user_id = ? AND revoked_at IS NULL';
  if (exceptSessionId) {
    sql += ' AND id <> ?';
    params.exceptSessionId = exceptSessionId;
  }
  run(sql, params);
}

export function revokeOtherSessions(userId, keepSessionId) {
  return revokeSessionsForUser(userId, 'revoked_other_sessions', keepSessionId);
}

export function revokeDevice(userId, deviceId) {
  run(
    'UPDATE sessions SET revoked_at = ?, revoked_reason = ? WHERE user_id = ? AND device_id = ? AND revoked_at IS NULL',
    { ts: Date.now(), reason: 'device_removed', userId, deviceId },
  );
}

export function purgeExpiredSessions() {
  const run1 = run('DELETE FROM sessions WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)', {
    ts: Date.now() - 7 * 24 * 60 * 60 * 1000, ts2: Date.now() - 7 * 24 * 60 * 60 * 1000,
  });
  return run1.changes;
}

export function devices(userId) {
  return all(
    `SELECT d.id, d.device_label AS label, d.device_type AS type, d.push_enabled AS pushEnabled,
            d.last_used_at AS lastUsedAt, d.created_at AS createdAt,
            (SELECT COUNT(*) FROM sessions s WHERE s.device_id = d.id AND s.revoked_at IS NULL AND s.expires_at > ?) AS activeSessions
       FROM devices d WHERE d.user_id = ? ORDER BY d.last_used_at DESC`,
    { ts: Date.now(), userId },
  );
}

/**
 * `Secure` e obrigatorio sempre que a origem e HTTPS - inclusive em
 * desenvolvimento. Sem isso o cookie de sessao trafegaria em claro se a mesma
 * porta fosse acessada por HTTP.
 */
function secureFlag() {
  return (config.isProd || config.useTls) ? '; Secure' : '';
}

export function sessionCookie(token, expiresAt) {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Expires=${new Date(expiresAt).toUTCString()}`,
  ];
  if (secureFlag()) parts.push('Secure');
  return parts.join('; ');
}

export function csrfCookie(token, expiresAt) {
  const parts = [
    `${CSRF_COOKIE}=${token}`,
    'Path=/',
    'SameSite=Strict',
    `Expires=${new Date(expiresAt).toUTCString()}`,
  ];
  if (secureFlag()) parts.push('Secure');
  return parts.join('; ');
}

export function clearCookies() {
  const base = 'Path=/; Max-Age=0; SameSite=Lax';
  const secure = secureFlag();
  return [
    `${SESSION_COOKIE}=; ${base}; HttpOnly${secure}`,
    `${CSRF_COOKIE}=; ${base}${secure}`,
  ];
}

export function describeDevice(userAgent = '') {
  const ua = String(userAgent);
  const browser = [
    [/Edg\//i, 'Edge'],
    [/OPR\//i, 'Opera'],
    [/Firefox\//i, 'Firefox'],
    [/Chrome\//i, 'Chrome'],
    [/Safari\//i, 'Safari'],
  ].find(([re]) => re.test(ua))?.[1] ?? 'Navegador';
  const os = [
    [/Windows/i, 'Windows'],
    [/Android/i, 'Android'],
    [/iPhone|iPad|iPod/i, 'iOS'],
    [/Mac OS/i, 'macOS'],
    [/Linux/i, 'Linux'],
  ].find(([re]) => re.test(ua))?.[1] ?? 'Desconhecido';
  return `${browser} em ${os}`;
}

export function deviceType(userAgent = '') {
  const ua = String(userAgent);
  if (/iPad|Tablet|PlayBook|Silk|Android(?!.*Mobile)/i.test(ua)) return 'tablet';
  if (/Mobi|iPhone|Android/i.test(ua)) return 'mobile';
  if (ua) return 'desktop';
  return 'other';
}
