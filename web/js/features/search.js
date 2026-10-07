/** Busca, Explorar, hashtags, sons e historico. */
import { api } from '../core/api.js';
import { el, icon, formatCount, debounce } from '../core/dom.js';
import { emptyState, toastError } from '../core/ui.js';
import { isLoggedIn } from '../core/store.js';
import { postTile } from './profile.js';
// --------------------------------------------------------------------------
// Busca
// --------------------------------------------------------------------------
export function createSearchScreen({ initialQuery = '' } = {}) {
  const page = el('div', { class: 'page' });
  const input = el('input', {
    class: 'input',
    type: 'search',
    placeholder: 'Pessoas, videos, hashtags, sons',
    value: initialQuery,
    'aria-label': 'Termo de busca',
  });
  const typeSeg = el('div', { class: 'seg mb' });
  const resultsHost = el('div');

  let type = 'all';
  let loading = false;
  let currentQuery = initialQuery;

  const renderTypes = () => {
    typeSeg.replaceChildren();
    for (const [id, label] of [['all', 'Tudo'], ['people', 'Pessoas'], ['posts', 'Videos'], ['hashtags', 'Hashtags'], ['sounds', 'Sons']]) {
      typeSeg.append(el('button', {
        type: 'button', role: 'tab', text: label,
        'aria-selected': String(type === id),
        onClick: () => { type = id; renderTypes(); run(); },
      }));
    }
  };

  const run = async () => {
    currentQuery = input.value.trim();
    if (currentQuery.length < 1) {
      resultsHost.replaceChildren(emptyState({
        iconName: 'search',
        title: 'O que voce procura?',
        message: 'Busque por @username, #hashtag, nome de som ou palavras da legenda.',
      }));
      return;
    }
    if (loading) return;
    loading = true;
    resultsHost.replaceChildren(el('div', { class: 'page-empty' }, [
      el('div', { class: 'spinner', style: { margin: '0 auto' } }),
    ]));
    try {
      const data = await api.get('/api/search', { query: { q: currentQuery, types: type, limit: 30 } });
      renderResults(data);
    } catch (err) {
      resultsHost.replaceChildren(emptyState({ iconName: 'warning', title: 'Falha na busca', message: err.message }));
    } finally {
      loading = false;
    }
  };

  const renderResults = (data) => {
    resultsHost.replaceChildren();
    const hasAny = (data.people?.length || 0) + (data.posts?.length || 0) + (data.hashtags?.length || 0) + (data.sounds?.length || 0);
    if (!hasAny) {
      resultsHost.append(emptyState({
        iconName: 'search',
        title: 'Nenhum resultado',
        message: `Nada encontrado para "${data.query}".`,
      }));
      return;
    }

    if (data.people?.length) {
      resultsHost.append(section('Pessoas', data.people.map((user) => el('a', { class: 'list-item', href: `/@${user.username}`, 'data-link': true }, [
        el('div', { class: 'avatar' }, [user.avatarUrl ? el('img', { src: user.avatarUrl, alt: '', loading: 'lazy' }) : el('div', { class: 'avatar' })]),
        el('div', { class: 'grow' }, [
          el('div', { class: 'strong truncate', text: user.displayName }),
          el('div', { class: 'small faint', text: `@${user.username} · ${formatCount(user.followerCount ?? 0)} seguidores` }),
        ]),
      ]))));
    }

    if (data.posts?.length) {
      resultsHost.append(section('Videos', el('div', { class: 'grid' }, data.posts.map((post) => postTile(post)))));
    }

    if (data.hashtags?.length) {
      resultsHost.append(section('Hashtags', el('div', { class: 'row row-wrap' }, data.hashtags.map((tag) => el('a', {
        class: 'btn btn-sm btn-ghost', href: `/tag/${encodeURIComponent(tag.tag.replace('#', ''))}`, 'data-link': true,
        text: `${tag.tag} · ${formatCount(tag.useCount)}`,
      })))));
    }

    if (data.sounds?.length) {
      resultsHost.append(section('Sons', el('div', { class: 'list' }, data.sounds.map((sound) => el('a', {
        class: 'list-item', href: `/som/${sound.id}`, 'data-link': true,
      }, [
        el('div', { class: 'avatar' }, [icon('music')]),
        el('div', { class: 'grow' }, [
          el('div', { class: 'strong truncate', text: sound.title }),
          el('div', { class: 'small faint', text: `${sound.artist || 'Original'} · ${formatCount(sound.useCount)} usos` }),
        ]),
      ])))));
    }
  };

  const section = (title, content) => el('section', { class: 'mb' }, [
    el('h2', { style: { fontSize: '15px', margin: '12px 0 8px' }, text: title }),
    content,
  ]);

  const debouncedRun = debounce(run, 320);
  input.addEventListener('input', debouncedRun);
  input.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); run(); } });

  renderTypes();
  page.append(
    el('h1', { class: 'page-title', text: 'Buscar' }),
    el('div', { class: 'field' }, [el('label', { class: 'sr-only', for: 'search-page-input', text: 'Busca' }), input]),
    typeSeg,
    resultsHost,
  );

  return {
    element: page,
    async load() {
      if (currentQuery) await run();
      else {
        resultsHost.replaceChildren(emptyState({
          iconName: 'search',
          title: 'O que voce procura?',
          message: 'Busque por @username, #hashtag, nome de som ou palavras da legenda.',
        }));
      }
      setTimeout(() => input.focus(), 60);
    },
    destroy() {
      debouncedRun.cancel?.();
      page.replaceChildren();
      page.remove();
    },
  };
}

// --------------------------------------------------------------------------
// Explorar
// --------------------------------------------------------------------------
export function createExploreScreen() {
  const page = el('div', { class: 'page' });
  const host = el('div');

  const render = (data) => {
    host.replaceChildren();
    host.append(el('h1', { class: 'page-title', text: 'Explorar' }));
    host.append(el('p', { class: 'page-sub', text: 'Hashtags e sons em alta, e os videos mais-engajados.' }));

    if (data.hashtags?.length) {
      host.append(el('h2', { style: { fontSize: '15px', margin: '16px 0 8px' }, text: 'Hashtags em alta' }));
      host.append(el('div', { class: 'row row-wrap' }, data.hashtags.map((tag) => el('a', {
        class: 'btn btn-sm btn-ghost',
        href: `/tag/${encodeURIComponent(tag.tag.replace('#', ''))}`,
        'data-link': true,
        text: `${tag.tag} · ${formatCount(tag.useCount)}`,
      }))));
    }

    if (data.sounds?.length) {
      host.append(el('h2', { style: { fontSize: '15px', margin: '16px 0 8px' }, text: 'Sons populares' }));
      host.append(el('div', { class: 'list' }, data.sounds.map((sound) => el('a', {
        class: 'list-item', href: `/som/${sound.id}`, 'data-link': true,
      }, [
        el('div', { class: 'avatar' }, [icon('music')]),
        el('div', { class: 'grow' }, [
          el('div', { class: 'strong truncate', text: sound.title }),
          el('div', { class: 'small faint', text: `${sound.artist || 'Original'} · ${formatCount(sound.useCount)} videos` }),
        ]),
      ]))));
    }

    if (data.posts?.length) {
      host.append(el('h2', { style: { fontSize: '15px', margin: '16px 0 8px' }, text: 'Videos em alta' }));
      host.append(el('div', { class: 'grid' }, data.posts.map((post) => postTile(post))));
    }
  };

  // `host` fica dentro de `page`; `page` e o elemento que o router monta.
  // (Era `page.append(host) && page`: `append()` retorna `undefined`, entao o
  // router montava `undefined` e a tela de busca/exploracao ficava vazia.)
  page.append(host);

  return {
    element: page,
    async load() {
      host.replaceChildren(el('div', { class: 'page-empty' }, [el('div', { class: 'spinner', style: { margin: '0 auto' } })]));
      try {
        render(await api.get('/api/explore'));
      } catch (err) {
        host.replaceChildren(emptyState({ iconName: 'warning', title: 'Falha ao carregar', message: err.message }));
      }
    },
    destroy() {
      page.replaceChildren();
      page.remove();
    },
  };
}

// --------------------------------------------------------------------------
// Hashtag
// --------------------------------------------------------------------------
export function createHashtagScreen({ tag }) {
  const page = el('div', { class: 'page' });
  let order = 'top';

  const render = (data) => {
    page.replaceChildren(
      el('h1', { class: 'page-title', text: data.hashtag.tag }),
      el('p', { class: 'page-sub', text: `${formatCount(data.hashtag.useCount)} videos · ${formatCount(data.hashtag.viewCount)} visualizacoes da pagina` }),
      el('div', { class: 'seg mb' }, [
        el('button', { type: 'button', text: 'Populares', 'aria-selected': String(order === 'top'), onClick: () => { order = 'top'; load(); } }),
        el('button', { type: 'button', text: 'Recentes', 'aria-selected': String(order === 'recent'), onClick: () => { order = 'recent'; load(); } }),
      ]),
      data.posts.length
        ? el('div', { class: 'grid' }, data.posts.map((post) => postTile(post)))
        : emptyState({ iconName: 'hash', title: 'Nenhum video com esta hashtag', message: 'Seja o primeiro a postar.' }),
    );
  };

  const load = async () => {
    page.replaceChildren(el('div', { class: 'page-empty' }, [el('div', { class: 'spinner', style: { margin: '0 auto' } })]));
    try {
      render(await api.get(`/api/hashtags/${encodeURIComponent(tag)}`, { query: { order, limit: 36 } }));
    } catch (err) {
      page.replaceChildren(emptyState({ iconName: 'hash', title: 'Hashtag nao encontrada', message: err.message }));
    }
  };

  return {
    element: page,
    async load() { await load(); },
    destroy() {
      page.replaceChildren();
      page.remove();
    },
  };
}

// --------------------------------------------------------------------------
// Som
// --------------------------------------------------------------------------
export function createSoundScreen({ soundId }) {
  const page = el('div', { class: 'page' });

  const load = async () => {
    page.replaceChildren(el('div', { class: 'page-empty' }, [el('div', { class: 'spinner', style: { margin: '0 auto' } })]));
    try {
      const data = await api.get(`/api/sounds/${soundId}`, { query: { limit: 36 } });
      const sound = data.sound;
      const saveBtn = el('button', {
        type: 'button',
        class: `btn ${sound.saved ? 'btn-ghost' : 'btn-primary'}`,
        text: sound.saved ? 'Salvo' : 'Salvar som',
        onClick: async () => {
          try {
            const result = sound.saved
              ? await api.delete(`/api/sounds/${sound.id}/save`)
              : await api.post(`/api/sounds/${sound.id}/save`, {});
            sound.saved = result.saved;
            saveBtn.textContent = sound.saved ? 'Salvo' : 'Salvar som';
            saveBtn.classList.toggle('btn-primary', !sound.saved);
            saveBtn.classList.toggle('btn-ghost', sound.saved);
          } catch (err) { toastError(err); }
        },
      });

      page.replaceChildren(
        el('div', { class: 'card' }, [
          el('div', { class: 'row' }, [
            el('div', { class: 'avatar' }, [icon('music')]),
            el('div', { class: 'grow' }, [
              el('h1', { class: 'page-title', style: { margin: '0' }, text: sound.title }),
              el('p', { class: 'page-sub', style: { margin: '2px 0 0' }, text: `${sound.artist || 'Original'} · ${formatCount(sound.useCount)} videos` }),
            ]),
            isLoggedIn() ? saveBtn : null,
          ]),
          sound.url
            ? el('audio', { src: sound.url, controls: true, preload: 'none', style: { width: '100%', marginTop: '10px' }, 'aria-label': `Ouvir ${sound.title}` })
            : el('p', { class: 'tiny faint', text: 'Este som ainda nao tem arquivo.' }),
          sound.isOriginal ? el('p', { class: 'tiny faint', text: 'Som original da plataforma.' }) : null,
        ]),
        el('h2', { style: { fontSize: '15px', margin: '16px 0 8px' }, text: 'Videos com este som' }),
        data.posts.length
          ? el('div', { class: 'grid' }, data.posts.map((post) => postTile(post)))
          : emptyState({ iconName: 'music', title: 'Nenhum video com este som ainda' }),
      );
    } catch (err) {
      page.replaceChildren(emptyState({ iconName: 'music', title: 'Som nao encontrado', message: err.message }));
    }
  };

  return {
    element: page,
    async load() { await load(); },
    destroy() {
      page.replaceChildren();
      page.remove();
    },
  };
}

// --------------------------------------------------------------------------
// Historico
// --------------------------------------------------------------------------
export function createHistoryScreen() {
  const page = el('div', { class: 'page' });

  const load = async () => {
    page.replaceChildren(el('h1', { class: 'page-title', text: 'Historico' }));
    try {
      const [history, favorites, recommendations] = await Promise.all([
        api.get('/api/users/me/history', { query: { limit: 40 } }),
        api.get('/api/users/me/favorites', { query: { limit: 40 } }),
        api.get('/api/me/recommendations'),
      ]);
      page.append(
        el('p', { class: 'page-sub', text: 'Videos que voce assistiu e salvou.' }),
        el('div', { class: 'card mb' }, [
          el('div', { class: 'row' }, [
            el('div', { class: 'grow' }, [
              el('div', { class: 'strong', text: 'Recomendacoes personalizadas' }),
              el('div', { class: 'small faint', text: recommendations.recommendation.optOut ? 'Desativadas nas configuracoes' : 'Ativas' }),
            ]),
            el('button', {
              type: 'button', class: 'btn btn-sm btn-ghost', text: 'Redefinir',
              onClick: async () => {
                try {
                  await api.post('/api/me/recommendations/reset', {});
                  toastError(new Error('Recomendacoes redefinidas. Recarregue a pagina.'));
                  location.reload();
                } catch (err) { toastError(err); }
              },
            }),
          ]),
        ]),
        el('h2', { style: { fontSize: '15px', margin: '8px 0' }, text: `Historico (${history.posts.length})` }),
        history.posts.length
          ? el('div', { class: 'grid' }, history.posts.map((post) => postTile(post)))
          : emptyState({ iconName: 'clock', title: 'Historico vazio' }),
        el('h2', { style: { fontSize: '15px', margin: '16px 0 8px' }, text: `Favoritos (${favorites.posts.length})` }),
        favorites.posts.length
          ? el('div', { class: 'grid' }, favorites.posts.map((post) => postTile(post)))
          : emptyState({ iconName: 'bookmark', title: 'Nenhum favorito ainda' }),
      );
    } catch (err) {
      page.replaceChildren(emptyState({ iconName: 'warning', title: 'Falha ao carregar', message: err.message }));
    }
  };

  return {
    element: page,
    async load() { await load(); },
    destroy() {
      page.replaceChildren();
      page.remove();
    },
  };
}
