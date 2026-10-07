import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import config, { ROOT } from '../config.js';
import logger from '../lib/logger.js';
import { unavailable } from '../lib/errors.js';

const execFileAsync = promisify(execFile);

let resolvedFfmpeg = null;
let resolvedFfprobe = null;
let probed = false;

/**
 * Localiza o ffmpeg: env -> PATH -> pacote empacotado.
 * ffprobe e opcional: quando ausente, o probe usa `ffmpeg -i` (banner stderr),
 * que devolve as mesmas informacoes (codec, tamanho, duracao, fps).
 */
/**
 * Resolve o executavel do ffmpeg.
 *
 * Ordem: `FFMPEG_PATH` -> `ffmpeg` do PATH -> binario embutido (ffmpeg-static).
 *
 * Dois casos especiais e explicitos:
 *  - `FFMPEG_PATH=none|off|disabled`: desliga o ffmpeg de proposito (usado em
 *    instalacoes que fazem o transcode fora do processo). Nao ha fallback.
 *  - `FFMPEG_PATH` definido e invalido: cai no proximo candidato, mas AVISA
 *    para o operador saber que a configuracao dele foi ignorada.
 */
export async function findFfmpeg() {
  if (probed) return resolvedFfmpeg;
  probed = true;

  const configured = String(config.ffmpegPath || '').trim();
  if (DISABLED_VALUES.has(configured.toLowerCase())) {
    logger.warn('ffmpeg desativado por FFMPEG_PATH; transcoding, HLS e thumbnails automaticos desligados');
    return null;
  }

  const candidates = [];
  if (configured) candidates.push(configured);
  candidates.push('ffmpeg');
  try {
    const mod = await import('ffmpeg-static');
    const bin = mod.default || mod;
    if (bin) candidates.push(bin);
  } catch {
    // pacote ausente: segue sem ffmpeg
  }

  for (const candidate of candidates) {
    const found = await tryRun(candidate, ['-version']);
    if (!found) continue;
    if (configured && candidate !== configured) {
      logger.warn('FFMPEG_PATH configurado nao e executavel; usando fallback', {
        configured,
        using: candidate,
      });
    }
    resolvedFfmpeg = candidate;
    const dir = path.dirname(candidate);
    const ext = path.extname(candidate);
    const sibling = path.join(dir, `ffprobe${ext || ''}`);
    resolvedFfprobe = fs.existsSync(sibling) ? sibling : null;
    if (!resolvedFfprobe) {
      const onPath = await tryRun('ffprobe', ['-version']);
      resolvedFfprobe = onPath ? 'ffprobe' : null;
    }
    logger.info('ffmpeg disponivel', { path: candidate, ffprobe: Boolean(resolvedFfprobe) });
    return resolvedFfmpeg;
  }

  logger.warn('ffmpeg NAO encontrado: transcoding, HLS e thumbnails automaticos desabilitados');
  return null;
}

const DISABLED_VALUES = new Set(['none', 'off', 'disabled', '0', 'false']);

async function tryRun(bin, args) {
  try {
    await execFileAsync(bin, args, { timeout: 10_000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

export async function ffmpegAvailable() {
  return Boolean(await findFfmpeg());
}

async function ffmpeg(args, { timeout = 10 * 60 * 1000 } = {}) {
  const bin = await findFfmpeg();
  if (!bin) {
    throw unavailable('ffmpeg_unavailable', 'FFmpeg nao esta instalado no servidor (FFMPEG_PATH). processamento de video indisponivel');
  }
  return execFileAsync(bin, ['-hide_banner', '-loglevel', 'error', '-nostdin', ...args], {
    timeout,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
}

async function ffprobe(args) {
  if (!resolvedFfprobe) {
    const bin = await findFfmpeg();
    if (!bin) {
      throw unavailable('ffmpeg_unavailable', 'FFmpeg nao esta instalado no servidor (FFMPEG_PATH)');
    }
  }
  const { stdout } = await execFileAsync(resolvedFfprobe, ['-hide_banner', '-loglevel', 'error', '-print_format', 'json', ...args], {
    timeout: 60_000,
    windowsHide: true,
  });
  return JSON.parse(stdout || '{}');
}

/**
 * Probe sem ffprobe: `ffmpeg -i <arquivo>` escreve os metadados no stderr.
 * Usado como fallback quando o binario ffprobe nao existe (ex.: ffmpeg-static).
 */
async function probeViaFfmpeg(filePath) {
  const bin = await findFfmpeg();
  if (!bin) throw unavailable('ffmpeg_unavailable', 'FFmpeg nao esta instalado no servidor (FFMPEG_PATH)');
  const { spawn } = await import('node:child_process');
  let stderr = '';
  try {
    await execFileAsync(bin, ['-hide_banner', '-nostdin', '-i', filePath, '-f', 'null', '-'], {
      timeout: 120_000,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (err) {
    stderr = String(err.stderr || '');
  }
  if (!stderr) {
    // Sem erro: ainda assim ffmpeg imprime o banner antes de abortar
    stderr = await new Promise((resolve) => {
      const child = spawn(bin, ['-hide_banner', '-i', filePath], { windowsHide: true });
      let out = '';
      child.stderr.on('data', (c) => { out += c.toString(); });
      child.on('close', () => resolve(out));
      child.on('error', () => resolve(''));
    });
  }

  const duration = /Duration:\s*(\d+):(\d+):(\d+\.?\d*)/.exec(stderr);
  // Item 3: a RESOLUCAO e o fps sao uteis, mas nao definem se existe trilha
  // de video. Num WebM do MediaRecorder o ffm costuma imprimir a linha sem o
  // par fps/tbr, e a regex completa deixava `hasVideo = false` - publicacao
  // recusada com "arquivo nao contem trilha de video" num video valido.
  const videoLine = /Stream #\d+:\d+.*?: Video: (\w+).*?, (\d+)x(\d+).*?, ([\d.]+) (?:fps|tbr)/.exec(stderr);
  // Pergunta 1: existe trilha de video? (independe de resolucao/fps)
  const videoPresente = /Stream #\d+:\d+.*?: Video: (\w+)/.exec(stderr);
  // Pergunta 2: a linha detalhada, quando houver.
  const fpsSolto = /Stream #\d+:\d+.*?: Video:.*?[\s,](\d+(?:\.\d+)?) fps/.exec(stderr);
  const dimSolto = /Stream #\d+:\d+.*?: Video:.*?, (\d+)x(\d+)/.exec(stderr);
  // Grupos normalizados: as DUAS regexes tem numeros de grupo diferentes
  // (4 e 2), e misturar os indices trocava a largura pela altura - erro
  // silencioso que so aparece olhando o valor.
  const codec = videoPresente ? videoPresente[1] : null;
  const largura = videoLine ? videoLine[2] : (dimSolto ? dimSolto[1] : null);
  const altura = videoLine ? videoLine[3] : (dimSolto ? dimSolto[2] : null);
  const fps = videoLine ? videoLine[4] : (fpsSolto ? fpsSolto[1] : null);
  const audioLine = /Stream #\d+:\d+.*?: Audio: (\w+)/.exec(stderr);
  const bitrate = /bitrate:\s*(\d+)\s*kb\/s/.exec(stderr);
  const size = /Video:.*?[\s,](\d+) bytes/.exec(stderr) || /size:\s*(\d+)\s*bytes/.exec(stderr);

  return {
    durationMs: duration
      ? Math.round((Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3])) * 1000)
      : 0,
    width: largura !== null ? Number(largura) : null,
    height: altura !== null ? Number(altura) : null,
    // A resposta honesta: existe trilha de video? (e nao "a regex detalhada bateu")
    hasVideo: Boolean(videoPresente),
    hasAudio: Boolean(audioLine),
    fps: fps !== null ? Number(fps) : 0,
    videoCodec: codec,
    audioCodec: audioLine ? audioLine[1] : null,
    bitrate: bitrate ? Number(bitrate[1]) * 1000 : 0,
    sizeBytes: size ? Number(size[1]) : 0,
  };
}

/** Metadados de video/audio (ffprobe quando existe, senao banner do ffmpeg). */
export async function probeMedia(filePath) {
  if (resolvedFfprobe) {
    try {
      return parseProbeJson(await ffprobe(['-show_format', '-show_streams', filePath]));
    } catch {
      // cai no fallback
    }
  }
  return probeViaFfmpeg(filePath);
}

function parseProbeJson(data) {
  const streams = data.streams || [];
  const video = streams.find((s) => s.codec_type === 'video');
  const audio = streams.find((s) => s.codec_type === 'audio');
  const durationSec = Number(data.format?.duration || video?.duration || audio?.duration || 0);
  let fps = 0;
  if (video?.avg_frame_rate && video.avg_frame_rate.includes('/')) {
    const [n, d] = video.avg_frame_rate.split('/').map(Number);
    fps = d ? n / d : 0;
  } else if (video?.r_frame_rate) {
    const [n, d] = video.r_frame_rate.split('/').map(Number);
    fps = d ? n / d : 0;
  }
  return {
    durationMs: Math.round(durationSec * 1000),
    width: video ? Number(video.width) || null : null,
    height: video ? Number(video.height) || null : null,
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
    fps: Math.round(fps * 1000) / 1000,
    videoCodec: video?.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null,
    bitrate: Number(data.format?.bit_rate || 0),
    sizeBytes: Number(data.format?.size || 0),
  };
}

/** Imagem (JPEG/WebP) -> extrai largura/altura reais do arquivo. */
export async function probeImage(filePath) {
  if (resolvedFfprobe) {
    try {
      const data = await ffprobe(['-show_streams', '-select_streams', 'v:0', filePath]);
      const s = (data.streams || [])[0];
      if (s) return { width: Number(s.width) || null, height: Number(s.height) || null };
    } catch {
      // ffprobe indisponivel para este arquivo: le o header
    }
  }
  return readImageSize(filePath);
}

function readImageSize(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(32 * 1024);
    const read = fs.readSync(fd, buf, 0, buf.length, 0);
    const data = buf.subarray(0, read);
    // PNG
    if (data.readUInt32BE(0) === 0x89504e47 && data.toString('ascii', 12, 16) === 'IHDR') {
      return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
    }
    // GIF
    if (data.toString('ascii', 0, 3) === 'GIF') {
      return { width: data.readUInt16LE(6), height: data.readUInt16LE(8) };
    }
    // BMP
    if (data.toString('ascii', 0, 2) === 'BM') {
      return { width: data.readInt32LE(18), height: Math.abs(data.readInt32LE(22)) };
    }
    // JPEG
    if (data[0] === 0xff && data[1] === 0xd8) {
      let offset = 2;
      while (offset + 9 < data.length) {
        if (data[offset] !== 0xff) { offset += 1; continue; }
        const marker = data[offset + 1];
        const length = data.readUInt16BE(offset + 2);
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { height: data.readUInt16BE(offset + 5), width: data.readUInt16BE(offset + 7) };
        }
        offset += 2 + length;
      }
    }
    // WEBP
    if (data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') {
      if (data.toString('ascii', 12, 16) === 'VP8 ') {
        return { width: data.readUInt16LE(26) & 0x3fff, height: data.readUInt16LE(28) & 0x3fff };
      }
      if (data.toString('ascii', 12, 16) === 'VP8L') {
        const b = data.readUInt32LE(21);
        return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
      }
      if (data.toString('ascii', 12, 16) === 'VP8X') {
        const w = data.readUIntLE(24, 3) + 1;
        const h = data.readUIntLE(27, 3) + 1;
        return { width: w, height: h };
      }
    }
    return { width: null, height: null };
  } finally {
    fs.closeSync(fd);
  }
}

// --------------------------------------------------------------------------
// Transcoding multi-resolucao + HLS
// --------------------------------------------------------------------------
const RENDITIONS = [
  { label: '360p', width: 480, height: 854, videoBitrate: '800k', maxrate: '856k', bufsize: '1200k', audioBitrate: '96k' },
  { label: '540p', width: 720, height: 1280, videoBitrate: '1600k', maxrate: '1712k', bufsize: '2400k', audioBitrate: '128k' },
  { label: '720p', width: 1280, height: 2276, videoBitrate: '2800k', maxrate: '2996k', bufsize: '4200k', audioBitrate: '128k' },
];

function evenSize(value) {
  const n = Math.round(value / 2) * 2;
  return n % 2 === 0 ? n : n + 1;
}

export async function transcodeProgressive({ inputPath, outputPath, height, label, bitrate = '1600k', audioBitrate = '128k' }) {
  const targetHeight = evenSize(height);
  const width = evenSize(Math.round((height * 9) / 16));
  await ffmpeg([
    '-i', inputPath,
    '-vf', `scale=${width}:${targetHeight}:force_original_aspect_ratio=decrease,pad=${width}:${targetHeight}:-1:-1:color=black,format=yuv420p`,
    '-c:v', 'libx264',
    '-profile:v', 'main',
    '-preset', 'veryfast',
    '-b:v', bitrate,
    '-maxrate', String(Math.round(parseInt(bitrate, 10) * 1.07)),
    '-bufsize', String(Math.round(parseInt(bitrate, 10) * 1.5)),
    '-g', '48',
    '-keyint_min', '48',
    '-sc_threshold', '0',
    '-c:a', 'aac',
    '-b:a', audioBitrate,
    '-ar', '48000',
    '-ac', '2',
    '-movflags', '+faststart',
    '-y', outputPath,
  ]);
  const stat = await fsp.stat(outputPath);
  return { label, width, height: targetHeight, bitrate, size: stat.size };
}

export async function makeHls({ inputPath, outDir, height, videoBitrate, audioBitrate, label, copy = false }) {
  const targetHeight = evenSize(height);
  const width = evenSize(Math.round((height * 9) / 16));
  await fsp.mkdir(outDir, { recursive: true });
  await ffmpeg([
    '-i', inputPath,
    '-vf', `scale=${width}:${targetHeight}:force_original_aspect_ratio=decrease,pad=${width}:${targetHeight}:-1:-1:color=black,format=yuv420p`,
    '-c:v', copy ? 'copy' : 'libx264',
    ...(copy ? [] : ['-profile:v', 'main', '-preset', 'veryfast', '-b:v', videoBitrate, '-maxrate', String(Math.round(parseInt(videoBitrate, 10) * 1.07)), '-bufsize', String(Math.round(parseInt(videoBitrate, 10) * 1.5)), '-g', '48', '-keyint_min', '48', '-sc_threshold', '0']),
    '-c:a', copy ? 'copy' : 'aac',
    ...(copy ? [] : ['-b:a', audioBitrate, '-ar', '48000', '-ac', '2']),
    '-f', 'hls',
    '-hls_time', '4',
    '-hls_playlist_type', 'vod',
    '-hls_flags', 'independent_segments',
    '-hls_segment_filename', path.join(outDir, `${label}_%04d.ts`),
    path.join(outDir, `${label}.m3u8`),
  ], { timeout: 15 * 60 * 1000 });
  // A resolucaoEfetiva e' lida do proprio playlist: sem isso o master
  // referencia "RESOLUTION=undefinedxundefined" e players ajustam mal.
  const playlist = await fsp.readFile(path.join(outDir, `${label}.m3u8`), 'utf8');
  const resMatch = /RESOLUTION=(\d+)x(\d+)/.exec(playlist);
  const segments = [...playlist.matchAll(/^(.+\.ts)$/gm)].map((m) => m[1]);
  return {
    label,
    dir: outDir,
    width: resMatch ? Number(resMatch[1]) : width,
    height: resMatch ? Number(resMatch[2]) : targetHeight,
    segments,
    durationSeconds: Number(/EXTINF:([\d.]+)/.exec(playlist)?.[1] ?? 0),
  };
}

export async function writeMasterPlaylist({ filePath, variants }) {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-INDEPENDENT-SEGMENTS'];
  for (const v of variants) {
    // Sem resolucao conhecida nao inventamos: omitimos o atributo em vez de
    // escrever "undefinedxundefined".
    const resolution = v.width && v.height ? `,RESOLUTION=${v.width}x${v.height}` : '';
    const bandwidth = Math.round((v.bandwidth ?? 0) * 1000);
    if (!bandwidth) continue;
    lines.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth}${resolution},CODECS="avc1.4d401f,mp4a.40.2",NAME="${v.label}"`,
      `${v.label}.m3u8`,
    );
  }
  if (lines.length === 3) return false; // nenhuma variante valida
  await fsp.writeFile(filePath, `${lines.join('\n')}\n`, 'utf8');
  return true;
}

/** Gera thumbnails (poster + storyboard de 6 quadros). */
export async function makeThumbnails({ inputPath, posterPath, spritePath, spriteWidth = 320, tileCount = 6 }) {
  await ffmpeg([
    '-i', inputPath,
    '-vf', `thumbnail=30,scale=${spriteWidth}:-2`,
    '-frames:v', '1',
    '-q:v', '4',
    '-y', posterPath,
  ]);
  const spriteHeight = Math.round((spriteWidth * 16) / 9);
  await ffmpeg([
    '-i', inputPath,
    '-vf', `fps=${tileCount},scale=${spriteWidth}:${spriteHeight},tile=${tileCount}x1`,
    '-frames:v', '1',
    '-q:v', '5',
    '-y', spritePath,
  ]);
  const stat = await fsp.stat(posterPath);
  return { posterSize: stat.size, sprite: spritePath, tileWidth: spriteWidth, tileHeight: spriteHeight, tileCount };
}

/**
 * Confere se o arquivo gerado REALMENTE tem canal alfa utilizavel.
 * Algumas builds do ffmpeg aceitam `-pix_fmt yuva420p` mas nao gravam o
 * bloco alpha (libvpx compilado sem suporte). Nunca marcamos alpha_ready=1
 * sem esta verificacao - o frontend depende disso para escolher entre
 * WebM transparente e chroma-key na GPU.
 */
/**
 * Verifica o canal alfa REAL do arquivo gerado (item 20).
 *
 * Decodifica um frame para RGBA e mede quanto e transparente e quanto
 * continua opaco. So considera alfa valido quando existe transparencia
 * E o assunto continua visivel - um arquivo 100% transparente "removeu o
 * fundo" apagando tudo, e um arquivo opaco nao removeu nada.
 */
export async function verifyAlphaChannel({ filePath, sampleFrame = 6 }) {
  const bin = await findFfmpeg();
  if (!bin) return { hasAlpha: false, reason: 'ffmpeg_unavailable' };
  const { spawnSync } = await import('node:child_process');
  // Varios quadros, nao UM: um unico frame no meio da animacao pode estar
  // vazio e validar um arquivo que, no fim, apaga o assunto.
  const result = spawnSync(
    bin,
    [
      '-v', 'error', '-i', filePath,
      '-vf', `select=lt(n\\,${sampleFrame + 6}),format=rgba`,
      '-frames:v', String(sampleFrame + 6), '-f', 'rawvideo', '-pix_fmt', 'rgba', '-',
    ],
    { windowsHide: true, maxBuffer: 256 * 1024 * 1024 },
  );
  if (result.status !== 0 || !result.stdout || result.stdout.length < 4096) {
    return { hasAlpha: false, reason: 'decode_failed' };
  }
  const data = result.stdout;
  let opaque = 0;
  let transparent = 0;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] > 200) opaque += 1;
    else if (data[i] < 40) transparent += 1;
  }
  const total = Math.floor(data.length / 4);
  const transparentRatio = transparent / total;
  const opaqueRatio = opaque / total;
  // Fundo removido de verdade E assunto preservado. O piso de 3% opaco existe
  // porque um arquivo quase todo transparente "removeu o fundo" apagando o
  // efeito inteiro - medido em 1,4% no Cemiterio com chave larga demais.
  const hasAlpha = transparentRatio > 0.20 && opaqueRatio > 0.03;
  return {
    hasAlpha,
    frames: sampleFrame + 6,
    transparentRatio: Math.round(transparentRatio * 1000) / 1000,
    opaqueRatio: Math.round(opaqueRatio * 1000) / 1000,
    reason: hasAlpha ? null : (opaqueRatio <= 0.03 ? 'subject_removed' : 'alpha_plane_absent_in_output'),
  };
}

export async function makeAlphaApng({
  inputPath, outputPath, mode = 'dark', keyColor = '0x000000',
  // Parametros enxutos de proposito: o efeito e uma sobreposicao efemera de
  // ~6s, entao 256px / 8fps / 96 cores ja sao suficientes e mantem o
  // processamento do catalogo no boot rapido (o APNG sai em ~1/3 do tempo
  // e em um terco do tamanho da primeira versao, 320px/10fps/128).
  similarity = 0.12, smoothness = 0.05, width = 256, fps = 8, maxColors = 96,
  durationSec = 4,
  /**
   * A fonte JA tem canal alfa (item 9: PNG RGBA transparente gerado em Node).
   *
   * Nesse caminho o `colorkey` E o `palettegen/paletteuse` sao OMITIDOS:
   *  - nao existe cor de fundo para apagar, entao a chave so cortaria o efeito;
   *  - `palettegen` trabalha sobre RGB e DESCARTA o plano alpha, o que
   *    deixava o arquivo inteiro transparente (medido: 100% transparente,
   *    0% opaco - o efeito sumia).
   * O muxer APNG grava RGBA direto, que e o que a fonte ja entrega.
   */
  sourceHasAlpha = false,
}) {
  const targetWidth = evenSize(width);
  // A chave e a cor do FUNDO. Em modo "light" o fundo e claro, entao a
  // chave branca e a que apaga o fundo e preserva a cena.
  const key = keyColor.startsWith('0x') ? keyColor : `0x${keyColor}`;

  // `palettegen`/`paletteuse` formam um grafo com entrada e saida multiplas e
  // por isso exigem `-filter_complex` (com `-vf` o ffmpeg recusa o grafo).
  const filterComplex = sourceHasAlpha
    ? `[0:v]scale=${targetWidth}:-2:flags=bicubic,format=rgba[out]`
    : [
      `[0:v]scale=${targetWidth}:-2:flags=bicubic,colorkey=${key}:${similarity}:${smoothness},split[pre][use]`,
      `[pre]palettegen=max_colors=${maxColors}[pal]`,
      '[use][pal]paletteuse=dither=bayer:bayer_scale=3,format=rgba[out]',
    ].join(';');

  await ffmpeg([
    '-i', inputPath,
    '-filter_complex', filterComplex,
    '-map', '[out]',
    '-an',
    '-t', String(durationSec),
    '-r', String(fps),
    '-plays', '0',
    '-f', 'apng',
    '-y', outputPath,
  ], { timeout: 20 * 60 * 1000 });

  const stat = await fsp.stat(outputPath);
  return {
    size: stat.size,
    // Sem chave quando a fonte ja tinha alfa: nao ha cor de fundo registrada.
    keyColor: sourceHasAlpha ? null : key,
    format: 'apng',
    width: targetWidth,
    sourceHasAlpha,
  };
}

/** Compatibilidade: nome antigo, agora produz APNG com alfa real. */
export async function makeAlphaWebm(options) {
  return makeAlphaApng(options);
}

/**
 * Pipeline completo de video. Retorna metadados reais.
 * Sem ffmpeg: devolve status 'pending' (nunca finge que processou).
 */
/**
 * ITEM 3 - porque o ffmpeg nao viu trilha de video.
 *
 * Roda o ffmpeg no arquivo e procura o motivo REAL na saida: container
 * desconhecido, codec nao suportado, arquivo truncado. Com isso o erro de
 * publicacao deixa de ser um "nao contem trilha de video" generico e passa a
 * dizer o que aconteceu - o usuario consegue agir (gravar de novo, exportar
 * como mp4) em vez de ficar so com uma mensagem que nao ajuda.
 *
 * @param {string} inputPath
 * @returns {Promise<{code: string, mensagem: string, detalhes: object}|null>}
 */
async function descreverFalhaDeLeitura(inputPath) {
  const bin = await findFfmpeg();
  if (!bin) return null;
  const { spawn } = await import('node:child_process');
  const stderr = await new Promise((resolve) => {
    const child = spawn(bin, ['-hide_banner', '-nostdin', '-i', inputPath, '-f', 'null', '-'], { windowsHide: true });
    let out = '';
    child.stderr.on('data', (c) => { out += c.toString(); });
    child.on('close', () => resolve(out));
    child.on('error', () => resolve(''));
  });

  const tamanho = Number(stderr.match(/, (\d+) bytes/)?.[1] || 0);
  const linhas = stderr.split('\n').map((l) => l.trim()).filter(Boolean);
  const erro = linhas.find((l) => /Invalid data found|could not find codec|Unsupported|moov atom not found|Truncat/i.test(l));

  if (/moov atom not found/i.test(stderr)) {
    return {
      code: 'video_truncated',
      mensagem: 'O video gravado esta incompleto (o arquivo termina antes do fim). '
        + 'Grave novamente e so publique depois de a gravacao parar.',
      detalhes: { tamanho },
    };
  }
  if (/Invalid data found|Unsupported/i.test(stderr)) {
    return {
      code: 'video_container_unsupported',
      mensagem: 'O ffmpeg nao reconheceu o formato do video gravado. '
        + 'Use MP4 (H.264) ou grave novamente pelo app.',
      detalhes: { tamanho, primeiraLinha: linhas[0] || null },
    };
  }
  if (erro) {
    return {
      code: 'video_probe_failed',
      mensagem: `Nao foi possivel ler o video gravado: ${erro}`,
      detalhes: { tamanho },
    };
  }
  // Sem erro do ffmpeg e sem trilha: e um arquivo de verdade sem video (audio
  // sozinho, por exemplo). A mensagem original e a correta.
  return null;
}

export async function processVideo({ inputPath, workDir, baseKey, mediaId, bucket = 'videos', renditionBucket = 'videos', thumbBucket = 'thumbnails', hlsBucket = 'videos', onProgress }) {
  const available = await ffmpegAvailable();
  if (!available) {
    return { status: 'pending', reason: 'ffmpeg_unavailable', meta: { transcoded: false, hls: false } };
  }

  const meta = await probeMedia(inputPath);
  if (!meta.hasVideo) {
    // Item 3: "nao contem trilha de video" e a mensagem CERTA para um arquivo
    // sem video, e a mensagem ERRADA quando o ffmpeg simplesmente nao
    // conseguiu ler o arquivo. Dizer "sem trilha" nesse segundo caso manda o
    // usuario gravar de novo sem motivo nenhum. Aqui a causa e distinguida e
    //Levada junto: nada e escondido, so nomeado corretamente.
    const leitura = await descreverFalhaDeLeitura(inputPath);
    if (leitura) {
      const err = new Error(leitura.mensagem);
      err.code = leitura.code;
      err.details = leitura.detalhes;
      throw err;
    }
    const err = new Error('Arquivo nao contem trilha de video');
    err.code = 'no_video_track';
    throw err;
  }
  if (meta.durationMs > config.maxVideoDuration * 1000) {
    const err = new Error(`Video excede ${config.maxVideoDuration}s`);
    err.code = 'video_too_long';
    err.details = { durationMs: meta.durationMs, maxMs: config.maxVideoDuration * 1000 };
    throw err;
  }

  await fsp.mkdir(workDir, { recursive: true });
  const result = {
    status: 'ready',
    meta: {
      ...meta,
      transcoded: false,
      hls: false,
      renditions: [],
      thumbnail: null,
    },
  };

  // --- Thumbnail + storyboard (sempre) ---
  const posterPath = path.join(workDir, 'poster.jpg');
  const spritePath = path.join(workDir, 'sprite.jpg');
  try {
    const thumbs = await makeThumbnails({ inputPath, posterPath, spritePath });
    const posterKey = `${mediaId}/poster.jpg`;
    const spriteKey = `${mediaId}/sprite.jpg`;
    const thumbDir = path.join(config.storageRoot, thumbBucket, mediaId);
    await fsp.mkdir(thumbDir, { recursive: true });
    await fsp.copyFile(posterPath, path.join(thumbDir, 'poster.jpg'));
    await fsp.copyFile(spritePath, path.join(thumbDir, 'sprite.jpg'));
    result.meta.thumbnail = {
      posterKey,
      spriteKey,
      ...thumbs,
    };
    onProgress?.({ stage: 'thumbnail', done: true });
  } catch (err) {
    logger.warn('falha ao gerar thumbnail', { mediaId, error: err.message });
    result.meta.thumbnail = null;
  }

  // --- Renditions progressivas ---
  if (config.mediaTranscode) {
    const sourceHeight = meta.height || 720;
    const targets = RENDITIONS.filter((r) => r.height <= sourceHeight + 100);
    if (!targets.length) targets.push(RENDITIONS[0]);
    for (const rendition of targets) {
      try {
        const outPath = path.join(workDir, `${rendition.label}.mp4`);
        const info = await transcodeProgressive({
          inputPath,
          outputPath: outPath,
          height: rendition.height,
          label: rendition.label,
          bitrate: rendition.videoBitrate,
          audioBitrate: rendition.audioBitrate,
        });
        const key = `${mediaId}/${rendition.label}.mp4`;
        await fsp.mkdir(path.dirname(path.join(config.storageRoot, renditionBucket, key)), { recursive: true });
        await fsp.copyFile(outPath, path.join(config.storageRoot, renditionBucket, key));
        result.meta.renditions.push({
          ...info,
          key,
          bitrateKbps: parseInt(rendition.videoBitrate, 10),
          mime: 'video/mp4',
        });
        onProgress?.({ stage: 'rendition', label: rendition.label });
      } catch (err) {
        logger.warn('falha em rendition', { mediaId, label: rendition.label, error: err.message });
      }
    }
    result.meta.transcoded = result.meta.renditions.length > 0;
  }

  // --- HLS adaptativo ---
  if (config.mediaHls && config.mediaTranscode && result.meta.renditions.length) {
    try {
      const hlsDir = path.join(config.storageRoot, hlsBucket, mediaId);
      const variants = [];
      for (const rendition of RENDITIONS) {
        if (!result.meta.renditions.some((r) => r.label === rendition.label)) continue;
        const info = await makeHls({
          inputPath,
          outDir: hlsDir,
          height: rendition.height,
          videoBitrate: rendition.videoBitrate,
          audioBitrate: rendition.audioBitrate,
          label: rendition.label,
        });
        variants.push({
          label: rendition.label,
          width: info.width,
          height: info.height,
          segments: info.segments?.length ?? 0,
          bandwidth: parseInt(rendition.videoBitrate, 10) + parseInt(rendition.audioBitrate, 10),
        });
      }
      if (variants.length) {
        await writeMasterPlaylist({ filePath: path.join(hlsDir, 'master.m3u8'), variants });
        result.meta.hls = true;
        result.meta.hlsKey = `${mediaId}/master.m3u8`;
        result.meta.hlsVariants = variants;
      }
    } catch (err) {
      logger.warn('falha ao gerar HLS', { mediaId, error: err.message });
    }
  }

  // --- Normalizacao do original (remixa quando necessario) ---
  try {
    const needsRemux = meta.videoCodec !== 'h264' || meta.audioCodec === 'vorbis' || meta.audioCodec === 'opus';
    if (needsRemux) {
      const normalized = path.join(workDir, 'original.mp4');
      await transcodeProgressive({
        inputPath,
        outputPath: normalized,
        height: meta.height || 720,
        label: 'source',
        bitrate: `${Math.min(6000, Math.max(800, Math.round((meta.bitrate || 2_000_000) / 1000)))}k`,
      });
      const key = `${mediaId}/original.mp4`;
      await fsp.mkdir(path.dirname(path.join(config.storageRoot, bucket, key)), { recursive: true });
      await fsp.copyFile(normalized, path.join(config.storageRoot, bucket, key));
      result.meta.normalizedKey = key;
    } else {
      result.meta.normalizedKey = baseKey;
    }
  } catch (err) {
    logger.warn('falha ao normalizar original', { mediaId, error: err.message });
    result.meta.normalizedKey = baseKey;
  }

  return result;
}

/** Extrai duracao de audio (gravacoes do chat). */
export async function probeAudio(filePath) {
  return probeMedia(filePath);
}

export async function ffmpegInfo() {
  const bin = await findFfmpeg();
  if (!bin) return { available: false, path: null, ffprobe: false };
  return { available: true, path: bin, ffprobe: Boolean(resolvedFfprobe), root: ROOT };
}
