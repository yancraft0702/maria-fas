/**
 * Verificador do item 7 - MENU DE EFEITOS compacto e profissional.
 *
 * Medido no navegador, com uma LIVE de verdade (para o painel abrir dentro da
 * tela real, nao de uma pagina solta):
 *
 *  - os 15 presentes aparecem, com preview animado e nome curto;
 *  - o painel NAO domina a tela: largura e altura limitadas, e a rolagem fica
 *    dentro da grade (o cabecalho continua visivel);
 *  - busca funciona de verdade sem categorias que escondam presentes;
 *  - o painel cabe na viewport mesmo com a safe-area e a barra inferior da
 *    LIVE, e SEM scroll horizontal;
 *  - funciona em 320, 360, 390, 414, 768, 1024, 1280, 1440 e 1920.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  startServer, Client, Report, sleep, randomUsername,
} from '../tests/helpers.mjs';
import { ROOT } from '../server/config.js';
import { launchChrome } from '../tests/cdp.mjs';

const report = new Report('LIVE: menu de efeitos compacto (item 7)');
const SCREENSHOT = path.join(ROOT, 'tests', 'artifacts', 'live-presentes-grade-15.png');

const TAMANHOS = [
  [320, 640, true], [360, 780, true], [390, 844, true], [414, 896, true],
  [768, 1024, false], [1024, 900, false], [1280, 900, false],
  [1440, 900, false], [1920, 1080, false], [1280, 1800, false],
];

async function run() {
  const server = await startServer();
  const api = new Client(server.baseUrl);
  const host = await api.register({ username: randomUsername('host') });
  const cookies = await fetch(`${server.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: host.username, password: 'Senha@Teste123' }),
  }).then((r) => r.headers.getSetCookie());

  const browser = await launchChrome({
    extraArgs: [
      '--autoplay-policy=no-user-gesture-required',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
    ],
  });
  const s = await browser.newBrowserContext();
  s.watch();

  try {
    await s.goto(`${server.baseUrl}/`, { waitMs: 300 });
    for (const ck of cookies) {
      const par = ck.split(';')[0];
      const nome = par.slice(0, par.indexOf('='));
      await s.send('Network.setCookie', {
        name: nome, value: decodeURIComponent(par.slice(nome.length + 1)),
        domain: '127.0.0.1', path: '/',
      });
    }

    for (const [w, h, mobile] of TAMANHOS) {
      await s.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile });
      await s.goto(`${server.baseUrl}/iniciar-live`, { waitMs: 2400 });
      if (w === TAMANHOS[0][0] && h === TAMANHOS[0][1]) {
        const freshness = await s.eval(`
          const [sw, js, css] = await Promise.all([
            fetch('/sw.js', { cache: 'no-store' }),
            fetch('/js/features/live-effects-card.js', { cache: 'no-store' }),
            fetch('/css/app.css', { cache: 'no-store' }),
          ]);
          return {
            versionedWorker: (await sw.text()).includes("const VERSION = 'pulse-v2'"),
            headers: [sw, js, css].map((r) => r.headers.get('cache-control')),
          };
        `);
        if (!freshness.versionedWorker || freshness.headers.some((header) => header !== 'no-cache')) {
          throw new Error(`worker/assets não atualizam cache corretamente: ${JSON.stringify(freshness)}`);
        }
        report.ok('service worker v2 e JS/CSS recebidos com revalidação sem cache HTTP');
      }
      const clicou = await s.eval(`
        const b = [...document.querySelectorAll('button')].find((x) => /iniciar transmissao/i.test(x.textContent || ''));
        if (!b) return 'sem botao';
        b.click();
        return 'clicou';
      `);
      if (clicou !== 'clicou') throw new Error(`${w}x${h}: ${clicou}`);
      await sleep(5200);
      const sala = (await api.get(`/api/users/${host.id}/live`)).body.live;
      if (!sala?.id) throw new Error(`${w}x${h}: a LIVE nao subiu`);

      const catalogo = await api.get('/api/live/effects');
      const totalEsperado = (catalogo.body.effects || []).length;
      if (totalEsperado !== 15) throw new Error(`catalogo com ${totalEsperado} presentes (esperado exatamente 15)`);
      if (catalogo.headers.get('cache-control') !== 'no-store') {
        throw new Error(`API de presentes com cache-control inesperado: ${catalogo.headers.get('cache-control')}`);
      }
      report.ok('API com exatamente 15 presentes');

    // Abre o menu de efeitos pelo BOTAO REAL da barra da LIVE.
      const requestsAntes = s.requests.filter((r) => new URL(r.url).pathname === '/api/live/effects').length;
      const abriuEfeitos = await s.eval(`
        const b = document.querySelector('.live-effects-btn')
          || [...document.querySelectorAll('button')]
            .find((x) => /Efeitos/i.test(x.getAttribute('aria-label') || ''));
        if (!b) return 'sem botao de efeitos';
        b.click();
        await new Promise((r) => setTimeout(r, 1100));
        const painel = document.querySelector('.effect-picker');
        if (!painel) return 'sem painel';
        // Deve ser o UNICO modal aberto: a medicao abaixo usa o primeiro.
        const modais = [...document.querySelectorAll('.modal')];
        return modais.length === 1 ? 'abriu' : 'abriu com ' + modais.length + ' modais';
      `);
      if (abriuEfeitos !== 'abriu') {
        throw new Error(`${w}x${h}: o painel de efeitos nao abriu limpo (${abriuEfeitos})`);
      }
      const requestsDepois = s.requests.filter((r) => new URL(r.url).pathname === '/api/live/effects').length;
      if (requestsDepois !== requestsAntes + 1) {
        throw new Error(`${w}x${h}: abrir a grade fez ${requestsDepois - requestsAntes} requests a /api/live/effects`);
      }

      const medido = await s.eval(`
        const painel = document.querySelector('.effect-picker');
        const modal = document.querySelector('.modal');
        const grade = document.querySelector('.effect-grid');
        const cabecalho = document.querySelector('.effect-picker-topo');
        const mr = modal.getBoundingClientRect();
        const gr = grade.getBoundingClientRect();
        const cards = [...grade.querySelectorAll('.effect-card')];
        const cardData = cards.map((c) => ({
          slug: c.dataset.slug,
          effectId: c.dataset.effectId,
          preview: c.querySelector('.effect-card-media img')?.getAttribute('src') || null,
          loaded: Boolean(c.querySelector('.effect-card-media img')?.naturalWidth),
        }));
        const nomes = cards.map((c) => (c.querySelector('.effect-card-name') || {}).textContent || '');
        const previews = cards.filter((c) => c.querySelector('img, video')).length;
        const comPreviewQuebrado = cards.filter((c) => {
          const m = c.querySelector('.effect-card-media');
          return m && m.classList.contains('is-broken');
        }).length;
        const selos = cards.filter((c) => c.querySelector('.effect-card-som')).length;
        // Nome curto: uma linha, sem vazar do card.
        const nomesEstouram = cards.filter((c) => {
          const n = c.querySelector('.effect-card-name');
          // O nome pode ocupar ate DUAS linhas (clamp), entao o limite e
          // ~38px. Acima disso o texto vazou do card.
          return n ? n.getBoundingClientRect().height > 40 : false;
        }).length;
        // O nome tem que caber na LARGURA do card (com clamp de 2 linhas), e os
        // cards precisam ter a mesma altura - senao a grade fica desalinhada.
        const alturas = new Set(cards.map((c) => Math.round(c.getBoundingClientRect().height)));
        const nomeVaza = cards.filter((c) => {
          const n = c.querySelector('.effect-card-name');
          return n ? n.scrollWidth > n.clientWidth + 1 : false;
        }).length;
        return {
          painel: [Math.round(painel.getBoundingClientRect().width), Math.round(painel.getBoundingClientRect().height)],
          modal: [Math.round(mr.width), Math.round(mr.height)],
          modalMaxWidth: getComputedStyle(modal).maxWidth,
          modalInline: modal.style.maxWidth || '(sem inline)',
          todosModais: [...document.querySelectorAll('.modal')].map((m) => Math.round(m.getBoundingClientRect().width)),
          grade: [Math.round(gr.width), Math.round(gr.height)],
          cards: cards.length,
          cardData,
          colunas: new Set(cards.map((c) => Math.round(c.getBoundingClientRect().left))).size,
          larguraCard: cards.length ? Math.round(cards[0].getBoundingClientRect().width) : 0,
          alturaCard: cards.length ? Math.round(cards[0].getBoundingClientRect().height) : 0,
          previews,
          comPreviewQuebrado,
          selos,
          nomes: nomes.slice(0, 4),
          nomesEstouram,
          alturas: [...alturas],
          nomeVaza,
          rola: grade.scrollHeight > grade.clientHeight + 1,
          cabecalhoVisivel: Boolean(cabecalho) && cabecalho.getBoundingClientRect().height > 0,
          filtrosVisiveis: Boolean(document.querySelector('.effect-picker-filtros')),
          busca: Boolean(document.querySelector('.effect-picker-busca')),
          categorias: document.querySelectorAll('.effect-picker-chip').length,
          contador: (document.querySelector('.effect-picker-count')?.textContent || '').trim(),
          // O painel tem de caber na viewport.
          foraDaTela: Math.round(Math.max(0, mr.bottom - innerHeight)) + Math.round(Math.max(0, -mr.top)),
          scrollX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          rodape: (document.querySelector('.effect-picker-rodape')?.textContent || '').trim(),
        };
      `);

      if (medido.cards !== totalEsperado) {
        throw new Error(`${w}x${h}: o painel mostrou ${medido.cards} efeitos `
          + `(o catalogo tem ${totalEsperado})`);
      }
      const apiPresentes = catalogo.body.effects;
      const esperadosPorSlug = new Map(apiPresentes.map((e) => [e.slug, e]));
      for (const card of medido.cardData) {
        const effect = esperadosPorSlug.get(card.slug);
        if (!effect || card.effectId !== effect.id || card.preview !== effect.mediaUrl) {
          throw new Error(`${w}x${h}: card ${card.slug} não usa o preview oficial correspondente (${JSON.stringify(card)})`);
        }
      }
      if (new Set(medido.cardData.map((c) => c.slug)).size !== 15
          || medido.cardData.some((c) => !esperadosPorSlug.has(c.slug))) {
        throw new Error(`${w}x${h}: a grade não corresponde exatamente aos 15 slugs oficiais`);
      }
      if (medido.previews < totalEsperado) {
        throw new Error(`${w}x${h}: so ${medido.previews} efeitos com preview `
          + `(o catalogo tem ${totalEsperado})`);
      }
      if (medido.comPreviewQuebrado > 0) {
        throw new Error(`${w}x${h}: ${medido.comPreviewQuebrado} preview(s) quebrado(s)`);
      }
      if (medido.nomesEstouram > 0) {
        throw new Error(`${w}x${h}: ${medido.nomesEstouram} card(s) com nome em mais de uma linha`);
      }
      if (medido.foraDaTela > 0) {
        throw new Error(`${w}x${h}: o painel passa ${medido.foraDaTela}px da viewport`);
      }
      if (medido.scrollX > 1) throw new Error(`${w}x${h}: scroll horizontal com o painel aberto`);
      if (!medido.busca) throw new Error(`${w}x${h}: o painel nao tem busca`);
      if (medido.categorias) throw new Error(`${w}x${h}: categorias escondem itens do catálogo`);
      // Compacto: nao pode dominar a tela.
      if (medido.modal[1] > h * 0.72) {
        throw new Error(`${w}x${h}: o painel mede ${medido.modal[1]}px de altura em ${h}px de tela `
          + '(dominando a tela)');
      }
      if (medido.modal[0] > Math.min(w, 430)) {
        throw new Error(`${w}x${h}: o painel mede ${medido.modal[0]}px de largura `
          + `(max-width resolvido=${medido.modalMaxWidth}, inline=${medido.modalInline}, `
          + `modais na tela=${JSON.stringify(medido.todosModais)})`);
      }
      if (medido.cardsTruncap > 0) {
        throw new Error(`${w}x${h}: ${medido.cardsTruncap} nome(s) cortados dentro do card`);
      }
      report.ok(`${w}x${h} (${mobile ? 'mobile' : 'desktop'}): painel ${medido.modal.join('x')}px, `
        + `grade ${medido.grade.join('x')}px com ${medido.cards} cards em ${medido.colunas} colunas `
        + `(card ${medido.larguraCard}x${medido.alturaCard}), ${medido.selos} selo(s) de som, `
        + `rolagem interna ${medido.rola ? 'sim' : 'nao'}, contador "${medido.contador}"`);
      if (w === 1280 && h === 1800) {
        const previewsCarregados = medido.cardData.every((card) => card.loaded);
        if (!previewsCarregados) throw new Error('a grade completa tem preview ainda não carregado');
        fs.mkdirSync(path.dirname(SCREENSHOT), { recursive: true });
        const bounds = await s.eval(`
          const r = document.querySelector('.modal').getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height };
        `);
        const { data } = await s.send('Page.captureScreenshot', {
          format: 'png',
          captureBeyondViewport: true,
          clip: { ...bounds, scale: 2 },
        });
        fs.writeFileSync(SCREENSHOT, Buffer.from(data, 'base64'));
        report.ok(`captura visual da grade real com 15 cards: ${SCREENSHOT}`);
      }

      // Busca: filtra de verdade.
      await s.eval(`
        const campo = document.querySelector('.effect-picker-busca');
        campo.focus();
        campo.value = 'fogo';
        campo.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      `);
      await sleep(500);
      const buscou = await s.eval(`
        const cards = [...document.querySelectorAll('.effect-grid .effect-card')];
        return {
          n: cards.length,
          nomes: cards.map((c) => (c.textContent || '').trim().toLowerCase()),
          contador: (document.querySelector('.effect-picker-count')?.textContent || '').trim(),
        };
      `);
      if (buscou.n < 1 || !buscou.nomes.every((n) => n.includes('fogo'))) {
        throw new Error(`${w}x${h}: a busca por "fogo" trouxe ${JSON.stringify(buscou.nomes)}`);
      }
      if (!buscou.contador.endsWith('de 15')) {
        throw new Error(`${w}x${h}: contador apos a busca ficou "${buscou.contador}" `
          + '(esperado "N de 15", o total do catálogo)');
      }

      await s.eval(`
        const campo = document.querySelector('.effect-picker-busca');
        campo.value = '';
        campo.dispatchEvent(new Event('input', { bubbles: true }));
      `);
      const todosComSom = await s.eval(`
        const cards = [...document.querySelectorAll('.effect-grid .effect-card')];
        return cards.length === 15 && cards.every((c) => c.querySelector('.effect-card-som'));
      `);
      if (!todosComSom) throw new Error(`${w}x${h}: presentes sem selo/arquivo de som`);
      report.ok(`${w}x${h}: busca "fogo" -> ${buscou.n} card(s); 15 previews com áudio, sem filtros`);

      // Item 7 no mobile: com o teclado aberto (a busca e um campo de texto) o
      // painel tem que encolher e continuar cabendo na tela.
      if (mobile) {
        // eslint-disable-next-line no-await-in-loop
        await s.eval(`
          const campo = document.querySelector('.effect-picker-busca');
          campo.focus();
          campo.dispatchEvent(new FocusEvent('focus'));
          return true;
        `);
        // eslint-disable-next-line no-await-in-loop
        await sleep(400);
        // eslint-disable-next-line no-await-in-loop
        const comTeclado = await s.eval(`
          const painel = document.querySelector('.effect-picker');
          const mr = document.querySelector('.modal').getBoundingClientRect();
          const grade = document.querySelector('.effect-grid');
          return {
            classe: painel.className,
            altura: Math.round(painel.getBoundingClientRect().height),
            modal: Math.round(mr.height),
            gradeVisivel: grade.getBoundingClientRect().height,
            foraDaTela: Math.round(Math.max(0, mr.bottom - innerHeight)),
            scrollX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          };
        `);
        if (!/com-teclado/.test(comTeclado.classe)) {
          throw new Error(`${w}x${h}: focar a busca nao marcou o painel como "com teclado"`);
        }
        if (comTeclado.altura >= medido.modal[1]) {
          throw new Error(`${w}x${h}: com o teclado o painel nao encolheu `
            + `(${medido.modal[1]}px -> ${comTeclado.altura}px)`);
        }
        if (comTeclado.foraDaTela > 0 || comTeclado.scrollX > 1) {
          throw new Error(`${w}x${h}: com o teclado o painel passa da tela `
            + `(${comTeclado.foraDaTela}px, scrollX ${comTeclado.scrollX})`);
        }
        report.ok(`${w}x${h}: com a busca focada o painel encolheu `
          + `${medido.modal[1]}px -> ${comTeclado.altura}px, grade ainda com `
          + `${comTeclado.gradeVisivel}px e nada fora da tela`);
        // eslint-disable-next-line no-await-in-loop
        await s.eval(`
          document.querySelector('.effect-picker-busca').blur();
          return true;
        `);
        // eslint-disable-next-line no-await-in-loop
        await sleep(300);
      }

      // Fecha o painel e encerra a LIVE, para o proximo tamanho comecar limpo.
      await s.eval(`
        const fechar = [...document.querySelectorAll('.modal button')]
          .find((x) => /Fechar|Close|cancelar/i.test(x.getAttribute('aria-label') || x.textContent || ''));
        if (fechar) fechar.click();
        else document.querySelector('.modal-backdrop')?.dispatchEvent(
          new MouseEvent('click', { bubbles: true }));
        return true;
      `);
      await sleep(500);
      const fim = await api.post(`/api/live/${sala.id}/end`, {});
      if (fim.status >= 400 && fim.status !== 404) {
        throw new Error(`${w}x${h}: nao encerrou a LIVE (${fim.status})`);
      }
    }

    report.ok('LIVE real consome /api/live/effects; grade exata de 15 previews oficiais em 10 resolucoes');
  } catch (error) {
    report.fail('verificacao do menu de efeitos interrompida', error);
  } finally {
    try { s.close?.(); } catch { /* ignore */ }
    await browser.close();
    await server.stop();
  }
  return report.summary();
}

run().then((r) => process.exit(r.failed > 0 ? 1 : 0)).catch((e) => { console.error(e); process.exit(1); });