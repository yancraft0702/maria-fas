/**
 * Helpers de DOM. Sem framework: criacao rapida, sem v-html em dados do
 * usuario (XSS sempre escapado).
 */

/**
 * Achata arrays de filhos em qualquer profundidade.
 *
 * CAUSA RAZ do item 21 (a busca mostrar a URL do perfil em vez do nome): com um
 * array aninhado dentro da lista de filhos, `el()` nao reconhecia um `Node` e
 * caia em `createTextNode(String(child))`. Em um HTMLAnchorElement,
 * `String()` devolve o HREF RESOLVIDO - por isso a tela mostrava
 * "http://127.0.0.1:3000/@fulano" no lugar de "Nome / @fulano". A lista de
 * pessoas virava um texto e o perfil nunca aparecia.
 *
 * O limite de profundidade evita que um array que se referencia vire pilha
 * estourada.
 */
function achatarFilhos(children, saida, profundidade = 0) {
  if (children === null || children === undefined || children === false) return;
  if (profundidade > 12) return;
  if (Array.isArray(children)) {
    for (const filho of children) achatarFilhos(filho, saida, profundidade + 1);
    return;
  }
  saida.push(children);
}

export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class' || key === 'className') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value; // apenas para SVG interno confiavel
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'disabled' || key === 'hidden' || key === 'checked' || key === 'selected') {
      node[key] = Boolean(value);
    } else node.setAttribute(key, value);
  }
  const lista = [];
  achatarFilhos(children, lista);
  for (const child of lista) {
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

export function svg(path, { viewBox = '0 0 24 24', className = '', filled = false } = {}) {
  const node = document.createElementNS(SVG_NS, 'svg');
  node.setAttribute('viewBox', viewBox);
  node.setAttribute('aria-hidden', 'true');
  if (className) node.setAttribute('class', className);
  if (filled) node.setAttribute('class', `${className} filled`.trim());
  node.innerHTML = path;
  return node;
}

export const ICONS = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/>',
  friends: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9"/><path d="M16 3.1a4 4 0 0 1 0 7.8"/>',
  inbox: '<path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  heart: '<path d="M20.8 5.6a5.5 5.5 0 0 0-7.8 0L12 6.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l8.8 8.8 8.8-8.8a5.5 5.5 0 0 0 0-7.8Z"/>',
  comment: '<path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z"/>',
  bookmark: '<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16Z"/>',
  share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4"/>',
  music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
  bell: '<path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>',
  live: '<circle cx="12" cy="12" r="3"/><path d="M7.8 7.8a6 6 0 0 0 0 8.4M16.2 7.8a6 6 0 0 1 0 8.4"/><path d="M4.9 4.9a10 10 0 0 0 0 14.2M19.1 4.9a10 10 0 0 1 0 14.2"/>',
  camera: '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2v11Z"/><circle cx="12" cy="13" r="4"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/>',
  mic: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0"/><path d="M12 17v5"/>',
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  more: '<circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/>',
  check: '<path d="m5 13 4 4L19 7"/>',
  play: '<path d="M6 4l14 8-14 8V4Z"/>',
  pause: '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 13a7.9 7.9 0 0 0 0-2l2-1.6-2-3.4-2.4 1a7.7 7.7 0 0 0-1.7-1L15 3h-4l-.3 2.6a7.7 7.7 0 0 0-1.7 1l-2.4-1-2 3.4L6.6 11a7.9 7.9 0 0 0 0 2l-2 1.6 2 3.4 2.4-1a7.7 7.7 0 0 0 1.7 1L11 21h4l.3-2.6a7.7 7.7 0 0 0 1.7-1l2.4 1 2-3.4-2-1.6Z"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="3.5" cy="6" r="1.2"/><circle cx="3.5" cy="12" r="1.2"/><circle cx="3.5" cy="18" r="1.2"/>',
  send: '<path d="M22 2 11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7Z"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M6 6l1 15h10l1-15"/>',
  flag: '<path d="M4 21V4h11l-1 4h6l-2 6h-4l-1 3H4"/>',
  block: '<circle cx="12" cy="12" r="9"/><path d="m5.6 5.6 12.8 12.8"/>',
  mute: '<path d="M11 5 6 9H2v6h4l5 4V5Z"/><path d="m22 9-6 6M16 9l6 6"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/>',
  edit: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5Z"/>',
  // Item 13: botao REPUBLICAR na barra da LIVE. Antes o `icon('repeat')`
  // devolvia SVG vazio e o botao aparecia sem desenho.
  repeat: '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/>',
  sparkle: '<path d="M12 3v6M12 15v6M3 12h6M15 12h6"/><path d="m6.3 6.3 3 3M14.7 14.7l3 3M17.7 6.3l-3 3M9.3 14.7l-3 3"/>',
  text: '<path d="M4 7V5h16v2M12 5v14M9 19h6"/>',
  smile: '<circle cx="12" cy="12" r="9"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><circle cx="9" cy="9" r="1"/><circle cx="15" cy="9" r="1"/>',
  sticker: '<path d="M15 3H5a2 2 0 0 0-2 2v10l9 9 9-9V8l-6-5Z"/><path d="M12 3v6h6"/>',
  gif: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M10 10a2 2 0 1 0 0 4M17 10h3M17 14h2"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2 21v-1a5 5 0 0 1 5-5h4a5 5 0 0 1 5 5v1"/><path d="M17 4.5a3.5 3.5 0 0 1 0 7"/>',
  lock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  chevronLeft: '<path d="m15 18-6-6 6-6"/>',
  chevronRight: '<path d="m9 18 6-6-6-6"/>',
  replay: '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 3v6h6"/>',
  volume: '<path d="M11 5 6 9H2v6h4l5 4V5Z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/>',
  volumeOff: '<path d="M11 5 6 9H2v6h4l5 4V5Z"/><path d="m16 9 5 6M21 9l-5 6"/>',
  flip: '<path d="M12 3v18"/><path d="M8 7 3 12l5 5V7ZM16 7l5 5-5 5V7Z"/>',
  timer: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2M9 2h6"/>',
  flash: '<path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z"/>',
  speed: '<path d="M12 20a8 8 0 1 1 8-8"/><path d="m12 12 4-3"/>',
  music2: '<circle cx="12" cy="12" r="9"/><path d="M9 18V5l10-2v13"/>',
  link: '<path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/>',
  location: '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
  eyeOff: '<path d="M9.9 5.2A9.7 9.7 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3 4M6.3 6.4A17 17 0 0 0 2 12s3.6 7 10 7a9.6 9.6 0 0 0 4.5-1.1"/><path d="m3 3 18 18"/><path d="M10 10a2.8 2.8 0 0 0 4 4"/>',
  message: '<path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z"/>',
  cameraOff: '<path d="M2 2l20 20"/><path d="M9 5h6l2 3h4a2 2 0 0 1 2 2v9M3 8v11a2 2 0 0 0 2 2h12"/><path d="M9.5 9.5A4 4 0 0 0 15 15"/>',
  film: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M7 4v16M17 4v16M2 9h5M2 15h5M17 9h5M17 15h5"/>',
  hash: '<path d="M9 3 7 21M17 3l-2 18M4 9h16M3 15h16"/>',
  bookmark2: '<path d="M6 3h12v18l-6-4.5L6 21V3Z"/>',
  pen: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5Z"/>',
  cut: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4 8.1 15.9M14.5 14.5 20 20M8.1 8.1 12 12"/>',
  rotate: '<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  warning: '<path d="M12 3 2 20h20L12 3Z"/><path d="M12 9v5M12 17h.01"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  arrowLeft: '<path d="M19 12H5M11 18l-6-6 6-6"/>',
  logout2: '<path d="M15 17l5-5-5-5"/><path d="M20 12H9"/><path d="M9 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9 3 3-2 2 2 2-3 3-2-2-2 2"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18Z"/>',
  cloud: '<path d="M17.5 19a4.5 4.5 0 0 0 .5-8.97A6 6 0 0 0 6.2 10.5 4 4 0 0 0 6 19h11.5Z"/>',
  text2: '<path d="M4 6h16M4 12h10M4 18h13"/>',
  headset: '<path d="M4 14v-2a8 8 0 0 1 16 0v2"/><rect x="2" y="14" width="4" height="6" rx="1.5"/><rect x="18" y="14" width="4" height="6" rx="1.5"/>',
  scissors: '<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><path d="M8 7.5 20 18M20 6 8 16.5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  userPlus: '<path d="M15 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><path d="M19 8v6M22 11h-6"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
};

export function icon(name, options = {}) {
  return svg(ICONS[name] || ICONS.help || '<circle cx="12" cy="12" r="9"/>', options);
}

/**
 * CORACAO da marca MARIA FÃS - definicao UNICA.
 *
 * Header, sidebar, bottom bar e tela de entrada usam todos este mesmo SVG
 * (item 2/27: nao pode existir um segundo desenho de logo). O preenchimento
 * vem das variaveis CSS da marca, e nao de um `<linearGradient>` com `id`,
 * porque o mesmo `id` se repetiria varias vezes no mesmo documento.
 *
 * @param {object} [options]
 * @param {string} [options.className] classe extra no <svg>
 * @param {number} [options.size] largura em px (a altura sai da proporcao 64:58)
 */
export function brandHeart({ className = '', size = 0 } = {}) {
  const h = size ? Math.round((size * 58) / 64) : 0;
  const box = size
    ? `width="${size}" height="${h}" style="width:${size}px;height:${h}px"`
    : '';
  const cls = `heart-logo ${className}`.trim();
  return `<svg class="${cls}" viewBox="0 0 64 58" role="img" aria-hidden="true" focusable="false" ${box}>
      <path class="heart-body"
            d="M32 55.5 6.9 31.2a15.6 15.6 0 0 1 22.1-22l3 3 3-3a15.6 15.6 0 1 1 22.1 22Z"/>
      <path class="heart-shine"
            d="M17.6 15.4a5.4 5.4 0 0 1 7.6 0l1.2 1.2-8.8 8.6-1.4-1.4a5.4 5.4 0 0 1 1.4-8.4Z"/>
    </svg>`;
}

export function clearNode(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function mount(container, ...children) {
  clearNode(container);
  for (const child of children.flat()) {
    if (child) container.append(child);
  }
  return container;
}

export function escapeHtml(text) {
  return String(text ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Converte @username e #hashtag em nos clicaveis (sem innerHTML). */
export function linkifyText(text, { onMention, onHashtag } = {}) {
  const fragment = document.createDocumentFragment();
  const source = String(text ?? '');
  const regex = /(@[a-z0-9._]{3,24}|#[\p{L}\p{N}_]{1,40})/gu;
  let last = 0;
  let match;
  while ((match = regex.exec(source)) !== null) {
    if (match.index > last) fragment.append(source.slice(last, match.index));
    const token = match[0];
    const button = el('button', {
      type: 'button',
      class: 'inline-token',
      style: {
        background: 'none', border: 'none', padding: '0', color: 'inherit',
        font: 'inherit', fontWeight: '700', cursor: 'pointer', textDecoration: 'underline',
      },
      text: token,
    });
    if (token.startsWith('@')) button.addEventListener('click', () => onMention?.(token.slice(1)));
    else button.addEventListener('click', () => onHashtag?.(token.slice(1)));
    fragment.append(button);
    last = match.index + token.length;
  }
  if (last < source.length) fragment.append(source.slice(last));
  return fragment;
}

export function formatCount(value) {
  const n = Number(value) || 0;
  if (n < 1000) return String(n);
  if (n < 1_000_000) {
    const v = n / 1000;
    return `${v.toFixed(v < 10 ? 1 : 0).replace('.0', '')} mil`;
  }
  if (n < 1_000_000_000) {
    const v = n / 1_000_000;
    return `${v.toFixed(v < 10 ? 1 : 0).replace('.0', '')} mi`;
  }
  return `${(n / 1_000_000_000).toFixed(1).replace('.0', '')} bi`;
}

export function formatTime(ms) {
  if (!ms) return '';
  const seconds = Math.floor((Date.now() - Number(ms)) / 1000);
  if (seconds < 60) return 'agora';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)} d`;
  return new Date(Number(ms)).toLocaleDateString('pt-BR');
}

export function formatDuration(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function timeAgo(ms) {
  return formatTime(ms);
}

export function debounce(fn, wait = 250) {
  let timer = null;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
  wrapped.cancel = () => clearTimeout(timer);
  return wrapped;
}

export function throttle(fn, wait = 100) {
  let last = 0;
  let timer = null;
  return (...args) => {
    const now = Date.now();
    const remaining = wait - (now - last);
    if (remaining <= 0) {
      last = now;
      fn(...args);
    } else if (!timer) {
      timer = setTimeout(() => {
        last = Date.now();
        timer = null;
        fn(...args);
      }, remaining);
    }
  };
}

export function uid(prefix = 'id') {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

/** Aguarda o proximo frame (para roteiro de animacao). */
export function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

export function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Observa quando o elemento entra na viewport. */
export function observeVisible(element, callback, options = { rootMargin: '200px' }) {
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) callback(entry);
    }
  }, options);
  observer.observe(element);
  return () => observer.disconnect();
}

export function isTouchDevice() {
  return window.matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
}

export function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
