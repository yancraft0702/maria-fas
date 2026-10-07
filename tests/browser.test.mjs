/**
 * Testes de navegador (Chrome headless via CDP).
 *
 * Verificam o que so existe no navegador de verdade:
 *  - boot da PWA sem erro de console e sem requisicao quebrada
 *  - login, rotas e navegacao (SPA) sem recarregar a pagina
 *  - feed renderizando posts reais vindos da API
 *  - ausencia de rolagem horizontal em 320/360/390/414/768/1024/1280/1440/1920
 *  - LIVE com MediaStream REAL: getUserMedia -> RTCPeerConnection -> ontrack,
 *    com bytes efetivamente recebidos pelo espectador
 *  - emoji: UMA insercao por clique, sem duplicar com pointer/touch
 *  - YouTube: apenas o player oficial, sem controles duplicados
 *  - service worker + manifest + instalabilidade
 */
import {
  startServer, Client, Report, makeTestImage, makeTestVideo, randomUsername, sleep, waitUntil,
} from './helpers.mjs';
import { launchChrome, findChrome } from './cdp.mjs';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

const report = new Report('Navegador (Chrome headless)');

const WIDTHS = [320, 360, 390, 414, 768, 1024, 1280, 1440, 1920];

async function run() {
  if (!findChrome()) {
    report.fail('Chrome nao encontrado', new Error('sem binario do Chrome neste ambiente'));
    return report.summary();
  }

  const server = await startServer();
  report.ok('servidor no ar', server.baseUrl);

  // Seed: uma conta com video publicado, para o feed ter conteudo real.
  const author = new Client(server.baseUrl);
  await author.register({ username: randomUsername('artista') });
  const notificationFixtures = {
    message: randomUUID(),
    system: randomUUID(),
  };
  const fixtureDb = new DatabaseSync(server.databasePath);
  const insertNotification = fixtureDb.prepare(
    `INSERT INTO notifications
      (id, user_id, actor_id, type, entity_type, entity_id, body, payload_json, created_at)
     VALUES (?, ?, NULL, ?, '', '', ?, '{}', ?)`,
  );
  insertNotification.run(notificationFixtures.message, author.user.id, 'message', 'mensagem de teste', Date.now());
  insertNotification.run(notificationFixtures.system, author.user.id, 'system', 'aviso de sistema de teste', Date.now() + 1);
  fixtureDb.close();
  const video = await makeTestVideo({ seconds: 2, width: 480, height: 854, withAudio: true });
  const upload = await author.upload('/api/media/upload?purpose=video', video.buffer, {
    filename: video.filename, mime: video.mime,
  });
  const mediaId = upload.body.media.id;
  report.ok('conteudo de origem semeado', `media ${mediaId}`);

  // Publica e ESPERA o processamento terminar: o teste precisa de video pronto
  // para tocar de verdade no navegador.
  const post = await author.post('/api/posts', {
    type: 'video', mediaId, caption: 'video de teste do navegador #pulse',
  });
  const videoPost = post.body.post;
  const historicalTextPost = await author.post('/api/posts', {
    type: 'text', caption: 'historico publico anterior da autora',
  });
  const otherAuthor = new Client(server.baseUrl);
  await otherAuthor.register({ username: randomUsername('outroautor') });
  const otherHistoricalPost = await otherAuthor.post('/api/posts', {
    type: 'text', caption: 'historico publico anterior de outro autor',
  });
  const historicalPosts = [videoPost, historicalTextPost.body.post, otherHistoricalPost.body.post];
  for (let index = 0; index < 7; index += 1) {
    const publisher = index % 2 ? otherAuthor : author;
    const historical = await publisher.post('/api/posts', {
      type: 'text', caption: `historico publico paginado ${index + 1}`,
    });
    historicalPosts.push(historical.body.post);
  }
  const restrictedPost = await author.post('/api/posts', {
    type: 'text', caption: 'post nao publico para seguidores', visibility: 'followers',
  });
  const newcomer = new Client(server.baseUrl);
  const newcomerUser = await newcomer.register({ username: randomUsername('recem') });
  const ready = await waitUntil(async () => {
    const { body } = await author.get(`/api/media/${mediaId}/status`);
    if (body.media.status === 'failed') throw new Error(`midia falhou: ${body.media.error}`);
    return body.media.status === 'ready' ? body.media : null;
  }, { timeoutMs: 120000, intervalMs: 800 });
  report.ok('video processado e pronto', `${ready.width}x${ready.height}, ${ready.durationMs}ms`);
  const activeRoom = await author.post('/api/live', { title: 'Titulo interno nao exibido no diretorio' });
  const activeRoomId = activeRoom.body.room.id;

  let browser = null;
  const sessions = [];

  try {
    browser = await launchChrome();
    report.ok('Chrome headless aberto', 'CDP conectado');

    const page = browser.newPage ? null : null;
    void page;
    const app = await browser.newPage();
    sessions.push(app);
    app.watch();

    // ------------------------------------------------------------ BOOT DA PWA
    await report.step('app carrega sem erro de console', async () => {
      await app.goto(`${server.baseUrl}/`, { waitMs: 800 });
      const title = await app.eval('return document.title;');
      if (!title || !title.includes('MARIA FÃS')) throw new Error(`titulo "${title}"`);
      if (app.pageErrors.length) throw new Error(`pageError: ${app.pageErrors[0]}`);
      // Erros de console so contam se NAO forem de rede/404 de recurso opcional.
      const real = app.consoleErrors.filter((e) => !/favicon|manifest.*404|net::ERR_FILE/i.test(e));
      if (real.length) throw new Error(`console: ${real.slice(0, 2).join(' | ')}`);
      return `title "${title}"`;
    });

    await report.step('nenhuma requisicao de rede quebrada no boot', async () => {
      const broken = app.failedRequests.filter(
        (f) => !/net::ERR_ABORTED|favicon/i.test(f.error || ''),
      );
      if (broken.length) {
        const map = new Map();
        for (const f of broken) map.set(f.error, (map.get(f.error) || 0) + 1);
        throw new Error([...map].map(([k, v]) => `${k} x${v}`).join(', '));
      }
      return `${app.requests.length} requisicoes, 0 falha`;
    });

    await report.step('service worker registrado e manifesto valido', async () => {
      const sw = await app.waitForFunction(
        'navigator.serviceWorker && navigator.serviceWorker.controller !== undefined',
        10_000,
      );
      void sw;
      const manifestHref = await app.eval(
        'return document.querySelector(\'link[rel="manifest"]\')?.href || null;',
      );
      if (!manifestHref) throw new Error('manifest nao linkado no HTML');
      const manifest = await app.eval(`
        const res = await fetch(document.querySelector('link[rel="manifest"]').href);
        const json = await res.json();
        return {
          ok: res.ok,
          name: json.name,
          icons: (json.icons || []).length,
          display: json.display,
          startUrl: json.start_url,
        };
      `);
      if (!manifest.ok) throw new Error('manifesto nao carrega');
      if (manifest.icons < 2) throw new Error(`manifesto com ${manifest.icons} icones`);
      if (manifest.display !== 'standalone') throw new Error(`display=${manifest.display}`);
      // Os icones precisam responder de verdade
      const iconStatus = await app.eval(`
        const res = await fetch(document.querySelector('link[rel="manifest"]').href);
        const json = await res.json();
        const results = [];
        for (const icon of json.icons) {
          const r = await fetch(icon.src);
          results.push(r.status);
        }
        return results;
      `);
      if (iconStatus.some((s) => s !== 200)) throw new Error(`icones com status ${iconStatus.join(',')}`);
      return `manifest "${manifest.name}" com ${manifest.icons} icones`;
    });

    // --------------------------------------------------------------- LOGIN
    await report.step('login pela interface cria sessao', async () => {
      const email = `${author.user.username}@pulse.test`;
      // A UI tem um formulario de login; usamos a API para semear a sessao e
      // depois validamos a navegacao autenticada com o mesmo cookie.
      const login = await author.post('/api/auth/login', { email, password: 'Senha@Teste123' });
      if (login.status !== 200) throw new Error(`login ${login.status}`);
      const cookies = await fetch(`${server.baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: 'Senha@Teste123' }),
      });
      for (const cookie of cookies.headers.getSetCookie()) {
        const [pair] = cookie.split(';');
        const [name, value] = pair.split('=');
        // Injeta a cookie real no perfil do Chrome via CDP.
        // eslint-disable-next-line no-await-in-loop
        await app.send('Network.setCookie', {
          name, value: decodeURIComponent(value), domain: '127.0.0.1', path: '/',
        });
      }
      await app.goto(`${server.baseUrl}/`, { waitMs: 600 });
      const authed = await app.eval(`
        const res = await fetch('/api/auth/me', { credentials: 'include' });
        const json = await res.json();
        return json.authenticated === true;
      `);
      if (!authed) throw new Error('a sessao nao chegou ao navegador');
      return 'cookie de sessao aceito pelo navegador';
    });

    await report.step('usuario recem-cadastrado recebe historico publico e segue em realtime', async () => {
      const page = await browser.newBrowserContext();
      sessions.push(page);
      page.watch();
      const login = await fetch(`${server.baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          identifier: newcomerUser.username,
          password: 'Senha@Teste123',
        }),
      });
      if (!login.ok) throw new Error(`login do usuario novo: HTTP ${login.status}`);
      for (const cookie of login.headers.getSetCookie()) {
        const [pair] = cookie.split(';');
        const [name, value] = pair.split('=');
        await page.send('Network.setCookie', {
          name, value: decodeURIComponent(value), domain: '127.0.0.1', path: '/',
        });
      }
      await page.goto(`${server.baseUrl}/`, { waitMs: 1200 });
      const initial = await page.waitForFunction(`
        const ids = [...document.querySelectorAll('.feed-stage .slide[data-post-id]')]
          .map((node) => node.dataset.postId);
        return ids.length ? ids : null;
      `, 12_000);
      if (initial.length !== 6) {
        throw new Error(`a primeira pagina do historico deveria conter 6 cards, recebeu ${initial.length}`);
      }
      if (initial.includes(restrictedPost.body.post.id)) {
        throw new Error('post followers apareceu no feed publico inicial');
      }

      const firstLive = await author.post('/api/posts', {
        type: 'text', caption: 'novo post publico em realtime autor A',
      });
      const secondLive = await otherAuthor.post('/api/posts', {
        type: 'text', caption: 'novo post publico em realtime autor B',
      });
      const newPublicPosts = [firstLive.body.post, secondLive.body.post];
      const expectedOrder = [...newPublicPosts].sort((a, b) => {
        const timeDifference = Number(b.publishedAt) - Number(a.publishedAt);
        return timeDifference || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
      }).map((item) => item.id);

      const received = await page.waitForFunction(`
        const wanted = new Set(${JSON.stringify(newPublicPosts.map((item) => item.id))});
        const nodes = [...document.querySelectorAll('.feed-stage .slide[data-post-id]')];
        const ids = nodes.map((node) => node.dataset.postId);
        return [...wanted].every((id) => ids.includes(id)) ? ids : null;
      `, 12_000);
      const filteredOrder = received.filter((id) => expectedOrder.includes(id));
      if (filteredOrder.join(',') !== expectedOrder.join(',')) {
        throw new Error(`ordem realtime incorreta: ${filteredOrder.join(',')} != ${expectedOrder.join(',')}`);
      }
      for (const post of newPublicPosts) {
        const count = await page.eval(`
          return document.querySelectorAll('[data-post-id="${post.id}"]').length;
        `);
        if (count !== 1) throw new Error(`post realtime ${post.id} duplicado (${count} cards)`);
      }
      if ((await page.eval(`return document.querySelectorAll('[data-post-id="${restrictedPost.body.post.id}"]').length;`)) !== 0) {
        throw new Error('conteudo restrito apareceu via realtime');
      }

      const expectedFeedIds = [...historicalPosts.map((item) => item.id), ...newPublicPosts.map((item) => item.id)];
      const pagedIds = await page.eval(`
        const expected = ${JSON.stringify(expectedFeedIds)};
        const stage = document.querySelector('.feed-stage');
        for (let attempt = 0; attempt < 10; attempt += 1) {
          stage.scrollTop = stage.scrollHeight;
          stage.dispatchEvent(new Event('scroll'));
          await new Promise((resolve) => setTimeout(resolve, 300));
          const ids = [...stage.querySelectorAll('.slide[data-post-id]')].map((node) => node.dataset.postId);
          if (expected.every((id) => ids.includes(id))) return ids;
        }
        return [...stage.querySelectorAll('.slide[data-post-id]')].map((node) => node.dataset.postId);
      `);
      for (const id of expectedFeedIds) {
        if (!pagedIds.includes(id)) throw new Error(`post publico historico ausente apos paginacao: ${id}`);
        const count = await page.eval(`return document.querySelectorAll('[data-post-id="${id}"]').length;`);
        if (count !== 1) throw new Error(`post ${id} duplicado apos paginacao (${count} cards)`);
      }
      if (pagedIds.includes(restrictedPost.body.post.id)) {
        throw new Error('post restrito apareceu em pagina posterior');
      }

      await page.goto(`${server.baseUrl}/`, { waitMs: 1000 });
      const afterReload = await page.waitForFunction(`
        const ids = [...document.querySelectorAll('.feed-stage .slide[data-post-id]')]
          .map((node) => node.dataset.postId);
        const required = ${JSON.stringify(newPublicPosts.map((item) => item.id))};
        return required.every((id) => ids.includes(id)) ? ids : null;
      `, 12_000);
      if (afterReload.includes(restrictedPost.body.post.id)) {
        throw new Error('post restrito apareceu depois de recarregar');
      }
      return `${historicalPosts.length} posts historicos paginados + 2 posts novos sem F5, ordenados e deduplicados; reload preserva realtime (${afterReload.length} cards)`;
    });

    await report.step('realtime do navegador autentica pela cookie', async () => {
      await app.waitForFunction(`
        const c = window.__PULSE_DEBUG__?.realtime;
        return !!(c && c.isAuthenticated && c.isAuthenticated());
      `, 15_000).catch((error) => {
        throw new Error(`socket nao autenticou pela cookie: ${error.message}`);
      });
      const stats = await app.eval('return window.__PULSE_DEBUG__.realtime.stats();');
      if (!stats.userId) throw new Error('userId ausente no cliente realtime');
      return `socket autenticado como ${String(stats.userId).slice(0, 12)}...`;
    });

    // ---------------------------------------------------------------- FEED
    await report.step('feed renderiza o video real da API', async () => {
      await app.eval(`
        const stage = document.querySelector('.feed-stage');
        const videoPostId = ${JSON.stringify(videoPost.id)};
        for (let attempt = 0; attempt < 10 && !stage.querySelector(\`.slide[data-post-id="\${videoPostId}"]\`); attempt += 1) {
          stage.scrollTop = stage.scrollHeight;
          stage.dispatchEvent(new Event('scroll'));
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
        const slide = stage.querySelector(\`.slide[data-post-id="\${videoPostId}"]\`);
        if (!slide) return false;
        stage.scrollTop = [...stage.querySelectorAll('.slide')].indexOf(slide) * stage.clientHeight;
        await new Promise((resolve) => setTimeout(resolve, 200));
        return slide.classList.contains('active');
      `);
      const info = await app.waitForFunction(`
        const slides = document.querySelectorAll('.slide[data-post-id]');
        const target = document.querySelector('.slide[data-post-id="${videoPost.id}"]');
        if (!target || !target.classList.contains('active')) return null;
        const videos = target.querySelectorAll('video');
        return {
          slides: slides.length,
          videos: videos.length,
          texts: document.body.innerText.length,
          postId: target.dataset.postId || null,
        };
      `, 15_000).catch((error) => {
        throw new Error(`feed nao renderizou: ${error.message}`);
      });
      if (info.texts < 20) throw new Error('pagina praticamente vazia');
      if (info.postId !== videoPost.id) throw new Error(`post ativo inesperado: ${info.postId}`);
      return `${info.slides} slides, ${info.videos} <video>, post=${info.postId}`;
    });

    await report.step('o video do feed carrega e reproduz (readyState >= 2)', async () => {
      const state = await app.waitForFunction(`
        const video = document.querySelector('.slide[data-post-id="${videoPost.id}"] video');
        if (!video) return null;
        if (video.readyState < 2) return null;
        return {
          readyState: video.readyState,
          width: video.videoWidth,
          height: video.videoHeight,
          src: video.currentSrc || video.src,
          hasPoster: Boolean(video.poster),
        };
      `, 20_000).catch((error) => {
        throw new Error(`video nao carregou: ${error.message}`);
      });
      if (!state.width || !state.height) throw new Error(`video ${state.width}x${state.height}`);
      if (!state.src.includes('/api/media/')) throw new Error(`src inesperado: ${state.src}`);
      return `${state.width}x${state.height} readyState=${state.readyState} poster=${state.hasPoster}`;
    });

    await report.step('Para voce ignora LIVE recebida na pagina inicial', async () => {
      const result = await app.eval(`
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const tab = (label) => [...document.querySelectorAll('.feed-tabs [role="tab"]')]
          .find((node) => node.textContent.trim() === label);
        const originalFetch = window.fetch.bind(window);
        let intercepted = 0;
        window.fetch = async (input, init) => {
          const url = String(input);
          if (url.includes('/api/feed/for-you')) {
            intercepted += 1;
            return new Response(JSON.stringify({
              posts: [{ id: 'live-initial-client-filter-test', type: 'live' }],
            }), { status: 200, headers: { 'Content-Type': 'application/json' } });
          }
          return originalFetch(input, init);
        };
        tab('Seguindo').click();
        await wait(150);
        tab('Para voce').click();
        await wait(150);
        const excluded = !document.querySelector('[data-post-id="live-initial-client-filter-test"]')
          && Boolean(document.querySelector('.feed-stage .page-empty'));
        window.fetch = originalFetch;
        tab('Seguindo').click();
        await wait(150);
        tab('Para voce').click();
        await wait(1500);
        return { intercepted, excluded, restored: document.querySelectorAll('.slide[data-post-id]').length };
      `);
      if (!result.intercepted) throw new Error('a pagina inicial Para voce nao foi interceptada');
      if (!result.excluded) throw new Error('uma LIVE apareceu na pagina inicial Para voce');
      if (!result.restored) throw new Error('o feed normal nao voltou após o teste');
      return `LIVE filtrada; feed normal restaurado com ${result.restored} slides`;
    });

    await report.step('Para voce ignora LIVE recebida por realtime', async () => {
      const before = await app.eval('return document.querySelectorAll(".slide[data-post-id]").length;');
      const after = await app.eval(`
        window.__PULSE_DEBUG__.realtime.emit('POST_CREATED', {
          post: { id: 'live-realtime-client-filter-test', type: 'live' },
        });
        return document.querySelectorAll('.slide[data-post-id]').length;
      `);
      const found = await app.eval(`
        return Boolean(document.querySelector('[data-post-id="live-realtime-client-filter-test"]'));
      `);
      if (found || after !== before) throw new Error('a LIVE realtime entrou no feed Para voce');
      return `${after} slides mantidos após evento LIVE`;
    });

    await report.step('nenhum item da resposta aparece como undefined/NaN', async () => {
      const text = await app.eval('return document.body.innerText;');
      const bad = [];
      if (/undefined/.test(text)) bad.push('"undefined"');
      if (/\bNaN\b/.test(text)) bad.push('NaN');
      if (/\bnull\b\s*$/.test(text)) bad.push('"null" solto');
      if (bad.length) throw new Error(`renderizou ${bad.join(', ')}`);
      return 'texto limpo';
    });

    // ------------------------------------------- IDENTIDADE / NAVEGACAO (produto)
    await report.step('a barra de busca grande saiu; a lupa ficou ao lado das abas', async () => {
      const info = await app.eval(`
        return {
          bigBar: Boolean(document.querySelector('#search-form')),
          tabs: [...document.querySelectorAll('.feed-tabs [role="tab"]')].map((t) => t.textContent.trim()),
          lupa: Boolean(document.querySelector('.feed-tabs .feed-search-btn')),
          lupaLabel: document.querySelector('.feed-tabs .feed-search-btn')?.getAttribute('aria-label') || null,
          liveLink: document.querySelector('.feed-tabs .feed-live-link')?.textContent.trim() || null,
          feedOrder: [...document.querySelectorAll('.feed-tabs [role="tab"], .feed-tabs .feed-live-link, .feed-tabs .feed-search-btn')]
            .map((t) => t.textContent.trim() || t.getAttribute('aria-label')),
          navItems: [...document.querySelectorAll('#tabbar [data-nav]')].map((n) => n.dataset.nav),
          lowerLive: Boolean(document.querySelector('#tabbar [data-nav="live"]')),
          sidebarLive: Boolean(document.querySelector('#side-nav [data-nav="live"]')),
          tabStyle: (() => {
            const s = getComputedStyle(document.querySelector('.feed-tabs [role="tab"]:nth-child(2)'));
            return { font: s.font, fontFamily: s.fontFamily, fontSize: s.fontSize,
              fontWeight: s.fontWeight, lineHeight: s.lineHeight, height: s.height,
              color: s.color, padding: s.padding };
          })(),
          liveStyle: (() => {
            const s = getComputedStyle(document.querySelector('.feed-live-link'));
            return { font: s.font, fontFamily: s.fontFamily, fontSize: s.fontSize,
              fontWeight: s.fontWeight, lineHeight: s.lineHeight, height: s.height,
              color: s.color, padding: s.padding };
          })(),
          railIcons: document.querySelectorAll('.rail').length,
          sideNav: document.querySelectorAll('#side-nav a').length,
        };
      `);
      if (info.bigBar) throw new Error('a barra #search-form continua na tela');
      if (!info.lupa) throw new Error('a lupa nao esta ao lado das abas');
      if (info.liveLink !== 'Ao vivo') throw new Error('atalho Ao vivo ausente no tab strip principal');
      if (info.feedOrder.join(' -> ') !== 'Para voce -> Seguindo -> Amigos -> Ao vivo -> Buscar') {
        throw new Error(`ordem das abas: ${info.feedOrder.join(' / ')}`);
      }
      if (info.lowerLive) throw new Error('Ao Vivo ainda aparece na barra inferior');
      if (!info.sidebarLive) throw new Error('Ao Vivo foi removido tambem da navegacao desktop');
      if (JSON.stringify(info.tabStyle) !== JSON.stringify(info.liveStyle)) {
        throw new Error(`tipografia do Ao Vivo diverge da aba inativa: ${JSON.stringify([info.tabStyle, info.liveStyle])}`);
      }
      if (info.railIcons !== 0) throw new Error('os 5 icones redundantes voltaram');
      if (info.sideNav < 3) throw new Error('a navegacao da sidebar foi quebrada');
      if (info.tabs.length !== 3) throw new Error(`abas: ${info.tabs.join(', ')}`);
      return `abas ${info.tabs.join(' / ')} / ${info.liveLink} / lupa, tabbar ${info.navItems.join(' / ')}`;
    });

    await report.step('Ao Vivo nao duplica na barra inferior em desktop e mobile', async () => {
      const results = [];
      for (const width of [1280, 390]) {
        await app.send('Emulation.setDeviceMetricsOverride', {
          width, height: 844, deviceScaleFactor: 1, mobile: width < 700,
        });
        const info = await app.eval(`
          return {
            lowerLive: Boolean(document.querySelector('#tabbar [data-nav="live"]')),
            upperLive: document.querySelector('.feed-tabs .feed-live-link')?.textContent.trim() || null,
            sideLive: Boolean(document.querySelector('#side-nav [data-nav="live"]')),
            standardTab: (() => {
              const s = getComputedStyle(document.querySelector('.feed-tabs [role="tab"]:nth-child(2)'));
              return [s.fontFamily, s.fontSize, s.fontWeight, s.lineHeight, s.height, s.color, s.padding].join('|');
            })(),
            liveTab: (() => {
              const s = getComputedStyle(document.querySelector('.feed-live-link'));
              return [s.fontFamily, s.fontSize, s.fontWeight, s.lineHeight, s.height, s.color, s.padding].join('|');
            })(),
          };
        `);
        if (info.lowerLive || info.upperLive !== 'Ao vivo' || !info.sideLive) {
          throw new Error(`${width}px: bottom=${info.lowerLive}, top=${info.upperLive}, sidebar=${info.sideLive}`);
        }
        if (info.standardTab !== info.liveTab) {
          throw new Error(`${width}px: estilos superiores diferentes; tab=${info.standardTab}, live=${info.liveTab}`);
        }
        results.push(`${width}px`);
      }
      await app.send('Emulation.clearDeviceMetricsOverride');
      return results.join(' e ');
    });

    await report.step('marcar todas como lidas mantém mensagens e sistema visíveis após reload', async () => {
      const seeded = await author.get('/api/notifications');
      for (const id of Object.values(notificationFixtures)) {
        if (!seeded.body.notifications.some((item) => item.id === id)) {
          throw new Error(`fixture de notificacao ${id} ausente na API`);
        }
      }
      await app.goto(`${server.baseUrl}/notificacoes`, { waitMs: 0 });
      const before = await app.waitForFunction(`
        const ids = [...document.querySelectorAll('.list-item[data-id]')].map((item) => item.dataset.id);
        return ${JSON.stringify(Object.values(notificationFixtures))}.every((id) => ids.includes(id))
          ? ids
          : null;
      `, 10_000).catch(async (error) => {
        const state = await app.eval(`
          return {
            path: location.pathname,
            title: document.body.innerText.slice(0, 200),
            auth: await fetch('/api/auth/me').then((response) => response.json()),
            notifications: await fetch('/api/notifications').then((response) => response.json()),
            ids: [...document.querySelectorAll('.list-item[data-id]')].map((item) => item.dataset.id),
          };
        `);
        throw new Error(`${error.message}; UI=${JSON.stringify(state)}`);
      });
      for (const id of Object.values(notificationFixtures)) {
        if (!before.includes(id)) throw new Error(`notificacao ${id} nao foi exibida antes de marcar`);
      }
      await app.eval(`
        [...document.querySelectorAll('button')]
          .find((button) => button.textContent.trim() === 'Marcar todas como lidas')?.click();
        return true;
      `);
      await app.waitForFunction(
        `document.querySelectorAll('.list-item[data-id]').length >= ${before.length}`,
        10_000,
      );
      const marked = await author.get('/api/notifications');
      if (marked.body.unread !== 0) throw new Error(`contador de nao lidas ${marked.body.unread}`);
      const markedById = new Map(marked.body.notifications.map((item) => [item.id, item]));
      for (const id of Object.values(notificationFixtures)) {
        if (!markedById.get(id)?.read) throw new Error(`notificacao ${id} nao persistiu como lida`);
      }
      await app.goto(`${server.baseUrl}/notificacoes`, { waitMs: 700 });
      const after = await app.eval(`
        return [...document.querySelectorAll('.list-item[data-id]')].map((item) => item.dataset.id);
      `);
      for (const id of Object.values(notificationFixtures)) {
        if (!after.includes(id)) throw new Error(`notificacao ${id} sumiu depois do reload`);
      }
      if (after.length !== before.length) throw new Error(`lista mudou: ${before.length} -> ${after.length}`);
      await app.goto(`${server.baseUrl}/`, { waitMs: 700 });
      return `${after.length} notificacoes mantidas, contador 0; mensagem e sistema lidos`;
    });

    await report.step('troca Para voce -> Seguindo -> Amigos -> Para voce nao perde o feed', async () => {
      const cycle = await app.eval(`
        const tab = (label) => [...document.querySelectorAll('.feed-tabs [role="tab"]')]
          .find((t) => t.textContent.trim() === label);
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const out = [];
        const first = document.querySelectorAll('.slide[data-post-id]').length;
        for (const name of ['Seguindo', 'Amigos', 'Para voce']) {
          const b = tab(name);
          if (!b) continue;
          b.click();
          await wait(1500);
          out.push({
            name,
            slides: document.querySelectorAll('.slide[data-post-id]').length,
            empty: Boolean(document.querySelector('.page-empty')),
          });
        }
        return { first, out };
      `);
      const voltar = cycle.out.find((c) => c.name === 'Para voce');
      if (!voltar) throw new Error('aba "Para voce" nao foi encontrada');
      if (voltar.slides === 0) {
        throw new Error('voltou para "Para voce" sem videos (estado vazio incorreto)');
      }
      const others = cycle.out.filter((c) => c.name !== 'Para voce');
      for (const item of others) {
        if (item.slides > 0) throw new Error(`"${item.name}" mostrou conteudo de outra aba`);
      }
      return `inicial=${cycle.first}, voltar=${voltar.slides} slides, Seguindo/Amigos vazios de verdade`;
    });

    await report.step('a busca continua funcionando na tela /busca', async () => {
      await app.eval(`
        document.querySelector('.feed-tabs .feed-search-btn').click();
        return true;
      `);
      await sleep(1500);
      const info = await app.eval(`
        return {
          path: location.pathname,
          hasInput: Boolean(document.querySelector('input[type="search"], .search input, #busca-input')),
          text: document.body.innerText.slice(0, 120),
        };
      `);
      if (info.path !== '/busca') throw new Error(`foi para ${info.path}`);
      if (/undefined/.test(info.text)) throw new Error('a tela de busca renderizou "undefined"');
      if (!info.hasInput) throw new Error('sem campo de busca na tela');
      return `tela ${info.path} com campo de busca`;
    });

    await report.step('AO VIVO mostra INICIAR LIVE e leva a transmissao real', async () => {
      await app.eval(`
        document.querySelector('#side-nav a[data-nav="live"]').click();
        return true;
      `);
      await sleep(2000);
      const info = await app.eval(`
        const btn = document.querySelector('.live-start-btn');
        const title = document.querySelector('.page-title');
        const box = btn ? btn.getBoundingClientRect() : null;
        return {
          path: location.pathname,
          hasBlock: Boolean(document.querySelector('.live-start')),
          label: btn ? btn.textContent.trim() : null,
          href: btn ? btn.getAttribute('href') : null,
          height: box ? Math.round(box.height) : 0,
          nearTitle: title && box ? box.top - title.getBoundingClientRect().bottom < 280 : false,
          activeRoom: document.querySelector('.live-directory-item')?.innerText || null,
          liveHref: document.querySelector('.live-directory-join')?.getAttribute('href') || null,
          text: document.body.innerText.slice(0, 100),
        };
      `);
      if (!info.hasBlock) throw new Error('a acao de iniciar LIVE nao aparece');
      if (!/INICIAR LIVE/i.test(info.label || '')) throw new Error(`rotulo "${info.label}"`);
      if (info.href !== '/iniciar-live') throw new Error(`destino ${info.href}`);
      if (info.height < 42) throw new Error(`botao pequeno: ${info.height}px`);
      if (!info.nearTitle) throw new Error('a acao nao esta entre as primeiras coisas visiveis');
      if (!info.activeRoom?.includes(`@${author.user.username}`)) throw new Error(`perfil ativo ausente: ${info.activeRoom}`);
      if (!/há \d+(s|min|h)/.test(info.activeRoom)) throw new Error(`duração nao calculada desde startedAt: ${info.activeRoom}`);
      if (!info.activeRoom.includes('0 espectadores')) throw new Error(`contagem de espectadores incorreta: ${info.activeRoom}`);
      if (info.activeRoom.includes('Titulo interno nao exibido')) throw new Error('titulo foi exibido no diretório');
      if (info.liveHref !== `/live/${activeRoomId}`) throw new Error(`destino de entrada inesperado: ${info.liveHref}`);
      if (/undefined/.test(info.text)) throw new Error('a tela AO VIVO renderizou "undefined"');
      const subscription = await app.eval('return window.__PULSE_DEBUG__.realtime.subs.has("live:directory");');
      if (!subscription) throw new Error('a tela nao assinou live:directory');
      const beforeRefresh = app.requests.filter((request) => request.url.includes('/api/lives/active')).length;
      await app.eval(`window.__PULSE_DEBUG__.realtime.emit('LIVE_DIRECTORY_CHANGE', {});`);
      await waitUntil(
        () => app.requests.filter((request) => request.url.includes('/api/lives/active')).length > beforeRefresh,
        { timeoutMs: 5000, intervalMs: 100 },
      );
      await author.post(`/api/live/${activeRoomId}/end`, {});
      return `"${info.label}" + perfil ativo e duração real em ${info.path}`;
    });

    await report.step('aviso de push: some com "Agora nao" e o botao volta a funcionar', async () => {
      const info = await app.eval(`
        const p = document.getElementById('push-prompt');
        const dismiss = document.getElementById('push-dismiss');
        const accept = document.getElementById('push-accept');
        if (!p || !dismiss || !accept) return { erro: 'aviso sem os dois botoes' };
        const oculto = () => p.hidden && getComputedStyle(p).display === 'none';

        p.hidden = true; dismiss.click();
        await new Promise((r) => setTimeout(r, 150));
        const depoisDeAgoraNao = oculto();
        const lembrado = localStorage.getItem('pulse_push_dismissed') === '1';

        p.hidden = false; accept.click();
        await new Promise((r) => setTimeout(r, 800));
        return {
          depoisDeAgoraNao,
          lembrado,
          sumiuDepoisDeAtivar: oculto(),
          botaoLiberado: !accept.disabled,
          rotulo: accept.textContent.trim(),
        };
      `);
      if (info.erro) throw new Error(info.erro);
      if (!info.depoisDeAgoraNao) throw new Error('"Agora nao" nao fechou o aviso');
      if (!info.lembrado) throw new Error('a recusa nao foi lembrada');
      if (!info.sumiuDepoisDeAtivar) throw new Error('"Ativar" nao fechou o aviso');
      if (!info.botaoLiberado) throw new Error('o botao "Ativar" ficou travado');
      return `Agora nao -> oculto, Ativar -> oculto e liberado ("${info.rotulo}")`;
    });

    await report.step('tela de entrada: so usuario e senha, com coracao animado', async () => {
      // Sessao isolada, sem cookie: e a tela de entrada de verdade.
      const guest = await browser.newBrowserContext();
      sessions.push(guest);
      guest.watch();
      await guest.goto(`${server.baseUrl}/configuracoes`, { waitMs: 2500 });
      const info = await guest.eval(`
        const inputs = [...document.querySelectorAll('.auth-card input:not([hidden])')];
        const labels = [...document.querySelectorAll('.auth-card label')].map((l) => l.textContent.replace(':', ''));
        const heart = document.querySelector('.brand-heart');
        const logo = document.querySelector('.brand-logo');
        return {
          title: document.title,
          heart: Boolean(heart),
          heartAnim: heart ? getComputedStyle(heart).animationName : null,
          logoAnim: logo ? getComputedStyle(logo).animationName : null,
          wordmark: document.querySelector('.brand-wordmark')?.textContent || null,
          ids: inputs.map((i) => i.id),
          labels,
          temEmail: inputs.some((i) => i.id.includes('email')),
          temForms: inputs.length >= 2,
        };
      `);
      if (!info.title.includes('MARIA FÃS')) throw new Error(`titulo "${info.title}"`);
      if (!info.temForms) throw new Error('o formulario nao renderizou os campos');
      if (info.temEmail) throw new Error('ainda pede email na interface');
      if (!/^(Usuario|Senha)$/.test(info.labels[0] || '')) throw new Error(`primeiro campo: ${info.labels[0]}`);
      if (!info.heart || info.heartAnim === 'none') throw new Error('coracao sem animacao');
      if (info.logoAnim === 'none') throw new Error('logo sem entrada suave');
      if (info.wordmark !== 'MARIA FÃS') throw new Error(`wordmark "${info.wordmark}"`);
      await guest.goto(`${server.baseUrl}/`, { waitMs: 200 });
      return `${info.labels.join(' + ')} | coracao "${info.heartAnim}" | entrada "${info.logoAnim}"`;
    });

    await report.step('navegacao e SPA (sem recarregar a pagina)', async () => {
      await app.goto(`${server.baseUrl}/`, { waitMs: 900 });
      const before = await app.eval('return (window.__navMarker = Math.random());');
      const navigated = await app.eval(`
        const link = [...document.querySelectorAll('a[href^="/"], [data-nav]')]
          .find((a) => ['/perfil', '/profile', '/notificacoes', '/mensagens', '/busca']
            .includes(a.getAttribute('href')));
        if (link) { link.click(); return link.getAttribute('href'); }
        return null;
      `);
      await sleep(900);
      const after = await app.eval('return window.__navMarker;');
      if (after !== before) throw new Error('a pagina recarregou (marcador perdido)');
      const url = await app.eval('return location.pathname;');
      if (navigated && url !== navigated) throw new Error(`link ${navigated} levou a ${url}`);
      return `navegou para ${url} sem recarregar`;
    });

    await report.step('deep link direto abre a rota pedida', async () => {
      const deep = await browser.newPage();
      sessions.push(deep);
      deep.watch();
      await deep.goto(`${server.baseUrl}/busca?q=pulse`, { waitMs: 1200 });
      const pathname = await deep.eval('return location.pathname;');
      if (pathname !== '/busca') throw new Error(`deep link abriu ${pathname}`);
      if (deep.pageErrors.length) throw new Error(`erro na rota: ${deep.pageErrors[0]}`);
      await deep.close();
      return 'rota /busca abriu direto';
    });

    await report.step('deep link de notificacao abre a tela correta', async () => {
      const deep = await browser.newPage();
      sessions.push(deep);
      deep.watch();
      await deep.goto(`${server.baseUrl}/notificacoes`, { waitMs: 900 });
      const pathname = await deep.eval('return location.pathname;');
      if (pathname !== '/notificacoes') throw new Error(`abriu ${pathname}`);
      await deep.close();
      return 'rota /notificacoes ok';
    });

    await report.step('a rota 404 da API nunca vira tela de sucesso', async () => {
      const result = await app.eval(`
        try {
          await window.__PULSE_DEBUG__.api.get('/api/posts/pst_inexistente_xyz');
          return { status: 200, code: null };
        } catch (error) {
          return { status: error.status || 0, code: error.code || null };
        }
      `);
      if (result.status !== 404) throw new Error(`status ${result.status}`);
      if (result.code !== 'post_not_found') throw new Error(`code ${result.code}`);
      return `${result.status} ${result.code}`;
    });

    // ------------------------------------------------- ROLAGEM HORIZONTAL
    await report.step('sem rolagem horizontal em 9 larguras', async () => {
      const offenders = [];
      for (const width of WIDTHS) {
        // eslint-disable-next-line no-await-in-loop
        await app.send('Emulation.setDeviceMetricsOverride', {
          width, height: 900, deviceScaleFactor: 1, mobile: width < 768,
        });
        // eslint-disable-next-line no-await-in-loop
        await app.goto(`${server.baseUrl}/`, { waitMs: 450 });
        // eslint-disable-next-line no-await-in-loop
        const overflow = await app.eval(`
          const de = document.documentElement;
          const wide = [...document.querySelectorAll('body *')]
            .filter((el) => {
              const r = el.getBoundingClientRect();
              return r.width > 0 && (r.right > de.clientWidth + 2 || r.left < -2);
            })
            .slice(0, 3)
            .map((el) => el.tagName + '.' + (el.className || '').toString().split(' ')[0]);
          return { scrollWidth: de.scrollWidth, clientWidth: de.clientWidth, wide };
        `);
        if (overflow.scrollWidth > overflow.clientWidth + 2) {
          offenders.push(`${width}px: ${overflow.scrollWidth} > ${overflow.clientWidth} ${overflow.wide.join(',')}`);
        }
      }
      await app.send('Emulation.clearDeviceMetricsOverride');
      if (offenders.length) throw new Error(offenders.join(' | '));
      return `${WIDTHS.length} larguras sem overflow`;
    });

    // --------------------------------------------------------------- EMOJI
    // --------------------------------------------------------------- EMOJI
await report.step('emoji insere exatamente 1 caractere por clique', async () => {
      // Chat global: mesmo `createComposer` dos comentÃ¡rios e da DM.
      await app.goto(`${server.baseUrl}/chat-global`, { waitMs: 1200 });
      const inserted = await app.eval(`
        const field = document.querySelector('textarea[placeholder]');
        if (!field) return { found: false };
        field.value = '';
        field.dispatchEvent(new Event('input', { bubbles: true }));
        field.focus();
        const opener = [...document.querySelectorAll('button[aria-label]')]
          .find((b) => /emoji/i.test(b.getAttribute('aria-label') || ''));
        if (!opener) return { found: true, opener: false };
        opener.click();
        await new Promise((r) => setTimeout(r, 350));
        const panel = document.querySelector('.picker-panel[role="dialog"]');
        if (!panel) return { found: true, opener: true, panel: false };
        const btn = panel.querySelector('.picker-grid button');
        if (!btn) return { found: true, opener: true, panel: true, button: false };
        btn.click();
        await new Promise((r) => setTimeout(r, 250));
        return {
          found: true, opener: true, panel: true, button: true,
          value: field.value, len: field.value.length, codePoints: [...field.value].length,
        };
      `);
      if (!inserted.found) throw new Error('composer nao encontrado');
      if (!inserted.opener) throw new Error('botao de emoji nao encontrado');
      if (!inserted.panel) throw new Error('painel de emoji nao abriu');
      if (!inserted.button) throw new Error('painel sem botoes de emoji');
      // Ponto central do requisito: 1 clique = 1 insercao. Contamos em CODE
      // POINTS (um emoji como ðŸ˜€ ocupa 2 unidades UTF-16).
      if (inserted.codePoints !== 1) {
        throw new Error(`1 clique inseriu ${inserted.codePoints} code point(s) ("${inserted.value}")`);
      }
      return `1 clique -> 1 code point "${inserted.value}" (${inserted.len} unidades UTF-16)`;
    });

    await report.step('eventos duplicados (pointer/mouse/click) nao duplicam a insercao', async () => {
      const result = await app.eval(`
        const field = document.querySelector('textarea[placeholder]');
        field.value = '';
        field.dispatchEvent(new Event('input', { bubbles: true }));
        field.focus();
        const panel = document.querySelector('.picker-panel[role="dialog"]')
          || (() => {
            const opener = [...document.querySelectorAll('button[aria-label]')]
              .find((b) => /emoji/i.test(b.getAttribute('aria-label') || ''));
            opener.click();
            return document.querySelector('.picker-panel[role="dialog"]');
          })();
        const btn = panel?.querySelector('.picker-grid button');
        if (!btn) return { ok: false };
        // Mouse e touch no mesmo alvo + clique explicito: o requisito e' que
        // isso resulte em 2 insercoes (nao 4, nao 1).
        for (const type of ['pointerdown', 'mousedown']) {
          btn.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true }));
        }
        btn.click();
        await new Promise((r) => setTimeout(r, 300));
        return {
          ok: true,
          codePoints: [...field.value].length,
          value: field.value,
        };
      `);
      if (!result.ok) throw new Error('nao foi possivel repetir o teste de emoji');
      if (result.codePoints !== 1) {
        throw new Error(`pointer+mouse+click inseriu ${result.codePoints} code points ("${result.value}")`);
      }
      return '1 clique (com pointer+mouse) -> 1 code point';
    });

    await report.step('emoji do comentario abre o painel sem inserir nada', async () => {
      // Volta para o feed (o passo anterior estava no chat global).
      await app.goto(`${server.baseUrl}/`, { waitMs: 1500 });
      const result = await app.eval(`
        scrollTo(0, 0);
        const openBtn = [...document.querySelectorAll('button[aria-label]')]
          .find((b) => /coment/i.test(b.getAttribute('aria-label') || ''));
        if (!openBtn) return { ok: false, reason: 'botao de comentarios ausente' };
        openBtn.click();
        await new Promise((r) => setTimeout(r, 1000));
        const sheet = document.querySelector('.sheet, .sheet-body, [role="dialog"]');
        const field = sheet?.querySelector('textarea[placeholder]');
        if (!field) return { ok: false, reason: 'composer de comentario ausente' };
        const before = field.value.length;
        const opener = [...sheet.querySelectorAll('button[aria-label]')]
          .find((b) => /emoji/i.test(b.getAttribute('aria-label') || ''));
        if (!opener) return { ok: false, reason: 'botao de emoji ausente no comentario' };
        opener.click();
        await new Promise((r) => setTimeout(r, 500));
        const panel = document.querySelector('.picker-panel[role="dialog"]');
        if (!panel) return { ok: false, reason: 'painel nao abriu' };
        // A aba inicial e "recentes" (pode ter 1 item). Troca para uma
        // categoria completa para validar o grid.
        const tab = [...panel.querySelectorAll('.picker-tabs button')]
          .find((b) => /rosto|smile|gesto|comida/i.test(b.textContent || ''));
        if (tab) tab.click();
        // Deixa o layout assentar antes de medir.
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 300))));
        const gridCount = panel.querySelectorAll('.picker-grid button').length;
        const rect = panel.getBoundingClientRect();
        return {
          ok: true,
          before,
          after: field.value.length,
          tab: tab?.textContent || 'recentes',
          gridCount,
          rect: { top: Math.round(rect.top), bottom: Math.round(rect.bottom), left: Math.round(rect.left), right: Math.round(rect.right) },
          viewport: { w: innerWidth, h: innerHeight },
          panelInViewport: rect.top >= -1 && rect.left >= -1
            && rect.bottom <= innerHeight + 1 && rect.right <= innerWidth + 1,
        };
      `);
      if (!result.ok) throw new Error(result.reason);
      if (result.after !== result.before) throw new Error('abrir o painel ja inseriu texto');
      if (result.gridCount < 20) throw new Error(`aba "${result.tab}" com ${result.gridCount} emojis`);
      if (!result.panelInViewport) {
        throw new Error(`painel fora da viewport ${JSON.stringify(result.rect)} vs ${JSON.stringify(result.viewport)}`);
      }
      return `aba "${result.tab}" com ${result.gridCount} emojis, dentro da viewport`;
    });

    // -------------------------------------------------------------- YOUTUBE
    await report.step('YouTube usa apenas o player oficial, sem controles duplicados', async () => {
      // Abrir o mini-player e' o que dispara o carregamento da IFrame API.
      const opened = await app.eval(`
        try {
          const mod = await import('/js/features/youtube.js');
          await mod.openMiniPlayer('dQw4w9WgXcQ', { title: 'Teste' });
          return { ok: true };
        } catch (e) {
          return { ok: false, error: e.message };
        }
      `);
      if (!opened.ok) throw new Error(`openMiniPlayer: ${opened.error}`);

      const api = await app.waitForFunction(`
        const yt = window.YT;
        return (yt && typeof yt.Player === 'function') ? true : null;
      `, 20_000).catch((error) => {
        throw new Error(`IFrame API do YouTube nao carregou: ${error.message}`);
      });
      void api;

      const result = await app.eval(`
        const iframes = [...document.querySelectorAll('iframe')]
          .map((f) => ({ src: f.src, origin: new URL(f.src, location.href).origin }));
        return {
          hasApi: typeof window.YT?.Player === 'function',
          iframes,
          // Controles proprios que o requisito PROIBE (play/pause/fullscreen/
          // barra/X/botao de abrir sao do player oficial):
          customPlayButtons: document.querySelectorAll(
            '[data-youtube-play], [data-yt-play], .yt-play, .youtube-play'
          ).length,
          customFullscreen: document.querySelectorAll(
            '[data-youtube-fullscreen], [data-yt-fullscreen], .yt-fullscreen'
          ).length,
          customBars: document.querySelectorAll('.yt-progress, .yt-seekbar, .yt-bar, .yt-timeline').length,
          // Dentro do mini-player so podem existir: o iframe do player oficial
          // e as duas zonas INVISIVEIS (arraste e resize).
          playerElements: [...document.querySelectorAll('.mini-player > *')]
            .filter((n) => n.tagName !== 'IFRAME'
              && !String(n.className || '').match(/mini-(resize|drag)/)).length,
          children: [...document.querySelectorAll('.mini-player > *')]
            .map((n) => n.tagName + '.' + String(n.className || '')),
        };
      `);
      if (!result.hasApi) throw new Error('IFrame API do YouTube nao carregada');
      const foreign = result.iframes.filter((f) => !/youtube\.com|youtube-nocookie\.com/.test(f.origin));
      if (foreign.length) throw new Error(`iframe nao-oficial: ${foreign.map((f) => f.origin).join(',')}`);
      if (result.customPlayButtons) throw new Error(`${result.customPlayButtons} botao de play proprio`);
      if (result.customFullscreen) throw new Error(`${result.customFullscreen} botao de fullscreen proprio`);
      if (result.customBars) throw new Error(`${result.customBars} barra de progresso propria`);
      if (result.playerElements) {
        throw new Error(`${result.playerElements} elemento(s) extra: ${result.children.join(', ')}`);
      }
      return `IFrame API ok, iframe oficial, 0 controle proprio`;
    });

    await report.step('mini-player do YouTube: arrastar, redimensionar 16:9 e fling fecha', async () => {
      // O mini-player ja foi aberto no passo anterior.
      const geometry = await app.eval(`
        const root = document.querySelector('.mini-player');
        if (!root) return null;
        const cs = getComputedStyle(root);
        const r = root.getBoundingClientRect();
        const handle = root.querySelector('.mini-resize');
        const hr = handle?.getBoundingClientRect();
        const drag = root.querySelector('.mini-drag');
        const dr = drag?.getBoundingClientRect();
        return {
          rect: { x: r.left, y: r.top, w: r.width, h: r.height },
          handle: hr ? { x: hr.left + hr.width / 2, y: hr.top + hr.height / 2 } : null,
          drag: dr ? { x: dr.left + dr.width / 2, y: dr.top + dr.height / 2 } : null,
          position: cs.position,
          hostPosition: getComputedStyle(document.getElementById('mini-player-host')).position,
          border: cs.borderTopWidth,
          boxShadow: cs.boxShadow,
          hasIframe: Boolean(root.querySelector('iframe')),
          hasHandle: Boolean(handle),
          hasDragStrip: Boolean(drag),
          handleVisible: handle ? (() => {
            const cs2 = getComputedStyle(handle);
            const after = getComputedStyle(handle, '::after');
            return {
              bg: cs2.backgroundColor,
              afterContent: after.content,
              afterW: after.width,
              afterH: after.height,
              visible: !(
                /rgba?\\(0,\\s*0,\\s*0,\\s*0\\)|^transparent$/.test(cs2.backgroundColor)
                && (after.content === 'none' || after.content === 'normal'
                  || (parseFloat(after.width) === 0 && parseFloat(after.height) === 0))
              ),
            };
          })() : false,
        };
      `);
      if (!geometry) throw new Error('mini-player ausente');
      const g0 = geometry.rect;

      // ---- Arrastar com MOUSE real (eventos confiaveis do CDP) ------------
      if (!geometry.hasDragStrip) throw new Error('faixa de arraste ausente');
      await app.drag(
        { x: geometry.drag.x, y: geometry.drag.y },
        { x: geometry.drag.x + 90, y: geometry.drag.y + 70 },
        10,
      );
      await sleep(350);
      const afterMouse = await app.eval(`
        const r = document.querySelector('.mini-player').getBoundingClientRect();
        return { x: r.left, y: r.top, w: r.width, h: r.height };
      `);
      const movedX = Math.abs(afterMouse.x - g0.x);
      const movedY = Math.abs(afterMouse.y - g0.y);
      if (movedX < 10 && movedY < 10) {
        throw new Error(`arrastar com mouse nao moveu (${Math.round(movedX)}x${Math.round(movedY)}px)`);
      }

      // ---- Arrastar com TOQUE real ----------------------------------------
      const t0 = afterMouse;
      const dragNow = await app.eval(`
        const d = document.querySelector('.mini-drag').getBoundingClientRect();
        const p = document.querySelector('.mini-player').getBoundingClientRect();
        return { x: d.left + d.width / 2, y: d.top + d.height / 2, px: p.left, py: p.top };
      `);
      void t0;
      await app.touchDrag([
        { x: dragNow.x, y: dragNow.y },
        { x: dragNow.x - 30, y: dragNow.y + 40 },
        { x: dragNow.x - 60, y: dragNow.y + 70 },
        { x: dragNow.x - 80, y: dragNow.y + 90 },
      ]);
      await sleep(350);
      const afterTouch = await app.eval(`
        const r = document.querySelector('.mini-player').getBoundingClientRect();
        return { x: r.left, y: r.top, w: r.width, h: r.height };
      `);
      const touchedX = Math.abs(afterTouch.x - t0.x);
      const touchedY = Math.abs(afterTouch.y - t0.y);
      if (touchedX < 10 && touchedY < 10) {
        throw new Error(`arrastar com toque nao moveu (${Math.round(touchedX)}x${Math.round(touchedY)}px)`);
      }

      // ---- Redimensionar 16:9 pela alca invisivel -------------------------
      if (!geometry.hasHandle) throw new Error('alca de resize ausente');
      const h0 = await app.eval(`
        const r = document.querySelector('.mini-resize').getBoundingClientRect();
        const p = document.querySelector('.mini-player').getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, px: p.x, py: p.y, pw: p.width, ph: p.height };
      `);
      const base = await app.eval(`
        const r = document.querySelector('.mini-player').getBoundingClientRect();
        return { x: r.left, y: r.top, w: r.width, h: r.height };
      `);
      await app.drag({ x: h0.x, y: h0.y }, { x: h0.x + 90, y: h0.y }, 10);
      await sleep(300);
      const resized = await app.eval(`
        const r = document.querySelector('.mini-player').getBoundingClientRect();
        return { w: r.width, h: r.height, ratio: r.width / r.height };
      `);
      if (resized.w <= base.w + 5) {
        throw new Error(`resize nao aumentou a largura (${Math.round(base.w)} -> ${Math.round(resized.w)})`);
      }
      if (Math.abs(resized.ratio - 16 / 9) > 0.06) {
        throw new Error(`proporcao ${resized.ratio.toFixed(3)} != 16:9 apos resize`);
      }

      // ---- Fling rapido para cima fecha e silencia -----------------------
      const f0 = await app.eval(`
        const r = document.querySelector('.mini-player').getBoundingClientRect();
        return { x: r.left, y: r.top, w: r.width, h: r.height };
      `);
      await app.drag(
        { x: f0.x + f0.w / 2, y: f0.y + 6 },
        { x: f0.x + f0.w / 2, y: 2 },
        6,
      );
      await sleep(900);
      const closed = await app.eval(`
        const still = document.querySelector('.mini-player');
        return {
          closed: !still,
          // O audio do YouTube so pode parar se o iframe sair da DOM.
          youtubeFrames: document.querySelectorAll(
            'iframe[src*="youtube"], iframe[src*="ytimg"], iframe[src*="google"]'
          ).length,
          hostEmpty: document.getElementById('mini-player-host')?.childElementCount === 0,
        };
      `);
      if (!closed.closed) throw new Error('fling para cima nao fechou o mini-player');
      if (!closed.hostEmpty) throw new Error('host do mini-player ficou com conteudo');
      if (closed.youtubeFrames > 0) {
        throw new Error(`${closed.youtubeFrames} iframe(s) do YouTube ainda na DOM (o audio seguiria tocando)`);
      }

      // Ancoragem na viewport: host fixo + jogador absoluto dentro dele.
      if (geometry.hostPosition !== 'fixed') throw new Error(`host position=${geometry.hostPosition}`);
      if (geometry.position !== 'absolute') throw new Error(`player position=${geometry.position}`);
      // Sem moldura/cartao: nada de borda ou sombra visivel.
      if (parseFloat(geometry.border) > 0 || (geometry.boxShadow && geometry.boxShadow !== 'none')) {
        throw new Error(`com borda/sombra: border=${geometry.border} shadow=${geometry.boxShadow}`);
      }
      if (!geometry.hasIframe) throw new Error('mini-player sem iframe do YouTube');
      if (geometry.handleVisible?.visible) {
        throw new Error(`alca de resize visivel: ${JSON.stringify(geometry.handleVisible)}`);
      }

      return `mouse ${Math.round(movedX)}px, toque ${Math.round(touchedX)}px, `
        + `resize ${Math.round(base.w)}->${Math.round(resized.w)}px (16:9), fling fechou e silenciou`;
    });

    await report.step('CSP bloqueia script externo nao permitido', async () => {
      // Dispara deliberadamente um script de terceiros: o console DEVE
      // registrar a violacao. Por isso o passo marca o log como esperado.
      const before = app.consoleErrors.length;
      await app.eval(`
        const s = document.createElement('script');
        s.src = 'https://evil.example.com/x.js';
        document.head.appendChild(s);
        await new Promise((r) => setTimeout(r, 600));
        s.remove();
        return true;
      `);
      const violations = app.consoleErrors.slice(before)
        .filter((e) => /Content Security Policy|violates the following/i.test(e));
      // A protecao real e' o cabecalho HTTP (verificado no suite de seguranca).
      // Aqui confirmamos que a politica existe como cabecalho.
      const res = await fetch(`${server.baseUrl}/`);
      const csp = res.headers.get('content-security-policy') || '';
      if (!csp.includes("script-src 'self'")) throw new Error('CSP sem script-src self');
      if (/script-src[^;]*\*/.test(csp)) throw new Error('script-src com wildcard (aceitaria origem arbitraria)');
      if (/script-src[^;]*'unsafe-(inline|eval)'/.test(csp)) throw new Error('script-src com unsafe-inline/eval');
      if (/evil/.test(csp)) throw new Error('CSP referencia origem de terceiro nao autorizada');
      if (!csp.includes('frame-src')) throw new Error('CSP sem frame-src (YouTube quebraria)');
      if (!violations.length) throw new Error('script de terceiro nao foi bloqueado pelo navegador');
      // Marca como esperado para o passo final de console.
      app.expectedConsole = app.consoleErrors.slice(0, app.consoleErrors.length);
      return `script de terceiros bloqueado (${violations.length} violacao(oes))`;
    });

    // ----------------------------------------------------- LIVE / WEbrtc REAL
    await report.step('getUserMedia devolve MediaStream real (camel e video)', async () => {
      const stream = await app.eval(`
        if (!navigator.mediaDevices?.getUserMedia) return { supported: false };
        const s = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        const tracks = s.getTracks().map((t) => ({ kind: t.kind, label: t.label, readyState: t.readyState }));
        window.__testStream = s;
        return {
          supported: true,
          id: s.id,
          active: s.active,
          tracks,
          videoSettings: (() => {
            const t = s.getVideoTracks()[0];
            return t ? t.getSettings() : null;
          })(),
        };
      `);
      if (!stream.supported) throw new Error('getUserMedia indisponivel');
      if (!stream.active) throw new Error('MediaStream inativo');
      if (stream.tracks.length < 2) throw new Error(`apenas ${stream.tracks.length} track(s)`);
      const settings = stream.videoSettings || {};
      if (!settings.width || !settings.height) throw new Error('video sem dimensoes reais');
      return `stream ${stream.tracks.length} tracks, video ${settings.width}x${settings.height}`;
    });

    await report.step('RTCPeerConnection cria offer/answer e ICE reais', async () => {
      const result = await app.eval(`
        const a = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
        const b = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
        window.__pcA = a; window.__pcB = b;
        a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate).catch(() => {});
        b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate).catch(() => {});
        const stream = window.__testStream;
        for (const track of stream.getTracks()) a.addTrack(track, stream);
        const remoteTracks = [];
        b.ontrack = (e) => { remoteTracks.push({ kind: e.track.kind, ready: e.track.readyState }); };

        const offer = await a.createOffer();
        await a.setLocalDescription(offer);
        await b.setRemoteDescription(offer);
        const answer = await b.createAnswer();
        await b.setLocalDescription(answer);
        await a.setRemoteDescription(answer);

        // Espera o fluxo de verdade chegar.
        await new Promise((r) => setTimeout(r, 2500));
        const stats = await b.getStats();
        let inboundBytes = 0;
        let inboundPackets = 0;
        stats.forEach((r) => {
          if (r.type === 'inbound-rtp' && !r.isRemote) {
            inboundBytes += r.bytesReceived || 0;
            inboundPackets += r.packetsReceived || 0;
          }
        });
        const sdpOk = a.localDescription.sdp.includes('m=video') && b.localDescription.sdp.includes('m=audio');
        return {
          sdpOk,
          remoteTracks,
          inboundBytes,
          inboundPackets,
          iceState: b.iceConnectionState,
        };
      `);
      if (!result.sdpOk) throw new Error('SDP sem m=video/m=audio');
      if (!result.remoteTracks.length) throw new Error('ontrack nunca disparou');
      if (result.inboundBytes <= 0) {
        throw new Error('nenhum byte recebido (fluxo nao chegou de verdade)');
      }
      if (!['connected', 'completed'].includes(result.iceState)) {
        throw new Error(`iceConnectionState=${result.iceState}`);
      }
      const kinds = result.remoteTracks.map((t) => t.kind).join('+');
      return `tracks ontrack=${kinds}, ${result.inboundBytes} bytes recebidos, ice=${result.iceState}`;
    });

    await report.step('RTCPeerConnection fecha sem conexao duplicada nem vazamento', async () => {
      const result = await app.eval(`
        const before = { a: window.__pcA, b: window.__pcB };
        window.__pcA.close();
        window.__pcB.close();
        // Tenta reabrir: nao pode reaproveitar a conexao velha.
        const c = new RTCPeerConnection({ iceServers: [] });
        c.addTransceiver('video');
        const offer = await c.createOffer();
        const ok = typeof offer.sdp === 'string' && offer.sdp.length > 100;
        c.close();
        return { ok, closedOld: before.a.signalingState, newClosed: c.signalingState };
      `);
      if (!result.ok) throw new Error('nova RTCPeerConnection nao gerou offer valido');
      return 'conexao fechada e nova conexao independente';
    });

    await report.step('estatisticas de video mostram dimensions reais', async () => {
      const result = await app.eval(`
        const video = document.createElement('video');
        video.muted = true;
        video.playsInline = true;
        video.autoplay = true;
        video.srcObject = window.__testStream;
        document.body.appendChild(video);
        await video.play().catch(() => {});
        await new Promise((r) => setTimeout(r, 1200));
        const info = {
          readyState: video.readyState,
          width: video.videoWidth,
          height: video.videoHeight,
          playing: !video.paused,
          currentTime: video.currentTime,
        };
        video.remove();
        return info;
      `);
      if (result.readyState < 2) throw new Error(`readyState ${result.readyState}`);
      if (!result.width || !result.height) throw new Error(`video ${result.width}x${result.height}`);
      return `${result.width}x${result.height} tocando=${result.playing} t=${result.currentTime.toFixed(2)}s`;
    });

    // ------------------------------------------------------------- LIVE REAL
    await report.step('LIVE real: host publica e espectador recebe via WebRTC', async () => {
      // 1) Host cria a LIVE pela propria UI (API do backend, com CSRF do app).
      const hostRoom = await app.eval(`
        try {
          const json = await window.__PULSE_DEBUG__.api.post('/api/live', { title: 'LIVE pelo navegador' });
          return { ok: true, roomId: json.room?.id || null, error: null };
        } catch (error) {
          return { ok: false, roomId: null, error: error.code || error.message };
        }
      `);
      if (!hostRoom.ok || !hostRoom.roomId) throw new Error(`criou LIVE: ${hostRoom.error || 'sem id'}`);

      // 2) Espectador em OUTRO contexto de navegador (perfil isolado) e,
      //    so entao, o host oferece: a ordem importa porque o host precisa ver
      //    o espectador na lista para enderecar o sinal.
      const viewer = await browser.newBrowserContext();
      sessions.push(viewer);
      viewer.watch();
      await viewer.goto(`${server.baseUrl}/`, { waitMs: 700 });

      const viewerClient = new Client(server.baseUrl);
      await viewerClient.register({ username: randomUsername('espectador') });
      const viewerLogin = await fetch(`${server.baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: `${viewerClient.user.username}@pulse.test`, password: 'Senha@Teste123',
        }),
      });
      for (const cookie of viewerLogin.headers.getSetCookie()) {
        const [pair] = cookie.split(';');
        const [name, value] = pair.split('=');
        // eslint-disable-next-line no-await-in-loop
        await viewer.send('Network.setCookie', {
          name, value: decodeURIComponent(value), domain: '127.0.0.1', path: '/',
        });
      }
      await viewer.goto(`${server.baseUrl}/`, { waitMs: 1200 });

      // Espectador: registra o listener ANTES de entrar e ja fica pronto para
      // responder a oferta (evita perder o primeiro sinal).
      const joined = await viewer.eval(`
        const roomId = ${JSON.stringify(hostRoom.roomId)};
        const dbg = window.__PULSE_DEBUG__;
        if (!dbg?.realtime) return { error: 'realtime indisponivel no espectador' };
        const cs = dbg.realtime;
        await dbg.api.post('/api/live/' + roomId + '/join', {});
        cs.subscribe('live:' + roomId);

        const pc = new RTCPeerConnection({ iceServers: [] });
        window.__viewerPc = pc;
        window.__viewerRemote = [];
        pc.ontrack = (e) => window.__viewerRemote.push(e.track.kind);

        window.__answerOffer = new Promise((resolve) => {
          window.__answered = false;
          window.__hostId = null;
          cs.addEventListener('LIVE_SIGNAL', async (event) => {
            const payload = event.detail?.payload || event.detail || {};
            if (payload.roomId !== roomId) return;
            window.__hostId = window.__hostId || payload.from;
            const signal = payload.signal || {};
            // ICE do host: candidate real, nao um stub.
            if (signal.kind === 'ice' && signal.candidate) {
              try {
                await pc.addIceCandidate(signal.candidate);
              } catch (e) { window.__viewerErr = 'ice: ' + e.message; }
              return;
            }
            if (signal.kind !== 'description') return;
            if (signal.description?.type !== 'offer') return;
            if (window.__answered) return;
            window.__answered = true;
            try {
              await pc.setRemoteDescription(signal.description);
              const answer = await pc.createAnswer();
              await pc.setLocalDescription(answer);
              cs.signal(roomId, payload.from, { kind: 'description', description: pc.localDescription });
            } catch (e) {
              window.__viewerErr = e.message;
            }
            resolve();
          });
          setTimeout(resolve, 15000);
        });
        // ICE do espectador volta para o host (troca real de candidates).
        pc.onicecandidate = (event) => {
          if (!event.candidate || !window.__hostId) return;
          cs.signal(roomId, window.__hostId, { kind: 'ice', candidate: event.candidate.toJSON() });
        };
        const detail = await dbg.api.get('/api/live/' + roomId);
        return { ok: true, viewerCount: detail.viewerCount, listed: (detail.viewers || []).length };
      `);
      if (joined.error) throw new Error(joined.error);
      if (joined.listed !== 1) throw new Error(`espectadores na sala: ${joined.listed} (esperava 1)`);

      // 3) Host cria a conexao, envia a oferta e o ICE pelo WebSocket real.
      const negotiated = await app.eval(`
        const cs = window.__PULSE_DEBUG__?.realtime;
        if (!cs) return { error: 'realtime indisponivel' };
        const roomId = ${JSON.stringify(hostRoom.roomId)};
        window.__liveError = null;

        const pc = new RTCPeerConnection({ iceServers: [] });
        const stream = window.__testStream;
        for (const track of stream.getTracks()) pc.addTrack(track, stream);
        window.__livePc = pc;

        cs.subscribe('live:' + roomId);
        cs.addEventListener('LIVE_SIGNAL', async (event) => {
          const payload = event.detail?.payload || event.detail || {};
          if (payload.roomId !== roomId) return;
          const signal = payload.signal || {};
          if (signal.kind === 'ice' && signal.candidate) {
            try {
              await pc.addIceCandidate(signal.candidate);
            } catch (e) { window.__liveError = 'ice: ' + e.message; }
            return;
          }
          if (signal.kind !== 'description') return;
          if (signal.description?.type !== 'answer') return;
          try {
            await pc.setRemoteDescription(signal.description);
          } catch (e) { window.__liveError = e.message; }
        });

        pc.onicecandidate = (event) => {
          if (!event.candidate) return;
          const viewers = window.__viewers || [];
          for (const viewer of viewers) {
            cs.signal(roomId, viewer.id, { kind: 'ice', candidate: event.candidate.toJSON() });
          }
        };
        pc.onicecandidateerror = () => {};

        const detail = await window.__PULSE_DEBUG__.api.get('/api/live/' + roomId);
        const viewers = detail.viewers || [];
        if (!viewers.length) return { error: 'sem espectadores na sala' };
        window.__viewers = viewers;

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        cs.signal(roomId, viewers[0].id, { kind: 'description', description: pc.localDescription });
        return {
          ok: true,
          signalingState: pc.signalingState,
          sdpBytes: pc.localDescription.sdp.length,
          hasVideo: pc.localDescription.sdp.includes('m=video'),
          hasAudio: pc.localDescription.sdp.includes('m=audio'),
        };
      `);
      if (negotiated.error) throw new Error(negotiated.error);
      if (!negotiated.hasVideo || !negotiated.hasAudio) {
        throw new Error('SDP do host sem m=video/m=audio');
      }

      // 4) Espectador aplica a resposta, espera o fluxo e mede bytes de verdade.
      const answered = await viewer.eval(`
        const pc = window.__viewerPc;
        await window.__answerOffer;
        await new Promise((r) => setTimeout(r, 4000));

        const video = document.createElement('video');
        video.autoplay = true; video.playsInline = true; video.muted = true;
        document.body.appendChild(video);
        video.srcObject = new MediaStream(pc.getReceivers().map((r) => r.track).filter(Boolean));
        video.play().catch(() => {});
        await new Promise((r) => setTimeout(r, 2500));

        const s = await pc.getStats();
        let bytes = 0; let packets = 0; let w = 0; let h = 0;
        s.forEach((r) => {
          if (r.type === 'inbound-rtp' && !r.isRemote) {
            bytes += r.bytesReceived || 0;
            packets += r.packetsReceived || 0;
            if (r.kind === 'video') { w = r.frameWidth || 0; h = r.frameHeight || 0; }
          }
        });
        const info = {
          remote: window.__viewerRemote,
          bytes, packets, w, h,
          ice: pc.iceConnectionState,
          signalingState: pc.signalingState,
          videoWidth: video.videoWidth,
          videoHeight: video.videoHeight,
          videoPlaying: !video.paused,
          err: window.__viewerErr || null,
        };
        video.remove();
        return info;
      `);
      if (answered.err) throw new Error(`espectador: ${answered.err}`);
      const hostErr = await app.eval('return window.__liveError || null;');
      if (hostErr) throw new Error(`host: ${hostErr}`);
      if (!answered.remote.length) throw new Error('ontrack do espectador nunca disparou');
      if (answered.bytes <= 0) {
        throw new Error('espectador nao recebeu NENHUM byte do host (WebRTC nao conectou)');
      }
      if (!['connected', 'completed'].includes(answered.ice)) {
        throw new Error(`iceConnectionState=${answered.ice} (SDP=${negotiated.sdpBytes} bytes)`);
      }
      if (answered.videoWidth <= 0) throw new Error(`<video> do espectador sem quadros (${answered.videoWidth}x${answered.videoHeight})`);
      return `espectador recebeu ${answered.bytes} bytes / ${answered.packets} pacotes, `
        + `${answered.videoWidth}x${answered.videoHeight} tocando=${answered.videoPlaying}, ice=${answered.ice}`;
    });

    await report.step('contagem de espectadores da LIVE exclui o host', async () => {
      const result = await app.eval(`
        const dbg = window.__PULSE_DEBUG__;
        const list = await dbg.api.get('/api/live/discover');
        const room = list.live[0];
        if (!room) return { error: 'sem LIVE ativa' };
        const detail = await dbg.api.get('/api/live/' + room.id);
        return {
          viewerCount: detail.viewerCount,
          hostId: room.host?.id || detail.room?.host?.id || null,
          viewerIds: (detail.viewers || []).map((v) => v.id),
        };
      `);
      if (result.error) throw new Error(result.error);
      if (result.viewerIds.includes(result.hostId)) throw new Error('host na lista de espectadores');
      return `viewerCount=${result.viewerCount}, host fora da lista`;
    });

    await report.step('efeitos da LIVE chegam ao navegador com arquivo real', async () => {
      const result = await app.eval(`
        const dbg = window.__PULSE_DEBUG__;
        const json = await dbg.api.get('/api/live/effects');
        const effects = json.effects || [];
        const withMedia = effects.filter((e) => e.mediaUrl);
        let bytesOk = 0;
        let mediaStatus = null;
        let contentType = null;
        let animated = false;
        for (const e of withMedia.slice(0, 1)) {
          const r = await fetch(e.mediaUrl);
          mediaStatus = r.status;
          contentType = r.headers.get('content-type');
          if (r.ok) {
            const source = await r.text();
            bytesOk = new TextEncoder().encode(source).byteLength;
            animated = /<animate/.test(source);
          }
        }
        return {
          total: effects.length,
          withMedia: withMedia.length,
          bytesOk,
          mediaStatus,
          contentType,
          animated,
          format: withMedia[0]?.format || null,
          chromaKey: effects.filter((e) => !e.alphaReady && e.chromaKey).length,
          alphaReady: effects.filter((e) => e.alphaReady).length,
        };
      `);
      if (result.total !== 15) throw new Error(`catálogo com ${result.total} presentes (esperado 15)`);
      if (result.withMedia !== 15) throw new Error(`${15 - result.withMedia} presente(s) sem arquivo`);
      if (result.bytesOk <= 0 || result.mediaStatus !== 200) throw new Error('SVG do presente nao baixou do navegador');
      if (result.contentType !== 'image/svg+xml' || result.format !== 'svg' || !result.animated) {
        throw new Error(`formato do preview inválido: ${JSON.stringify(result)}`);
      }
      if (result.chromaKey !== 0 || result.alphaReady !== 15) {
        throw new Error('presentes SVG devem usar transparência alfa real, sem chroma-key');
      }
      return `${result.total} SVGs animados, ${result.bytesOk} bytes baixados, alphaReady=${result.alphaReady}`;
    });

    await report.step('efeito dispara na LIVE e o frontend nao duplica a animacao', async () => {
      const roomId = await app.eval(`
        const list = await window.__PULSE_DEBUG__.api.get('/api/live/discover');
        return list.live[0]?.id || null;
      `);
      if (!roomId) throw new Error('sem LIVE ativa para testar o efeito');

      const result = await app.eval(`
        const roomId = ${JSON.stringify(roomId)};
        const dbg = window.__PULSE_DEBUG__;
        const effects = await dbg.api.get('/api/live/effects');
        const effect = effects.effects[0];

        // Ouve o realtime e conta quantas vezes o efeito chegou.
        window.__effectHits = [];
        dbg.realtime.subscribe('live:' + roomId);
        dbg.realtime.addEventListener('EFFECT_TRIGGER', (event) => {
          const p = event.detail || {};
          if (p.roomId === roomId) window.__effectHits.push({ sequence: p.sequence, eventId: p.eventId });
        });

        const first = await dbg.api.post('/api/live/' + roomId + '/effects', {
          effectId: effect.id, clientEventId: 'browser-1',
        });
        // Reenvia o MESMO clientEventId: o backend tem de reconhecer a duplicata.
        const second = await dbg.api.post('/api/live/' + roomId + '/effects', {
          effectId: effect.id, clientEventId: 'browser-1',
        });
        await new Promise((r) => setTimeout(r, 1200));
        return {
          first: first.payload ? { eventId: first.payload.eventId, sequence: first.payload.sequence } : null,
          duplicate: second.duplicate === true,
          hits: window.__effectHits,
        };
      `);
      if (!result.first?.eventId || !Number.isFinite(result.first.sequence)) {
        throw new Error('payload sem eventId/sequence');
      }
      if (!result.duplicate) throw new Error('reenvio do mesmo clientEventId nao foi reconhecido como duplicata');
      // Chave: 1 disparo = 1 animacao, mesmo com reenvio
      if (result.hits.length !== 1) throw new Error(`efeito entregue ${result.hits.length}x no cliente`);
      return `1 disparo, 1 entrega (sequence=${result.first.sequence})`;
    });

    // -------------------------------------------------------------- CONSOLE
    // ---------------------------------------------------------- FEED (UI)
    await report.step('som do video: botao visivel, 1o toque liga e o botao alterna', async () => {
      await app.goto(`${server.baseUrl}/`, { waitMs: 2500 });
      const result = await app.eval(`
        const stage = document.querySelector('.feed-stage');
        const videoPostId = ${JSON.stringify(videoPost.id)};
        for (let attempt = 0; attempt < 10 && !stage.querySelector(\`.slide[data-post-id="\${videoPostId}"]\`); attempt += 1) {
          stage.scrollTop = stage.scrollHeight;
          stage.dispatchEvent(new Event('scroll'));
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
        const findBtn = (root) => root.querySelector(
          '.act[aria-label="Ativar som"], .act[aria-label="Desativar som"]'
        );
        const slide = stage.querySelector(\`.slide[data-post-id="\${videoPostId}"]\`);
        if (!stage || !slide) return { ok: false, reason: 'post de video nao foi carregado' };
        const index = [...stage.querySelectorAll('.slide')].indexOf(slide);
        stage.scrollTop = index * stage.clientHeight;
        await new Promise((resolve) => setTimeout(resolve, 200));
        if (!slide.classList.contains('active')) {
          return { ok: false, reason: 'post de video nao ficou ativo' };
        }
        let video = slide?.querySelector('video');
        if (!video) return { ok: false, reason: 'slide ativo sem video' };

        const botao = findBtn(slide);
        if (!botao) return { ok: false, reason: 'sem botao de som' };
        const labelInicial = botao.getAttribute('aria-label');

        // Autoplay com som e bloqueado pelo navegador: comeca mudo.
        const muted0 = video.muted;

        // 1) Primeiro toque real na tela LIGA o som (gesto do usuario).
        slide.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
        await new Promise((r) => setTimeout(r, 400));
        const afterTap = { muted: video.muted, paused: video.paused };

        // 2) O mesmo toque nao pode pausar o video.
        video.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        await new Promise((r) => setTimeout(r, 300));
        const afterClick = video.paused;

        // 3) O botao alterna o som nos dois sentidos.
        findBtn(slide).click();
        await new Promise((r) => setTimeout(r, 300));
        const off = video.muted;
        findBtn(slide).click();
        await new Promise((r) => setTimeout(r, 300));
        const on = video.muted;

        return {
          ok: true, labelInicial, muted0, afterTap, afterClick, off, on,
          labelFinal: findBtn(slide).getAttribute('aria-label'),
        };
      `);
      if (!result.ok) throw new Error(result.reason);
      if (!result.muted0) throw new Error('o video ja nasceu com som: o teste nao exercita o caso real');
      if (result.afterTap.muted !== false) throw new Error('o primeiro toque nao ligou o som');
      if (result.afterClick !== false) throw new Error('o toque que ligou o som tambem pausou o video');
      if (result.off !== true) throw new Error('o botao nao desligou o som');
      if (result.on !== false) throw new Error('o botao nao religou o som');
      return `inicial "${result.labelInicial}" (muted) -> 1o toque liga sem pausar -> botao alterna -> "${result.labelFinal}"`;
    });

    await report.step('clicar no video alterna play/pause; comentario so pelo botao', async () => {
      await app.goto(`${server.baseUrl}/`, { waitMs: 2000 });
      const result = await app.eval(`
        const stage = document.querySelector('.feed-stage');
        const videoPostId = ${JSON.stringify(videoPost.id)};
        for (let attempt = 0; attempt < 10 && !stage.querySelector(\`.slide[data-post-id="\${videoPostId}"]\`); attempt += 1) {
          stage.scrollTop = stage.scrollHeight;
          stage.dispatchEvent(new Event('scroll'));
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
        const slide = stage.querySelector(\`.slide[data-post-id="\${videoPostId}"]\`);
        if (!slide) return { ok: false, reason: 'post de video nao foi carregado' };
        stage.scrollTop = [...stage.querySelectorAll('.slide')].indexOf(slide) * stage.clientHeight;
        await new Promise((resolve) => setTimeout(resolve, 200));
        const video = slide?.querySelector('video');
        if (!video) return { ok: false, reason: 'video do slide ausente' };

        // Estado inicial: tocando (autoplay por permissao).
        await new Promise((r) => setTimeout(r, 900));
        const playing0 = !video.paused;

        // 1) Clique no VIDEO pausa.
        video.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        await new Promise((r) => setTimeout(r, 400));
        const paused1 = video.paused;

        // 2) Clique de novo retoma.
        video.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        await new Promise((r) => setTimeout(r, 400));
        const playing2 = !video.paused;

        // 3) Clicar no video NAO abre comentarios.
        const commentsBefore = document.querySelectorAll('.sheet, [role="dialog"]').length;
        video.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        await new Promise((r) => setTimeout(r, 350));
        const commentsAfter = document.querySelectorAll('.sheet, [role="dialog"]').length;
        video.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

        // 4) O botao de comentario ABRE a folha.
        const btn = [...slide.querySelectorAll('button[aria-label]')]
          .find((b) => /coment/i.test(b.getAttribute('aria-label') || ''));
        btn.click();
        await new Promise((r) => setTimeout(r, 900));
        const sheetOpen = document.querySelectorAll('.sheet, [role="dialog"]').length;
        const hasComposer = Boolean(document.querySelector('.sheet textarea[placeholder]'));
        return {
          ok: true,
          playing0, paused1, playing2,
          commentsBefore, commentsAfter, sheetOpen, hasComposer,
        };
      `);
      if (!result.ok) throw new Error(result.reason);
      if (!result.playing0) throw new Error('video nao inicia reproduzindo (autoplay)');
      if (!result.paused1) throw new Error('clique no video nao pausou');
      if (!result.playing2) throw new Error('segundo clique nao retomou');
      if (result.commentsAfter !== result.commentsBefore) throw new Error('clique no video abriu comentarios');
      if (result.sheetOpen <= result.commentsBefore) throw new Error('botao de comentario nao abriu a folha');
      if (!result.hasComposer) throw new Error('folha de comentarios sem composer');
      return 'play/pause alterna e comentario so pelo botao';
    });

    await report.step('feed carrega o proximo slide antes de chegar nele (preload)', async () => {
      // Semeia conteudo: preload/unload so faz sentido com varios slides.
      for (let i = 0; i < 7; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await author.post('/api/posts', {
          type: 'text', caption: `post de feed ${i} para exercitar a navegacao #pulse`,
        });
      }
      await app.goto(`${server.baseUrl}/`, { waitMs: 1800 });
      const info = await app.eval(`
        const stage = document.querySelector('#feed-stage');
        const slides = stage.querySelectorAll('.slide');
        return {
          slides: slides.length,
          // Slides distantes nao devem carregar midia.
          distantLoaded: [...slides].slice(3).filter((s) => {
            const v = s.querySelector('video');
            return v && v.currentSrc;
          }).length,
        };
      `);
      if (info.slides < 2) throw new Error(`apenas ${info.slides} slide(s) no feed`);
      if (info.distantLoaded > 0) {
        throw new Error(`${info.distantLoaded} slide(s) distante(s) com midia carregada (deveria descarregar)`);
      }
      return `${info.slides} slides, nenhum distante carregado`;
    });

    await report.step('"Nao tenho interesse" remove o post do feed', async () => {
      // Publica um post descartavel e o remove pelo menu real.
      const throwaway = await author.post('/api/posts', { type: 'text', caption: 'post descartavel #pulse' });
      const postId = throwaway.body.post.id;
      await app.goto(`${server.baseUrl}/`, { waitMs: 1800 });

      const removed = await app.eval(`
        const target = ${JSON.stringify(postId)};
        const slide = [...document.querySelectorAll('.slide')]
          .find((s) => s.dataset.postId === target);
        if (!slide) return { ok: false, reason: 'post nao apareceu no feed' };
        const more = [...slide.querySelectorAll('button[aria-label]')]
          .find((b) => /mais op/i.test(b.getAttribute('aria-label') || ''));
        if (!more) return { ok: false, reason: 'botao de menu ausente' };
        more.click();
        await new Promise((r) => setTimeout(r, 500));
        const item = [...document.querySelectorAll('button, [role="menuitem"]')]
          .find((b) => /nao tenho interesse/i.test(b.textContent || ''));
        if (!item) return { ok: false, reason: 'opcao "Nao tenho interesse" ausente' };
        item.click();
        await new Promise((r) => setTimeout(r, 900));
        const stillThere = [...document.querySelectorAll('.slide')]
          .some((s) => s.dataset.postId === target);
        return { ok: true, stillThere };
      `);
      if (!removed.ok) throw new Error(removed.reason);
      if (removed.stillThere) throw new Error('post continua no feed apos "Nao tenho interesse"');

      // O backend registra a ocultacao: nem a recarga traz o post de volta.
      await app.goto(`${server.baseUrl}/`, { waitMs: 1800 });
      const afterReload = await app.eval(`
        const target = ${JSON.stringify(postId)};
        return [...document.querySelectorAll('.slide')].some((s) => s.dataset.postId === target);
      `);
      if (afterReload) throw new Error('post voltou apos recarregar (backend nao persistiu)');
      return 'removido do feed e nao volta ao recarregar';
    });

    await report.step('ocultar criador remove os posts dele do feed', async () => {
      // Conta separada: esconder o autor do video zeraria o feed inteiro.
      const stranger = new Client(server.baseUrl);
      await stranger.register({ username: randomUsername('criador') });
      const creator = await stranger.post('/api/posts', { type: 'text', caption: 'post do criador oculto #pulse' });
      const postId = creator.body.post.id;
      await app.goto(`${server.baseUrl}/`, { waitMs: 1800 });

      const hidden = await app.eval(`
        const target = ${JSON.stringify(postId)};
        const slide = [...document.querySelectorAll('.slide')]
          .find((s) => s.dataset.postId === target);
        if (!slide) return { ok: false, reason: 'post nao apareceu' };
        const more = [...slide.querySelectorAll('button[aria-label]')]
          .find((b) => /mais op/i.test(b.getAttribute('aria-label') || ''));
        more.click();
        await new Promise((r) => setTimeout(r, 500));
        const item = [...document.querySelectorAll('button, [role="menuitem"]')]
          .find((b) => /ocultar @/i.test(b.textContent || ''));
        if (!item) return { ok: false, reason: 'opcao "Ocultar @" ausente' };
        item.click();
        await new Promise((r) => setTimeout(r, 500));
        // Confirmacao explicita (o app pede confirmacao antes de ocultar).
        const confirm = [...document.querySelectorAll('button')]
          .find((b) => /^ocultar$/i.test((b.textContent || '').trim()));
        if (confirm) confirm.click();
        await new Promise((r) => setTimeout(r, 1200));
        const stillThere = [...document.querySelectorAll('.slide')]
          .some((s) => s.dataset.postId === target);
        return { ok: true, stillThere };
      `);
      if (!hidden.ok) throw new Error(hidden.reason);
      if (hidden.stillThere) throw new Error('posts do criador continuam no feed');
      return 'criador ocultado e posts sumiram do feed';
    });

    await report.step('bloquear autor: menu funciona e o backend e a autoridade', async () => {
      // Post do autor de referencia, usado como alvo do bloqueio.
      const target = await author.post('/api/posts', {
        type: 'text', caption: `post alvo do bloqueio ${Date.now()}`,
      });
      const targetId = target.body.post.id;

      // Troca a sessao do navegador para OUTRA conta: o usuario logado
      // (autor) nao pode bloquear a si mesmo.
      const browserUser = new Client(server.baseUrl);
      await browserUser.register({ username: randomUsername('moderador') });
      const swap = await fetch(`${server.baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: `${browserUser.user.username}@pulse.test`, password: 'Senha@Teste123',
        }),
      });
      for (const cookie of swap.headers.getSetCookie()) {
        const [pair] = cookie.split(';');
        const [name, value] = pair.split('=');
        // eslint-disable-next-line no-await-in-loop
        await app.send('Network.setCookie', {
          name, value: decodeURIComponent(value), domain: '127.0.0.1', path: '/',
        });
      }
      await app.goto(`${server.baseUrl}/`, { waitMs: 1800 });

      // 1) Caminho pela interface: menu do post -> Bloquear @ -> confirmar.
      const viaMenu = await app.eval(`
        const target = ${JSON.stringify(targetId)};
        const slide = [...document.querySelectorAll('.slide')]
          .find((s) => s.dataset.postId === target);
        if (!slide) return { ok: false, reason: 'post alvo nao apareceu no feed' };
        const more = [...slide.querySelectorAll('button[aria-label]')]
          .find((b) => /mais op/i.test(b.getAttribute('aria-label') || ''));
        if (!more) return { ok: false, reason: 'botao de menu ausente' };
        more.click();
        await new Promise((r) => setTimeout(r, 500));
        const item = [...document.querySelectorAll('button, [role="menuitem"]')]
          .find((b) => /bloquear @/i.test(b.textContent || ''));
        if (!item) return { ok: false, reason: 'opcao "Bloquear @" ausente' };
        item.click();
        await new Promise((r) => setTimeout(r, 600));
        const confirm = [...document.querySelectorAll('button')]
          .find((b) => /^bloquear$/i.test((b.textContent || '').trim()));
        if (!confirm) return { ok: false, reason: 'confirmacao ausente' };
        confirm.click();
        await new Promise((r) => setTimeout(r, 1500));
        const stillThere = [...document.querySelectorAll('.slide')]
          .some((s) => s.dataset.postId === target);
        const toasts = [...document.querySelectorAll('.toasts *')].map((n) => n.textContent);
        const blocks = await window.__PULSE_DEBUG__.api.get('/api/me/blocks');
        return {
          ok: true,
          stillThere,
          toasts,
          blocked: (blocks.users || []).map((b) => b.username),
        };
      `);
      if (!viaMenu.ok) throw new Error(viaMenu.reason);
      if (viaMenu.stillThere) {
        throw new Error(`post continua no feed apos bloquear `
          + `(toasts=${JSON.stringify(viaMenu.toasts)}, bloqueados=${JSON.stringify(viaMenu.blocked)})`);
      }
      if (!viaMenu.blocked.length) throw new Error('backend nao registrou o bloqueio');

      // 2) O BACKEND e' a autoridade: follow, comentario, DM, feed e midia.
      const viewer = browserUser;
      const authorId = author.user.id;

      const follow = await viewer.post(`/api/users/${authorId}/follow`, {});
      if (follow.status === 200) throw new Error('conseguiu seguir quem o bloqueou');

      const comment = await viewer.post(`/api/posts/${videoPost.id}/comments`, { body: 'oi' });
      if (comment.status === 200) throw new Error('conseguiu comentar no post de quem bloqueou');

      const dm = await viewer.post(`/api/users/${authorId}/message`, {});
      if (dm.status === 200) throw new Error('conseguiu enviar DM para quem o bloqueou');

      // O bloqueio e ENTRE as duas contas: o feed de quem bloqueou nao pode
      // mostrar o conteudo. Um terceiro (inclusive anonimo) continua vendo -
      // isso e correto, bloqueio nao e exclusao de conteudo publico.
      const blockedFeed = await viewer.get('/api/feed/for-you');
      if (blockedFeed.body.posts.some((p) => p.author.id === authorId)) {
        throw new Error('conteudo do autor bloqueado ainda no feed de quem bloqueou');
      }
      // Quem nao bloqueou continua vendo o conteudo publico (com sessao:
      // o feed exige usuario logado).
      const outro = new Client(server.baseUrl);
      await outro.register({ username: randomUsername('terceiro') });
      const publicFeed = await outro.get('/api/feed/for-you');
      if (!publicFeed.body.posts.some((p) => p.author.id === authorId)) {
        throw new Error('conteudo publico sumiu para quem nao bloqueou');
      }
      // E sem sessao o feed nem abre.
      const anonFeed = await new Client(server.baseUrl).get('/api/feed/for-you');
      if (anonFeed.status !== 401) {
        throw new Error(`feed anonimo devolveu ${anonFeed.status} em vez de 401`);
      }
      const mediaKey = encodeURIComponent(`videos/${mediaId}.mp4`);
      const media = await viewer.get(`/api/media/stream?key=${mediaKey}`);
      if (media.status === 200) throw new Error('midia do post bloqueado ainda servida');

      // 3) Desbloqueando devolve o acesso.
      await viewer.delete(`/api/users/${authorId}/block`);
      const after = await viewer.post(`/api/users/${authorId}/follow`, {});
      if (after.status !== 200) throw new Error(`follow apos desbloquear: ${after.status}`);
      return 'menu ok + bloqueio efetivo no backend + desbloqueio';
    });

    // ------------------------------------------------- LIVE: TELA DO ESPECTADOR
    let liveCommentAuthor = null;
    let liveProfileRoomId = null;
    await report.step('tela da LIVE: topo, campo "Digite...", acoes e ~10 comentarios', async () => {
      const roomId = await app.eval(`
        const list = await window.__PULSE_DEBUG__.api.get('/api/live/discover');
        return list.live[0]?.id || null;
      `);
      if (!roomId) throw new Error('sem LIVE ativa para abrir a tela do espectador');
      liveProfileRoomId = roomId;

      // 12 comentÃ¡rios reais para provar o limite visual de ~10.
      const viewerClient = new Client(server.baseUrl);
      await viewerClient.register({ username: randomUsername('chat'), env: {} });
      const commentAvatar = await makeTestImage({ width: 96, height: 96, color: 'purple' });
      const uploadedAvatar = await viewerClient.upload('/api/users/me/avatar', commentAvatar.buffer, {
        filename: commentAvatar.filename, mime: commentAvatar.mime, field: 'image',
      });
      if (uploadedAvatar.status !== 200 || !uploadedAvatar.body.user.avatarUrl) {
        throw new Error('nao foi possivel configurar a foto do autor do comentario');
      }
      liveCommentAuthor = {
        username: viewerClient.user.username,
        avatarUrl: uploadedAvatar.body.user.avatarUrl,
      };
      await viewerClient.post(`/api/live/${roomId}/join`, {});
      for (let i = 1; i <= 12; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await viewerClient.post(`/api/live/${roomId}/messages`, { body: `mensagem ${i}` });
      }

      await app.goto(`${server.baseUrl}/live/${roomId}`, { waitMs: 2500 });
      const ui = await app.eval(`
        const root = document.querySelector('.live-viewer, .live-stage, [data-live-viewer]') || document;
        const text = document.body.innerText;

        // Topo: foto do anfitriao, @username, nome e contagem de espectadores
        const hasAvatar = Boolean(root.querySelector('.avatar img, .avatar, img.avatar'));
        const username = (text.match(/@[a-z0-9_]+/i) || [])[0] || null;
        // Contador de espectadores: icone de olho + numero (sem o host).
        const pill = [...root.querySelectorAll('.live-pill')]
          .find((n) => /espectador/i.test(n.getAttribute('title') || ''));
        const viewerCount = pill
          ? (pill.querySelector('span:last-of-type')?.textContent || '').trim()
          : null;

        // Campo de chat com placeholder "Digite..."
        const field = root.querySelector('input[placeholder*="Digite" i], textarea[placeholder*="Digite" i]')
          || document.querySelector('input[placeholder*="Digite" i], textarea[placeholder*="Digite" i]');

        // Acoes: coracao, efeitos, compartilhar
        const buttons = [...root.querySelectorAll('button[aria-label]')].map((b) => b.getAttribute('aria-label'));
        const heart = buttons.find((l) => /corac|heart|curtir/i.test(l)) || null;
        const effects = buttons.find((l) => /efeit/i.test(l)) || null;
        const share = buttons.find((l) => /compartilh|share/i.test(l)) || null;

        // Chat: ~10 visiveis; o banco segue com os 12.
        const messages = [...root.querySelectorAll('.live-msg, [data-live-message], .chat-msg')];
        const visible = messages.filter((m) => m.offsetParent !== null);

        // O chat fica ACIMA da camada de efeitos.
        const messagesY = messages.length
          ? Math.min(...messages.map((m) => m.getBoundingClientRect().top))
          : null;
        const canvas = root.querySelector('canvas');
        const canvasY = canvas ? canvas.getBoundingClientRect().top : null;

        return {
          hasAvatar, username, viewerCount,
          hasField: Boolean(field),
          placeholder: field?.getAttribute('placeholder') || null,
          heart, effects, share,
          visibleMessages: visible.length,
          domMessages: messages.length,
          messagesY, canvasY,
        };
      `);
      if (!ui.hasAvatar) throw new Error('sem foto do anfitriao no topo');
      if (!ui.username) throw new Error('sem @username do anfitriao');
      if (!ui.viewerCount || !/^\d[\d.,]*[km]?$/i.test(ui.viewerCount)) {
        throw new Error(`contagem de espectadores invalida ("${ui.viewerCount}")`);
      }
      // O anfitriao NAO entra na contagem: a UI tem de bater com o backend.
      const truth = await viewerClient.get(`/api/live/${roomId}`);
      if (Number(ui.viewerCount.replace(/[^\d]/g, '')) !== truth.body.viewerCount) {
        throw new Error(`contagem na UI ${ui.viewerCount} != backend ${truth.body.viewerCount}`);
      }
      if (truth.body.viewers.some((v) => v.id === truth.body.room.host.id)) {
        throw new Error('host aparece na lista de espectadores');
      }
      if (!ui.hasField) throw new Error('sem campo de chat');
      if (!/digite/i.test(ui.placeholder || '')) throw new Error(`placeholder "${ui.placeholder}"`);
      if (!ui.heart) throw new Error('sem acao de coracao');
      if (!ui.effects) throw new Error('sem acao de efeitos');
      if (!ui.share) throw new Error('sem acao de compartilhar');
      if (ui.visibleMessages < 1) throw new Error('nenhum comentario visivel');
      if (ui.visibleMessages > 12) {
        throw new Error(`${ui.visibleMessages} comentarios visiveis (o esperado e' ~10)`);
      }
      if (ui.messagesY !== null && ui.canvasY !== null && ui.messagesY > ui.canvasY) {
        throw new Error('chat NAO esta acima da camada de efeitos');
      }

      // O banco preserva tudo: o limite e' visual.
      const persisted = await viewerClient.get(`/api/live/${roomId}/messages`, { query: { limit: 50 } });
      if (persisted.body.messages.length < 12) {
        throw new Error(`historico perdeu mensagens: ${persisted.body.messages.length}/12`);
      }
      return `${ui.visibleMessages} visiveis / ${persisted.body.messages.length} no banco, `
        + `espectadores=${ui.viewerCount}, chat acima dos efeitos`;
    });

    await report.step('comentario abre perfil rapido, permite seguir e navegar ao perfil completo', async () => {
      const profilePage = await browser.newBrowserContext();
      sessions.push(profilePage);
      profilePage.watch();
      const login = await fetch(`${server.baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          identifier: author.user.username,
          password: 'Senha@Teste123',
        }),
      });
      if (!login.ok) throw new Error(`login para testar o perfil rapido: HTTP ${login.status}`);
      for (const cookie of login.headers.getSetCookie()) {
        const [pair] = cookie.split(';');
        const [name, value] = pair.split('=');
        await profilePage.send('Network.setCookie', {
          name, value: decodeURIComponent(value), domain: '127.0.0.1', path: '/',
        });
      }
      await profilePage.goto(`${server.baseUrl}/live/${liveProfileRoomId}`, { waitMs: 1000 });
      await profilePage.waitForFunction(`
        return [...document.querySelectorAll('.live-msg')]
          .some((node) => node.textContent.includes('mensagem 12'));
      `, 8000);
      await profilePage.eval(`
        const comment = [...document.querySelectorAll('.live-msg')]
          .find((node) => node.textContent.includes('mensagem 12'));
        if (!comment) throw new Error('comentario do espectador nao esta na LIVE');
        const video = document.querySelector('video');
        window.__livePopupState = {
          path: location.pathname,
          comment,
          video,
          stream: video?.srcObject || null,
        };
        comment.click();
      `);
      const card = await profilePage.waitForFunction(`
        const node = document.querySelector('.modal .live-profile-card');
        return node ? node.innerText : null;
      `, 8000);
      if (!card.includes(`@${liveCommentAuthor.username}`)) {
        throw new Error(`perfil rapido incorreto: ${card}`);
      }
      const uninterrupted = await profilePage.eval(`
        const before = window.__livePopupState;
        const video = document.querySelector('video');
        return location.pathname === before.path
          && document.body.contains(before.comment)
          && (!before.video || (before.video === video
            && video.isConnected && video.srcObject === before.stream));
      `);
      if (!uninterrupted) throw new Error('abrir o perfil rapido alterou a LIVE ou seu stream');
      const avatarMatches = await profilePage.eval(`
        const image = document.querySelector('.modal .live-profile-avatar img');
        return image?.getAttribute('src') || null;
      `);
      if (avatarMatches !== liveCommentAuthor.avatarUrl) {
        throw new Error(`foto do perfil rapido divergente: ${avatarMatches}`);
      }
      const actions = await profilePage.eval(`
        return [...document.querySelectorAll('.modal .live-profile-actions button')]
          .map((button) => button.textContent.trim());
      `);
      if (!actions.includes('Seguir') || !actions.includes('Ver perfil')) {
        throw new Error(`acoes ausentes no perfil rapido: ${actions.join(', ')}`);
      }
      await profilePage.eval(`
        [...document.querySelectorAll('.modal .live-profile-actions button')]
          .find((button) => button.textContent.trim() === 'Seguir').click();
      `);
      await profilePage.waitForFunction(`
        return [...document.querySelectorAll('.modal .live-profile-actions button')]
          .some((button) => button.textContent.trim() === 'Seguindo');
      `, 8000);
      await profilePage.eval(`
        [...document.querySelectorAll('.modal .live-profile-actions button')]
          .find((button) => button.textContent.trim() === 'Ver perfil').click();
      `);
      await profilePage.waitForFunction(
        `location.pathname === '/@${liveCommentAuthor.username}' && document.querySelector('.profile-head')`,
        8000,
      );
      const profileUser = await profilePage.eval(`
        return document.querySelector('.profile-user')?.textContent.trim() || null;
      `);
      if (profileUser !== `@${liveCommentAuthor.username}`) {
        throw new Error(`navegacao abriu perfil incorreto: ${profileUser}`);
      }
      if (profilePage.errors.length) {
        throw new Error(`erro no navegador do perfil rapido: ${profilePage.errors.join(' | ')}`);
      }
      return 'avatar real, resumo, seguir, ver perfil; LIVE mantida ate a navegacao solicitada';
    });

    await report.step('nenhum erro de console acumulado ao final da navegacao', async () => {
      // Ignora o que foi PROVOCADO de proposito (violacao CSP do passo anterior)
      // e o que e externo ao app (favicon, player do YouTube).
      const expected = app.expectedConsole || [];
      const real = app.consoleErrors.filter((message) => {
        if (expected.includes(message)) return false;
        if (/Content Security Policy|violates the following/i.test(message)) return false;
        if (/favicon|ytimg|youtube|google/i.test(message)) return false;
        if (/net::ERR_ABORTED/i.test(message)) return false;
        return true;
      });
      if (real.length) {
        const notFound = app.requests
          .map((r) => r.url)
          .filter((u) => /404/.test(u));
        void notFound;
        throw new Error(`${real.length} erro(s): ${real.slice(0, 3).join(' | ')}`);
      }
      return `${app.requests.length} requisicoes, ${expected.length} violacao CSP esperada(s), 0 erro inesperado`;
    });

    report.ok('navegador exercitado com WebRTC e midia reais');
  } catch (error) {
    report.fail('fluxo de navegador interrompido', error);
  } finally {
    for (const session of sessions) {
      try { await session.close(); } catch { /* ignore */ }
    }
    if (browser) await browser.close();
    await server.stop();
  }

  return report.summary();
}

run().then((result) => {
  process.exit(result.failed > 0 ? 1 : 0);
}).catch((error) => {
  console.error('erro fatal:', error);
  process.exit(1);
});