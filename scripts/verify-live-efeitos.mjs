/**
 * Reproduz o roteiro do item 22 na LIVE e captura QUALQUER erro de console
 * com stack: abrir LIVE, host, espectador, efeito, trocar efeito, varios
 * efeitos, fechar/reabrir menu, reconectar, sair e entrar de novo.
 */
import { startServer, Client, Report, randomUsername, sleep } from '../tests/helpers.mjs';
import { launchChrome } from '../tests/cdp.mjs';

const report = new Report('LIVE: efeitos, realtime e erros');
const server = await startServer();

const hostCli = new Client(server.baseUrl);
const hostUser = await hostCli.register({ username: randomUsername('host') });
const viewCli = new Client(server.baseUrl);
const viewUser = await viewCli.register({ username: randomUsername('view') });

const browser = await launchChrome();

async function sessao(usuario, width = 390, height = 844) {
  const s = await browser.newBrowserContext();
  s.watch();
  await s.goto(`${server.baseUrl}/`, { waitMs: 300 });
  const r = await fetch(`${server.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: usuario.username, password: 'Senha@Teste123' }),
  });
  for (const ck of r.headers.getSetCookie()) {
    const pair = ck.split(';')[0];
    const n = pair.split('=')[0];
    const v = pair.slice(n.length + 1);
    await s.send('Network.setCookie', { name: n, value: decodeURIComponent(v), domain: '127.0.0.1', path: '/' });
  }
  await s.send('Network.setCacheDisabled', { cacheDisabled: true });
  await s.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 768 });
  return s;
}

/** Erros de console relevantes (ignora rede opcional). */
function erros(s) {
  return s.consoleErrors.filter((e) => !/favicon|ERR_ABORTED|ERR_ABORTED|net::ERR/i.test(e));
}

try {
  const host = await sessao(hostUser);
  const viewer = await sessao(viewUser);

  // ---- 1) host inicia LIVE -------------------------------------------
  await report.step('host inicia LIVE com MediaStream real', async () => {
    await host.goto(`${server.baseUrl}/iniciar-live`, { waitMs: 2000 });
    await host.eval(`
      const b = [...document.querySelectorAll('#main button')].find((x) => /Iniciar transmissao/i.test(x.innerText));
      b.click();
      return true;
    `);
    const st = await host.waitForFunction(`
      const v = document.querySelector('#main video');
      if (!v || !v.videoWidth) return null;
      return { w: v.videoWidth, temSala: Boolean(document.querySelector('.live-host, .live-stage, #main')) };
    `, 25000).catch((e) => ({ erro: e.message }));
    if (st.erro) throw new Error(`sem preview: ${st.erro}`);
    await sleep(2500);
    const lista = await hostCli.get('/api/live/discover');
    const sala = (lista.body.live || [])[0];
    if (!sala) throw new Error('sala nao criada');
    return `preview ${st.w}px, sala ${sala.id}`;
  });

  const sala = (await hostCli.get('/api/live/discover')).body.live[0];

  // ---- 2) espectador entra --------------------------------------------
  await report.step('espectador entra e recebe video pelo WebRTC', async () => {
    await viewer.goto(`${server.baseUrl}/live/${sala.id}`, { waitMs: 3000 });
    await viewer.eval(`
      const b = [...document.querySelectorAll('button')].find((x) => /^(Entrar|Assistir)/i.test((x.innerText || '').trim()));
      if (b) b.click();
      return true;
    `);
    await sleep(1500);
    await viewer.eval(`
      const b = [...document.querySelectorAll('button')].find((x) => /^(Entrar|Assistir)/i.test((x.innerText || '').trim()));
      if (b) b.click();
      return true;
    `);
    const st = await viewer.waitForFunction(`
      const v = document.querySelector('video');
      if (!v || !v.videoWidth) return null;
      return { w: v.videoWidth, bytes: v.getAttribute('data-bytes') || null };
    `, 40000).catch((e) => ({ erro: e.message }));
    if (st.erro) throw new Error(`espectador sem video: ${st.erro}`);
    return `espectador recebendo ${st.w}px`;
  });

  // ---- 3) menu de efeitos: miniaturas ---------------------------------
  await report.step('menu de efeitos: cards com preview real e nome', async () => {
    await host.eval(`
      const b = [...document.querySelectorAll('button')].find((x) => /Efeitos/i.test(x.getAttribute('aria-label') || ''));
      b.click();
      return true;
    `);
    await sleep(2500);
    const st = await host.eval(`
      const modal = document.querySelector('.modal-root');
      const cells = [...modal.querySelectorAll('.effect-card')];
      const imgs = [...modal.querySelectorAll('.effect-card-media img, .effect-card-media video')];
      return {
        modal: Boolean(modal),
        cells: cells.length,
        imgs: imgs.length,
        quebradas: imgs.filter((m) => m.complete && m.naturalWidth === 0 || (m.readyState === 0 && m.error)).length,
        carregadas: imgs.filter((m) => (m.tagName === 'IMG' && m.naturalWidth > 0) || (m.tagName === 'VIDEO' && m.readyState >= 2)).length,
        nomes: cells.slice(0, 4).map((c) => c.title || c.getAttribute('aria-label') || c.textContent.trim().slice(0, 20)),
        temNomeVisivel: cells.slice(0, 4).map((c) => {
          const n = c.querySelector('.picker-name, span');
          return n ? n.textContent.trim() : null;
        }),
        cellBox: cells[0] ? { w: Math.round(cells[0].getBoundingClientRect().width), h: Math.round(cells[0].getBoundingClientRect().height) } : null,
        texto: modal.innerText.slice(0, 160),
      };
    `);
    if (!st.modal) throw new Error('menu de efeitos nao abriu');
    if (!st.cells) throw new Error('menu sem cards');
    if (st.imgs && st.quebradas) throw new Error(`${st.quebradas} imagem(ns) de efeito quebrada(s)`);
    return `${st.cells} cards, ${st.carregadas}/${st.imgs} previews carregados, nomes ${JSON.stringify(st.nomes)}, caixa ${JSON.stringify(st.cellBox)}`;
  });

  // ---- 4) dispara efeito ----------------------------------------------
  await report.step('host dispara efeito e o espectador ve a animacao', async () => {
    await host.eval(`
      const modal = document.querySelector('.modal-root');
      const cell = modal.querySelector('.effect-card');
      cell.click();
      return true;
    `);
    await sleep(1200);
    const noHost = await host.eval("return document.querySelectorAll('.live-effects .effect-instance, #live-effects > *').length;");
    await sleep(1500);
    const noViewer = await viewer.eval("return document.querySelectorAll('.live-effects .effect-instance, #live-effects > *').length;");
    if (noHost < 1) throw new Error('anfitriao sem instancia de efeito');
    if (noViewer < 1) throw new Error('espectador sem instancia de efeito');
    return `anfitriao=${noHost} instancia(s), espectador=${noViewer}`;
  });

  // ---- 5) troca de efeito + varios + fechar/reabrir ------------------
  await report.step('troca de efeito, dispara varios e reabre o menu sem erro', async () => {
    for (let i = 0; i < 3; i += 1) {
      await host.eval(`
        const b = [...document.querySelectorAll('button')].find((x) => /Efeitos/i.test(x.getAttribute('aria-label') || ''));
        b.click();
        return true;
      `);
      await sleep(700);
      await host.eval(`
        const cells = [...document.querySelectorAll('.modal-root .effect-card')];
        cells[${i} % Math.max(1, cells.length)].click();
        return true;
      `);
      await sleep(700);
    }
    // Fecha o modal pelo "Fechar" do proprio dialogo e reabre.
    await host.eval(`
      const modal = document.querySelector('.modal');
      const fechar = [...(modal?.querySelectorAll('button') || [])]
        .find((b) => /Fechar/i.test(b.getAttribute('aria-label') || ''));
      if (fechar) fechar.click();
      return true;
    `);
    await sleep(500);
    await host.eval(`
      const b = [...document.querySelectorAll('button')].find((x) => /Efeitos/i.test(x.getAttribute('aria-label') || ''));
      b.click();
      return true;
    `);
    await sleep(1200);
    const e1 = erros(host);
    const e2 = erros(viewer);
    if (e1.length) throw new Error(`host: ${e1.slice(0, 2).join(' | ')}`);
    if (e2.length) throw new Error(`espectador: ${e2.slice(0, 2).join(' | ')}`);
    return '3 trocas + fechar/reabrir sem erro de console';
  });

  // ---- 6) reconexao do espectador ------------------------------------
  await report.step('espectador sai e volta: efeito NAO reaparece (late joiner)', async () => {
    await viewer.send('Network.setCacheDisabled', { cacheDisabled: true });
    await viewer.goto(`${server.baseUrl}/live/${sala.id}`, { waitMs: 3000 });
    await viewer.eval(`
      const b = [...document.querySelectorAll('button')].find((x) => /^(Entrar|Assistir)/i.test((x.innerText || '').trim()));
      if (b) b.click();
      return true;
    `);
    await sleep(2000);
    const inst = await viewer.eval("return document.querySelectorAll('.live-effects .effect-instance, #live-effects > *').length;");
    if (inst > 0) throw new Error(`late joiner recebeu ${inst} efeito(s) antigo(s)`);
    const e = erros(viewer);
    if (e.length) throw new Error(`apos reconectar: ${e.slice(0, 2).join(' | ')}`);
    return `0 efeitos reproduzidos na reconexao, ${e.length} erro(s)`;
  });

  // ---- 7) encerrar ----------------------------------------------------
  await report.step('encerrar a LIVE nao deixa erro nem efeito pendente', async () => {
    // O passo anterior termina com o menu de efeitos ABERTO (ele confere que
    // reabrir nao quebra). Entao primeiro fecha: com o painel em cima, o
    // `querySelector('.modal')` devolvia o painel de efeitos em vez do dialogo
    // de confirmacao, e o "Encerrar" nunca era confirmado - falha do teste,
    // nao do produto.
    await host.eval(`
      for (const b of document.querySelectorAll('.modal .icon-btn[aria-label*="Fechar"], .modal [aria-label="Fechar"]')) {
        b.click();
        return true;
      }
      return false;
    `);
    await sleep(900);
    const sobrou = await host.eval("return document.querySelectorAll('.modal').length;");
    if (sobrou > 0) throw new Error(`o menu de efeitos ficou aberto (${sobrou} modal(is)) e nao ha como encerrar por tras dele`);

    // (Item 11) "Encerrar/Sair" mora dentro do menu de configuracoes no TOPO
    // da tela - o botao saiu da barra inferior. O caminho real e abrir o menu
    // e escolher a opcao; procurar um botao solto na tela nao acha nada.
    const abriuMenu = await host.eval(`
      const b = document.querySelector('.live-settings-btn')
        || [...document.querySelectorAll('button')].find((x) => /configuracoes/i.test(x.getAttribute('aria-label') || ''));
      if (!b) return false;
      b.click();
      return true;
    `);
    if (!abriuMenu) throw new Error('nenhum botao de configuracoes da transmissao no topo');
    await sleep(900);
    const clicou = await host.eval(`
      const d = [...document.querySelectorAll('.modal')]
        .find((m) => /Configuracoes da LIVE/i.test(m.querySelector('h2')?.textContent || ''));
      const item = d && [...d.querySelectorAll('.live-config-item')]
        .find((x) => /Encerrar|Sair/i.test(x.textContent || ''));
      if (!item) return 'sem item de encerrar: ' + [...(d?.querySelectorAll('.live-config-item') || [])].map((x) => x.textContent.trim()).join(' | ');
      item.click();
      return 'clicou';
    `);
    if (clicou !== 'clicou') throw new Error(clicou);
    await sleep(1400);
    // Confirma apenas o dialogo cujo titulo fala em encerrar.
    await host.eval(`
      const dialogo = [...document.querySelectorAll('.modal')]
        .find((m) => /Encerrar|Sair/i.test(m.querySelector('h2')?.textContent || ''));
      if (!dialogo) return false;
      const c = [...dialogo.querySelectorAll('button')]
        .find((x) => /Encerrar|Confirmar|Sim/i.test(x.innerText || ''));
      if (!c) return false;
      c.click();
      return true;
    `);
    // A LIVE precisa ter sido encerrada de verdade no backend.
    let fim = false;
    for (let i = 0; i < 30 && !fim; i += 1) {
      fim = (await hostCli.get(`/api/live/${sala.id}`).catch(() => null))?.body?.room?.status === 'ended';
      if (!fim) await sleep(500);
    }
    if (!fim) {
      const diag = await host.eval(`
        return {
          url: location.pathname,
          modal: Boolean(document.querySelector('.modal')),
          titulo: document.querySelector('.modal h2')?.textContent || null,
          acoes: [...(document.querySelector('.modal')?.querySelectorAll('button') || [])]
            .map((b) => (b.innerText || b.getAttribute('aria-label') || '').trim()),
        };
      `);
      throw new Error(`a LIVE nao mudou de status para encerrada; tela=${JSON.stringify(diag)}`);
    }
    await sleep(2500);
    const e1 = erros(host);
    const e2 = erros(viewer);
    const res = await host.eval(`
      const inst = [...document.querySelectorAll('.live-effects .effect-instance, #live-effects > *')];
      return {
        n: inst.length,
        urls: [...new Set(inst.map((n) => n.querySelector('img,video')?.src?.split('key=')[1] || n.tagName))].slice(0, 3),
        visiveis: inst.filter((n) => getComputedStyle(n).opacity !== '0' && getComputedStyle(n).display !== 'none').length,
        url: location.pathname,
      };
    `);
    if (e1.length) throw new Error(`host: ${e1.slice(0, 2).join(' | ')}`);
    if (e2.length) throw new Error(`espectador: ${e2.slice(0, 2).join(' | ')}`);
    if (res.visiveis > 0) throw new Error(`${res.visiveis} efeito(s) ainda visivel(is) apos encerrar`);
    return `encerrada, ${res.n} no DOM (${res.visiveis} visiveis), tela ${res.url}, sem erro`;
  });

  // ---- 8) abrir o menu SEM sala (null.id) ----------------------------
  await report.step('sem LIVE ativa: abrir e fechar menus nao gera null.id', async () => {
    await host.goto(`${server.baseUrl}/`, { waitMs: 2500 });
    await host.goto(`${server.baseUrl}/ao-vivo`, { waitMs: 2000 });
    const e = erros(host);
    if (e.some((x) => /null/.test(x) && /\.id/.test(x))) {
      throw new Error(`null.id: ${e.find((x) => /null/.test(x))}`);
    }
    return `${e.length} erro(s) de console`;
  });
} catch (err) {
  report.fail('erro inesperado', err);
}

const resumo = report.summary();
await browser.close();
await server.stop();
process.exit(resumo.failed > 0 ? 1 : 0);