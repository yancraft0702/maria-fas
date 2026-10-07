import fs from 'node:fs';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import router from './router.js';
import { endpoint } from './middleware.js';
import config, { ROOT, turnConfigured, giphyConfigured, pushConfigured } from './config.js';
import { writeJson } from './http.js';
import { get, scalar } from './db/index.js';
import logger from './lib/logger.js';
import hub from './realtime/hub.js';
import { ffmpegInfo } from './media/pipeline.js';
import { storageUsage } from './storage/index.js';

// --------------------------------------------------------------------------
// Healthcheck
// --------------------------------------------------------------------------
let ffmpegCache = null;
let storageCache = { at: 0, usage: { totalBytes: 0, files: 0 } };

async function ffmpegInfoCached(maxAgeMs = 60000) {
  if (ffmpegCache && Date.now() - ffmpegCache.at < maxAgeMs) return ffmpegCache.value;
  const value = await ffmpegInfo();
  ffmpegCache = { at: Date.now(), value };
  return value;
}

/**
 * Uso do storage com cache curto.
 *
 * A contagem percorre os buckets recursivamente: e' cara em storage grande,
 * por isso o cache de 15s. `?fresh=1` ignora o cache (diagnostico e testes),
 * sem nunca inventar numero - se o calculo falhar, devolve o ultimo valor
 * conhecido e o healthcheck reflete a falha em `checks.storage`.
 */
async function storageUsageCached(maxAgeMs = 15000, fresh = false) {
  if (!fresh && Date.now() - storageCache.at < maxAgeMs) return storageCache.usage;
  try {
    const usage = storageUsage();
    storageCache = { at: Date.now(), usage };
    return usage;
  } catch (err) {
    logger.warn('nao foi possivel medir o storage', { error: err.message });
    return storageCache.usage;
  }
}

router.get('/api/health', endpoint(async (ctx, res) => {
  const startedAt = process.hrtime.bigint();
  let dbOk = false;
  let dbLatencyMs = 0;
  try {
    const t0 = process.hrtime.bigint();
    scalar('SELECT 1 AS ok', {}, 0);
    dbLatencyMs = Number(process.hrtime.bigint() - t0) / 1e6;
    dbOk = true;
  } catch (err) {
    logger.error('healthcheck: banco indisponivel', { error: err.message });
  }

  const ffmpeg = await ffmpegInfoCached();
  const storageOk = await storageUsageCached(15000, ctx.query.fresh === '1');
  const storage = storageOk;
  const checks = {
    database: dbOk,
    storage: storageOk !== null,
    ffmpeg: ffmpeg.available,
    websocket: Boolean(hub.wss),
  };
  const healthy = dbOk;

  writeJson(res, healthy ? 200 : 503, {
    status: healthy ? 'ok' : 'degraded',
    version: '1.0.0',
    uptimeSeconds: Math.floor(process.uptime()),
    checkMs: Math.round(Number(process.hrtime.bigint() - startedAt) / 1e6),
    checks: {
      ...checks,
      databaseLatencyMs: Number(dbLatencyMs.toFixed(2)),
      storageFiles: storage.files,
      storageBytes: storage.totalBytes,
    },
    features: {
      transcode: config.mediaTranscode && ffmpeg.available,
      hls: config.mediaHls && ffmpeg.available,
      turn: turnConfigured(),
      giphy: giphyConfigured(),
      push: pushConfigured(),
    },
    realtime: hub.stats(),
  });
}));

router.get('/api/ready', endpoint(async (ctx, res) => {
  const count = get('SELECT COUNT(*) AS c FROM users')?.c ?? -1;
  if (count < 0) {
    writeJson(res, 503, { ready: false, reason: 'database_unavailable' });
    return;
  }
  writeJson(res, 200, { ready: true, users: count });
}));

// --------------------------------------------------------------------------
// Metadados da aplicacao (capacidades reais, nunca inventadas)
// --------------------------------------------------------------------------
router.get('/api/app/config', endpoint(async (ctx, res) => {
  const ffmpeg = await ffmpegInfo();
  writeJson(res, 200, {
    name: 'MARIA FÃS',
    version: '1.0.0',
    features: {
      live: true,
      giphy: giphyConfigured(),
      push: pushConfigured(),
      hls: config.mediaHls && ffmpeg.available,
      transcode: config.mediaTranscode && ffmpeg.available,
      turn: turnConfigured(),
    },
    limits: {
      videoBytes: config.maxVideoBytes,
      imageBytes: config.maxImageBytes,
      audioBytes: config.maxAudioBytes,
      fileBytes: config.maxFileBytes,
      videoDurationSeconds: config.maxVideoDuration,
      liveMaxViewers: config.liveMaxViewers,
      effectDailyLimit: config.effectDailyLimit,
    },
    moderationWindows: [2, 4, 6, 10],
  });
}));

// --------------------------------------------------------------------------
// Arquivos estaticos (PWA). Servidos sem passar pelas regras de API.
// --------------------------------------------------------------------------
const PUBLIC_DIR = path.join(ROOT, 'web');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

export async function serveStatic(ctx, res) {
  let pathname = decodeURIComponent(ctx.path);
  if (pathname === '/' || pathname === '') pathname = '/index.html';
  if (pathname.endsWith('/')) pathname += 'index.html';

  const target = path.resolve(PUBLIC_DIR, `.${pathname}`);
  if (!target.startsWith(path.resolve(PUBLIC_DIR))) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403');
    return;
  }

  let file = target;
  let stat = statSafe(file);
  if (!stat && !path.extname(pathname)) {
    // SPA fallback: rotas do cliente (/, /inbox, /@user, ...)
    file = path.join(PUBLIC_DIR, 'index.html');
    stat = statSafe(file);
  }
  if (!stat || !stat.isFile()) {
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: { code: 'not_found', message: `Pagina nao encontrada: ${pathname}` } }));
    return;
  }

  const ext = path.extname(file).toLowerCase();
  const isShell = file.endsWith('index.html') || file.endsWith('sw.js');
  const isApplicationCode = ['.js', '.mjs', '.css', '.json', '.webmanifest'].includes(ext);
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': isShell
      ? 'no-cache'
      : isApplicationCode
        ? 'no-cache'
        : 'public, max-age=3600, stale-while-revalidate=86400',
    ...(file.endsWith('sw.js') ? { 'Service-Worker-Allowed': '/' } : {}),
  });
  if (ctx.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(file).pipe(res);
}

function statSafe(file) {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

export { PUBLIC_DIR };
