/** Perfil: capa, foto, contadores, abas, videos, likes, reposts, favoritos, playlists, story e LIVE. */
import { api } from '../core/api.js';
import { el, icon, formatCount, formatTime, linkifyText } from '../core/dom.js';
import { openModal, toastError, toastSuccess, confirmDialog, openMenu, emptyState } from '../core/ui.js';
import { store, isLoggedIn } from '../core/store.js';
import { navigate } from '../core/router.js';
import { realtime } from '../core/realtime.js';
import { uploadAvatar, uploadCover, updateProfile, changeUsername } from './auth.js';
import { openReportDialog } from './report.js';
import { recordWatch } from './analytics.js';

export async function fetchUser(idOrUsername) {
  return api.get(`/api/users/${encodeURIComponent(idOrUsername)}`);
}

export async function setAvatar(file, onProgress) {
  return uploadAvatar(file, onProgress);
}

/**
 * Reflete a nova foto/capa na tela sem recarregar a pagina.
 * O upload ja devolve o usuario atualizado e o `setUser` cuida do estado
 * global; aqui so sincroniza o objeto usado por esta tela.
 * Usa o mesmo storage do resto do produto (/api/users/me/avatar|cover).
 */
function applyImageLocally(currentUser, updated) {
  if (!currentUser || !updated) return;
  currentUser.avatarUrl = updated.avatarUrl;
  currentUser.avatarVersion = updated.avatarVersion;
  currentUser.coverUrl = updated.coverUrl;
}

/** Escolhe um arquivo de imagem e envia (reusa o seletor do projeto). */
function pickAndUpload(kind, currentUser, after) {
  pickImage(async (file) => {
    try {
      const updated = kind === 'avatar' ? await setAvatar(file, null) : await setCover(file, null);
      applyImageLocally(currentUser, updated);
      after();
      toastSuccess(kind === 'avatar' ? 'Foto de perfil atualizada' : 'Capa atualizada');
    } catch (err) {
      toastError(err);
    }
  });
}

export async function setCover(file, onProgress) {
  return uploadCover(file, onProgress);
}

export function createProfilePage({ idOrUsername }) {
  const state = { user: null, data: null, tab: 'videos', cleanups: [], loading: false };

  // `data-username` identifica QUAL perfil esta na tela. Sem ele nao havia como
  // confirmar, pelo DOM, que a navegacao foi para o perfil certo (e nao para
  // outra tela que so contenha o mesmo texto).
  const page = el('div', { class: 'page', dataset: { username: '' } });
  const tabsHost = el('div', { class: 'profile-tabs', role: 'tablist' });
  const contentHost = el('div');

  const render = () => {
    const { user, data } = state;
    if (!user) return;
    const relation = data.relation || {};
    const isSelf = relation.isSelf || (isLoggedIn() && store.user.id === user.id);
    const counts = data.counts || {};

    page.replaceChildren();

    // ---- capa ----
    const cover = el('div', {
      class: 'profile-cover',
      style: data.coverUrl ? { backgroundImage: `url("${data.coverUrl}")` } : {},
      role: 'img',
      'aria-label': `Capa de @${user.username}`,
    });
    if (isSelf) {
      cover.append(el('button', {
        type: 'button', class: 'btn btn-sm btn-ghost profile-cover-edit',
        text: 'Alterar capa',
        onClick: () => pickAndUpload('cover', user, reload),
      }));
    }

    // ---- cabecalho ----
    const actions = el('div', { class: 'profile-actions' });
    if (isSelf) {
      actions.append(el('button', {
        type: 'button', class: 'btn btn-ghost', text: 'Editar perfil', onClick: () => openEditProfile(),
      }));
      actions.append(el('button', {
        type: 'button', class: 'btn btn-ghost', 'aria-label': 'Mais opcoes',
        onClick: (event) => openSelfMenu(event),
      }, [icon('more')]));
    } else if (isLoggedIn()) {
      const followBtn = el('button', {
        type: 'button',
        class: `btn ${relation.isFollowing || relation.followStatus === 'accepted' ? 'btn-ghost' : 'btn-primary'}`,
        text: followLabel(relation),
        onClick: () => toggleFollow(followBtn, relation),
      });
      actions.append(followBtn);
      if (relation.followStatus === 'pending') {
        actions.append(el('button', {
          type: 'button', class: 'btn btn-ghost', text: 'Cancelar pedido',
          onClick: () => toggleFollow(followBtn, relation),
        }));
      }
      actions.append(el('button', {
        type: 'button', class: 'btn btn-ghost', 'aria-label': 'Mais opcoes',
        onClick: () => openUserMenu(user, relation),
      }, [icon('more')]));
      if (!relation.isBlocked) {
        actions.append(el('button', {
          type: 'button', class: 'btn btn-solid', text: 'Mensagem',
          onClick: async () => {
            try {
              const result = await api.post(`/api/users/${user.id}/message`, {});
              navigate(`/inbox/${result.conversationId}`);
            } catch (err) { toastError(err); }
          },
        }));
      }
    } else {
      actions.append(el('a', { href: '/entrar', class: 'btn btn-primary', 'data-link': true, text: 'Entrar para seguir' }));
    }

    const bioNode = el('div', { class: 'profile-bio' });
    if (data.bio) bioNode.append(linkifyText(data.bio, {
      onMention: (username) => navigate(`/@${username}`),
      onHashtag: (tag) => navigate(`/tag/${tag}`),
    }));
    if (data.website) {
      bioNode.append(el('a', {
        href: data.website, target: '_blank', rel: 'noopener noreferrer',
        class: 'row small', style: { marginTop: '6px' },
      }, [icon('link'), el('span', { text: data.website.replace(/^https?:\/\//, '') })]));
    }
    if (data.location) {
      bioNode.append(el('div', { class: 'row small muted', style: { marginTop: '4px' } }, [
        icon('location'), el('span', { text: data.location }),
      ]));
    }

    const liveBadge = data.live
      ? el('a', {
        href: `/live/${data.live.id}`, class: 'live-pill', 'data-link': true,
        style: { marginTop: '10px', display: 'inline-flex', color: '#fff' },
      }, [el('i', { style: { width: '8px', height: '8px', borderRadius: '50%', background: 'var(--danger)', display: 'inline-block' } }),
        el('span', { text: `AO VIVO - ${formatCount(data.live.viewerCount)} espectadores` })])
      : null;

    page.append(
      cover,
      el('div', { class: 'profile-head' }, [
        el('div', { class: 'profile-row' }, [
          el('div', { class: 'avatar lg' }, [
            user.avatarUrl
              ? el('img', { src: `${user.avatarUrl}`, alt: `Foto de @${user.username}`, key: user.avatarVersion })
              : el('div', { class: 'avatar lg' }),
            // Botao de trocar a foto de perfil (visivel so no proprio perfil).
            isSelf ? el('button', {
              type: 'button',
              class: 'profile-avatar-edit',
              'aria-label': 'Alterar foto de perfil',
              title: 'Alterar foto de perfil',
              onClick: () => pickAndUpload('avatar', user, reload),
            }, [icon('camera')]) : null,
          ]),
          actions,
        ]),
        el('h1', { class: 'profile-name' }, [
          el('span', { text: user.displayName }),
          // Item 20: o badge era um glifo de TEXTO com byte corrompido (aparecia
          // um caractere rosa quebrado ao lado do nome). Agora e um SVG do
          // catalogo de icones: sem mojibake e com a mesma fonte do resto.
          user.isVerified
            ? el('span', {
              class: 'profile-verified',
              'aria-label': 'Conta verificada',
              title: 'Conta verificada',
              role: 'img',
            }, [icon('check')])
            : null,
        ]),
        el('div', { class: 'profile-user', text: `@${user.username}` }),
        bioNode,
        liveBadge,
        el('div', { class: 'profile-stats' }, [
          stat(counts.followingCount, 'seguindo'),
          stat(counts.followerCount, 'seguidores'),
          stat(counts.likeCount, 'curtidas'),
          counts.friendCount ? stat(counts.friendCount, 'amigos') : null,
        ]),
        el('div', { class: 'row row-wrap small', style: { gap: '6px', marginTop: '4px' } }, [
          el('span', { class: 'faint', text: `Entrou ${formatTime(user.createdAt)}` }),
          user.role !== 'user' ? el('span', { class: 'status-tag status-active', text: user.role === 'admin' ? 'administrador' : 'moderacao' }) : null,
        ]),
        tabsHost,
      ]),
      contentHost,
    );

    renderTabs();
    renderTab();
  };

  const stat = (value, label) => el('a', {
    class: 'profile-stat',
    href: '#',
    onClick: (event) => {
      event.preventDefault();
      if (label === 'seguidores') { loadList('followers'); return; }
      if (label === 'seguindo') { loadList('following'); return; }
      if (label === 'amigos') { loadList('friends'); return; }
    },
  }, [el('b', { text: formatCount(value ?? 0) }), el('span', { text: ` ${label}` })]);

  const followLabel = (relation) => {
    if (relation.followStatus === 'pending') return 'Solicitado';
    if (relation.isFollowing) return 'Seguindo';
    if (relation.isFriend) return 'Amigos';
    return 'Seguir';
  };

  const toggleFollow = async (button, relation) => {
    try {
      const isFollowing = relation.followStatus === 'accepted';
      const result = isFollowing
        ? await api.delete(`/api/users/${state.user.id}/follow`)
        : await api.post(`/api/users/${state.user.id}/follow`, {});
      relation.followStatus = result.status;
      relation.isFollowing = result.status === 'accepted';
      relation.isFriend = Boolean(result.isFriend);
      button.textContent = followLabel(relation);
      button.classList.toggle('btn-primary', !relation.isFollowing);
      button.classList.toggle('btn-ghost', relation.isFollowing);
      recordWatch(state.data.posts?.[0]?.id || state.user.id, { followedAuthor: true, profileVisited: true });
      const counts = await api.get(`/api/users/${state.user.id}/relation`);
      state.data.counts = counts.counts;
      render();
    } catch (err) { toastError(err); }
  };

  /**
   * Abas do perfil (item 11).
   *
   * No perfil do proprio usuario a grade tem QUATRO opcoes - Videos, Curtidas,
   * Reposts e Privacidade - e todas cabem numa unica linha, sem carrossel e
   * sem `overflow-x`. Antes eram sete (Favoritos, Playlists e Rascunhos
   * incluidos) e no mobile era preciso arrastar a grade para chegar em
   * "Privacidade".
   *
   * As opcoes que sairam da grade NAO foram apagadas: Favoritos, Playlists e
   * Rascunhos continuam existindo e aparecem no menu do proprio perfil
   * (`openSelfMenu`), que e o lugar apropriado para opcoes de uso menos
   * frequente.
   */
  /**
   * Abas que continuam existindo mas nao ocupam a grade principal (item 11).
   * O conteudo (`renderTab`) e o mesmo de antes; so mudou o ponto de acesso.
   */
  const ABAS_FORA_DA_GRADE = [
    { id: 'favorites', label: 'Favoritos', icon: 'bookmark' },
    { id: 'collections', label: 'Playlists', icon: 'folder' },
    { id: 'drafts', label: 'Rascunhos', icon: 'edit' },
  ];

  const listaAbas = () => {
    const ehMeu = isLoggedIn() && store.user && store.user.id === state.user.id;
    const tabs = [
      { id: 'videos', label: 'Videos', icon: 'grid', count: state.data.counts?.postCount },
      { id: 'likes', label: 'Curtidas', icon: 'heart', count: state.data.counts?.likeCount },
      { id: 'reposts', label: 'Reposts', icon: 'replay', count: state.data.counts?.repostCount },
    ];
    if (ehMeu) tabs.push({ id: 'settings', label: 'Privacidade', icon: 'lock' });
    return tabs;
  };

  // Impressao digital do conjunto de abas. A grade so e remontada quando ela
  // MUDA - trocar de aba nao passa por `replaceChildren` (item 12, fluidez).
  let fingerprintGrade = null;

  const renderTabs = () => {
    const tabs = listaAbas();
    // Se a aba atual saiu da grade (ex.: o menu abriu "Rascunhos"), ela volta
    // a existir para o conteudo nao ficar sem aba selecionada.
    if (!tabs.some((t) => t.id === state.tab)) {
      const extra = ABAS_FORA_DA_GRADE.find((t) => t.id === state.tab);
      if (extra) tabs.push({ ...extra, count: undefined });
      else state.tab = 'videos';
    }

    const fp = tabs.map((t) => `${t.id}:${t.label}:${t.count ?? ''}`).join('|');
    if (fp === fingerprintGrade && tabsHost.children.length === tabs.length) {
      marcarAbaAtiva();
      return;
    }
    fingerprintGrade = fp;

    tabsHost.replaceChildren();
    // `flex: 1 1 0` + `min-width: 0`: as quatro dividem a largura disponivel
    // em partes iguais, entao cabem em 320px sem cortar rotulo.
    tabsHost.dataset.total = String(tabs.length);
    for (const tab of tabs) {
      tabsHost.append(el('button', {
        type: 'button', class: 'profile-tab', role: 'tab', dataset: { tab: tab.id },
        'aria-selected': String(state.tab === tab.id),
        onClick: () => selecionarAba(tab.id),
      }, [
        icon(tab.icon),
        // Rótulo e contador ficam na MESMA linha de texto: separados, o número
        // virava uma segunda linha da aba e a grade crescia de altura.
        el('span', { class: 'profile-tab-text' }, [
          el('span', { class: 'profile-tab-label', text: tab.label }),
          tab.count ? el('span', { class: 'profile-tab-count', text: formatCount(tab.count) }) : null,
        ]),
      ]));
    }
  };

  /** So o estado visual do botao muda; nenhum no e recriado. */
  const marcarAbaAtiva = () => {
    for (const botao of tabsHost.querySelectorAll('.profile-tab')) {
      botao.setAttribute('aria-selected', String(botao.dataset.tab === state.tab));
    }
  };

  /** Troca de aba sem remontar a grade nem reescrever os contadores. */
  const selecionarAba = (id) => {
    if (state.tab === id && contentHost.dataset.aba === id) return;
    state.tab = id;
    marcarAbaAtiva();
    renderTab();
  };

  const renderTab = async () => {
    // Aba pedida agora: se o usuario clicar em outra antes da resposta, a
    // resposta lenta e descartada em vez de sobrescrever a tela nova (era o
    // "conteudo pulando de posicao").
    const abaPedida = state.tab;
    if (contentHost.dataset.aba !== abaPedida) {
      contentHost.replaceChildren(el('div', { class: 'page-empty' }, [
        el('div', { class: 'spinner', style: { margin: '0 auto' } }),
      ]));
    }
    try {
      switch (state.tab) {
        case 'videos': return await renderVideos(abaPedida);
        case 'likes': return await renderList('/api/users/' + encodeURIComponent(state.user.username) + '/liked', 'Nenhuma curtida visivel.', abaPedida);
        case 'reposts': return await renderList(`/api/users/${state.user.id}/reposts`, 'Nenhum repost ainda.', abaPedida);
        case 'favorites': return await renderList('/api/me/favorites', 'Nenhum favorito ainda.', abaPedida);
        case 'collections': return await renderCollections(abaPedida);
        case 'drafts': return await renderDrafts(abaPedida);
        case 'settings': return await renderPrivacy(abaPedida);
        default: return await renderVideos(abaPedida);
      }
    } catch (err) {
      if (abaPedida !== state.tab) return undefined;
      contentHost.dataset.aba = abaPedida;
      contentHost.replaceChildren(emptyState({
        iconName: 'warning', title: 'Nao foi possivel carregar', message: err.message,
      }));
    }
    return undefined;
  };

  const renderVideos = async (abaPedida = state.tab) => {
    const data = await api.get(`/api/users/${encodeURIComponent(state.user.username)}/posts`, { query: { limit: 36 } });
    if (abaPedida !== state.tab) return;
    contentHost.dataset.aba = abaPedida;
    contentHost.replaceChildren();
    if (!data.posts?.length) {
      contentHost.append(emptyState({
        iconName: 'film',
        title: 'Nenhum video ainda',
        message: state.user.id === store.user?.id ? 'Publique seu primeiro video pelo botao +.' : 'Esta conta ainda nao publicou videos.',
      }));
      return;
    }
    const grid = el('div', { class: 'grid' });
    for (const post of data.posts) grid.append(postTile(post));
    contentHost.append(grid);
  };

  const renderList = async (path, emptyMessage, abaPedida = state.tab) => {
    const data = await api.get(path, { query: { limit: 36 } });
    if (abaPedida !== state.tab) return;
    contentHost.dataset.aba = abaPedida;
    contentHost.replaceChildren();
    if (!data.posts?.length) {
      contentHost.append(emptyState({ iconName: 'film', title: 'Nada por aqui', message: emptyMessage }));
      return;
    }
    const grid = el('div', { class: 'grid' });
    for (const post of data.posts) grid.append(postTile(post));
    contentHost.append(grid);
  };

  const renderCollections = async (abaPedida = state.tab) => {
    const data = await api.get('/api/me/collections');
    if (abaPedida !== state.tab) return;
    contentHost.dataset.aba = abaPedida;
    contentHost.replaceChildren();
    if (!data.collections?.length) {
      contentHost.append(emptyState({ iconName: 'folder', title: 'Sem playlists', message: 'Crie uma playlist para organizar seus favoritos.' }));
      contentHost.append(el('button', {
        type: 'button', class: 'btn btn-primary', text: 'Criar playlist',
        onClick: () => createCollection(),
      }));
      return;
    }
    const grid = el('div', { class: 'grid' });
    for (const collection of data.collections) {
      grid.append(el('a', {
        class: 'tile', href: '#', onClick: (event) => { event.preventDefault(); openCollection(collection); },
      }, [
        el('div', { class: 'tile-fallback', style: { display: 'flex', flexDirection: 'column', gap: '6px', justifyContent: 'center' } }, [
          icon('folder'),
          el('div', { class: 'strong truncate', text: collection.name }),
          el('div', { class: 'tiny faint', text: `${collection.itemCount} itens` }),
        ]),
      ]));
    }
    contentHost.append(grid, el('button', {
      type: 'button', class: 'btn btn-primary mt', text: 'Nova playlist', onClick: () => createCollection(),
    }));
  };

  const renderDrafts = async (abaPedida = state.tab) => {
    const data = await api.get('/api/drafts');
    if (abaPedida !== state.tab) return;
    contentHost.dataset.aba = abaPedida;
    contentHost.replaceChildren();
    if (!data.drafts?.length) {
      contentHost.append(emptyState({ iconName: 'edit', title: 'Sem rascunhos', message: 'Rascunhos sao privados e so aparecem aqui.' }));
      return;
    }
    const list = el('div', { class: 'list' });
    for (const draft of data.drafts) {
      list.append(el('div', { class: 'list-item' }, [
        el('div', { class: 'grow' }, [
          el('div', { class: 'truncate clamp-2', text: draft.payload?.caption || 'Video sem legenda' }),
          el('div', { class: 'tiny faint', text: `Editado ${formatTime(draft.updatedAt)}` }),
        ]),
        el('button', {
          type: 'button', class: 'btn btn-sm btn-solid', text: 'Publicar',
          onClick: async () => {
            try {
              const result = await api.post(`/api/drafts/${draft.id}/publish`, {});
              toastSuccess('Rascunho publicado');
              navigate(`/video/${result.post.id}`);
            } catch (err) { toastError(err); }
          },
        }),
        el('button', {
          type: 'button', class: 'btn btn-sm btn-ghost', 'aria-label': 'Excluir rascunho',
          onClick: async () => {
            try {
              await api.delete(`/api/drafts/${draft.id}`);
              toastSuccess('Rascunho excluido');
              renderDrafts();
            } catch (err) { toastError(err); }
          },
        }, [icon('trash')]),
      ]));
    }
    contentHost.append(list);
  };

  const renderPrivacy = async (abaPedida = state.tab) => {
    const { settings } = await api.get('/api/me/settings');
    if (abaPedida !== state.tab) return;
    const group = el('div', { class: 'setting-group' }, [
      el('h3', { text: 'Privacidade da conta' }),
    ]);
    const privacy = settings.privacy;
    for (const [key, label] of [
      ['accountPrivacy', 'Visibilidade da conta'],
      ['whoCanFollow', 'Quem pode te seguir'],
      ['whoCanComment', 'Quem pode comentar'],
      ['whoCanMessage', 'Quem pode enviar mensagem'],
      ['whoCanMention', 'Quem pode te mencionar'],
      ['whoCanTag', 'Quem pode te marcar'],
      ['whoCanSeeLikes', 'Quem pode ver suas curtidas'],
      ['whoCanSeeReposts', 'Quem pode ver seus reposts'],
      ['downloadAllowed', 'Quem pode baixar seus videos'],
      ['remixAllowed', 'Quem pode remixar seus videos'],
    ]) {
      const select = el('select', { class: 'select' });
      const options = key === 'accountPrivacy'
        ? [['public', 'Publica'], ['private', 'Privada']]
        : [['everyone', 'Todos'], ['followers', 'Quem te segue'], ['friends', 'Somente amigos'], ['nobody', 'Ninguem']];
      for (const [value, text] of options) select.append(el('option', { value, text }));
      select.value = privacy[key];
      select.addEventListener('change', async () => {
        try {
          await api.patch('/api/me/privacy', { [key]: select.value });
          toastSuccess('Privacidade atualizada');
        } catch (err) { toastError(err); }
      });
      group.append(el('div', { class: 'field' }, [el('label', { text: label }), select]));
    }
    const friendOnly = el('input', { type: 'checkbox', checked: privacy.friendOnly });
    friendOnly.addEventListener('change', async () => {
      try {
        await api.patch('/api/me/privacy', { friendOnly: friendOnly.checked });
        toastSuccess(friendOnly.checked ? 'Somente amigos podem ver seu conteudo' : 'Conteudo visivel publicamente');
      } catch (err) { toastError(err); }
    });
    group.append(el('div', { class: 'switch' }, [
      el('span', { text: 'Somente amigos podem ver meus conteudos (relacao mutua)' }),
      friendOnly,
    ]));
    contentHost.dataset.aba = abaPedida;
    contentHost.replaceChildren(group);
  };

  const createCollection = async () => {
    const name = el('input', { class: 'input', placeholder: 'Nome da playlist', maxlength: '60' });
    const privacy = el('select', { class: 'select' }, [
      el('option', { value: 'private', text: 'Privada' }),
      el('option', { value: 'public', text: 'Publica' }),
    ]);
    openModal({
      title: 'Nova playlist',
      body: el('div', {}, [
        el('div', { class: 'field' }, [el('label', { text: 'Nome' }), name]),
        el('div', { class: 'field' }, [el('label', { text: 'Visibilidade' }), privacy]),
      ]),
      actions: [
        { label: 'Cancelar', class: 'btn-ghost' },
        {
          label: 'Criar',
          class: 'btn-primary',
          onClick: async () => {
            if (!name.value.trim()) return false;
            try {
              await api.post('/api/collections', { name: name.value.trim(), privacy: privacy.value });
              toastSuccess('Playlist criada');
              renderCollections();
              return true;
            } catch (err) { toastError(err); return false; }
          },
        },
      ],
    });
  };

  const openCollection = async (collection) => {
    const detail = await api.get('/api/me/collections').catch(() => null);
    const found = detail?.collections?.find((c) => c.id === collection.id);
    if (!found) return;
    const grid = el('div', { class: 'grid' });
    for (const post of found.posts) grid.append(postTile(post));
    openModal({
      title: found.name,
      size: '600px',
      body: found.posts.length ? grid : el('p', { class: 'muted', text: 'Playlist vazia.' }),
    });
  };

  const loadList = async (kind) => {
    const data = await api.get(`/api/users/${state.user.id}/${kind}`, { query: { limit: 100 } });
    const list = el('div', { class: 'list' });
    for (const user of data.users || []) {
      list.append(el('a', { class: 'list-item', href: `/@${user.username}`, 'data-link': true }, [
        el('div', { class: 'avatar' }, [
          user.avatarUrl ? el('img', { src: user.avatarUrl, alt: '', loading: 'lazy' }) : el('div', { class: 'avatar' }),
        ]),
        el('div', { class: 'grow' }, [
          el('div', { class: 'strong truncate', text: user.displayName }),
          el('div', { class: 'small faint truncate', text: `@${user.username}` }),
        ]),
        user.isFriend ? el('span', { class: 'tiny faint', text: 'Amigos' }) : null,
        user.isFollowing ? el('span', { class: 'tiny faint', text: 'Seguindo' }) : null,
      ]));
    }
    openModal({
      title: kind === 'followers' ? 'Seguidores' : kind === 'following' ? 'Seguindo' : 'Amigos',
      size: '480px',
      body: (data.users || []).length ? list : el('p', { class: 'muted', text: 'Nenhum usuario ainda.' }),
    });
  };

  const openEditProfile = () => {
    const displayName = el('input', { class: 'input', value: state.user.displayName, maxlength: '60' });
    const username = el('input', { class: 'input', value: state.user.username, maxlength: '24' });
    const bio = el('textarea', { class: 'textarea', maxlength: '300' });
    bio.value = state.data.bio || '';
    const website = el('input', { class: 'input', value: state.data.website || '', maxlength: '200' });
    const location = el('input', { class: 'input', value: state.data.location || '', maxlength: '80' });

    openModal({
      title: 'Editar perfil',
      size: '480px',
      body: el('div', {}, [
        el('div', { class: 'field' }, [el('label', { text: 'Nome de exibicao' }), displayName]),
        el('div', { class: 'field' }, [el('label', { text: '@username' }), username]),
        el('div', { class: 'field' }, [el('label', { text: 'Bio' }), bio]),
        el('div', { class: 'field' }, [el('label', { text: 'Link' }), website]),
        el('div', { class: 'field' }, [el('label', { text: 'Localizacao' }), location]),
      ]),
      actions: [
        { label: 'Cancelar', class: 'btn-ghost' },
        {
          label: 'Salvar',
          class: 'btn-primary',
          onClick: async () => {
            try {
              const result = await updateProfile({
                displayName: displayName.value.trim(),
                bio: bio.value.trim(),
                website: website.value.trim(),
                location: location.value.trim(),
              });
              const newUsername = username.value.trim().replace(/^@/, '').toLowerCase();
              if (newUsername !== result.user.username) {
                await changeUsername(newUsername);
              }
              toastSuccess('Perfil atualizado');
              await reload();
              return true;
            } catch (err) { toastError(err); return false; }
          },
        },
      ],
    });
  };

  // Atalho usado pelo menu do perfil para as abas fora da grade.
  const abrirAba = (id) => {
    state.tab = id;
    // A grade precisa ganhar o botao da aba que o menu abriu.
    fingerprintGrade = null;
    renderTabs();
    renderTab();
  };

  const openSelfMenu = (event) => openMenu([
    { label: 'Editar perfil', icon: 'edit', onClick: () => openEditProfile() },
    { label: 'Criar um video', icon: 'camera', onClick: () => navigate('/criar') },
    // As tres abas que sairam da grade (item 11) continuam acessiveis aqui.
    ...ABAS_FORA_DA_GRADE.map((aba) => ({
      label: aba.label,
      icon: aba.icon,
      onClick: () => abrirAba(aba.id),
    })),
    { label: 'Configuracoes', icon: 'settings', onClick: () => navigate('/configuracoes') },
    {
      label: 'Exportar meus dados',
      icon: 'download',
      onClick: async () => {
        const data = await api.get('/api/me/export');
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = el('a', { href: url, download: 'pulse-dados.json' });
        document.body.append(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
        toastSuccess('Arquivo de dados gerado');
      },
    },
  ]);

  const openUserMenu = (user, relation) => openMenu([
    {
      label: 'Copiar link do perfil',
      icon: 'copy',
      onClick: async () => {
        const url = `${location.origin}/@${user.username}`;
        await navigator.clipboard?.writeText(url);
        toastSuccess('Link copiado');
      },
    },
    {
      label: 'Silenciar',
      icon: 'mute',
      onClick: async () => {
        try {
          if (relation.isMuted) await api.delete(`/api/users/${user.id}/mute`);
          else await api.post(`/api/users/${user.id}/mute`, {});
          toastSuccess('Preferencia de silencio atualizada');
          reload();
        } catch (err) { toastError(err); }
      },
    },
    {
      label: relation.isBlocked ? 'Desbloquear' : 'Bloquear',
      icon: 'block',
      danger: !relation.isBlocked,
      onClick: async () => {
        const ok = await confirmDialog({
          title: relation.isBlocked ? `Desbloquear @${user.username}?` : `Bloquear @${user.username}?`,
          message: relation.isBlocked ? 'A conta podera te seguir e interagir novamente.' : 'Nao serao possiveis seguidores, comentarios, mensagens ou acesso a conteudos privados.',
          confirmLabel: relation.isBlocked ? 'Desbloquear' : 'Bloquear',
          danger: !relation.isBlocked,
        });
        if (!ok) return;
        try {
          if (relation.isBlocked) await api.delete(`/api/users/${user.id}/block`);
          else await api.post(`/api/users/${user.id}/block`, {});
          toastSuccess('Bloqueio atualizado');
          await reload();
        } catch (err) { toastError(err); }
      },
    },
    {
      label: 'Denunciar conta',
      icon: 'flag',
      danger: true,
      onClick: () => openReportDialog({ targetType: 'user', targetId: user.id, title: `Denunciar @${user.username}` }),
    },
  ]);

  const reload = async () => {
    state.data = await fetchUser(idOrUsername);
    state.user = state.data.user;
    // Marcador do perfil exibido: permite confirmar pela DOM qual conta abriu.
    page.dataset.username = state.user.username || '';
    render();
  };

  // ---- Realtime: contadores e relaciones ----
  const onFollow = (event) => {
    const payload = event.detail || {};
    if (payload.followeeId === state.user?.id && store.user?.id === payload.followerId) {
      reload().catch(() => {});
    }
  };
  state.cleanups.push(realtime.addEventListener('FOLLOW', onFollow));
  state.cleanups.push(realtime.addEventListener('UNFOLLOW', onFollow));
  state.cleanups.push(realtime.addEventListener('COUNTS', (event) => {
    const payload = event.detail || {};
    if (payload.followers !== undefined && state.data?.counts) {
      state.data.counts.followerCount = payload.followers;
      render();
    }
  }));

  reload().catch((err) => {
    page.replaceChildren(emptyState({
      iconName: 'user',
      title: err.status === 404 ? 'Conta nao encontrada' : 'Perfil indisponivel',
      message: err.status === 404 ? 'Esta conta nao existe ou foi removida.' : err.message,
    }));
  });

  return {
    element: page,
    async destroy() {
      for (const fn of state.cleanups) fn();
      state.cleanups.length = 0;
      page.replaceChildren();
      page.remove();
    },
  };
}

/** Tile compacto de video (grid). */
export function postTile(post) {
  const node = el('a', {
    class: 'tile',
    href: `/video/${post.id}`,
    'data-link': true,
    'aria-label': post.caption?.slice(0, 80) || 'Video',
  });
  if (post.type === 'text') {
    node.append(el('div', { class: 'tile-fallback', style: { background: 'linear-gradient(160deg,#1a1a2e,#2d1b3d)' } }, [
      el('span', { class: 'clamp-2', text: post.caption?.slice(0, 80) || '' }),
    ]));
  } else if (post.media?.posterUrl) {
    node.append(el('img', { src: post.media.posterUrl, alt: '', loading: 'lazy' }));
  } else if (post.media?.kind === 'image') {
    node.append(el('img', { src: post.media.url, alt: '', loading: 'lazy' }));
  } else {
    node.append(el('div', { class: 'tile-fallback' }, [
      el('span', { text: post.type === 'video' ? 'Processando\u2026' : 'Sem imagem' }),
    ]));
  }

  node.append(el('div', { class: 'tile-meta' }, [
    el('div', { class: 'tile-author' }, [
      el('div', { class: 'avatar' }, [
        post.author?.avatarUrl ? el('img', { src: post.author.avatarUrl, alt: '', loading: 'lazy' }) : el('div', { class: 'avatar' }),
      ]),
      el('span', { class: 'truncate', text: `@${post.author?.username || ''}` }),
    ]),
    el('span', { class: 'spacer' }),
    el('span', { class: 'row', style: { gap: '3px' } }, [icon('heart'), el('span', { text: formatCount(post.counts?.likes ?? 0) })]),
  ]));

  return node;
}

/** Linha de video (lista). */
export function postRow(post) {
  return el('a', { class: 'row-post', href: `/video/${post.id}`, 'data-link': true }, [
    el('div', { class: 'row-thumb' }, [
      post.media?.posterUrl
        ? el('img', { src: post.media.posterUrl, alt: '', loading: 'lazy' })
        : el('div', { class: 'tile-fallback', text: post.type === 'text' ? 'Texto' : 'V\u00eddeo' }),
    ]),
    el('div', {}, [
      el('div', { class: 'strong small truncate', text: `@${post.author?.username || ''}` }),
      el('div', { class: 'small clamp-2', text: post.caption || 'Sem legenda' }),
      el('div', { class: 'row tiny faint', style: { marginTop: '4px', gap: '10px' } }, [
        el('span', { class: 'row', style: { gap: '3px' } }, [icon('heart'), el('span', { text: formatCount(post.counts?.likes ?? 0) })]),
        el('span', { class: 'row', style: { gap: '3px' } }, [icon('comment'), el('span', { text: formatCount(post.counts?.comments ?? 0) })]),
        el('span', { text: formatTime(post.createdAt) }),
      ]),
    ]),
  ]);
}

/** Seletor de imagem (avatar/capa). */
export function pickImage(onPick) {
  const input = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', style: { display: 'none' } });
  document.body.append(input);
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    input.remove();
    if (file) onPick(file);
  });
  input.click();
}

/** Recorte de imagem com zoom e posicao (client-side, antes do upload). */
export function openImageCropper({ file, aspect = 1, title = 'Ajustar imagem', onDone }) {
  const canvas = el('canvas', { style: { width: '100%', maxWidth: '360px', borderRadius: '12px', touchAction: 'none' } });
  const image = new Image();
  const url = URL.createObjectURL(file);
  const ctx = canvas.getContext('2d');

  const size = 400;
  canvas.width = size * aspect;
  canvas.height = size;
  const state = { zoom: 1, offsetX: 0, offsetY: 0 };

  const draw = () => {
    const base = Math.min(canvas.width / image.width, canvas.height / image.height);
    const w = image.width * base * state.zoom;
    const h = image.height * base * state.zoom;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, (canvas.width - w) / 2 + state.offsetX, (canvas.height - h) / 2 + state.offsetY, w, h);
  };

  image.onload = () => draw();

  // Pan + zoom por ponteiro
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  canvas.addEventListener('pointerdown', (event) => {
    dragging = true;
    lastX = event.clientX;
    lastY = event.clientY;
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    const rect = canvas.getBoundingClientRect();
    state.offsetX += ((event.clientX - lastX) / rect.width) * canvas.width;
    state.offsetY += ((event.clientY - lastY) / rect.height) * canvas.height;
    lastX = event.clientX;
    lastY = event.clientY;
    draw();
  });
  canvas.addEventListener('pointerup', () => { dragging = false; });
  canvas.addEventListener('wheel', (event) => {
    event.preventDefault();
    state.zoom = Math.max(1, Math.min(4, state.zoom * (event.deltaY > 0 ? 0.92 : 1.08)));
    draw();
  }, { passive: false });

  const zoomSlider = el('input', { type: 'range', min: '100', max: '400', value: '100', style: { width: '100%' } });
  zoomSlider.addEventListener('input', () => {
    state.zoom = Number(zoomSlider.value) / 100;
    draw();
  });

  const modal = openModal({
    title,
    size: '440px',
    body: el('div', {}, [
      canvas,
      el('div', { class: 'field mt' }, [el('label', { text: 'Zoom' }), zoomSlider]),
      el('p', { class: 'tiny faint', text: 'Arraste para posicionar e use o zoom para enquadrar.' }),
    ]),
    actions: [
      { label: 'Cancelar', class: 'btn-ghost' },
      {
        label: 'Aplicar',
        class: 'btn-primary',
        onClick: () => {
          canvas.toBlob((blob) => {
            onDone(new File([blob], `recortado-${Date.now()}.jpg`, { type: 'image/jpeg' }));
            URL.revokeObjectURL(url);
          }, 'image/jpeg', 0.92);
          return true;
        },
      },
    ],
    onClose: () => URL.revokeObjectURL(url),
  });

  image.src = url;
  return modal;
}
