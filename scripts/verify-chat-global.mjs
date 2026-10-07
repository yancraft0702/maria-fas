/**
 * Verificador dos itens 1 e 29 - CHAT GLOBAL no topo e controles visiveis.
 *
 * Item 1: existe um botao de Chat Global no topo do site, ao lado do avatar,
 *         que leva direto para `/chat-global`, funciona no desktop e no
 *         mobile, respeita a safe-area e nao fica atras de nada.
 * Item 29: TODOS os controles inferiores do Chat Global (campo, enviar, anexo,
 *         midia, emoji, GIF, figurinha, audio, reacoes, resposta) estao
 *         VISIVEIS de verdade - medidos com `elementFromPoint`, que e o que
 *         diz quem esta NA FRENTE - e acima da bottom navigation.
 *
 * "Visivel" aqui nao e "existe no DOM": um botao coberto pela bottom nav
 * (ou por um menu) passa em qualquer checagem de presenca e falha nesta.
 */
import {
  startServer, Client, Report, sleep, randomUsername,
} from '../tests/helpers.mjs';
import { launchChrome } from '../tests/cdp.mjs';

const report = new Report('Chat Global no topo e controles visiveis (itens 1 e 29)');

// O terceiro elemento e o flag `mobile` do Emulation.setDeviceMetricsOverride.
// Sem ele o CDP recusa a chamada com "Invalid parameters (-32602)".
const CELULARES = [[320, 640, true], [360, 780, true], [390, 844, true], [414, 896, true]];
const DESKTOP = [[1024, 900, false], [1280, 900, false], [1440, 900, false], [1920, 1080, false]];

/** Aplica a sessao e o tamanho, com a safe-area de um iPhone injetada. */
async function comSessao(s, baseUrl, cookies, w, h, mobile) {
  await s.goto(`${baseUrl}/`, { waitMs: 300 });
  for (const ck of cookies) {
    const par = ck.split(';')[0];
    const nome = par.slice(0, par.indexOf('='));
    await s.send('Network.setCookie', {
      name: nome, value: decodeURIComponent(par.slice(nome.length + 1)),
      domain: '127.0.0.1', path: '/',
    });
  }
  await s.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile });
}

/**
 * Mede a barra de mensagens do Chat Global: cada controle precisa estar dentro
 * da tela, com alvo tocavel e COMO DONO no ponto do seu centro.
 */
const MEDIR_CONTROLES = `
  const foot = document.querySelector('.chat-page .chat-foot, .global-chat .chat-foot');
  if (!foot) return { erro: 'sem barra de mensagens' };
  const composer = foot.querySelector('.composer');
  const tabbar = document.querySelector('.tabbar');
  const topo = document.querySelector('.topbar');
  const doc = document.documentElement;
  const safeB = parseFloat(getComputedStyle(doc).getPropertyValue('--safe-b')) || 0;

  const alvos = [...foot.querySelectorAll('button, textarea, input, [contenteditable="true"]')];
  const medidos = alvos.map((n) => {
    const b = n.getBoundingClientRect();
    const cx = Math.round(b.left + b.width / 2);
    const cy = Math.round(b.top + b.height / 2);
    const naFrente = (cx >= 0 && cx < innerWidth && cy >= 0 && cy < innerHeight)
      ? document.elementFromPoint(cx, cy) : null;
    const dono = naFrente
      ? (typeof naFrente.className === 'string' && naFrente.className
        ? naFrente.className.split(' ')[0] : naFrente.tagName.toLowerCase())
      : 'FORA-DA-TELA';
    // Em <svg>, className e SVGAnimatedString (objeto), nao texto: sem este
    // tratamento o nome saia como "[object Object]".
    // O controle esta coberto quando quem esta na frente NAO e ele nem um
    // descendente dele.
    const contido = naFrente
      && (naFrente === n || n.contains(naFrente)
        || (naFrente.contains && naFrente.contains(n)));
    const coberto = !naFrente || !contido;
    return {
      rotulo: n.getAttribute('aria-label') || n.className || n.tagName.toLowerCase(),
      box: [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)],
      alvo: Math.round(Math.min(b.width, b.height)),
      dentroDaTela: b.top >= 0 && b.left >= 0 && b.bottom <= innerHeight + 1 && b.right <= innerWidth + 1,
      coberto,
      dono,
    };
  });

  const fb = foot.getBoundingClientRect();
  // A partir de 1024px a bottom navigation some (a sidebar assume). Medir a
  // caixa de um elemento com display:none daria 0 e faria o teste acusar um
  // "abaixo da tabbar" inexistente.
  const tabbarVisivel = Boolean(tabbar) && getComputedStyle(tabbar).display !== 'none'
    && tabbar.getBoundingClientRect().height > 0;
  const tb = tabbarVisivel ? tabbar.getBoundingClientRect() : null;
  return {
    medidos,
    foot: { top: Math.round(fb.top), bottom: Math.round(fb.bottom), h: Math.round(fb.height) },
    composerBottom: composer ? Math.round(composer.getBoundingClientRect().bottom) : null,
    tabbarTop: tb ? Math.round(tb.top) : null,
    topoBottom: topo ? Math.round(topo.getBoundingClientRect().bottom) : null,
    safeB,
    chatVh: getComputedStyle(document.querySelector('.chat-page') || doc).getPropertyValue('--chat-vh').trim(),
    docRola: doc.scrollHeight - doc.clientHeight,
    scrollX: doc.scrollWidth - doc.clientWidth,
  };
`;

async function run() {
  const server = await startServer();
  const api = new Client(server.baseUrl);
  const host = await api.register({ username: randomUsername('chat') });
  const outro = await api.register({ username: randomUsername('outro') });

  // Conversa global com conteudo real, para a tela nao ficar vazia.
  for (let i = 0; i < 4; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await api.post('/api/chat/global', { body: `Mensagem global ${i} para a tela ter conteudo.` });
  }

  const cookies = await fetch(`${server.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: host.username, password: 'Senha@Teste123' }),
  }).then((r) => r.headers.getSetCookie());
  void outro;

  const browser = await launchChrome({ extraArgs: ['--autoplay-policy=no-user-gesture-required'] });
  const s = await browser.newBrowserContext();
  s.watch();

  try {
    // ---------------- ITEM 1: o botao existe no topo e leva ao chat --------
    for (const [w, h, mobile] of [...CELULARES, ...DESKTOP]) {
      await comSessao(s, server.baseUrl, cookies, w, h, mobile);
      await s.goto(`${server.baseUrl}/`, { waitMs: 2600 });

      let botao;
      try {
        botao = await s.eval(`
        const topo = document.getElementById('topbar');
        const b = topo && topo.querySelector('.chat-global-btn');
        if (!b) return { erro: 'sem botao de chat global no topo' };
        const bbb = b.getBoundingClientRect();
        const avatar = topo.querySelector('.avatar-btn');
        const ab = avatar ? avatar.getBoundingClientRect() : null;
        const cx = Math.round(bbb.left + bbb.width / 2);
        const cy = Math.round(bbb.top + bbb.height / 2);
        const naFrente = document.elementFromPoint(cx, cy);
        return {
          href: b.getAttribute('href'),
          aria: b.getAttribute('aria-label'),
          icone: Boolean(b.querySelector('svg')),
          box: [Math.round(bbb.left), Math.round(bbb.top), Math.round(bbb.width), Math.round(bbb.height)],
          dentroDoTopbar: Boolean(topo.contains(b)),
          // Ao lado do avatar: nao no canto oposto nem em cima dele.
          ladoDoAvatar: ab ? Math.abs((bbb.left + bbb.right) / 2 - (ab.left + ab.right) / 2) : null,
          naFrente: naFrente
            ? (typeof naFrente.className === 'string' && naFrente.className
              ? naFrente.className.split(' ')[0] : naFrente.tagName.toLowerCase())
            : 'FORA-DA-TELA',
          coberto: !naFrente || !(naFrente === b || b.contains(naFrente)),
          zTopbar: getComputedStyle(topo).zIndex,
          topoDaTela: Math.round(topo.getBoundingClientRect().top),
          // Safe-area: o cabecalho tem de incluir a margem superior.
          safeT: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--safe-t')) || 0,
          alturaTopbar: Math.round(topo.getBoundingClientRect().height),
          scrollX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        };
      `);
      } catch (err) {
        throw new Error(`${w}x${h} ao MEDIR o botao do topo: ${err.message}`);
      }
      if (botao.erro) throw new Error(`${w}x${h}: ${botao.erro}`);
      if (botao.href !== '/chat-global') throw new Error(`${w}x${h}: href "${botao.href}"`);
      if (!botao.icone) throw new Error(`${w}x${h}: o botao do Chat Global esta sem icone`);
      if (!botao.aria) throw new Error(`${w}x${h}: o botao do Chat Global nao tem aria-label`);
      if (botao.coberto) {
        throw new Error(`${w}x${h}: o botao do Chat Global esta ATRAS de "${botao.naFrente}"`);
      }
      if (botao.topoDaTela !== 0) throw new Error(`${w}x${h}: o topo comecou em ${botao.topoDaTela}px`);
      // A altura do cabecalho precisa cobrir a safe-area, senao o botao fica
      // sob a barra do sistema no celular.
      const alturaEsperada = 52 + botao.safeT;
      if (Math.abs(botao.alturaTopbar - alturaEsperada) > 2) {
        throw new Error(`${w}x${h}: o cabecalho mede ${botao.alturaTopbar}px e deveria medir `
          + `${alturaEsperada}px (52 + safe-area ${botao.safeT}px)`);
      }
      if (botao.ladoDoAvatar !== null && botao.ladoDoAvatar > 140) {
        throw new Error(`${w}x${h}: o botao do Chat Global esta a ${botao.ladoDoAvatar}px do avatar `
          + '(nao esta "ao lado" como pedido)');
      }
      if (botao.scrollX > 1) throw new Error(`${w}x${h}: scroll horizontal ao adicionar o botao`);
      report.ok(`item 1 - ${w}x${h} (${mobile ? 'mobile' : 'desktop'}): botao em `
        + `${botao.box.join(',')} dentro do topo (h=${botao.alturaTopbar}px = 52 + safe-area `
        + `${botao.safeT}px), icone presente, na frente de "${botao.naFrente}", `
        + `${botao.ladoDoAvatar === null ? 'sem avatar para comparar' : `${botao.ladoDoAvatar}px do avatar`}`);

      // Clicar abre o chat global de verdade.
      await s.eval(`
        document.querySelector('#topbar .chat-global-btn').click();
        return true;
      `);
      await sleep(2200);
      const abriu = await s.eval(`
        return {
          url: location.pathname,
          temChat: Boolean(document.querySelector('.chat-page .global-feed, .global-chat .global-feed')),
          temComposer: Boolean(document.querySelector('.chat-page .composer')),
          titulo: (document.querySelector('.chat-page h1, .chat-page h2, .chat-head h1, .global-chat h1')?.textContent || '').trim(),
        };
      `);
      if (abriu.url !== '/chat-global') throw new Error(`${w}x${h}: o clique abriu ${abriu.url}`);
      if (!abriu.temChat || !abriu.temComposer) {
        throw new Error(`${w}x${h}: o chat global abriu sem feed ou sem composer `
          + `(${JSON.stringify(abriu)})`);
      }

      // ---------------- ITEM 29: os controles estao visiveis? --------------
      await s.eval(`
        const r = document.documentElement.style;
        r.setProperty('--safe-t', '47px');
        r.setProperty('--safe-b', '34px');
        return true;
      `);
      await sleep(900);

      let medido;
      try {
        medido = await s.eval(MEDIR_CONTROLES);
      } catch (err) {
        throw new Error(`${w}x${h} ao MEDIR os controles: ${err.message}`);
      }
      if (medido.erro) throw new Error(`${w}x${h}: ${medido.erro}`);
      if (!medido.medidos.length) throw new Error(`${w}x${h}: a barra de mensagens nao tem controle nenhum`);

      const escondidos = medido.medidos.filter((c) => c.coberto || !c.dentroDaTela);
      if (escondidos.length) {
        throw new Error(`${w}x${h}: ${escondidos.length} controle(s) do Chat Global fora de vista - `
          + escondidos.map((c) => `${c.rotulo} [${c.box.join(',')}] dono="${c.dono}"`).join(' | '));
      }
      const pequenos = medido.medidos.filter((c) => c.alvo < 24);
      if (pequenos.length) {
        throw new Error(`${w}x${h}: ${pequenos.length} controle(s) com alvo abaixo de 24px - `
          + pequenos.map((c) => `${c.rotulo}=${c.alvo}px`).join(', '));
      }
      // Nenhum controle pode ficar ABAIXO da bottom navigation: e o sintoma
      // "os botoes ficam escondidos atras dos botoes do menu".
      if (medido.tabbarTop !== null && medido.composerBottom > medido.tabbarTop) {
        throw new Error(`${w}x${h}: a barra de mensagens termina em ${medido.composerBottom}px, `
          + `ABAIXO da bottom nav (${medido.tabbarTop}px) - e por isso que os botoes sumiam`);
      }
      if (medido.docRola > 1) throw new Error(`${w}x${h}: o documento rola ${medido.docRola}px`);
      if (medido.scrollX > 1) throw new Error(`${w}x${h}: scroll horizontal de ${medido.scrollX}px`);

      // O espaco entre o composer e a tabbar tem que ter dono.
      const banda = medido.tabbarTop !== null && medido.composerBottom < medido.tabbarTop
        ? medido.tabbarTop - medido.composerBottom : 0;
      if (banda > 10) {
        throw new Error(`${w}x${h}: ${banda}px sem dono entre a barra de mensagens e a bottom nav`);
      }
      report.ok(`item 29 - ${w}x${h}: ${medido.medidos.length} controles do Chat Global todos `
        + `visiveis e na frente (menor alvo ${Math.min(...medido.medidos.map((c) => c.alvo))}px) - `
        + `${medido.medidos.map((c) => c.rotulo).join(', ')}; `
        + `composer em ${medido.composerBottom}px e bottom nav em ${medido.tabbarTop}px, `
        + `sem banda morta e sem documento rolando`);
    }

    // O Inbox privado continua existindo e separado do Chat Global.
    await comSessao(s, server.baseUrl, cookies, 390, 844, true);
    await s.goto(`${server.baseUrl}/inbox`, { waitMs: 2400 });
    const inbox = await s.eval(`
      const texto = document.body.innerText || '';
      return {
        listaPresente: Boolean(document.querySelector('.chat-list')),
        titulo: texto.includes('Inbox'),
        temLinkGlobal: Boolean(document.querySelector('a[href="/chat-global"]')),
      };
    `);
    if (!inbox.listaPresente || !inbox.titulo) {
      throw new Error(`o Inbox privado foi afetado (${JSON.stringify(inbox)})`);
    }
    report.ok('o Inbox privado continua intacto e separado do Chat Global');

    report.ok('Chat Global acessivel pelo topo e com todos os controles visiveis');
  } catch (error) {
    report.fail('verificacao do Chat Global interrompida', error);
    console.error('STACK:', error && error.stack);
    console.error('CODIGO:', error && error.code, 'STATUS:', error && error.status,
      'URL:', error && error.url);
  } finally {
    try { s.close?.(); } catch { /* ignore */ }
    await browser.close();
    await server.stop();
  }
  return report.summary();
}

run().then((r) => process.exit(r.failed > 0 ? 1 : 0)).catch((e) => { console.error(e); process.exit(1); });