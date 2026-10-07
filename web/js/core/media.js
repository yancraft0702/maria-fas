/**
 * Modo de manutencao das midias.
 *
 * O objetivo e NUNCA deixar: video tocando fora da tela, audio duplicado,
 * camera/microfone abertos, iframe invisivel, timer vazando.
 * Este modulo e o unico lugar onde <video> e <audio> sao criados.
 */

const registry = new Map(); // id -> { node, kind, ownerId, playing, createdAt }
let counter = 0;

function nextId() {
  counter += 1;
  return `media-${counter}`;
}

/**
 * Registra um elemento de midia no registro global.
 * @returns {() => void} destruicao (idempotente)
 */
export function registerMedia(node, { kind = 'video', ownerId = null } = {}) {
  const id = nextId();
  registry.set(id, { node, kind, ownerId, playing: false, createdAt: Date.now() });

  const markState = () => {
    const entry = registry.get(id);
    if (entry) entry.playing = !node.paused && !node.ended && node.readyState > 2;
  };
  node.addEventListener('play', markState);
  node.addEventListener('pause', markState);
  node.addEventListener('ended', markState);
  node.addEventListener('emptied', markState);

  let destroyed = false;
  return function destroy() {
    if (destroyed) return;
    destroyed = true;
    registry.delete(id);
    try {
      node.pause();
      node.removeAttribute('src');
      if (node.src && !node.src.startsWith('blob:')) {
        try { node.load(); } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
    node.remove();
  };
}

export function destroyMedia(node) {
  for (const [id, entry] of registry) {
    if (entry.node === node) {
      registry.delete(id);
      try { node.pause(); node.removeAttribute('src'); node.load(); } catch { /* ignore */ }
      node.remove();
      return;
    }
  }
}

/** Pausa tudo que pertence a um dono (ex.: todas as midias de um slide). */
export function pauseOwnedBy(ownerId) {
  let count = 0;
  for (const entry of registry.values()) {
    if (entry.ownerId !== ownerId) continue;
    try { entry.node.pause(); } catch { /* ignore */ }
    count += 1;
  }
  return count;
}

/** Pausa todas as midias registradas (limpeza de tela). */
export function pauseAll() {
  let count = 0;
  for (const entry of registry.values()) {
    try { entry.node.pause(); } catch { /* ignore */ }
    count += 1;
  }
  return count;
}

/** Destroi todas as midias de um dono (usado no cleanup de rota). */
export function destroyOwnedBy(ownerId) {
  const destroys = [];
  for (const [id, entry] of registry) {
    if (entry.ownerId !== ownerId) continue;
    registry.delete(id);
    destroys.push(destroyMedia(entry.node));
  }
  return destroys;
}

export function destroyAll() {
  for (const entry of [...registry.values()]) {
    destroyMedia(entry.node);
  }
  registry.clear();
}

export function stats() {
  let playing = 0;
  let videos = 0;
  let audios = 0;
  for (const entry of registry.values()) {
    if (entry.playing) playing += 1;
    if (entry.kind === 'video') videos += 1;
    if (entry.kind === 'audio') audios += 1;
  }
  return { total: registry.size, playing, videos, audios };
}

/** Cria um <video> registrado. */
export function createVideo({ src, poster = null, muted = false, loop = false, playsInline = true, controls = false, ownerId = null, preload = 'metadata', crossOrigin = null } = {}) {
  const video = document.createElement('video');
  video.playsInline = playsInline;
  video.setAttribute('playsinline', '');
  video.muted = muted;
  video.loop = loop;
  video.controls = controls;
  video.preload = preload;
  if (crossOrigin) video.crossOrigin = crossOrigin;
  if (poster) video.poster = poster;
  if (src) video.src = src;
  registerMedia(video, { kind: 'video', ownerId });
  return video;
}

/** Cria um <audio> registrado. */
export function createAudio({ src, controls = true, ownerId = null, preload = 'none' } = {}) {
  const audio = document.createElement('audio');
  audio.controls = controls;
  audio.preload = preload;
  if (src) audio.src = src;
  registerMedia(audio, { kind: 'audio', ownerId });
  return audio;
}

/**
 * Reproduz com resiliencia: navegadores bloqueiam autoplay com som.
 * Se falhar, tenta de novo sem audio e sinaliza o chamador.
 */
export async function safePlay(media, { muted = true } = {}) {
  if (!media) return { played: false, reason: 'no_media' };
  try {
    media.muted = muted;
    await media.play();
    return { played: true, muted };
  } catch (err) {
    if (err.name === 'NotAllowedError' && !muted) {
      try {
        media.muted = true;
        await media.play();
        return { played: true, muted: true, blockedByPolicy: true };
      } catch (err2) {
        return { played: false, reason: err2.name };
      }
    }
    return { played: false, reason: err.name };
  }
}

/** Buffers de video para o player principal do feed. */
class VideoPool {
  constructor(max = 4) {
    this.max = max;
    this.pool = [];
  }

  acquire() {
    const reused = this.pool.pop();
    if (reused) return reused;
    const video = document.createElement('video');
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.preload = 'auto';
    video.muted = true;
    return video;
  }

  release(video) {
    if (!video) return;
    try { video.pause(); } catch { /* ignore */ }
    try { video.removeAttribute('src'); video.load(); } catch { /* ignore */ }
    video.remove();
    if (this.pool.length < this.max) this.pool.push(video);
  }

  destroy() {
    this.pool = [];
  }
}

export const videoPool = new VideoPool(4);

/**
 * Snapshot de recursos vivos na pagina (diagnostico e testes).
 *
 * `console.debug` (nao `console.log`): o dump so aparece quando o devtools
 * esta com o nivel debug ligado, entao nao polui o log de operacao.
 */
export function auditMedia({ log = false } = {}) {
  const snapshot = {
    ...stats(),
    videosInDom: document.querySelectorAll('video').length,
    audiosInDom: document.querySelectorAll('audio').length,
    iframesInDom: document.querySelectorAll('iframe').length,
    activeStreams: 0,
  };
  if (log) console.debug('[pulse:midia]', snapshot);
  return snapshot;
}
