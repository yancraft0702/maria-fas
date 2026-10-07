import fsp from 'node:fs/promises';
import path from 'node:path';
import config from '../config.js';
import { newId } from '../lib/ids.js';
import { all, run, get, transaction } from '../db/index.js';
import { writeFile, deleteKey, bucketPath } from '../storage/index.js';
import { processVideo, probeMedia, probeImage, probeAudio, ffmpegAvailable } from './pipeline.js';
import { payloadTooLarge, unsupportedMedia, unprocessable, badRequest } from '../lib/errors.js';
import logger from '../lib/logger.js';

export const ACCEPTED = {
  video: {
    mimes: ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-matroska', 'video/3gpp', 'video/x-m4v', 'video/mpeg'],
    extensions: ['.mp4', '.mov', '.webm', '.mkv', '.3gp', '.m4v'],
    maxBytes: () => config.maxVideoBytes,
    bucket: 'videos',
    kind: 'video',
  },
  image: {
    mimes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
    extensions: ['.jpg', '.jpeg', '.png', '.webp', '.gif'],
    maxBytes: () => config.maxImageBytes,
    bucket: 'avatars',
    kind: 'image',
  },
  audio: {
    mimes: ['audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/ogg', 'audio/webm', 'audio/wav', 'audio/x-m4a', 'audio/webm;codecs=opus'],
    extensions: ['.mp3', '.m4a', '.aac', '.ogg', '.oga', '.wav', '.webm'],
    maxBytes: () => config.maxAudioBytes,
    bucket: 'audio',
    kind: 'audio',
  },
  file: {
    mimes: [
      'application/pdf', 'text/plain', 'application/zip', 'application/x-zip-compressed',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'text/csv', 'application/json',
    ],
    extensions: ['.pdf', '.txt', '.zip', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.csv', '.json'],
    maxBytes: () => config.maxFileBytes,
    bucket: 'attachments',
    kind: 'file',
  },
};

/**
 * Detecta o tipo real pelos bytes (magic numbers).
 * O MIME declarado pelo cliente NUNCA e authority.
 */
export function sniffMime(buffer) {
  if (!buffer || buffer.length < 12) return 'application/octet-stream';
  const b = buffer;
  const ascii = (start, end) => b.toString('ascii', start, end);

  // MP4 / MOV / M4A (ftyp)
  if (ascii(4, 8) === 'ftyp') {
    const brand = ascii(8, 12);
    if (brand.startsWith('qt')) return 'video/quicktime';
    if (brand.startsWith('M4A') || brand.startsWith('M4B')) return 'audio/mp4';
    if (brand.startsWith('heic') || brand.startsWith('heix')) return 'image/heic';
    return 'video/mp4';
  }
  // Matroska / WebM (EBML)
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) {
    const docType = ascii(0, 64);
    if (docType.includes('webm')) return 'video/webm';
    return 'video/x-matroska';
  }
  // WebM audio-only shares the EBML header; refined by caller using ffmpeg.
  // MP3 (ID3 or frame sync)
  if (ascii(0, 3) === 'ID3') return 'audio/mpeg';
  if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return 'audio/mpeg';
  // WAV (RIFF....WAVE)
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return 'audio/wav';
  // OGG
  if (ascii(0, 4) === 'OggS') return 'audio/ogg';
  // FLAC
  if (ascii(0, 4) === 'fLaC') return 'audio/flac';
  // JPEG
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  // PNG
  if (b[0] === 0x89 && ascii(1, 4) === 'PNG') return 'image/png';
  // GIF (GIF87a / GIF89a). O corte e [0, 4): comparar com 'GIF8' usando 3
  // bytes fazia a checagem nunca passar e TODO GIF era recusado com 415
  // "application/octet-stream" - nem no chat nem em posts.
  if (ascii(0, 4) === 'GIF8') return 'image/gif';
  // WEBP (RIFF....WEBP)
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  // AVIF/HEIF (ftyp brands already handled)
  if (ascii(4, 8) === 'ftyp' && ascii(8, 12).startsWith('avif')) return 'image/avif';
  // PDF
  if (ascii(0, 5) === '%PDF-') return 'application/pdf';
  // ZIP (also docx/xlsx/pptx/odt)
  if (b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07)) return 'application/zip';
  // GZIP
  if (b[0] === 0x1f && b[1] === 0x8b) return 'application/gzip';
  if (b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0) return 'application/vnd.ms-excel';
  if (b[0] === 0x50 && b[1] === 0x4b) return 'application/zip';
  // 3GP
  if (ascii(0, 4) === '....ftyp3g') return 'video/3gpp';
  // ITENS 1 e 2: arquivo de TEXTO nao tem magic number, entao terminava em
  // `application/octet-stream` e o backend respondia 415 a todos os tipos que
  // o proprio menu de anexo oferece (.txt, .csv, .json). Aqui o conteudo e
  // lido de verdade: `pareceTexto` so aceita conteudo sem byte nulo e sem
  // caractere de controle, entao um binario com extensao .txt continua sendo
  // recusado. O rotulo exato entre text/plain, text/csv e application/json
  // fica por conta da extensao, em `validateUpload`.
  if (pareceTexto(buffer)) return 'text/plain';
  return 'application/octet-stream';
}

/**
 * O conteudo e texto? Byte nulo e caractere de controle (fora de tab, quebra
 * de linha e alimentacao de formulario) sao a marca de binario. A janela e
 * limitada aos primeiros 8 KB, que ja e o bastante para decidir.
 */
function pareceTexto(buffer) {
  const limite = Math.min(buffer.length, 8192);
  if (limite < 1) return false;
  for (let i = 0; i < limite; i += 1) {
    const c = buffer[i];
    if (c === 0x09 || c === 0x0a || c === 0x0d || c === 0x0c || c === 0x08) continue;
    if (c < 0x20) return false;
  }
  return true;
}

/** Rotulo mais preciso para arquivo de texto, pela extensao. */
const MIME_POR_EXTENSAO = {
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.json': 'application/json',
};

const EXT_FOR_MIME = {
  'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/webm': '.webm', 'video/x-matroska': '.mkv',
  'video/3gpp': '.3gp', 'video/x-m4v': '.m4v', 'image/jpeg': '.jpg', 'image/png': '.png',
  'image/webp': '.webp', 'image/gif': '.gif', 'audio/mpeg': '.mp3', 'audio/mp4': '.m4a',
  'audio/aac': '.aac', 'audio/ogg': '.ogg', 'audio/wav': '.wav', 'audio/x-m4a': '.m4a',
  'application/pdf': '.pdf', 'text/plain': '.txt', 'application/zip': '.zip', 'text/csv': '.csv',
  'application/json': '.json', 'application/octet-stream': '.bin',
};

export function sanitizeFilename(name) {
  const base = String(name || 'arquivo')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/]/g, '_')
    .replace(/\.{2,}/g, '.')
    .slice(-120);
  return base || 'arquivo';
}

/**
 * Valida categoria x MIME real x tamanho. Lanca 413/415 reais.
 */
export function validateUpload({ category, buffer, declaredMime, originalName }) {
  const spec = ACCEPTED[category];
  if (!spec) throw badRequest('invalid_upload_category', `Categoria de upload invalida: ${category}`);
  const size = buffer.length;
  if (size === 0) throw unprocessable('empty_file', 'Arquivo vazio');
  const max = spec.maxBytes();
  if (size > max) {
    throw payloadTooLarge('file_too_large', `Arquivo de ${(size / 1048576).toFixed(1)} MB excede o limite de ${(max / 1048576).toFixed(0)} MB`, {
      size, maxBytes: max,
    });
  }
  const sniffed = sniffMime(buffer);
  const normalizedDeclared = String(declaredMime || '').split(';')[0].trim().toLowerCase();
  const ext = path.extname(sanitizeFilename(originalName)).toLowerCase();

  // ITENS 1 e 2: texto tem um unico tipo real (`text/plain`). A extensao
  // so diz qual rotulo gravar, entre os tres que o `file` aceita. Extensao
  // fora da lista nao refine nada - a checagem deAllowed continua abaixo.
  const mimeFinal = (sniffed === 'text/plain' && MIME_POR_EXTENSAO[ext])
    ? MIME_POR_EXTENSAO[ext]
    : sniffed;
  const sniffOk = spec.mimes.includes(mimeFinal);
  const declaredOk = !normalizedDeclared || spec.mimes.includes(normalizedDeclared);
  const extOk = !ext || spec.extensions.includes(ext);

  if (!sniffOk) {
    // Tolerancia: containers validos podem nao constar na tabela; o ffmpeg
    // valida o codec no passo seguinte de processamento.
    const fallbackOk = spec.kind === 'video' || spec.kind === 'audio'
      ? ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-matroska', 'audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/wav'].includes(mimeFinal)
      : false;
    if (!fallbackOk) {
      throw unsupportedMedia('mime_not_allowed', `Tipo de arquivo nao permitido: ${mimeFinal}`, {
        detected: mimeFinal, allowed: spec.mimes,
      });
    }
  }
  if (!extOk && normalizedDeclared && !declaredOk) {
    throw unsupportedMedia('mime_not_allowed', `Tipo declarado (${normalizedDeclared}) nao combina com a categoria ${category}`);
  }
  if (declaredOk && !spec.mimes.includes(mimeFinal) && spec.kind === 'image' && mimeFinal !== 'image/avif') {
    throw unsupportedMedia('mime_mismatch', `Conteudo detectado como ${mimeFinal}, mas declarado como ${normalizedDeclared}`);
  }
  // A extensao original manda quando ela e valida e o mime nao tem um
  // proprio: assim um `.csv` continua `.csv` em vez de virar `.txt`.
  const extensaoFinal = (!EXT_FOR_MIME[mimeFinal] && extOk) ? ext : (EXT_FOR_MIME[mimeFinal] || ext || '.bin');
  return { mime: mimeFinal, extension: extensaoFinal };
}

/**
 * Salva um upload. `buffer` e' o conteudo completo ja lido pelo servidor.
 */
export async function saveUpload({ ownerId, category, buffer, declaredMime, originalName, bucket: bucketOverride, purpose = 'generic', meta = {} }) {
  const { mime, extension } = validateUpload({ category, buffer, declaredMime, originalName });
  const spec = ACCEPTED[category];
  const mediaId = newId('med');
  const bucket = bucketOverride || spec.bucket;
  // storage_key e sempre RELATIVO ao bucket (ex.: "med_x1.mp4" ou "med_x1/720p.mp4").
  // O caminho completo e sempre `${bucket}/${storage_key}`.
  const key = `${mediaId}${extension}`;
  const name = sanitizeFilename(originalName);

  await writeFile(bucket, key, buffer);

  let width = null;
  let height = null;
  let durationMs = null;
  let hasAudio = 0;
  let processingError = null;
  const extraMeta = { ...meta, detectedMime: mime, category };
  // Video so vira 'ready' apos o pipeline (thumbnail, rendicoes, HLS).
  // Sem isso o cliente receberia 'ready' com metadados vazios.
  let status = spec.kind === 'video' ? 'pending' : 'ready';

  if (spec.kind === 'image') {
    const probeTarget = path.join(bucketPath(bucket), key);
    const info = await probeImage(probeTarget).catch(() => ({ width: null, height: null }));
    width = info.width;
    height = info.height;
  } else if (spec.kind === 'audio') {
    const probeTarget = path.join(bucketPath(bucket), key);
    let info;
    try {
      info = await probeAudio(probeTarget);
    } catch (error) {
      await deleteKey(bucket, key);
      throw error;
    }
    if (!info.hasAudio || !Number.isFinite(info.durationMs) || info.durationMs <= 0) {
      await deleteKey(bucket, key);
      throw unprocessable('audio_metadata_unavailable', 'Nao foi possivel validar a trilha e a duracao real do audio');
    }
    durationMs = info.durationMs;
    hasAudio = 1;
    if (durationMs > 15 * 60 * 1000) {
      await deleteKey(bucket, key);
      throw unprocessable('audio_too_long', 'Gravacao de audio excede 15 minutos');
    }
  }

  run(
    `INSERT INTO media (id, owner_id, kind, bucket, storage_key, original_name, mime, size,
       width, height, duration_ms, has_audio, status, meta_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    {
      id: mediaId, ownerId, kind: spec.kind, bucket, key, originalName: name, mime,
      size: buffer.length, width, height, durationMs, hasAudio, status,
      metaJson: JSON.stringify(extraMeta), now: Date.now(),
    },
  );

  return { id: mediaId, mediaId, bucket, key, mime, size: buffer.length, width, height, durationMs, status };
}

export async function backfillAudioDurations() {
  const rows = all(
    `SELECT id, bucket, storage_key, meta_json FROM media
      WHERE kind = 'audio' AND (duration_ms IS NULL OR duration_ms <= 0)
      ORDER BY created_at ASC`,
  );
  let updated = 0;
  for (const media of rows) {
    const filePath = path.join(bucketPath(media.bucket), media.storage_key);
    try {
      const info = await probeAudio(filePath);
      if (!info.hasAudio || !Number.isFinite(info.durationMs) || info.durationMs <= 0) {
        logger.warn('duracao de audio antigo nao pode ser normalizada', { mediaId: media.id });
        continue;
      }
      const metadata = safeParse(media.meta_json);
      run('UPDATE media SET duration_ms = ?, meta_json = ? WHERE id = ? AND (duration_ms IS NULL OR duration_ms <= 0)', {
        durationMs: info.durationMs,
        metaJson: JSON.stringify({ ...metadata, durationMs: info.durationMs }),
        mediaId: media.id,
      });
      updated += 1;
    } catch (error) {
      logger.warn('falha ao normalizar duracao de audio antigo', {
        mediaId: media.id,
        error: error.message,
      });
    }
  }
  if (updated) logger.info('duracoes de audios antigos normalizadas', { updated });
  return { scanned: rows.length, updated };
}

/**
 * Processa video em background. Quando ffmpeg falta, marca como pending e o
 * frontend recebe 202 com o motivo real (nunca 200 falso).
 */
export function queueVideoProcessing({ mediaId, buffer, ownerId }) {
  const media = get('SELECT * FROM media WHERE id = ?', { mediaId });
  if (!media) return;
  const job = async () => {
    const tmpDir = path.join(config.storageRoot, '.tmp', mediaId);
    try {
      await fsp.mkdir(tmpDir, { recursive: true });
      const inputPath = path.join(tmpDir, 'source.bin');
      await fsp.writeFile(inputPath, buffer);
      run("UPDATE media SET status = 'processing' WHERE id = ?", { mediaId });
      const result = await processVideo({
        inputPath,
        workDir: tmpDir,
        baseKey: media.storage_key,
        mediaId,
      });
      transaction(() => {
        if (result.status === 'ready') {
          const meta = result.meta;
          run(
            `UPDATE media SET status = 'ready', width = ?, height = ?, duration_ms = ?,
               has_audio = ?, meta_json = ? WHERE id = ?`,
            {
              width: meta.width, height: meta.height, durationMs: meta.durationMs,
              hasAudio: meta.hasAudio ? 1 : 0,
              metaJson: JSON.stringify({ ...safeParse(media.meta_json), ...meta }),
              mediaId,
            },
          );
          for (const r of meta.renditions || []) {
            run(
              `INSERT INTO video_renditions (id, media_id, label, width, height, bitrate, bucket, storage_key, size, mime, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              {
                id: newId('rnd'), mediaId, label: r.label, width: r.width, height: r.height,
                bitrate: r.bitrateKbps, bucket: 'videos', key: r.key, size: r.size,
                mime: r.mime, now: Date.now(),
              },
            );
          }
          if (meta.hls) {
            run(
              `INSERT INTO hls_manifests (id, media_id, bucket, storage_key, duration_ms, created_at)
               VALUES (?, ?, 'videos', ?, ?, ?)`,
              { id: newId('hls'), mediaId, key: meta.hlsKey, durationMs: meta.durationMs, now: Date.now() },
            );
          }
        } else {
          run("UPDATE media SET status = 'processing', processing_error = ? WHERE id = ?", {
            reason: result.reason, mediaId,
          });
        }
      });
      logger.info('video processado', { mediaId, status: result.status, renditions: result.meta?.renditions?.length ?? 0 });
    } catch (err) {
      run("UPDATE media SET status = 'failed', processing_error = ? WHERE id = ?", {
        reason: err.message, mediaId,
      });
      logger.error('falha no processamento de video', { mediaId, error: err.message });
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  };
  setImmediate(() => {
    job().catch((err) => logger.error('job de video quebrou', { mediaId, error: err.message }));
  });
}

function safeParse(json) {
  try { return JSON.parse(json || '{}'); } catch { return {}; }
}

/** Remove arquivos de midia que nao tem linha no banco (orfaos). */
export async function cleanupOrphanMedia({ dryRun = false } = {}) {
  const removed = [];
  const buckets = ['videos', 'avatars', 'covers', 'thumbnails', 'audio', 'chat', 'dm', 'live', 'attachments', 'effects', 'sounds'];
  for (const bucket of buckets) {
    const root = path.join(config.storageRoot, bucket);
    const walk = async (dir) => {
      let entries;
      try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
          continue;
        }
        if (entry.name.endsWith('.tmp') || entry.name.startsWith('.')) continue;
        const key = path.relative(path.join(config.storageRoot, bucket), full).split(path.sep).join('/');
        const referenced =
          get('SELECT 1 AS ok FROM media WHERE bucket = ? AND storage_key = ?', { bucket, key }) ||
          get(
            `SELECT 1 AS ok FROM video_renditions WHERE bucket = ? AND storage_key = ?
             UNION SELECT 1 FROM hls_manifests WHERE bucket = ? AND storage_key = ?`,
            { bucket, key, bucket2: bucket, key2: key },
          ) ||
          get('SELECT 1 AS ok FROM users WHERE avatar_key = ? OR cover_key = ?', { k1: `${bucket}/${key}`, k2: `${bucket}/${key}` });
        if (referenced) continue;
        const isManifestOrSegment = /\.(m3u8|ts)$/.test(key);
        if (isManifestOrSegment) {
          const owner = key.split('/')[1];
          const ownerMedia = get('SELECT 1 AS ok FROM media WHERE id = ?', { id: owner });
          if (ownerMedia) continue;
        }
        if (!dryRun) {
          await fsp.unlink(full).catch(() => {});
        }
        removed.push({ bucket, key });
      }
    };
    await walk(root);
  }
  if (removed.length) logger.info('midia orfa removida', { count: removed.length, dryRun });
  return removed;
}

/** Status de processamento de um video (frontend consulta para progress). */
export function mediaStatus(mediaId) {
  const media = get('SELECT * FROM media WHERE id = ?', { mediaId });
  if (!media) return null;
  const meta = safeParse(media.meta_json);
  return {
    id: media.id,
    status: media.status,
    error: media.processing_error,
    durationMs: media.duration_ms,
    width: media.width,
    height: media.height,
    posterKey: meta.thumbnail?.posterKey ?? null,
    spriteKey: meta.thumbnail?.spriteKey ?? null,
    renditions: (meta.renditions || []).map((r) => ({ label: r.label, width: r.width, height: r.height, key: r.key })),
    hlsKey: meta.hlsKey ?? null,
    normalizedKey: meta.normalizedKey ?? null,
  };
}

export { ffmpegAvailable, probeMedia, probeImage, probeAudio };
