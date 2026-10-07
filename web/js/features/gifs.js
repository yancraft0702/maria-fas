/**
 * Painel de GIFs e stickers (GIPHY via backend).
 * A chave da API existe somente no servidor: este modulo nunca a ve.
 * Sem GIPHY_API_KEY configurado, o backend responde 503 e a UI explica o
 * requisito em vez de fingir conteudo.
 */
import { api, ApiError } from '../core/api.js';
import { el, icon, debounce } from '../core/dom.js';

let configured = null;
let recentKeys = JSON.parse(localStorage.getItem('pulse_gif_recentes') || '[]');

export function saveRecent(item) {
  if (!item?.id) return;
  recentKeys = [item, ...recentKeys.filter((r) => r.id !== item.id)].slice(0, 24);
  localStorage.setItem('pulse_gif_recentes', JSON.stringify(recentKeys));
}

export function recentGifs() {
  return recentKeys;
}

export async function checkProvider() {
  if (configured !== null) return configured;
  try {
    const status = await api.get('/api/giphy/status');
    configured = Boolean(status.configured);
  } catch {
    configured = false;
  }
  return configured;
}

/**
 * Cria o painel de GIF/sticker.
 * @param {object} options
 * @param {(item: object) => void} options.onPick
 */
export function createGifPanel({ onPick, kind = 'gifs', title = 'GIFs' } = {}) {
  const state = { kind, query: '', offset: 0, loading: false, done: false };
  let destroyed = false;
  let requestSeq = 0;

  const grid = el('div', { class: 'picker-grid', role: 'listbox', 'aria-label': title });
  const note = el('div', { class: 'picker-note', hidden: true });
  const tabs = el('div', { class: 'picker-tabs', role: 'tablist' });
  const searchWrap = el('div', { class: 'picker-search' });
  const panel = el('div', { class: 'picker-panel', role: 'dialog', 'aria-label': title });

  const searchInput = el('input', {
    class: 'input', type: 'search', placeholder: `Buscar ${title.toLowerCase()}`,
    'aria-label': `Buscar ${title.toLowerCase()}`,
  });
  searchWrap.append(searchInput);

  // `replaceChildren()` DEPOIS de `textContent` apagava a propria mensagem:
  // o painel ficava com uma grade VAZIA e sem nenhuma explicacao quando o
  // GIPHY recusava (429/503). O texto agora entra como no proprio.
  const setNote = (text, tone = 'info') => {
    if (!text) { note.hidden = true; note.replaceChildren(); return; }
    note.hidden = false;
    note.className = `picker-note ${tone}`;
    note.replaceChildren();
    if (tone !== 'plain') note.append(icon('warning'));
    note.append(el('span', { text }));
  };

  /**
   * Card de um GIF/sticker (itens 17/18).
   *
   * A imagem e o conteudo. Se ela falhar, o card vira um fallback compacto
   * - nunca texto gigante, nunca espaco vazio.
   */
  const renderGrid = (items) => {
    grid.replaceChildren();
    for (const item of items) {
      const img = el('img', {
        src: item.previewUrl || item.url,
        alt: item.title || 'GIF',
        loading: 'lazy',
        decoding: 'async',
        onError: (event) => {
          const alvo = event.currentTarget;
          const card = alvo.closest('.picker-cell');
          if (card) card.classList.add('is-broken');
          alvo.remove();
        },
      });
      const button = el('button', {
        type: 'button',
        class: 'picker-cell',
        role: 'option',
        'aria-label': item.title || (item.kind === 'sticker' ? 'Sticker' : 'GIF'),
        title: item.title || '',
        dataset: { kind: item.kind },
        onClick: () => {
          if (destroyed) return;
          saveRecent(item);
          onPick?.(item);
        },
      }, [img]);
      grid.append(button);
    }
  };

  const load = async ({ append = false } = {}) => {
    if (state.loading || destroyed) return;
    state.loading = true;
    const seq = ++requestSeq;
    grid.setAttribute('aria-busy', 'true');
    if (!append) {
      setNote('Carregando…');
      if (!state.query) {
        const cached = recentGifs().filter((r) => r.kind === state.kind);
        if (cached.length) { renderGrid(cached); setNote(''); }
      }
    }
    try {
      const path = state.query
        ? '/api/giphy/search'
        : '/api/giphy/trending';
      const params = {
        q: state.query || undefined,
        kind: state.kind,
        limit: 24,
        offset: append ? state.offset : 0,
        rating: 'pg',
        lang: 'pt',
      };
      const result = await api.get(path, { query: params });
      if (destroyed || seq !== requestSeq) return;
      const items = result.items || [];
      if (append) {
        renderGrid([...grid.children].length ? [] : []);
        // concatena mantendo os itens ja renderizados
        const merged = [...currentItems, ...items];
        currentItems = merged;
        renderGrid(merged);
      } else {
        currentItems = items;
        renderGrid(items);
      }
      setNote(items.length ? '' : 'Nada encontrado para essa busca.');
      state.offset += items.length;
      state.done = items.length < 24;
    } catch (err) {
      if (destroyed || seq !== requestSeq) return;
      if (err instanceof ApiError && err.code === 'giphy_rate_limited') {
        // Cota do GIPHY esgotada: e uma condicao TEMPORARIA e nao falta de
        // configuracao. Dizer "configure GIPHY_API_KEY" aqui mandava o
        // usuario mexer na chave sem resolver nada.
        currentItems = [];
        grid.replaceChildren();
        setNote('Limite do GIPHY atingido. Os GIFs voltam em instantes.', 'error');
        providerDown = true;
      } else if (err instanceof ApiError && (err.code === 'gif_provider_not_configured' || err.status === 503)) {
        currentItems = [];
        grid.replaceChildren();
        setNote('GIFs desativados: configure GIPHY_API_KEY no servidor para habilitar.', 'error');
        providerDown = true;
      } else if (err instanceof ApiError && err.code === 'giphy_unauthorized') {
        currentItems = [];
        grid.replaceChildren();
        setNote('Chave do GIPHY invalida ou expirada. Revise GIPHY_API_KEY no servidor.', 'error');
        providerDown = true;
      } else if (err instanceof ApiError && err.code === 'giphy_unreachable') {
        currentItems = [];
        grid.replaceChildren();
        setNote('Sem conexao com o GIPHY no momento. Tente de novo.', 'error');
        providerDown = true;
      } else {
        setNote(`Falha ao carregar GIFs: ${err.message}`, 'error');
      }
    } finally {
      state.loading = false;
      grid.removeAttribute('aria-busy');
    }
  };

  let currentItems = [];
  let providerDown = false;

  // abas GIF / Sticker
  for (const option of [
    { id: 'gifs', label: 'GIFs' },
    { id: 'stickers', label: 'Stickers' },
  ]) {
    const button = el('button', {
      type: 'button', role: 'tab',
      'aria-selected': String(state.kind === option.id),
      text: option.label,
      onClick: () => {
        if (state.kind === option.id) return;
        state.kind = option.id;
        currentItems = [];
        grid.replaceChildren();
        for (const other of tabs.children) other.setAttribute('aria-selected', 'false');
        button.setAttribute('aria-selected', 'true');
        searchInput.placeholder = `Buscar ${option.label.toLowerCase()}`;
        load();
      },
    });
    tabs.append(button);
  }

  const runSearch = debounce(() => load(), 350);
  searchInput.addEventListener('input', () => {
    state.query = searchInput.value.trim();
    runSearch();
  });

  panel.append(tabs, searchWrap, grid, note);

  // rolagem infinita
  const onScroll = () => {
    if (destroyed || state.done || providerDown) return;
    const nearBottom = grid.scrollHeight - grid.scrollTop - grid.clientHeight < 220;
    if (nearBottom) load({ append: true });
  };
  grid.addEventListener('scroll', onScroll);

  load();

  return {
    element: panel,
    destroy() {
      destroyed = true;
      requestSeq += 1;
      grid.removeEventListener('scroll', onScroll);
      panel.replaceChildren();
      panel.remove();
    },
  };
}

/** Busca por GIF dentro de um campo de texto (atalho @gif). */
export function createGifSearchBar({ onPick, placeholder = 'Buscar GIF' } = {}) {
  const input = el('input', { class: 'input', type: 'search', placeholder, 'aria-label': placeholder });
  const results = el('div', { class: 'picker-grid', style: { maxHeight: '260px', padding: '0' } });
  const note = el('div', { class: 'picker-note', hidden: true });
  const wrap = el('div', { class: 'picker-panel', role: 'dialog', 'aria-label': 'Buscar GIF' }, [
    el('div', { class: 'picker-search' }, [input]),
    results,
    note,
  ]);
  let destroyed = false;

  const run = debounce(async () => {
    const query = input.value.trim();
    if (destroyed) return;
    if (!query) { results.replaceChildren(); note.hidden = true; return; }
    note.hidden = false;
    note.textContent = 'Buscando…';
    try {
      const data = await api.get('/api/giphy/search', { query: { q: query, limit: 18 } });
      if (destroyed) return;
      results.replaceChildren();
      for (const item of data.items || []) {
        results.append(el('button', {
          type: 'button',
          'aria-label': item.title || 'GIF',
          onClick: () => { saveRecent(item); onPick?.(item); },
        }, [el('img', { src: item.previewUrl, alt: '', loading: 'lazy' })]));
      }
      note.hidden = (data.items || []).length > 0;
      note.textContent = 'Nenhum GIF encontrado.';
    } catch (err) {
      if (destroyed) return;
      results.replaceChildren();
      note.hidden = false;
      // Mesma distincao do painel: cota esgotada e problema temporario,
      // configuracao faltando e outra coisa. Uma mensagem so nao ajuda.
      note.textContent = err.code === 'gif_provider_not_configured'
        ? 'GIFs desativados: configure GIPHY_API_KEY no servidor.'
        : err.code === 'giphy_rate_limited'
          ? 'Limite do GIPHY atingido. Os GIFs voltam em instantes.'
          : `Falha na busca: ${err.message}`;
    }
  }, 350);

  input.addEventListener('input', run);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
    }
  });

  return {
    element: wrap,
    focus() { input.focus(); },
    destroy() { destroyed = true; wrap.replaceChildren(); wrap.remove(); },
  };
}
