import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import logger from './lib/logger.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// --------------------------------------------------------------------------
// Carregamento de .env (UTF-8) sem depender de pacote externo.
// Valores ja presentes no ambiente tem prioridade (padrao de container/CI).
// --------------------------------------------------------------------------
function loadEnvFile() {
  for (const name of ['.env', '.env.local']) {
    const file = path.join(ROOT, name);
    if (!fs.existsSync(file)) continue;
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
      throw new Error(`Falha ao ler ${name}: ${err.message}`);
    }
    // remove BOM UTF-8
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
        (value.startsWith("'") && value.endsWith("'") && value.length > 1)
      ) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }
}
loadEnvFile();

const env = process.env;

function str(key, fallback = '') {
  const v = env[key];
  return v === undefined || v === '' ? fallback : v;
}
function num(key, fallback) {
  const v = env[key];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) {
    throw new Error(`Variavel de ambiente ${key} invalida: "${v}" (esperado numero)`);
  }
  return n;
}
function bool(key, fallback = false) {
  const v = env[key];
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on', 'sim'].includes(v.trim().toLowerCase());
}
function list(key, fallback = []) {
  const v = env[key];
  if (!v) return fallback;
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const nodeEnv = str('NODE_ENV', 'development');
const isProd = nodeEnv === 'production';

// --------------------------------------------------------------------------
// HTTPS de desenvolvimento (item 9/10)
// --------------------------------------------------------------------------
// Com TLS_CERT_PATH + TLS_KEY_PATH o servidor sobe em HTTPS REAL (https://),
// o que torna a origem um contexto seguro: camera, microfone, WebRTC e LIVE
// passam a funcionar tambem no celular da rede local, em https://IP:PORTA.
// O certificado NUNCA fica no frontend nem no repositorio: vive em
// `.certs/` (git-ignored) e e lido so pelo servidor.
const tlsCertPath = str('TLS_CERT_PATH');
const tlsKeyPath = str('TLS_KEY_PATH');
const useTls = Boolean(tlsCertPath && tlsKeyPath);
const port = num('PORT', 3000);
const defaultPublicUrl = `${useTls ? 'https' : 'http'}://localhost:${port}`;

const config = {
  nodeEnv,
  isProd,
  host: str('HOST', '0.0.0.0'),
  port,
  useTls,
  tlsCertPath: tlsCertPath ? path.resolve(ROOT, tlsCertPath) : '',
  tlsKeyPath: tlsKeyPath ? path.resolve(ROOT, tlsKeyPath) : '',
  tlsCaPath: str('TLS_CA_PATH') ? path.resolve(ROOT, str('TLS_CA_PATH')) : '',
  tlsPassphrase: str('TLS_PASSPHRASE'),
  publicUrl: str('PUBLIC_URL', defaultPublicUrl).replace(/\/+$/, ''),
  corsOrigins: list('CORS_ORIGINS'),

  sessionSecret: str('SESSION_SECRET'),
  scryptCost: num('SCRYPT_COST', 16384),
  sessionTtlMs: num('SESSION_TTL_MS', 30 * 24 * 60 * 60 * 1000),

  databasePath: path.resolve(ROOT, str('DATABASE_PATH', './data/pulse.db')),
  storageRoot: path.resolve(ROOT, str('STORAGE_ROOT', './storage')),

  ffmpegPath: str('FFMPEG_PATH'),
  maxVideoDuration: num('MAX_VIDEO_DURATION', 600),
  maxVideoBytes: num('MAX_VIDEO_BYTES', 100 * 1024 * 1024),
  maxImageBytes: num('MAX_IMAGE_BYTES', 20 * 1024 * 1024),
  maxAudioBytes: num('MAX_AUDIO_BYTES', 20 * 1024 * 1024),
  maxFileBytes: num('MAX_FILE_BYTES', 50 * 1024 * 1024),
  mediaTranscode: bool('MEDIA_TRANSCODE', true),
  mediaHls: bool('MEDIA_HLS', true),

  stunUrls: list('STUN_URLS', ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302']),
  // TURN real (item 1). Aceita:
  //   TURN_URL        = "turn:host:3478"  (usa TURN_USERNAME/TURN_CREDENTIAL)
  //   TURN_URLS       = lista separada por virgula, para UDP + TCP/TLS juntos
  //   TURN_URLS       = "user:pass@host:3478?transport=udp" (coturn gera assim)
  turnUrl: str('TURN_URL'),
  turnUrlsRaw: str('TURN_URLS'),
  turnUsername: str('TURN_USERNAME'),
  turnCredential: str('TURN_CREDENTIAL'),
  // Item 3: segredo compartilhado do TURN REST API. Com ele, o servidor emite
  // credenciais que EXPIRAM (usuario = "expiracao:rotulo", senha =
  // HMAC-SHA1 do segredo) e o segredo nunca vai para o navegador. Sem ele, o
  // projeto cai no modo estatico TURN_USERNAME/TURN_CREDENTIAL.
  turnSecret: str('TURN_SECRET'),
  // Validade da credencial efemera, em segundos (padrao 1 hora).
  turnTtlSeconds: (() => {
    const v = Number(str('TURN_TTL_SECONDS', ''));
    return Number.isFinite(v) && v > 0 ? Math.trunc(v) : 3600;
  })(),
  liveTokenSecret: str('LIVE_TOKEN_SECRET'),
  liveMaxViewers: num('LIVE_MAX_VIEWERS', 500),
  liveMaxPeers: num('LIVE_MAX_PEERS', 13),
  effectDailyLimit: num('EFFECT_DAILY_LIMIT', 10),

  giphyApiKey: str('GIPHY_API_KEY'),
  giphyBaseUrl: str('GIPHY_BASE_URL', 'https://api.giphy.com'),

  vapidPublicKey: str('VAPID_PUBLIC_KEY'),
  vapidPrivateKey: str('VAPID_PRIVATE_KEY'),
  vapidSubject: str('VAPID_SUBJECT', 'mailto:admin@localhost'),

  rateLimitWindowMs: num('RATE_LIMIT_WINDOW_MS', 60_000),
  rateLimitMax: num('RATE_LIMIT_MAX', 600),
  authMaxAttempts: num('AUTH_MAX_ATTEMPTS', 8),
  authAttemptWindowMs: num('AUTH_ATTEMPT_WINDOW_MS', 15 * 60 * 1000),

  adminEmail: str('ADMIN_EMAIL'),
  adminUsername: str('ADMIN_USERNAME'),
  adminPassword: str('ADMIN_PASSWORD'),
  demoPassword: str('DEMO_PASSWORD'),

  youtubeApiKey: str('YOUTUBE_API_KEY'),

  // Envio de email. Sem SMTP configurado, o e-mail fica registrado em log
  // (nunca fingimos entrega). Configure SMTP_* para envio real.
  smtp: (() => {
    const host = str('SMTP_HOST');
    if (!host) return null;
    return {
      host,
      port: num('SMTP_PORT', 587),
      secure: bool('SMTP_SECURE', false),
      user: str('SMTP_USER'),
      password: str('SMTP_PASSWORD'),
      from: str('SMTP_FROM', 'MARIA FÃS <no-reply@mariafas.local>'),
      async send({ to, subject, text, html }) {
        // Envio real exige uma lib SMTP (nodemailer). Sem ela, registramos.
        logger.warn('SMTP_HOST configurado mas nenhum transporte SMTP instalado; e-mail registrado em log', { to, subject });
        return { delivered: false, reason: 'smtp_transport_missing', to, subject };
      },
    };
  })(),
};

if (!config.sessionSecret) {
  if (config.isProd) {
    throw new Error('SESSION_SECRET e obrigatorio em producao. Gere com: npm run keys');
  }
  config.sessionSecret = crypto.randomBytes(48).toString('base64url');
  logger.warn('SESSION_SECRET ausente: usando segredo temporario para desenvolvimento');
}
if (!config.liveTokenSecret) config.liveTokenSecret = config.sessionSecret;

/**
 * Interpreta a configuracao de TURN.
 *
 * Cada entrada pode vir de tres formas:
 *   1) `turn:host:3478?transport=udp`            -> usa TURN_USERNAME/CREDENTIAL
 *   2) `user:pass@host:3478?transport=tcp`      -> credenciais embutidas
 *   3) `turns:host:5349`                         -> TURN sobre TLS (443)
 *
 * Uma entrada SEM credencial (nem global nem embutidas) e DESCARTADA: o
 * navegador nao consegue autenticar nela, e melhor nao oferecer um servidor
 * inútil do que fingir que o TURN esta pronto.
 *
 * @returns {{urls: string, username: string, credential: string}[]}
 */
export function turnServers() {
  const raw = [config.turnUrl, config.turnUrlsRaw]
    .filter(Boolean)
    .join(',')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const seen = new Set();
  const out = [];
  for (const entry of raw) {
    let username = config.turnUsername;
    let credential = config.turnCredential;
    let url = entry;

    const at = entry.lastIndexOf('@');
    if (at > 0) {
      const userinfo = entry.slice(0, at);
      url = entry.slice(at + 1);
      const colon = userinfo.indexOf(':');
      if (colon >= 0) {
        username = userinfo.slice(0, colon);
        credential = userinfo.slice(colon + 1);
      } else {
        username = userinfo;
      }
      url = /^[a-z]+:/.test(url) ? url : `turn:${url}`;
    } else if (!/^(stun|stuns|turn|turns):/.test(url)) {
      url = `turn:${url}`;
    }

    if (!username || !credential) continue;
    const key = `${url}|${username}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ urls: [url], username, credential });
  }
  return out;
}

/**
 * URLs de TURN SEM credencial, para o gerador de credenciais efemeras
 * reaproveitar o mesmo interpretador (UDP/TCP/TURNS).
 *
 * @returns {{urls: string}[]} lista de URLs de TURN declaradas
 */
export function turnUrls() {
  const raw = [config.turnUrl, config.turnUrlsRaw]
    .filter(Boolean)
    .join(',')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const entry of raw) {
    let url = entry;
    const at = entry.lastIndexOf('@');
    if (at > 0) {
      const userinfo = entry.slice(0, at);
      url = entry.slice(at + 1);
      if (!userinfo.includes(':')) continue; // sem senha: nada a fazer
    } else if (!/^(turn|turns):/.test(url)) {
      continue;
    }
    if (!/^(turn|turns):/.test(url)) url = `turn:${url}`;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ urls: [url] });
  }
  return out;
}

/**
 * @returns {boolean} Ha TURN CONFIGURADO (variaveis de ambiente com credencial).
 * Isso NAO significa relay funcionando: relay de verdade so aparece quando um
 * candidato `relay` e gathering e o par conectado o usa (medido no cliente).
 */
export function turnConfigured() {
  if (config.turnSecret) return turnUrls().length > 0;
  return turnServers().length > 0;
}

/** @returns {boolean} Servico GIPHY esta configurado */
export function giphyConfigured() {
  return Boolean(config.giphyApiKey);
}

/** @returns {boolean} Push (VAPID) esta configurado */
export function pushConfigured() {
  return Boolean(config.vapidPublicKey && config.vapidPrivateKey);
}

export default config;
