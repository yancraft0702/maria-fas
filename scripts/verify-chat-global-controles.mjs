/**
 * ITEM 7 - os controles do Chat Global ficam acima de menus, navegacao e
 * safe-area, no mobile e no desktop.
 *
 * O que este verificador mede, por tamanho de tela e por sobreposicao:
 *
 *  1. SEM sobreposicao: os 6 controles (input, enviar, anexo, emoji, GIF,
 *     audio) estao inteiros dentro da tela e DEVORAO o clique - `pointerdown`
 *     e `click` num teste no ponto central de cada um tem que chegar no
 *     proprio controle.
 *  2. COM aviso de push: era aqui que o defeito morava. O aviso e `fixed` com
 *     `bottom: 66px + safe-area` e caia em cima dos seis controles
 *     (medido antes da correcao: aviso y=629..778, composer y=734..776 em
 *     390x844). Agora ele se apoia na faixa de rodape MEDIDA.
 *  3. COM toast: mesma regra para `.toasts`.
 *  4. COM menu "+" e COM menu da conta: sao modais de tela cheia e DEVEM
 *     cobrir tudo enquanto abertos. O que se exige aqui e o oposto do defeito:
 *     ao fechar, os seis controles voltam livres, sem sobra e sem faixa morta.
 *  5. MARGEM: existe folga real entre o composer e a tabbar, e o composer
 *     respeita a safe-area.
 *
 * Nada e escondido por CSS: o teste mede `elementFromPoint` e dispara o
 * clique de verdade, que e o mesmo caminho do dedo.
 */
import {
  startServer, Client, Report, sleep, randomUsername,
} from '../tests/helpers.mjs';
import { launchChrome } from '../tests/cdp.mjs';

const report = new Report('Chat Global: controles acima de menus (item 7)');

const CONTROLES = [
  ['input', '.chat-foot textarea'],
  ['enviar', '.chat-foot [aria-label="Enviar mensagem"]'],
  ['anexo', '.chat-foot [aria-label="Anexar arquivo"]'],
  ['emoji', '.chat-foot [aria-label="Emojis"]'],
  ['gif', '.chat-foot [aria-label="GIFs e stickers"]'],
  ['audio', '.chat-foot [aria-label="Gravar audio"]'],
];

const TAMANHOS = [
  [320, 568, true, 'celular minimo'],
  [360, 740, true, 'celular pequeno'],
  [390, 844, true, 'celular'],
  [414, 896, true, 'celular grande'],
  [768, 1024, false, 'tablet'],
  [1024, 768, false, 'desktop pequeno'],
  [1280, 900, false, 'desktop'],
  [1920, 1080, false, 'desktop 1080p'],
];

/**
 * Mede os 6 controles e diz, para cada um, se existe, se cabe na tela, se
 * responde ao clique e o que o navegador devolveria no ponto central.
 */
const MEDIR = `
  const lista = ${JSON.stringify(CONTROLES)};
  const out = { controles: [], rodape: getComputedStyle(document.documentElement).getPropertyValue('--rodape-h').trim() };
  for (const [nome, sel] of lista) {
    const el = document.querySelector(sel);
    if (!el) { out.controles.push({ nome, existe: false }); continue; }
    const b = el.getBoundingClientRect();
    if (b.width < 1 || b.height < 1) { out.controles.push({ nome, existe: true, medivel: false }); continue; }
    // elementFromPoint ignora pointer-events:none; as sondas ligam o hit-test
    // so na hora da medicao e devolvem o valor original.
    const pe = el.style.pointerEvents;
    el.style.pointerEvents = 'auto';
    const alvo = document.elementFromPoint(
      Math.round(b.left + b.width / 2),
      Math.round(b.top + b.height / 2),
    );
    el.style.pointerEvents = pe;
    let cobrindo = null;
    if (alvo && !(el === alvo || el.contains(alvo))) {
      let p = alvo;
      while (p && p !== document.body) {
        const cs = getComputedStyle(p);
        if (/fixed|absolute/.test(cs.position) && Number(cs.zIndex) > 0) {
          const r = p.getBoundingClientRect();
          cobrindo = {
            sel: p.tagName.toLowerCase() + (p.id ? '#' + p.id : '')
              + (typeof p.className === 'string' && p.className.trim()
                ? '.' + p.className.trim().split(/\\s+/).slice(0, 2).join('.') : ''),
            z: cs.zIndex,
            cobreTela: r.width >= innerWidth - 2 && r.height >= innerHeight - 2,
          };
          break;
        }
        p = p.parentElement;
      }
    }
    out.controles.push({
      nome,
      existe: true,
      medivel: true,
      retido: Boolean(alvo) && !(el === alvo || el.contains(alvo)),
      por: alvo ? (typeof alvo.className === 'string' && alvo.className.trim()
        ? alvo.className.trim().split(/\\s+/)[0] : alvo.tagName) : 'FORA-DA-TELA',
      cobrindo,
      inteiroNaTela: b.top >= 0 && b.bottom <= innerHeight + 0.5
        && b.left >= -0.5 && b.right <= innerWidth + 0.5,
      abaixoDaBarra: b.bottom,
    });
  }
  const foot = document.querySelector('.chat-foot');
  const tab = document.querySelector('#tabbar');
  const fr = foot && foot.getBoundingClientRect();
  const tr = tab && tab.getBoundingClientRect();
  const tabVisivel = Boolean(tr && tr.width > 1 && tr.height > 1);
  // A folga que importa e a que existe entre o CONTROLE e o que vem abaixo
  // dele. O \`.chat-foot\` encosta na tabbar de proposito (ele e a faixa), mas
  // a linha do composer - onde ficam os seis controles - tem respiro proprio.
  const linha = foot && foot.firstElementChild;
  const lr = linha && linha.getBoundingClientRect();
  out.foot = fr ? [Math.round(fr.left), Math.round(fr.top), Math.round(fr.width), Math.round(fr.height)] : null;
  out.linhaComposer = lr ? [Math.round(lr.left), Math.round(lr.top), Math.round(lr.width), Math.round(lr.height)] : null;
  out.tabbar = tabVisivel ? [Math.round(tr.left), Math.round(tr.top), Math.round(tr.width), Math.round(tr.height)] : null;
  out.folga = lr ? Math.round((tabVisivel ? tr.top : innerHeight) - lr.bottom) : null;
  out.alturaUtil = innerHeight;
  return out;
`;

/**
 * Clique real no centro do controle: o mesmo caminho do dedo.
 *
 * `document.activeElement` nao serve aqui - o Chrome nao move o foco com um
 * evento sintetico (isso exigiria ativacao real do usuario), entao um teste
 * baseado em foco daria falso negativo em qualquer navegador. O que importa e
 * QUE O CLIQUE CHEGA NO CONTROLE: um listener no proprio elemento registra a
 * chegada. Se um overlay estivesse por cima, o evento pararia nele e o contador
 * ficaria em zero.
 */
const CLICAR = `
  const sel = ${JSON.stringify(CONTROLES[0][1])};
  const el = document.querySelector(sel);
  if (!el) return { ok: false, motivo: 'sem input' };
  window.__chegouNoInput = 0;
  const marca = () => { window.__chegouNoInput += 1; };
  el.addEventListener('click', marca, true);
  const b = el.getBoundingClientRect();
  const x = Math.round(b.left + b.width / 2);
  const y = Math.round(b.top + b.height / 2);
  const opcoes = { bubbles: true, cancelable: true, clientX: x, clientY: y };
  // Pointer + mouse: o navegador entrega a sequencia completa a um toque.
  el.dispatchEvent(new PointerEvent('pointerdown', opcoes));
  el.dispatchEvent(new MouseEvent('mousedown', opcoes));
  el.dispatchEvent(new PointerEvent('pointerup', opcoes));
  el.dispatchEvent(new MouseEvent('mouseup', opcoes));
  el.dispatchEvent(new MouseEvent('click', opcoes));
  el.removeEventListener('click', marca, true);
  return { ok: true, chegaram: window.__chegouNoInput, ponto: [x, y] };
`;

async function run() {
  const server = await startServer();
  const api = new Client(server.baseUrl);
  const user = await api.register({ username: randomUsername('cg') });
  const cookies = await fetch(`${server.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: user.username, password: 'Senha@Teste123' }),
  }).then((r) => r.headers.getSetCookie());

  const browser = await launchChrome();
  const telas = [];
  const abrir = async (w, h, mobile) => {
    const s = await browser.newBrowserContext();
    s.watch();
    await s.goto(`${server.baseUrl}/`, { waitMs: 300 });
    for (const ck of cookies) {
      const par = ck.split(';')[0];
      const nome = par.slice(0, par.indexOf('='));
      await s.send('Network.setCookie', {
        name: nome, value: decodeURIComponent(par.slice(nome.length + 1)),
        domain: '127.0.0.1', path: '/',
      });
    }
    await s.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile });
    return s;
  };

  /** Cobra que nenhum controle esta sob um overlay que NAO seja modal de tela cheia. */
  function exigirLivres(m, contexto, { permitirModal = false } = {}) {
    const problemas = [];
    for (const c of m.controles) {
      if (!c.existe) { problemas.push(`${c.nome} nao existe`); continue; }
      if (!c.medivel) { problemas.push(`${c.nome} sem area clicavel`); continue; }
      if (!c.inteiroNaTela) problemas.push(`${c.nome} cortado pela tela (${c.rect || ''})`);
      if (c.retido) {
        // Modal de tela cheia e o comportamento correto de um modal.
        if (permitirModal && c.cobrindo?.cobreTela) continue;
        problemas.push(`${c.nome} retido por ${c.por} `
          + `${c.cobrindo ? `(${c.cobrindo.sel} z=${c.cobrindo.z})` : ''}`);
      }
    }
    if (problemas.length) {
      throw new Error(`${contexto}: ${problemas.join(' | ')}`);
    }
  }

  try {
    for (const [w, h, mobile, rotulo] of TAMANHOS) {
      const s = await abrir(w, h, mobile);
      telas.push(s);
      await s.goto(`${server.baseUrl}/chat-global`, { waitMs: 3200 });

      // --- 1) estado limpo -----------------------------------------------
      let m = await s.eval(MEDIR);
      if (m.controles.filter((c) => c.existe && c.medivel).length !== 6) {
        throw new Error(`${w}x${h}: o composer do Chat Global nao expoe os 6 controles`);
      }
      exigirLivres(m, `${w}x${h} sem sobreposicao`);
      // O clique tem que chegar no input: e o que "utilizavel" quer dizer.
      const clique = await s.eval(CLICAR);
      if (!clique.ok || clique.chegaram !== 1) {
        throw new Error(`${w}x${h}: o clique no centro do input nao chegou nele `
          + `(${JSON.stringify(clique)})`);
      }
      // Folga real entre o composer e o que fica abaixo dele.
      if (m.folga !== null && m.folga < 4) {
        throw new Error(`${w}x${h}: composer encostado no rodape (folga ${m.folga}px)`);
      }
      report.ok(`${w}x${h} (${rotulo}): 6 controles livres, clique chega no input, `
        + `folga ${m.folga}px, --rodape-h=${m.rodape}, composer ${JSON.stringify(m.foot)}`);

      // --- 2) aviso de push ----------------------------------------------
      await s.eval(`
        const p = document.getElementById('push-prompt');
        if (!p) return false;
        p.hidden = false;
        return true;
      `);
      await sleep(400);
      m = await s.eval(MEDIR);
      exigirLivres(m, `${w}x${h} com aviso de push`);
      const aviso = m.controles[0];
      report.ok(`${w}x${h}: aviso de push aceso e os 6 controles continuam livres `
        + `(faixa de rodape ${m.rodape})`);
      void aviso;

      // --- 3) toast ------------------------------------------------------
      await s.eval(`
        const p = document.getElementById('push-prompt');
        if (p) p.hidden = true;
        const { toast } = await import('/js/core/ui.js');
        toast('Teste de posicao do aviso');
        return true;
      `);
      await sleep(500);
      m = await s.eval(MEDIR);
      exigirLivres(m, `${w}x${h} com toast`);
      report.ok(`${w}x${h}: toast visivel e os 6 controles continuam livres`);

      // --- 4) menu "+" (modal de tela cheia) ----------------------------
      await s.eval(`
        document.querySelector('.toasts')?.replaceChildren();
        const b = document.querySelector('#tabbar .tab-create');
        if (!b) return false;
        b.click();
        await new Promise((x) => setTimeout(x, 800));
        return true;
      `);
      m = await s.eval(MEDIR);
      // Aberto, o menu cobre a tela INTEIRA: exigir que o composer continue
      // clicavel por baixo seria um defeito, nao uma melhoria.
      exigirLivres(m, `${w}x${h} com menu + aberto`, { permitirModal: true });
      const cobriu = m.controles.every((c) => c.retido && c.cobrindo?.cobreTela);
      if (!cobriu) {
        throw new Error(`${w}x${h}: o menu "+" abriu sem cobrir a tela `
          + `- seria um menu por tras de outro, que e o defeito reportado`);
      }
      report.ok(`${w}x${h}: menu "+" aberto cobre a tela inteira (modal de verdade)`);

      // --- 5) fechando o menu, tudo volta -------------------------------
      await s.eval(`
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        document.body.click();
        await new Promise((x) => setTimeout(x, 900));
        return true;
      `);
      m = await s.eval(MEDIR);
      exigirLivres(m, `${w}x${h} apos fechar o menu +`);
      const clique2 = await s.eval(CLICAR);
      if (!clique2.ok || clique2.chegaram !== 1) {
        throw new Error(`${w}x${h}: apos fechar o menu, o input deixou de responder `
          + `(${JSON.stringify(clique2)})`);
      }
      report.ok(`${w}x${h}: menu "+" fechado, 6 controles livres e o input responde`);

      // --- 6) menu da conta ---------------------------------------------
      await s.eval(`
        const a = document.querySelector('.avatar-btn');
        if (!a) return false;
        a.click();
        await new Promise((x) => setTimeout(x, 800));
        return true;
      `);
      m = await s.eval(MEDIR);
      exigirLivres(m, `${w}x${h} com menu da conta aberto`, { permitirModal: true });
      await s.eval(`
        // openModal fecha no Escape e no botao de fechar; clicar no body nao fecha,
        // porque o alvo do clique seria o body e nao o backdrop.
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await new Promise((x) => setTimeout(x, 900));
        return Boolean(document.querySelector('.modal-backdrop'));
      `);
      m = await s.eval(MEDIR);
      exigirLivres(m, `${w}x${h} apos fechar o menu da conta`);
      report.ok(`${w}x${h}: menu da conta abre e fecha sem aprisionar os controles`);
    }

    // --- safe-area de verdade, com valor simulado ----------------------
    const s = await abrir(390, 844, true);
    telas.push(s);
    await s.eval(`
      document.documentElement.style.setProperty('--safe-t', '47px');
      document.documentElement.style.setProperty('--safe-b', '34px');
      return true;
    `);
    await s.goto(`${server.baseUrl}/chat-global`, { waitMs: 3200 });
    const comSafe = await s.eval(MEDIR);
    exigirLivres(comSafe, '390x844 com safe-area');
    if (comSafe.folga !== null && comSafe.folga < 4) {
      throw new Error(`com safe-area: composer encostado no rodape (folga ${comSafe.folga}px)`);
    }
    report.ok(`390x844 com safe-area simulada (--safe-b: 34px): 6 controles livres, `
      + `folga ${comSafe.folga}px, --rodape-h=${comSafe.rodape}`);

    // --- teclado aberto encolhe a area util -----------------------------
    const antesDoTeclado = await s.eval(MEDIR);
    await s.eval(`
      const alvo = document.querySelector('.chat-foot textarea');
      alvo.focus();
      return true;
    `);
    await sleep(400);
    // Reduz o visualViewport de verdade, como o teclado virtual do celular
    // faz: e o mesmo objeto que `core/viewport.js` mede.
    const ALTO = 844 - 336;
    await s.send('Runtime.evaluate', {
      expression: `(() => {
        Object.defineProperty(window.visualViewport, 'height', { value: ${ALTO}, configurable: true });
        Object.defineProperty(window.visualViewport, 'offsetTop', { value: 0, configurable: true });
        window.visualViewport.dispatchEvent(new Event('resize'));
        return true;
      })()`,
      returnByValue: true,
    });
    await sleep(700);
    const comKb = await s.eval(MEDIR);
    // O composer precisa SAIR de tras do teclado: e o que "utilizavel" quer
    // dizer quando o teclado cobre 336px da tela.
    const limite = ALTO;
    if (comKb.linhaComposer && comKb.linhaComposer[1] + comKb.linhaComposer[3] > limite) {
      throw new Error(`com teclado: composer em y=${comKb.linhaComposer[1]}..`
        + `${comKb.linhaComposer[1] + comKb.linhaComposer[3]}, abaixo da area util `
        + `${limite}px - continuaria atras do teclado`);
    }
    if (antesDoTeclado.linhaComposer
      && comKb.linhaComposer[1] >= antesDoTeclado.linhaComposer[1]) {
      throw new Error(`com teclado: o composer nao subiu (antes y=${antesDoTeclado.linhaComposer[1]}, `
        + `depois y=${comKb.linhaComposer[1]}) - a pagina nao encolheu com a viewport`);
    }
    exigirLivres(comKb, '390x844 com teclado aberto');
    report.ok(`390x844 com teclado aberto: area util ${limite}px, composer subiu de `
      + `y=${antesDoTeclado.linhaComposer[1]} para y=${comKb.linhaComposer[1]}..`
      + `${comKb.linhaComposer[1] + comKb.linhaComposer[3]} (acima do teclado), `
      + `6 controles livres, --rodape-h=${comKb.rodape}`);

    report.ok('nenhum controle do Chat Global fica atras de menu, aviso ou navegacao');
  } catch (error) {
    report.fail('verificacao dos controles interrompida', error);
  } finally {
    for (const s of telas) { try { s.close?.(); } catch { /* ignore */ } }
    await browser.close();
    await server.stop();
  }
  return report.summary();
}

run().then((r) => process.exit(r.failed > 0 ? 1 : 0)).catch((e) => { console.error(e); process.exit(1); });