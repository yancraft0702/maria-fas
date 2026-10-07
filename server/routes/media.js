import fsp from 'node:fs/promises';
import path from 'node:path';
import router from '../router.js';
import { endpoint } from '../middleware.js';
import config from '../config.js';
import { writeJson } from '../http.js';
import * as v from '../lib/validate.js';
import { notFound, forbidden, badRequest, unprocessable } from '../lib/errors.js';
import { get } from '../db/index.js';
import { createReadStream, parseRange, statKey, keyPath, storageUsage, listKeys } from '../storage/index.js';
import { saveUpload, queueVideoProcessing, mediaStatus, cleanupOrphanMedia } from '../media/upload.js';
import { ffmpegInfo } from '../media/pipeline.js';
import { canViewPost, canDownloadPost } from '../domain/privacy.js';
import { getPost } from '../domain/posts.js';
import { readSingleFile } from './auth.js';

/**
 * Streaming com autorizacao real.
 * Regras:
 *  - midia de perfil (avatars/covers) e publica
 *  - midia de post exige visibilidade do post
 *  - midia de chat/DM exige membro da conversa ou owner
 *  - Live e publica enquanto a LIVE esta ativa
 *  - efeitos de LIVE sao publicos (assets da plataforma)
 */
/** Extrai o mediaId de uma chave de storage:
 *  videos/<mediaId>.mp4 | videos/<mediaId>/720p.mp4 | videos/<mediaId>/360p_0001.ts */
function mediaIdFromKey(key) {
  const first = String(key).split('/')[0] || '';
  return first.replace(/\.[A-Za-z0-9]+$/, '');
}

function authorizeKey(ctx, bucket, key) {
  const userId = ctx.user?.id ?? null;
  const mediaId = mediaIdFromKey(key);
  const lookup = (id) => get('SELECT * FROM media WHERE id = ?', { id });

  if (['avatars', 'covers', 'effects', 'thumbnails', 'sounds'].includes(bucket)) return { ok: true };

  const media = lookup(mediaId);
  if (!media) return { ok: false, reason: 'media_not_found' };

  if (bucket === 'videos') return authorizeMedia(ctx, media);

  if (['attachments', 'audio', 'chat', 'dm', 'live'].includes(bucket)) {
    if (media.owner_id === userId) return { ok: true };
    const dmMessage = get(
      `SELECT 1 AS ok FROM messages WHERE media_id = ? AND conversation_id IN
        (SELECT conversation_id FROM conversation_members WHERE user_id = ?)`,
      { mediaId: media.id, userId },
    );
    if (dmMessage) return { ok: true };
    // Midia de chat global e midia de LIVE sao visiveis a qualquer autenticado.
    if (get('SELECT 1 AS ok FROM global_chat WHERE media_id = ?', { mediaId: media.id })) return { ok: true };
    if (bucket === 'chat' || bucket === 'live') return { ok: true };
    // Audio/imagem anexado a um COMENTARIO (item 8): segue a visibilidade do
    // post onde ele esta. Sem esta checagem o anexo de um comentario publico
    // respondia 403 para todo mundo menos quem escreveu - o audio "funcionava"
    // so na propria conta.
    const emComentario = get(
      `SELECT c.post_id AS post_id FROM comments c
        WHERE c.media_id = ? AND c.status = 'published' LIMIT 1`,
      { mediaId: media.id },
    );
    if (emComentario) {
      const post = get('SELECT * FROM posts WHERE id = ?', { id: emComentario.post_id });
      if (!post) return { ok: false, reason: 'media_not_accessible' };
      return canViewPost(post, ctx.user) ? { ok: true } : { ok: false, reason: 'post_not_visible' };
    }
    return { ok: false, reason: 'media_not_accessible' };
  }
  return { ok: false, reason: 'media_not_found' };
}

function authorizeMedia(ctx, media) {
  const userId = ctx.user?.id ?? null;
  if (media.owner_id === userId) return { ok: true };
  if (media.kind === 'effect') return { ok: true };
  const post = get('SELECT * FROM posts WHERE media_id = ? LIMIT 1', { mediaId: media.id });
  if (post) {
    return canViewPost(post, ctx.user) ? { ok: true } : { ok: false, reason: 'post_not_visible' };
  }
  const story = get("SELECT * FROM stories WHERE media_id = ? AND status = 'published' LIMIT 1", { mediaId: media.id });
  if (story) return { ok: true };
  const sound = get('SELECT id FROM sounds WHERE media_id = ?', { mediaId: media.id });
  if (sound) return { ok: true };
  const inMessage = get(
    `SELECT 1 AS ok FROM messages WHERE media_id = ? AND conversation_id IN
      (SELECT conversation_id FROM conversation_members WHERE user_id = ?)`,
    { mediaId: media.id, userId },
  );
  if (inMessage) return { ok: true };
  const inGlobal = get('SELECT 1 AS ok FROM global_chat WHERE media_id = ?', { mediaId: media.id });
  if (inGlobal) return { ok: true };
  return { ok: false, reason: 'media_not_accessible' };
}

// --------------------------------------------------------------------------
// Streaming (com Range para progressivo)
// --------------------------------------------------------------------------
router.get('/api/media/stream', endpoint(async (ctx, res) => {
  const key = v.str(ctx.query.key, { field: 'key', min: 1, max: 400 });
  const slash = key.indexOf('/');
  if (slash === -1) throw badRequest('invalid_media_key', 'Chave de midia invalida');
  const bucket = key.slice(0, slash);
  const inner = key.slice(slash + 1);

  const auth = authorizeKey(ctx, bucket, inner);
  if (!auth.ok) throw forbidden(auth.reason, 'Midia nao disponivel');

  const stat = statKey(bucket, inner);
  if (!stat) throw notFound('media_not_found', 'Midia nao encontrada');

  const range = parseRange(ctx.headers.range, stat.size);
  const contentType = mimeFor(key);
  const inlineGiftSvg = bucket === 'effects'
    && path.extname(inner).toLowerCase() === '.svg'
    && Boolean(get(
      `SELECT 1 AS ok FROM effects e
         JOIN media m ON m.id = e.media_id
        WHERE e.enabled = 1 AND m.bucket = ? AND m.storage_key = ?`,
      { bucket, key: inner },
    ));

  // ITENS 1 e 2: aceitar `.txt`/`.csv`/`.json` no anexo do chat so e seguro
  // com estas duas cabecalhos. Sem `nosniff`, o navegador pode ignorar o
  // Content-Type e interpretar o arquivo como outra coisa; sem
  // `Content-Disposition`, um `.txt` (ou `.svg`) containing HTML abria como
  // DOCUMENTO no proprio origin da aplicacao - XSS armazenado disparado por
  // um link de download. Nada e escondido: o arquivo continua sendo servido
  // inteiro, com o mesmo conteudo, e e aberto para BAIXAR.
  const disposition = needsAttachment(contentType, key) && !inlineGiftSvg ? 'attachment' : null;

  res.writeHead(range ? 206 : 200, {
    'Content-Type': contentType,
    'Content-Length': range ? range.end - range.start + 1 : stat.size,
    ...(range ? { 'Content-Range': `bytes ${range.start}-${range.end}/${stat.size}` } : {}),
    ...(disposition ? { 'Content-Disposition': `${disposition}; filename="${path.basename(key)}"` } : {}),
    ...(inlineGiftSvg ? {
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'none'; object-src 'none'; base-uri 'none'",
    } : {}),
    'X-Content-Type-Options': 'nosniff',
    'Accept-Ranges': 'bytes',
    'Cache-Control': isStaticAsset(bucket, inner) ? 'public, max-age=31536000, immutable' : 'private, max-age=600',
  });
  const { stream } = createReadStream(bucket, inner, range);
  stream.on('error', () => res.destroy());
  if (ctx.method === 'HEAD') { res.end(); return; }
  stream.pipe(res);
}), { rate: 'media' });

// --------------------------------------------------------------------------
// HLS adaptativo
// --------------------------------------------------------------------------
router.get('/api/media/hls', endpoint(async (ctx, res) => {
  const key = v.str(ctx.query.key, { field: 'key', min: 1, max: 400 });
  const slash = key.indexOf('/');
  const bucket = key.slice(0, slash);
  const inner = key.slice(slash + 1);
  const auth = authorizeKey(ctx, bucket, inner);
  if (!auth.ok) throw forbidden(auth.reason, 'Midia nao disponivel');

  const target = keyPath(bucket, inner);
  if (!statKey(bucket, inner)) throw notFound('hls_not_found', 'Manifesto HLS nao encontrado (transcoding indisponivel?)');
  const dir = path.dirname(target);
  const name = path.basename(inner);
  if (!/^(master|[0-9]+p)\.m3u8$/.test(name) && !/^[0-9]+p_[0-9]+\.ts$/.test(name)) {
    throw badRequest('invalid_hls_path', 'Caminho HLS invalido');
  }
  const content = await fsp.readFile(target);
  res.writeHead(200, {
    'Content-Type': name.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t',
    'Content-Length': content.length,
    'Cache-Control': 'public, max-age=3600',
  });
  res.end(content);
}), { rate: 'media' });

// --------------------------------------------------------------------------
// Upload
// --------------------------------------------------------------------------
router.post('/api/media/upload', endpoint(async (ctx, res) => {
  const purpose = v.oneOf(ctx.query.purpose, ['video', 'audio', 'image', 'file'], { field: 'purpose', fallback: 'video' });
  const { buffer, contentType, filename } = await readSingleFile(ctx, [purpose === 'image' ? 'image' : purpose]);

  const bucket = bucketForPurpose(purpose);
  const saved = await saveUpload({
    ownerId: ctx.user.id,
    category: purpose,
    buffer,
    declaredMime: contentType,
    originalName: filename,
    bucket,
    purpose,
  });

  if (purpose === 'video') {
    queueVideoProcessing({ mediaId: saved.mediaId, buffer, ownerId: ctx.user.id });
    writeJson(res, 202, {
      media: { ...saved, url: `/api/media/stream?key=${encodeURIComponent(`${saved.bucket}/${saved.key}`)}` },
      status: 'processing',
      message: 'Upload recebido. O processamento (thumbnail, multiplas resolucoes, HLS) roda em segundo plano.',
    });
    return;
  }

  writeJson(res, 201, {
    media: { ...saved, url: `/api/media/stream?key=${encodeURIComponent(`${saved.bucket}/${saved.key}`)}` },
    status: saved.status,
  });
}), { auth: true, rate: 'upload' });

router.get('/api/media/:id/status', endpoint(async (ctx, res) => {
  const mediaId = v.id(ctx.params.id, { field: 'id' });
  const media = get('SELECT owner_id FROM media WHERE id = ?', { id: mediaId });
  if (!media) throw notFound('media_not_found', 'Midia nao encontrada');
  if (media.owner_id !== ctx.user.id && ctx.user.role === 'user') {
    throw forbidden('media_not_accessible', 'Midia nao disponivel');
  }
  const status = mediaStatus(mediaId);
  writeJson(res, 200, { media: status });
}), { auth: true });

router.get('/api/media/config', endpoint(async (ctx, res) => {
  const ffmpeg = await ffmpegInfo();
  writeJson(res, 200, {
    limits: {
      videoBytes: config.maxVideoBytes,
      imageBytes: config.maxImageBytes,
      audioBytes: config.maxAudioBytes,
      fileBytes: config.maxFileBytes,
      videoDurationSeconds: config.maxVideoDuration,
    },
    transcode: config.mediaTranscode,
    hls: config.mediaHls,
    ffmpeg: { available: ffmpeg.available, ffprobe: ffmpeg.ffprobe },
    accepted: {
      video: ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-matroska', 'video/3gpp'],
      image: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
      audio: ['audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/ogg', 'audio/wav', 'audio/webm'],
      file: ['application/pdf', 'text/plain', 'application/zip', 'text/csv', 'application/json'],
    },
  });
}), { rate: 'default' });

// --------------------------------------------------------------------------
// Download autorizado (regra de privacidade no backend)
// --------------------------------------------------------------------------
router.get('/api/media/download', endpoint(async (ctx, res) => {
  const postId = v.str(ctx.query.postId, { field: 'postId', min: 1, max: 64 });
  const post = getPost(postId);
  if (!post) throw notFound('post_not_found', 'Conteudo nao encontrado');
  if (!canViewPost(post, ctx.user)) throw forbidden('post_not_visible', 'Conteudo indisponivel');
  if (!canDownloadPost(ctx.user?.id ?? null, post)) throw forbidden('download_not_allowed', 'O autor nao permite downloads');
  if (!post.media_id) throw unprocessable('no_media', 'Este conteudo nao tem arquivo para download');
  const media = get('SELECT * FROM media WHERE id = ?', { mediaId: post.media_id });
  if (!media) throw notFound('media_not_found', 'Arquivo nao encontrado');
  const stat = statKey(media.bucket, media.storage_key);
  if (!stat) throw notFound('media_not_found', 'Arquivo nao encontrado');
  const filename = buildFilename(post, media);
  res.writeHead(200, {
    'Content-Type': media.mime,
    'Content-Length': stat.size,
    'Content-Disposition': `attachment; filename="${filename}"`,
  });
  const { stream } = createReadStream(media.bucket, media.storage_key);
  stream.pipe(res);
}), { rate: 'media' });

// --------------------------------------------------------------------------
// Housekeeping
// --------------------------------------------------------------------------
router.get('/api/admin/storage/usage', endpoint(async (ctx, res) => {
  if (ctx.user.role === 'user') throw forbidden('admin_only', 'Acesso restrito a equipe');
  const usage = storageUsage();
  const perBucket = {};
  for (const bucket of ['avatars', 'covers', 'videos', 'thumbnails', 'audio', 'chat', 'dm', 'live', 'effects', 'sounds', 'attachments']) {
    const entries = listKeys(bucket);
    perBucket[bucket] = {
      files: entries.length,
      bytes: entries.reduce((acc, e) => acc + e.size, 0),
    };
  }
  writeJson(res, 200, { total: usage, buckets: perBucket });
}), { auth: true, rate: 'default' });

router.post('/api/admin/storage/cleanup', endpoint(async (ctx, res) => {
  if (ctx.user.role === 'user') throw forbidden('admin_only', 'Acesso restrito a equipe');
  const dryRun = ctx.body.dryRun !== false;
  const removed = await cleanupOrphanMedia({ dryRun });
  writeJson(res, 200, { dryRun, removed: removed.length, items: removed.slice(0, 50) });
}), { auth: true, rate: 'write' });

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------
function bucketForPurpose(purpose) {
  return {
    video: 'videos', audio: 'audio', image: 'chat', file: 'attachments',
  }[purpose] || 'attachments';
}

function mimeFor(key) {
  const ext = path.extname(key).toLowerCase();
  return {
    '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
    '.mkv': 'video/x-matroska', '.3gp': 'video/3gpp',
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
    '.gif': 'image/gif', '.svg': 'image/svg+xml',
    '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg',
    '.opus': 'audio/ogg', '.wav': 'audio/wav', '.flac': 'audio/flac',
    '.pdf': 'application/pdf', '.txt': 'text/plain', '.csv': 'text/csv',
    '.zip': 'application/zip', '.json': 'application/json',
    '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t',
  }[ext] || 'application/octet-stream';
}

/**
 * O navegador pode EXECUTAR estes tipos se abrirem como documento. Eles sao
 * servidos para BAIXAR, nunca interpretados no origin da aplicacao.
 */
function needsAttachment(contentType, key) {
  const ext = path.extname(key).toLowerCase();
  if (['.txt', '.csv', '.json', '.svg', '.htm', '.html', '.xml', '.xhtml'].includes(ext)) return true;
  // Sem extensao confiavel: tudo que possa ser interpretado como documento
  // tambem vai para download.
  return /^(text\/|application\/(json|xml|xhtml))/i.test(contentType);
}

function isStaticAsset(bucket, key) {
  if (['avatars', 'covers', 'effects', 'thumbnails', 'sounds'].includes(bucket)) return true;
  return false;
}

function buildFilename(post, media) {
  const ext = path.extname(media.storage_key) || '.bin';
  const slug = String(post.caption || 'pulse')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48) || 'pulse';
  return `${slug}${ext}`;
}
