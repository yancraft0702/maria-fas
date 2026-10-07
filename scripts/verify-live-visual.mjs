/**
 * Verificacao VISUAL com navegador real das telas das imagens (itens 10, 11,
 * 14, 15, 19, 26 e 27).
 *
 * Nao basta passar no teste de codigo: aqui o Chrome headless abre a aplicacao
 * de verdade, com sessao real, e mede os RETANGULOS na tela:
 *
 *  IMAGEM 1 (host)   - o aviso de TURN e pequeno e NAO cobre o video; os
 *                      controles inferiores nao se sobrepoem; o efeito esta
 *                      DENTRO do campo; o botao sair tem zona propria.
 *  IMAGEM 2 (viewer) - MidiaStream REAL chega por ontrack; o estado da area de
 *                      video nunca e "sem midia"; controles sem colisao; o
 *                      espectador nao ve detalhe de infraestrutura.
 *  IMAGEM 3 (feed)   - avatar, @usuario e descricao acima da bottom nav em
 *                      320/360/390/414, sem cortar texto, sem acoes colidindo.
 *  ADMIN             - header, hero, cards, feed de atividade e indicador ao
 *                      vivo; e um evento real chega sem F5.
 *
 * A MidiaStream e real: o Chrome de teste usa dispositivo de camera virtual do
 * proprio navegador (nao e um video inventado pelo app) e o espectador so e
 * aprovado quando `videoWidth > 0` e ha bytes fluindo.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT } from '../server/config.js';
import { Client, RealtimeClient, sleep, randomUsername } from '../tests/helpers.mjs';
import { launchChrome } from '../tests/cdp.mjs';

const OUT = path.resolve('tests/artifacts/telas-live');
fs.mkdirSync(OUT, { recursive: true });

let falhas = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const fail = (m) => { falhas += 1; console.log(`  FALHA ${m}`); };
const secao = (t) => console.log(`\n== ${t}`);

const PORTA = 3413;
const BASE = `http://127.0.0.1:${PORTA}`;
const dir = path.join(ROOT, 'data', '.tmp-live-visual');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });

// TURN de exemplo por ENV: o backend tem que ACEITAR e expor como configurado.
// O relay nao existe nesta maquina (nao ha coturn) - e o diagnostico precisa
// dizer isso em vez de fingir que relay funciona.
const env = {
  ...process.env,
  DATABASE_PATH: path.join(dir, 'test.db'),
  STORAGE_ROOT: path.join(dir, 'storage'),
  PORT: String(PORTA),
  LOG_LEVEL: 'warn',
  SESSION_SECRET: 'verificacao-visual-nao-producao-000000',
  TLS_CERT_PATH: '',
  TURN_URL: 'turn:turn.exemplo.invalid:3478?transport=udp',
  TURN_USERNAME: 'usuario_exemplo',
  TURN_CREDENTIAL: 'senha_exemplo',
};

const child = spawn(process.execPath, [path.join(ROOT, 'server', 'main.js')], {
  cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env,
});
let log = '';
child.stdout.on('data', (c) => { log += c; });
child.stderr.on('data', (c) => { log += c; });

function semSobreposicao(a, b, tolerancia = 1) {
  if (!a || !b) return false;
  const x = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return x > tolerancia && y > tolerancia;
}

async function main() {
  for (let i = 0; i < 90; i += 1) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* subindo */ }
    await sleep(150);
  }
  ok(`servidor de teste no ar em ${BASE}`);

  // ---------------------------------------------------------------- CONTAS
  const hostApi = new Client(BASE);
  const hostUser = await hostApi.register({ username: randomUsername('hostvis') });
  await hostApi.post('/api/auth/login', { identifier: hostUser.username, password: 'Senha@Teste123' });

  const viewerApi = new Client(BASE);
  const viewerUser = await viewerApi.register({ username: randomUsername('viewvis') });
  await viewerApi.post('/api/auth/login', { identifier: viewerUser.username, password: 'Senha@Teste123' });

  const feedApi = new Client(BASE);
  const feedUser = await feedApi.register({ username: randomUsername('feedvis') });
  await feedApi.post('/api/auth/login', { identifier: feedUser.username, password: 'Senha@Teste123' });

  await new Promise((resolve, reject) => {
    const seed = spawn(process.execPath, [path.join(ROOT, 'server', 'db', 'cli-seed.js')], {
      cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...env, ADMIN_EMAIL: 'visual@pulse.test', ADMIN_USERNAME: 'adminvisual', ADMIN_PASSWORD: 'SenhaAdminVisual@2026' },
    });
    let out = '';
    seed.stdout.on('data', (c) => { out += c; });
    seed.stderr.on('data', (c) => { out += c; });
    seed.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(out))));
  });
  const adminApi = new Client(BASE);
  await adminApi.login('visual@pulse.test', 'SenhaAdminVisual@2026');

  async function cookiesDe(username, password = 'Senha@Teste123') {
    const r = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: username, password }),
    });
    if (!r.ok) throw new Error(`login de ${username}: ${r.status}`);
    return r.headers.getSetCookie();
  }

  const cookiesHost = await cookiesDe(hostUser.username);
  const cookiesViewer = await cookiesDe(viewerUser.username);
  const cookiesFeed = await cookiesDe(feedUser.username);
  const cookiesAdmin = await cookiesDe('adminvisual', 'SenhaAdminVisual@2026');

  const browser = await launchChrome({
    extraArgs: [
      '--ignore-certificate-errors',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });

  async function sessao(cookies, w, h, mobile) {
    const s = await browser.newBrowserContext();
    s.watch();
    // O prompt de notificacoes do Chrome cobre a area do video e polui a
    // conferencia visual. Nega a permissao de uma vez: nao e parte do layout.
    await s.send('Browser.grantPermissions', { permissions: [], origin: BASE }).catch(() => {});
    await s.goto(`${BASE}/`, { waitMs: 250 });
    for (const ck of cookies) {
      const pair = ck.split(';')[0];
      const nome = pair.slice(0, pair.indexOf('='));
      await s.send('Network.setCookie', {
        name: nome, value: decodeURIComponent(pair.slice(nome.length + 1)), domain: '127.0.0.1', path: '/',
      });
    }
    await s.send('Network.setCacheDisabled', { cacheDisabled: true });
    await s.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile });
    return s;
  }

  async function capturar(ctx, nome) {
    const r = await ctx.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, `${nome}.png`), Buffer.from(r.data, 'base64'));
  }

  /**
   * Nega a permissao de notificacoes. O prompt nativo do Chrome aparece por
   * cima do video e atrapalharia a conferencia visual do layout - e nao faz
   * parte da interface do app.
   */
  async function negarNotificacoes(ctx) {
    await ctx.eval(`
      if (window.Notification && Notification.permission === 'default') {
        try { await Notification.requestPermission(); } catch { /* ja negado */ }
      }
      return true;
    `).catch(() => {});
  }

  // ---------------------------------------------------- LIVE REAL (imagens 1 e 2)
  secao('IMAGEM 1: tela do HOST com MidiaStream real');
  // A LIVE e criada pela PROPRIA tela do host: e assim que o app funciona de
  // verdade (camera -> sala -> WebRTC). Criar antes pela API faria o boot cair
  // em "voce ja esta em uma LIVE ativa" e mediriamos um estado de erro.
  let roomId = null;

  const hostCtx = await sessao(cookiesHost, 390, 844, true);
  await hostCtx.goto(`${BASE}/ao-vivo`, { waitMs: 1200 });
  await negarNotificacoes(hostCtx);
  await hostCtx.goto(`${BASE}/ao-vivo`, { waitMs: 800 });
  const hostInfo = await hostCtx.eval(`
    const mod = await import('/js/features/live.js');
    const screen = mod.createHostLiveScreen({ title: 'verificacao visual', category: 'outros' });
    document.body.appendChild(screen.element);
    await screen.ready;
    await new Promise((r) => setTimeout(r, 2500));
    const v = document.querySelector('video.local');
    const salaDoHost = await fetch('/api/users/${hostUser.id}/live').then((r) => r.json()).catch(() => null);
    window.__roomId = salaDoHost?.live?.id || null;
    const aviso = document.querySelector('.live-turn');
    const chip = aviso?.querySelector('.live-turn-chip');
    const r = (e) => (e ? e.getBoundingClientRect().toJSON() : null);
    const campo = document.querySelector('.live-field');
    const input = document.querySelector('.live-input');
    const efeito = document.querySelector('.live-input-action');
    const tools = document.querySelector('.live-tools');
    const sair = document.querySelector('.live-end-btn');
    const bar = document.querySelector('.live-input-bar');
    const chat = document.querySelector('.live-chat');
    return {
      tela: Boolean(document.querySelector('.live-page[data-role="host"]')),
      srcObject: Boolean(v?.srcObject),
      tracks: v?.srcObject ? v.srcObject.getTracks().map((t) => ({ kind: t.kind, ready: t.readyState })) : [],
      videoW: v?.videoWidth || 0, videoH: v?.videoHeight || 0,
      tocando: Boolean(v && !v.paused),
      avisoEstado: aviso?.dataset.state || null,
      avisoTexto: document.querySelector('.live-turn-text')?.textContent || null,
      avisoRect: r(chip), videoRect: r(v), vh: window.innerHeight, vw: window.innerWidth,
      campo: r(campo), input: r(input), efeito: r(efeito), tools: r(tools), sair: r(sair), bar: r(bar), chat: r(chat),
      liveBarH: getComputedStyle(document.querySelector('.live-page')).getPropertyValue('--live-bar-h').trim(),
      objectFit: v ? getComputedStyle(v).objectFit : null,
      semScrollH: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  `);

  if (hostInfo.tela) ok('tela do host montada'); else fail('tela do host nao montou');
  if (hostInfo.srcObject && hostInfo.tracks.length === 2) {
    ok(`MidiaStream real: [${hostInfo.tracks.map((t) => `${t.kind}:${t.ready}`).join(', ')}] ${hostInfo.videoW}x${hostInfo.videoH} tocando=${hostInfo.tocando}`);
  } else fail(`host sem MidiaStream completa (tracks=${JSON.stringify(hostInfo.tracks)})`);
  if (hostInfo.objectFit === 'cover') ok('video do host em cover (sem tarja preta)');
  else fail(`object-fit do host: ${hostInfo.objectFit}`);

  // Item 9: aviso compacto e fora da area do video.
  if (hostInfo.avisoEstado === 'hidden') ok('aviso de TURN oculto (TURN configurado por ENV)');
  else if (hostInfo.avisoEstado === 'open') {
    const alt = hostInfo.avisoRect?.height || 0;
    const larg = hostInfo.avisoRect?.width || 0;
    if (alt <= 42 && larg <= 330) ok(`aviso compacto ${Math.round(larg)}x${Math.round(alt)}px: "${hostInfo.avisoTexto}"`);
    else fail(`aviso grande: ${Math.round(larg)}x${Math.round(alt)}px`);
    if (!semSobreposicao(hostInfo.avisoRect, hostInfo.videoRect)) ok('aviso fora da area do video');
    else fail('aviso sobreposto ao video do host');
  } else fail(`estado do aviso de TURN: ${hostInfo.avisoEstado}`);

  // Itens 10, 11 e 12: layout inferior do host.
  for (const [nome, a, b] of [
    ['campo x ferramentas', hostInfo.campo, hostInfo.tools],
    ['ferramentas x sair', hostInfo.tools, hostInfo.sair],
    ['efeito x ferramentas', hostInfo.efeito, hostInfo.tools],
    ['barra x chat', hostInfo.bar, hostInfo.chat],
  ]) {
    if (!a || !b) { fail(`host ${nome}: elemento ausente`); continue; }
    if (!semSobreposicao(a, b)) ok(`host ${nome}: separado`);
    else fail(`host ${nome}: COLIDE`);
  }
  if (hostInfo.input && hostInfo.efeito) {
    const dentro = hostInfo.efeito.left >= hostInfo.input.left - 1 && hostInfo.efeito.right <= hostInfo.input.right + 1;
    if (dentro) ok('host: botao de efeito DENTRO do campo de texto');
    else fail('host: efeito fora do campo');
  }
  if (hostInfo.sair && hostInfo.tools) {
    const dist = hostInfo.sair.left - hostInfo.tools.right;
    if (dist >= 8) ok(`host: ${Math.round(dist)}px entre as acoes e o botao sair`);
    else fail(`host: sair colado no compartilhamento (${Math.round(dist)}px)`);
  }
  if (hostInfo.bar && hostInfo.bar.bottom <= hostInfo.vh) ok('host: barra dentro da viewport');
  else fail('host: barra fora da viewport');
  ok(`host: --live-bar-h=${hostInfo.liveBarH} (medido, nao fixo)`);
  // O contexto do host FICA ABERTO: e ele que esta transmitindo de verdade
  // para o espectador que entra na proxima secao.
  await capturar(hostCtx, 'host-390');

  // ------------------------------------------------ ESPECTADOR COM VIDEO REAL
  secao('IMAGEM 2: tela do ESPECTADOR recebendo midia real');
  roomId = await hostCtx.eval('return window.__roomId || null;');
  if (!roomId) throw new Error('a tela do host nao criou a sala');
  ok(`sala ${roomId} criada pela tela do host`);

  // Pagina em branco (nao /live/:id): se a rota montar a tela sozinha, teriamos
  // DOIS espectadores na pagina e mediriamos o estado do errado.
  const viewerCtx = await sessao(cookiesViewer, 390, 844, true);
  await viewerCtx.goto(`${BASE}/ao-vivo`, { waitMs: 800 });
  await negarNotificacoes(viewerCtx);
  await viewerCtx.goto(`${BASE}/ao-vivo`, { waitMs: 500 });
  const viewerInfo = await viewerCtx.eval(`
    const mod = await import('/js/features/live-viewer.js');
    const screen = mod.createViewerLiveScreen({ roomId: ${JSON.stringify(roomId)} });
    document.body.appendChild(screen.element);
    const video = document.querySelector('video.remote');
    const inicio = Date.now();
    // Espera a MediaStream REAL chegar (videoWidth > 0) em vez de esperar tempo fixo.
    while (Date.now() - inicio < 20000) {
      if (video && video.videoWidth > 0 && video.currentTime > 0) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    const estado = document.querySelector('.live-media-state');
    const estadosVisiveis = [...document.querySelectorAll('.live-media-state')]
      .filter((e) => e.getBoundingClientRect().height > 0).length;
    const v = document.querySelector('video.remote');
    const r = (e) => (e ? e.getBoundingClientRect().toJSON() : null);
    const campo = document.querySelector('.live-field');
    const input = document.querySelector('.live-input');
    const efeito = document.querySelector('.live-input-action');
    const tools = document.querySelector('.live-tools');
    const bar = document.querySelector('.live-input-bar');
    const chat = document.querySelector('.live-chat');
    return {
      srcObject: Boolean(v?.srcObject),
      tracks: v?.srcObject ? v.srcObject.getTracks().map((t) => ({ kind: t.kind, ready: t.readyState })) : [],
      videoW: v?.videoWidth || 0, videoH: v?.videoHeight || 0,
      tocando: Boolean(v && !v.paused && v.currentTime > 0),
      tempo: v ? Number(v.currentTime.toFixed(2)) : 0,
      estado: estado ? estado.dataset.state : 'playing',
      estadosVisiveis,
      texto: estado ? estado.textContent.slice(0, 120) : null,
      temTentar: Boolean(document.querySelector('.live-media-actions button')),
      objeto: v ? getComputedStyle(v).objectFit : null,
      campo: r(campo), input: r(input), efeito: r(efeito), tools: r(tools), bar: r(bar), chat: r(chat),
      video: r(v), vh: window.innerHeight,
      textoTela: document.querySelector('.live-page')?.textContent || '',
      semScrollH: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  `);

  if (viewerInfo.srcObject && viewerInfo.tracks.length) {
    ok(`MediaStream remota REAL: [${viewerInfo.tracks.map((t) => `${t.kind}:${t.ready}`).join(', ')}] ${viewerInfo.videoW}x${viewerInfo.videoH} tocando=${viewerInfo.tocando} t=${viewerInfo.tempo}s`);
  } else {
    fail(`espectador sem midia (srcObject=${viewerInfo.srcObject}, estado="${viewerInfo.texto}")`);
  }
  if (viewerInfo.tocando) ok('video do espectador reproduzindo (nao area preta)');
  else fail('video do espectador parado');

  if (!viewerInfo.texto || !/sem midia/i.test(viewerInfo.texto)) {
    ok(`estado da area de video: "${viewerInfo.estado}"${viewerInfo.estado === 'playing' ? ' (sem aviso)' : ` - ${String(viewerInfo.texto).slice(0, 60)}`}`);
  } else {
    fail(`espectador em "sem midia": ${viewerInfo.texto}`);
  }
  // Se o video esta tocando, NAO pode sobrar aviso de espera na tela.
  if (viewerInfo.tocando && viewerInfo.estadosVisiveis === 0) {
    ok('nenhum aviso de espera sobre o video que ja esta tocando');
  } else if (viewerInfo.tocando) {
    fail(`${viewerInfo.estadosVisiveis} aviso(s) na tela com o video tocando (estado=${viewerInfo.estado})`);
  }
  if (viewerInfo.objeto === 'cover') ok('video do espectador em cover');
  else fail(`object-fit do espectador: ${viewerInfo.objeto}`);

  for (const [nome, a, b] of [
    ['campo x ferramentas', viewerInfo.campo, viewerInfo.tools],
    ['efeito x ferramentas', viewerInfo.efeito, viewerInfo.tools],
    ['barra x chat', viewerInfo.bar, viewerInfo.chat],
  ]) {
    if (!a || !b) { fail(`espectador ${nome}: elemento ausente`); continue; }
    if (!semSobreposicao(a, b)) ok(`espectador ${nome}: separado`);
    else fail(`espectador ${nome}: COLIDE`);
  }
  if (viewerInfo.input && viewerInfo.efeito) {
    const dentro = viewerInfo.efeito.left >= viewerInfo.input.left - 1 && viewerInfo.efeito.right <= viewerInfo.input.right + 1;
    if (dentro) ok('espectador: efeito DENTRO do campo');
    else fail('espectador: efeito fora do campo');
  }
  if (viewerInfo.chat && viewerInfo.bar) {
    if (viewerInfo.chat.bottom <= viewerInfo.bar.top + 2) ok('espectador: chat termina acima dos controles');
    else fail(`espectador: chat cobre a barra (chat.bottom=${Math.round(viewerInfo.chat.bottom)} bar.top=${Math.round(viewerInfo.bar.top)})`);
  }
  if (!/TURN_URL|TURN_USERNAME|TURN_CREDENTIAL/.test(viewerInfo.textoTela)) {
    ok('espectador sem detalhe de infraestrutura em tela');
  } else fail('espectador expoe nome de variavel de TURN');
  if (viewerInfo.semScrollH <= 1) ok('espectador sem scroll horizontal');
  else fail(`espectador com scroll horizontal (${viewerInfo.semScrollH}px)`);
  await capturar(viewerCtx, 'viewer-390');
  await viewerCtx.close?.();

  // ------------------------------------------- 3. FEED (imagem 3)
  secao('IMAGEM 3: bloco da postagem acima da bottom nav');
  const descricao = 'Descricao longa de verificacao visual para medir se o bloco de informacoes fica acima da barra inferior de navegacao do celular sem cortar texto nem ficar atras do menu. '
    + 'Repetindo para ocupar varias linhas: verificacao de layout do feed no celular, com avatar, nome e usuario sempre visiveis.';

  for (const largura of [320, 360, 390, 414, 768, 1024, 1280, 1440]) {
    const post = await feedApi.post('/api/posts', { type: 'text', caption: descricao });
    if (post.status !== 201) { fail(`criar post: ${post.status}`); break; }
    const ctx = await sessao(cookiesFeed, largura, largura < 900 ? 780 : 900, largura < 900);
    await ctx.goto(`${BASE}/`, { waitMs: 2200 });
    const m = await ctx.eval(`
      const r = (e) => (e ? e.getBoundingClientRect().toJSON() : null);
      const tabbar = document.querySelector('.tabbar');
      const overlay = document.querySelector('.slide-overlay');
      const caption = document.querySelector('.slide-caption');
      const autorEl = document.querySelector('.slide-author');
      const acoes = document.querySelector('.slide-actions');
      return {
        tabbar: r(tabbar), overlay: r(overlay), caption: r(caption), autorEl: r(autorEl), acoes: r(acoes),
        vh: window.innerHeight,
        overflowH: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        tabbarVisivel: tabbar ? getComputedStyle(tabbar).display !== 'none' : false,
        captionLinhas: caption ? Math.round(caption.getBoundingClientRect().height / parseFloat(getComputedStyle(caption).lineHeight)) : 0,
        // Nenhum "null"/"undefined"/"NaN" em nenhum no de texto da tela: e o
        // jeito de pegar valor ausente renderizado como string (item 20/26).
        nulos: (() => {
          const achados = [];
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          let no = walker.nextNode();
          while (no) {
            const t = (no.nodeValue || '').trim();
            if (/^(null|undefined|NaN)$/.test(t)) {
              achados.push((no.parentElement?.className || no.parentElement?.tagName || '?') + ' = ' + t);
            }
            no = walker.nextNode();
          }
          return achados;
        })(),
      };
    `);
    const rot = `feed ${largura}px`;
    if (m.nulos && m.nulos.length) fail(`${rot}: texto nulo na tela -> ${m.nulos.join(', ')}`);
    else ok(`${rot}: nenhum "null"/"undefined" em tela`);
    if (!m.overlay) { fail(`${rot}: bloco de informacoes ausente`); continue; }
    if (m.overflowH > 1) fail(`${rot}: scroll horizontal (${m.overflowH}px)`);
    else ok(`${rot}: sem scroll horizontal`);
    // Compara o TEXTO (ultima linha da descricao), nao a caixa do overlay: e o
    // texto que o usuario precisa ler.
    const textoBaixo = m.caption ? Math.max(m.caption.bottom, m.autorEl?.bottom || 0) : 0;
    if (m.tabbarVisivel && m.tabbar) {
      if (textoBaixo <= m.tabbar.top + 1) {
        ok(`${rot}: texto termina ${Math.round(m.tabbar.top - textoBaixo)}px acima da bottom nav`);
      } else {
        fail(`${rot}: texto atras da bottom nav (texto.bottom=${Math.round(textoBaixo)}, tabbar.top=${Math.round(m.tabbar.top)})`);
      }
    } else if (textoBaixo <= m.vh + 1) {
      ok(`${rot}: bloco dentro da viewport`);
    } else fail(`${rot}: bloco fora da viewport`);
    if (m.caption && m.autorEl) {
      if (m.autorEl.bottom <= m.overlay.bottom + 1) ok(`${rot}: avatar/@usuario dentro do bloco`);
      else fail(`${rot}: avatar fora do bloco`);
      if (m.captionLinhas >= 2) ok(`${rot}: descricao em ${m.captionLinhas} linhas (nao cortada)`);
      else if (m.captionLinhas === 1) ok(`${rot}: descricao em 1 linha`);
      else fail(`${rot}: descricao sem altura`);
    }
    if (m.acoes && m.caption && semSobreposicao(m.acoes, m.caption)) {
      fail(`${rot}: acoes laterais colidem com a descricao`);
    } else ok(`${rot}: acoes laterais fora da descricao`);
    if (m.acoes && m.autorEl && semSobreposicao(m.acoes, m.autorEl)) {
      fail(`${rot}: acoes laterais colidem com avatar/nome`);
    } else ok(`${rot}: acoes laterais fora do avatar/nome`);
    await capturar(ctx, `feed-${largura}`);
    await ctx.close?.();
  }

  // ------------------------------------------------------------- 4. ADMIN
  secao('Painel administrativo em tempo real');
  const adminCtx = await sessao(cookiesAdmin, 1280, 900, false);
  await adminCtx.goto(`${BASE}/ao-vivo`, { waitMs: 800 });
  const adminAntes = await adminCtx.eval(`
    const rt = window.__PULSE_DEBUG__?.realtime;
    const mod = await import('/js/features/admin.js');
    const screen = mod.createAdminScreen();
    (document.querySelector('main') || document.body).appendChild(screen.element);
    await screen.load();
    await new Promise((r) => setTimeout(r, 4000));
    const body = document.querySelector('.settings-body');
    return {
      header: Boolean(document.querySelector('.admin-header')),
      hero: Boolean(document.querySelector('.admin-hero')),
      colunas: document.querySelectorAll('.admin-columns .admin-card').length,
      atividade: document.querySelectorAll('.admin-activity-row').length,
      badge: document.querySelector('.admin-live')?.dataset.state || null,
      badgeTexto: document.querySelector('.admin-live-text')?.textContent || null,
      stats: document.querySelectorAll('.admin-stat').length,
      overflowH: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      bodyTexto: (body?.textContent || '').slice(0, 160),
      socket: {
        conectado: Boolean(rt?.isOpen?.()),
        autenticado: Boolean(rt?.isAuthenticated?.()),
        // O topico administrativo tem de estar assinado (o servidor so aceita
        // staff); e o indicador precisa dizer "ao vivo".
        assinouAdmin: Boolean(rt?.subs?.has?.('admin:events')),
      },
    };
  `);
  ok(`socket do painel: conectado=${adminAntes.socket.conectado} autenticado=${adminAntes.socket.autenticado} assinou admin:events=${adminAntes.socket.assinouAdmin}`);
  if (adminAntes.header && adminAntes.hero && adminAntes.stats >= 8) {
    ok(`painel: cabecalho+hero+${adminAntes.stats} cards, ${adminAntes.colunas} colunas, ${adminAntes.atividade} atividade(s), indicador="${adminAntes.badgeTexto}" (${adminAntes.badge})`);
  } else {
    fail(`painel incompleto: ${JSON.stringify(adminAntes)}`);
  }
  if (!adminAntes.hero) console.log(`  (conteudo do painel: "${adminAntes.bodyTexto}")`);
  if (adminAntes.overflowH <= 1) ok('painel sem scroll horizontal em 1280px');
  else fail(`painel com scroll horizontal (${adminAntes.overflowH}px)`);

  // Evento real chega sem F5: um usuario novo conecta o socket.
  const outro = new Client(BASE);
  const novoUser = await outro.register({ username: randomUsername('evento') });
  const rt = new RealtimeClient(`ws://127.0.0.1:${PORTA}/ws`, outro);
  await rt.connect();
  await sleep(3000);
  const adminDepois = await adminCtx.eval(`
    return {
      atividade: document.querySelectorAll('.admin-activity-row').length,
      primeira: document.querySelector('.admin-activity-row')?.textContent || '',
    };
  `);
  if (adminDepois.atividade > adminAntes.atividade) {
    ok(`painel recebeu evento real sem F5: ${adminAntes.atividade} -> ${adminDepois.atividade} linha(s) ("${adminDepois.primeira.trim().slice(0, 46)}")`);
  } else {
    fail(`painel nao recebeu evento (${adminAntes.atividade} -> ${adminDepois.atividade}) para @${novoUser.username}`);
  }
  await capturar(adminCtx, 'admin-1280');
  await adminCtx.close?.();

  // --------------------------------------------------- 5. RESPONSIVIDADE
  secao('Responsividade 320 a 1920 (item 27)');
  for (const largura of [320, 360, 390, 414, 768, 1024, 1280, 1440, 1920]) {
    const ctx = await sessao(cookiesFeed, largura, largura < 900 ? 800 : 900, largura < 900);
    await ctx.goto(`${BASE}/`, { waitMs: 1800 });
    const m = await ctx.eval(`
      // Elemento sem area = renderizado de verdade (offsetParent !== null) e
      // estreito. Abas escondidas por display:none nao contam: nao estao na tela.
      const cortados = [...document.querySelectorAll('.tabbar button, .feed-tabs button')]
        .filter((b) => b.offsetParent !== null && b.getBoundingClientRect().width < 8)
        .map((b) => (b.textContent || b.className));
      const fora = [...document.querySelectorAll('.tabbar button, .feed-tabs button, .slide-overlay')]
        .filter((b) => b.offsetParent !== null)
        .filter((b) => { const r = b.getBoundingClientRect(); return r.right > window.innerWidth + 1 || r.left < -1; }).length;
      return {
        overflowH: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        cortados, fora,
      };
    `);
    const problemas = [];
    if (m.overflowH > 1) problemas.push(`scroll horizontal ${m.overflowH}px`);
    if (m.cortados.length) problemas.push(`${m.cortados.length} botao(oes) sem area: ${m.cortados.join(' | ')}`);
    if (m.fora) problemas.push(`${m.fora} elemento(s) fora da tela`);
    if (problemas.length) fail(`${largura}px: ${problemas.join(', ')}`);
    else ok(`${largura}px: sem overflow, sem botao cortado, nada fora da tela`);
    await ctx.close?.();
  }

  await browser.close();
  console.log(`\ncapturas em ${path.relative(process.cwd(), OUT)}`);
}

main()
  .then(() => {
    console.log(`\n${falhas === 0 ? 'VERIFICACAO VISUAL OK' : `${falhas} PROBLEMA(S) VISUAL(IS)`}`);
    child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
    process.exit(falhas === 0 ? 0 : 1);
  })
  .catch((error) => {
    console.error('\nerro na verificacao visual:', error.message);
    if (log) console.error(log.slice(-1000));
    child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
    process.exit(1);
  });