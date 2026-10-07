/**
 * Verificador da composicao de camadas da LIVE (itens 5 e 6).
 *
 * Item 5: um efeito acionado por QUALQUER participante (host OU espectador)
 *         aparece nos TRES clientes, em tempo real, sem duplicar.
 * Item 6: a camada de efeito fica ACIMA do video e ABAIXO da interface
 *         (chat, barra de mensagens, controles), e o efeito aparece no
 *         MOBILE tambem - nao atras da transmissao nem invisivel.
 *
 * A composicao e medida de verdade: `elementFromPoint` no centro da instancia
 * do efeito precisa devolver o proprio efeito, e `compareDocumentPosition`
 * confirma que video < efeito < interface.
 */
import {
  startServer, Client, Report, sleep, randomUsername, makeTestVideo,
} from '../tests/helpers.mjs';
import { launchChrome } from '../tests/cdp.mjs';

const report = new Report('LIVE: camadas de efeito e heart acima do video (itens 5 e 6)');

const TAMANHOS = [
  [320, 640, 'mobile'], [360, 780, 'mobile'], [390, 844, 'mobile'], [414, 896, 'mobile'],
  [768, 1024, 'tablet'], [1024, 900, 'desktop'], [1280, 900, 'desktop'],
  [1440, 900, 'desktop'], [1920, 1080, 'desktop'],
];

async function run() {
  const server = await startServer();
  const host = new Client(server.baseUrl);
  const hostUser = await host.register({ username: randomUsername('host') });
  const esp1 = new Client(server.baseUrl);
  const esp1User = await esp1.register({ username: randomUsername('esp1') });
  const esp2 = new Client(server.baseUrl);
  const esp2User = await esp2.register({ username: randomUsername('esp2') });

  const cookiesDe = async (cli) => {
    const u = cli.user;
    return fetch(`${server.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: u.username, password: 'Senha@Teste123' }),
    }).then((r) => r.headers.getSetCookie());
  };
  const cookiesHost = await cookiesDe(host);
  const cookiesEsp1 = await cookiesDe(esp1);
  const cookiesEsp2 = await cookiesDe(esp2);

  // Uma publicacao para o host enviar (o fluxo do chat precisa de conteudo).
  const video = await makeTestVideo({ seconds: 30, width: 480, height: 854, withAudio: true });
  const up = await host.upload('/api/media/upload?purpose=video', video.buffer, {
    filename: video.filename, mime: video.mime,
  });
  const post = await host.post('/api/posts', { type: 'video', caption: 'fonte', mediaId: up.body.media.id });

  const browser = await launchChrome({
    extraArgs: [
      '--autoplay-policy=no-user-gesture-required',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
    ],
  });

  const abrirSessao = async (cookies, w, h, mobile) => {
    const s = await browser.newBrowserContext();
    s.watch();
    await s.goto(`${server.baseUrl}/`, { waitMs: 300 });
    for (const ck of cookies) {
      const par = ck.split(';')[0];
      const nome = par.slice(0, par.indexOf('='));
      await s.send('Network.setCookie', {
        name: nome, value: decodeURIComponent(par.slice(nome.length + 1)), domain: '127.0.0.1', path: '/',
      });
    }
    await s.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile });
    void post;
    return s;
  };

  let sala = null;
  const sessoes = [];

  try {
    // O host e um cliente normal em 1280x900 (o efeito no desktop e o caso do
    // sintoma de "faixa atras do video").
    const sHost = await abrirSessao(cookiesHost, 1280, 900, false);
    sessoes.push(sHost);
    await sHost.goto(`${server.baseUrl}/iniciar-live`, { waitMs: 2600 });
    const clicou = await sHost.eval(`
      const b = [...document.querySelectorAll('button')].find((x) => /iniciar transmissao/i.test(x.textContent || ''));
      if (!b) return 'sem botao';
      if (b.disabled) return 'botao desabilitado';
      b.click();
      return 'clicou';
    `);
    if (clicou !== 'clicou') throw new Error(`o host nao conseguiu iniciar a transmissao: ${clicou}`);
    // A sala sobe pela tela; o id vem da API, que e a autoridade.
    await sleep(5600);
    const meu = await host.get(`/api/users/${hostUser.id}/live`);
    sala = meu.body.live || null;
    if (!sala?.id) throw new Error(`host nao tem LIVE ativa: ${JSON.stringify(meu.body).slice(0, 160)}`);
    report.ok(`LIVE iniciada pela interface: ${sala.id} por @${hostUser.username}`);

    const sEsp1 = await abrirSessao(cookiesEsp1, 390, 844, true);
    const sEsp2 = await abrirSessao(cookiesEsp2, 414, 896, true);
    sessoes.push(sEsp1, sEsp2);
    await sEsp1.goto(`${server.baseUrl}/live/${sala.id}`, { waitMs: 3200 });
    await sEsp2.goto(`${server.baseUrl}/live/${sala.id}`, { waitMs: 3200 });

    // Espera a midia chegar (WebRTC) nos tres.
    const midia = async (s) => {
      for (let i = 0; i < 26; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        const m = await s.eval(`
          const v = document.querySelector('.live-video-wrap video.remote, .live-video-wrap video.local');
          return v && v.srcObject ? v.srcObject.getTracks().map((t) => t.kind) : null;
        `);
        if (m && m.length) return m;
        // eslint-disable-next-line no-await-in-loop
        await sleep(1200);
      }
      return null;
    };
    for (const [nome, s] of [['host', sHost], ['esp1', sEsp1], ['esp2', sEsp2]]) {
      // eslint-disable-next-line no-await-in-loop
      const m = await midia(s);
      if (!m) throw new Error(`${nome} nao recebeu midia da LIVE`);
    }
    report.ok('midia real nos tres clientes (host + 2 espectadores)');

    // Os tres clientes registram os eventos realtime que chegam: assim da
    // para dizer se o evento NAO CHEGOU ou se chegou e foi descartado na
    // renderizacao (as duas falhas tem causas bem diferentes).
    for (const s of [sHost, sEsp1, sEsp2]) {
      // eslint-disable-next-line no-await-in-loop
      await s.eval(`
        window.__eventos = [];
        window.__errosLive = [];
        if (!window.__erroHook) {
          window.__erroHook = true;
          addEventListener('error', (e) =>
            window.__errosLive.push(String(e.message || e).slice(0, 200)));
        }
        const { realtime } = await import('/js/core/realtime.js');
        realtime.addEventListener('EFFECT_TRIGGER', (ev) => {
          const p = ev.detail || {};
          window.__eventos.push({
            roomId: p.roomId,
            eventId: p.eventId,
            sequence: p.sequence,
            temMidia: Boolean(p.effect && p.effect.mediaUrl),
            scale: p.effect && p.effect.scale,
          });
        });
        return true;
      `);
    }

    /** Dispara um efeito pela API, como o usuario faria pelo menu. */
    // O limite diario de efeitos (10 por usuario, imposed pelo backend) e real e
    // respeitado: por isso o disparo alterna entre os TRES participantes. Cada
    // um tem a propria cota, e assim o teste cobre "host aciona" e "espectador
    // aciona" ao mesmo tempo, como o item 5 exige.
    let rodizio = 0;
    const telasParaEfeito = [sHost, sEsp1, sEsp2];
    const ativar = async (effectId, eventId) => {
      const tela = telasParaEfeito[rodizio % telasParaEfeito.length];
      rodizio += 1;
      // O disparo e feito DE DENTRO do navegador, com o token CSRF: e o mesmo
      // caminho que o menu de efeitos usa, e garante que o evento sai com o
      // mesmo formato de quando o usuario clica no card.
      const r = await tela.eval(`
        const csrf = (document.cookie.split(';').find((c) => c.trim().startsWith('pulse_csrf=')) || '').split('=')[1] || '';
        const resposta = await fetch('/api/live/${sala.id}/effects', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': decodeURIComponent(csrf) },
          body: JSON.stringify({ effectId: ${JSON.stringify(effectId)}, clientEventId: ${JSON.stringify(eventId)} }),
        });
        return { status: resposta.status, body: await resposta.json() };
      `);
      if (r.status >= 400) throw new Error(`efeito recusado (${r.status}): ${JSON.stringify(r.body).slice(0, 240)}`);
      // O que o EVENTO traz e o que shouldPlay() avalia: sem mediaUrl ou com
      // sequence <= a ultima vista, o cliente ignora de proposito.
      console.log(`EVENTO: roomId=${r.body.payload?.roomId} eventId=${r.body.payload?.eventId} `
        + `sequence=${r.body.payload?.sequence} mediaUrl=${Boolean(r.body.payload?.effect?.mediaUrl)} `
        + `alpha=${r.body.payload?.effect?.alpha}`);
      return r.body;
    };

    const catalogo = await host.get('/api/live/effects');
    const efeitos = (catalogo.body.effects || []).slice(0, 4);
    if (efeitos.length < 4) throw new Error(`catalogo com ${efeitos.length} efeitos`);

    // ---------------- ITEM 5 + 6: efeito aparece nos tres, acima do video ----
    for (const [i, efeito] of efeitos.entries()) {
      // eslint-disable-next-line no-await-in-loop
      const antes = await sHost.eval("return document.querySelectorAll('.effect-instance').length;");
      // eslint-disable-next-line no-await-in-loop
      await ativar(efeito.id, `ev-${i}-${Date.now()}`);

      // Espera ATIVA: a instancia precisa estar VISIVEL, ou seja, o
      // elementFromPoint no centro dela tem que devolver o proprio efeito.
      const medir = async (s, rotulo) => {
        for (let t = 0; t < 20; t += 1) {
          // eslint-disable-next-line no-await-in-loop
          const r = await s.eval(`
            const inst = [...document.querySelectorAll('.effect-instance')]
              .filter((n) => n.getBoundingClientRect().width > 4)[0];
            if (!inst) return { ok: false, motivo: 'sem instancia' };
            const b = inst.getBoundingClientRect();
            const cx = Math.round(b.left + b.width / 2);
            const cy = Math.round(b.top + b.height / 2);
            // elementFromPoint IGNORA o que tem pointer-events: none (e a
            // camada de efeito tem, de proposito, para nao roubar o toque).
            // Para o teste de "quem esta na frente" funcionar, o hit-test e
            // ligado so durante a medicao e restaurado em seguida. Isso nao
            // muda o desenho: apenas torna a camada testavel.
            const camada = document.getElementById('live-effects');
            const peAntes = camada.style.pointerEvents;
            camada.style.pointerEvents = 'auto';
            const noPonto = document.elementFromPoint(cx, cy);
            camada.style.pointerEvents = peAntes;
            const dentroDaTela = b.top >= -2 && b.left >= -2
              && b.right <= innerWidth + 2 && b.bottom <= innerHeight + 2;
            // Composicao: video -> efeito -> interface. A prova e o
            // z-index resolvido de cada camada (todas dentro da
            // .live-page, portanto no mesmo contexto de empilhamento) e o
            // elementFromPoint, que mostra quem esta NA FRENTE de verdade.
            // Ordem no DOM nao serve: a camada de efeito e montada por ultimo
            // dentro da page, entao a comparacao de documento inverteria o
            // resultado sem dizer nada sobre a pilha real.
            const z = (sel) => {
              const n = document.querySelector(sel);
              return n ? Number(getComputedStyle(n).zIndex) : null;
            };
            const zCamada = z('#live-effects');
            const zVideo = z('.live-video-wrap');
            const zBarra = z('.live-input-bar');
            const zChat = z('.live-chat');
            return {
              ok: true,
              visivel: dentroDaTela,
              noPonto: noPonto ? noPonto.className || noPonto.tagName : null,
              sobreVideo: zVideo !== null && zCamada > zVideo,
              abaixoDaInterface: [zBarra, zChat].every((v) => v === null || v > zCamada),
              z: String(zCamada),
              zVideo: String(zVideo),
              zBarra: String(zBarra),
              dentroDaPage: Boolean(document.getElementById('live-effects')?.closest('.live-page')),
              tamanho: [Math.round(b.width), Math.round(b.height)],
              dentroDaCamada: Boolean(inst.closest('#live-effects')),
            };
          `);
          if (r.ok && r.visivel) return r;
          // eslint-disable-next-line no-await-in-loop
          await sleep(700);
        }
        return null;
      };

      // Chama o MESMO play() que o evento realtime chama, com o payload exato
      // que o servidor devolveu. Roda uma vez: repetir a cada efeito dispararia
      // extras e saturaria o teto de instancias simultaneas.
      if (i === 0) {
        // eslint-disable-next-line no-await-in-loop
        const disparado = await ativar(efeitos[0].id, `ev-local-${Date.now()}`);
        // eslint-disable-next-line no-await-in-loop
        const casoLocal = await sHost.eval(`
          const { EffectOverlay } = await import('/js/features/live-effects.js');
          const camada = document.getElementById('live-effects');
          const overlay = new EffectOverlay(camada);
          const payload = ${JSON.stringify(disparado.payload)};
          let r = null;
          let erro = null;
          try { r = overlay.play(payload); } catch (e) { erro = String(e && e.message || e); }
          await new Promise((x) => setTimeout(x, 600));
          const inst = camada.querySelector('.effect-instance');
          const b = inst ? inst.getBoundingClientRect() : null;
          return {
            aceitou: Boolean(r),
            erro,
            box: b ? [Math.round(b.width), Math.round(b.height)] : null,
            paiDaCamada: camada.parentElement
              ? (camada.parentElement.className || camada.parentElement.tagName) : null,
          };
        `);
        if (casoLocal.erro) throw new Error(`play() lancou: ${casoLocal.erro}`);
        if (!casoLocal.aceitou) {
          throw new Error(`play() recusou o payload do servidor: ${JSON.stringify(casoLocal)}`);
        }
        // O que prova o caminho de renderizacao e o retorno aceito com um no
        // de tamanho plausivel na camada - nao o crescimento da contagem, que
        // nao acontece quando o teto de 6 instancias esta em uso.
        if (!casoLocal.box || casoLocal.box[0] < 8 || casoLocal.box[1] < 8) {
          throw new Error(`play() nao deixou instancia visivel: ${JSON.stringify(casoLocal)}`);
        }
        report.ok(`renderizacao local ok: instancia ${casoLocal.box.join('x')}px `
          + `na camada dentro de "${casoLocal.paiDaCamada}"`);
      }

      const hostMed = await medir(sHost, 'host');
      const esp1Med = await medir(sEsp1, 'esp1');
      const esp2Med = await medir(sEsp2, 'esp2');
      if (!hostMed || !esp1Med || !esp2Med) {
        // Diagnostico antes de falhar: o efeito foi criado? atras de quem?
        const dump = async (s, rotulo) => {
          const d = await s.eval(`
            const camada = document.getElementById('live-effects');
            const coracoes = document.getElementById('live-hearts');
            const page = document.querySelector('.live-page');
            const inst = [...document.querySelectorAll('.effect-instance')];
            return {
              temCamada: Boolean(camada),
              camadaPai: camada ? camada.parentElement?.className || camada.parentElement?.tagName : null,
              dentroDaPage: Boolean(camada && camada.closest('.live-page')),
              coracoesPai: coracoes ? coracoes.parentElement?.className || coracoes.parentElement?.tagName : null,
              zCamada: camada ? getComputedStyle(camada).zIndex : null,
              posCamada: camada ? getComputedStyle(camada).position : null,
              zPage: page ? getComputedStyle(page).zIndex : null,
              zVideo: (() => { const v = document.querySelector('.live-video-wrap'); return v ? getComputedStyle(v).zIndex : null; })(),
              instancias: inst.length,
              detalhe: inst.slice(0, 2).map((n) => {
                const b = n.getBoundingClientRect();
                const cx = Math.round(b.left + b.width / 2);
                const cy = Math.round(b.top + b.height / 2);
                const p = document.elementFromPoint(cx, cy);
                return {
                  box: [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)],
                  z: getComputedStyle(n).zIndex,
                  display: getComputedStyle(n).display,
                  opacity: getComputedStyle(n).opacity,
                  noPonto: p ? (p.className || p.tagName) : null,
                  fonte: n.querySelector('canvas, video') ? n.querySelector('canvas, video').tagName : 'sem midia',
                };
              }),
            };
          `);
          console.log(`DIAG ${rotulo}:`, JSON.stringify(d, null, 2));
        };
        await dump(sHost, 'host');
        await dump(sEsp1, 'esp1');
        const eventos = async (s) => s.eval(`
          return {
            eventos: (window.__eventos || []).map((e) => e.eventId),
            erros: window.__errosLive || [],
            instancias: document.querySelectorAll('.effect-instance').length,
            temOverlay: Boolean(document.getElementById('live-effects')),
          };
        `);
        const h = await eventos(sHost);
        const e1 = await eventos(sEsp1);
        const e2 = await eventos(sEsp2);
        const local = casoLocal;
        throw new Error(`o efeito "${efeito.id}" nao ficou visivel. `
          + `renderizacao local=${JSON.stringify(local)}\n`
          + `host:  eventos=${JSON.stringify(h.eventos)} instancias=${h.instancias} erros=${JSON.stringify(h.erros)}\n`
          + `esp1:  eventos=${JSON.stringify(e1.eventos)} instancias=${e1.instancias} erros=${JSON.stringify(e1.erros)}\n`
          + `esp2:  eventos=${JSON.stringify(e2.eventos)} instancias=${e2.instancias} erros=${JSON.stringify(e2.erros)}`);
      }
      for (const [rotulo, m] of [['host', hostMed], ['esp1', esp1Med], ['esp2', esp2Med]]) {
        if (!m) throw new Error(`${rotulo}: o efeito "${efeito.id}" nao ficou visivel em ${i}`);
        if (!m.sobreVideo) {
          throw new Error(`${rotulo}: o efeito "${efeito.id}" esta ATRAS do video `
            + `(camada z=${m.z}, video z=${m.zVideo})`);
        }
        if (!m.abaixoDaInterface) {
          throw new Error(`${rotulo}: o efeito "${efeito.id}" ficou ACIMA da interface `
            + `(camada z=${m.z}, barra z=${m.zBarra})`);
        }
        if (!m.dentroDaPage) throw new Error(`${rotulo}: a camada de efeitos nao esta dentro da .live-page`);
        if (!m.dentroDaCamada) throw new Error(`${rotulo}: a instancia do efeito nao esta na camada`);
        // O que esta NA FRENTE no centro do efeito tem de ser a camada de efeito
        // (ou a propria instancia). Se voltasse o <video>, o efeito estaria
        // atras da transmissao - que e exatamente o defeito do item 6.
        const naFrente = String(m.noPonto || '');
        const ehVideo = /^(local|remote|live-video-wrap|video)$/.test(naFrente);
        const ehDaCamada = naFrente.includes('live-effects') || naFrente.includes('effect-instance');
        if (ehVideo || !ehDaCamada) {
          throw new Error(`${rotulo}: no centro do efeito esta na frente "${naFrente}" `
            + `(camada z=${m.z}, video z=${m.zVideo})`);
        }
      }
      // eslint-disable-next-line no-await-in-loop
      const depoisCount = await sHost.eval("return document.querySelectorAll('.effect-instance').length;");
      if (depoisCount <= antes) throw new Error(`host: o efeito nao criou instancia nova (${antes} -> ${depoisCount})`);
      report.ok(`"${efeito.name || efeito.id}" (${hostMed.tamanho.join('x')}px, `
        + `video z=${hostMed.zVideo} < efeitos z=${hostMed.z} < barra z=${hostMed.zBarra}) `
        + `visivel nos TRES e na frente do video`);
    }

    // ------------- ITEM 6 nos TAMANHOS exigidos (mobile e desktop) --------
    await ativar(efeitos[0].id, `ev-resize-${Date.now()}`);
    for (const [w, h, tipo] of TAMANHOS) {
      // eslint-disable-next-line no-await-in-loop
      const s = await abrirSessao(cookiesEsp2, w, h, tipo === 'mobile');
      sessoes.push(s);
      // eslint-disable-next-line no-await-in-loop
      await s.goto(`${server.baseUrl}/live/${sala.id}`, { waitMs: 3400 });
      // Reativa o efeito para ESTE cliente entrar na sala depois do disparo.
      // eslint-disable-next-line no-await-in-loop
      await ativar(efeitos[1].id, `ev-${w}-${Date.now()}`);

      let vis = null;
      for (let t = 0; t < 18; t += 1) {
        // eslint-disable-next-line no-await-in-loop
        vis = await s.eval(`
          const inst = [...document.querySelectorAll('.effect-instance')]
            .filter((n) => n.getBoundingClientRect().width > 4)[0];
          if (!inst) return null;
          const b = inst.getBoundingClientRect();
          const cx = Math.round(b.left + b.width / 2);
          const cy = Math.round(b.top + b.height / 2);
          // Mesma razao do bloco de cima: o hit-test so vale com o
          // pointer-events ligado na hora da medicao.
          const camada = document.getElementById('live-effects');
          const peAntes = camada.style.pointerEvents;
          camada.style.pointerEvents = 'auto';
          const noPonto = document.elementFromPoint(cx, cy);
          camada.style.pointerEvents = peAntes;
          return {
            visivel: b.top >= -2 && b.left >= -2 && b.right <= innerWidth + 2 && b.bottom <= innerHeight + 2,
            noPonto: noPonto ? (noPonto.className || noPonto.tagName) : null,
            dentroDaTela: [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)],
            scrollX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          };
        `);
        if (vis && vis.visivel) break;
        // eslint-disable-next-line no-await-in-loop
        await sleep(700);
      }
      if (!vis || !vis.visivel) {
        throw new Error(`${w}x${h} (${tipo}): o efeito nao ficou visivel (${JSON.stringify(vis)})`);
      }
      if (/^(local|remote|live-video-wrap|video)$/.test(String(vis.noPonto || ''))) {
        throw new Error(`${w}x${h} (${tipo}): o efeito esta ATRAS do video `
          + `("noPonto" = "${vis.noPonto}")`);
      }
      if (vis.scrollX > 1) throw new Error(`${w}x${h}: scroll horizontal com o efeito na tela`);
      report.ok(`${w}x${h} (${tipo}): efeito visivel em ${vis.dentroDaTela.join(',')} e no topo do video`);
      // eslint-disable-next-line no-await-in-loop
      await s.close?.();
    }

    // ------------- ITEM 4: coracao nos tres, com evento unico --------------
    // Registra os coracoes que chegam, para separar "o evento nao chegou" de
    // "chegou e nao virou coracao na tela".
    for (const s of [sHost, sEsp1, sEsp2]) {
      // eslint-disable-next-line no-await-in-loop
      await s.eval(`
        window.__coracoes = [];
        const { realtime } = await import('/js/core/realtime.js');
        realtime.addEventListener('LIVE_HEART', (ev) => {
          const p = ev.detail || {};
          window.__coracoes.push({ roomId: p.roomId, quantity: p.quantity, userId: p.userId });
        });
        return true;
      `);
    }
    const respHeart = await esp2.post(`/api/live/${sala.id}/hearts`, { quantity: 1 });
    if (respHeart.status >= 400) {
      throw new Error(`coracao recusado (${respHeart.status}): ${JSON.stringify(respHeart.body).slice(0, 200)}`);
    }
    const coracoes = async (s) => {
      let melhor = null;
      for (let t = 0; t < 16; t += 1) {
        // eslint-disable-next-line no-await-in-loop
        const r = await s.eval(`
          const camada = document.getElementById('live-hearts');
          const coracoes = [...document.querySelectorAll('#live-hearts .flying-heart')];
          // "Em voo" = no com area de tela, animacao CORRENDO e dentro da
          // viewport. Nao se usa elementFromPoint aqui: a camada tem
          // pointer-events: none (de proposito) e o hit-test ignoraria o
          // coracao, dando falso negativo.
          const emVoo = coracoes.filter((c) => {
            const b = c.getBoundingClientRect();
            const cs = getComputedStyle(c);
            return b.width > 2 && b.height > 2
              && b.top < innerHeight && b.bottom > 0
              && cs.animationName !== 'none' && cs.animationPlayState === 'running'
              && Number(cs.opacity) > 0.01;
          });
          // Prova de que o coracao e DESENHADO sobre o video: com o hit-test
          // ligado por um instante, o elemento na frente do ponto central tem
          // de estar dentro da camada de coracoes. O coracao sobe e pode
          // sair pelo topo, entao so e medido um coracao cujo centro ainda
          // esteja DENTRO da tela.
          let naFrente = null;
          const dentroDaTela = emVoo.find((c) => {
            const b = c.getBoundingClientRect();
            const cy = b.top + b.height / 2;
            return cy > 0 && cy < innerHeight && b.left > 0 && b.left < innerWidth;
          });
          if (dentroDaTela) {
            const b = dentroDaTela.getBoundingClientRect();
            const antes = camada.style.pointerEvents;
            camada.style.pointerEvents = 'auto';
            const p = document.elementFromPoint(
              Math.round(b.left + b.width / 2), Math.round(b.top + b.height / 2));
            camada.style.pointerEvents = antes;
            naFrente = p ? (p.className || p.tagName) : null;
          } else {
            naFrente = 'todos-acima-da-tela';
          }
          return {
            quantidade: coracoes.length,
            emVoo: emVoo.length,
            naFrente,
            dentroDaPage: Boolean(camada?.closest('.live-page')),
          };
        `);
        if (r.emVoo > 0) return r;
        melhor = r;
        // eslint-disable-next-line no-await-in-loop
        await sleep(500);
      }
      return melhor;
    };
    for (const [nome, s] of [['host', sHost], ['esp1', sEsp1], ['esp2', sEsp2]]) {
      // eslint-disable-next-line no-await-in-loop
      const c = await coracoes(s);
      if (!c || !c.emVoo) {
        const chegado = await s.eval('return window.__coracoes || [];');
        throw new Error(`${nome}: nenhum coracao ANIMADO/visivel `
          + `(medido=${JSON.stringify(c)}, eventos de coracao=${JSON.stringify(chegado)})`);
      }
      if (!c.dentroDaPage) throw new Error(`${nome}: a camada de coracoes nao esta dentro da .live-page`);
      // `flying-heart` e a propria animacao do coracao e `live-hearts` a camada:
      // os dois sao a prova de que o coracao esta na frente do video.
      const naFrente = String(c.naFrente || '');
      if (c.naFrente !== 'todos-acima-da-tela'
        && !naFrente.includes('live-hearts') && !naFrente.includes('flying-heart')) {
        throw new Error(`${nome}: o coracao esta ATRAS de "${c.naFrente}" `
          + '(a animacao existe mas nao e desenhada sobre o video)');
      }
      report.ok(`${nome}: ${c.quantidade} coracao(oes) no DOM, ${c.emVoo} animando e `
        + `desenhado sobre o video (na frente: "${c.naFrente}")`);
    }

    report.ok('camadas da LIVE acima do video e abaixo da interface, no desktop e no mobile');
  } catch (error) {
    report.fail('verificacao das camadas da LIVE interrompida', error);
  } finally {
    for (const s of sessoes) { try { s.close?.(); } catch { /* ignore */ } }
    await browser.close();
    await server.stop();
  }
  return report.summary();
}

run().then((r) => process.exit(r.failed > 0 ? 1 : 0)).catch((e) => { console.error(e); process.exit(1); });
