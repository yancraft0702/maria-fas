import crypto from 'node:crypto';
import config, { pushConfigured } from './config.js';
import logger from './lib/logger.js';
import { all, run } from './db/index.js';
import { newId } from './lib/ids.js';
import https from 'node:https';
import http from 'node:http';

/**
 * Web Push (RFC 8291/8292) com VAPID (RFC 8292).
 * Implementacao real: as chaves vem de VAPID_PRIVATE_KEY / VAPID_PUBLIC_KEY.
 * Sem chaves => push desabilitado (nada e inventado) e a API responde 503.
 */

// ---------- VAPID ----------
function b64urlToBuf(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(padded, 'base64');
}

function derivePublicKey(privateKey) {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(b64urlToBuf(privateKey));
  return ecdh.getPublicKey();
}

let vapidCache = null;
function vapid() {
  if (vapidCache) return vapidCache;
  if (!pushConfigured()) return null;
  try {
    const publicKey = config.vapidPublicKey || derivePublicKey(config.vapidPrivateKey).toString('base64url');
    vapidCache = {
      publicKey,
      privateKey: b64urlToBuf(config.vapidPrivateKey),
      subject: config.vapidSubject.startsWith('mailto:') || config.vapidSubject.startsWith('https://')
        ? config.vapidSubject
        : `mailto:${config.vapidSubject}`,
    };
    return vapidCache;
  } catch (err) {
    logger.error('chaves VAPID invalidas', { error: err.message });
    return null;
  }
}

export function publicVapidKey() {
  const v = vapid();
  return v ? v.publicKey : null;
}

function vapidHeader(audience, v, expiresIn = 12 * 60 * 60) {
  const header = { typ: 'JWT', alg: 'ES256' };
  const payload = {
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + expiresIn,
    sub: v.subject,
  };
  const enc = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const signingInput = `${enc(header)}.${enc(payload)}`;
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(v.privateKey);
  const signature = crypto.createSign('SHA256').update(signingInput).sign({
    key: ecdh.getPrivateKey(),
    dsaEncoding: 'ieee-p1363',
  });
  return `${signingInput}.${signature.toString('base64url')}`;
}

// ---------- Payload encryption (aes128gcm) ----------
function hkdf(salt, info, ikm, length) {
  return Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from(info, 'utf8'), length));
}

async function webPushEncrypt({ payload, p256dh, auth }) {
  const receiverPublic = b64urlToBuf(p256dh);
  const authSecret = b64urlToBuf(auth);
  const ecdh = crypto.createECDH('prime256v1');
  const ephemeral = ecdh.generateKeys();
  const senderPublic = ecdh.getPublicKey();
  const sharedSecret = ecdh.computeSecret(receiverPublic);
  const salt = crypto.randomBytes(16);

  // RFC 8291: PRK = HKDF(auth_secret, "WebPush: info", ecdh_secret)
  const prk = hkdf(authSecret, 'WebPush: info\0', sharedSecret, 32);
  const contentKey = hkdf(salt, 'Content-Encoding: aes128gcm\0', prk, 16);
  const nonce = hkdf(salt, 'Content-Encoding: aes128gcm\0', prk, 12);

  const cipher = crypto.createCipheriv('aes-128-gcm', contentKey, nonce);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(payload, 'utf8')), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096, 0); // record size de 4096

  // Header: 0x80 | salt(16) | rs(4) | keyid(sender public key, 65) | ciphertext | authTag
  return Buffer.concat([Buffer.from([0x80]), salt, rs, senderPublic, ciphertext, authTag]);
}

async function request(urlString, { method = 'POST', headers = {}, body = null, timeout = 15_000 }) {
  const url = new URL(urlString);
  const lib = url.protocol === 'http:' ? http : https;
  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'http:' ? 80 : 443),
        path: `${url.pathname}${url.search}`,
        method,
        headers,
        timeout,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/**
 * Envia push para todas as subscriptions do usuario.
 * Nunca lanca: falha de push e registrada e nao afeta a acao principal.
 */
export async function sendPush({ userId, title, body, url = '/', tag = '', icon = '/icons/icon-192.png' }) {
  if (!pushConfigured()) return { sent: 0, skipped: 'push_not_configured' };
  const subs = all('SELECT * FROM push_subscriptions WHERE user_id = ? AND failure_count < 6', { userId });
  if (!subs.length) return { sent: 0, skipped: 'no_subscriptions' };
  const v = vapid();
  if (!v) return { sent: 0, skipped: 'vapid_invalid' };

  const payload = JSON.stringify({ title, body, url, tag, icon });
  let sent = 0;
  let removed = 0;

  for (const sub of subs) {
    try {
      const audience = new URL(sub.endpoint).origin;
      const jwt = vapidHeader(audience, v);
      let headers = {
        TTL: '86400',
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        'Content-Length': '0',
        Authorization: `vapid t=${jwt}, k=${v.publicKey}`,
      };
      let bodyBuffer = Buffer.alloc(0);
      try {
        bodyBuffer = await webPushEncrypt({ payload, p256dh: sub.p256dh, auth: sub.auth });
        headers['Content-Length'] = String(bodyBuffer.length);
      } catch (err) {
        logger.debug('criptografia push indisponivel, enviando sem payload', { error: err.message });
      }
      const res = await request(sub.endpoint, { method: 'POST', headers, body: bodyBuffer });
      if (res.status >= 200 && res.status < 300) {
        sent += 1;
        run('UPDATE push_subscriptions SET last_used_at = ?, failure_count = 0 WHERE id = ?', { ts: Date.now(), id: sub.id });
      } else if (res.status === 404 || res.status === 410) {
        run('DELETE FROM push_subscriptions WHERE id = ?', { id: sub.id });
        removed += 1;
      } else {
        run('UPDATE push_subscriptions SET failure_count = failure_count + 1 WHERE id = ?', { id: sub.id });
        logger.warn('push recusado', { status: res.status, sub: sub.id });
      }
    } catch (err) {
      run('UPDATE push_subscriptions SET failure_count = failure_count + 1 WHERE id = ?', { id: sub.id });
      logger.warn('falha ao enviar push', { error: err.message, sub: sub.id });
    }
  }
  return { sent, removed };
}

export function saveSubscription({ userId, endpoint, keys, deviceId = null }) {
  const id = newId('sub');
  run(
    `INSERT INTO push_subscriptions (id, user_id, device_id, endpoint, p256dh, auth, created_at, last_used_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh,
       auth = excluded.auth, last_used_at = excluded.last_used_at, failure_count = 0`,
    { id, userId, deviceId, endpoint, p256dh: keys.p256dh, auth: keys.auth, createdAt: Date.now(), lastUsedAt: Date.now() },
  );
  return id;
}

export function removeSubscription({ userId, endpoint }) {
  run('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?', { userId, endpoint });
  return { removed: true };
}

export async function testPush(userId) {
  return sendPush({
    userId,
    title: 'MARIA FÃS',
    body: 'Notificacoes push estao funcionando.',
    url: '/notifications',
  });
}
