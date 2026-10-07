/**
 * GIPHY e stickers reais (itens 17, 18, 29, 31).
 *
 * Abre o seletor no chat, busca, trending, stickers, clica, envia e
 * confere a renderizacao no destino. Mede os cards, as imagens e o
 * fallback; nenhuma imagem quebrada e nenhum texto no lugar da imagem.
 */
import { startServer, Client, Report, randomUsername, sleep } from '../tests/helpers.mjs';
import { launchChrome } from '../tests/cdp.mjs';

const report = new Report('GIPHY e stickers: interface real');
const server = await startServer();
const status = await fetch(`${server.baseUrl}/api/giphy/status`);
const statusBody = await status.json();
if (!statusBody.configured) {
  report.fail('GIPHY sem chave', new Error('a chave nao esta no servidor (/.env)'));
}

const cli = new Client(server.baseUrl);
const user = await cli.register({ username: randomUsername('gif') });

const browser = await launchChrome();

async function sessao(width, height, mobile) {
  const s = await browser.newBrowserContext();
  s.watch();
  await s.goto(`${server.baseUrl}/`, { waitMs: 300 });
  const r = await fetch(`${server.baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: user.username, password: 'Senha@Teste123' }),
  });
  for (const ck of r.headers.getSetCookie()) {
    const pair = ck.split(';')[0];
    const n = pair.split('=')[0];
    await s.send('Network.setCookie', { name: n, value: decodeURIComponent(pair.slice(n.length + 1)), domain: '127.0.0.1', path: '/' });
  }
  await s.send('Network.setCacheDisabled', { cacheDisabled: true });
  await s.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
  return s;
}

/**
 * Abre o seletor e devolve a grade ja carregada. Idempotente: o botao e um
 * alternador, entao so e clicado quando o painel ainda nao esta aberto.
 */
const abrirSeletor = (s, aba = 'GIFs') => s.eval(`
  const alvo = ${JSON.stringify(aba)};
  let painel = document.querySelector('.picker-panel');
  if (!painel) {
    const botao = [...document.querySelectorAll('.composer button')]
      .find((x) => /GIF/i.test(x.getAttribute('aria-label') || ''));
    if (!botao) return { erro: 'sem botao de GIF no composer' };
    botao.click();
    await new Promise((x) => setTimeout(x, 1200));
    painel = document.querySelector('.picker-panel');
  }
  if (!painel) return { erro: 'painel nao abriu' };
  const abaSticker = [...(painel.querySelectorAll('.picker-tabs button') || [])]
    .find((b) => /sticker/i.test(b.textContent || ''));
  if (alvo === 'Stickers' && abaSticker && abaSticker.getAttribute('aria-selected') !== 'true') {
    abaSticker.click();
  }
  await new Promise((x) => setTimeout(x, 4200));
  return { ok: true };
`);

/** Mede os cards da grade. */
const medirGrade = (s) => s.eval(`
  const painel = document.querySelector('.picker-panel');
  const grade = document.querySelector('.picker-grid');
  const celulas = [...(grade?.children || [])];
  const imgs = [...(grade?.querySelectorAll('img') || [])];
  const vw = document.documentElement.clientWidth;
  const pr = painel?.getBoundingClientRect();
  const caixas = celulas.map((c) => c.getBoundingClientRect());
  return {
    painel: Boolean(painel),
    painelBox: pr ? { w: Math.round(pr.width), h: Math.round(pr.height), top: Math.round(pr.top) } : null,
    celulas: celulas.length,
    colunas: grade ? getComputedStyle(grade).gridTemplateColumns.split(' ').length : 0,
    imgs: imgs.length,
    carregadas: imgs.filter((i) => i.naturalWidth > 0).length,
    quebradas: imgs.filter((i) => i.complete && i.naturalWidth === 0).length,
    https: imgs.filter((i) => (i.currentSrc || i.src || '').startsWith('https://')).length,
    foraDoPainel: caixas.filter((r) => pr && (r.right > pr.right + 1 || r.left < pr.left - 1)).length,
    foraDaTela: caixas.filter((r) => r.right > vw + 1 || r.left < -1).length,
    textoGigante: [...(grade?.children || [])]
      .filter((c) => {
        const t = (c.textContent || '').trim();
        return t.length > 40 && !c.querySelector('img');
      }).length,
    // Escape duplo na barra: dentro do template do Node o "\\\\/" e consumido
    // e a regex chegaria ao navegador quebrada.
    mostraUrl: (painel?.innerText || '').match(/https?:\\/\\//) ? true : false,
    mostraJson: (painel?.innerText || '').includes('"images"') || (painel?.innerText || '').includes('downsized'),
    kinds: [...(grade?.querySelectorAll('[data-kind]') || [])].map((c) => c.dataset.kind).slice(0, 3),
    // O aviso de indisponibilidade precisa ser VISIVEL, nunca uma grade muda.
    aviso: (painel?.querySelector('.picker-note:not([hidden])')?.textContent || '').trim(),
  };
`);

// Verdadeiro quando o GIPHY recusou a chamada (cota esgotada ou
  // indisponivel). Nesse caso os passos exigem AVISO visivel, nao imagens.
let giphyFora = false;

/**
 * Logs de console QUE O GIPHY CAUSA quando recusa a chamada. Sao esperados e
 * nao indicam defeito: o navegador avisa que a requisicao falhou e a interface
 * mostra o motivo na tela. Erro de JavaScript continua sendo falha.
 */
function errosEsperadosGiphy() {
  if (!giphyFora) return /$^/;
  return /status of 503|status of 429|giphy_rate_limited|Failed to load resource.*(503|429)/i;
}

try {
  for (const [largura, altura, mobile, nome, esperadoMinCol] of [[390, 844, true, 'mobile', 2], [1440, 900, false, 'desktop', 4]]) {
    const s = await sessao(largura, altura, mobile);
    await s.goto(`${server.baseUrl}/chat-global`, { waitMs: 3000 });

    // ---- Trending de GIFs -------------------------------------------
    await report.step(`${nome}:Trending de GIFs mostra imagens REAIS em cards`, async () => {
      const abriu = await abrirSeletor(s, 'GIFs');
      if (abriu.erro) throw new Error(abriu.erro);
      const st = await medirGrade(s);
      if (!st.painel) throw new Error('painel nao abriu');

      // O GIPHY e um servico externo com cota propria (429). Quando ele recusa,
      // a exigencia NAO e "ha imagens" e sim "a grade NAO pode ficar muda":
      // o usuario tem de ler o motivo. Isso tambem impede que um teste verde
      // esconda um servico fora do ar.
      if (st.celulas < 6) {
        if (!st.aviso) {
          throw new Error(`a grade ficou VAZIA sem aviso: ${st.celulas} celulas e nenhum .picker-note`);
        }
        report.ok(`${nome}: GIPHY indisponivel (cota/limite) e a interface AVISOU: "${st.aviso}"`);
        giphyFora = true;
        return;
      }
      giphyFora = false;
      if (st.imgs < 6) throw new Error(`poucas imagens: ${st.imgs}`);
      if (st.carregadas < 6) throw new Error(`apenas ${st.carregadas}/${st.imgs} imagens carregaram`);
      if (st.quebradas > 0) throw new Error(`${st.quebradas} imagem(ns) quebrada(s)`);
      if (st.https !== st.imgs) throw new Error(`${st.imgs - st.https} imagem(ns) fora de HTTPS`);
      if (st.colunas < esperadoMinCol) throw new Error(`grade com ${st.colunas} coluna(s) em ${nome}`);
      if (st.foraDoPainel > 0) throw new Error(`${st.foraDoPainel} card(s) fora do painel`);
      if (st.foraDaTela > 0) throw new Error(`${st.foraDaTela} card(s) fora da tela`);
      if (st.textoGigante > 0) throw new Error(`${st.textoGigante} card(s) mostrando texto no lugar da imagem`);
      if (st.mostraUrl) throw new Error('URL visivel na interface');
      if (st.mostraJson) throw new Error('JSON visivel na interface');
      return `${st.celulas} cards, ${st.colunas} colunas, ${st.carregadas}/${st.imgs} imagens HTTPS, painel ${st.painelBox.w}x${st.painelBox.h}`;
    });

    // ---- Busca real --------------------------------------------------
    await report.step(`${nome}: busca por termo traz resultados reais`, async () => {
      await s.eval(`
        const campo = document.querySelector('.picker-search input, .picker-panel input');
        if (!campo) return 'sem campo de busca';
        campo.value = 'gato';
        campo.dispatchEvent(new Event('input', { bubbles: true }));
        return 'ok';
      `);
      await sleep(1200);
      await s.eval(`
        const campo = document.querySelector('.picker-search input, .picker-panel input');
        campo.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        return true;
      `);
      await sleep(4500);
      const st = await medirGrade(s);
      if (giphyFora && !st.aviso) {
        throw new Error(`${motivo} E a grade ficou vazia sem nenhum aviso visivel`);
      }
      if (giphyFora) return `GIPHY indisponivel e a interface avisou: "${st.aviso}"`;
      if (st.celulas < 4) throw new Error(`busca devolveu ${st.celulas} resultado(s)`);
      if (st.carregadas < 4) throw new Error(`busca: ${st.carregadas}/${st.imgs} imagens carregaram`);
      if (st.quebradas > 0) throw new Error(`busca: ${st.quebradas} imagem(ns) quebrada(s)`);
      return `${st.celulas} resultados, ${st.carregadas} imagens carregadas`;
    });

    // ---- Stickers -----------------------------------------------------
    await report.step(`${nome}: stickers aparecem como imagem, nunca "kind: sticker"`, async () => {
      const abriu = await abrirSeletor(s, 'Stickers');
      if (abriu.erro) throw new Error(abriu.erro);
      const st = await medirGrade(s);
      if (giphyFora && !st.aviso) {
        throw new Error(`${motivo} E a grade ficou vazia sem nenhum aviso visivel`);
      }
      if (giphyFora) return `GIPHY indisponivel e a interface avisou: "${st.aviso}"`;
      if (st.celulas < 4) throw new Error(`stickers: ${st.celulas} card(s)`);
      if (st.carregadas < 4) throw new Error(`stickers: ${st.carregadas}/${st.imgs} imagens carregaram`);
      if (st.quebradas > 0) throw new Error(`stickers: ${st.quebradas} imagem(ns) quebrada(s)`);
      if (st.kinds.includes('sticker') === false && st.celulas > 0) throw new Error('cards de sticker sem marcador');
      const texto = await s.eval(`return (document.querySelector('.picker-panel')?.innerText || '').slice(0, 200);`);
      if (/kind:\s*sticker/i.test(texto)) throw new Error('a interface mostra "kind: sticker"');
      return `${st.celulas} stickers, ${st.carregadas} imagens, kinds=${JSON.stringify(st.kinds)}`;
    });

    // ---- Selecionar, enviar e renderizar ------------------------------
    await report.step(`${nome}: GIF selecionado e enviado aparece na conversa`, async () => {
      await abrirSeletor(s, 'GIFs');
      await sleep(2500);
      if (giphyFora) {
        report.ok(`${nome}: envio de GIF nao verificavel com o GIPHY indisponivel`);
        return;
      }
      const escolhido = await s.eval(`
        const celula = document.querySelector('.picker-grid .picker-cell img');
        if (!celula) return { erro: 'sem celula com imagem' };
        const src = celula.currentSrc || celula.src;
        celula.closest('button').click();
        await new Promise((x) => setTimeout(x, 900));
        return { src };
      `);
      if (escolhido.erro) throw new Error(escolhido.erro);
      await s.eval(`
        const enviar = [...document.querySelectorAll('.composer button')]
          .find((b) => /Enviar/i.test(b.getAttribute('aria-label') || b.title || ''));
        if (enviar) enviar.click();
        return true;
      `);
      const st = await s.waitForFunction(`
        const mensagens = [...document.querySelectorAll('.global-feed .msg-media img, .msg-media img, .msg-bubble img')];
        const boa = mensagens.find((i) => i.naturalWidth > 0);
        if (!boa) return null;
        const r = boa.getBoundingClientRect();
        return {
          total: mensagens.length,
          quebradas: mensagens.filter((i) => i.complete && i.naturalWidth === 0).length,
          w: Math.round(r.width),
          h: Math.round(r.height),
        };
      `, 15000).catch(() => null);
      if (!st) {
      const diag = await s.eval(`
        const composer = document.querySelector('.composer');
        return {
          toasts: [...document.querySelectorAll('.toast, .toast-msg, [role="alert"]')].map((t) => t.textContent.trim().slice(0, 90)),
          composer: Boolean(composer),
          filhosFeed: document.querySelector('.global-feed')?.children.length ?? -1,
          textoFeed: (document.querySelector('.global-feed')?.innerText || '').slice(0, 120),
        };
      `);
      throw new Error(`a mensagem enviada nao renderizou a imagem; tela=${JSON.stringify(diag)}; console=${JSON.stringify(s.consoleErrors.slice(0, 3))}`);
    }
      if (st.quebradas > 0) throw new Error(`${st.quebradas} imagem(ns) quebrada(s) na conversa`);
      if (st.w < 40 || st.h < 40) throw new Error(`imagem pequena na conversa: ${st.w}x${st.h}`);
      return `GIF renderizado na conversa (${st.w}x${st.h}), ${st.total} imagem(ns), 0 quebrada`;
    });
  }

  await report.step('nenhum erro de console no fluxo do GIPHY', async () => {
    const s = await sessao(390, 844, true);
    await s.goto(`${server.baseUrl}/chat-global`, { waitMs: 2500 });
    await abrirSeletor(s, 'GIFs');
    await sleep(3000);
    // O navegador registra no console o 503 da propria chamada ao GIPHY. Com o
    // provedor recusando, esse log e ESPERADO - o que nao pode passar e um erro
    // de JavaScript (que a UI nao engana) ou qualquer outra falha de rede.
    const soDoGiphy = errosEsperadosGiphy();
    const erros = s.consoleErrors.filter((e) => !/favicon|ERR_ABORTED|net::ERR/i.test(e) && !soDoGiphy.test(e));
    if (erros.length) throw new Error(erros.slice(0, 2).join(' | '));
    const logsGiphy = s.consoleErrors.filter((e) => soDoGiphy.test(e)).length;
    return `${erros.length} erro(s) de console${logsGiphy ? ` (+${logsGiphy} log(s) esperado(s) do GIPHY fora do ar)` : ''}`;
  });
} catch (err) {
  console.error(err.stack || err.message);
  report.fail('erro inesperado', err);
}

const resumo = report.summary();
await browser.close();
await server.stop();
process.exit(resumo.failed > 0 ? 1 : 0);
