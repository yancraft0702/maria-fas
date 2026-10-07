/**
 * Verificador do item 30 - o "vazio preto" abaixo da conversa no celular.
 *
 * Nao testa CSS por texto: MEDE, no Chrome, com a safe-area de um iPhone
 * injetada (o headless reporta `env(safe-area-inset-*) = 0`, entao sem isso
 * a situacao real do aparelho nunca seria medida).
 *
 * O que e exigido:
 *  A) a soma topbar + pagina + tabbar == altura da viewport (nada sobrando);
 *  B) entre o fim do composer e o topo da tabbar NAO existe faixa sem dono;
 *  C) o corpo das mensagens rola de ponta a ponta sem revelar nada fora dele;
 *  D) com o teclado aberto (viewport visivel menor) o documento NAO passa a
 *     rolar e o composer continua acima do limite inferior;
 *  E) fechar o teclado restaura a altura, sem valor antigo guardado.
 */
import {
  startServer, Client, Report, sleep, randomUsername, makeTestAudio,
} from '../tests/helpers.mjs';
import { launchChrome } from '../tests/cdp.mjs';

const report = new Report('Chat privado: altura real e sem vazio preto (item 30)');

const CELULARES = [[320, 640], [360, 780], [390, 844], [414, 896]];

/** Injeta a safe-area de um iPhone: sem isso o cenario real nao existe no Chrome. */
const APLICAR_SAFE_AREA = `
  const r = document.documentElement.style;
  r.setProperty('--safe-t', '47px');
  r.setProperty('--safe-b', '34px');
  return true;
`;

/** Snapshot da cadeia inteira, com quem "dona" cada pixel da coluna. */
const MEDIR = `
  const box = (sel) => {
    const n = document.querySelector(sel);
    if (!n) return null;
    const b = n.getBoundingClientRect();
    const cs = getComputedStyle(n);
    return {
      sel, top: Math.round(b.top), bottom: Math.round(b.bottom), h: Math.round(b.height),
      pos: cs.position, padB: cs.paddingBottom, ovf: cs.overflowY,
    };
  };
  const boxes = ['.topbar', '.inbox-page', '.tabbar', '.chat-thread-head',
    '.chat-thread-body', '.chat-foot', '.composer'].map(box).filter(Boolean);
  const doc = document.documentElement;
  const foot = document.querySelector('.chat-foot');
  const tab = document.querySelector('.tabbar');
  const corpo = document.querySelector('.chat-thread-body');
  const fb = foot ? foot.getBoundingClientRect() : null;
  const tb = tab ? tab.getBoundingClientRect() : null;
  const fbRect = document.querySelector('.composer')?.getBoundingClientRect();
  return {
    vh: innerHeight,
    chatVh: getComputedStyle(document.querySelector('.inbox-page')).getPropertyValue('--chat-vh').trim(),
    docScrollH: doc.scrollHeight,
    docClientH: doc.clientHeight,
    docRola: doc.scrollHeight - doc.clientHeight,
    scrollX: doc.scrollWidth - doc.clientWidth,
    boxes,
    somaAltura: boxes.filter((b) => ['.topbar', '.inbox-page', '.tabbar'].includes(b.sel))
      .reduce((t, b) => t + b.h, 0),
    // Faixa entre o fim do COMPOSER e o topo da tabbar: se for > 0 e menor que a
    // tabbar, existe banda morta entre os dois.
    bandaEntreComposerETabbar: fbRect && tb ? Math.round(tb.top - fbRect.bottom) : null,
    // Faixa entre o fim do FOOT e o topo da tabbar (o padding do foot).
    bandaAteTabbar: fb && tb ? Math.round(tb.top - fb.bottom) : null,
    corpo: corpo ? {
      scrollHeight: corpo.scrollHeight, clientHeight: corpo.clientHeight,
      overscroll: getComputedStyle(corpo).overscrollBehaviorY,
    } : null,
  };
`;

async function run() {
  const server = await startServer();
  const a = new Client(server.baseUrl);
  const aUser = await a.register({ username: randomUsername('a') });
  const b = new Client(server.baseUrl);
  const bUser = await b.register({ username: randomUsername('b') });
  const conv = await a.post('/api/conversations', { userId: bUser.id });
  const id = conv.body.conversationId;

  for (let i = 0; i < 16; i += 1) {
    await a.post(`/api/conversations/${id}/messages`, {
      type: 'text', body: `Mensagem ${i} com texto suficiente para ocupar espaco de verdade.`,
    });
    await b.post(`/api/conversations/${id}/messages`, { type: 'text', body: `Resposta ${i} do outro lado.` });
  }
  const audio = await makeTestAudio({ seconds: 5 });
  const up = await a.upload('/api/media/upload?purpose=audio', audio.buffer, {
    filename: audio.filename, mime: audio.mime,
  });
  await a.post(`/api/conversations/${id}/messages`, { type: 'audio', body: '', mediaId: up.body.media.id });

  const cookies = await fetch(`${server.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: aUser.username, password: 'Senha@Teste123' }),
  }).then((r) => r.headers.getSetCookie());

  const browser = await launchChrome({ extraArgs: ['--autoplay-policy=no-user-gesture-required'] });
  const s = await browser.newBrowserContext();
  s.watch();

  try {
    for (const [w, h] of CELULARES) {
      await s.goto(`${server.baseUrl}/`, { waitMs: 300 });
      if (w === 320) {
        for (const ck of cookies) {
          const par = ck.split(';')[0];
          const nome = par.slice(0, par.indexOf('='));
          await s.send('Network.setCookie', {
            name: nome, value: decodeURIComponent(par.slice(nome.length + 1)), domain: '127.0.0.1', path: '/',
          });
        }
      }
      await s.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: true });
      await s.goto(`${server.baseUrl}/inbox/${id}`, { waitMs: 2600 });
      await s.eval(APLICAR_SAFE_AREA);
      await sleep(1800);

      const m = await s.eval(MEDIR);

      // (A) a altura da cadeia tem de fechar com a viewport
      if (Math.abs(m.somaAltura - m.vh) > 1) {
        throw new Error(`${w}x${h}: a altura nao fecha - topbar+pagina+tabbar = ${m.somaAltura}px, viewport ${m.vh}px`);
      }
      // (B) nenhuma BANDA MORTA entre o composer e a tabbar. Um respiro de ate
      // 10px e projeto (o padding da barra); o defeito eram 34px, ou seja, a
      // safe-area contada duas vezes. O que nao pode acontecer e uma faixa sem
      // dono, entao a faixa e tambem testada com `elementFromPoint`.
      if (m.bandaEntreComposerETabbar > 10) {
        throw new Error(`${w}x${h}: ${m.bandaEntreComposerETabbar}px sem dono entre o composer e a tabbar`);
      }
      if (m.bandaAteTabbar > 10) {
        throw new Error(`${w}x${h}: ${m.bandaAteTabbar}px de folga no fim da barra de mensagens`);
      }
      const donoDaBanda = await s.eval(`
        const f = document.querySelector('.chat-foot').getBoundingClientRect();
        const t = document.querySelector('.tabbar').getBoundingClientRect();
        if (f.bottom >= t.top) return 'encostado';
        const n = document.elementFromPoint(Math.round(innerWidth / 2), Math.round((f.bottom + t.top) / 2));
        return n ? (typeof n.className === 'string' && n.className ? n.className.split(' ')[0] : n.tagName.toLowerCase()) : 'NENHUM';
      `);
      if (donoDaBanda === 'NENHUM') {
        throw new Error(`${w}x${h}: ha uma faixa sem nenhum elemento entre o composer e a tabbar`);
      }
      if (m.docRola > 1) {
        throw new Error(`${w}x${h}: o documento rola ${m.docRola}px (algo esta maior que a viewport)`);
      }
      if (m.scrollX > 1) throw new Error(`${w}x${h}: scroll horizontal de ${m.scrollX}px`);
      if (!m.corpo || m.corpo.scrollHeight <= m.corpo.clientHeight) {
        throw new Error(`${w}x${h}: o corpo das mensagens nao tem rolagem propria`);
      }
      if (!/contain/.test(m.corpo.overscroll)) {
        throw new Error(`${w}x${h}: overscroll-behavior do corpo e "${m.corpo.overscroll}" (esperado contain)`);
      }

      // (C) o gesto: percorre a lista inteira e confere que nada aparece
      const gesto = await s.eval(`
        const corpo = document.querySelector('.chat-thread-body');
        const dono = (y) => {
          const n = document.elementFromPoint(Math.round(innerWidth / 2), y);
          return n ? (n.className && typeof n.className === 'string' ? n.className.split(' ')[0] : n.tagName.toLowerCase()) : null;
        };
        const medirBanda = () => {
          const f = document.querySelector('.chat-foot').getBoundingClientRect();
          const t = document.querySelector('.tabbar').getBoundingClientRect();
          const y = Math.round((f.bottom + t.top) / 2);
          // A faixa e medida entre o COMPOSER e a tabbar, nao entre o foot e a
          // tabbar: o padding da barra e respiro de projeto.
          const c = document.querySelector('.composer').getBoundingClientRect();
          const meio = Math.round((c.bottom + t.top) / 2);
          return {
            y: meio,
            largura: Math.round(t.top - c.bottom),
            dono: c.bottom < t.top ? dono(meio) : 'encostado',
          };
        };
        const out = { passos: [] };
        for (const alvo of ['topo', 'meio', 'fim']) {
          corpo.scrollTop = alvo === 'topo' ? 0 : alvo === 'meio' ? corpo.scrollHeight / 2 : corpo.scrollHeight;
          await new Promise((r) => setTimeout(r, 320));
          out.passos.push({ alvo, scrollTop: Math.round(corpo.scrollTop), banda: medirBanda() });
        }
        // Arrasto rapido para baixo no fim (o caso do rubber-band):
        corpo.scrollTop = 0;
        await new Promise((r) => setTimeout(r, 250));
        const antes = document.documentElement.scrollTop;
        document.documentElement.scrollTop = 500;
        await new Promise((r) => setTimeout(r, 250));
        out.documentoRolou = document.documentElement.scrollTop;
        document.documentElement.scrollTop = antes;
        return out;
      `);
      for (const passo of gesto.passos) {
        if (passo.banda.dono === 'encostado') continue;
        // A faixa pertence a barra de mensagens (respiro de projeto) ou e
        // pequena demais para ser o defeito. O que nao pode e faixa sem dono.
        if (passo.banda.dono === 'NENHUM' && passo.banda.largura > 10) {
          throw new Error(`${w}x${h}: com a lista em "${passo.alvo}" apareceu ${passo.banda.largura}px `
            + `sem nenhum elemento (y=${passo.banda.y})`);
        }
      }
      if (gesto.documentoRolou > 0) {
        throw new Error(`${w}x${h}: o documento rolou ${gesto.documentoRolou}px no arrasto (fundo revelavel)`);
      }

      // (D) e (E) TECLADO DE VERDADE: o `visualViewport` e encolhido e o
      // evento `resize` disparado - que e EXATAMENTE o caminho que o teclado
      // virtual executa no celular. Nao se injeta `--chat-vh` na mao: o app o
      // reescreve a cada evento (comportamento correto), entao a injecao seria
      // apagada antes de ser medida.
      const tecladoAntes = await s.eval(`
        const alvo = document.querySelector('.composer textarea, .composer input');
        if (!alvo) return { erro: 'sem campo' };
        if (!window.visualViewport) return { erro: 'sem visualViewport' };
        const vv = window.visualViewport;
        window.__vvReal = vv.height;
        // Altura com 38% da tela coberta pelo teclado.
        Object.defineProperty(vv, 'height', {
          configurable: true,
          get: () => Math.round(window.__vvReal * 0.62),
        });
        vv.dispatchEvent(new Event('resize'));
        return { antes: window.__vvReal };
      `);
      if (tecladoAntes.erro) throw new Error(`${w}x${h}: ${tecladoAntes.erro}`);

      await sleep(800);
      // Com o teclado aberto a referencia NAO e `innerHeight` (o layout
      // viewport continua com a altura toda): e a area VISIVEL. Comparar com
      // `innerHeight` acusaria um espaco que o usuario nao ve.
      const comTeclado = await s.eval(`
        const page = document.querySelector('.inbox-page');
        const tab = document.querySelector('.tabbar');
        const foot = document.querySelector('.composer');
        const corpo = document.querySelector('.chat-thread-body');
        const doc = document.documentElement;
        const baseVisivel = window.visualViewport
          ? Math.round(window.visualViewport.height - window.visualViewport.offsetTop)
          : innerHeight;
        return {
          baseVisivel,
          vh: innerHeight,
          chatVh: getComputedStyle(page).getPropertyValue('--chat-vh').trim(),
          paginaH: Math.round(page.getBoundingClientRect().height),
          docRola: doc.scrollHeight - doc.clientHeight,
          scrollX: doc.scrollWidth - doc.clientWidth,
          topoDaTabbar: Math.round(tab.getBoundingClientRect().top),
          fimDaTabbar: Math.round(tab.getBoundingClientRect().bottom),
          fimDoComposer: Math.round(foot.getBoundingClientRect().bottom),
          corpoH: Math.round(corpo.getBoundingClientRect().height),
        };
      `);
      if (comTeclado.chatVh === `${h}px`) {
        throw new Error(`${w}x${h}: o app nao acompanhou a viewport reduzir (--chat-vh continua ${comTeclado.chatVh})`);
      }
      if (comTeclado.docRola > 1) {
        throw new Error(`${w}x${h}: com o teclado aberto o documento rola ${comTeclado.docRola}px `
          + '(e por isso o arrasto revela o fundo preto)');
      }
      // Nada pode passar da area visivel. A tabbar PUDE ficar abaixo do limite
      // visivel - e normal, o teclado cobre essa faixa. O que nao pode e o
      // composer sumir atras do teclado ou aparecer uma faixa sem dono no
      // que ainda da para ver.
      if (comTeclado.fimDoComposer > comTeclado.baseVisivel + 1) {
        throw new Error(`${w}x${h}: o composer fica ${comTeclado.fimDoComposer - comTeclado.baseVisivel}px `
          + 'abaixo do limite visivel (atras do teclado)');
      }
      const faixaVazia = await s.eval(`
        const base = window.visualViewport
          ? Math.round(window.visualViewport.height - window.visualViewport.offsetTop) : innerHeight;
        const vazios = [];
        // Varre a coluna central em cima da area VISIVEL: cada pixel precisa ter
        // um elemento por tras (e nao o fundo solto da pagina).
        for (let y = 1; y < base; y += 3) {
          const n = document.elementFromPoint(Math.round(innerWidth / 2), y);
          if (!n) { vazios.push(y); continue; }
          const nome = typeof n.className === 'string' && n.className
            ? n.className.split(' ')[0] : n.tagName.toLowerCase();
          // body/html no ponto significa que o pixel pertence ao fundo da
          // pagina, e nao a nenhuma camada da interface.
          if (nome === 'body' || nome === 'html') vazios.push(y);
        }
        return { total: vazios.length, exemplos: vazios.slice(0, 5), base };
      `);
      if (faixaVazia.total > 0) {
        throw new Error(`${w}x${h}: ${faixaVazia.total} pontos da area visivel (ate ${faixaVazia.base}px) `
          + `sem nenhum elemento da interface, o que aparece como fundo vazio: y=${faixaVazia.exemplos.join(',')}`);
      }
      // E o espaco entre o composer e a tabbar, mas SO dentro da area
      // visivel: com o teclado aberto a tabbar fica presa ao fundo do layout
      // viewport (640px), ou seja, ATRAS do teclado. Essa faixa nao e vazia
      // vista pelo usuario - e a propria faixa do teclado.
      const tabbarVisivel = comTeclado.topoDaTabbar < comTeclado.baseVisivel;
      const bandaTeclado = tabbarVisivel
        ? comTeclado.topoDaTabbar - comTeclado.fimDoComposer
        : 0;
      if (bandaTeclado > 10) {
        throw new Error(`${w}x${h}: com o teclado surgiram ${bandaTeclado}px sem dono `
          + 'entre o composer e a tabbar');
      }
      // A area de mensagens tem de encolher de verdade: o alvo e menos de
      // 75% da area ANTERIOR, porque encolher "um pouco" nao resolve o teclado.
      const corpoAntes = m.corpo.clientHeight;
      if (comTeclado.corpoH > corpoAntes * 0.75) {
        throw new Error(`${w}x${h}: a area de mensagens nao encolheu com o teclado `
          + `(${corpoAntes}px -> ${comTeclado.corpoH}px, --chat-vh=${comTeclado.chatVh}, `
          + `pagina=${comTeclado.paginaH}px)`);
      }

      // (E) FECHAR o teclado: volta ao valor real, sem altura antiga guardada.
      await s.eval(`
        const vv = window.visualViewport;
        Object.defineProperty(vv, 'height', { configurable: true, get: () => window.__vvReal });
        document.querySelector('.composer textarea, .composer input')?.blur();
        vv.dispatchEvent(new Event('resize'));
        return true;
      `);
      await sleep(800);
      const depois = await s.eval(MEDIR);
      if (depois.chatVh !== `${h}px`) {
        throw new Error(`${w}x${h}: ao fechar o teclado ficou uma altura antiga (--chat-vh = ${depois.chatVh}, esperado ${h}px)`);
      }
      if (Math.abs(depois.somaAltura - depois.vh) > 1) {
        throw new Error(`${w}x${h}: ao fechar o teclado a altura nao voltou (${depois.somaAltura} vs ${depois.vh})`);
      }
      if (depois.docRola > 1) throw new Error(`${w}x${h}: apos fechar o teclado o documento rola ${depois.docRola}px`);

      report.ok(`${w}x${h}: cadeia fecha em ${depois.somaAltura}px (viewport ${depois.vh}), sem banda morta, `
        + `rolagem de ${depois.corpo.scrollHeight}px em ${depois.corpo.clientHeight}px; `
        + `com teclado a area caiu para ${comTeclado.corpoH}px e --chat-vh foi a ${comTeclado.chatVh} `
        + `sem documento rolar; ao fechar voltou a ${depois.chatVh}`);
    }
  } catch (error) {
    report.fail('verificacao do viewport do chat interrompida', error);
  } finally {
    try { s.close?.(); } catch { /* ignore */ }
    await browser.close();
    await server.stop();
  }
  return report.summary();
}

run().then((r) => process.exit(r.failed > 0 ? 1 : 0)).catch((e) => { console.error(e); process.exit(1); });
