/**
 * Verificador de LAYOUT (itens 1, 2, 9, 11 e 13).
 *
 * Nao testa CSS por texto: mede geometria real no Chrome, em cada tamanho
 * pedido, e falha se algum requisito NAO for medido como esperado:
 *
 *   1. bloco do autor (foto + nome + @ + descricao) proximo do rodape util;
 *   2. coluna de acoes (Curtir/Comentar/Salvar/Repostar/Compartilhar/3pontos)
 *      tambem baixa e proporcional a altura real da viewport;
 *   9. picker de GIF/figurinha cabe no mobile (320/360/390/414), sem
 *      scroll horizontal e sem ocupar a tela inteira;
 *  11. grade do perfil com 4 abas numa unica linha, sem overflow-x;
 *  13. nenhum elemento cortando, nenhum scroll horizontal na pagina.
 */
import {
  startServer, Client, Report, sleep, randomUsername, makeTestVideo,
} from '../tests/helpers.mjs';
import { launchChrome } from '../tests/cdp.mjs';

const report = new Report('Layout do feed, perfil e picker (medido no navegador)');

const MOBILE = [320, 360, 390, 414];
const DESKTOP = [1024, 1280, 1440, 1920];

/** Chrome nao emula `dvh` como a viewport real do aparelho; medimos do mesmo jeito. */
async function medir(s) {
  return s.eval(`
    const r = (sel) => document.querySelector(sel);
    const box = (sel) => {
      const n = r(sel);
      if (!n) return null;
      const b = n.getBoundingClientRect();
      return { top: Math.round(b.top), bottom: Math.round(b.bottom), left: Math.round(b.left), right: Math.round(b.right), w: Math.round(b.width), h: Math.round(b.height) };
    };
    const tabbar = box('.tabbar');
    const stage = box('.slide.active') || box('.slide');
    const overlay = box('.slide.active .slide-overlay') || box('.slide-overlay');
    const autor = box('.slide.active .slide-author') || box('.slide-author');
    const legenda = box('.slide.active .slide-caption') || box('.slide-caption');
    const acoes = box('.slide.active .slide-actions') || box('.slide-actions');
    // SOMENTE a publicacao ativa: o feed mantem varias paginas montadas, e
    // medir os botoes das outras daria espacamentos sem sentido.
    const botoes = [...document.querySelectorAll('.slide.active .act')]
      .map((b) => {
        const x = b.getBoundingClientRect();
        return { h: Math.round(x.height), w: Math.round(x.width), bottom: Math.round(x.bottom), top: Math.round(x.top) };
      })
      .sort((a, b) => a.top - b.top);
    const doc = document.documentElement;
    return {
      vw: innerWidth, vh: innerHeight,
      scrollX: doc.scrollWidth - doc.clientWidth,
      stage, tabbar, overlay, autor, legenda, acoes, botoes,
      // Onde o texto precisa chegar: acima da bottom nav no celular, e acima
      // do fim do player no desktop (lá nao existe bottom nav, e o player e
      // centralizado com max-height, entao innerHeight nao serve).
      limiteInferior: (tabbar && tabbar.h > 0) ? tabbar.top : (stage ? stage.bottom : innerHeight),
      alturaUtil: stage ? stage.h : innerHeight,
      comTabbar: Boolean(tabbar && tabbar.h > 0),
    };
  `);
}

async function run() {
  const server = await startServer();
  const host = new Client(server.baseUrl);
  const hostUser = await host.register({ username: randomUsername('host') });
  const login = await fetch(`${server.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: hostUser.username, password: 'Senha@Teste123' }),
  });
  const cookies = login.headers.getSetCookie();

  // Duas publicacoes com legenda longa: e a que mais estica o bloco.
  const ids = [];
  for (let i = 0; i < 2; i += 1) {
    const video = await makeTestVideo({ seconds: 1, width: 360, height: 640 });
    const up = await host.upload('/api/media/upload?purpose=video', video.buffer, {
      filename: video.filename, mime: video.mime,
    });
    const p = await host.post('/api/posts', {
      type: 'video',
      caption: `Legenda longa de teste ${i} `.repeat(24),
      mediaId: up.body.media.id,
    });
    ids.push(p.body.post.id);
  }

  const browser = await launchChrome({ extraArgs: ['--autoplay-policy=no-user-gesture-required'] });
  const s = await browser.newBrowserContext();
  s.watch();

  // Conversa usada para medir o picker no desktop: no PC o seletor e aberto
  // pelo composer da conversa particular, entao a tela precisa existir de
  // verdade (uma DM consigo mesmo nao e criada pela API).
  const parceiro = new Client(server.baseUrl);
  const parceiroUser = await parceiro.register({ username: randomUsername('parceiro') });
  const conversa = await host.post('/api/conversations', { userId: parceiroUser.id });
  const conversationId = conversa.body.conversationId;
  if (!conversationId) throw new Error('nao foi possivel criar a conversa para medir o picker');

  try {
    await s.goto(`${server.baseUrl}/`, { waitMs: 300 });
    for (const ck of cookies) {
      const par = ck.split(';')[0];
      const nome = par.slice(0, par.indexOf('='));
      await s.send('Network.setCookie', {
        name: nome, value: decodeURIComponent(par.slice(nome.length + 1)), domain: '127.0.0.1', path: '/',
      });
    }
    await s.goto(`${server.baseUrl}/`, { waitMs: 2600 });

    // ------------------------------------------------ ITENS 1 e 2: FEED ---
    for (const [largura, altura] of [...MOBILE.map((w) => [w, 780]), ...DESKTOP.map((w) => [w, 900])]) {
      await s.send('Emulation.setDeviceMetricsOverride', {
        width: largura, height: altura, deviceScaleFactor: 1, mobile: largura < 900,
      });
      await s.goto(`${server.baseUrl}/`, { waitMs: 2000 });
      const m = await medir(s);

      const rotulo = `${largura}x${altura}`;

      // Sem scroll horizontal (item 13).
      if (m.scrollX > 1) {
        throw new Error(`${rotulo}: scroll horizontal de ${m.scrollX}px`);
      }
      if (!m.stage || !m.autor || !m.acoes || !m.legenda) {
        throw new Error(`${rotulo}: elementos do feed ausentes (${JSON.stringify({ stage: Boolean(m.stage), autor: Boolean(m.autor), acoes: Boolean(m.acoes), legenda: Boolean(m.legenda) })})`);
      }

      // --- Item 1: o bloco do autor tem de estar BAIXO.
      // Medida em fracao da altura util do player: quanto mais perto de 1,
      // mais embaixo. Exigimos que o texto fique nos 34% inferiores, com
      // margem de folga para a bottom nav.
      const folgaTexto = m.limiteInferior - m.legenda.bottom;
      const fracaoTexto = 1 - (folgaTexto / m.alturaUtil);
      if (fracaoTexto < 0.72) {
        throw new Error(`${rotulo}: bloco do autor ainda alto (sobe ate ${(fracaoTexto * 100).toFixed(0)}% da altura util; folga do texto = ${folgaTexto}px)`);
      }
      // Nunca atras da bottom nav.
      if (folgaTexto < 0) {
        throw new Error(`${rotulo}: descricao ATRAS da bottom nav (${folgaTexto}px)`);
      }

      // --- Item 2: a coluna de acoes tambem baixa e proportionally espacada.
      const folgaAcoes = m.limiteInferior - m.acoes.bottom;
      const fracaoAcoes = 1 - (folgaAcoes / m.alturaUtil);
      if (fracaoAcoes < 0.70) {
        throw new Error(`${rotulo}: coluna de acoes ainda alta (sobe ate ${(fracaoAcoes * 100).toFixed(0)}% da altura util)`);
      }
      if (folgaAcoes < 0) {
        throw new Error(`${rotulo}: acoes ATRAS da bottom nav (${folgaAcoes}px)`);
      }
      if (m.botoes.length < 5) {
        throw new Error(`${rotulo}: coluna de acoes com ${m.botoes.length} botao(e)s (esperado >= 5)`);
      }
      // Espacamento uniforme entre os botoes (ja ordenados de cima para baixo).
      const vaos = [];
      for (let i = 1; i < m.botoes.length; i += 1) {
        vaos.push(m.botoes[i].top - m.botoes[i - 1].top);
      }
      const menor = vaos.length ? Math.min(...vaos) : 0;
      const maior = vaos.length ? Math.max(...vaos) : 0;
      // A coluna pode ter um separador visual entre grupos (curtir/comentar/
      // salvar e acoes depublicacao), entao a tolerancia cobre esse degrau.
      if (maior - menor > 16) {
        throw new Error(`${rotulo}: espacamento irregular entre os botoes (vaos ${vaos.join(', ')})`);
      }
      if (menor <= 0) {
        throw new Error(`${rotulo}: botoes sobrepostos (vaos ${vaos.join(', ')})`);
      }
      // Alvo de toque minimo.
      const pequeno = m.botoes.find((b) => b.h < 40 || b.w < 40);
      if (pequeno) {
        throw new Error(`${rotulo}: botao de acao com alvo pequeno (${pequeno.w}x${pequeno.h})`);
      }

      // --- Nao pode haver sobreposicao entre a legenda e a coluna de acoes.
      const colide = m.acoes.left < m.legenda.right - 2;
      if (colide) {
        throw new Error(`${rotulo}: legenda (right=${m.legenda.right}) invade a coluna de acoes (left=${m.acoes.left})`);
      }

      report.ok(`${rotulo}: texto ate ${(fracaoTexto * 100).toFixed(0)}% / acoes ate ${(fracaoAcoes * 100).toFixed(0)}% `
        + `da altura util, folga ${folgaTexto}px, ${m.botoes.length} botoes com vao ${menor}px`);
    }

    // ------------------------------------- ITENS 9 e 5: PICKER -------------
    // Mobile E desktop: no celular tem de caber sem estourar a tela; no
    // computador tem de ser um painel flutuante compacto (360-420px), nunca
    // uma janela que cobre a conversa.
    for (const [largura, altura] of [
      ...MOBILE.map((w) => [w, w <= 360 ? 640 : 780]),
      [1280, 900], [1920, 1080],
    ]) {
      const ehCelular = largura < 900;
      await s.send('Emulation.setDeviceMetricsOverride', {
        width: largura, height: altura, deviceScaleFactor: 1, mobile: ehCelular,
      });
      // No desktop o composer fica na conversa, entao e preciso abrir uma.
      const rota = ehCelular ? `/video/${ids[0]}` : `/inbox/${conversationId}`;
      await s.goto(`${server.baseUrl}${rota}`, { waitMs: 2200 });

      // No celular o composer vive dentro do painel de comentarios; no
      // desktop ele ja esta na conversa. O caminho real e o que se mede.
      if (ehCelular) {
        await s.eval(`
          const b = [...document.querySelectorAll('button')].find((x) => /coment/i.test(x.getAttribute('aria-label') || ''));
          if (b) b.click();
          return true;
        `);
        for (let i = 0; i < 12; i += 1) {
          // eslint-disable-next-line no-await-in-loop
          const tem = await s.eval("return Boolean(document.querySelector('.sheet .composer'));");
          if (tem) break;
          // eslint-disable-next-line no-await-in-loop
          await sleep(500);
        }
      }
      const abriuComposer = await s.eval(`
        const sheet = document.querySelector('.sheet, [role="dialog"]');
        const b = sheet
          ? [...sheet.querySelectorAll('button')].find((x) => /gif/i.test(x.getAttribute('aria-label') || ''))
          : [...document.querySelectorAll('.composer button')].find((x) => /gif/i.test(x.getAttribute('aria-label') || ''));
        if (!b) return false;
        b.click();
        return true;
      `);
      if (!abriuComposer) throw new Error(`${largura}px: sem botao de GIF`);
      // Espera a grade encher.
      for (let i = 0; i < 14; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await sleep(700);
        // eslint-disable-next-line no-await-in-loop
        const cheio = await s.eval(`
          const g = document.querySelector('.picker-panel .picker-grid');
          return g ? g.querySelectorAll('button').length : 0;
        `);
        if (cheio > 0) break;
      }

      const p = await s.eval(`
        const painel = document.querySelector('.picker-panel');
        if (!painel) return { erro: 'sem painel' };
        const b = painel.getBoundingClientRect();
        const grade = painel.querySelector('.picker-grid');
        const celulas = [...grade.querySelectorAll('button')];
        const r0 = celulas[0]?.getBoundingClientRect();
        const doc = document.documentElement;
        return {
          left: Math.round(b.left), right: Math.round(b.right), top: Math.round(b.top),
          bottom: Math.round(b.bottom), w: Math.round(b.width), h: Math.round(b.height),
          vw: innerWidth, vh: innerHeight,
          colunas: r0 ? Math.round(grade.getBoundingClientRect().width / (r0.width || 1)) : 0,
          celulaLargura: r0 ? Math.round(r0.width) : 0,
          deformada: celulas.some((c) => {
            const img = c.querySelector('img');
            if (!img) return false;
            const cell = c.getBoundingClientRect();
            // Com object-fit:cover a imagem e recortada, nunca esticada; se
            // alguma img desenhasse mais largo que a celula, estaria deformada.
            return img.getBoundingClientRect().width > cell.width + 2;
          }),
          scrollXPagina: doc.scrollWidth - doc.clientWidth,
          scrollXPainel: painel.scrollWidth - painel.clientWidth,
          fracaoAltura: Math.round((b.height / innerHeight) * 100),
        };
      `);
      if (p.erro) throw new Error(`${largura}px: ${p.erro}`);

      if (p.left < -1 || p.right > p.vw + 1) {
        throw new Error(`${largura}px: picker sai da tela (${p.left}..${p.right} de ${p.vw})`);
      }
      if (p.scrollXPagina > 1) {
        throw new Error(`${largura}px: scroll horizontal na pagina (${p.scrollXPagina}px) com o picker aberto`);
      }
      if (p.scrollXPainel > 1) {
        throw new Error(`${largura}px: scroll horizontal DENTRO do picker (${p.scrollXPainel}px)`);
      }
      // Item 9: nao ocupa a tela inteira vertical.
      if (p.fracaoAltura > 70) {
        throw new Error(`${largura}px: picker ocupa ${p.fracaoAltura}% da altura da tela`);
      }
      // Item 5: no desktop o painel e explicitamente compacto (360-420px).
      if (largura >= 1024 && (p.w < 340 || p.w > 430)) {
        throw new Error(`no desktop o picker deveria ter 360-420px, tem ${p.w}px`);
      }
      if (p.deformada) throw new Error(`${largura}px: thumbnail deformada (largura maior que a celula)`);
      if (p.colunas < 3) throw new Error(`${largura}px: grade com ${p.colunas} coluna(s) -的比例 ruim`);
      if (p.celulaLargura < 44) throw new Error(`${largura}px: celula de ${p.celulaLargura}px e pequena demais para o dedo`);

      report.ok(`${largura}px: picker ${p.w}x${p.h} (${p.fracaoAltura}% da tela), ${p.colunas} colunas de ${p.celulaLargura}px, dentro da viewport`);

      // Fecha o picker/painel antes do proximo tamanho.
      await s.eval(`
        const fecha = document.querySelector('.sheet-close');
        if (fecha) fecha.click();
        return true;
      `);
      await sleep(400);
    }

    // ------------------------------------- ITEM 11: GRADE DO PERFIL MOBILE ---
    for (const largura of MOBILE) {
      await s.send('Emulation.setDeviceMetricsOverride', {
        width: largura, height: 780, deviceScaleFactor: 1, mobile: true,
      });
      await s.goto(`${server.baseUrl}/@${hostUser.username}`, { waitMs: 2200 });
      const g = await s.eval(`
        const host = document.querySelector('.profile-tabs');
        if (!host) return { erro: 'sem grade' };
        const abas = [...host.querySelectorAll('.profile-tab')];
        const hb = host.getBoundingClientRect();
        // Rotulo cortado e "texto cortado" (item 13). Medir o no do ROTULO e
        // comparar com o texto inteiro e o que prova: text-overflow com
        // ellipsis mantem scrollWidth == clientWidth, entao so olhar o botao
        // nao acusaria nada.
        const cortes = abas.map((a) => {
          const rot = a.querySelector('.profile-tab-label');
          if (!rot) return null;
          const esperado = rot.textContent.trim();
          const completo = rot.scrollWidth <= rot.clientWidth + 1;
          const dentroDaTela = rot.getBoundingClientRect().right <= hb.right + 1;
          return completo && dentroDaTela ? null : { texto: esperado, largura: Math.round(rot.getBoundingClientRect().width), precisa: rot.scrollWidth };
        }).filter(Boolean);
        // Uma aba e um bloco so: se o icone e o texto ocuparem faixas verticais
        // diferentes, a aba ganhou uma segunda linha.
        const faixasPorAba = abas.map((a) => {
          const icone = a.querySelector('svg');
          const texto = a.querySelector('.profile-tab-text');
          if (!icone || !texto) return null;
          const bi = icone.getBoundingClientRect();
          const bt = texto.getBoundingClientRect();
          return Math.abs(bi.bottom - bt.top) <= 6 ? null : { sobrepostos: false, icone: Math.round(bi.bottom), texto: Math.round(bt.top) };
        }).filter(Boolean);
        return {
          rotulos: abas.map((a) => (a.querySelector('.profile-tab-label')?.textContent || '').trim()),
          n: abas.length,
          linhas: new Set(abas.map((a) => Math.round(a.getBoundingClientRect().top))).size,
          overflow: Math.round(host.scrollWidth - host.clientWidth),
          overflowX: getComputedStyle(host).overflowX,
          cortes,
          faixasPorAba,
          alturaAba: Math.round(abas[0]?.getBoundingClientRect().height || 0),
          larguraHost: Math.round(hb.width),
          larguraAba: Math.round(abas[0]?.getBoundingClientRect().width || 0),
          direcao: abas[0] ? getComputedStyle(abas[0]).flexDirection : null,
        };
      `);
      if (g.erro) throw new Error(`${largura}px: ${g.erro}`);
      if (g.n !== 4) throw new Error(`${largura}px: grade com ${g.n} abas, esperado 4 (${g.rotulos.join(' | ')})`);
      if (g.linhas !== 1) throw new Error(`${largura}px: grade ocupa ${g.linhas} linhas, esperado 1`);
      if (g.overflow > 1) throw new Error(`${largura}px: grade com overflow-x de ${g.overflow}px`);
      if (g.overflowX === 'auto' || g.overflowX === 'scroll') {
        throw new Error(`${largura}px: grade ainda e carrossel (overflow-x: ${g.overflowX})`);
      }
      if (g.cortes.length) {
        throw new Error(`${largura}px: rotulo cortado: ${JSON.stringify(g.cortes)}`);
      }
      if (g.faixasPorAba.length) {
        throw new Error(`${largura}px: icone e texto em linhas diferentes: ${JSON.stringify(g.faixasPorAba)}`);
      }
      report.ok(`${largura}px: grade com 4 abas em 1 linha (${g.rotulos.join(' | ')}), `
        + `${g.larguraAba}x${g.alturaAba}px cada (${g.direcao}), sem overflow e sem rotulo cortado`);
    }

    // ---------------------------------- ITEM 3: PERFIL A PARTIR DE "SEGUINDO" ---
    await s.send('Emulation.setDeviceMetricsOverride', {
      width: 390, height: 780, deviceScaleFactor: 1, mobile: true,
    });
    // Dados reais nas tres listas, senao o teste passaria por vacuuo:
    //   - 2 pessoas que o host segue          -> "Seguindo"
    //   - 1 pessoa que segue o host           -> "Seguidores"
    //   - 1Amizade mutua                     -> "Amigos"
    const seguidos = [];
    for (let i = 0; i < 2; i += 1) {
      const u = new Client(server.baseUrl);
      const novo = await u.register({ username: randomUsername('seguindo') });
      await host.post(`/api/users/${novo.id}/follow`, {});
      seguidos.push(novo);
    }
    const seguidor = new Client(server.baseUrl);
    const seguidorUser = await seguidor.register({ username: randomUsername('seguidor') });
    await seguidor.post(`/api/users/${hostUser.id}/follow`, {});

    const amigo = new Client(server.baseUrl);
    const amigoUser = await amigo.register({ username: randomUsername('amigo') });
    await host.post(`/api/users/${amigoUser.id}/follow`, {});
    await amigo.post(`/api/users/${hostUser.id}/follow`, {});

    for (const lista of ['seguindo', 'seguidores', 'amigos']) {
      await s.goto(`${server.baseUrl}/@${hostUser.username}`, { waitMs: 2000 });
      const abriu = await s.eval(`
        const b = [...document.querySelectorAll('button, [role="button"], .stat, .profile-stat')]
          .find((x) => new RegExp(${JSON.stringify(lista)}, 'i').test(x.textContent || ''));
        if (!b) return false;
        b.click();
        return true;
      `);
      if (!abriu) throw new Error(`lista "${lista}": contagem nao encontrada/nao clicavel`);
      await sleep(1400);
      const escolheu = await s.eval(`
        const modal = document.querySelector('.modal-backdrop');
        if (!modal) return { erro: 'a lista nao abriu' };
        const link = modal.querySelector('a[href^="/@"]');
        if (!link) return { erro: 'lista sem usuarios' };
        const alvo = link.getAttribute('href');
        link.click();
        return { alvo };
      `);
      if (escolheu.erro) throw new Error(`lista "${lista}": ${escolheu.erro}`);
      await sleep(1400);
      const depois = await s.eval(`
        const doc = document.documentElement;
        return {
          url: location.pathname,
          modais: document.querySelectorAll('.modal-backdrop, .sheet').length,
          noScroll: document.body.classList.contains('no-scroll'),
          scrollX: doc.scrollWidth - doc.clientWidth,
          perfilVisivel: Boolean(document.querySelector('[data-username]')) || /\\/@[a-z0-9_.]+$/i.test(location.pathname),
        };
      `);
      if (depois.modais > 0) {
        throw new Error(`lista "${lista}": ${depois.modais} janela(s) ficou(aram) aberta(s) por cima do perfil`);
      }
      if (depois.noScroll) throw new Error(`lista "${lista}": scroll-lock preso no <body>`);
      if (depois.scrollX > 1) throw new Error(`lista "${lista}": scroll horizontal apos navegar (${depois.scrollX}px)`);
      if (!depois.perfilVisivel) throw new Error(`lista "${lista}": perfil nao apareceu (url=${depois.url})`);
      report.ok(`lista "${lista}": navegou para ${depois.url}, 0 janela aberta, sem scroll-lock`);
    }

    // ------------------------------ ITEM 12: FLUIDEZ ----------------------
    // O que se mede aqui e o oposto de "animacao em tudo" e de "re-render
    // completo desnecessario": trocar de aba NAO pode recriar os botoes (senao
    // a linha "pula"), e nenhuma transicao pode passar de 200ms.
    for (const [largura, altura, celular] of [[390, 800, true], [1280, 900, false]]) {
      await s.send('Emulation.setDeviceMetricsOverride', {
        width: largura, height: altura, deviceScaleFactor: 1, mobile: celular,
      });
      await s.goto(`${server.baseUrl}/@${hostUser.username}`, { waitMs: 2200 });

      const marca = await s.eval(`
        window.__abas = [...document.querySelectorAll('.profile-tab')];
        window.__t0 = performance.now();
        return window.__abas.length;
      `);
      const alvo = await s.eval(`
        const b = [...document.querySelectorAll('.profile-tab')].find((x) => x.dataset.tab === 'likes');
        if (!b) return 'sem aba de curtidas';
        b.click();
        return 'clicou';
      `);
      if (alvo !== 'clicou') throw new Error(`${largura}px: ${alvo}`);
      // Espera o conteudo da aba chegar.
      for (let i = 0; i < 14; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        const pronto = await s.eval("return document.querySelector('.profile-tabs').dataset.total === '4' && !document.querySelector('.spinner');");
        if (pronto) break;
        // eslint-disable-next-line no-await-in-loop
        await sleep(600);
      }
      const depois = await s.eval(`
        const atuais = [...document.querySelectorAll('.profile-tab')];
        const mesmosNos = atuais.length === window.__abas.length
          && atuais.every((n, i) => n === window.__abas[i]);
        const selecionadas = atuais.filter((n) => n.getAttribute('aria-selected') === 'true').map((n) => n.dataset.tab);
        // Toda transicao precisa ser CURTA (item 12).
        const lentas = [];
        for (const n of document.querySelectorAll('.profile-tab, .profile-tabs, .profile-tab *')) {
          const cs = getComputedStyle(n);
          for (const prop of ['transitionDuration', 'animationDuration']) {
            const v = cs[prop];
            for (const parte of String(v).split(',')) {
              const ms = parseFloat(parte) * (parte.includes('ms') ? 1 : 1000);
              if (Number.isFinite(ms) && ms > 220) lentas.push({ sel: n.className, prop, ms });
            }
          }
        }
        return { mesmosNos, selecionadas, lentas, abaAtiva: document.querySelector('.profile-tabs') ? true : false };
      `);
      if (!depois.mesmosNos) {
        throw new Error(`${largura}px}: a troca de aba RECRIOU os botoes (re-render completo)`);
      }
      if (depois.selecionadas.length !== 1 || depois.selecionadas[0] !== 'likes') {
        throw new Error(`${largura}px}: estado da aba errado (${JSON.stringify(depois.selecionadas)})`);
      }
      if (depois.lentas.length) {
        throw new Error(`${largura}px}: transicao longa demais: ${JSON.stringify(depois.lentas.slice(0, 4))}`);
      }
      report.ok(`${largura}px: troca de aba sem remontar os botoes (${marca} nos preservados), `
        + 'selecao correta e nenhuma transicao acima de 220ms');
    }

    report.ok('layout medido em todos os tamanhos exigidos');
    void seguidos;
    void seguidor;
    void amigo;
  } catch (error) {
    report.fail('verificacao de layout interrompida', error);
  } finally {
    try { s.close?.(); } catch { /* ignore */ }
    await browser.close();
    await server.stop();
    void ids;
  }

  return report.summary();
}

run().then((r) => process.exit(r.failed > 0 ? 1 : 0)).catch((e) => {
  console.error('erro fatal:', e);
  process.exit(1);
});
