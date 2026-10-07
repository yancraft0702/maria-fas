import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import config, { ROOT } from '../config.js';
import { all, get, run, transaction } from '../db/index.js';
import { newId } from '../lib/ids.js';
import { notFound, forbidden, tooManyRequests, badRequest } from '../lib/errors.js';
import { writeFile, deleteKey } from '../storage/index.js';
import { makeAlphaApng, verifyAlphaChannel, findFfmpeg, ffmpegAvailable, probeMedia } from '../media/pipeline.js';
import logger from '../lib/logger.js';

/**
 * Legacy raster assets may still need the existing transcoding pipeline.
 */
const KEY_PARAMS = {
  keyColor: '0x000000',
  similarity: 0,
  smoothness: 0,
};

function keyParamsFor() {
  return KEY_PARAMS;
}

/** Nome do diretorio de origem: "animação" (com acento). */
const EFFECTS_DIRNAME = 'anima\u00e7\u00e3o';

function resolveEffectsDir() {
  if (process.env.EFFECTS_SOURCE_DIR) return path.resolve(process.env.EFFECTS_SOURCE_DIR);
  // Aceita tambem a versao sem acento, para o projeto funcionar em outra
  // maquina/sistema de arquivos. Os escapes unicode evitam duvida de codificacao.
  for (const name of [EFFECTS_DIRNAME, 'animacao']) {
    const candidate = path.resolve(ROOT, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.resolve(ROOT, EFFECTS_DIRNAME);
}

const EFFECTS_DIR = resolveEffectsDir();

const source = (file) => path.join(EFFECTS_DIR, file);

/** Catálogo final das quinze animações autorais transparentes. */
export const EFFECT_CATALOG = [
  ['rosa-premium', 'Rosa premium', '\u{1F339}'],
  ['coracao-cristal', 'Cora\u00e7\u00e3o de cristal', '\u{1F48E}'],
  ['urso-de-pelucia', 'Urso de pel\u00facia', '\u{1F9F8}'],
  ['borboletas-douradas', 'Borboletas douradas', '\u{1F98B}'],
  ['aguia-majestosa', '\u00c1guia majestosa', '\u{1F985}'],
  ['lobo-uivando', 'Lobo uivando', '\u{1F43A}'],
  ['leao-dourado', 'Le\u00e3o dourado', '\u{1F981}'],
  ['fogos-de-artificio', 'Fogos de artif\u00edcio', '\u{1F386}'],
  ['coroa-real', 'Coroa real', '\u{1F451}'],
  ['notas-musicais', 'Notas musicais', '\u{1F3BC}'],
  ['disco-boom', 'Disco boom', '\u{1F4BF}'],
  ['presente-dourado', 'Presente dourado', '\u{1F381}'],
  ['portal-de-luz', 'Portal de luz', '\u{1F300}'],
  ['chuva-de-estrelas-premium', 'Chuva de estrelas', '\u{1F320}'],
  ['coracao-confetes', 'Cora\u00e7\u00e3o + confetes', '\u{1F49D}'],
].map(([slug, name, emoji]) => ({
  slug,
  name,
  emoji,
  source: source(`presentes/${slug}.svg`),
  sound: source(`sons/${slug}.wav`),
  keyMode: 'none',
  durationMs: 3800,
  position: 'center',
  scale: 0.82,
}));

if (EFFECT_CATALOG.length !== 15 || new Set(EFFECT_CATALOG.map((effect) => effect.slug)).size !== 15) {
  throw new Error('O catalogo de presentes da LIVE deve conter exatamente 15 itens unicos');
}

/** Registra (ou atualiza) os efeitos oficiais no banco. */
export function syncEffectCatalog() {
  const created = [];
  const now = Date.now();
  const activeSlugs = new Set(EFFECT_CATALOG.map((item) => item.slug));
  for (const row of all('SELECT id, slug FROM effects WHERE enabled = 1')) {
    if (activeSlugs.has(row.slug)) continue;
    run('UPDATE effects SET enabled = 0 WHERE id = ?', { id: row.id });
    logger.info('presente legado desativado', { slug: row.slug });
  }

  for (const item of EFFECT_CATALOG) {
    const existing = get('SELECT * FROM effects WHERE slug = ?', { slug: item.slug });
    if (existing) {
      run(
        `UPDATE effects SET name = ?, emoji = ?, duration_ms = ?, position = ?, scale = ?, requires_alpha = 1, enabled = 1
          WHERE slug = ?`,
        { name: item.name, emoji: item.emoji, durationMs: item.durationMs, position: item.position, scale: item.scale, slug: item.slug },
      );
      continue;
    }
    const id = newId('eff');
    run(
      `INSERT INTO effects (id, slug, name, emoji, alpha_ready, duration_ms, position, scale, requires_alpha, enabled, min_role, created_at)
       VALUES (?, ?, ?, ?, 0, ?, ?, ?, 1, 1, 'user', ?)`,
      { id, slug: item.slug, name: item.name, emoji: item.emoji, durationMs: item.durationMs, position: item.position, scale: item.scale, now },
    );
    created.push(id);
  }
  return created;
}

/**
 * Remove os arquivos do catálogo anterior e prepara todos os novos assets
 * antes de o servidor começar a aceitar tráfego.
 */
export async function prepareEffectCatalog() {
  const currentSlugs = EFFECT_CATALOG.map((item) => item.slug);
  const placeholders = currentSlugs.map(() => '?').join(', ');
  const retired = all(`SELECT id FROM effects WHERE slug NOT IN (${placeholders})`, currentSlugs);
  transaction(() => {
    for (const row of retired) {
      run('UPDATE effects SET enabled = 0, media_id = NULL, sound_id = NULL, alpha_ready = 0 WHERE id = ?', { id: row.id });
    }
  });

  const orphaned = all(
    `SELECT m.id, m.bucket, m.storage_key FROM media m
       WHERE m.bucket = 'effects' AND m.owner_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM effects e WHERE e.enabled = 1 AND (e.media_id = m.id OR e.sound_id = m.id))`,
  );
  for (const media of orphaned) {
    await deleteKey(media.bucket, media.storage_key);
    run('DELETE FROM media WHERE id = ?', { id: media.id });
  }

  for (const item of EFFECT_CATALOG) {
    const visual = await queueEffectMedia(item.slug, item);
    if (!visual.generated && visual.reason !== 'already_ready') {
      throw new Error(`Presente ${item.slug} sem animação pronta: ${visual.reason || 'erro desconhecido'}`);
    }
    const sound = await queueEffectSound(item.slug, item);
    if (!sound.soundId) {
      throw new Error(`Presente ${item.slug} sem áudio pronto: ${sound.skipped || 'erro desconhecido'}`);
    }
  }
}

/**
 * Item 9 - registra o SOM de um efeito.
 *
 * O arquivo WAV e gerado junto com o catálogo por `scripts/generate-live-gifts.mjs` em
 * `animacao/sons/<slug>.wav`. O upload passa pelo mesmo `saveUpload` do resto
 * do projeto (validacao de MIME, tamanho e persistencia), e o `sound_id` fica
 * gravado em `effects.sound_id`.
 *
 * Efeitos SEM arquivo de som sao deixados com `sound_id` NULL - a API passa a
 * responder `hasAudio: false` e o cliente nao toca nada. Preferimos um efeito
 * silencioso a um efeito com som inventado.
 *
 * @param {string} effectIdOrSlug
 * @param {object} catalogItem item de `EFFECT_CATALOG`
 * @returns {Promise<object>} resultado do registro
 */
export async function queueEffectSound(effectIdOrSlug, catalogItem) {
  const effect = get('SELECT * FROM effects WHERE id = ? OR slug = ?', { id: effectIdOrSlug, slug: effectIdOrSlug });
  if (!effect) throw notFound('effect_not_found', 'Efeito nao encontrado');
  const item = catalogItem || EFFECT_CATALOG.find((e) => e.slug === effect.slug);
  if (!item) return { skipped: 'sem item no catalogo' };
  const arquivo = item.sound;
  if (!arquivo) return { skipped: 'efeito sem som' };

  if (!fs.existsSync(arquivo)) {
    logger.warn('som de presente ausente - rode scripts/generate-live-gifts.mjs', {
      slug: item.slug, path: arquivo,
    });
    return { skipped: 'arquivo_ausente' };
  }
  // Ja registrado e com o arquivo no disco: nao reenvia.
  if (effect.sound_id) {
    const jaGravado = get('SELECT id, bucket, storage_key, meta_json FROM media WHERE id = ?', { mediaId: effect.sound_id });
    if (jaGravado) {
      const buffer = await fsp.readFile(arquivo);
      const durationMs = duracaoWav(buffer);
      if (!durationMs) throw badRequest('invalid_effect_audio', `WAV inválido para o presente ${item.slug}`);
      const meta = { ...safeJson(jaGravado.meta_json), durationMs, slug: item.slug, kind: 'effect-sound' };
      run('UPDATE media SET duration_ms = ?, meta_json = ? WHERE id = ?', {
        durationMs, metaJson: JSON.stringify(meta), mediaId: effect.sound_id,
      });
      return { soundId: effect.sound_id, reused: true };
    }
  }

  const buffer = await fsp.readFile(arquivo);
  const { saveUpload } = await import('../media/upload.js');
  const saved = await saveUpload({
    ownerId: null,
    category: 'audio',
    buffer,
    declaredMime: 'audio/wav',
    originalName: path.basename(arquivo),
    bucket: 'effects',
    purpose: 'live-effect',
    // `owner_id` nulo: o som pertence ao catalogo, nao a um usuario. A rota de
    // streaming libera midia sem dono para o proprio efeito (ver
    // `authorizeKey` em server/routes/media.js).
    meta: { durationMs: duracaoWav(buffer), slug: item.slug, kind: 'effect-sound' },
  });
  run('UPDATE effects SET sound_id = ? WHERE id = ?', { soundId: saved.mediaId, id: effect.id });
  logger.info('som de efeito registrado', { slug: item.slug, bytes: buffer.length });
  return { soundId: saved.mediaId, bytes: buffer.length };
}

/** Le a duracao do cabeçalho WAV (segundos -> ms). 0 se nao for WAV valido. */
function duracaoWav(buffer) {
  try {
    if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF'
      || buffer.toString('ascii', 8, 12) !== 'WAVE') return 0;
    const bytesPorSegundo = buffer.readUInt32LE(28);
    const bytes = buffer.readUInt32LE(40);
    if (!bytesPorSegundo || !bytes) return 0;
    return Math.round((bytes / bytesPorSegundo) * 1000);
  } catch {
    return 0;
  }
}

/**
 * Gera (uma vez) a versao com canal alfa de cada efeito.
 * Sem ffmpeg -> o efeito fica com alpha_ready=0 e a UI avisa que nao ha
 * arquivo com transparencia; nada e inventado.
 */
/**
 * Gera a versao com canal alfa de cada efeito (uma vez por arquivo de origem).
 *
 * Remocao de fundo tem duas rotas, ambas reais:
 *  1. `alpha_ready = 1`  -> o ffmpeg gerou WebM com canal alfa VERIFICADO
 *     (verifyAlphaChannel confirma pixels transparentes e opacos no arquivo);
 *  2. `alpha_ready = 0`  -> o build do ffmpeg nao grava o plano alpha
 *     (ex.: libvpx sem suporte). O arquivo original e servido em WebM e o
 *     cliente aplica chroma-key na GPU (WebGL), que tambem e remocao real,
 *     calculada por quadro. Os parametros de chave viajam no payload.
 *
 * O status exposto na API e sempre o estado real do arquivo.
 */

export async function queueEffectMedia(effectIdOrSlug, catalogItem) {
  const effect = get('SELECT * FROM effects WHERE id = ? OR slug = ?', { id: effectIdOrSlug, slug: effectIdOrSlug });
  if (!effect) throw notFound('effect_not_found', 'Efeito nao encontrado');
  if (effect.alpha_ready) return { generated: false, reason: 'already_ready', mediaId: effect.media_id };
  const item = catalogItem || EFFECT_CATALOG.find((e) => e.slug === effect.slug);
  if (!item) throw badRequest('effect_source_missing', `Sem arquivo de origem para o efeito ${effect.slug}`);
  if (!fs.existsSync(item.source)) {
    logger.warn('arquivo de efeito ausente', { slug: item.slug, path: item.source });
    return { generated: false, reason: 'source_missing' };
  }
  if (path.extname(item.source).toLowerCase() === '.svg') {
    const asset = await buildAnimatedSvgAsset(item);
    if (!asset.ok) return asset;
    run('UPDATE effects SET media_id = ?, alpha_ready = 1 WHERE id = ?', {
      mediaId: asset.mediaId,
      id: effect.id,
    });
    return { generated: true, alpha: true, mediaId: asset.mediaId, key: asset.key };
  }
  if (!(await ffmpegAvailable())) {
    logger.warn('ffmpeg ausente: efeito sem preprocessamento', { slug: item.slug });
    return { generated: false, reason: 'ffmpeg_unavailable' };
  }

  async function buildAnimatedSvgAsset(item) {
    const buffer = await fsp.readFile(item.source);
    const markup = buffer.toString('utf8');
    if (buffer.length > 120_000 || !/<svg\b/i.test(markup)
        || /<script\b|\bon[a-z]+\s*=|(?:href|src)\s*=\s*["']\s*(?:https?:|\/\/|data:)/i.test(markup)) {
      throw badRequest('invalid_effect_asset', `Asset SVG inválido ou inseguro: ${item.slug}`);
    }

    const mediaId = newId('med');
    const bucket = 'effects';
    const key = `${mediaId}.svg`;
    await writeFile(bucket, key, buffer);
    const metaJson = JSON.stringify({
      alpha: true,
      format: 'svg',
      animated: true,
      durationMs: item.durationMs,
      sourceFile: item.source,
    });
    transaction(() => {
      run(
        `INSERT INTO media (id, owner_id, kind, bucket, storage_key, original_name, mime, size,
           width, height, duration_ms, has_audio, status, meta_json, created_at)
         VALUES (?, NULL, 'effect', ?, ?, ?, 'image/svg+xml', ?, 480, 768, ?, 0, 'ready', ?, ?)`,
        {
          id: mediaId,
          bucket,
          key,
          originalName: `${item.slug}.svg`,
          size: buffer.length,
          durationMs: item.durationMs,
          metaJson,
          now: Date.now(),
        },
      );
    });
    return { ok: true, mediaId, key };
  }

  const sourceKey = `${item.source}|${item.keyMode}`;
  if (!generatedBySource.has(sourceKey)) {
    generatedBySource.set(sourceKey, buildAlphaAsset(item));
  }
  const asset = await generatedBySource.get(sourceKey);
  if (!asset.ok) return asset;

  // O arquivo SEMPRE e' anexado ao efeito (e o que o cliente reproduz).
  // `alpha_ready` so e' 1 quando o canal alfa foi de fato verificado; caso
  // contrario o cliente aplica chroma-key na GPU sobre este mesmo arquivo.
  run('UPDATE effects SET media_id = ?, alpha_ready = ? WHERE id = ?', {
    mediaId: asset.mediaId,
    alphaReady: asset.hasAlpha ? 1 : 0,
    id: effect.id,
  });
  logger.info('efeito pronto', {
    slug: effect.slug,
    source: path.basename(item.source),
    alpha: asset.hasAlpha,
    keyMode: item.keyMode,
  });
  return {
    generated: true,
    alpha: asset.hasAlpha,
    // Arquivo com alfa real: nada de chroma-key na GPU como solucao final.
    chromaKey: null,
    mediaId: asset.mediaId,
    key: asset.key,
    reason: asset.hasAlpha ? null : asset.reason,
  };
}

/**
 * Parametros de remocao de fundo gravados no arquivo (usados na auditoria).
 * Nao sao aplicados no cliente: o alfa ja vem pronto no APNG.
 */
function chromaKeyFor(itemOrSlug) {
  const slug = typeof itemOrSlug === 'string'
    ? itemOrSlug
    : itemOrSlug?.slug;
  const p = keyParamsFor(slug);
  return {
    color: p.keyColor,
    similarity: p.similarity,
    smoothness: p.smoothness,
  };
}

/** Processa um arquivo de origem e grava o WebM (com ou sem alfa). */
async function buildAlphaAsset(item) {
  const mediaId = newId('med');
  const bucket = 'effects';
  // APNG animado: unico formato que este build do ffmpeg grava COM ALFA.
  const key = `${mediaId}.png`;
  const tmpDir = path.join(config.storageRoot, '.tmp', `effect-${mediaId}`);
  await fsp.mkdir(tmpDir, { recursive: true });
  const alphaPath = path.join(tmpDir, 'alpha.png');
  try {
    const keyParams = keyParamsFor(item.slug);
    // Item 9: os arquivos novos ja nascem com alfa real (PNG RGBA). Nesse
    // caso o colorkey e omitido - ver `makeAlphaApng({ sourceHasAlpha })`.
    // Um PNG (e nao MP4) com canal alfa e a unica fonte que dispensa chave.
    const fonteTemAlfa = item.keyMode === 'none';
    const info = await makeAlphaApng({
      inputPath: item.source,
      outputPath: alphaPath,
      mode: item.keyMode,
      keyColor: keyParams.keyColor,
      similarity: keyParams.similarity,
      smoothness: keyParams.smoothness,
      sourceHasAlpha: fonteTemAlfa,
      durationSec: item.durationMs / 1000,
    });
    // Mede o alfa gravado: fundo removido E assunto preservado.
    const check = await verifyAlphaChannel({ filePath: alphaPath });
    if (!check.hasAlpha) {
      logger.warn('efeito sem alfa valido; descartado em vez de virar retangulo opaco', {
        slug: item.slug, reason: check.reason,
        transparente: check.transparentRatio, opaco: check.opaqueRatio,
      });
      return { ok: false, reason: check.reason || 'alpha_invalid' };
    }
    const buffer = await fsp.readFile(alphaPath);
    await writeFile(bucket, key, buffer);
    const source = await probeMedia(item.source).catch(() => null);
    const metaJson = JSON.stringify({
      alpha: true,
      format: 'apng',
      keyMode: item.keyMode,
      keyColor: keyParams.keyColor,
      similarity: keyParams.similarity,
      smoothness: keyParams.smoothness,
      sourceFile: item.source,
      generatedBy: 'ffmpeg-colorkey-apng',
      alphaCheck: check,
    });
    transaction(() => {
      run(
        `INSERT INTO media (id, owner_id, kind, bucket, storage_key, original_name, mime, size,
           width, height, duration_ms, has_audio, status, meta_json, created_at)
         VALUES (?, NULL, 'effect', ?, ?, ?, 'image/apng', ?, ?, ?, ?, 0, 'ready', ?, ?)`,
        {
          mediaId,
          bucket,
          key,
          originalName: `${path.parse(item.source).name}.webm`,
          size: buffer.length,
          width: info.width ?? source?.width ?? null,
          height: info.height ?? source?.height ?? null,
          durationMs: source?.durationMs ?? item.durationMs,
          metaJson,
          now: Date.now(),
        },
      );
    });
    if (check.hasAlpha) {
      logger.info('asset de efeito com alfa verificado', {
        source: path.basename(item.source),
        bytes: info.size,
        transparentes: check.transparentRatio,
      });
    } else {
      logger.warn('ffmpeg nao gravou o plano alpha; usando chroma-key na GPU', {
        source: path.basename(item.source), reason: check.reason,
      });
    }
    return { ok: true, generated: true, hasAlpha: check.hasAlpha, reason: check.reason, mediaId, key };
  } catch (err) {
    logger.error('falha ao preparar efeito', { source: item.source, error: err.message });
    return { ok: false, generated: false, reason: err.message };
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Reencode para WebM (VP9) sem audio, mantendo resolucao. */
async function ffmpegTranscodeWebm({ inputPath, outputPath, height = 720 }) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const bin = await findFfmpeg();
  if (!bin) throw new Error('ffmpeg indisponivel');
  const targetHeight = evenSize(height);
  const targetWidth = evenSize(Math.round((height * 9) / 16));
  await run(bin, [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-i', inputPath,
    '-vf', `scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease,pad=${targetWidth}:${targetHeight}:-1:-1:color=black,format=yuv420p`,
    '-an',
    '-c:v', 'libvpx-vp9',
    '-b:v', '0',
    '-crf', '34',
    '-deadline', 'realtime',
    '-cpu-used', '6',
    '-row-mt', '1',
    '-auto-alt-ref', '1',
    '-y', outputPath,
  ], { windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 10 * 60 * 1000 });
}

function evenSize(value) {
  const n = Math.round(value / 2) * 2;
  return n % 2 === 0 ? n : n + 1;
}

export function listEffects(user = null) {
  const rows = all('SELECT * FROM effects WHERE enabled = 1 ORDER BY created_at ASC');
  const staff = user && (user.role === 'admin' || user.role === 'moderator');
  return rows.map((row) => serializeEffect(row, { unlimited: staff }));
}

/**
 * Serializa um efeito para o cliente.
 *
 * Item 9: `hasAudio`/`soundUrl`/`soundDurationMs` sao o estado REAL do arquivo
 * de audio. Quando nao ha som, `soundUrl` fica `null` e `hasAudio` `false` -
 * o cliente nao toca nada. Nunca se "fabrica" som para um efeito que nao tem.
 */
function serializeEffect(row, { unlimited = false } = {}) {
  const media = row.media_id
    ? get('SELECT bucket, storage_key, meta_json FROM media WHERE id = ?', { mediaId: row.media_id })
    : null;
  const meta = media ? safeJson(media.meta_json) : {};
  const som = row.sound_id
    ? get('SELECT bucket, storage_key, meta_json, size FROM media WHERE id = ?', { mediaId: row.sound_id })
    : null;
  const somMeta = som ? safeJson(som.meta_json) : {};
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    emoji: row.emoji,
    // Estado real do arquivo: canal alfa em disco, ou chroma-key na GPU.
    alphaReady: Boolean(row.alpha_ready),
    // Alfa gravado no arquivo; sem fallback de chroma-key na GPU.
    chromaKey: null,
    alphaSource: meta.format === 'svg' ? 'svg-alpha' : 'apng-real',
    format: meta.format || null,
    keyParams: meta.keyParams || chromaKeyFor(row.slug),
    durationMs: row.duration_ms,
    position: row.position,
    scale: row.scale,
    unlimited,
    mediaUrl: media ? `/api/media/stream?key=${encodeURIComponent(`${media.bucket}/${media.storage_key}`)}` : null,
    hasAudio: Boolean(som),
    soundUrl: som ? `/api/media/stream?key=${encodeURIComponent(`${som.bucket}/${som.storage_key}`)}` : null,
    soundDurationMs: somMeta.durationMs ?? somMeta.duration_ms ?? null,
    soundBytes: som ? som.size : null,
  };
}

export { serializeEffect };

function safeJson(json) {
  try { return JSON.parse(json || '{}'); } catch { return {}; }
}

export function usageToday(userId) {
  const day = new Date().toISOString().slice(0, 10);
  return get('SELECT count FROM effect_usage_daily WHERE user_id = ? AND day = ?', { userId, day })?.count ?? 0;
}

export function recordEffectUsage(user) {
  const day = new Date().toISOString().slice(0, 10);
  run(
    `INSERT INTO effect_usage_daily (user_id, day, count) VALUES (?, ?, 1)
     ON CONFLICT(user_id, day) DO UPDATE SET count = count + 1`,
    { userId: user.id, day },
  );
}

/** Limite: 10 efeitos/dia para usuario comum; admin/moderador sem limite. */
export function effectAllowedForUser(user) {
  if (!user) throw forbidden('login_required', 'Faca login para usar efeitos');
  if (user.role === 'admin' || user.role === 'moderator') return { unlimited: true, used: usageToday(user.id) };
  const used = usageToday(user.id);
  if (used >= config.effectDailyLimit) {
    throw tooManyRequests('effect_limit_reached', `Voce usou os ${config.effectDailyLimit} efeitos disponiveis hoje. O limite renova a meia-noite.`, {
      used, limit: config.effectDailyLimit, resetsAt: new Date(new Date().setHours(24, 0, 0, 0)).toISOString(),
    });
  }
  return { unlimited: false, used, limit: config.effectDailyLimit };
}

export function effectStatus() {
  return all('SELECT slug, alpha_ready, media_id FROM effects ORDER BY slug').map((r) => ({
    slug: r.slug,
    alphaReady: Boolean(r.alpha_ready),
    hasMedia: Boolean(r.media_id),
  }));
}
