/**
 * Mini-player de video do YouTube usando APENAS o player oficial.
 *
 * O site controla somente: posicao, arrastar, redimensionar e dispensar.
 * Nao existe: play/pause customizado, barra customizada, botao X, botao
 * "abrir no YouTube" nem controles duplicados. Quem reproduz, pausa e abre
 * em tela cheia e o proprio player do YouTube dentro do iframe.
 */
import { el } from '../core/dom.js';

const YT_API_SRC = 'https://www.youtube.com/iframe_api';

let apiPromise = null;
let playerSeq = 0;

/** Carrega a IFrame API oficial uma unica vez. */
export function loadYouTubeApi() {
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve, reject) => {
    if (window.YT?.Player) { resolve(window.YT); return; }
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      if (typeof previous === 'function') previous();
      resolve(window.YT);
    };
    const script = document.createElement('script');
    script.src = YT_API_SRC;
    script.async = true;
    script.onerror = () => reject(new Error('Nao foi possivel carregar o player oficial do YouTube'));
    document.head.append(script);
    setTimeout(() => reject(new Error('Timeout ao carregar o player do YouTube')), 15000);
  });
  return apiPromise;
}

/** Extrai o videoId de varias formas de URL do YouTube. */
export function parseYouTubeId(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  if (/^[A-Za-z0-9_-]{11}$/.test(raw)) return raw;
  try {
    const url = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
    const host = url.hostname.replace(/^www\./, '');
    if (host === 'youtu.be') {
      const id = url.pathname.slice(1).split('/')[0];
      return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
    }
    if (host.endsWith('youtube.com') || host.endsWith('youtube-nocookie.com')) {
      if (url.pathname === '/watch') {
        const id = url.searchParams.get('v');
        return /^[A-Za-z0-9_-]{11}$/.test(id || '') ? id : null;
      }
      const parts = url.pathname.split('/').filter(Boolean);
      if (['embed', 'shorts', 'live', 'v'].includes(parts[0]) && parts[1]) {
        return /^[A-Za-z0-9_-]{11}$/.test(parts[1]) ? parts[1] : null;
      }
    }
  } catch { /* entrada nao e URL */ }
  return null;
}

/** Lê a variavel enablejsapi=1 sem perder os demais parametros. */
function buildEmbedUrl(videoId) {
  const url = new URL(`https://www.youtube.com/embed/${videoId}`);
  url.searchParams.set('playsinline', '1');
  url.searchParams.set('rel', '0');
  url.searchParams.set('modestbranding', '1');
  url.searchParams.set('enablejsapi', '1');
  url.searchParams.set('origin', location.origin);
  return url.toString();
}

const STORE_KEY = 'pulse_miniplayer';

function readStore() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || '{}'); } catch { return {}; }
}

function writeStore(data) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(data)); } catch { /* quota */ }
}

/**
 * Cria o mini-player. Somente UM player existe por vez.
 * @returns {Promise<{destroy: () => void, focus: () => void, element: HTMLElement}>}
 */
export async function openMiniPlayer(source, { title = '', autoplay = true } = {}) {
  const videoId = parseYouTubeId(source);
  if (!videoId) {
    throw new Error('Link do YouTube invalido. Use um link de video, Short ou live.');
  }

  const host = document.getElementById('mini-player-host');
  if (!host) throw new Error('Host do mini-player nao encontrado');

  // Um player por vez: fecha o anterior de verdade (remove iframe e audio)
  host.replaceChildren();

  playerSeq += 1;
  const playerId = `yt-player-${playerSeq}`;

  const saved = readStore();
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  const defaultWidth = viewport.width < 700 ? Math.min(320, viewport.width - 24) : 360;
  const state = {
    width: clamp(saved.width || defaultWidth, 220, viewport.width - 16),
    x: saved.x ?? null,
    y: saved.y ?? null,
  };

  const iframe = document.createElement('iframe');
  iframe.id = playerId;
  iframe.src = buildEmbedUrl(videoId);
  iframe.title = title || 'Video do YouTube';
  iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';
  iframe.setAttribute('allowfullscreen', '1');
  iframe.setAttribute('frameborder', '0');
  // Sem sandbox com allow-scripts bloqueado: o player oficial precisa rodar livre.
  // allow-same-origin permite o postMessage oficial funcionar.

  const container = el('div', { class: 'mini-player', role: 'region', 'aria-label': title || 'Mini-player de video' });
  const dragStrip = el('div', { class: 'mini-drag', 'aria-hidden': 'true' });
  const handle = el('div', { class: 'mini-resize', 'aria-hidden': 'true' });
  container.append(dragStrip, iframe, handle);
  host.append(container);

  // Posicao inicial (canto inferior direito, acima da tabbar)
  state.x = state.x !== null && state.x < viewport.width - 60 ? state.x : viewport.width - state.width - 12;
  state.y = state.y !== null && state.y < viewport.height - 60 ? state.y : viewport.height - state.width * 0.5625 - 76;
  applyPosition();

  let player = null;
  try {
    const YT = await loadYouTubeApi();
    player = new YT.Player(iframe, {
      videoId,
      playerVars: {
        playsinline: 1,
        rel: 0,
        modestbranding: 1,
        autoplay: autoplay ? 1 : 0,
      },
      events: {
        onReady: () => {
          if (autoplay) {
            // autoplay e responsabilidade do player oficial; se o navegador
            // bloquear, o usuario usa os controles nativos do proprio player.
            try { player.playVideo(); } catch { /* bloqueado pelo navegador */ }
          }
        },
        onError: (event) => {
          console.warn('[youtube] erro no player oficial:', event?.data);
        },
      },
    });
  } catch (err) {
    // Sem API: o iframe do embed oficial continua funcionando normalmente.
    console.warn('[youtube] usando embed sem API:', err.message);
  }

  // ---- Arrastar (mouse e toque) ----
  let dragging = false;
  let startX = 0;
  let startY = 0;
  let originX = 0;
  let originY = 0;
  let lastY = 0;
  let lastTime = 0;
  let velocity = 0;
  let moved = false;

  const onPointerDown = (event) => {
    // So a faixa de arraste e o container iniciam o arraste; a zona de resize
    // tem seu proprio caminho. Eventos dentro do iframe NAO chegam (o iframe
    // e' um documento separado) - e por isso que a faixa existe.
    if (event.target === handle) return;
    if (event.button !== undefined && event.button !== 0) return;
    dragging = true;
    moved = false;
    startX = event.clientX;
    startY = event.clientY;
    originX = state.x;
    originY = state.y;
    lastY = event.clientY;
    lastTime = performance.now();
    velocity = 0;
    container.classList.add('dragging');
    container.setPointerCapture?.(event.pointerId);
    // Durante o arraste o iframe nao deve "engolir" os eventos.
    iframe.style.pointerEvents = 'none';
    event.preventDefault();
  };

  const onPointerMove = (event) => {
    if (!dragging) return;
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;
    const now = performance.now();
    const dt = now - lastTime;
    if (dt > 0) velocity = ((event.clientY - lastY) / dt) * 1000;
    lastY = event.clientY;
    lastTime = now;
    state.x = clamp(originX + dx, 4, window.innerWidth - state.width - 4);
    state.y = clamp(originY + dy, 4, window.innerHeight - state.width * 0.5625 - 4);
    applyPosition();
  };

  const onPointerUp = (event) => {
    if (!dragging) return;
    dragging = false;
    container.classList.remove('dragging');
    container.releasePointerCapture?.(event.pointerId);
    iframe.style.pointerEvents = '';
    // Arrastar rapidamente para cima = dispensar (fecha e para o audio)
    if (velocity < -900 && (event.clientY - startY) < -40) {
      destroy();
      return;
    }
    persist();
  };

  container.addEventListener('pointerdown', onPointerDown);
  container.addEventListener('pointermove', onPointerMove);
  container.addEventListener('pointerup', onPointerUp);
  container.addEventListener('pointercancel', onPointerUp);

  // ---- Redimensionar mantendo 16:9 ----
  let resizing = false;
  let resizeStartWidth = 0;
  let resizeStartX = 0;
  let resizeStartMouseX = 0;

  const onResizeDown = (event) => {
    event.preventDefault();
    event.stopPropagation();
    resizing = true;
    resizeStartWidth = state.width;
    resizeStartMouseX = event.clientX;
    container.classList.add('resizing');
    container.setPointerCapture?.(event.pointerId);
  };
  const onResizeMove = (event) => {
    if (!resizing) return;
    const delta = event.clientX - resizeStartMouseX;
    const next = clamp(resizeStartWidth + delta, 220, Math.min(window.innerWidth - 16, 720));
    state.width = next;
    applyPosition();
  };
  const onResizeUp = (event) => {
    if (!resizing) return;
    resizing = false;
    container.classList.remove('resizing');
    container.releasePointerCapture?.(event.pointerId);
    persist();
  };
  handle.addEventListener('pointerdown', onResizeDown);
  container.addEventListener('pointermove', onResizeMove);
  container.addEventListener('pointerup', onResizeUp);
  container.addEventListener('pointercancel', onResizeUp);

  // ---- Fechar: remove o iframe e para o audio do player ----
  function destroy() {
    try { player?.stopVideo?.(); } catch { /* ignore */ }
    try { player?.destroy?.(); } catch { /* ignore */ }
    // Garante parada mesmo sem a API: remove o iframe da DOM.
    try { iframe.src = 'about:blank'; } catch { /* ignore */ }
    iframe.remove();
    dragStrip.remove();
    handle.remove();
    container.remove();
    host.replaceChildren();
    window.removeEventListener('resize', onViewportChange);
    container.removeEventListener('pointerdown', onPointerDown);
    container.removeEventListener('pointermove', onPointerMove);
    container.removeEventListener('pointerup', onPointerUp);
    container.removeEventListener('pointercancel', onPointerUp);
    handle.removeEventListener('pointerdown', onResizeDown);
    localStorage.removeItem(STORE_KEY);
  }

  function applyPosition() {
    container.style.left = `${state.x}px`;
    container.style.top = `${state.y}px`;
    container.style.width = `${state.width}px`;
    // 16:9 garantido pela aspect-ratio do CSS; explicito para robustez
    container.style.height = `${Math.round(state.width * 0.5625)}px`;
  }

  function persist() {
    writeStore({ x: state.x, y: state.y, width: state.width });
  }

  function onViewportChange() {
    state.x = clamp(state.x, 4, window.innerWidth - state.width - 4);
    state.y = clamp(state.y, 4, window.innerHeight - state.width * 0.5625 - 4);
    applyPosition();
  }
  window.addEventListener('resize', onViewportChange);

  return {
    element: container,
    destroy,
    focus() { try { player?.playVideo?.(); } catch { /* ignore */ } },
    get videoId() { return videoId; },
  };
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

export function miniPlayerOpen() {
  const host = document.getElementById('mini-player-host');
  return Boolean(host && host.querySelector('.mini-player'));
}

/** Fecha o mini-player se existir (usado na navegacao/teardown). */
export function closeMiniPlayer() {
  const host = document.getElementById('mini-player-host');
  const node = host?.querySelector('.mini-player');
  if (node) {
    const iframe = node.querySelector('iframe');
    try { iframe.src = 'about:blank'; } catch { /* ignore */ }
    iframe?.remove();
    node.remove();
  }
  host?.replaceChildren();
  localStorage.removeItem(STORE_KEY);
}
