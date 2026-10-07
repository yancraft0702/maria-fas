/**
 * Editor de video.
 *
 * Camera real (getUserMedia), gravacao em WebM via MediaRecorder, corte,
 * velocidade, volume, filtros, efeitos, texto, stickers, emojis, desenho,
 * capa, descricao, hashtags, mencoes, local, privacidade, comentarios,
 * download, remix e rascunho.
 */
import { api } from '../core/api.js';
import { el, icon, formatDuration } from '../core/dom.js';
import { openModal, toastError, toastSuccess, confirmDialog } from '../core/ui.js';
import { navigate } from '../core/router.js';
import { MediaDevices } from './live.js';
import { createEmojiPanel } from './emoji.js';
import { listSounds } from '../core/sounds.js';
/** Filtros: CSS em tempo real + exportacao limitada ao original.
 *  O pipeline do servidor nao aplica filtros; o filtro e' property do player. */
const FILTERS = [
  { id: 'none', label: 'Original', css: 'none' },
  { id: 'vivid', label: 'Vivid', css: 'saturate(1.5) contrast(1.08)' },
  { id: 'warm', label: 'Quente', css: 'sepia(0.22) saturate(1.2)' },
  { id: 'cool', label: 'Frio', css: 'hue-rotate(-12deg) saturate(1.1)' },
  { id: 'mono', label: 'Mono', css: 'grayscale(1) contrast(1.1)' },
  { id: 'noir', label: 'Noir', css: 'grayscale(1) contrast(1.4) brightness(0.9)' },
  { id: 'sunset', label: 'Pôr do sol', css: 'sepia(0.35) hue-rotate(-18deg) saturate(1.4)' },
  { id: 'cold', label: 'Gelo', css: 'hue-rotate(180deg) saturate(1.2) brightness(1.05)' },
  { id: 'dream', label: 'Sonho', css: 'blur(0.4px) brightness(1.08) saturate(1.15)' },
  { id: 'retro', label: 'Retro', css: 'sepia(0.5) saturate(1.1) contrast(0.95)' },
];

const EFFECTS_VIDEO = [
  { id: 'pulse', label: 'Pulso', css: 'scale(1) brightness(1)' },
  { id: 'breathe', label: 'Respirar', css: 'scale(1.03)' },
  { id: 'shake', label: 'Tremor', css: 'scale(1.01) contrast(1.05)' },
  { id: 'glow', label: 'Brilho', css: 'brightness(1.12) saturate(1.2)' },
];

export function createVideoEditor({ remixPostId = null, draft = null } = {}) {
  const state = {
    stream: null,
    devices: new MediaDevices(),
    recording: false,
    recorder: null,
    chunks: [],
    recordedBlob: null,
    recordedUrl: null,
    recordedDurationMs: 0,
    sourceUrl: null,
    sourceFile: null,
    mediaId: null,
    filter: 'none',
    effect: null,
    volume: 1,
    speed: 1,
    // trimStart/trimEnd sao nomes globais do DOM (String.prototype): use chaves explicitas
    trimStart: 0,
    trimEnd: 0,
    overlays: [],
    drawings: [],
    soundId: null,
    coverBlob: null,
    caption: '',
    visibility: 'public',
    commentsEnabled: true,
    downloadAllowed: 'everyone',
    remixAllowed: 'everyone',
    duetAllowed: true,
    location: '',
    draftId: draft?.id ?? null,
    draftPayload: draft?.payload ?? null,
    timerSeconds: 0,
    timerHandle: null,
    facing: 'user',
    countdown: 0,
  };

  const cleanups = [];
  const stage = el('div', { class: 'editor-stage' });
  const toolsBar = el('div', { class: 'editor-tools', role: 'toolbar', 'aria-label': 'Ferramentas de edicao' });
  const bottomBar = el('div', { class: 'editor-bar' });
  const page = el('div', { class: 'editor', style: { position: 'fixed', inset: '0', zIndex: '70' } }, [
    el('div', { class: 'topbar', style: { position: 'relative' } }, [
      el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Fechar editor', onClick: () => confirmClose() }, [icon('close')]),
      el('strong', { class: 'grow center', text: 'Novo video' }),
      el('button', { type: 'button', class: 'btn btn-sm btn-ghost', text: 'Rascunho', onClick: () => saveDraft() }),
    ]),
    stage,
    toolsBar,
    bottomBar,
  ]);

  const preview = el('video', {
    class: 'preview',
    autoplay: true,
    muted: true,
    playsinline: true,
    style: { maxHeight: '100%', maxWidth: '100%', objectFit: 'contain', background: '#000' },
  });
  preview.muted = true;
  const overlayLayer = el('div', { class: 'editor-canvas-overlay' });
  const drawingCanvas = el('canvas', { class: 'ed-drawing' });
  let liveStreamVideo = null;

  stage.append(preview, overlayLayer, drawingCanvas);
  setupDrawing(drawingCanvas);

  // ---- Barra inferior ----
  const recordBtn = el('button', { type: 'button', class: 'btn btn-primary grow', 'aria-label': 'Gravar' }, [icon('camera'), el('span', { text: ' Gravar' })]);
  const nextBtn = el('button', { type: 'button', class: 'btn btn-solid', text: 'Publicar', disabled: true });
  recordBtn.addEventListener('click', () => (state.recording ? stopRecording() : startRecording()));
  nextBtn.addEventListener('click', () => openPublishSheet());
  bottomBar.append(recordBtn, nextBtn);

  // ---- Ferramentas ----
  const tools = [
    { id: 'flip', icon: 'flip', label: 'Virar', action: flipCamera },
    { id: 'timer', icon: 'timer', label: 'Timer', action: openTimer },
    { id: 'flash', icon: 'flash', label: 'Flash', action: toggleFlash },
    { id: 'speed', icon: 'speed', label: 'Velocidade', action: openSpeed },
    { id: 'cut', icon: 'scissors', label: 'Cortar', action: openTrim },
    { id: 'volume', icon: 'volume', label: 'Volume', action: openVolume },
    { id: 'filter', icon: 'sparkle', label: 'Filtros', action: openFilters },
    { id: 'effect', icon: 'film', label: 'Efeitos', action: openVideoEffects },
    { id: 'text', icon: 'text', label: 'Texto', action: addTextOverlay },
    { id: 'sticker', icon: 'sticker', label: 'Sticker', action: openStickers },
    { id: 'emoji', icon: 'smile', label: 'Emojis', action: openEmojiOverlay },
    { id: 'draw', icon: 'pen', label: 'Desenhar', action: toggleDrawing },
    { id: 'sound', icon: 'music', label: 'Som', action: openSoundPicker },
    { id: 'cover', icon: 'image', label: 'Capa', action: pickCover },
  ];

  for (const tool of tools) {
    toolsBar.append(el('button', {
      type: 'button',
      class: 'tool-btn',
      dataset: { tool: tool.id },
      'aria-label': tool.label,
      onClick: tool.action,
    }, [icon(tool.icon), el('span', { text: tool.label })]));
  }

  // ---- Camera ----
  async function openCamera() {
    if (!MediaDevices.isSupported()) {
      stage.replaceChildren(el('div', { class: 'live-placeholder' }, [
        icon('cameraOff'),
        el('p', { text: 'Este navegador nao oferece camera.' }),
        el('p', { class: 'tiny faint', text: 'Use HTTPS (ou localhost) e um navegador atualizado.' }),
      ]));
      return;
    }
    try {
      if (state.countdown > 0) await runCountdown(state.countdown);
      state.stream = await state.devices.open({ video: true, audio: true, facing: state.facing });
    } catch (err) {
      stage.replaceChildren(el('div', { class: 'live-placeholder' }, [
        icon('cameraOff'),
        el('p', { text: err.name === 'NotAllowedError' ? 'Permissao de camera/microfone negada.' : err.message }),
        el('button', {
          type: 'button', class: 'btn btn-primary', text: 'Enviar um arquivo',
          onClick: () => pickFile(),
        }),
      ]));
      recordBtn.replaceChildren(icon('camera'), el('span', { text: ' Gravar' }));
      return;
    }

    liveStreamVideo = el('video', { autoplay: true, muted: true, playsinline: true, style: { maxHeight: '100%', maxWidth: '100%', objectFit: 'contain', transform: state.facing === 'user' ? 'scaleX(-1)' : 'none' } });
    liveStreamVideo.muted = true;
    liveStreamVideo.srcObject = state.stream;
    stage.replaceChildren(liveStreamVideo, overlayLayer, drawingCanvas);
    applyFilter();
    overlayLayer.replaceChildren();
    resizeCanvas(drawingCanvas);
    recordBtn.replaceChildren(icon('circle' in {} ? 'circle' : 'camera'), el('span', { text: ' Gravar' }));
    recordBtn.classList.add('btn-danger');
    recordBtn.classList.remove('btn-primary');
    nextBtn.disabled = true;
  }

  async function runCountdown(seconds) {
    return new Promise((resolve) => {
      let remaining = seconds;
      const counter = el('div', {
        class: 'live-placeholder',
        style: { position: 'absolute', inset: '0', zIndex: '20', fontSize: '72px', fontWeight: '800', background: 'rgba(0,0,0,.6)' },
        text: String(remaining),
      });
      stage.append(counter);
      const timer = setInterval(() => {
        remaining -= 1;
        if (remaining <= 0) {
          clearInterval(timer);
          counter.remove();
          resolve();
          return;
        }
        counter.textContent = String(remaining);
      }, 1000);
    });
  }

  // ---- Gravacao ----
  async function startRecording() {
    if (!state.stream) { await openCamera(); return; }
    const mimeType = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4']
      .find((type) => window.MediaRecorder?.isTypeSupported?.(type));
    try {
      state.recorder = mimeType ? new MediaRecorder(state.stream, { mimeType }) : new MediaRecorder(state.stream);
    } catch (err) {
      toastError(new Error(`Nao foi possivel iniciar a gravacao: ${err.message}`));
      return;
    }
    state.chunks = [];
    state.startedAt = Date.now();
    state.recorder.ondataavailable = (event) => {
      if (event.data?.size) state.chunks.push(event.data);
    };
    state.recorder.onstop = () => {
      const type = state.recorder?.mimeType || mimeType || 'video/webm';
      state.recordedBlob = state.chunks.length ? new Blob(state.chunks, { type }) : null;
      finishRecording();
    };
    state.recorder.onerror = (event) => toastError(new Error(event.error?.message || 'Falha na gravacao'));

    state.recording = true;
    state.recorder.start(200);
    recordBtn.classList.remove('btn-danger');
    recordBtn.classList.add('btn-primary');
    recordBtn.replaceChildren(icon('pause'), el('span', { text: ' Parar' }));
    nextBtn.disabled = true;

    const tick = setInterval(() => {
      state.recordedDurationMs = Date.now() - state.startedAt;
      recordBtn.lastChild.textContent = ` Parar ${formatDuration(state.recordedDurationMs)}`;
    }, 250);
    state.recordingTimer = tick;
  }

  function stopRecording() {
    if (!state.recorder || state.recorder.state === 'inactive') return;
    clearInterval(state.recordingTimer);
    state.recorder.stop();
  }

  function finishRecording() {
    state.recording = false;
    if (!state.recordedBlob || state.recordedBlob.size === 0) {
      toastError(new Error('A gravacao ficou vazia. Tente novamente.'));
      recordBtn.replaceChildren(icon('camera'), el('span', { text: ' Gravar' }));
      return;
    }
    if (state.recordedUrl) URL.revokeObjectURL(state.recordedUrl);
    state.recordedUrl = URL.createObjectURL(state.recordedBlob);
    state.sourceUrl = state.recordedUrl;
    state.trimStart = 0;
    state.trimEnd = state.recordedDurationMs;
    liveStreamVideo?.pause();
    if (liveStreamVideo?.srcObject) liveStreamVideo.srcObject = null;
    liveStreamVideo = null;
    preview.src = state.sourceUrl;
    preview.muted = false;
    preview.volume = state.volume;
    preview.playbackRate = state.speed;
    preview.loop = true;
    preview.play().catch(() => {});
    stage.replaceChildren(preview, overlayLayer, drawingCanvas);
    applyFilter();
    resizeCanvas(drawingCanvas);

    // Para camera apos gravar: nao deixa microfone/camera abertos
    state.devices.close();
    state.stream = null;

    recordBtn.classList.remove('btn-primary', 'btn-danger');
    recordBtn.classList.add('btn-ghost');
    recordBtn.replaceChildren(icon('replay'), el('span', { text: ' Regravar' }));
    nextBtn.disabled = false;
    toastSuccess(`Video gravado (${(state.recordedBlob.size / 1048576).toFixed(1)} MB)`);
  }

  // ---- Importar arquivo ----
  function pickFile() {
    const input = el('input', { type: 'file', accept: 'video/*', style: { display: 'none' } });
    document.body.append(input);
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      input.remove();
      if (!file) return;
      loadSourceFile(file);
    });
    input.click();
  }

  function loadSourceFile(file) {
    state.sourceFile = file;
    if (state.recordedUrl) URL.revokeObjectURL(state.recordedUrl);
    state.sourceUrl = URL.createObjectURL(file);
    state.recordedBlob = file;
    preview.src = state.sourceUrl;
    preview.loop = true;
    preview.muted = false;
    preview.volume = state.volume;
    const meta = el('video');
    meta.preload = 'metadata';
    meta.src = state.sourceUrl;
    meta.addEventListener('loadedmetadata', () => {
      state.trimStart = 0;
      state.trimEnd = Math.round(meta.duration * 1000);
      state.recordedDurationMs = state.trimEnd;
      toastSuccess(`Arquivo carregado (${formatDuration(state.trimEnd)})`);
      meta.remove();
    }, { once: true });
    stage.replaceChildren(preview, overlayLayer, drawingCanvas);
    applyFilter();
    resizeCanvas(drawingCanvas);
    recordBtn.classList.remove('btn-primary', 'btn-danger');
    recordBtn.classList.add('btn-ghost');
    recordBtn.replaceChildren(icon('replay'), el('span', { text: 'Trocar arquivo' }));
    recordBtn.onclick = pickFile;
    nextBtn.disabled = false;
    preview.play().catch(() => {});
  }

  // ---- Controles ----
  async function flipCamera() {
    if (!state.stream) return;
    state.facing = state.facing === 'user' ? 'environment' : 'user';
    try {
      const track = await state.devices.switchCamera(null);
      if (track && liveStreamVideo) {
        liveStreamVideo.style.transform = state.facing === 'user' ? 'scaleX(-1)' : 'none';
      }
    } catch (err) { toastError(err); }
  }

  function openTimer() {
    const grid = el('div', { class: 'seg' });
    let selected = state.countdown || 0;
    for (const seconds of [0, 3, 10]) {
      grid.append(el('button', {
        type: 'button',
        text: seconds === 0 ? 'Sem timer' : `${seconds}s`,
        'aria-selected': String(selected === seconds),
        onClick: (event) => {
          selected = seconds;
          state.countdown = seconds;
          for (const other of grid.children) other.setAttribute('aria-selected', 'false');
          event.currentTarget.setAttribute('aria-selected', 'true');
        },
      }));
    }
    openModal({
      title: 'Timer de gravacao',
      body: grid,
      actions: [{ label: 'Pronto', class: 'btn-primary' }],
    });
  }

  function toggleFlash() {
    const track = state.stream?.getVideoTracks()[0];
    if (!track?.getCapabilities || !track.getCapabilities().torch) {
      toastError(new Error('Este dispositivo nao tem flash disponivel'));
      return;
    }
    const next = !state.torch;
    track.applyConstraints({ advanced: [{ torch: next }] }).then(
      () => { state.torch = next; toastSuccess(`Flash ${next ? 'ligado' : 'desligado'}`); },
      (err) => toastError(new Error(`Nao foi possivel alternar o flash: ${err.message}`)),
    );
  }

  function openSpeed() {
    const values = [0.5, 0.75, 1, 1.25, 1.5, 2];
    const grid = el('div', { class: 'seg' });
    for (const value of values) {
      grid.append(el('button', {
        type: 'button',
        text: `${value}x`,
        'aria-selected': String(state.speed === value),
        onClick: (event) => {
          state.speed = value;
          preview.playbackRate = value;
          for (const other of grid.children) other.setAttribute('aria-selected', 'false');
          event.currentTarget.setAttribute('aria-selected', 'true');
        },
      }));
    }
    openModal({ title: 'Velocidade', body: grid, actions: [{ label: 'Pronto', class: 'btn-primary' }] });
  }

  function openVolume() {
    const slider = el('input', { type: 'range', min: '0', max: '100', value: String(Math.round(state.volume * 100)), style: { width: '100%' } });
    const label = el('div', { class: 'center small', text: `${Math.round(state.volume * 100)}%` });
    slider.addEventListener('input', () => {
      state.volume = Number(slider.value) / 100;
      preview.volume = state.volume;
      label.textContent = `${slider.value}%`;
    });
    openModal({
      title: 'Volume do video',
      body: el('div', {}, [slider, label]),
      actions: [{ label: 'Pronto', class: 'btn-primary' }],
    });
  }

  function openTrim() {
    if (!state.sourceUrl) {
      toastError(new Error('Grave ou importe um video primeiro'));
      return;
    }
    const total = state.trimEnd || state.recordedDurationMs || 1;
    const start = el('input', { type: 'range', min: '0', max: String(Math.max(0, total - 500)), value: String(state.trimStart), style: { width: '100%' } });
    const end = el('input', { type: 'range', min: String(state.trimStart + 500), max: String(total), value: String(state.trimEnd), style: { width: '100%' } });
    const info = el('div', { class: 'center small', text: `${formatDuration(state.trimStart)} → ${formatDuration(state.trimEnd)}` });
    const update = () => {
      if (Number(end.value) < Number(start.value) + 500) end.value = String(Number(start.value) + 500);
      state.trimStart = Number(start.value);
      state.trimEnd = Number(end.value);
      info.textContent = `${formatDuration(state.trimStart)} → ${formatDuration(state.trimEnd)} (${formatDuration(state.trimEnd - state.trimStart)})`;
      preview.currentTime = state.trimStart / 1000;
    };
    start.addEventListener('input', update);
    end.addEventListener('input', update);
    openModal({
      title: 'Cortar',
      body: el('div', {}, [
        el('div', { class: 'small muted', text: 'Inicio' }), start,
        el('div', { class: 'small muted', text: 'Fim' }), end,
        info,
      ]),
      actions: [{ label: 'Pronto', class: 'btn-primary' }],
    });
  }

  function applyFilter() {
    const filter = FILTERS.find((f) => f.id === state.filter) || FILTERS[0];
    const effect = EFFECTS_VIDEO.find((e) => e.id === state.effect);
    const filters = [filter.css];
    if (effect) filters.push(effect.css);
    const value = filters.filter(Boolean).join(' ');
    preview.style.filter = value;
    if (liveStreamVideo) liveStreamVideo.style.filter = value;
  }

  function openFilters() {
    const strip = el('div', { class: 'filter-strip' });
    for (const filter of FILTERS) {
      const chip = el('button', {
        type: 'button',
        class: 'filter-chip',
        'aria-pressed': String(state.filter === filter.id),
        onClick: () => {
          state.filter = filter.id;
          applyFilter();
          for (const other of strip.children) other.setAttribute('aria-pressed', 'false');
          chip.setAttribute('aria-pressed', 'true');
        },
      }, [
        el('canvas', { width: '60', height: '78' }),
        el('span', { text: filter.label }),
      ]);
      const canvas = chip.firstChild;
      const ctx = canvas.getContext('2d');
      const gradient = ctx.createLinearGradient(0, 0, 60, 78);
      gradient.addColorStop(0, '#8b5cf6');
      gradient.addColorStop(1, '#ef2b4f');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, 60, 78);
      strip.append(chip);
    }
    openModal({ title: 'Filtros', size: '420px', body: strip, actions: [{ label: 'Pronto', class: 'btn-primary' }] });
  }

  function openVideoEffects() {
    const list = el('div', { class: 'seg' });
    for (const effect of EFFECTS_VIDEO) {
      list.append(el('button', {
        type: 'button',
        text: effect.label,
        'aria-selected': String(state.effect === effect.id),
        onClick: (event) => {
          state.effect = state.effect === effect.id ? null : effect.id;
          applyFilter();
          for (const other of list.children) other.setAttribute('aria-selected', 'false');
          if (state.effect === effect.id) event.currentTarget.setAttribute('aria-selected', 'true');
        },
      }));
    }
    openModal({ title: 'Efeitos de movimento', body: list, actions: [{ label: 'Pronto', class: 'btn-primary' }] });
  }

  // ---- Sobreposicoes (texto, stickers, emojis) ----
  const STICKERS = ['✨', '🔥', '💯', '😂', '😱', '❤️', '👏', '🎉', '🤯', '👀', '💀', '🧠', '🌈', '⚡', '🍕', '🎯', '🚩', '💎'];

  function addOverlay(node, { kind }) {
    node.dataset.kind = kind;
    node.style.left = '50%';
    node.style.top = '50%';
    node.style.transform = 'translate(-50%, -50%)';
    overlayLayer.append(node);
    state.overlays.push({ node, kind });
    makeDraggable(node);
    return node;
  }

  function addTextOverlay() {
    const input = el('input', { class: 'input', placeholder: 'Digite o texto', maxlength: '80' });
    openModal({
      title: 'Adicionar texto',
      body: el('div', {}, [
        input,
        el('div', { class: 'field mt' }, [
          el('label', { text: 'Cor' }),
          el('div', { class: 'row row-wrap' }, ['#ffffff', '#8b5cf6', '#ec4899', '#ef2b4f', '#22c55e', '#f59e0b', '#000000'].map((color) => el('button', {
            type: 'button',
            style: { width: '32px', height: '32px', borderRadius: '50%', background: color, border: '1px solid var(--line)', cursor: 'pointer' },
            'aria-label': `Cor ${color}`,
            dataset: { color },
            onClick: (event) => {
              const target = event.currentTarget.closest('.modal').querySelector('.ed-text-preview');
              if (target) target.style.color = color;
            },
          }))),
        ]),
      ]),
      actions: [
        { label: 'Cancelar', class: 'btn-ghost' },
        {
          label: 'Adicionar',
          class: 'btn-primary',
          onClick: () => {
            const text = input.value.trim();
            if (!text) return false;
            const node = addOverlay(el('div', { class: 'ed-text ed-text-preview', text }), { kind: 'text' });
            return true;
          },
        },
      ],
    });
  }

  function openStickers() {
    const grid = el('div', { class: 'picker-grid' });
    for (const sticker of STICKERS) {
      grid.append(el('button', {
        type: 'button', text: sticker,
        onClick: () => {
          addOverlay(el('div', { class: 'ed-sticker', text: sticker }), { kind: 'sticker' });
          modal.close();
        },
      }));
    }
    const modal = openModal({ title: 'Stickers', size: '360px', body: grid });
  }

  function openEmojiOverlay() {
    const fakeField = el('textarea', { style: { position: 'absolute', opacity: '0', pointerEvents: 'none' } });
    overlayLayer.append(fakeField);
    const panel = createEmojiPanel(fakeField, {
      onPick: (emoji) => {
        addOverlay(el('div', { class: 'ed-sticker', text: emoji }), { kind: 'emoji' });
      },
    });
    const modal = openModal({
      title: 'Emojis',
      size: '360px',
      body: panel.element,
      onClose: () => {
        panel.destroy();
        fakeField.remove();
      },
    });
  }

  function toggleDrawing() {
    const button = toolsBar.querySelector('[data-tool="draw"]');
    const active = button.getAttribute('aria-pressed') === 'true';
    button.setAttribute('aria-pressed', String(!active));
    drawingCanvas.style.pointerEvents = active ? 'none' : 'auto';
    drawingCanvas.style.cursor = active ? 'default' : 'crosshair';
    if (!active && !state.drawing) {
      state.drawing = true;
    } else if (active) {
      state.drawing = false;
      // limpa o desenho ao desativar
      const ctx = drawingCanvas.getContext('2d');
      ctx.clearRect(0, 0, drawingCanvas.width, drawingCanvas.height);
      state.drawings = [];
    }
  }

  function setupDrawing(canvas) {
    let drawing = false;
    let lastX = 0;
    let lastY = 0;
    const ctx = canvas.getContext('2d');
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#ffffff';

    const pos = (event) => {
      const rect = canvas.getBoundingClientRect();
      return {
        x: ((event.clientX - rect.left) / rect.width) * canvas.width,
        y: ((event.clientY - rect.top) / rect.height) * canvas.height,
      };
    };
    canvas.addEventListener('pointerdown', (event) => {
      if (state.drawing !== true) return;
      drawing = true;
      const point = pos(event);
      lastX = point.x;
      lastY = point.y;
      canvas.setPointerCapture?.(event.pointerId);
    });
    canvas.addEventListener('pointermove', (event) => {
      if (!drawing) return;
      const point = pos(event);
      ctx.beginPath();
      ctx.moveTo(lastX, lastY);
      ctx.lineTo(point.x, point.y);
      ctx.stroke();
      lastX = point.x;
      lastY = point.y;
    });
    const stop = () => { drawing = false; };
    canvas.addEventListener('pointerup', stop);
    canvas.addEventListener('pointercancel', stop);
  }

  function resizeCanvas(canvas) {
    const rect = stage.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
  }

  function makeDraggable(node) {
    let dragging = false;
    let startX = 0;
    let startY = 0;
    node.addEventListener('pointerdown', (event) => {
      dragging = true;
      startX = event.clientX;
      startY = event.clientY;
      node.setPointerCapture?.(event.pointerId);
      event.stopPropagation();
    });
    node.addEventListener('pointermove', (event) => {
      if (!dragging) return;
      const rect = stage.getBoundingClientRect();
      const x = Math.min(96, Math.max(4, ((event.clientX - rect.left) / rect.width) * 100));
      const y = Math.min(96, Math.max(4, ((event.clientY - rect.top) / rect.height) * 100));
      node.style.left = `${x}%`;
      node.style.top = `${y}%`;
      node.style.transform = 'none';
    });
    const stop = (event) => {
      dragging = false;
      node.releasePointerCapture?.(event.pointerId);
    };
    node.addEventListener('pointerup', stop);
    node.addEventListener('pointercancel', stop);
    node.addEventListener('dblclick', () => {
      node.remove();
      state.overlays = state.overlays.filter((o) => o.node !== node);
    });
    cleanups.push(() => node.remove());
  }

  function pickCover() {
    if (!preview.videoWidth) {
      toastError(new Error('Grave ou importe um video primeiro'));
      return;
    }
    const capture = el('video', { src: preview.src, muted: true, playsinline: true, style: { maxHeight: '60dvh', maxWidth: '100%' } });
    capture.currentTime = Math.min(preview.currentTime, Math.max(0, (preview.duration || 1) - 0.1));
    const canvas = el('canvas');
    const hint = el('p', { class: 'tiny faint center', text: 'Arraste para escolher o quadro da capa' });
    capture.addEventListener('loadeddata', () => {
      canvas.width = capture.videoWidth;
      canvas.height = capture.videoHeight;
    });
    capture.addEventListener('timeupdate', () => {
      const ctx = canvas.getContext('2d');
      ctx.drawImage(capture, 0, 0, canvas.width, canvas.height);
    });
    const timeline = el('input', {
      type: 'range', min: '0', max: '100', value: String(Math.round((preview.currentTime / (preview.duration || 1)) * 100)),
      style: { width: '100%' },
    });
    timeline.addEventListener('input', () => {
      capture.currentTime = (Number(timeline.value) / 100) * (capture.duration || 1);
    });
    const modal = openModal({
      title: 'Escolher capa',
      size: '420px',
      body: el('div', {}, [capture, timeline, hint, el('canvas', { style: { width: '100%', borderRadius: '10px', display: 'none' } })]),
      actions: [
        { label: 'Cancelar', class: 'btn-ghost' },
        {
          label: 'Usar este quadro',
          class: 'btn-primary',
          onClick: () => {
            const visibleCanvas = modal.panel.querySelector('canvas:last-of-type');
            if (!visibleCanvas || !visibleCanvas.width) return false;
            visibleCanvas.style.display = 'block';
            visibleCanvas.getContext('2d').drawImage(capture, 0, 0, visibleCanvas.width, visibleCanvas.height);
            visibleCanvas.toBlob((blob) => { state.coverBlob = blob; }, 'image/jpeg', 0.9);
            return true;
          },
        },
      ],
    });
  }

  async function openSoundPicker() {
    const data = await listSounds({ limit: 30 }).catch(() => ({ sounds: [] }));
    const list = el('div', { class: 'menu-list' });
    for (const sound of data.sounds || []) {
      list.append(el('button', {
        type: 'button', class: 'menu-item',
        onClick: () => {
          state.soundId = sound.id;
          toastSuccess(`Som "${sound.title}" aplicado`);
          modal.close();
        },
      }, [
        icon('music'),
        el('span', { class: 'grow', text: `${sound.title}${sound.artist ? ` · ${sound.artist}` : ''}` }),
        el('span', { class: 'tiny faint', text: `${sound.useCount ?? 0} usos` }),
      ]));
    }
    const modal = openModal({
      title: 'Escolher som',
      body: (data.sounds || []).length ? list : el('p', { class: 'muted small', text: 'Nenhum som disponivel ainda.' }),
    });
  }

  // ---- Rascunho ----
  function draftPayload() {
    return {
      type: state.recordedBlob ? 'video' : 'text',
      mediaId: state.mediaId,
      caption: captionField?.value ?? state.caption,
      visibility: state.visibility,
      commentsEnabled: state.commentsEnabled,
      downloadAllowed: state.downloadAllowed,
      remixAllowed: state.remixAllowed,
      duetAllowed: state.duetAllowed,
      location: state.location,
      soundId: state.soundId,
      filter: state.filter,
      effect: state.effect,
      volume: state.volume,
      speed: state.speed,
      trimStart: state.trimStart,
      trimEnd: state.trimEnd,
      cover: state.coverBlob ? 'presente' : null,
    };
  }

  async function saveDraft() {
    try {
      if (state.recordedBlob && !state.mediaId) {
        const uploaded = await uploadVideo();
        state.mediaId = uploaded.id;
      }
      const result = await api.post('/api/drafts', { id: state.draftId || undefined, payload: draftPayload() });
      state.draftId = result.draft.id;
      toastSuccess('Rascunho salvo (privado)');
    } catch (err) {
      toastError(err);
    }
  }

  async function uploadVideo({ onProgress } = {}) {
    if (!state.recordedBlob) throw new Error('Nada para enviar');
    const type = state.recordedBlob.type || 'video/webm';
    const extension = type.includes('mp4') ? 'mp4' : type.includes('ogg') ? 'ogv' : 'webm';
    const file = new File([state.recordedBlob], `pulse-${Date.now()}.${extension}`, { type });
    const { promise } = api.upload('/api/media/upload?purpose=video', { file, onProgress: onProgress || (() => {}) });
    const result = await promise;
    return result.media;
  }

  // ---- Publicar ----
  let captionField = null;
  function openPublishSheet() {
    if (!state.recordedBlob) {
      toastError(new Error('Grave ou importe um video antes de publicar'));
      return;
    }
    captionField = el('textarea', {
      class: 'textarea',
      placeholder: 'Escreva uma legenda… use #hashtags e @mencoes',
      maxlength: '2200',
    });
    captionField.value = state.draftPayload?.caption || '';

    const visibilitySelect = el('select', { class: 'select' }, [
      el('option', { value: 'public', text: 'Publico' }),
      el('option', { value: 'followers', text: 'Quem me segue' }),
      el('option', { value: 'friends', text: 'Somente amigos' }),
      el('option', { value: 'private', text: 'Somente eu' }),
    ]);
    visibilitySelect.value = state.visibility;

    const locationInput = el('input', { class: 'input', placeholder: 'Localizacao (opcional)', maxlength: '80' });
    locationInput.value = state.location;

    const commentsToggle = el('input', { type: 'checkbox', checked: state.commentsEnabled });
    const downloadSelect = el('select', { class: 'select' }, [
      el('option', { value: 'everyone', text: 'Todos podem baixar' }),
      el('option', { value: 'followers', text: 'Somente seguidores' }),
      el('option', { value: 'friends', text: 'Somente amigos' }),
      el('option', { value: 'nobody', text: 'Ninguem' }),
    ]);
    downloadSelect.value = state.downloadAllowed;

    const remixSelect = el('select', { class: 'select' }, [
      el('option', { value: 'everyone', text: 'Todos podem remixar' }),
      el('option', { value: 'followers', text: 'Somente seguidores' }),
      el('option', { value: 'friends', text: 'Somente amigos' }),
      el('option', { value: 'nobody', text: 'Ninguem' }),
    ]);
    remixSelect.value = state.remixAllowed;

    const duetToggle = el('input', { type: 'checkbox', checked: state.duetAllowed });

    const progressTrack = el('div', { class: 'progress-track' });
    const progressBar = el('div', { class: 'progress-bar' });
    progressTrack.append(progressBar);
    const progressLabel = el('div', { class: 'tiny faint center', text: '' });

    const submitBtn = el('button', { type: 'button', class: 'btn btn-primary btn-block', text: 'Publicar' });

    submitBtn.addEventListener('click', async () => {
      submitBtn.disabled = true;
      submitBtn.textContent = 'Enviando…';
      try {
        state.caption = captionField.value;
        state.visibility = visibilitySelect.value;
        state.location = locationInput.value.trim();
        state.commentsEnabled = commentsToggle.checked;
        state.downloadAllowed = downloadSelect.value;
        state.remixAllowed = remixSelect.value;
        state.duetAllowed = duetToggle.checked;

        if (!state.mediaId) {
          progressLabel.textContent = 'Enviando arquivo…';
          const media = await uploadVideo({
            onProgress: (percent) => {
              progressBar.style.width = `${percent}%`;
              progressLabel.textContent = `Upload ${percent}%`;
            },
          });
          state.mediaId = media.id;
          progressLabel.textContent = 'Processando video no servidor (thumbnail, resolucoes)…';
          // Sincroniza com o processamento em background
          await waitForMedia(media.id);
        }

        const result = await api.post('/api/posts', {
          type: 'video',
          mediaId: state.mediaId,
          caption: state.caption,
          visibility: state.visibility,
          commentsEnabled: state.commentsEnabled,
          downloadAllowed: state.downloadAllowed,
          remixAllowed: state.remixAllowed,
          duetAllowed: state.duetAllowed,
          location: state.location,
          soundId: state.soundId,
        });
        toastSuccess('Publicado!');
        modal.close();
        teardown();
        navigate(`/video/${result.post.id}`);
      } catch (err) {
        toastError(err);
        submitBtn.disabled = false;
        submitBtn.textContent = 'Publicar';
      }
    });

    const modal = openModal({
      title: 'Publicar video',
      size: '480px',
      body: el('div', {}, [
        el('div', { class: 'field' }, [el('label', { text: 'Legenda' }), captionField]),
        el('div', { class: 'field' }, [el('label', { text: 'Visibilidade' }), visibilitySelect]),
        el('div', { class: 'field' }, [el('label', { text: 'Quem pode baixar' }), downloadSelect]),
        el('div', { class: 'field' }, [el('label', { text: 'Quem pode fazer remix' }), remixSelect]),
        el('div', { class: 'field' }, [el('label', { text: 'Localizacao' }), locationInput]),
        el('div', { class: 'switch' }, [el('span', { text: 'Permitir comentarios' }), commentsToggle]),
        el('div', { class: 'switch' }, [el('span', { text: 'Permitir duets' }), duetToggle]),
        progressTrack,
        progressLabel,
        submitBtn,
      ]),
    });

    return modal;
  }

  async function waitForMedia(mediaId, { attempts = 60 } = {}) {
    for (let i = 0; i < attempts; i += 1) {
      try {
        const result = await api.get(`/api/media/${mediaId}/status`);
        if (result.media.status === 'ready') return result.media;
        if (result.media.status === 'failed') {
          throw new Error(`Processamento falhou: ${result.media.error || 'sem detalhes'}`);
        }
      } catch (err) {
        if (err.message?.includes('Processamento falhou')) throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    return null;
  }

  async function confirmClose() {
    const hasContent = Boolean(state.recordedBlob || state.overlays.length);
    if (hasContent) {
      const ok = await confirmDialog({
        title: 'Fechar o editor?',
        message: 'Salve como rascunho para nao perder o trabalho, ou descarte.',
        confirmLabel: 'Salvar rascunho',
        cancelLabel: 'Descartar',
      });
      if (ok) {
        await saveDraft();
        teardown();
        navigate('/');
        return;
      }
      const discard = await confirmDialog({
        title: 'Descartar o video?',
        message: 'Esta acao nao pode ser desfeita.',
        confirmLabel: 'Descartar',
        danger: true,
      });
      if (!discard) return;
    }
    teardown();
    navigate('/');
  }

  function teardown() {
    for (const fn of cleanups) fn();
    cleanups.length = 0;
    clearInterval(state.recordingTimer);
    clearInterval(state.timerHandle);
    if (state.recorder && state.recorder.state !== 'inactive') {
      try { state.recorder.stop(); } catch { /* ignore */ }
    }
    try { preview.pause(); } catch { /* ignore */ }
    preview.removeAttribute('src');
    if (state.recordedUrl) URL.revokeObjectURL(state.recordedUrl);
    state.devices.close();
    state.stream = null;
    overlayLayer.replaceChildren();
    page.replaceChildren();
    page.remove();
  }

  // ---- Inicializacao ----
  if (remixPostId) {
    loadRemix(remixPostId);
  } else if (state.draftPayload) {
    // rascunho: recupera configuracoes (midia precisa ser reenviada se nao houver arquivo local)
    state.caption = state.draftPayload.caption || '';
    state.visibility = state.draftPayload.visibility || 'public';
    state.soundId = state.draftPayload.soundId || null;
    state.filter = state.draftPayload.filter || 'none';
    state.mediaId = state.draftPayload.mediaId || null;
    if (state.mediaId) {
      api.get(`/api/media/${state.mediaId}/status`).then((result) => {
        if (result.media?.status === 'ready') {
          state.sourceUrl = `/api/media/stream?key=${encodeURIComponent(`videos/${result.media.id}`)}`;
        }
      }).catch(() => {});
    }
    openCamera();
  } else {
    // Botao de importar arquivo sempre disponivel
    recordBtn.addEventListener('click', () => {}, { once: true });
    openCamera();
  }

  window.addEventListener('resize', () => resizeCanvas(drawingCanvas));
  cleanups.push(() => window.removeEventListener('resize', () => resizeCanvas(drawingCanvas)));

  async function loadRemix(postId) {
    try {
      const result = await api.get(`/api/posts/${postId}`);
      const post = result.post;
      state.caption = post.caption || '';
      state.soundId = post.sound?.id || null;
      state.sourceUrl = post.media?.url || null;
      if (state.sourceUrl) {
        preview.src = state.sourceUrl;
        preview.loop = true;
        preview.muted = false;
        stage.replaceChildren(preview, overlayLayer, drawingCanvas);
        resizeCanvas(drawingCanvas);
        recordBtn.classList.remove('btn-primary', 'btn-danger');
        recordBtn.classList.add('btn-ghost');
        recordBtn.replaceChildren(icon('replay'), el('span', { text: 'Trocar arquivo' }));
        recordBtn.onclick = pickFile;
        nextBtn.disabled = false;
        preview.play().catch(() => {});
      }
      toastSuccess(`Remix de @${post.author.username}`);
    } catch (err) {
      toastError(err);
      openCamera();
    }
  }

  return {
    element: page,
    destroy() { teardown(); },
  };
}
