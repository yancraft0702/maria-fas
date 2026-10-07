/**
 * Feed vertical fullscreen (Para voce / Seguindo / Amigos).
 *
 * Garantias:
 * - cada video ocupa a tela; swipe/troca por scroll-snap ou botoes
 * - autoplay quando permitido; pausa ao sair da viewport
 * - preload do proximo; videos distantes sao descarregados (liberty/cleanup)
 * - clique no video = play/pause (NAO abre comentarios)
 * - comentarios abrem apenas pelo botao proprio
 * - sem "undefined"/"NaN": todos os campos tem valor definido
 */
import { api } from '../core/api.js';
import { el, icon, formatCount, linkifyText } from '../core/dom.js';
import { toastError } from '../core/ui.js';
import { createVideo, safePlay, pauseOwnedBy, destroyOwnedBy, videoPool } from '../core/media.js';
import { store, isLoggedIn } from '../core/store.js';
import { openComments } from './comments.js';
import { openShareMenu } from './share.js';
import { openPostMenu } from './post-menu.js';
import { mediaBubble } from './audio-bubble.js';
import { recordWatch } from './analytics.js';
import { navigate } from '../core/router.js';
import { realtime } from '../core/realtime.js';

const FEEDS = {
  for_you: { path: '/api/feed/for-you', label: 'Para voce' },
  following: { path: '/api/feed/following', label: 'Seguindo' },
  friends: { path: '/api/feed/friends', label: 'Amigos' },
};

/**
 * @param {object} options
 * @param {'for_you'|'following'|'friends'} options.feed
 */
export function createFeedPage({ feed = 'for_you' } = {}) {
  const cleanups = [];
  const tabsBar = el('div', { class: 'feed-tabs', role: 'tablist', 'aria-label': 'Feeds' });
  const stage = el('div', { class: 'feed-stage', id: 'feed-stage' });
  const page = el('div', { class: 'feed-page desktop' }, [tabsBar, stage]);

  let currentFeed = feed;
  let slides = [];
  let activeIndex = -1;
  let loading = false;
  const PAGE_SIZE = 6;

  /**
   * Estado de paginacao POR ABA.
   *
   * Antes these variaveis (`offset`, `seenIds`, `exhausted`) eram unicas para
   * as tres abas: ao trocar de aba o `offset` continuava advanced e os posts
   * ja vistos seguiam bloqueados, entao voltar para "Para voce" mostrava
   * "Nada por aqui" mesmo com videos publicados. Cada aba agora tem o seu
   * proprio cursor e o seu proprio conjunto de ids vistos.
   */
  const feedState = new Map();
  const stateFor = (id) => {
    if (!feedState.has(id)) {
      feedState.set(id, { offset: 0, seenIds: new Set(), exhausted: false, realtimeInsertedIds: [] });
    }
    return feedState.get(id);
  };

  /** Zera o cursor da aba (o DOM dela foi limpo, entao recarrega do inicio). */
  const resetFeed = (id) => feedState.set(id, {
    offset: 0, seenIds: new Set(), exhausted: false, realtimeInsertedIds: [],
  });

  const setTabs = () => {
    tabsBar.replaceChildren();
    for (const [id, config] of Object.entries(FEEDS)) {
      if (id !== 'for_you' && !isLoggedIn()) continue;
      const button = el('button', {
        type: 'button',
        role: 'tab',
        'aria-selected': String(currentFeed === id),
        text: config.label,
        onClick: () => {
          if (currentFeed === id) return;
          switchFeed(id);
        },
      });
      tabsBar.append(button);
    }
    tabsBar.append(el('a', {
      class: 'feed-live-link',
      href: '/ao-vivo',
      'data-link': true,
      'data-nav': 'live',
      'aria-label': 'Ao Vivo',
      text: 'Ao vivo',
    }));
    // Lupa ao lado das abas (item 9): abre a busca, sem occupy a tela.
    tabsBar.append(el('button', {
      type: 'button',
      class: 'feed-search-btn',
      'aria-label': 'Buscar',
      title: 'Buscar',
      onClick: () => navigate('/busca'),
    }, [icon('search')]));
  };

  const switchFeed = async (id) => {
    currentFeed = id;
    setTabs();
    // Os slides da aba anterior sairam da tela: o cursor dela volta a zero,
    // senao a proxima visita a ela comecaria no offset antigo e apareceria
    // "Nada por aqui" mesmo havendo videos.
    resetFeed(id);
    cleanupSlides();
    stage.scrollTop = 0;
    await loadPage();
  };

  // ---- Limpeza de midia por tela (sem video tocando ao sair) ----
  const cleanupSlides = () => {
    for (const slide of slides) {
      observer?.unobserve(slide.element);
      unregisterSlide(slide);
      slide.teardown?.();
    }
    slides = [];
    stage.replaceChildren();
    activeIndex = -1;
    stage.scrollTop = 0;
    pauseOwnedBy('feed');
  };

  // ---- Dados ----
  /**
   * Insere um slide no fluxo do palco e o registra no observer.
   *
   * Como o palco e o container de rolagem, o slide entra no FLUXO normal (nao
   * mais em `position: absolute`): e isso que faz cada publicacao ter seu
   * proprio espaco vertical e a rolagem ser real.
   */
  const insertSlide = (slide, { position = null } = {}) => {
    if (position === null || position >= slides.length) {
      slides.push(slide);
      stage.append(slide.element);
    } else {
      slides.splice(position, 0, slide);
      stage.insertBefore(slide.element, slides[position + 1]?.element || null);
    }
    observer?.observe(slide.element);
    return slide;
  };

  const loadPage = async () => {
    if (loading) return;
    loading = true;
    const config = FEEDS[currentFeed];
    const state = stateFor(currentFeed);
    const requestedOffset = state.offset;
    const realtimeLogOffset = state.realtimeInsertedIds.length;
    try {
      const result = await api.get(config.path, { query: { limit: PAGE_SIZE, offset: requestedOffset } });
      const received = result.posts || [];
      const posts = received.filter((p) => p && (currentFeed !== 'for_you' || p.type !== 'live') && !state.seenIds.has(p.id));
      for (const post of posts) state.seenIds.add(post.id);
      state.exhausted = received.length < PAGE_SIZE;
      const receivedIds = new Set(received.map((post) => post?.id).filter(Boolean));
      const realtimeNotInPage = state.realtimeInsertedIds
        .slice(realtimeLogOffset)
        .filter((id) => !receivedIds.has(id)).length;
      state.offset = requestedOffset + received.length + realtimeNotInPage;
      state.realtimeInsertedIds = [];

      if (!posts.length && !slides.length) {
        stage.append(emptyFeed(currentFeed));
        return;
      }
      for (const post of posts) insertSlide(createSlide(post));
      if (activeIndex === -1 && slides.length) activate(0);
    } catch (err) {
      if (err.code === 'login_required') {
        stage.append(el('div', { class: 'page-empty' }, [
          icon('lock'),
          el('p', { text: 'Faca login para ver este feed.' }),
          el('button', { type: 'button', class: 'btn btn-primary', text: 'Entrar', onClick: () => navigate('/entrar') }),
        ]));
      } else {
        stage.append(el('div', { class: 'page-empty' }, [
          el('div', { class: 'spinner', style: { margin: '0 auto 10px' } }),
          el('p', { class: 'small', text: 'Carregando feed…' }),
        ]));
        toastError(err);
      }
    } finally {
      loading = false;
    }
  };

  // ---- Navegacao: ROLAGEM REAL (item 5) --------------------------------
  /**
   * Altura de uma pagina do feed.
   *
   * Medida do proprio palco (e nao `100dvh`): o espaco util ja desconta as
   * abas, o topo e a bottom nav, entao uma pagina e exatamente o que o usuario
   * ve. O minimo evita que o palco尚未 tenha laid out.
   */
  const alturaPagina = () => stage.clientHeight || stage.getBoundingClientRect().height || 1;

  /** Rola o palco ate a pagina `index` de forma suave (movimento real). */
  const scrollParaIndex = (index, { behavior = 'smooth' } = {}) => {
    const top = index * alturaPagina();
    if (typeof stage.scrollTo === 'function') {
      stage.scrollTo({ top, behavior });
      return;
    }
    stage.scrollTop = top; // navegador sem scrollTo suave
  };

  /**
   * `activate` continua sendo o ponto UNICO que decide qual publicacao toca.
   * A diferenca e que ela agora rola o palco em vez de trocar a exibicao: o
   * movimento vem do navegador, com o mesmo comportamento de uma pagina.
   *
   * O slide que sai PAUSA mas nao e destruido - destruir soltava o `src` do
   * <video> e ao voltar o usuario via um slide mudo. So `cleanupSlides()`
   * (trocar de aba / sair da tela) destroi.
   */
  const activate = async (index, { scroll = true } = {}) => {
    if (index < 0 || index >= slides.length) return;
    if (activeIndex === index) {
      // Ja e o ativo: se a rolagem foi feita a mao, realinha na pagina.
      if (scroll) scrollParaIndex(index, { behavior: 'auto' });
      return;
    }
    const previous = slides.find((slide) => slide.element.classList.contains('active')) || slides[activeIndex];
    if (previous) previous.deactivate?.();
    activeIndex = index;

    // A classe `.active` continua marcando o slide visivel (usada por CSS e por
    // leitores de tela), mas NAO mais decide a exibicao: todos os slides
    // existem no fluxo e o que aparece e o que esta no viewport do palco.
    for (let i = 0; i < slides.length; i += 1) {
      slides[i].element.classList.toggle('active', i === index);
    }

    const slide = slides[index];
    slide.activate();

    if (scroll) scrollParaIndex(index);

    // Preload do proximo / do anterior
    if (slides[index + 1]) slides[index + 1].preload();
    if (slides[index - 1]) slides[index - 1].preload();

    // Carrega mais ao chegar no fim
    if (index >= slides.length - 2 && !stateFor(currentFeed).exhausted && !loading) loadPage();
  };

  /**
   * Avanca/retrocede uma pagina. Se a proxima ainda nao existe, carrega e so
   * entao rola - evita chegar ao fim e travar.
   */
  const goTo = (delta) => {
    const target = activeIndex + delta;
    if (target < 0) return;
    if (target >= slides.length) {
      if (!stateFor(currentFeed).exhausted && !loading) {
        loadPage().then(() => {
          if (activeIndex + delta < slides.length) activate(activeIndex + delta);
        });
      }
      return;
    }
    activate(target);
  };

  // Teclado (desktop)
  const onKeyDown = (event) => {
    if (event.target.matches('input, textarea, [contenteditable]')) return;
    if (event.key === 'ArrowDown' || event.key === 'PageDown') { event.preventDefault(); goTo(1); }
    if (event.key === 'ArrowUp' || event.key === 'PageUp') { event.preventDefault(); goTo(-1); }
    if (event.key === ' ') {
      const slide = slides[activeIndex];
      if (slide?.togglePlay) { event.preventDefault(); slide.togglePlay(); }
    }
    if (event.key === 'm' || event.key === 'M') {
      const slide = slides[activeIndex];
      if (slide?.toggleMute) { event.preventDefault(); slide.toggleMute(); }
    }
    if (event.key === 'l' || event.key === 'L') {
      const slide = slides[activeIndex];
      if (slide?.like) { event.preventDefault(); slide.like(); }
    }
  };
  document.addEventListener('keydown', onKeyDown);

  // ---- Gesto: ROLAGEM NATIVA do container (item 5) ---------------------
  // O wheel NAO e interceptado. O unico trabalho aqui e marcar que houve
  // gesto, para o assentamento saber que a rolagem vai parar.
  // Nao ha `preventDefault`, nem acumulador de `delta`, nem `touchstart`/
  // `touchend` artificial. Wheel, touchpad e swipe chegam ao `stage`, que
  // tem `overflow-y: auto` + `scroll-snap`: o navegador faz o movimento.
  // Um gesto = uma publicacao porque cada pagina tem a altura do palco e o
  // snap assenta exatamente na pagina seguinte.
  //
  // A unica coisa que ainda tratamos e o FIM da lista: quando o usuario chega
  // ao ultimo slide, caregar a proxima pagina e manter a posicao.
  let fimObservado = 0;

  /**
   * Assenta a rolagem na pagina mais proxima quando o gesto termina.
   *
   * `scroll-snap: mandatory` ja garante isso na maior parte do tempo. O que
   * escapa dele e o gesto lento e pequeno (mouse OLDO, trackpad arrastando): o
   * Chrome deixa o container a meio caminho e o usuario ve duas publicacoes ao
   * mesmo tempo. Aqui, quando a rolagem fica parada fora de uma pagina, um
   * unico `scrollTo` suave fecha a distancia.
   *
   * Nao e animacao decorativa: e o container de scroll indo para o ponto mais
   * proximo, que e exatamente o que o snap faria se o navegador deixasse.
   */
  let assentando = null;
  const assentar = () => {
    clearTimeout(assentando);
    assentando = setTimeout(() => {
      const pagina = alturaPagina();
      if (!pagina || !slides.length) return;
      const posicao = stage.scrollTop;
      const maisProxima = Math.round(posicao / pagina);
      const desvio = Math.abs(posicao - maisProxima * pagina);
      // Ja esta na pagina (ou no comeco/fim da lista): nada a fazer.
      if (desvio <= 4) return;
      if (maisProxima < 0 || maisProxima > slides.length - 1) return;
      stage.scrollTo({ top: maisProxima * pagina, behavior: 'smooth' });
    }, 130);
  };

  const onScroll = () => {
    const pagina = alturaPagina();
    if (!pagina) return;
    // Indice mais proximo da rolagem atual (funciona tambem em scroll inercial).
    const bruto = stage.scrollTop / pagina;
    const indice = Math.max(0, Math.min(slides.length - 1, Math.round(bruto)));
    if (indice !== activeIndex) activate(indice, { scroll: false });
    // Perto do fim (duas paginas), carrega mais sob demanda.
    const pertoDoFim = stage.scrollTop + stage.clientHeight >= stage.scrollHeight - pagina * 1.5;
    if (pertoDoFim && slides.length !== fimObservado && !stateFor(currentFeed).exhausted && !loading) {
      fimObservado = slides.length;
      loadPage();
    }
    // Cada evento de rolagem reagenda o assentamento: ele so roda quando o
    // gesto PARAR.
    assentar();
  };
  // `passive: true` aqui e proposital: NUNCA fazemos \`preventDefault\` no
    // wheel. Com \`passive: true\` o navegador tem a certeza de que a rolagem
    // e nossa e aplica o scroll na mesma hora - e a diferenca entre "a tela
    // para e depois troca" e a rolagem de verdade.
    stage.addEventListener('scroll', onScroll, { passive: true });

  // IntersectionObserver marca o slide realmente visivel. E a fonte mais
  // confiavel do indice ativo: nao depende de estimar pixels nem do listener de
  // scroll, e cobre o caso de arrastar rapido (scroll inercial).
  let observer = null;
  if (typeof IntersectionObserver === 'function') {
    observer = new IntersectionObserver((entradas) => {
      for (const entrada of entradas) {
        if (!entrada.isIntersecting) continue;
        const i = slides.findIndex((s) => s.element === entrada.target);
        if (i >= 0 && i !== activeIndex) activate(i, { scroll: false });
      }
    }, { root: stage, threshold: 0.6 });
    // Cada slide criado entra no observer (ver `createSlide`/inserirSlide).
    for (const slide of slides) observer.observe(slide.element);
  }

  // Rola o palco quando o conteudo muda de tamanho (abas, resize, teclado).
  const realinhar = () => {
    if (activeIndex >= 0) scrollParaIndex(activeIndex, { behavior: 'auto' });
  };
  if (typeof ResizeObserver === 'function') {
    const resizeObs = new ResizeObserver(() => realinhar());
    resizeObs.observe(stage);
    cleanups.push(() => resizeObs.disconnect());
  }

  setTabs();
  loadPage();

  // ---- Item 7: nova publicacao entra no feed sem reload ---------------
  // O topico `feed:new` e global. A insercao e no TOPO (o feed e
  // cronologico) e o indice ativo anda junto, para o video que estava em
  // tela continuar em tela.
  const unsubFeed = isLoggedIn() ? realtime.subscribe('feed:new') : null;
  const pendingRealtimeIds = new Set();
  const onNewPost = async (event) => {
    const postId = event.detail?.postId || event.detail?.post?.id;
    if (!postId || currentFeed !== 'for_you' || pendingRealtimeIds.has(postId)) return;
    // So o "Para voce" e aberto a todos; as outras abas tem conjunto proprio.
    const feedAtRequest = currentFeed;
    const state = stateFor('for_you');
    if (state.seenIds.has(postId)) return;
    pendingRealtimeIds.add(postId);
    try {
      // Busca o objeto canonico sob a sessao atual: a mesma query aplica
      // visibilidade publica, bloqueios, posts ocultos e estado de conta.
      const result = await api.get(FEEDS.for_you.path, {
        query: { limit: 1, postId },
      });
      if (currentFeed !== feedAtRequest || currentFeed !== 'for_you') return;
      const post = (result.posts || []).find((item) => item?.id === postId);
      if (!post || post.type === 'live' || state.seenIds.has(post.id)) return;

      state.seenIds.add(post.id);
      state.realtimeInsertedIds.push(post.id);
      const empty = stage.querySelector('.page-empty');
      if (empty) empty.remove();

      const publishedAt = (item) => Number(item.publishedAt) || Number(item.createdAt) || 0;
      const position = slides.findIndex((slide) => {
        const current = slide.post;
        const timeDifference = publishedAt(post) - publishedAt(current);
        if (timeDifference !== 0) return timeDifference > 0;
        return post.id > current.id;
      });
      const insertionIndex = position < 0 ? slides.length : position;
      const activeSlide = slides[activeIndex] || null;
      insertSlide(createSlide(post), { position: insertionIndex });
      if (activeSlide) {
        await activate(slides.indexOf(activeSlide));
      } else {
        await activate(0);
      }
    } catch (err) {
      toastError(err);
    } finally {
      pendingRealtimeIds.delete(postId);
    }
  };
  cleanups.push(realtime.addEventListener('POST_CREATED', onNewPost));

  // Assina topico do post ativo para receber contadores em tempo real
  const unsubTopics = [];

  page.dataset.feed = currentFeed;

  return {
    element: page,
    async activate() {
      document.body.classList.add('no-scroll');
      if (!slides.length) await loadPage();
      else if (activeIndex >= 0) slides[activeIndex].play();
    },
    destroy() {
      document.removeEventListener('keydown', onKeyDown);
      // A rolagem e do container: basta soltar o listener e o observer.
      stage.removeEventListener('scroll', onScroll);
      observer?.disconnect();
      observer = null;
      unsubFeed?.();
      cleanupSlides();
      destroyOwnedBy('feed');
      videoPool.destroy();
      unsubTopics.forEach((fn) => fn());
      cleanups.forEach((fn) => fn());
      document.body.classList.remove('no-scroll');
      page.replaceChildren();
      page.remove();
    },
    get activePost() {
      return slides[activeIndex]?.post || null;
    },
  };
}

function emptyFeed(kind) {
  const messages = {
    for_you: { icon: 'sparkle', title: 'Nada por aqui ainda', message: 'Publique um video ou siga pessoas para encher seu feed.' },
    following: { icon: 'users', title: 'Voce ainda nao segue ninguem', message: 'Busque pessoas e siga para ver os videos delas aqui.' },
    friends: { icon: 'friends', title: 'Sem amigos em comum', message: 'Amizade no MARIA FÃS e mutua: os dois precisam seguir o outro.' },
  };
  const copy = messages[kind] || messages.for_you;
  return el('div', { class: 'page-empty' }, [
    icon(copy.icon, { className: 'muted' }),
    el('h3', { text: copy.title }),
    el('p', { class: 'small', text: copy.message }),
    kind !== 'for_you'
      ? el('a', { href: '/busca', class: 'btn btn-primary mt', 'data-link': true, text: 'Buscar pessoas' })
      : el('a', { href: '/criar', class: 'btn btn-primary mt', 'data-link': true, text: 'Publicar um video' }),
  ]);
}

/**
 * Um slide = um video com overlay e acoes.
 */
function createSlide(post) {
  const owner = 'feed';
  let video = null;
  let active = false;
  let watchStart = 0;
  let watchAccum = 0;
  let replayed = false;
  let wasCompleted = false;
  let reported = false;
  let cleanups = [];
  let unobserveProgress = null;

  const mediaHost = el('div', { class: 'slide-media' });
  const overlay = el('div', { class: 'slide-overlay' });
  const actionsHost = el('div', { class: 'slide-actions' });
  const pauseIcon = el('div', { class: 'slide-pause' }, [icon('play')]);
  const progress = el('div', { class: 'slide-progress' });

  const likeState = { liked: Boolean(post.viewerState?.liked), count: post.counts?.likes ?? 0 };
  const favoriteState = { favorited: Boolean(post.viewerState?.favorited) };

  // ---- midia ----
  // Um repost tem a midia do post ORIGINAL em `repostOf.media`; um post de
  // LIVE nao tem midia nenhuma (o video ao vivo fica na tela da LIVE). Sem
  // este tratamento os dois caiam no placeholder "Conteudo sem midia.".
  const midia = post.media || post.repostOf?.media || null;
  const ehRepublicacao = post.type === 'repost' && Boolean(post.repostOf?.media);

  if (post.type === 'text') {
    // O texto ocupa a area do video com respiro para o bloco de informacoes
    // (autor e acoes) nao ficarem por cima das palavras.
    mediaHost.append(el('div', {
      class: 'slide-text-tile',
    }, [el('div', { class: 'slide-text', text: post.caption || '' })]));
  } else if (post.type === 'live') {
    // Post de LIVE nao tem midia gravada (o video e ao vivo, na tela da LIVE).
    // Mostramos um cartao honesto que leva para as transmissoes - sem inventar
    // um estado "no ar" que o backend nao devolveu.
    mediaHost.append(el('div', { class: 'slide-live-card' }, [
      el('div', { class: 'slide-live-badge' }, [icon('live'), el('span', { text: 'LIVE' })]),
      el('p', { class: 'slide-live-title', text: post.caption || 'Transmissao ao vivo' }),
      el('button', {
        type: 'button',
        class: 'btn btn-primary',
        text: 'Ver transmissoes',
        onClick: () => navigate('/ao-vivo'),
      }),
    ]));
  } else if (midia) {
    if (midia.kind === 'audio') {
      // (Item 16) Publicacao so com audio: toca aqui mesmo. Antes caia no
      // `<video>` generico e aparecia o placeholder "Sem midia para exibir",
      // porque um arquivo de audio nao tem video nenhum.
      mediaHost.append(el('div', { class: 'slide-audio' }, [
        el('div', { class: 'slide-audio-badge' }, [icon('music'), el('span', { text: 'Audio' })]),
        mediaBubble({ url: midia.url, label: 'Audio da publicacao', durationMs: midia.durationMs }),
      ]));
    } else if (midia.status === 'failed') {
      mediaHost.append(el('div', { class: 'live-placeholder' }, [
        icon('warning'),
        el('p', { text: 'Este video nao pode ser processado.' }),
        el('p', { class: 'tiny faint', text: midia.error || 'Sem detalhes.' }),
      ]));
    } else if (midia.kind === 'image') {
      mediaHost.append(el('img', { src: midia.url, alt: post.caption?.slice(0, 80) || 'Foto', loading: 'lazy' }));
    } else if (midia.status === 'processing' && !midia.posterUrl) {
      const badge = el('div', { class: 'slide-badge-processing' }, [
        el('div', { class: 'spinner' }),
        el('span', { text: 'Processando video…' }),
      ]);
      mediaHost.append(badge);
      // Enquanto processa, mostra o arquivo original para nao ficar tela preta
      video = createVideo({
        src: midia.url,
        poster: midia.posterUrl || null,
        muted: true,
        loop: true,
        ownerId: owner,
        preload: 'auto',
      });
      mediaHost.append(video);
      pollMediaStatus(midia.id, badge);
    } else {
      video = createVideo({
        src: pickStreamUrl(midia),
        poster: midia.posterUrl || null,
        muted: store.preferences.autoplayMuted !== false,
        loop: true,
        ownerId: owner,
        preload: 'auto',
      });
      mediaHost.append(video);
      attachVideoBehavior(video);
    }
    // Marca de republicacao: o video e do post original.
    if (ehRepublicacao) {
      mediaHost.append(el('div', { class: 'slide-repost-mark' }, [
        icon('replay'),
        el('span', { text: `Republicou de @${post.repostOf.author?.username || 'alguem'}` }),
      ]));
    }
  } else {
    // Sem midia de verdade (ex.: imagem ainda nao processada e sem original).
    mediaHost.append(el('div', { class: 'live-placeholder' }, [
      icon('film'),
      el('p', { text: 'Sem midia para exibir.' }),
    ]));
  }

  // ---- overlay ----
  const captionNode = el('div', { class: 'slide-caption' });
  if (post.caption) {
    captionNode.append(linkifyText(post.caption, {
      onMention: (username) => navigate(`/@${username}`),
      onHashtag: (tag) => navigate(`/tag/${tag}`),
    }));
  }
  captionNode.addEventListener('click', () => {
    captionNode.classList.toggle('clamp-2');
  });

  const authorLine = el('div', { class: 'slide-author' }, [
    el('div', { class: 'avatar sm' }, [
      post.author.avatarUrl
        ? el('img', { src: post.author.avatarUrl, alt: '', onError: (e) => { e.currentTarget.replaceWith(el('div', { class: 'avatar sm' })); } })
        : el('div', { class: 'avatar sm' }),
    ]),
    el('div', { class: 'slide-author-text' }, [
      // (Item 7) Nome de exibicao E @username tem que estar visivel. Antes
      // havia so o @username, entao o "nome" exigido pelo requisito nao
      // aparecia nunca.
      post.author.displayName && post.author.displayName !== post.author.username
        ? el('span', { class: 'name', text: post.author.displayName })
        : null,
      el('a', {
        href: `/@${post.author.username}`,
        class: post.author.displayName && post.author.displayName !== post.author.username ? 'username' : 'name',
        'data-link': true,
        text: `@${post.author.username}`,
      }),
    ].filter(Boolean)),
  ]);

  const soundLine = post.sound
    ? el('div', { class: 'slide-sound' }, [icon('music2'), el('span', { text: `${post.sound.title}${post.sound.artist ? ` · ${post.sound.artist}` : ''}` })])
    : el('div', { class: 'slide-sound faint' }, [icon('film'), el('span', { text: post.type === 'text' ? 'Post de texto' : 'Video' })]);

  // Num post de TEXTO o proprio texto ja ocupa a area do slide (o tile). Se o
  // overlay repetisse a descricao, o mesmo paragrafo apareceria duas vezes e o
  // bloco de informacoes ficaria ilegivel. Aqui o overlay mostra so quem postou.
  overlay.append(...[authorLine, post.type === 'text' ? null : captionNode, soundLine].filter(Boolean));

  // ---- acoes ----
  const likeBtn = actionButton('heart', formatCount(likeState.count), likeState.liked, 'Curtir', () => toggleLike());
  const commentBtn = actionButton('comment', formatCount(post.counts?.comments ?? 0), false, 'Comentarios', () => {
    openComments(post.id, { onCount: (count) => { commentBtn.label.textContent = formatCount(count); } });
  });
  const favoriteBtn = actionButton('bookmark', favoriteState.favorited ? 'Salvo' : 'Salvar', favoriteState.favorited, 'Favoritar', () => toggleFavorite());
  const repostBtn = actionButton('replay', formatCount(post.counts?.reposts ?? 0), Boolean(post.viewerState?.reposted), 'Repostar', () => toggleRepost());
  const shareBtn = actionButton('share', formatCount(post.counts?.shares ?? 0), false, 'Compartilhar', () => openShareMenu(post));
  // Controle de SOM visivel: o autoplay com audio e bloqueado pelos navegadores,
  // entao o usuario precisa de um botao claro para ligar e desligar o som.
  const audioBtn = el('button', {
    type: 'button',
    class: 'act act-sound',
    'aria-label': 'Ativar som',
    title: 'Ativar som',
    dataset: { sound: 'off' },
    onClick: (event) => { event.stopPropagation(); toggleMute(); },
  }, [icon('volumeOff')]);
  const moreBtn = el('button', {
    type: 'button',
    class: 'act',
    'aria-label': 'Mais opcoes',
    onClick: () => openPostMenu(post, {
      // "Nao tenho interesse", "Ocultar @", "Silenciar" e "Bloquear" tiram o
      // slide da tela imediatamente. Sem isto o post continuava visivel ate a
      // proxima navegacao, apesar do backend ja ter gravado a acao.
      onChanged: (change) => {
        if (!change) return;
        if (change.hidden || change.blocked || change.muted || change.deleted) {
          // "Ocultar @x", "Bloquear @x" e "Silenciar @x" valem para o AUTOR
          // inteiro: some com todos os slides dele, nao so o post do menu.
          const byAuthor = Boolean(change.hidden || change.blocked || change.muted);
          const removed = byAuthor
            ? discardSlidesByAuthor(post.author.id)
            : (slideApi?.discard(), 1);
          window.dispatchEvent(new CustomEvent('pulse:feed-remove', {
            detail: { postId: post.id, authorId: post.author.id, removed },
          }));
        }
      },
    }),
  }, [icon('more')]);

  // Item 9: o botao de musica lateral foi removido (nao fazia nada no slide).
  // O sistema de sons continua intacto na busca, no editor e no card do post.
  actionsHost.append(likeBtn.node, commentBtn.node, favoriteBtn.node, repostBtn.node, shareBtn.node, moreBtn);
  if (video) actionsHost.insertBefore(audioBtn, moreBtn);

  const element = el('div', { class: 'slide', dataset: { postId: post.id } }, [mediaHost, pauseIcon, overlay, actionsHost, progress]);

// Primeira interacao real do usuario no slide: se o video entrou mudo
  // (o navegador bloqueia autoplay com som), o proprio gesto LIGA o audio.
  // Registrado aqui, depois de `element` existir.
  //
  // `soundHandledGesture` impede que o MESMO toque tambem pausasse o video:
  // o primeiro toque serve para ligar o som; os proximos fazem play/pause.
  let soundHandledGesture = false;
  const enableSoundOnFirstGesture = () => {
    if (!video || !video.muted) return;
    video.muted = false;
    soundHandledGesture = true;
    syncSoundButton();
    video.play().catch(() => { /* se o navegador recusar, o botao continua */ });
  };
  const FIRST_GESTURES = ['pointerdown', 'touchstart', 'keydown'];
  for (const event of FIRST_GESTURES) {
    element.addEventListener(event, enableSoundOnFirstGesture, { passive: true, once: true });
  }
  cleanups.push(() => {
    for (const event of FIRST_GESTURES) {
      element.removeEventListener(event, enableSoundOnFirstGesture);
    }
  });

  /** Libera listeners e midia do slide. Compartilhado pelo menu e pelo feed. */
  /**
   * Sai de cena SEM destruir o video (item 6).
   *
   * Antes, trocar de slide chamava `teardown` (que solta o `src`, remove os
   * listeners e esvazia `cleanups`). Ao voltar para o video anterior o
   * elemento ficava sem midia e nao reproduzia - era o "voltar nao funciona".
   * Aqui o elemento, o `src` e os listeners permanecem: so a reproducao para.
   */
  function deactivate() {
    if (!active) return;
    flushWatch(false);
    try { video?.pause(); } catch { /* ignore */ }
    element.classList.remove('paused');
    pauseIcon.hidden = true;
    active = false;
  }

  function destroySlide() {
    flushWatch(false);
    deactivate();
    for (const fn of cleanups) fn();
    cleanups = [];
    unobserveProgress?.();
    pauseOwnedBy(owner);
    if (video) {
      // Descarga de videos distantes: solta a midia da memoria
      try { video.pause(); video.removeAttribute('src'); video.load(); } catch { /* ignore */ }
    }
  }

  // Preenchido no return (o menu do post precisa remover o slide da tela).
  let slideApi = null;

  // ---- comportamento do video ----
  function attachVideoBehavior(node) {
    const onClick = () => {
      // O mesmo toque que ligou o som nao deve tambem pausar o video.
      if (soundHandledGesture) { soundHandledGesture = false; return; }
      togglePlay();
    };
    node.addEventListener('click', onClick);
    cleanups.push(() => node.removeEventListener('click', onClick));

    const onTime = () => {
      const duration = Number(node.duration) || 0;
      const percent = duration ? (node.currentTime / duration) * 100 : 0;
      progress.style.width = `${percent}%`;
      if (duration && node.currentTime >= duration * 0.92) wasCompleted = true;
    };
    node.addEventListener('timeupdate', onTime);
    cleanups.push(() => node.removeEventListener('timeupdate', onTime));

    const onPlay = () => {
      element.classList.remove('paused');
      if (!active) return;
      watchStart = Date.now();
    };
    const onPause = () => {
      element.classList.add('paused');
      if (watchStart) { watchAccum += Date.now() - watchStart; watchStart = 0; }
    };
    const onEnded = () => { flushWatch(true); };
    const onWaiting = () => progress.classList.add('buffering');
    const onPlaying = () => progress.classList.remove('buffering');

    node.addEventListener('play', onPlay);
    node.addEventListener('pause', onPause);
    node.addEventListener('ended', onEnded);
    node.addEventListener('waiting', onWaiting);
    node.addEventListener('playing', onPlaying);
    // Estado do som sempre espelhado do elemento (item 10).
    node.addEventListener('volumechange', syncSoundButton);
    node.addEventListener('mute', syncSoundButton);
    cleanups.push(() => {
      node.removeEventListener('play', onPlay);
      node.removeEventListener('pause', onPause);
      node.removeEventListener('ended', onEnded);
      node.removeEventListener('waiting', onWaiting);
      node.removeEventListener('playing', onPlaying);
      node.removeEventListener('volumechange', syncSoundButton);
      node.removeEventListener('mute', syncSoundButton);
    });
  }

  function togglePlay() {
    if (!video) return;
    if (video.paused) {
      video.play().catch(() => {});
    } else {
      video.pause();
    }
  }

  function toggleMute() {
    if (!video) return;
    video.muted = !video.muted;
    // Chamar play() aqui e um gesto do usuario: se o video estava pausado, ele
    // volta a tocar e o som ja aplica.
    if (!video.paused) return;
    video.play().catch(() => { /* o botao continua disponivel */ });
  }

  /**
  * Estado do botao de som (item 10).
  *
  * NAO existe estado visual paralelo: o botao e desenhado a partir de
  * `video.muted` sempre que o elemento muda - inclusive quando o proprio
  * navegador muda (ou outro codigo). O evento `volumechange` e a fonte da
  * verdade, e `mute` cobre navegadores que nao o disparam para `muted`.
  */
  function syncSoundButton() {
    if (!video || !audioBtn) return;
    const on = !video.muted;
    const label = on ? 'Desativar som' : 'Ativar som';
    audioBtn.dataset.sound = on ? 'on' : 'off';
    audioBtn.setAttribute('aria-label', label);
    audioBtn.setAttribute('title', label);
    audioBtn.setAttribute('aria-pressed', String(on));
    const wanted = on ? 'volume' : 'volumeOff';
    if (audioBtn.dataset.icon !== wanted) {
      audioBtn.dataset.icon = wanted;
      audioBtn.replaceChildren(icon(wanted));
    }
  }

  const play = async () => {
    if (!video || !active) return;
    // Video que ja terminou (voltamos para ele depois do fim) recomeça.
    if (video.ended || (video.currentTime > 0 && video.duration && video.currentTime >= video.duration - 0.15)) {
      try { video.currentTime = 0; } catch { /* ignore */ }
    }
    const muted = store.preferences.autoplayMuted !== false;
    const result = await safePlay(video, { muted });
    syncSoundButton();
    if (result.blockedByPolicy) {
      // Autoplay com som bloqueado: o usuario precisa tocar. Mostramos o icone.
      element.classList.add('paused');
    }
  };

  const toggleLike = async () => {
    if (!isLoggedIn()) { navigate('/entrar'); return; }
    // Otimista; o backend reconcilia
    const previous = likeState.liked;
    likeState.liked = !previous;
    likeState.count += likeState.liked ? 1 : -1;
    if (likeState.count < 0) likeState.count = 0;
    likeBtn.setState(likeState.liked, formatCount(likeState.count));
    try {
      const result = await api.post(`/api/posts/${post.id}/like`, {});
      likeState.liked = result.liked;
      likeState.count = result.counts.likes;
      likeBtn.setState(result.liked, formatCount(result.counts.likes));
    } catch (err) {
      likeState.liked = previous;
      likeState.count += previous ? -1 : 1;
      likeBtn.setState(previous, formatCount(likeState.count));
      toastError(err);
    }
  };

  const toggleFavorite = async () => {
    if (!isLoggedIn()) { navigate('/entrar'); return; }
    const previous = favoriteState.favorited;
    favoriteState.favorited = !previous;
    favoriteBtn.setState(favoriteState.favorited, favoriteState.favorited ? 'Salvo' : 'Salvar');
    try {
      const result = await api.post(`/api/posts/${post.id}/favorite`, {});
      favoriteState.favorited = result.favorited;
      favoriteBtn.setState(result.favorited, result.favorited ? 'Salvo' : 'Salvar');
    } catch (err) {
      favoriteState.favorited = previous;
      favoriteBtn.setState(previous, previous ? 'Salvo' : 'Salvar');
      toastError(err);
    }
  };

  const toggleRepost = async () => {
    if (!isLoggedIn()) { navigate('/entrar'); return; }
    const previous = Boolean(post.viewerState?.reposted);
    try {
      const result = previous
        ? await api.delete(`/api/posts/${post.id}/repost`)
        : await api.post(`/api/posts/${post.id}/repost`, {});
      const count = result.counts?.reposts ?? post.counts.reposts;
      repostBtn.setState(!previous, formatCount(count));
      post.viewerState.reposted = !previous;
      post.counts.reposts = count;
    } catch (err) {
      toastError(err);
    }
  };

  const flushWatch = (completed = false) => {
    if (!isLoggedIn() || reported) return;
    if (!watchAccum && !completed) return;
    const totalMs = watchAccum + (watchStart ? Date.now() - watchStart : 0);
    if (totalMs < 800) return;
    reported = true;
    watchStart = 0;
    recordWatch(post.id, {
      watchMs: totalMs,
      completed: completed || wasCompleted,
      skipped: !completed && totalMs < 2500,
      replayed,
    });
  };

  slideApi = {
    element,
    post,
    activate() {
      active = true;
      element.classList.add('active');
      play();
      flushWatch(false);
    },
    /** Sai de cena mantendo o video carregado (item 6). */
    deactivate,
    preload() {
      if (!video || active) return;
      if (video.preload === 'none') video.preload = 'auto';
      // Aquecimento sem reproduzir nem baixar o arquivo inteiro
      video.load?.();
    },
    play,
    togglePlay,
    toggleMute,
    like: toggleLike,
    authorId: post.author.id,
    teardown: destroySlide,
    /** Remove o slide da tela (usado pelo menu do post). */
    discard() {
      unregisterSlide(slideApi);
      destroySlide();
      element.remove();
    },
  };
  return registerSlide(slideApi);
}

/**
 * Slides vivos do feed.
 *
 * "Ocultar @x" / "Bloquear @x" / "Silenciar @x" precisam tirar da tela TODOS
 * os posts do autor, nao so o do menu. Como `createSlide` nao enxerga o array do
 * feed, o registro vive aqui.
 */
const liveSlides = new Set();

function registerSlide(api) {
  liveSlides.add(api);
  return api;
}

function unregisterSlide(api) {
  liveSlides.delete(api);
}

/** Remove todos os slides de um autor. Devolve quantos foram removidos. */
function discardSlidesByAuthor(authorId) {
  let removed = 0;
  for (const api of [...liveSlides]) {
    if (api.authorId !== authorId) continue;
    api.discard();
    removed += 1;
  }
  return removed;
}

/** Escolhe a melhor fonte disponivel (HLS > rendicao > original). */
function pickStreamUrl(media) {
  return media.normalizedUrl || media.url;
}

/**
 * Aguarda o processamento do video terminar.
 *
 * NOTA: isto NAO tem relacao com a navegacao do feed. E o status da MIDIA de
 * uma publicacao recem-enviada (o ffmpeg ainda esta gerando o arquivo): nao ha
 * como saber sem perguntar, e nenhuma animacao de rolagem depende disso. A
 * navegacao entre publicacoes e rolagem de verdade (item 5), sem nenhum
 * intervalo trocando slide.
 */
function pollMediaStatus(mediaId, badge) {
  let attempts = 0;
  let timer = null;
  const consultar = async () => {
    attempts += 1;
    if (attempts > 90) { clearTimeout(timer); return; }
    try {
      const result = await api.get(`/api/media/${mediaId}/status`);
      const status = result.media?.status;
      if (status === 'ready') {
        clearTimeout(timer);
        location.reload();
      } else if (status === 'failed') {
        clearTimeout(timer);
        badge.textContent = 'Falha no processamento do video';
      } else {
        timer = setTimeout(consultar, 4000);
      }
    } catch {
      // Silencioso: tenta de novo
      timer = setTimeout(consultar, 4000);
    }
  };
  consultar();
}

function actionButton(iconName, label, on, ariaLabel, onClick) {
  const iconNode = icon(iconName, { filled: false });
  const labelNode = el('span', { text: label });
  const node = el('button', {
    type: 'button',
    class: `act${on ? ' on' : ''}`,
    'aria-label': ariaLabel,
    'aria-pressed': String(Boolean(on)),
    onClick,
  }, [iconNode, labelNode]);
  return {
    node,
    label: labelNode,
    setState(active, text) {
      node.classList.toggle('on', Boolean(active));
      node.setAttribute('aria-pressed', String(Boolean(active)));
      labelNode.textContent = text;
    },
  };
}

export { createSlide };
