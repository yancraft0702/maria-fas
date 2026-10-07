/**
 * MARIA FÃS - ponto de entrada do cliente.
 * Monta shell (sidebar desktop / tabbar mobile), rotas, realtime e PWA.
 */
import { api } from './core/api.js';
import { realtime } from './core/realtime.js';
import { store, on, setUser, isLoggedIn, bootstrapSession, refreshCounts, applyInitialTheme, toggleTheme, applyPreferences, setCounts } from './core/store.js';
import { route, startRouter, navigate, resolve, setNotFound, back, setSessionGuard } from './core/router.js';
import { el, icon, mount, clearNode, debounce, brandHeart } from './core/dom.js';
import { toast, toastError, toastSuccess, emptyState } from './core/ui.js';
import { pauseAll, auditMedia } from './core/media.js';
import { closeMiniPlayer } from './features/youtube.js';
import { flush as flushAnalytics } from './features/analytics.js';
import { openCreateMenu } from './features/create-menu.js';
import { publicarFaixaRodape } from './core/viewport.js';

const boot = document.getElementById('boot');
const bootMsg = document.getElementById('boot-msg');
const app = document.getElementById('app');
const mainEl = document.getElementById('main');
const sidebarNav = document.getElementById('side-nav');
const tabbar = document.getElementById('tabbar');
const topbarActions = document.getElementById('topbar-actions');
const backBtn = document.getElementById('btn-back');

// Marca da casa: o MESMO coracao usado na tela de entrada (item 2/27).
// Preenchido uma vez, no boot, para sidebar e header usarem o mesmo desenho.
{
  const marca = brandHeart({ size: 30 });
  const sidebarMark = document.getElementById('brand-mark');
  const topbarHeart = document.getElementById('topbar-heart');
  if (sidebarMark) sidebarMark.innerHTML = marca;
  if (topbarHeart) topbarHeart.innerHTML = brandHeart({ size: 26 });
}
const pushPrompt = document.getElementById('push-prompt');

// --------------------------------------------------------------------------
// Navegacao: uma unica definicao por destino, usada na sidebar e na tabbar.
// --------------------------------------------------------------------------
// Navegacao: uma unica definicao por destino, usada na sidebar e na tabbar.
//
// Ao Vivo permanece na sidebar; no celular, sua entrada fica no tab strip do
// feed para evitar duplicar o atalho na barra inferior.
const NAV_ITEMS = [
  { id: 'home', label: 'Inicio', icon: 'home', href: '/', mobile: true, desktop: true },
  { id: 'friends', label: 'Amigos', icon: 'friends', href: '/amigos', mobile: true, desktop: true },
  { id: 'live', label: 'Ao Vivo', icon: 'live', href: '/ao-vivo', mobile: false, desktop: true },
  { id: 'create', label: 'Publicar', icon: 'plus', mobile: true, desktop: true, primary: true },
  { id: 'inbox', label: 'Inbox', icon: 'inbox', href: '/inbox', mobile: true, desktop: true, badge: 'messages' },
  { id: 'profile', label: 'Perfil', icon: 'user', href: '/perfil', mobile: true, desktop: true, requiresAuth: true },
  { id: 'notifications', label: 'Notificacoes', icon: 'bell', href: '/notificacoes', mobile: false, desktop: true, badge: 'notifications' },
  { id: 'admin', label: 'Administracao', icon: 'shield', href: '/admin', mobile: false, desktop: true, staffOnly: true },
  // Rotas preservadas, fora da navegacao principal.
  { id: 'search', label: 'Buscar', icon: 'search', href: '/busca', mobile: false, desktop: false },
  { id: 'explore', label: 'Explorar', icon: 'sparkle', href: '/explorar', mobile: false, desktop: false },
];

function visibleNavItems() {
  return NAV_ITEMS.filter((item) => {
    if (item.requiresAuth && !isLoggedIn()) return false;
    if (item.staffOnly && !(store.user?.role === 'admin' || store.user?.role === 'moderator')) return false;
    return true;
  });
}

function renderSidebar() {
  clearNode(sidebarNav);
  for (const item of visibleNavItems()) {
    if (!item.desktop) continue;
    // Item 9: "Publicar" e o "+" da bottom nav abrem o MESMO menu de criacao.
    if (item.primary) {
      sidebarNav.append(createButton());
      continue;
    }
    const count = item.badge ? store.counts[item.badge] || 0 : 0;
    sidebarNav.append(el('a', {
      class: 'side-link',
      href: item.href,
      'data-link': true,
      'data-nav': item.id,
      'aria-label': item.label,
    }, [
      icon(item.icon),
      el('span', { class: 'grow', text: item.label }),
      count > 0 ? el('span', { class: 'badge', text: count > 99 ? '99+' : String(count) }) : null,
    ]));
  }
}

/**
 * Botao "Publicar" da sidebar (desktop). Abre o menu de criacao - o mesmo do
 * "+" do celular. Nao existe um segundo editor.
 */
function createButton() {
  return el('button', {
    type: 'button',
    class: 'side-link side-create',
    'data-nav': 'create',
    'aria-label': 'Publicar',
    onClick: () => openCreateMenu({ formato: 'menu' }),
  }, [icon('plus'), el('span', { class: 'grow', text: 'Publicar' })]);
}

function renderTabbar() {
  clearNode(tabbar);
  const items = visibleNavItems().filter((item) => item.mobile);
  tabbar.style.gridTemplateColumns = `repeat(${items.length}, minmax(0, 1fr))`;
  for (const item of items) {
    // Item 9: o "+" central e o ponto UNICO de criacao.
    if (item.primary) {
      tabbar.append(el('button', {
        type: 'button',
        class: 'tab-create',
        'data-nav': item.id,
        'aria-label': 'Criar',
        onClick: () => openCreateMenu(),
      }, [icon('plus')]));
      continue;
    }
    const count = item.badge ? store.counts[item.badge] || 0 : 0;
    tabbar.append(el('a', {
      class: 'tab',
      href: item.href,
      'data-link': true,
      'data-nav': item.id,
      'aria-label': item.label,
    }, [
      icon(item.icon),
      el('span', { text: item.label }),
      count > 0 ? el('span', { class: 'tab-badge', text: count > 99 ? '99+' : String(count) }) : null,
    ]));
  }
}

function renderTopbarActions() {
  clearNode(topbarActions);
  if (!isLoggedIn()) {
    topbarActions.append(
      el('a', { class: 'btn btn-sm btn-ghost', href: '/entrar', 'data-link': true, text: 'Entrar' }),
      el('a', { class: 'btn btn-sm btn-primary', href: '/cadastro', 'data-link': true, text: 'Criar conta' }),
    );
    return;
  }

  const notificationCount = store.counts.notifications || 0;
  topbarActions.append(el('a', {
    class: 'icon-btn', href: '/notificacoes', 'data-link': true, 'aria-label': `Notificacoes (${notificationCount})`,
    'data-nav': 'notifications',
  }, [
    icon('bell'),
    notificationCount > 0 ? el('span', { class: 'badge', text: notificationCount > 99 ? '99+' : String(notificationCount) }) : null,
  ]));

  if (store.user?.role === 'admin' || store.user?.role === 'moderator') {
    topbarActions.append(el('a', {
      class: 'icon-btn', href: '/admin', 'data-link': true, 'aria-label': 'Administracao',
    }, [icon('shield')]));
  }

  // Item 1: CHAT GLOBAL no topo do site, ao lado do avatar.
  //
  // Antes ele so aparecia dentro do Inbox, que e a area PRIVADA - e quem chega
  // pelo topo do site nao tinha onde clicar. Este botao e o atalho direto: leva
  // a `/chat-global`, que e a MESMA tela de sempre (mesmo componente
  // `createGlobalChat`), sem duplicar chat nem criar rota nova.
  //
  // `data-nav="chat-global"` faz o botao receber o estado ativo junto com a
  // navegacao, e o icone e o mesmo das reacoes, para leitura imediata.
  topbarActions.append(el('a', {
    class: 'icon-btn chat-global-btn',
    href: '/chat-global',
    'data-link': true,
    'data-nav': 'chat-global',
    'aria-label': 'Chat global',
    title: 'Chat global',
  }, [icon('users')]));

  topbarActions.append(el('button', {
    type: 'button',
    class: 'avatar-btn',
    'aria-label': `Perfil de @${store.user.username}`,
    onClick: (event) => openAccountMenu(event),
  }, [
    store.user.avatarUrl
      ? el('img', { src: `${store.user.avatarUrl}&s=80`, alt: '', loading: 'lazy' })
      : el('span', { style: { display: 'grid', placeItems: 'center', height: '100%' } }, [icon('user')]),
  ]));
}

/**
 * Rotas com `data-nav` que NAO fazem parte da navegacao principal (sidebar e
 * bottom nav). Sao atalhos de tela - hoje, so o Chat Global do topo (item 1).
 * Sem esta lista, o botao do Chat Global nunca receberia o estado ativo, porque
 * `highlightNav` so conhece os itens de `NAV_ITEMS`.
 */
const ROTAS_AVULSAS = {
  'chat-global': '/chat-global',
};

function highlightNav(routeInfo) {
  const path = routeInfo?.path || location.pathname;
  for (const node of document.querySelectorAll('[data-nav]')) {
    const id = node.dataset.nav;
    const item = NAV_ITEMS.find((n) => n.id === id);
    const avulsa = ROTAS_AVULSAS[id];
    let active = false;
    if (avulsa) {
      active = path === avulsa;
    } else if (!item) {
      active = false;
    } else if (item.href === '/') {
      active = path === '/';
    } else if (item.id === 'profile') {
      active = path === '/perfil' || path.startsWith('/@');
    } else {
      active = path === item.href || path.startsWith(`${item.href}/`);
    }
    if (active) node.setAttribute('aria-current', 'page');
    else node.removeAttribute('aria-current');
  }
}

/**
 * Shell da aplicacao.
 *
 * Sem sessao, nada de navegacao privada e montado: ficam apenas a marca, o
 * topo limpo e o conteudo do login/cadastro. Isso evita mostrar links que
 * so_existiria para leadingar a sessao e depois falhar no backend.
 */
function renderShell() {
  clearNode(sidebarNav);
  clearNode(tabbar);
  renderTopbarActions();
  syncAuthOnly();
  backBtn.hidden = location.pathname === '/' || authOnly();
  if (!isLoggedIn()) {
    document.body.classList.add('authed-off');
    app.classList.add('logged-out');
    return;
  }
  document.body.classList.remove('authed-off');
  app.classList.remove('logged-out');
  renderSidebar();
  renderTabbar();
}

function openAccountMenu() {
  import('./core/ui.js').then(({ openMenu }) => {
    openMenu([
      { label: 'Meu perfil', icon: 'user', onClick: () => navigate('/perfil') },
      { label: 'Meus videos', icon: 'film', onClick: () => navigate('/perfil') },
      { label: 'Rascunhos', icon: 'edit', onClick: () => navigate('/perfil') },
      { label: 'Configuracoes', icon: 'settings', onClick: () => navigate('/configuracoes') },
      { label: 'Meus dados', icon: 'download', onClick: () => navigate('/configuracoes') },
      {
        label: 'Sair',
        icon: 'logout',
        danger: true,
        onClick: async () => {
          const { logout } = await import('./features/auth.js');
          await logout();
          realtime.disconnect();
          setUser(null);
          navigate('/');
          toastSuccess('Voce saiu da conta');
        },
      },
    ], { title: `@${store.user.username}` });
  });
}

backBtn.addEventListener('click', () => back('/'));
document.getElementById('btn-theme').addEventListener('click', () => toggleTheme());
document.getElementById('btn-settings').addEventListener('click', () => navigate('/configuracoes'));

// --------------------------------------------------------------------------
// Rotas
// --------------------------------------------------------------------------

/**
 * Telas de autenticacao sao PAGINAS INDEPENDENTES (item 3).
 *
 * Nao pode sobrar nada do aplicativo em volta: sidebar, topbar, tabbar, botao
 * de voltar e as acoes do topo. A classe `auth-only` no <body> e a unica
 * fonte dessa decisao - o CSS esconde o shell inteiro.
 */
function authOnly() {
  return !isLoggedIn() && PUBLIC_ROUTES.has(location.pathname);
}

function syncAuthOnly() {
  document.body.classList.toggle('auth-only', authOnly());
}

/**
 * Login obrigatorio antes do site.
 *
 * So estas rotas abrem sem sessao. Qualquer outra URL - acessada direto,
 * por link ou pelo historico - e redirecionada para `/entrar`, guardando o
 * destino em `?redirect=` para voltar para ele depois do login.
 *
 * A autorizacao REAL continua no backend: isto aqui e a camada de navegacao,
 * nao uma segunda fonte de permissao.
 */
const PUBLIC_ROUTES = new Set([
  '/entrar',
  '/cadastro',
  '/recuperar-senha',
]);

setSessionGuard((path, meta = {}) => {
  if (meta.public) return null;
  if (PUBLIC_ROUTES.has(path)) return null;
  if (isLoggedIn()) return null;
  const redirect = `${path}${location.search || ''}`;
  return `/entrar?redirect=${encodeURIComponent(redirect)}`;
});

// Sem sessao nenhuma nao ha sidebar, tabbar nem notificacao para mostrar.
// (O estado real so e conhecido depois de `bootstrapSession()`, entao quem
// revela o shell e o boot, no fim deste arquivo.)
const requireAuthPage = (load) => async (ctx) => {
  if (!isLoggedIn()) {
    const { loginScreen } = await import('./features/auth.js');
    const screen = loginScreen({
      onDone: () => {
        screen.destroy();
        renderShell();
        resolve();
      },
    });
    mount(mainEl, screen.element);
    return () => screen.destroy();
  }
  return load(ctx);
};

route('/', async () => {
  const { createFeedPage } = await import('./features/feed.js');
  const feed = createFeedPage({ feed: 'for_you' });
  mount(mainEl, feed.element);
  mainEl.classList.add('flush');
  await feed.activate();
  return () => {
    mainEl.classList.remove('flush');
    feed.destroy();
  };
});

/**
 * Destino apos o login. Aceita SOMENTE caminhos internos do proprio app
 * (nada de URL absoluta ou protocolo), para o redirect nao virar open redirect.
 */
function safeRedirect(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return null;
  if (value.startsWith('/entrar') || value.startsWith('/cadastro')) return null;
  return value;
}

route('/entrar', async ({ query }) => {
  if (isLoggedIn()) { navigate('/'); return () => {}; }
  const { loginScreen } = await import('./features/auth.js');
  const screen = loginScreen({
    initialTab: 'login',
    onDone: (user) => {
      screen.destroy();
      renderShell();
      connectRealtime();
      toastSuccess(`Ola, ${user.displayName}!`);
      // Volta para onde o usuario tentava ir.
      navigate(safeRedirect(query.redirect) || '/');
    },
  });
  mount(mainEl, screen.element);
  document.body.classList.add('no-scroll');
  return () => {
    screen.destroy();
    document.body.classList.remove('no-scroll');
  };
});

route('/cadastro', async () => {
  if (isLoggedIn()) { navigate('/'); return () => {}; }
  const { loginScreen } = await import('./features/auth.js');
  const screen = loginScreen({
    initialTab: 'register',
    onDone: (user) => {
      screen.destroy();
      renderShell();
      connectRealtime();
      toastSuccess('Bem-vindo ao MARIA FÃS!');
      navigate('/perfil');
    },
  });
  mount(mainEl, screen.element);
  document.body.classList.add('no-scroll');
  return () => {
    screen.destroy();
    document.body.classList.remove('no-scroll');
  };
});

route('/recuperar-senha', async ({ query }) => {
  const { resetPasswordScreen, loginScreen } = await import('./features/auth.js');
  const screen = query.token
    ? resetPasswordScreen({ token: query.token })
    : loginScreen({ initialTab: 'forgot' });
  mount(mainEl, screen.element);
  return () => screen.destroy();
});

route('/amigos', requireAuthPage(async () => {
  const { createFriendsScreen } = await import('./features/friends.js');
  const screen = createFriendsScreen();
  mount(mainEl, screen.element);
  await screen.load();
  return () => screen.destroy();
}));

route('/criar', requireAuthPage(async ({ query }) => {
  const { createVideoEditor } = await import('./features/editor.js');
  const editor = createVideoEditor({ remixPostId: query.remix || null });
  mount(mainEl, editor.element);
  return () => editor.destroy();
}));

route('/video/:id', async ({ params }) => {
  const { createPostPage } = await import('./features/post-page.js');
  const page = createPostPage({ postId: params.id });
  mount(mainEl, page.element);
  await page.load();
  return () => page.destroy();
});

route('/videos/:id', async ({ params }) => navigate(`/video/${params.id}`));

route('/inbox', async () => {
  if (!isLoggedIn()) { navigate('/entrar'); return () => {}; }
  const { createInboxScreen } = await import('./features/inbox.js');
  const screen = createInboxScreen();
  mount(mainEl, screen.element);
  await screen.load();
  return () => screen.destroy();
});

route('/inbox/:conversationId', async ({ params }) => {
  if (!isLoggedIn()) { navigate('/entrar'); return () => {}; }
  const { createInboxScreen } = await import('./features/inbox.js');
  const screen = createInboxScreen({ conversationId: params.conversationId });
  mount(mainEl, screen.element);
  await screen.load();
  return () => screen.destroy();
});

route('/chat-global', async () => {
  if (!isLoggedIn()) { navigate('/entrar'); return () => {}; }
  const { createGlobalChat } = await import('./features/messaging.js');
  const chat = createGlobalChat();
  mount(mainEl, chat.element);
  await chat.load();
  return () => chat.destroy();
});

route('/ao-vivo', async () => {
  const { createLiveDiscoverScreen } = await import('./features/live-discover.js');
  const screen = createLiveDiscoverScreen();
  mount(mainEl, screen.element);
  await screen.load();
  return () => screen.destroy();
});

route('/live/:id', async ({ params }) => {
  if (!isLoggedIn()) {
    const { loginScreen } = await import('./features/auth.js');
    const screen = loginScreen({
      onDone: () => { screen.destroy(); renderShell(); connectRealtime(); resolve(); },
    });
    mount(mainEl, screen.element);
    return () => screen.destroy();
  }
  const { createViewerLiveScreen } = await import('./features/live-viewer.js');
  const screen = createViewerLiveScreen({ roomId: params.id });
  mount(mainEl, screen.element);
  return () => screen.destroy();
});

route('/iniciar-live', requireAuthPage(async () => {
  const { createLiveStartScreen } = await import('./features/live-discover.js');
  const screen = createLiveStartScreen();
  mount(mainEl, screen.element);
  return () => screen.destroy();
}));

route('/busca', async ({ query }) => {
  const { createSearchScreen } = await import('./features/search.js');
  const screen = createSearchScreen({ initialQuery: query.q || '' });
  mount(mainEl, screen.element);
  await screen.load();
  return () => screen.destroy();
});

route('/explorar', async () => {
  const { createExploreScreen } = await import('./features/search.js');
  const screen = createExploreScreen();
  mount(mainEl, screen.element);
  await screen.load();
  return () => screen.destroy();
});

route('/notificacoes', requireAuthPage(async () => {
  const { createNotificationsScreen } = await import('./features/notifications.js');
  const screen = createNotificationsScreen();
  mount(mainEl, screen.element);
  await screen.load();
  return () => screen.destroy();
}));

route('/perfil', requireAuthPage(async () => {
  const { createProfilePage } = await import('./features/profile.js');
  const page = createProfilePage({ idOrUsername: store.user.username });
  mount(mainEl, page.element);
  return () => page.destroy();
}));

route('/@:username', async ({ params }) => {
  const { createProfilePage } = await import('./features/profile.js');
  const page = createProfilePage({ idOrUsername: params.username });
  mount(mainEl, page.element);
  return () => page.destroy();
});

route('/tag/:tag', async ({ params }) => {
  const { createHashtagScreen } = await import('./features/search.js');
  const screen = createHashtagScreen({ tag: params.tag });
  mount(mainEl, screen.element);
  await screen.load();
  return () => screen.destroy();
});

route('/som/:id', async ({ params }) => {
  const { createSoundScreen } = await import('./features/search.js');
  const screen = createSoundScreen({ soundId: params.id });
  mount(mainEl, screen.element);
  await screen.load();
  return () => screen.destroy();
});

route('/configuracoes', requireAuthPage(async () => {
  const { createSettingsScreen } = await import('./features/settings.js');
  const screen = createSettingsScreen();
  mount(mainEl, screen.element);
  await screen.load();
  return () => screen.destroy();
}));

route('/admin', requireAuthPage(async () => {
  if (!(store.user?.role === 'admin' || store.user?.role === 'moderator')) {
    mount(mainEl, emptyState({
      iconName: 'lock', title: 'Acesso restrito', message: 'Esta area e exclusiva da equipe de moderacao.',
    }));
    return () => {};
  }
  const { createAdminScreen } = await import('./features/admin.js');
  const screen = createAdminScreen();
  mount(mainEl, screen.element);
  await screen.load();
  return () => screen.destroy();
}));

route('/historico', requireAuthPage(async () => {
  const { createHistoryScreen } = await import('./features/search.js');
  const screen = createHistoryScreen();
  mount(mainEl, screen.element);
  await screen.load();
  return () => screen.destroy();
}));

setNotFound(async () => {
  mount(mainEl, emptyState({
    iconName: 'search',
    title: 'Pagina nao encontrada',
    message: 'O endereco acessado nao existe.',
    action: el('a', { class: 'btn btn-primary', href: '/', 'data-link': true, text: 'Voltar ao inicio' }),
  }));
});

// --------------------------------------------------------------------------
// Realtime
// --------------------------------------------------------------------------
function connectRealtime() {
  if (!isLoggedIn()) {
    realtime.disconnect();
    return;
  }
  const token = sessionStorage.getItem('pulse_ws_token');
  // O WS autentica pelo mesmo cookie de sessao; o token e' opcional.
  realtime.connect(token || undefined).then(() => {
    realtime.subscribe(`user:${store.user.id}`);
    if (realtime.subs.has('global-chat') === false) realtime.subscribe('global-chat');
  }).catch(() => { /* reconexao automatica cuida */ });

  realtime.addEventListener('NOTIFICATION', () => refreshCounts());
  realtime.addEventListener('COUNTS', (event) => setCounts(event.detail || {}));
  realtime.addEventListener('MESSAGE', debounce(() => refreshCounts(), 800));
  realtime.addEventListener('revoked', () => {
    toast('Sua sessao foi encerrada em outro dispositivo.', { type: 'error' });
    setUser(null);
    realtime.disconnect();
    renderShell();
    navigate('/entrar');
  });
}

// --------------------------------------------------------------------------
// PWA: service worker + instalacao + push
// --------------------------------------------------------------------------
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  // Liga os botoes do aviso assim que o app sobe (e nao 12s depois): um
  // botao visivel e clicavel precisa responder imediatamente.
  initPushPrompt();
  // Item 7: mede a faixa de rodape uma vez so, no shell. O aviso de
  // notificacoes e os toasts ancoram nessa medicao em vez de num `bottom`
  // fixo - era o que os colocava por cima dos controles do Chat Global.
  publicarFaixaRodape();
  const schedulePrompt = () => {
    if (isLoggedIn() && pushSupported() && Notification.permission === 'default') {
      setTimeout(maybeShowPushPrompt, 12000);
    }
  };
  if (document.readyState === 'complete') schedulePrompt();
  window.addEventListener('load', async () => {
    try {
      if (navigator.serviceWorker.controller) {
        navigator.serviceWorker.addEventListener('controllerchange', () => {
          window.location.reload();
        }, { once: true });
      }
      await navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' });
      store.serviceWorkerReady = true;
      schedulePrompt();
    } catch (err) {
      console.warn('[pwa] service worker nao registrado:', err.message);
    }
  });
}

/**
 * Aviso de notificacoes.
 *
 * Regras: em qualquer acao valida o aviso SAI da tela (mesmo se o navegador
 * negar a permissao), os botoes nunca ficam travados, e a recusa do usuario
 * ("Agora nao") e lembrada para nao insistir.
 */
function pushSupported() {
  return typeof Notification !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window;
}

function hidePushPrompt() {
  if (pushPrompt) pushPrompt.hidden = true;
}

async function maybeShowPushPrompt() {
  if (!pushSupported()) return;
  if (!isLoggedIn()) return;
  if (Notification.permission !== 'default') return;
  if (localStorage.getItem('pulse_push_dismissed') === '1') return;
  if (!store.appConfig.features?.push) return;
  hidePushPrompt();
  pushPrompt.hidden = false;
}

function initPushPrompt() {
  const dismissBtn = document.getElementById('push-dismiss');
  const acceptBtn = document.getElementById('push-accept');
  if (!pushPrompt || !dismissBtn || !acceptBtn) return;

  dismissBtn.addEventListener('click', () => {
    // "Agora nao": some na hora e nao volta nesta sessao/visita.
    hidePushPrompt();
    localStorage.setItem('pulse_push_dismissed', '1');
    store.pushEnabled = false;
  });

  acceptBtn.addEventListener('click', async () => {
    hidePushPrompt();
    dismissBtn.disabled = true;
    acceptBtn.disabled = true;
    acceptBtn.textContent = 'Ativando…';
    try {
      if (!pushSupported()) {
        toast('Este navegador nao suporta notificacoes.', { type: 'error' });
        return;
      }
      const permission = await Notification.requestPermission();
      localStorage.setItem('pulse_push', permission);
      store.pushEnabled = permission === 'granted';

      if (permission === 'denied') {
        // Negado no navegador: estado final conhecido, nao ha o que repetir.
        localStorage.setItem('pulse_push_dismissed', '1');
        toast('Notificacoes bloqueadas nas configuracoes do navegador.', { type: 'warn' });
        return;
      }
      if (permission !== 'granted') {
        toast('Ativacao de notificacoes cancelada.', { type: 'warn' });
        return;
      }

      // Permissao concedida: registra a inscricao no servidor.
      const registration = await navigator.serviceWorker.ready;
      const key = await api.get('/api/push/key');
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key.publicKey),
      });
      await api.post('/api/push/subscribe', subscription.toJSON());
      localStorage.setItem('pulse_push_dismissed', '1');
      toastSuccess('Notificacoes ativadas');
    } catch (err) {
      // Falha de infraestrutura (ex.: push do servidor sem par VAPID) e
      // mostrada como erro real - nada e simulado.
      toast(err.message || 'Nao foi possivel ativar as notificacoes.', { type: 'error' });
    } finally {
      // Os botoes sempre voltam a funcionar, mesmo em caso de erro.
      dismissBtn.disabled = false;
      acceptBtn.disabled = false;
      acceptBtn.textContent = 'Ativar';
    }
  });
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
  return output;
}

// --------------------------------------------------------------------------
// Deep links do PWA (notifications)
// --------------------------------------------------------------------------
function handleDeepLink() {
  const url = new URL(location.href);
  const target = url.searchParams.get('to');
  if (target && target.startsWith('/')) {
    navigate(target);
  }
}

// --------------------------------------------------------------------------
// Ciclo de vida
// --------------------------------------------------------------------------
let pageInstance = null;

on('route:start', () => {
  // Limpa recursos da tela anterior (midia, timers, overlays).
  // `flushAnalytics` envia os eventos de visualizacao pendentes SEM desligar o
  // servico de analytics (que precisa continuar em rotas diferentes).
  pauseAll();
  flushAnalytics().catch(() => { /* envio de analytics e best-effort */ });
  closeMiniPlayer();
  renderShell();
  highlightNav(null);
});

on('route:end', (info) => {
  highlightNav(info);
  syncAuthOnly();
  backBtn.hidden = location.pathname === '/' || authOnly();
});

on('counts', () => {
  renderSidebar();
  renderTabbar();
  renderTopbarActions();
});

on('user:changed', () => renderShell());

on('user', () => renderShell());

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') pauseAll();
});

// Erros nao tratados: nunca "falso sucesso" silencioso
window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason;
  if (reason?.name === 'ApiError') {
    console.error('[api]', reason.status, reason.code, reason.message);
    if (reason.status >= 500) toastError(reason);
  } else {
    console.error('[unhandled]', reason);
  }
});

async function start() {
  try {
    bootMsg.textContent = 'carregando…';
    applyInitialTheme();
    const user = await bootstrapSession();
    applyPreferences();

    renderShell();
    app.hidden = false;
    boot.remove();

    if (user) connectRealtime();
    registerServiceWorker();
    handleDeepLink();
    await startRouter();

    // Auditoria de recursos em desenvolvimento
    if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
      window.__PULSE_DEBUG__ = {
        store,
        api,
        realtime,
        auditMedia,
        version: '1.0.0',
      };
    }
  } catch (err) {
    console.error('[boot]', err);
    if (boot) {
      bootMsg.textContent = `Falha ao iniciar: ${err.message}`;
      bootMsg.style.color = '#ff8080';
    }
  }
}

start();

export { auditMedia };
