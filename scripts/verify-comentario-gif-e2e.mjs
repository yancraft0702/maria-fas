/**
 * Verificador E2E do item 6: GIF e figurinha como comentario, no navegador.
 *
 * Existe porque a validacao do backend ja passava (ha teste de API), mas o
 * relato era "o sistema responde campo obrigatorio". O caminho que quebrava era
 * o REAL: composer -> picker -> onSend -> API. Este script nao chama a API
 * direto para o comentario: ele ABRE a publicacao, ABRE o painel, CLICA no
 * botao de GIF, ESCOLHE um item, envia e confere o que apareceu na tela e no
 * banco.
 */
import {
  startServer, Client, Report, sleep, randomUsername, makeTestVideo,
} from '../tests/helpers.mjs';
import { launchChrome } from '../tests/cdp.mjs';

const report = new Report('GIF/figurinha em comentario (fluxo real do navegador)');

/** Espera ate `teste` devolver verdadeiro (ou desistir). Nada de sleep fixo. */
async function esperar(s, descricao, teste, { tentativas = 20, passo = 700 } = {}) {
  let ultimo = null;
  for (let i = 0; i < tentativas; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    ultimo = await s.eval(teste);
    if (ultimo) return ultimo;
    // eslint-disable-next-line no-await-in-loop
    await sleep(passo);
  }
  throw new Error(`timeout esperando: ${descricao} (ultimo=${JSON.stringify(ultimo)})`);
}

async function run() {
  const server = await startServer();
  const host = new Client(server.baseUrl);
  const hostUser = await host.register({ username: randomUsername('host') });
  await host.post('/api/auth/login', { identifier: hostUser.username, password: 'Senha@Teste123' });

  const outro = new Client(server.baseUrl);
  const outroUser = await outro.register({ username: randomUsername('outro') });
  const login = await fetch(`${server.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: outroUser.username, password: 'Senha@Teste123' }),
  });
  const cookies = login.headers.getSetCookie();

  const video = await makeTestVideo({ seconds: 1, width: 240, height: 320 });
  const up = await host.upload('/api/media/upload?purpose=video', video.buffer, {
    filename: video.filename, mime: video.mime,
  });
  const post = await host.post('/api/posts', { type: 'video', caption: 'post', mediaId: up.body.media.id });
  const postId = post.body.post.id;

  const browser = await launchChrome({ extraArgs: ['--autoplay-policy=no-user-gesture-required'] });
  const s = await browser.newBrowserContext();
  s.watch();

  const registrarRede = () => s.eval(`
    if (!window.__redeHook) {
      window.__redeHook = true;
      window.__rede = [];
      const orig = window.fetch;
      window.fetch = async (...args) => {
        const url = String(args[0]?.url || args[0] || '');
        // O QUE FOI ENVIADO e o que interessa: o corpo da RESPOSTA tem o
        // comentario serializado inteiro e os campos uteis ficam depois de 400
        // caracteres, o que media o proprio teste.
        let enviado = '';
        try { enviado = typeof args[1]?.body === 'string' ? args[1].body.slice(0, 400) : ''; } catch { enviado = ''; }
        const r = await orig(...args);
        if (url.includes('/comments')) {
          window.__rede.push({
            metodo: (args[1]?.method || 'GET'),
            url: url.replace(location.origin, ''),
            status: r.status,
            enviado,
          });
        }
        return r;
      };
    }
    return true;
  `);

  const abrirPainel = async () => {
    await s.eval(`
      const sheet = document.querySelector('.sheet, [role="dialog"]');
      if (sheet) return true;
      const b = [...document.querySelectorAll('button')].find((x) => /coment/i.test(x.getAttribute('aria-label') || ''));
      if (!b) return false;
      b.click();
      return true;
    `);
    return esperar(s, 'painel de comentarios', `
      const sheet = document.querySelector('.sheet, [role="dialog"]');
      if (!sheet) return false;
      const temComposer = Boolean(sheet.querySelector('textarea, input'));
      const temGif = [...sheet.querySelectorAll('button')].some((b) => /gif/i.test(b.getAttribute('aria-label') || ''));
      return temComposer && temGif ? 'ok' : false;
    `);
  };

  const escolherItem = async (celula) => s.eval(`
    const grade = document.querySelector('.picker-grid, [class*="picker"] .grid, .gif-grid');
    if (!grade) return 'sem grade';
    const botoes = [...grade.querySelectorAll('button')];
    const alvo = botoes[${celula}];
    if (!alvo) return 'grade sem ' + ${celula} + ' celulas';
    alvo.click();
    return 'clicou';
  `);

  try {
    // A sessao precisa estar logada NA PAGINA: sem o cookie, o botao de
    // comentarios redireciona para /entrar e nao existe painel nenhum.
    await s.goto(`${server.baseUrl}/`, { waitMs: 300 });
    for (const ck of cookies) {
      const par = ck.split(';')[0];
      const nome = par.slice(0, par.indexOf('='));
      await s.send('Network.setCookie', {
        name: nome, value: decodeURIComponent(par.slice(nome.length + 1)), domain: '127.0.0.1', path: '/',
      });
    }
    await s.send('Emulation.setDeviceMetricsOverride', {
      width: 390, height: 844, deviceScaleFactor: 1, mobile: true,
    });
    await s.goto(`${server.baseUrl}/video/${postId}`, { waitMs: 3000 });
    const logado = await s.eval(`
      return !/\\/entrar$/.test(location.pathname) && Boolean(document.querySelector('[data-auth-user], .avatar, .perfil-link'));
    `);
    if (!logado) throw new Error(`a sessao nao ficou logada (url=${await s.eval('return location.pathname;')})`);

    await registrarRede();
    const abriu = await abrirPainel();
    report.ok(`painel aberto: ${abriu}`);

    // ---------------------------------------------------------------- GIF ---
    await s.eval(`
      const sheet = document.querySelector('.sheet, [role="dialog"]');
      const b = [...sheet.querySelectorAll('button')].find((x) => /gif/i.test(x.getAttribute('aria-label') || ''));
      b.click();
      return true;
    `);
    await esperar(s, 'grade de GIF', `
      const grade = document.querySelector('.picker-grid, [class*="picker"] .grid, .gif-grid');
      return grade && grade.querySelectorAll('button').length ? grade.querySelectorAll('button').length : false;
    `);
    const cliqueGif = await escolherItem(0);
    if (cliqueGif !== 'clicou') throw new Error(cliqueGif);

    await esperar(s, 'comentario com GIF na tela', `
      return document.querySelectorAll('.comment-media img').length >= 1 ? true : false;
    `);
    const postGif = await s.eval(`
      const envios = (window.__rede || []).filter((r) => r.metodo === 'POST');
      return envios.map((r) => ({ status: r.status, tipo: /"type":"sticker"/.test(r.enviado) ? 'sticker' : (/"type":"gif"/.test(r.enviado) ? 'gif' : '?'), temUrl: /"url":"https/.test(r.enviado) }));
    `);
    if (!postGif.length) throw new Error('nenhum POST /comments saiu (o composer nao enviou)');
    if (postGif.some((p) => p.status >= 400)) {
      throw new Error(`POST /comments rejeitou: ${JSON.stringify(postGif)}`);
    }
    if (postGif.some((p) => p.tipo === '?' || !p.temUrl)) {
      throw new Error(`o envio nao carregava anexo (type/url): ${JSON.stringify(postGif)}`);
    }
    report.ok(`GIF enviado sem texto: ${JSON.stringify(postGif)}`);

    // Recarrega e confere que o GIF continua salvo.
    await s.goto(`${server.baseUrl}/video/${postId}`, { waitMs: 2600 });
    await abrirPainel();
    // A lista de comentarios carrega por async: espera ela encher antes de
    // medir, senao o teste ve o estado vazio e acusa bug onde nao ha.
    await esperar(s, 'comentarios carregados apos reload', `
      const sheet = document.querySelector('.sheet, [role="dialog"]');
      if (!sheet) return false;
      const temLista = sheet.querySelector('.comment, .comment-item, [class*="comment"]');
      return temLista ? true : false;
    `, { tentativas: 20 });
    const persistiu = await s.eval(`
      const imgs = [...document.querySelectorAll('.comment-media img')];
      return { total: imgs.length, giphy: imgs.filter((i) => /giphy/i.test(i.src)).length };
    `);
    if (persistiu.giphy === 0) {
      throw new Error(`apos recarregar o GIF nao continuou salvo (${JSON.stringify(persistiu)})`);
    }
    report.ok(`GIF persistiu apos recarregar (${persistiu.giphy} midia(s))`);

    // ---------------------------------------------------------- FIGURINHA ---
    await registrarRede();
    await s.eval(`
      const sheet = document.querySelector('.sheet, [role="dialog"]');
      const b = [...sheet.querySelectorAll('button')].find((x) => /gif/i.test(x.getAttribute('aria-label') || ''));
      if (!b) return false;
      b.click();
      return true;
    `);
    await esperar(s, 'picker reaberto', `
      const grade = document.querySelector('.picker-grid, [class*="picker"] .grid, .gif-grid');
      return grade && grade.querySelectorAll('button').length ? true : false;
    `);
    const aba = await s.eval(`
      const botoes = [...document.querySelectorAll('[role="tab"], .seg button')];
      const alvo = botoes.find((b) => /sticker|figurinha/i.test(b.textContent || ''));
      if (!alvo) return 'sem aba: ' + botoes.map((b) => (b.textContent || '').trim()).join(' | ');
      alvo.click();
      return 'clicou';
    `);
    if (aba !== 'clicou') throw new Error(aba);
    await esperar(s, 'grade de figurinhas', `
      const grade = document.querySelector('.picker-grid, [class*="picker"] .grid, .gif-grid');
      return grade && grade.querySelectorAll('button').length ? grade.querySelectorAll('button').length : false;
    `);
    const cliqueSticker = await escolherItem(0);
    if (cliqueSticker !== 'clicou') throw new Error(cliqueSticker);

    // Espera ATIVA pela segunda midia. O que conta e o ANEXO existir no
    // comentario (`media-broken` tambem e um anexo visivel: se a URL externa
    // caiu, o aviso aparece em vez de sumir).
    let estadoSticker = null;
    for (let tent = 0; tent < 20; tent += 1) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(900);
      // eslint-disable-next-line no-await-in-loop
      estadoSticker = await s.eval(`
        const midias = [...document.querySelectorAll('.comment-media')];
        return {
          total: document.querySelectorAll('.comment-media img').length,
          midias: midias.length,
          quebradas: document.querySelectorAll('.comment-media .media-broken').length,
          completa: midias.map((m) => {
            const i = m.querySelector('img');
            return i ? { w: i.naturalWidth, ok: i.complete && i.naturalWidth > 0 } : 'sem img';
          }),
        };
      `);
      if (estadoSticker.midias >= 2 && estadoSticker.completa.filter((c) => c && c.ok).length >= 2) break;
    }
    if (estadoSticker.midias < 2) {
      // Antes de acusar o produto, mostra onde a figurinha parou: no banco ou
      // na tela.
      const noBanco = await fetch(`${server.baseUrl}/api/posts/${postId}/comments`, {
        headers: { Cookie: cookies.join('; ') },
      }).then((r) => r.json())
        .then((d) => (d.comments || []).map((c) => ({ tipo: c.type, url: Boolean(c.media && c.media.url) })));
      throw new Error(
        `figurinha nao virou anexo no comentario: tela=${JSON.stringify(estadoSticker)} `
        + `banco=${JSON.stringify(noBanco)}`,
      );
    }
    if (estadoSticker.quebradas > 0) {
      throw new Error(`a URL da figurinha nao carregou e virou aviso: ${JSON.stringify(estadoSticker)}`);
    }
    // O no no DOM nao basta: a imagem precisa ter pixels de verdade. O GIPHY
    // devolve 200 com uma imagem "conteudo indisponivel" quando o item nao
    // existe mais, e isso apareceria como "imagem carregada" numa checagem
    // so de URL.
    const semPixel = (estadoSticker.completa || []).filter((c) => typeof c === 'object' && (!c.ok || c.w < 8));
    if (semPixel.length) {
      throw new Error(`a midia do comentario esta no DOM mas sem imagem valida: ${JSON.stringify(semPixel)}`);
    }
    if (estadoSticker.quebradas > 0) {
      throw new Error(`a URL da figurinha nao carregou e virou aviso: ${JSON.stringify(estadoSticker)}`);
    }

    // Tela sem erro de validacao.
    const naTela = await s.eval(`
      const texto = document.body.innerText || '';
      return {
        midias: document.querySelectorAll('.comment-media').length,
        campoObrigatorio: /campo obrigat[oó]rio/i.test(texto),
      };
    `);
    if (naTela.campoObrigatorio) throw new Error('a tela ainda mostra "campo obrigatorio"');
    report.ok(`figurinha aceito sem texto (${naTela.midias} anexos no comentario)`);

    // Banco: os DOIS tipos gravados, com URL.
    const tipos = await fetch(`${server.baseUrl}/api/posts/${postId}/comments`, {
      headers: { Cookie: cookies.join('; ') },
    }).then((r) => r.json())
      .then((d) => (d.comments || []).map((c) => ({ type: c.type, url: Boolean(c.media && c.media.url) })));
    if (!tipos.some((c) => c.type === 'gif' && c.url)) {
      throw new Error(`banco sem GIF com url: ${JSON.stringify(tipos)}`);
    }
    if (!tipos.some((c) => c.type === 'sticker' && c.url)) {
      throw new Error(`banco sem figurinha com url: ${JSON.stringify(tipos)}`);
    }
    report.ok(`banco gravou gif e sticker com midia: ${JSON.stringify(tipos)}`);

    report.ok('GIF e figurinha em comentario validados ponta a ponta');
  } catch (error) {
    const rede = await s.eval('return (window.__rede || []).slice(-4);').catch(() => null);
    report.fail(`fluxo interrompido${rede ? ` (rede=${JSON.stringify(rede).slice(0, 400)})` : ''}`, error);
  } finally {
    try { s.close?.(); } catch { /* ignore */ }
    await browser.close();
    await server.stop();
  }

  return report.summary();
}

run().then((r) => process.exit(r.failed > 0 ? 1 : 0)).catch((e) => {
  console.error('erro fatal:', e);
  process.exit(1);
});
