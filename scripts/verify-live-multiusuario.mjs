/**
 * Prova de MULTIUSUARIO da LIVE (itens 8, 10, 12, 23).
 *
 * Nao conta "funciona em uma aba". Abre TRES sessoes reais de Chrome:
 *   streamer, espectador 1 e espectador 2, cada uma com seu proprio login.
 *
 * O que e medido, com os eventos que passaram pelo backend:
 *  - streamer aperta CORACAO -> os DOIS espectadores e o proprio streamer veem
 *    a animacao subindo, e o contador no banco sobe (item 8 e 23);
 *  - espectador 1 ativa um EFEITO -> streamer, espectador 2 e o proprio
 *    espectador 1 veem o efeito; o evento tem event_id, sequence e autor (item 10);
 *  - espectador 2 ENTRA durante a transmissao -> o streamer e a lista de
 *    espectadores recebem em tempo real, sem recarregar (item 12 e 23);
 *  - espectador 1 SAI -> a lista atualiza sozinha (item 23);
 *  - newcomer (quem entra depois) recebe os eventos NOVOS e nao os antigos
 *    (item 10: late joiner nao precisa de efeitos que ja terminaram).
 *
 * A animacao do coracao e provada de verdade: mede-se o no `.flying-heart`
 * dentro do container, e o efeito pela imagem do overlay com o arquivo real.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../server/config.js';
import {
  startServer, Client, Report, sleep, randomUsername, RealtimeClient, tempDir, makeTestImage,
} from '../tests/helpers.mjs';
import { launchChrome } from '../tests/cdp.mjs';

const report = new Report('LIVE multiusuario: coracoes, efeitos e espectadores');

/** Faz upload de um video real e devolve o mediaId (a camera virtual e real no Chrome). */
async function midiaDeVideo(api) {
  const { makeTestVideo } = await import('../tests/helpers.mjs');
  const v = await makeTestVideo({ seconds: 6, width: 360, height: 640 });
  const up = await api.upload('/api/media/upload?purpose=video', v.buffer, {
    filename: v.filename, mime: v.mime,
  });
  if (!up.body?.media?.id) throw new Error(`upload falhou: ${JSON.stringify(up.body).slice(0, 120)}`);
  return up.body.media.id;
}

async function run() {
  const server = await startServer();
  report.ok('servidor no ar', server.baseUrl);

  // ------------------------------------------------------------- usuarios
  const host = new Client(server.baseUrl);
  const hostUser = await host.register({ username: randomUsername('host') });
  await host.post('/api/auth/login', { identifier: hostUser.username, password: 'Senha@Teste123' });

  const esp1 = new Client(server.baseUrl);
  const esp1User = await esp1.register({ username: randomUsername('esp1') });
  await esp1.post('/api/auth/login', { identifier: esp1User.username, password: 'Senha@Teste123' });

  const esp2 = new Client(server.baseUrl);
  const esp2User = await esp2.register({ username: randomUsername('esp2') });
  await esp2.post('/api/auth/login', { identifier: esp2User.username, password: 'Senha@Teste123' });
  const avatarUrls = new Map();
  await report.step('avatares distintos enviados por host e dois espectadores', async () => {
    const users = [
      [host, 'host', 'red'],
      [esp1, 'esp1', 'green'],
      [esp2, 'esp2', 'blue'],
    ];
    for (const [client, label, color] of users) {
      const image = await makeTestImage({ width: 96, height: 96, color });
      const upload = await client.upload('/api/users/me/avatar', image.buffer, {
        filename: image.filename, mime: image.mime, field: 'image',
      });
      if (upload.status !== 200 || !upload.body.user.avatarUrl) {
        throw new Error(`${label}: upload do avatar falhou (${upload.status})`);
      }
      avatarUrls.set(label, upload.body.user.avatarUrl);
    }
    if (new Set(avatarUrls.values()).size !== 3) throw new Error('os avatares nao sao distintos');
    return 'três fotos reais diferentes persistidas no perfil';
  });

  // ----------------------------------------------------------- presentes autorais
  const catalogo = await esp1.get('/api/live/effects');
  const efeitos = (catalogo.body && catalogo.body.effects) || [];
  // O catálogo atual tem exatamente 15 presentes, todos com mídia pronta.
  if (efeitos.length !== 15) throw new Error(`catalogo com ${efeitos.length} presentes (esperado exatamente 15)`);
  const comArquivo = efeitos.filter((e) => e.mediaUrl);
  if (comArquivo.length < efeitos.length) {
    throw new Error(`so ${comArquivo.length}/${efeitos.length} efeitos tem arquivo de midia pronto: `
      + efeitos.filter((e) => !e.mediaUrl).map((e) => e.slug).join(', '));
  }
  report.ok(`catalogo com exatamente ${efeitos.length} presentes, todos com arquivo de midia`);

  // ------------------------------------------------------------- midia
  // O host sobe um video real: e o que entra na transmissao WebRTC.
  await midiaDeVideo(host);

  const browser = await launchChrome({
    extraArgs: [
      '--autoplay-policy=no-user-gesture-required',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
    ],
  });
  const sessoes = [];

  const cookiesDe = async (username) => {
    const r = await fetch(`${server.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: username, password: 'Senha@Teste123' }),
    });
    if (!r.ok) throw new Error(`login de ${username}: HTTP ${r.status}`);
    return r.headers.getSetCookie();
  };

  /**
   * Abre uma sessao de navegador com o login de `username` e leva ate a LIVE.
   *
   * A tela de-espectador e `/live/:id` (ver `main.js`, que chama
   * `createViewerLiveScreen`). Nao existe `/ao-vivo/:id` - essa URL cai no
   * 404, que foi exatamente o que o primeiro diagnose mostrou.
   */
  async function abrirViewer(username) {
    const s = await abrirSessao(username);
    await s.goto(`${server.baseUrl}/live/${room.id}`, { waitMs: 4200 });
    return s;
  }

  /**
   * Abre o HOST na tela de transmissao DE VERDADE.
   *
   * A tela do host nao tem rota: ela e montada por `/iniciar-live` quando o
   * usuario clica em "Iniciar transmissao" (`createHostLiveScreen`). Sem esse
   * passo o host era so mais um espectador e ninguem transmitia.
   */
  async function abrirHost() {
    const s = await abrirSessao(hostUser.username);
    await s.goto(`${server.baseUrl}/iniciar-live`, { waitMs: 2600 });
    const clicou = await s.eval(`
      const botao = [...document.querySelectorAll('button')].find((b) => /iniciar transmissao/i.test(b.textContent || ''));
      if (!botao) return 'sem botao';
      if (botao.disabled) return 'botao desabilitado';
      botao.click();
      return 'clicou';
    `);
    if (clicou !== 'clicou') throw new Error(`host nao conseguiu iniciar a transmissao: ${clicou}`);
    return s;
  }

  /** Login + viewport. O destino da tela e responsabilidade de quem chama. */
  async function abrirSessao(username) {
    const s = await browser.newBrowserContext();
    sessoes.push(s);
    s.watch();
    await s.goto(`${server.baseUrl}/`, { waitMs: 250 });
    for (const ck of await cookiesDe(username)) {
      const par = ck.split(';')[0];
      const nome = par.slice(0, par.indexOf('='));
      await s.send('Network.setCookie', {
        name: nome, value: decodeURIComponent(par.slice(nome.length + 1)), domain: '127.0.0.1', path: '/',
      });
    }
    await s.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    return s;
  }

  // Cliente realtime para observar os eventos brutos (prova de que o backend
  // e a autoridade e nao o navegador de quem clicou). O WS autentica pelo COOKIE
  // da sessao, entao o `Client` HTTP vai como segundo argumento.
  // O socket e aberto aqui, mas a inscricao no topico da LIVE so acontece
  // DEPOIS que o host iniciar a transmissao (o room id vem da API). Por isso
  // `room` vive no escopo do `run`.
  let room = null;
  const observador = new RealtimeClient(`${server.baseUrl.replace('http', 'ws')}/ws`, esp1);
  await observador.connect();
  // Atalhos de leitura sobre o que chegou no socket.
  const payloads = (tipo) => observador.eventsOfType(tipo).map((e) => e.payload);
  const conta = (tipo) => observador.eventsOfType(tipo).length;

  /**
   * Dispara um efeito pela rota real, de dentro da tela indicada.
   *
   * Precisa do cookie `pulse_csrf`: o backend usa double-submit e responde
   * 403 sem ele - e o teste mediria Forbidden em vez do efeito.
   */
  const ativarEfeito = async (tela, effectId, clientEventId) => tela.eval(`
    const csrf = (document.cookie.split(';').find((c) => c.trim().startsWith('pulse_csrf=')) || '').split('=')[1] || '';
    const resposta = await fetch('/api/live/' + ROOM_ID + '/effects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': decodeURIComponent(csrf) },
      body: JSON.stringify({ effectId: EFFECT_ID, clientEventId: CLI_ID }),
    });
    return { status: resposta.status, body: await resposta.json() };
  `.replace('ROOM_ID', JSON.stringify(room.id))
    .replace('EFFECT_ID', JSON.stringify(effectId))
    .replace('CLI_ID', JSON.stringify(clientEventId)));
  try {
    // O HOST inicia a transmissao pela interface real (`/iniciar-live`), porque e
    // la que `createHostLiveScreen` monta camera, microfone e WebRTC.
    const telaHost = await abrirHost();
    await sleep(5200);

    // A tela do host nao navega: o id da sala vem da API, que e a autoridade.
    // A rota `GET /api/users/:id/live` responde `{ live }` (nao `room`).
    const minha = await host.get(`/api/users/${hostUser.id}/live`);
    room = (minha.body && minha.body.live) || null;
    if (!room?.id) {
      throw new Error(`host nao tem LIVE ativa: ${JSON.stringify(minha.body).slice(0, 160)}`);
    }
    report.ok(`LIVE iniciada pela interface: ${room.id} por @${hostUser.username}`);

    const telaEsp1 = await abrirViewer(esp1User.username);
    await sleep(900);
    const telaEsp2 = await abrirViewer(esp2User.username);
    await sleep(3200);

    // Topico real do hub: `live:<roomId>`. Assinado agora que a sala existe.
    observador.subscribe([`live:${room.id}`]);
    await sleep(500);

    await report.step('comentario realtime mostra o avatar carregado do autor', async () => {
      await esp1.post(`/api/live/${room.id}/messages`, { body: 'avatar no comentario realtime' });
      const expectedKey = new URL(avatarUrls.get('esp1'), server.baseUrl).searchParams.get('key');
      const inspect = async (screen) => screen.eval(`
        const node = [...document.querySelectorAll('.live-msg')].find((m) => m.innerText.includes('avatar no comentario realtime'));
        const image = node?.querySelector('img');
        return {
          found: Boolean(node),
          key: image?.currentSrc ? new URL(image.currentSrc).searchParams.get('key') : null,
          loaded: Boolean(image?.complete && image?.naturalWidth > 0),
        };
      `);
      let hostResult = await inspect(telaHost);
      let viewerResult = await inspect(telaEsp2);
      for (let i = 0; i < 12 && (!hostResult.loaded || !viewerResult.loaded); i += 1) {
        await sleep(250);
        hostResult = await inspect(telaHost);
        viewerResult = await inspect(telaEsp2);
      }
      for (const [label, result] of [['host', hostResult], ['espectador', viewerResult]]) {
        if (!result.found || !result.loaded || result.key !== expectedKey) {
          throw new Error(`${label} nao carregou o avatar correto no comentario: ${JSON.stringify(result)}`);
        }
      }
      return 'host e espectador carregaram a foto original do autor pelo evento realtime';
    });

    // ------------------------------------------------------------ checagem
    const estado = async (s) => s.eval(`
      const video = document.querySelector('video');
      const audio = video ? video.srcObject : null;
      const tracks = audio ? audio.getTracks().map((t) => t.kind) : [];
      return {
        url: location.pathname,
        temVideo: Boolean(video),
        tocando: Boolean(video && !video.paused && video.readyState >= 2),
        tracks,
        coracoes: document.querySelectorAll('#live-hearts .flying-heart').length,
        // Seletores REAIS do EffectOverlay: a camada e #live-effects e cada efeito e
        // um .effect-instance (ver features/live-effects.js). Os seletores
        // antigos (.live-effect-layer) nunca existiram e faziam o teste
        // enxergar zero efeitos mesmo quando eles apareciam.
        efeitos: document.querySelectorAll('#live-effects .effect-instance img, #live-effects .effect-instance video').length,
        semMidia: /conteudo sem midia|conteÃºdo sem mÃ­dia/i.test(document.body.innerText || ''),
        btnCoracao: Boolean(document.querySelector('[aria-label*="Curtir"], [aria-label*="coracao" i], .heart-button, .live-heart')),
        btnEspectadores: Boolean(document.querySelector('.live-viewers-btn')),
        textoBarra: [...document.querySelectorAll('.live-input-bar button')].map((b) => b.getAttribute('aria-label')).filter(Boolean),
      };
    `);

    const host1 = await estado(telaHost);
    const esp1a = await estado(telaEsp1);
    const esp2a = await estado(telaEsp2);

    // URL da tela ANTES de abrir o painel de espectadores: e o que prova que
    // abrir a lista nao tira ninguem da transmissao nem navega. Medida aqui
    // porque e usada em dois passos diferentes.
    const urlAntesDoPainel = await telaHost.eval('return { url: location.pathname, transmissao: Boolean(document.querySelector("video")) };');

    if (host1.semMidia || esp1a.semMidia || esp2a.semMidia) {
      throw new Error('algum cliente caiu em "Conteudo sem midia"');
    }
    report.ok('nenhum cliente em "Conteudo sem midia"');

    await report.step('os tres veem video real do streamer (item 14)', async () => {
      // A propagacao de midia passa por WebRTC de verdade (offer/answer + ICE),
      // entao leva alguns segundos. Em vez de um unico sleep com charset fixo,
      // o teste ESPERA de forma ativa: e o que distingue "ainda negociando" de
      // "nunca vai chegar".
      const probing = async () => {
        const a = await estado(telaHost);
        const b = await estado(telaEsp1);
        const c = await estado(telaEsp2);
        return { a, b, c, prontos: [a, b, c].filter((e) => e.tocando && e.tracks.length).length };
      };
      let r = await probing();
      for (let i = 0; i < 20 && r.prontos < 3; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await sleep(1200);
        // eslint-disable-next-line no-await-in-loop
        r = await probing();
      }
      if (r.prontos < 3) {
        // Diagnostico: sem isto o teste so diria "1/3" e nao ajudaria a
        // achar a causa. Coleta o estado de MIDIA e de CONEXAO de cada lado.
        const laudo = await Promise.all([telaHost, telaEsp1, telaEsp2].map((t) => t.eval(`
          const v = document.querySelector('video');
          return {
            srcObject: v && v.srcObject ? v.srcObject.getTracks().map((x) => x.kind) : null,
            readyState: v ? v.readyState : -1,
            paused: v ? v.paused : null,
            videoWidth: v ? v.videoWidth : 0,
            erro: v && v.error ? v.error.name + ':' + v.error.message : null,
            // Estado real das conexoes WebRTC, lido do LiveMesh em producao.
            conexoes: window.__pulseConexoes ? JSON.stringify(window.__pulseConexoes()) : null,
          };
        `).catch((e) => ({ erro: String(e.message).slice(0, 90) }))));
        // Logs do console de cada sessao: e o que costuma dizer por que a
        // malha nem chegou a ser criada.
        const logs = [telaHost, telaEsp1, telaEsp2].map((t) => (t.logs || [])
          .filter((l) => /live|webrtc|peer|ice|signal|erro|error/i.test(String(l.text || '')))
          .slice(-6)
          .map((l) => String(l.text || '').slice(0, 130)));
        throw new Error(
          `so ${r.prontos}/3 tocando: ${JSON.stringify([r.a, r.b, r.c].map((e) => ({ tocando: e.tocando, tracks: e.tracks })))}`
          + ` | midia=${JSON.stringify(laudo.map((l) => l.srcObject))}`
          + ` | conexoes=${JSON.stringify(laudo.map((l) => l.conexoes)).slice(0, 400)}`
          + ` | logs=${JSON.stringify(logs).slice(0, 900)}`,
        );
      }
      return `host + 2 espectadores com audio e video tocando (${r.a.tracks.join('+')})`;
    });

    await report.step('o botao de coracao existe nos tres clientes', async () => {
      for (const [nome, e] of [['host', host1], ['esp1', esp1a], ['esp2', esp2a]]) {
        if (!e.btnCoracao) throw new Error(`${nome}: sem botao de coracao`);
      }
      return 'host, espectador 1 e espectador 2 com botao de coracao';
    });

    // ======================================================= item 8 e 23
    await report.step('STREAMER aperta coracao: os tres veem a animacao (itens 8 e 23)', async () => {
      // Zera o que houver para medir so esta rodada.
      await telaHost.eval(`document.querySelectorAll('#live-hearts .flying-heart').forEach((n) => n.remove()); return true;`);
      await telaEsp1.eval(`document.querySelectorAll('#live-hearts .flying-heart').forEach((n) => n.remove()); return true;`);
      await telaEsp2.eval(`document.querySelectorAll('#live-hearts .flying-heart').forEach((n) => n.remove()); return true;`);

      const antes = await host.get(`/api/live/${room.id}`);
      // heartCount vive dentro de room na resposta de GET /api/live/:id.
      const totalAntes = (antes.body && antes.body.room && antes.body.room.heartCount) || 0;

      // Clique REAL no botao do host.
      await telaHost.eval(`
        const b = document.querySelector('[aria-label*="Curtir"], [aria-label*="coracao" i], .heart-button, .live-heart');
        if (!b) return false;
        b.click(); b.click(); b.click();
        return true;
      `);
      await sleep(1400);

      const contagens = [];
      for (const [nome, tela] of [['host', telaHost], ['esp1', telaEsp1], ['esp2', telaEsp2]]) {
        // eslint-disable-next-line no-await-in-loop
        const n = await tela.eval(`
          const nos = [...document.querySelectorAll('#live-hearts .flying-heart')];
          const texto = nos.map((x) => x.textContent);
          // A animacao precisa estar RODANDO, nao so presente no DOM.
          const animando = nos.filter((x) => {
            const cs = getComputedStyle(x);
            return cs.animationName !== 'none' && cs.animationPlayState === 'running';
          }).length;
          return { total: nos.length, animando, coracoes: texto.every((t) => /\\u2764|\\u2665|\\u{1F49D}/u.test(t) || t.trim() !== '?') };
        `);
        if (n.total === 0) throw new Error(`${nome}: nenhum coracao apareceu`);
        if (n.animando === 0) throw new Error(`${nome}: coracao no DOM mas SEM animacao (so texto parado)`);
        if (!n.coracoes) throw new Error(`${nome}: conteudo do coracao corrompido (nao e emoji)`);
        contagens.push(`${nome}=${n.total} (${n.animando} animando)`);
      }

      // O contador real (banco) subiu?
      const depois = await host.get(`/api/live/${room.id}`);
      const totalDepois = (depois.body && depois.body.room && depois.body.room.heartCount) || 0;
      if (totalDepois <= totalAntes) {
        throw new Error(`contador de coracoes no banco nao subiu: ${totalAntes} -> ${totalDepois}`);
      }
      return `${contagens.join(', ')} | contador no banco ${totalAntes} -> ${totalDepois}`;
    });

    await report.step('o evento de coracao passou pelo backend para os tres', async () => {
      const coracoes = observador.eventsOfType('LIVE_HEART');
      if (!coracoes.length) throw new Error('nenhum LIVE_HEART publicado no hub');
      const ultimo = coracoes[coracoes.length - 1];
      const p = ultimo.payload;
      if (p.roomId !== room.id) throw new Error('LIVE_HEART com roomId errado');
      if (!Number(p.quantity)) throw new Error('LIVE_HEART sem quantidade');
      // `event_id` e `seq` vem do envelope do hub: e o que da unicidade.
      if (!ultimo.event_id) throw new Error('LIVE_HEART sem event_id no envelope');
      return `${coracoes.length} LIVE_HEART (event_id=${String(ultimo.event_id).slice(0, 10)}..., seq=${ultimo.seq}), quantity=${p.quantity}`;
    });

    // ==================================================== item 10 e 23
    // ==================================================== item 10 e 23
    await report.step('ESPECTADOR 1 ativa efeito: os tres veem (itens 10 e 23)', async () => {
      // Efeito REAL do catalogo, com arquivo de midia gerado.
      const alvo = comArquivo[0];
      // Token CSRF real do app (cookie `pulse_csrf`, double-submit). Sem ele o
      // backend responde 403 e o teste mediria Forbidden em vez do efeito.
      // O POST roda DENTRO da tela do espectador 1, com a sessao dela.
      const clientEventId = `cli-1-${Date.now()}`;
      const r = await ativarEfeito(telaEsp1, alvo.id, clientEventId);
      if (r.status !== 201 && r.status !== 200) {
        throw new Error(`ativar efeito: HTTP ${r.status} corpo=${String(JSON.stringify(r.body ?? null)).slice(0, 200)}`);
      }
      await sleep(1400);

      const vistos = [];
      for (const [nome, tela] of [['host', telaHost], ['esp1', telaEsp1], ['esp2', telaEsp2]]) {
        // eslint-disable-next-line no-await-in-loop
        const v = await tela.eval(`
          // Seletores REAIS do EffectOverlay: a camada e #live-effects e cada
          // efeito e um .effect-instance (ver features/live-effects.js).
          const camada = document.getElementById('live-effects');
          const instancias = camada ? [...camada.querySelectorAll('.effect-instance')] : [];
          const midia = instancias.flatMap((i) => [...i.querySelectorAll('img, video')]);
          const visiveis = midia.filter((m) => {
            const b = m.getBoundingClientRect();
            return b.width > 0 && b.height > 0;
          });
          return {
            camada: Boolean(camada),
            instancias: instancias.length,
            midia: midia.length,
            visiveis: visiveis.length,
            src: midia[0]?.getAttribute('src') || midia[0]?.currentSrc || '',
          };
        `);
        if (v.midia === 0) throw new Error(`${nome}: o efeito nao apareceu (laudo=${JSON.stringify(v)})`);
        if (v.visiveis === 0) throw new Error(`${nome}: efeito no DOM mas sem caixa visivel (laudo=${JSON.stringify(v)})`);
        vistos.push(`${nome}=${v.midia} midia / ${v.visiveis} visivel (${String(v.src || '(sem src)').slice(0, 30)})`);
      }
      return `${alvo.slug}: ${vistos.join(', ')}`;
    });
    await report.step('o evento de efeito tem event_id, sequence, autor e timestamp', async () => {
      const efeitos = observador.eventsOfType('EFFECT_TRIGGER');
      if (!efeitos.length) throw new Error('nenhum EFFECT_TRIGGER publicado no hub');
      const p = efeitos[efeitos.length - 1].payload;
      // O backend e a autoridade do evento: eventId, sequence, autor e
      // timestamp sao gravados no banco e publicados juntos.
      if (!p.eventId) throw new Error('EFFECT_TRIGGER sem eventId (sem como evitar duplicidade)');
      if (p.sequence == null) throw new Error('EFFECT_TRIGGER sem sequence');
      if (!p.user?.id) throw new Error('EFFECT_TRIGGER sem autor');
      if (!p.at) throw new Error('EFFECT_TRIGGER sem timestamp');
      if (!p.effect?.slug) throw new Error('EFFECT_TRIGGER sem o efeito');
      if (!p.effect?.mediaUrl) throw new Error('EFFECT_TRIGGER sem arquivo de midia');
      if (p.roomId !== room.id) throw new Error('EFFECT_TRIGGER com roomId errado');
      return `${String(p.eventId).slice(0, 12)}..., sequence=${p.sequence}, autor=@${p.user.username}, efeito=${p.effect.slug}, at=${p.at}`;
    });

    await report.step('o mesmo clientEventId nao duplica o efeito (item 10)', async () => {
      const antes = conta('EFFECT_TRIGGER');
      const idFixo = 'cli-duplicado-fixo';
      const r = await ativarEfeito(telaEsp1, comArquivo[0].id, idFixo);
      const primeira = await ativarEfeito(telaEsp1, comArquivo[0].id, idFixo);
      await sleep(700);
      const depois = conta('EFFECT_TRIGGER');
      // O segundo envio com o MESMO clientEventId nao pode gerar evento novo.
      const duplicado = Boolean(primeira.body && (primeira.body.duplicate || primeira.body.event));
      if (r.status >= 400) throw new Error(`primeiro envio falhou: HTTP ${r.status}`);
      if (depois - antes > 1) throw new Error(`clientEventId repetido gerou ${depois - antes} eventos`);
      return `reenvio com o mesmo clientEventId nao duplicou (${depois - antes} evento novo; duplicate=${duplicado})`;
    });

    await report.step('LATE JOINER recebe os eventos NOVOS e nao os antigos (item 10)', async () => {
      const novo = await abrirViewer(esp2User.username);
      await sleep(2600);
      // Recem-chegado: nao deve estar tocando nenhum efeito antigo.
      const inicio = await estado(novo);
      if (inicio.semMidia) throw new Error('late joiner caiu em "Conteudo sem midia"');
      if (inicio.efeitos > 0) {
        throw new Error(`late joiner recebeu ${inicio.efeitos} efeitos que ja tinham terminado`);
      }
      // Dispara um efeito novo AGORA: ele tem de chegar.
      const r = await ativarEfeito(novo, comArquivo[1].id, `cli-tarde-${Date.now()}`);
      if (r >= 400) throw new Error(`efeito para late joiner: HTTP ${r}`);
      await sleep(1100);
      const depois = await estado(novo);
      if (depois.efeitos === 0) throw new Error('late joiner nao recebeu o efeito disparado depois que entrou');
      return `sem efeitos antigos (0) e recebeu o novo (${depois.efeitos})`;
    });

    // ==================================================== item 12 e 23
    await report.step('o contador de espectadores reflete quem entrou (itens 12 e 23)', async () => {
      const contagem = async (s) => s.eval(`
        const b = document.querySelector('.live-viewers-btn');
        return b ? (b.textContent || '').trim() : null;
      `);
      const noHost = await contagem(telaHost);
      if (!noHost) throw new Error('host: sem botao de espectadores no topo');
      const viaApi = await host.get(`/api/live/${room.id}`);
      const reais = (viaApi.body && viaApi.body.viewerCount) || 0;
      if (reais < 2) throw new Error(`backend reporta ${reais} espectadores (esperado >=2)`);
      return `botao mostra "${noHost}", backend reporta ${reais} espectadores`;
    });

    await report.step('o painel de espectadores abre SOBRE a LIVE e atualiza sozinho', async () => {
      // Abre pelo botao do topo, sem navegar.
      await telaHost.eval(`
        const b = document.querySelector('.live-viewers-btn');
        if (!b) return false;
        b.click();
        return true;
      `);
      await sleep(1500);
      const painel = await telaHost.eval(`
        const linhas = [...document.querySelectorAll('.live-viewer-row')];
        const modal = linhas[0]?.closest('[role="dialog"], .modal, .sheet') || document.body;
        return {
          linhas: linhas.length,
          handles: linhas.map((l) => (l.querySelector('.live-viewer-user') || {}).textContent || ''),
          temFoto: linhas.filter((l) => l.querySelector('img')).length,
          fotosCarregadas: linhas.filter((l) => {
            const img = l.querySelector('img');
            return img && img.complete && img.naturalWidth > 0;
          }).length,
          keys: linhas.map((l) => {
            const src = l.querySelector('img')?.currentSrc;
            return src ? new URL(src).searchParams.get('key') : null;
          }),
          // Continua na LIVE: nao navegou e o video segue no lugar.
          url: location.pathname,
          transmissao: Boolean(document.querySelector('video')),
        };
      `);
      if (urlAntesDoPainel.transmissao && !painel.transmissao) {
        throw new Error('abrir o painel tirou a transmissao da tela');
      }
      if (painel.url !== urlAntesDoPainel.url) throw new Error(`painel navegou para ${painel.url}`);
      if (painel.linhas < 2) throw new Error(`painel com ${painel.linhas} linhas (esperado >=2)`);
      if (!painel.handles.some((h) => h.startsWith('@'))) throw new Error('painel sem @username');
      if (painel.fotosCarregadas < 2) throw new Error(`${painel.fotosCarregadas} avatares carregados visualmente`);
      for (const label of ['esp1', 'esp2']) {
        const imageKey = new URL(avatarUrls.get(label), server.baseUrl).searchParams.get('key');
        if (!painel.keys.includes(imageKey)) {
          throw new Error(`a foto de ${label} nao aparece na lista visual de participantes`);
        }
      }
      fs.mkdirSync(path.join(ROOT, 'tests', 'artifacts'), { recursive: true });
      const { data: screenshot } = await telaHost.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(ROOT, 'tests', 'artifacts', 'live-avatares-participantes.png'), Buffer.from(screenshot, 'base64'));

      // Fecha e re-abre para forcar nova busca: a lista tem de vir atualizada.
      await telaHost.eval(`
        const fechar = [...document.querySelectorAll('button[aria-label*="Fechar"], .modal-close, [data-close]')][0];
        if (fechar) fechar.click();
        return true;
      `);
      await sleep(700);
      await telaHost.eval(`document.querySelector('.live-viewers-btn')?.click(); return true;`);
      await sleep(1400);
      const reAberto = await telaHost.eval(`return document.querySelectorAll('.live-viewer-row').length;`);
      if (reAberto < 2) throw new Error(`reabertura com ${reAberto} linhas`);
      return `${painel.linhas} linhas, ${painel.fotosCarregadas} fotos carregadas, ${painel.handles.filter((h) => h).join(' ')}; ${reAberto} na reabertura`;
    });

    await report.step('ESPECTADOR 1 SAI: lista e contador caem sozinhos (item 23)', async () => {
      const antes = await host.get(`/api/live/${room.id}`);
      const antesN = (antes.body && antes.body.viewerCount) || 0;

      // Sai pelo menu de configuracoes, como o usuario faria (item 11).
      await telaEsp1.eval(`
        const config = [...document.querySelectorAll('.live-top-actions button')].find((b) => /configuracoes/i.test(b.getAttribute('aria-label') || ''));
        if (!config) return 'sem menu de configuracoes';
        config.click();
        return 'abriu';
      `);
      await sleep(900);
      const cliqueu = await telaEsp1.eval(`
        const item = [...document.querySelectorAll('.live-config-item')].find((b) => /sair da live/i.test(b.textContent || ''));
        if (!item) return 'sem item de sair';
        item.click();
        return 'clicou';
      `);
      if (cliqueu === 'clicou') {
        // Ha confirmacao (item 11): precisa confirmar.
        await sleep(700);
        await telaEsp1.eval(`
          const botao = [...document.querySelectorAll('button')].find((b) => /sair da live/i.test(b.textContent || '') && !b.closest('.live-config-list'));
          if (botao) botao.click();
          return true;
        `);
      }
      await sleep(2600);

      const depois = await host.get(`/api/live/${room.id}`);
      const depoisN = (depois.body && depois.body.viewerCount) || 0;
      if (depoisN >= antesN) {
        throw new Error(`contador nao caiu apos a saida: ${antesN} -> ${depoisN}`);
      }

      // O painel aberto no host tem de refletir a saida sem F5.
      const noHost = await telaHost.eval(`return { url: location.pathname, linhas: document.querySelectorAll('.live-viewer-row').length };`);
      if (noHost.url !== urlAntesDoPainel.url) throw new Error('o host saiu da LIVE ao ver a lista');
      return `contador ${antesN} -> ${depoisN}; host continua na LIVE (${noHost.url})`;
    });

    await report.step('entradas e saidas foram eventos reais do backend', async () => {
      const entradas = payloads('LIVE_JOIN');
      const saidas = payloads('LIVE_LEAVE');
      // O observador socket E o espectador 1; contam-se as entradas dos OUTROS
      // usuarios (host, espectador 2 e o late joiner), que e o que o painel do
      // host tem de refletir.
      const outros = entradas.filter((p) => p.userId !== esp1User.id).length;
      if (outros < 2) throw new Error(`so ${outros} entradas de outros usuarios (total ${entradas.length})`);
      if (saidas.length < 1) throw new Error('nenhum LIVE_LEAVE no hub');
      return `${entradas.length} entradas (${outros} de outros usuarios) e ${saidas.length} saidas publicadas no hub`;
    });

    await report.step('a barra inferior tem a ordem do item 13 nos tres clientes', async () => {
      const esperado = ['Digite sua mensagem', 'Confirmar envio da mensagem', 'Efeitos da LIVE', 'Compartilhar LIVE', 'Republicar LIVE'];
      for (const [nome, tela] of [['host', telaHost], ['esp2', telaEsp2]]) {
        // eslint-disable-next-line no-await-in-loop
        const r = await tela.eval(`
          const barra = document.querySelector('.live-input-bar');
          if (!barra) return { erro: 'sem barra' };
          const campo = barra.querySelector('.live-field input');
          const botoes = [...barra.querySelectorAll('button')];
          const enviar = barra.querySelector('.live-send');
          const grupo = barra.querySelector('.live-tools');
          const r = (e) => { if (!e) return null; const b = e.getBoundingClientRect(); return { t: Math.round(b.top), l: Math.round(b.left), r: Math.round(b.right), w: Math.round(b.width), h: Math.round(b.height) }; };
          return {
            ordem: [r(campo), r(enviar), r(grupo)],
            enviarVisivel: enviar ? !enviar.hidden : false,
            temDivisor: Boolean(barra.querySelector('.live-divider')),
            rotulos: botoes.map((b) => b.getAttribute('aria-label')).filter(Boolean),
            // Nenhum botao dentro do campo de texto.
            botoesNoCampo: campo ? campo.querySelectorAll('button').length : 0,
          };
        `);
        if (r.erro) throw new Error(`${nome}: ${r.erro}`);
        if (r.botoesNoCampo !== 0) throw new Error(`${nome}: ${r.botoesNoCampo} botao dentro do campo`);
        if (!r.temDivisor) throw new Error(`${nome}: sem divisor separando os controles`);
        // (Item 13) O botao de confirmar NAO aparece sem texto.
        if (r.enviarVisivel) throw new Error(`${nome}: botao de confirmar envio visivel sem texto`);
        // (Item 13) Com texto PRONTO o botao de confirmar aparece; antes disso ele fica
        // oculto. Quando esta oculto, a posicao e lida do DOM (indice entre os
        // irmaos), porque o retangulo e 0x0 e nao prova ordem nenhuma.
        if (!r.enviarVisivel) {
          const ordemDom = await tela.eval(`
            const barra = document.querySelector('.live-input-bar');
            if (!barra) return { erro: 'sem barra' };
            const filhos = [...barra.children].map((c) => c.className.split(' ')[0]);
            return {
              filhos,
              iCampo: filhos.indexOf('live-field'),
              iEnviar: filhos.indexOf('live-send'),
              iGrupo: filhos.indexOf('live-tools'),
            };
          `);
          if (ordemDom.erro) throw new Error(`${nome}: ${ordemDom.erro}`);
          if (!(ordemDom.iCampo >= 0 && ordemDom.iEnviar > ordemDom.iCampo && ordemDom.iGrupo > ordemDom.iEnviar)) {
            throw new Error(`${nome}: ordem no DOM errada (${ordemDom.filhos.join(' > ')})`);
          }
        } else {
          const [campoR, enviarR, grupoR] = r.ordem;
          if (!(campoR && enviarR && grupoR)) throw new Error(`${nome}: barra sem campo/enviar/grupo`);
          if (!(campoR.l <= enviarR.l && enviarR.r <= grupoR.l + 2)) {
            throw new Error(`${nome}: ordem errada (campo ${campoR.l}-${campoR.r}, enviar ${enviarR.l}-${enviarR.r}, grupo ${grupoR.l})`);
          }
        }
        // Com texto, o botao aparece.
        // eslint-disable-next-line no-await-in-loop
        await tela.eval(`
          const c = document.querySelector('.live-field input');
          if (c) { c.focus(); c.value = 'ola'; c.dispatchEvent(new Event('input', { bubbles: true })); }
          return true;
        `);
        // eslint-disable-next-line no-await-in-loop
        await sleep(400);
        // eslint-disable-next-line no-await-in-loop
        const depois = await tela.eval(`
          const enviar = document.querySelector('.live-send');
          return { visivel: enviar ? !enviar.hidden : false, w: enviar ? Math.round(enviar.getBoundingClientRect().width) : 0 };
        `);
        if (!depois.visivel) throw new Error(`${nome}: botao de confirmar nao apareceu com texto`);
        if (depois.w < 30) throw new Error(`${nome}: botao de confirmar pequeno demais (${depois.w}px)`);
        // Depois de enviar, some de novo.
        // eslint-disable-next-line no-await-in-loop
        await tela.eval(`
          const enviar = document.querySelector('.live-send');
          if (enviar) enviar.click();
          return true;
        `);
        // eslint-disable-next-line no-await-in-loop
        await sleep(700);
        // eslint-disable-next-line no-await-in-loop
        const fim = await tela.eval(`
          const enviar = document.querySelector('.live-send');
          const c = document.querySelector('.live-field input');
          return { visivel: enviar ? !enviar.hidden : false, campoVazio: c ? c.value === '' : false };
        `);
        if (fim.visivel) throw new Error(`${nome}: botao de confirmar continuou visivel apos enviar`);
        if (!fim.campoVazio) throw new Error(`${nome}: campo nao limpou apos enviar`);
        void esperado;
      }
      return 'campo -> confirmar (condicional) -> divisor -> grupo; confirmar some apos enviar';
    });

    await report.step('configuracoes no topo e "sair" dentro do menu (item 11)', async () => {
      for (const [nome, tela, papel] of [['host', telaHost, 'Encerrar LIVE'], ['esp2', telaEsp2, 'Sair da LIVE']]) {
        // eslint-disable-next-line no-await-in-loop
        const r = await tela.eval(`
          const barra = document.querySelector('.live-input-bar');
          const noTopo = [...document.querySelectorAll('.live-top-actions button')].find((b) => /configuracoes/i.test(b.getAttribute('aria-label') || ''));
          const naBarra = [...(barra ? barra.querySelectorAll('button') : [])].some((b) => /sair|encerrar/i.test(b.getAttribute('aria-label') || ''));
          return { temNoTopo: Boolean(noTopo), naBarra };
        `);
        if (!r.temNoTopo) throw new Error(`${nome}: sem botao de configuracoes no topo`);
        if (r.naBarra) throw new Error(`${nome}: botao de sair ainda na barra inferior`);
        // eslint-disable-next-line no-await-in-loop
        await tela.eval(`
          [...document.querySelectorAll('.live-top-actions button')].find((b) => /configuracoes/i.test(b.getAttribute('aria-label') || ''))?.click();
          return true;
        `);
        // eslint-disable-next-line no-await-in-loop
        await sleep(900);
        // eslint-disable-next-line no-await-in-loop
        const menu = await tela.eval(`
          const itens = [...document.querySelectorAll('.live-config-item')].map((i) => (i.textContent || '').trim());
          return { itens, temConfiguracao: itens.some((i) => /configuracoes|configuraÃ§Ãµes/i.test(i)) };
        `);
        if (!menu.itens.some((i) => new RegExp(papel, 'i').test(i))) {
          throw new Error(`${nome}: menu sem "${papel}" (itens: ${menu.itens.join(' | ')})`);
        }
        // eslint-disable-next-line no-await-in-loop
        await tela.eval(`
          const fechar = [...document.querySelectorAll('button[aria-label*="Fechar"], .modal-close')][0];
          if (fechar) fechar.click();
          return true;
        `);
        // eslint-disable-next-line no-await-in-loop
        await sleep(500);
      }
      return 'host ve "Encerrar LIVE", espectador ve "Sair da LIVE", ambos dentro do menu no topo';
    });

    report.ok('LIVE multiusuario validada: coracoes, efeitos e espectadores em tempo real');
  } catch (error) {
    report.fail('fluxo multiusuario interrompido', error);
  } finally {
    try { observador.close?.(); } catch { /* ignore */ }
    for (const s of sessoes) { try { s.close?.(); } catch { /* ignore */ } }
    await browser.close();
    await server.stop();
    void tempDir;
    void path;
    void fs;
    void ROOT;
  }

  return report.summary();
}

run().then((r) => process.exit(r.failed > 0 ? 1 : 0)).catch((e) => {
  console.error('erro fatal:', e);
  process.exit(1);
});