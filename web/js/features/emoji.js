/**
 * Seletor de emojis.
 *
 * Regra critica: UMA acao = UMA insercao.
 * - apenas `click` (unico listener por botao)
 * - sem listeners em elemento pai + filho
 * - sem ponteiros duplicados (touchstart/pointerdown)
 * - `insert()` e idempotente por documento (ignora evento em andamento)
 */

const CATEGORIES = [
  { id: 'recentes', label: 'Recentes', icon: 'clock' },
  { id: 'rostos', label: 'Rostos', icon: 'smile' },
  { id: 'gestos', label: 'Gestos', icon: 'users' },
  { id: 'animais', label: 'Animais', icon: 'paw' },
  { id: 'comida', label: 'Comida', icon: 'food' },
  { id: 'atividade', label: 'Atividade', icon: 'ball' },
  { id: 'viagem', label: 'Viagem', icon: 'plane' },
  { id: 'objetos', label: 'Objetos', icon: 'bulb' },
  { id: 'simbolos', label: 'Simbolos', icon: 'sparkle' },
  { id: 'bandeiras', label: 'Bandeiras', icon: 'flag' },
];

const EMOJI = {
  rostos: [
    '😀', '😃', '😄', '😁', '😆', '😅', '🤣', '😂', '🙂', '🙃',
    '😉', '😊', '😇', '🥰', '😍', '🤩', '😘', '😗', '😚', '😙',
    '😋', '😛', '😜', '🤪', '😝', '🤑', '🤗', '🤭', '🤫', '🤔',
    '🤐', '🤨', '😐', '😑', '😶', '😏', '😒', '🙄', '😬', '😮',
    '😯', '😲', '😳', '🥺', '😦', '😧', '😨', '😰', '😥', '😢',
    '😭', '😱', '😖', '😣', '😞', '😓', '😩', '😫', '🥱', '😤',
    '😡', '😠', '🤬', '😈', '💀', '🤡', '👻', '👽', '🤖', '😺',
    '😸', '😹', '😻', '😼', '😽', '🙀', '😿', '😾', '🙈', '🙉',
    '🙊', '💋', '💌', '💘', '💝', '💖', '💗', '💓', '💞', '💕',
  ],
  gestos: [
    '👍', '👎', '👌', '🤌', '✌️', '🤞', '🤟', '🤘', '🤙', '👈',
    '👉', '👆', '👇', '☝️', '✋', '🤚', '🖐️', '🖖', '👋', '🤝',
    '👏', '🙌', '👐', '🤲', '🤜', '🤛', '✊', '👊', '🫶', '🙏',
    '💪', '🦾', '👀', '🧠', '🦷', '👣', '🫰', '🫵', '🖕', '🤌',
  ],
  animais: [
    '🐶', '🐱', '🐭', '🐹', '🐰', '🦊', '🐻', '🐼', '🐨', '🐯',
    '🦁', '🐮', '🐷', '🐸', '🐵', '🐔', '🐧', '🐦', '🐤', '🦆',
    '🦅', '🦉', '🦇', '🐺', '🐗', '🐴', '🦄', '🐝', '🐛', '🦋',
    '🐌', '🐞', '🐢', '🐍', '🦖', '🐙', '🦑', '🦀', '🐠', '🐟',
    '🐬', '🐳', '🦈', '🐊', '🐘', '🦒', '🦓', '🦘', '🐄', '🐖',
    '🐑', '🐐', '🦌', '🐕', '🐩', '🦮', '🐈', '🐓', '🦃', '🦚',
  ],
  comida: [
    '🍏', '🍎', '🍐', '🍊', '🍋', '🍌', '🍉', '🍇', '🍓', '🫐',
    '🍒', '🍑', '🥭', '🍍', '🥥', '🥝', '🍅', '🥑', '🥦', '🥬',
    '🥒', '🌶️', '🌽', '🥕', '🧄', '🧅', '🥔', '🍠', '🥐', '🥯',
    '🍞', '🥖', '🥨', '🧀', '🥚', '🍳', '🥞', '🥓', '🍔', '🍟',
    '🍕', '🌭', '🥪', '🌮', '🌯', '🥗', '🍝', '🍜', '🍲', '🍛',
    '🍣', '🍱', '🥟', '🍤', '🍙', '🍚', '🍘', '🍥', '🥠', '🥮',
    '🍢', '🍡', '🍧', '🍨', '🍦', '🥧', '🧁', '🍰', '🎂', '🍮',
    '🍭', '🍬', '🍫', '🍿', '🍩', '🍪', '☕', '🍵', '🧃', '🥤',
    '🍺', '🍻', '🥂', '🍷', '🥃', '🍸', '🍹', '🍾', '🧊', '🍽️',
  ],
  atividade: [
    '⚽', '🏀', '🏈', '⚾', '🥎', '🎾', '🏐', '🏉', '🥏', '🎱',
    '🪀', '🏓', '🏸', '🏒', '🏑', '🥍', '🏏', '⛳', '🪁', '🏹',
    '🎣', '🤿', '🥊', '🥋', '🎽', '🛹', '🛼', '🛷', '⛸️', '🥌',
    '🎿', '⛷️', '🏂', '🏋️', '🤼', '🤸', '🤺', '🤾', '🏌️', '🏇',
    '🧘', '🏄', '🏊', '🤽', '🚣', '🧗', '🚴', '🚵', '🎪', '🎭',
    '🎨', '🎬', '🎤', '🎧', '🎼', '🎹', '🥁', '🎷', '🎺', '🎸',
    '🎲', '🎯', '🎮', '🕹️', '🎰', '🧩',
  ],
  viagem: [
    '🚗', '🚕', '🚙', '🚌', '🚎', '🏎️', '🚓', '🚑', '🚒', '🚐',
    '🚚', '🚛', '🚜', '🛴', '🚲', '🛵', '🏍️', '🚨', '🚔', '🚍',
    '🚝', '🚄', '🚅', '🚈', '🚂', '🚆', '🚄', '🚃', '✈️', '🛫',
    '🛬', '🛩️', '💺', '🛰️', '🚀', '🛸', '🚁', '🛶', '⛵', '🚤',
    '🛥️', '🛳️', '⛴️', '🚢', '⚓', '⛽', '🚧', '🚦', '🚥', '🗺️',
    '🗿', '🗽', '🗼', '🏰', '🏯', '🏟️', '🎡', '🎢', '🎠', '⛲',
    '⛱️', '🏖️', '🏝️', '🏜️', '🌋', '⛰️', '🏔️', '🗻', '🏕️', '⛺',
    '🌍', '🌎', '🌏', '🗾',
  ],
  objetos: [
    '⌚', '📱', '💻', '⌨️', '🖥️', '🖨️', '🖱️', '💽', '💾', '💿',
    '📀', '📼', '📷', '📸', '📹', '🎥', '📽️', '📞', '☎️', '📟',
    '📠', '📺', '📻', '🎙️', '⏱️', '⏰', '⏲️', '🕰️', '🕒', '🔋',
    '🔌', '💡', '🔦', '🕯️', '🧯', '🛢️', '💸', '💵', '💴', '💶',
    '💰', '💳', '🧾', '💎', '⚖️', '🔧', '🔨', '⚒️', '🛠️', '⛏️',
    '🔩', '⚙️', '🧰', '🧲', '🪜', '🔫', '💣', '🧨', '🪓', '🔪',
    '🗡️', '⚔️', '🛡️', '🚬', '⚰️', '🏺', '🔮', '📿', '🧿', '💈',
    '⚱️', '🏆', '🥇', '🥈', '🥉', '🎖️', '🎗️', '🎫', '🎟️', '🎪',
    '🤹', '🎭', '🖼️', '🛍️', '🛒', '🎁', '🎈', '🎏', '🎀', '📚',
    '📖', '📝', '✏️', '🖊️', '📌', '📎', '📐', '📏', '🧮', '📅',
  ],
  simbolos: [
    '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '💔',
    '❣️', '💕', '💞', '💓', '💗', '💖', '💘', '💝', '✨', '⭐',
    '🌟', '💫', '💥', '🔥', '🌈', '☀️', '🌤️', '⛅', '☁️', '🌧️',
    '⛈️', '🌩️', '❄️', '☃️', '💤', '✅', '❌', '❗', '❓', '⚠️',
    '🚫', '♾️', '💯', '🔔', '🔕', '🔇', '🔊', '📢', '📣', '💬',
    '💭', '🗯️', '♻️', '⚠️', '🚸', '🔆', '🔅', '⚡', '🎵', '🎶',
    '🔁', '🔂', '▶️', '⏸️', '⏹️', '⏺️', '⏭️', '⏮️', '⏩', '🔼',
    '🔽', '⬆️', '⬇️', '⬅️', '➡️', '↗️', '↘️', '↙️', '↖️', '↕️',
    '#️⃣', '*️⃣', '0️⃣', '1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣',
    '8️⃣', '9️⃣', '🔟', '🔴', '🟠', '🟡', '🟢', '🔵', '🟣', '⚫',
    '⚪', '🟤', '🔺', '🔻', '🔸', '🔹', '🔶', '🔷', '🔳', '🔲',
  ],
  bandeiras: ['🇧🇷', '🇵🇹', '🇺🇸', '🇬🇧', '🇫🇷', '🇩🇪', '🇪🇸', '🇮🇹', '🇯🇵', '🇰🇷',
    '🇨🇳', '🇷🇺', '🇮🇳', '🇨🇦', '🇦🇺', '🇲🇽', '🇦🇷', '🇨🇱', '🇵🇪', '🇨🇴'],
};

const RECENT_KEY = 'pulse_emoji_recentes';
const MAX_RECENT = 40;

function loadRecent() {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.filter((e) => typeof e === 'string').slice(0, MAX_RECENT) : [];
  } catch {
    return [];
  }
}

function saveRecent(list) {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, MAX_RECENT))); } catch { /* quota */ }
}

export function addRecent(emoji) {
  const list = loadRecent().filter((e) => e !== emoji);
  list.unshift(emoji);
  saveRecent(list);
  emoji?.dispatchEvent?.(new CustomEvent('emoji:recent', { bubbles: true, detail: emoji }));
}

/**
 * Insere um emoji no campo de texto em uma unica acao.
 * @param {HTMLTextAreaElement|HTMLInputElement} field
 */
export function insertEmoji(field, emoji) {
  if (!field || !emoji) return;
  const start = field.selectionStart ?? field.value.length;
  const end = field.selectionEnd ?? field.value.length;
  const before = field.value.slice(0, start);
  const after = field.value.slice(end);
  const needsSpaceBefore = before.length > 0 && !/\s$/.test(before);
  const payload = `${needsSpaceBefore ? ' ' : ''}${emoji}`;
  field.value = `${before}${payload}${after}`;
  const caret = start + payload.length;
  field.setSelectionRange(caret, caret);
  field.dispatchEvent(new Event('input', { bubbles: true }));
  addRecent(emoji);
}

/**
 * Monta o painel de emojis.
 * @param {HTMLTextAreaElement} field campo alvo
 * @param {object} options
 * @returns {{element: HTMLElement, destroy: () => void}}
 */
export function createEmojiPanel(field, { onPick = null, columns = 8 } = {}) {
  const state = { category: 'recentes', query: '' };
  let destroyed = false;

  const grid = document.createElement('div');
  grid.className = 'picker-grid';
  grid.setAttribute('role', 'listbox');
  grid.setAttribute('aria-label', 'Emojis');

  const tabs = document.createElement('div');
  tabs.className = 'picker-tabs';
  tabs.setAttribute('role', 'tablist');

  const panel = document.createElement('div');
  panel.className = 'picker-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Seletor de emojis');

  let activeTab = null;

  const renderGrid = () => {
    grid.replaceChildren();
    let list;
    if (state.query.trim()) {
      const needle = state.query.trim().toLowerCase();
      list = [...new Set(Object.values(EMOJI).flat())].filter((e) => e.includes(needle)).slice(0, 120);
      if (!list.length) {
        grid.append(Object.assign(document.createElement('div'), {
          className: 'picker-note', textContent: `Nenhum emoji para "${state.query}"`,
        }));
        return;
      }
    } else if (state.category === 'recentes') {
      list = loadRecent();
      if (!list.length) list = EMOJI.rostos.slice(0, 40);
    } else {
      list = EMOJI[state.category] || [];
    }

    for (const emoji of list) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = emoji;
      button.title = emoji;
      button.setAttribute('aria-label', `Emoji ${emoji}`);
      button.setAttribute('role', 'option');
      // Um unico listener: click. Nada de touch/pointer duplicado.
      button.addEventListener('click', () => {
        if (destroyed) return;
        insertEmoji(field, emoji);
        onPick?.(emoji);
      });
      grid.append(button);
    }
  };

  const renderTabs = () => {
    tabs.replaceChildren();
    for (const category of CATEGORIES) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = category.label;
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', String(state.category === category.id));
      button.addEventListener('click', () => {
        state.category = category.id;
        state.query = '';
        if (searchInput) searchInput.value = '';
        for (const other of tabs.children) other.setAttribute('aria-selected', 'false');
        button.setAttribute('aria-selected', 'true');
        activeTab = button;
        renderGrid();
      });
      tabs.append(button);
      if (state.category === category.id) activeTab = button;
    }
  };

  const searchInput = document.createElement('input');
  searchInput.className = 'input';
  searchInput.type = 'search';
  searchInput.placeholder = 'Buscar emoji';
  searchInput.setAttribute('aria-label', 'Buscar emoji');
  searchInput.addEventListener('input', () => {
    state.query = searchInput.value;
    renderGrid();
  });

  const searchWrap = document.createElement('div');
  searchWrap.className = 'picker-search';
  searchWrap.append(searchInput);

  panel.append(tabs, searchWrap, grid);
  renderTabs();
  renderGrid();

  return {
    element: panel,
    destroy() {
      destroyed = true;
      panel.remove();
      panel.replaceChildren();
    },
  };
}

/**
 * Ancora um painel flutuante dentro da viewport.
 *
 * Sem isto o painel abre `position:absolute; bottom:100%` acima do campo e,
 * dentro de containers baixos (a folha de comentarios, o rodape do chat),
 * sai pela TOPO da tela - fica invisivel e impossivel de usar.
 *
 * Regras:
 *  - `position: fixed` (independe do ancestral com overflow/transform)
 *  - abre ACIMA da ancora quando ha espaco; caso contrario, abaixo
 *  - `max-height` = espaco disponivel de verdade
 *  - clamp horizontal com margem de 8px
 *  - reposiciona em resize/orientationchange/scroll
 *
 * @returns {() => void} funcao de limpeza
 */
export function anchorToViewport(panel, anchor) {
  // Reentrancia: `reposition` escreve no `max-height` do painel, o que muda o
  // tamanho dele e dispara o ResizeObserver DE NOVO. Sem esta trava o
  // feedback loop estourava a pilha ("Maximum call stack size exceeded") e o
  // `unanchor` launched ao fechar o seletor de GIF falhava - o que impedia o
  // envio do GIF escolhido. Alem disso so escrevemos estilo quando o valor
  // muda, para o ciclo parar de verdade.
  let running = false;
  let scheduled = 0;

  /** Escreve no estilo apenas quando o valor e diferente. */
  const setStyle = (prop, value) => {
    if (panel.style[prop] !== value) panel.style[prop] = value;
  };

  /**
   * Area visivel REAL. `innerHeight` nao encolhe quando o teclado virtual abre,
   * entao um painel ancorado perto do rodape ficava escondido atras dele.
   * `visualViewport` e quem sabe quanto da tela sobrou de verdade.
   */
  const areaVisivel = () => {
    const vv = window.visualViewport;
    if (!vv) return { width: innerWidth, height: innerHeight, top: 0 };
    return {
      width: Math.round(vv.width),
      height: Math.round(vv.height),
      // `offsetTop` > 0 quando a pagina esta rolada; o painel e `position:fixed`
      // e precisa da mesma correcao.
      top: Math.round(vv.offsetTop || 0),
    };
  };

  const reposition = () => {
    if (running) return;
    if (!panel.isConnected || !anchor.isConnected) return;
    running = true;
    try {
      const margin = 8;
      const gap = 8;
      const view = areaVisivel();
      const anchorRect = anchor.getBoundingClientRect();

      setStyle('position', 'fixed');
      setStyle('margin', '0');
      setStyle('z-index', '999');
      // O teto do CSS e declarado em `--picker-teto` (custom property), e nao
      // lido da altura renderizada: medir a altura com a grade ainda vazia
      // devolvia 179px e,ao escrever isso inline, o painel ficava PRESO
      // naquele tamanho (o ResizeObserver nunca mais disparava, porque o
      // proprio max-height impedia o crescimento).
      setStyle('max-height', '');

      const natural = panel.getBoundingClientRect();
      const width = Math.min(natural.width, view.width - margin * 2);
      setStyle('width', `${Math.round(width)}px`);

      // O rodape da area visivel (teclado virtual conta) e o limite real.
      const viewBottom = view.top + view.height;
      const spaceAbove = Math.max(0, anchorRect.top - gap - margin);
      const spaceBelow = Math.max(0, viewBottom - anchorRect.bottom - gap - margin);
      // Item 5/9: o painel nao pode ocupar a tela inteira. `teto` e uma fracao
      // da altura VISIVEL - 55% em qualquer tamanho - de modo que a conversa
      // continua aparecendo em volta. O teto do CSS (`--picker-teto`) e
      // deliberadamente MAIOR que este: assim o valor em JS e sempre o que
      // vale, e o CSS so entra como reserva se o JS nao rodar.
      const teto = Math.round(view.height * 0.55);
      const bruto = Math.max(160, openAboveSegue(spaceAbove, spaceBelow));
      const available = Math.max(160, Math.min(bruto, teto));
      setStyle('max-height', `${Math.floor(available)}px`);

      // Medida DEPOIS do clamp: e' a altura real que precisa caber na viewport.
      const height = Math.min(panel.getBoundingClientRect().height, available);
      const left = Math.min(
        Math.max(margin, anchorRect.left + anchorRect.width / 2 - width / 2),
        Math.max(margin, view.width - margin - width),
      );
      // Abre acima quando cabe o suficiente; se nao couber em nenhum lado, abre
      // do lado com mais espaco (o grid rola internamente).
      const openAbove = spaceAbove >= 200 || spaceAbove >= spaceBelow;
      const top = openAbove
        ? Math.max(margin + view.top, anchorRect.top - gap - height)
        : Math.min(Math.max(margin + view.top, viewBottom - margin - height), anchorRect.bottom + gap);

      setStyle('left', `${Math.round(left)}px`);
      setStyle('top', `${Math.round(top)}px`);
    } finally {
      running = false;
    }
  };

  /** Decide o lado com mais espaco util (repetido aqui para nao duplicar regra). */
  const openAboveSegue = (spaceAbove, spaceBelow) => (
    spaceAbove >= 200 || spaceAbove >= spaceBelow ? spaceAbove : spaceBelow
  );

  /** Coalesce varias chamadas (scroll/resize/observer) em um unico quadro. */
  const schedule = () => {
    if (scheduled) return;
    scheduled = requestAnimationFrame(() => { scheduled = 0; reposition(); });
  };

  reposition();
  const raf = requestAnimationFrame(reposition);
  const onChange = () => schedule();
  addEventListener('resize', onChange, { passive: true });
  addEventListener('orientationchange', onChange, { passive: true });
  addEventListener('scroll', onChange, { passive: true, capture: true });
  // Teclado virtual: `resize` sozinho nao dispara de forma confiavel em
  // Android/iOS; e o `visualViewport` que avisa que a area util mudou.
  const vv = window.visualViewport;
  if (vv) {
    vv.addEventListener('resize', onChange, { passive: true });
    vv.addEventListener('scroll', onChange, { passive: true });
  }
  // O painel muda de tamanho quando o usuario troca de aba ou filtra a busca:
  // sem observar, ele cresce DEPOIS do posicionamento e invade a viewport.
  // Observa SO o painel (a ancora nao muda de tamanho) e agenda em um frame.
  const observer = typeof ResizeObserver === 'function'
    ? new ResizeObserver(() => schedule())
    : null;
  observer?.observe(panel);

  return () => {
    cancelAnimationFrame(raf);
    cancelAnimationFrame(scheduled);
    scheduled = 0;
    observer?.disconnect();
    removeEventListener('resize', onChange);
    removeEventListener('orientationchange', onChange);
    removeEventListener('scroll', onChange, true);
    if (vv) {
      vv.removeEventListener('resize', onChange);
      vv.removeEventListener('scroll', onChange);
    }
  };
}

/** Emoji aleatorio de reacao (usado nas reacoes rapidas). */
export const QUICK_REACTIONS = ['❤️', '😂', '😮', '😢', '👍', '🔥', '👏', '🎉', '😍', '🤯', '😡', '🙏'];

export function emojiCategories() {
  return CATEGORIES.map((c) => ({ ...c, count: (EMOJI[c.id] || []).length }));
}
