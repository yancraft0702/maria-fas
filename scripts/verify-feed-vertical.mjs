/**
 * Feed vertical: MESMO mecanismo nas 3 abas, conteudo real de varias contas,
 * ordem cronologica e ciclo completo de navegacao (item 1, 2, 3, 4, 5, 6).
 *
 * exercised:
 *  A) 3 usuarios publicam em horarios diferentes -> ordem C, B, A
 *  B) swipe (mobile) e wheel/teclado (desktop) com ida e volta
 *  C) so o video ativo reproduz; voltar reproduz; avancar reproduz
 *  D) as 3 abas navegam igual
 *  E) a Home mobile nao tem espaco vazio no topo e o video nao fica sob a barra
 */
import { startServer, Client, Report, randomUsername, sleep, makeTestVideo } from '../tests/helpers.mjs';
import { launchChrome } from '../tests/cdp.mjs';

const report = new Report('Feed vertical: conteudo, ordem e navegacao');
const server = await startServer();

// ---------------------------------------------------------------- conteudo
const video = await makeTestVideo({ seconds: 3, width: 480, height: 854, withAudio: true });
const esperaPronta = async (cli, mediaId) => {
  for (let i = 0; i < 150; i += 1) {
    const r = await cli.get(`/api/media/${mediaId}/status`);
    if (r.body.media?.status === 'ready') return r.body.media;
    if (r.body.media?.status === 'failed') throw new Error(`midia ${mediaId} falhou: ${r.body.media.error}`);
    await sleep(800);
  }
  throw new Error(`midia ${mediaId} nao ficou pronta`);
};

const publicados = [];
const autores = [];
for (let i = 0; i < 3; i += 1) {
  const cli = new Client(server.baseUrl);
  const user = await cli.register({ username: randomUsername(`aut${i}`) });
  const up = await cli.upload('/api/media/upload?purpose=video', video.buffer, { filename: `a${i}.mp4`, mime: video.mime });
  await esperaPronta(cli, up.body.media.id);
  const post = await cli.post('/api/posts', { type: 'video', mediaId: up.body.media.id, caption: `autor ${i}` });
  publicados.push({ id: post.body.post.id, autor: user.username });
  autores.push({ cli, user });
  await sleep(1300); // espacos distintos: a ordem cronologica fica inequivoca
}

const leitor = new Client(server.baseUrl);
const userLeitor = await leitor.register({ username: randomUsername('leitor') });

// Amizade/follow MUTUOS de verdade, para "Seguindo" e "Amigos" terem conteudo
// real (o backend so cria a amizade quando os dois lados aceitam).
const idLeitor = userLeitor.id;
await leitor.post(`/api/users/${autores[1].user.id}/follow`, {});
await autores[1].cli.post(`/api/users/${idLeitor}/follow`, {});
await leitor.post(`/api/users/${autores[0].user.id}/follow`, {});
const relacao = await leitor.get(`/api/users/${autores[1].user.id}/relation`);
const amizade = await leitor.get(`/api/users/${idLeitor}/friends`);

const browser = await launchChrome();

async function sessao(width, height, mobile) {
  const s = await browser.newBrowserContext();
  s.watch();
  await s.goto(`${server.baseUrl}/`, { waitMs: 300 });
  const r = await fetch(`${server.baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: userLeitor.username, password: 'Senha@Teste123' }),
  });
  for (const ck of r.headers.getSetCookie()) {
    const pair = ck.split(';')[0];
    const n = pair.split('=')[0];
    await s.send('Network.setCookie', { name: n, value: decodeURIComponent(pair.slice(n.length + 1)), domain: '127.0.0.1', path: '/' });
  }
  await s.send('Network.setCacheDisabled', { cacheDisabled: true });
  await s.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
  await s.goto(`${server.baseUrl}/`, { waitMs: 3200 });
  return s;
}

/** Estado do player: indice ativo, quem reproduz, ids visiveis. */
const estado = (s) => s.eval(`
  const slides = [...document.querySelectorAll('.slide')];
  const ativos = slides.filter((x) => x.classList.contains('active'));
  const videos = [...document.querySelectorAll('.slide-media video')];
  // Com ROLAGEM REAL, durante o gesto duas paginas ficam PARCIALMENTE
  // visiveis - e o movimento aparecendo, nao defeito. O que nao podewk
  // acontecer e duas paginas "na tela" (ocupando o palco inteiro) ou dois
  // videos reproduzindo.
  const stageEl = document.querySelector('.feed-stage');
  const limites = stageEl ? stageEl.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
  const visiveis = slides.filter((x) => {
    const r = x.getBoundingClientRect();
    return r.height > 40 && r.top < limites.bottom && r.bottom > limites.top;
  });
  // Pagina "em tela": cobre praticamente todo o palco.
  const cheias = stageEl
    ? slides.filter((x) => {
      const r = x.getBoundingClientRect();
      const s = stageEl.getBoundingClientRect();
      return r.height > 40 && r.top <= s.top + 8 && r.bottom >= s.bottom - 8;
    })
    : [];
  const stage = document.querySelector('.feed-stage');
  const alturaPagina = stage ? stage.clientHeight : 0;
  // Indice real = posicao da rolagem arredondada para a pagina mais proxima.
  // E o que o usuario ve, independente da classe .active.
  const pelaRolagem = alturaPagina ? Math.round(stage.scrollTop / alturaPagina) : 0;
  return {
    total: slides.length,
    ativo: slides.indexOf(ativos[0] ?? slides[0]),
    ativoRolagem: pelaRolagem,
    scrollTop: stage ? Math.round(stage.scrollTop) : 0,
    alturaPagina,
    ativos: ativos.length,
    visiveis: visiveis.length,
    cheias: cheias.length,
    tocando: videos.filter((v) => !v.paused && v.readyState >= 2).length,
    pausados: videos.filter((v) => v.paused).length,
    ids: slides.map((x) => x.dataset.postId || ''),
    ativoId: (ativos[0] || {}).dataset?.postId || '',
  };
`);

try {
  // ---- A) conteudo real + ordem cronologica (itens 1 e 5) --------------
  await report.step('Para voce: videos de VARIOS autores, mais recente primeiro', async () => {
    const st = await estado((await sessao(1440, 900, false)));
    const esperado = [publicados[2].id, publicados[1].id, publicados[0].id];
    const faltando = esperado.filter((id) => !st.ids.includes(id));
    if (faltando.length) throw new Error(`${faltando.length} publicacao(oes) real(is) ausente(s) do feed`);
    const ordem = st.ids.filter((id) => esperado.includes(id));
    const posicoes = esperado.map((id) => ordem.indexOf(id));
    if (!posicoes.every((v, i) => i === 0 || posicoes[i - 1] < v)) {
      throw new Error(`ordem cronologica errada: ${ordem.map((id) => id.slice(-4)).join(' > ')}`);
    }
    const autores = [...new Set(esperado.map((id) => publicados.find((p) => p.id === id).autor))];
    if (autores.length < 3) throw new Error(`feed mostra ${autores.length} autor(es), esperado 3`);
    return `ordem ${ordem.map((id) => id.slice(-4)).join(' > ')} (C > B > A), autores: ${autores.join(', ')}`;
  });

  // ---- B/C) teclado no desktop (itens 3 e 6) ---------------------------
  const desk = await sessao(1440, 900, false);
  await report.step('desktop: ArrowDown/ArrowUp percorrem 1 -> 2 -> 3 -> 2 -> 1 com reproducao', async () => {
    const inicio = await estado(desk);
    if (inicio.total < 3) throw new Error(`poucos slides: ${inicio.total}`);
    const teclas = ['ArrowDown', 'ArrowDown', 'ArrowUp', 'ArrowUp'];
    const passos = [];
    for (const key of teclas) {
      await desk.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: key === 'ArrowDown' ? 40 : 38 });
      await desk.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: key === 'ArrowDown' ? 40 : 38 });
      await sleep(900);
      const st = await estado(desk);
      passos.push(st.ativo);
      if (st.ativos !== 1) throw new Error(`${st.ativos} slides ativos ao mesmo tempo (deveria ser 1)`);
      if (st.tocando !== 1) throw new Error(`${st.tocando} video(s) reproduzindo (deveria ser 1) apos ${key}`);
    }
    if (JSON.stringify(passos) !== JSON.stringify([1, 2, 1, 0])) {
      throw new Error(`sequencia de teclas ${passos.join(' -> ')} (esperado 1 -> 2 -> 1 -> 0)`);
    }
    const fim = await estado(desk);
    if (fim.ativoId !== inicio.ativoId) throw new Error('voltou para um video diferente do inicial');
    return `indice ${passos.join(' -> ')}, sempre 1 video tocando, voltou ao inicial`;
  });

  await report.step('desktop: roda do mouse avanca e volta UM video por gesto', async () => {
    const antes = await estado(desk);
    const box = await desk.eval(`
      const r = document.querySelector('.feed-stage').getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    `);
    await desk.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, buttons: 0 });

    // (a) Rajada PEQUENA: rola um pouco e ASSENTA na mesma pagina. Nao e um
    // "gesto" de verdade, entao nao pode trocar de publicacao - nem travar.
    for (let i = 0; i < 3; i += 1) {
      await desk.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: box.x, y: box.y, deltaX: 0, deltaY: 20 });
      await sleep(60);
    }
    await sleep(1100);
    const parcial = await estado(desk);
    if (parcial.scrollTop > antes.alturaPagina * 0.5) {
      throw new Error(`rajada pequena de roda pulou de pagina (${antes.scrollTop} -> ${parcial.scrollTop})`);
    }

    // (b) Gesto REAL: avanca uma publicacao e assenta nela.
    await desk.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: box.x, y: box.y, deltaX: 0, deltaY: 420 });
    await sleep(1100);
    const depois = await estado(desk);
    if (depois.ativoRolagem !== antes.ativoRolagem + 1) {
      throw new Error(`gesto de roda avancou ${depois.ativoRolagem - antes.ativoRolagem} pagina(s) (esperado 1); `
        + `scrollTop ${antes.scrollTop} -> ${depois.scrollTop}, pagina ${antes.alturaPagina}px`);
    }
    const resto = depois.scrollTop % depois.alturaPagina;
    if (resto > 6 || resto < -6) {
      throw new Error(`rolagem parou no meio da pagina: scrollTop=${depois.scrollTop}, resto=${resto}`);
    }

    // (c) Roda para cima volta.
    await desk.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: box.x, y: box.y, deltaX: 0, deltaY: -420 });
    await sleep(1100);
    const voltou = await estado(desk);
    if (voltou.ativoRolagem !== antes.ativoRolagem) {
      throw new Error(`roda para cima nao voltou (${voltou.scrollTop}, esperado ~${antes.scrollTop})`);
    }
    return `rajada pequena=${parcial.scrollTop}px (mesma pagina); gesto=${depois.scrollTop}px (`
      + `${depois.ativoRolagem} paginas, assentada); volta=${voltou.scrollTop}px`;
  });

  await report.step('desktop: a pagina do feed nao rola (video nao fica preso)', async () => {
    const st = await desk.eval(`
      const de = document.documentElement;
      return {
        scrollH: de.scrollHeight,
        vh: window.innerHeight,
        bodyOverflow: getComputedStyle(document.body).overflowY,
        mainOverflow: getComputedStyle(document.getElementById('main')).overflowY,
        stage: (() => { const s = document.querySelector('.feed-stage'); return { h: Math.round(s.getBoundingClientRect().height), scroll: s.scrollHeight - s.clientHeight }; })(),
      };
    `);
    if (st.scrollH > st.vh + 1) fail(`page rola: ${st.scrollH} > ${st.vh}`);
    return `scrollH=${st.scrollH} vh=${st.vh}, stage ${st.stage.h}px sem overflow interno`;
  });

  // ---- B/C) swipe no mobile (itens 2 e 6) ------------------------------
  const cel = await sessao(390, 844, true);
  await report.step('mobile: swipe sobe/desce e o video volta a reproduzir', async () => {
    const antes = await estado(cel);
    const arrastar = async (deY, paraY) => {
      await cel.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 195, y: deY }] });
      await sleep(50);
      await cel.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 195, y: paraY }] });
      await sleep(50);
      await cel.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await sleep(950);
    };
    await arrastar(700, 250);
    const cima = await estado(cel);
    if (cima.ativo !== antes.ativo + 1) throw new Error(`swipe para cima nao avancou (${antes.ativo} -> ${cima.ativo})`);
    if (cima.tocando !== 1) throw new Error(`${cima.tocando} video(s) reproduzindo apos avancar`);
    await arrastar(250, 700);
    const baixo = await estado(cel);
    if (baixo.ativo !== antes.ativo) throw new Error(`swipe para baixo nao voltou (${baixo.ativo})`);
    if (baixo.tocando !== 1) throw new Error(`${baixo.tocando} video(s) reproduzindo apos VOLTAR`);
    if (baixo.ativoId !== antes.ativoId) throw new Error('voltou para um video diferente');
    // Invariante real: UMA publicacao em tela e UM video reproduzindo.
    if (baixo.cheias !== 1) throw new Error(`${baixo.cheias} publicacoes em tela ao mesmo tempo (esperado 1)`);
    return `${antes.ativo} -> ${cima.ativo} -> ${baixo.ativo}; sempre 1 reproduzindo, 1 em tela`
      + ` (parcialmente visiveis durante o gesto: ${baixo.visiveis})`;
  });

  // ---- D) as 3 abas com o mesmo mecanismo (item 4) ---------------------
  await report.step('as 3 abas usam o mesmo player: navegar em cada uma', async () => {
    const relatorio = [];
    for (const nome of ['Para voce', 'Seguindo', 'Amigos']) {
      await cel.eval(`
        const aba = [...document.querySelectorAll('.feed-tabs [role="tab"]')].find((t) => new RegExp(${JSON.stringify(nome)}, 'i').test(t.textContent));
        if (aba) aba.click();
        return true;
      `);
      await sleep(2200);
      const st = await estado(cel);
      const antes = st.ativo;
      // Navega pela MESMA logica (tecla) em qualquer aba.
      await cel.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
      await cel.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
      await sleep(900);
      const depois = await estado(cel);
      const vazio = await cel.eval(`
        const e = document.querySelector('.page-empty');
        return e ? e.innerText.replace(/\\s+/g, ' ').slice(0, 50) : null;
      `);
      if (st.total === 0 && !vazio) throw new Error(`aba ${nome} sem posts e sem estado vazio`);
      if (nome !== 'Para voce' && st.total === 0) {
        throw new Error(`aba ${nome} vazia apesar do follow/amizade reais (relacao=${JSON.stringify(relacao.body).slice(0, 60)})`);
      }
      if (st.total > 1 && depois.ativo !== antes + 1) {
        throw new Error(`aba ${nome}: navegacao nao avancou (${antes} -> ${depois.ativo})`);
      }
      if (st.total > 1 && depois.tocando !== 1) throw new Error(`aba ${nome}: ${depois.tocando} reproduzindo`);
      relatorio.push(`${nome}: ${st.total} slides${vazio ? ' (vazio explicito)' : ''}${st.total > 1 ? ` ${antes}->${depois.ativo}` : ''}`);
    }
    return relatorio.join(' | ');
  });

  // ---- E) Home mobile sem espaco vazio e sem video sob a barra (item 7) --
  await report.step('mobile: sem espaco vazio no topo e video NAO fica sob a bottom nav', async () => {
    const medidas = [];
    for (const [w, h] of [[320, 640], [360, 780], [390, 844], [414, 896]]) {
      await cel.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: true });
      await cel.goto(`${server.baseUrl}/`, { waitMs: 2600 });
      // eslint-disable-next-line no-await-in-loop
      const st = await cel.eval(`
        const tabs = document.querySelector('.feed-tabs');
        const stage = document.querySelector('.feed-stage');
        const topbar = document.querySelector('.topbar');
        const tabbar = document.querySelector('#tabbar');
        const tb = topbar.getBoundingClientRect();
        const t = tabs.getBoundingClientRect();
        const s = stage.getBoundingClientRect();
        const nb = tabbar.getBoundingClientRect();
        const de = document.documentElement;
        return {
          vh: window.innerHeight,
          fimTopbar: Math.round(tb.bottom),
          topoAbas: Math.round(t.top),
          alturaAbas: Math.round(t.height),
          topoStage: Math.round(s.top),
          baseStage: Math.round(s.bottom),
          topoBarra: Math.round(nb.top),
          scrollH: de.scrollHeight,
          scrollW: de.scrollWidth,
          clientW: de.clientWidth,
        };
      `);
      const vao = st.topoAbas - st.fimTopbar;
      if (vao > 4) throw new Error(`${w}px: ${vao}px de vao entre o topo e as abas`);
      if (st.baseStage > st.topoBarra + 1) throw new Error(`${w}px: video invade a bottom nav em ${st.baseStage - st.topoBarra}px`);
      if (st.scrollH > st.vh + 1) throw new Error(`${w}px: pagina rola verticalmente (${st.scrollH} > ${st.vh})`);
      if (st.scrollW > st.clientW + 1) throw new Error(`${w}px: scroll horizontal`);
      medidas.push(`${w}: abas@${st.topoAbas}(+${st.alturaAbas}) stage ${st.topoStage}-${st.baseStage} barra@${st.topoBarra}`);
    }
    return medidas.join(' | ');
  });

  // ---- G) desktop em varias larguras (item 12) -------------------------
  await report.step('desktop 1024/1280/1440/1920: player ocupa a area, sem scroll', async () => {
    const medidas = [];
    for (const w of [1024, 1280, 1440, 1920]) {
      await desk.send('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: 1, mobile: false });
      await desk.goto(`${server.baseUrl}/`, { waitMs: 2400 });
      // eslint-disable-next-line no-await-in-loop
      const st = await desk.eval(`
        const stage = document.querySelector('.feed-stage');
        const s = stage.getBoundingClientRect();
        const de = document.documentElement;
        const videos = [...document.querySelectorAll('.slide-media video')];
        return {
          stageH: Math.round(s.height),
          stageW: Math.round(s.width),
          scrollH: de.scrollHeight,
          vh: window.innerHeight,
          scrollW: de.scrollWidth,
          clientW: de.clientWidth,
          tocando: videos.filter((v) => !v.paused && v.readyState >= 2).length,
          videoBox: videos[0] ? { w: Math.round(videos[0].getBoundingClientRect().width), h: Math.round(videos[0].getBoundingClientRect().height) } : null,
        };
      `);
      if (st.scrollH > st.vh + 1) throw new Error(`${w}px: pagina rola (${st.scrollH} > ${st.vh})`);
      if (st.scrollW > st.clientW + 1) throw new Error(`${w}px: scroll horizontal`);
      if (st.tocando !== 1) throw new Error(`${w}px: ${st.tocando} videos reproduzindo`);
      if (!st.videoBox || st.videoBox.h < 200) throw new Error(`${w}px: video pequeno (${JSON.stringify(st.videoBox)})`);
      medidas.push(`${w}: stage ${st.stageW}x${st.stageH}, video ${st.videoBox.w}x${st.videoBox.h}`);
    }
    return medidas.join(' | ');
  });
} catch (err) {
  report.fail('erro inesperado', err);
}

const resumo = report.summary();
await browser.close();
await server.stop();
process.exit(resumo.failed > 0 ? 1 : 0);
