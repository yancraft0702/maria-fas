/**
 * Verificacao das telas de autenticacao (item 3), cadastro (5),
 * recuperacao sem token (6) e chat global (29) - desktop e mobile.
 */
import { startServer, Client, Report, randomUsername } from '../tests/helpers.mjs';
import { launchChrome } from '../tests/cdp.mjs';

const report = new Report('Telas de autenticacao e chat global');
const server = await startServer();

// Conta para o chat global ter mensagens.
const c = new Client(server.baseUrl);
const eu = await c.register({ username: randomUsername('ana') });
for (const body of ['Oi pessoal!', 'Alguem ai?', 'Bora fazer uma LIVE', 'Primeiro!']) {
  await c.post('/api/chat/global', { type: 'text', body });
}

const browser = await launchChrome();

async function sessao(width, height, { usuario = null } = {}) {
  // Sempre um contexto isolado: sem isso a sessao criada por um passo
  // contamina o passo seguinte.
  const s = await browser.newBrowserContext();
  s.watch();
  await s.goto(`${server.baseUrl}/`, { waitMs: 300 });
  if (usuario) {
    const r = await fetch(`${server.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: usuario.username, password: 'Senha@Teste123' }),
    });
    for (const ck of r.headers.getSetCookie()) {
      const [pair] = ck.split(';'); const [n, v] = pair.split('=');
      await s.send('Network.setCookie', { name: n, value: decodeURIComponent(v), domain: '127.0.0.1', path: '/' });
    }
  }
  await s.send('Network.setCacheDisabled', { cacheDisabled: true });
  await s.eval(`
    const regs = await navigator.serviceWorker.getRegistrations();
    for (const r of regs) await r.unregister();
    const keys = await caches.keys();
    for (const k of keys) await caches.delete(k);
    return true;
  `).catch(() => {});
  await s.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 768 });
  return s;
}

// ---------------------------------------------------------------- item 3
for (const [plataforma, w, h] of [['desktop', 1440, 900], ['mobile', 390, 844]]) {
  await report.step(`${plataforma}: /entrar e /cadastro sem NENHUM layout do app`, async () => {
    const s = await sessao(w, h);
    const problemas = [];
    for (const rota of ['/entrar', '/cadastro', '/recuperar-senha']) {
      await s.goto(`${server.baseUrl}${rota}`, { waitMs: 2200 });
      const r = await s.eval(`
        const visivel = (sel) => { const n = document.querySelector(sel); if (!n) return false;
          const cs = getComputedStyle(n); const b = n.getBoundingClientRect();
          return cs.display !== 'none' && cs.visibility !== 'hidden' && b.width > 0 && b.height > 0; };
        const card = document.querySelector('.auth-card')?.getBoundingClientRect();
        return {
          card: Boolean(document.querySelector('.auth-card')),
          coracao: Boolean(document.querySelector('.brand-heart')),
          palavra: document.querySelector('.brand-wordmark')?.textContent || null,
          arte: Boolean(document.querySelector('.auth-page-art')),
          subtitulo: document.querySelector('.auth-subtitle')?.textContent || null,
          sidebar: visivel('.sidebar'),
          topbar: visivel('.topbar'),
          tabbar: visivel('.tabbar'),
          voltar: visivel('#btn-back'),
          sino: visivel('#topbar-actions'),
          brandSidebar: visivel('.sidebar .brand'),
          cardCentro: card ? Math.abs((card.left + card.right) / 2 - innerWidth / 2) < 40 : false,
          scrollW: document.documentElement.scrollWidth, vw: document.documentElement.clientWidth,
        };
      `);
      if (!r.card) problemas.push(`${rota}: sem cartao`);
      if (r.sidebar) problemas.push(`${rota}: sidebar visivel`);
      if (r.topbar) problemas.push(`${rota}: topbar visivel`);
      if (r.tabbar) problemas.push(`${rota}: tabbar visivel`);
      if (r.voltar) problemas.push(`${rota}: botao de voltar visivel`);
      if (r.sino) problemas.push(`${rota}: icones do topo visiveis`);
      if (r.brandSidebar) problemas.push(`${rota}: marca do sidebar visivel`);
      if (!r.coracao) problemas.push(`${rota}: sem coracao`);
      if (r.palavra !== 'MARIA FÃS') problemas.push(`${rota}: wordmark "${r.palavra}"`);
      if (!r.arte) problemas.push(`${rota}: sem efeito decorativo`);
      if (!r.subtitulo) problemas.push(`${rota}: sem subtitulo`);
      if (!r.cardCentro) problemas.push(`${rota}: cartao fora do centro`);
      if (r.scrollW > r.vw + 1) problemas.push(`${rota}: overflow ${r.scrollW}>${r.vw}`);
    }
    if (problemas.length) throw new Error(problemas.join(' | '));
    return `3 rotas limpas em ${w}px: sem sidebar/topbar/tabbar/voltar/sino, cartao central com coracao, "MARIA FÃS", subtitulo e brilho decorativo`;
  });
}

// ---------------------------------------------------------------- item 5
await report.step('cadastro real cria a conta, faz sessao e mostra o motivo do erro', async () => {
  const s = await sessao(1440, 900);
  await s.goto(`${server.baseUrl}/cadastro`, { waitMs: 2000 });

  // 1) usuario curto -> erro de campo, nao "Dados invalidos"
  const curto = await s.eval(`
    document.querySelector('#reg-user').value = 'ab';
    document.querySelector('#reg-pass').value = 'Marcos0702@#/7';
    document.querySelector('#reg-pass2').value = 'Marcos0702@#/7';
    document.querySelector('.auth-card form').requestSubmit();
    await new Promise((x) => setTimeout(x, 1500));
    const e = document.querySelector('.auth-error');
    return { msg: e && !e.hidden ? e.textContent : null, url: location.pathname };
  `);
  if (!curto.msg) throw new Error('sem mensagem de erro para usuario curto');
  if (/Dados invalidos/i.test(curto.msg)) throw new Error(`erro generico: "${curto.msg}"`);
  if (/curto|3|24|caracter/i.test(curto.msg) === false) throw new Error(`mensagem nao explica o usuario: "${curto.msg}"`);

  // 2) senha curta -> erro de campo
  const senhaCurta = await s.eval(`
    document.querySelector('#reg-user').value = 'kim';
    document.querySelector('#reg-pass').value = 'abc';
    document.querySelector('#reg-pass2').value = 'abc';
    document.querySelector('.auth-card form').requestSubmit();
    await new Promise((x) => setTimeout(x, 1500));
    const e = document.querySelector('.auth-error');
    return e && !e.hidden ? e.textContent : null;
  `);
  if (!senhaCurta || /Dados invalidos/i.test(senhaCurta)) throw new Error(`senha curta: "${senhaCurta}"`);

  // 3) senhas diferentes -> erro local
  const diferentes = await s.eval(`
    document.querySelector('#reg-user').value = 'kim';
    document.querySelector('#reg-pass').value = 'Marcos0702@#/7';
    document.querySelector('#reg-pass2').value = 'Marcos0702@#/8';
    document.querySelector('.auth-card form').requestSubmit();
    await new Promise((x) => setTimeout(x, 800));
    const e = document.querySelector('.auth-error');
    return e && !e.hidden ? e.textContent : null;
  `);
  if (!/coincidem|conferem/i.test(diferentes || '')) throw new Error(`senhas diferentes: "${diferentes}"`);

  // 4) usuario duplicado -> erro do servidor.
  //     `kim` precisa existir de verdade: ate aqui nada foi criado, porque as
  //     tres tentativas acima pararam na validacao.
  await new Client(server.baseUrl).post('/api/auth/register', {
    username: 'kim', password: 'Marcos0702@#/7',
  });
  const dup = await s.eval(`
    document.querySelector('#reg-user').value = 'kim';
    document.querySelector('#reg-pass').value = 'Marcos0702@#/7';
    document.querySelector('#reg-pass2').value = 'Marcos0702@#/7';
    document.querySelector('.auth-card form').requestSubmit();
    await new Promise((x) => setTimeout(x, 1800));
    const e = document.querySelector('.auth-error');
    return e && !e.hidden ? e.textContent : null;
  `);
  if (!dup || /ja (esta|existe)|em uso/i.test(dup) === false) throw new Error(`duplicado: "${dup}"`);

  // 5) cadastro valido cria sessao
  const novo = randomUsername('kim');
  const ok = await s.eval(`
    document.querySelector('#reg-user').value = ${JSON.stringify(novo)};
    document.querySelector('#reg-pass').value = 'Marcos0702@#/7';
    document.querySelector('#reg-pass2').value = 'Marcos0702@#/7';
    document.querySelector('.auth-card form').requestSubmit();
    await new Promise((x) => setTimeout(x, 3000));
    const e = document.querySelector('.auth-error');
    return {
      url: location.pathname,
      erro: e && !e.hidden ? e.textContent : null,
      sidebar: document.querySelectorAll('#side-nav a').length,
      sessao: (await (await fetch('/api/auth/me', { credentials: 'include' })).json()).authenticated === true,
    };
  `);
  if (ok.erro) throw new Error(`cadastro valido falhou: ${ok.erro}`);
  if (!ok.sessao) throw new Error('cadastro nao criou sessao');
  if (ok.sidebar < 3) throw new Error('app nao montou apos o cadastro');

  // 6) login com a conta recem-criada
  const entrada = await sessao(1440, 900);
  await entrada.goto(`${server.baseUrl}/entrar`, { waitMs: 2000 });
  const login = await entrada.eval(`
    document.querySelector('#login-identifier').value = ${JSON.stringify(novo)};
    document.querySelector('#login-password').value = 'Marcos0702@#/7';
    document.querySelector('.auth-card form').requestSubmit();
    await new Promise((x) => setTimeout(x, 2800));
    return { url: location.pathname, card: Boolean(document.querySelector('.auth-card')) };
  `);
  if (login.card) throw new Error('login nao saiu da tela de entrada');

  return `erros claros (curto: "${curto.msg}" | senha: "${senhaCurta}" | diferentes: "${diferentes}" | dup: "${dup}") e cadastro+login de "${novo}" funcionando`;
});

// ---------------------------------------------------------------- item 6
await report.step('recuperacao nunca mostra token e informa a situacao real', async () => {
  const s = await sessao(1440, 900);
  await s.goto(`${server.baseUrl}/recuperar-senha`, { waitMs: 2000 });
  const r = await s.eval(`
    document.querySelector('#forgot-identifier').value = ${JSON.stringify(eu.username)};
    document.querySelector('.auth-card form').requestSubmit();
    await new Promise((x) => setTimeout(x, 2000));
    const nota = document.querySelector('.auth-note');
    const texto = document.getElementById('main').innerText;
    return {
      nota: nota ? nota.textContent : null,
      classe: nota ? nota.className : null,
      temTokenVisivel: /codigo de teste|devToken|c[0-9a-f]{16,}/i.test(texto),
      texto: texto.slice(0, 200),
    };
  `);
  if (!r.nota) throw new Error('sem aviso apos solicitar recuperacao');
  if (r.temTokenVisivel) throw new Error(`token visivel na tela: ${r.texto}`);

  // A API tambem nao devolve token.
  const api = await new Client(server.baseUrl).post('/api/auth/forgot-password', { identifier: eu.username });
  const corpo = JSON.stringify(api.body);
  if (/devToken|"token"/i.test(corpo)) throw new Error(`a API devolveu credencial: ${corpo}`);
  if (api.status !== 202) throw new Error(`HTTP ${api.status}`);

  return `sem token na tela nem na API; aviso = "${r.nota}" (classe ${r.classe})`;
});

// ---------------------------------------------------------------- item 7
await report.step('login pede so Usuario e Senha, sem texto de email', async () => {
  const s = await sessao(390, 844);
  await s.goto(`${server.baseUrl}/entrar`, { waitMs: 2000 });
  const r = await s.eval(`
    const campos = [...document.querySelectorAll('.auth-card input:not([hidden])')].map((i) => i.type);
    const rotulos = [...document.querySelectorAll('.auth-card label')].map((l) => l.textContent.replace(':', '').trim());
    const texto = document.querySelector('.auth-card').innerText;
    return {
      campos, rotulos,
      temEmail: campos.includes('email') || rotulos.some((l) => /email/i.test(l)),
      textoContraditorio: /@usuario ou seu email|ou seu email/i.test(texto),
      botao: [...document.querySelectorAll('.auth-card button')].map((b) => b.textContent.trim()),
    };
  `);
  if (r.temEmail) throw new Error(`ainda pede email: campos=${r.campos} rotulos=${r.rotulos}`);
  if (r.textoContraditorio) throw new Error('texto contraditorio sobre email na tela');
  if (!r.campos.includes('password')) throw new Error('sem campo de senha');
  if (r.campos.length !== 2) throw new Error(`esperava 2 campos, veio ${r.campos.length}`);
  return `campos ${JSON.stringify(r.campos)}, rotulos ${r.rotulos.join(' + ')}`;
});

// ---------------------------------------------------------------- item 29
for (const [plataforma, w, h] of [['desktop', 1440, 900], ['mobile', 390, 844]]) {
  await report.step(`${plataforma}: chat global proporcional, sem area vazia e campo visivel`, async () => {
    const s = await sessao(w, h, { usuario: eu });
    await s.goto(`${server.baseUrl}/chat-global`, { waitMs: 2500 });
    const r = await s.eval(`
      const tab = document.querySelector('#tabbar');
      const tabVisivel = tab && getComputedStyle(tab).display !== 'none';
      const rt = tabVisivel ? tab.getBoundingClientRect() : null;
      const chat = document.querySelector('.global-chat');
      const feed = document.querySelector('.global-feed');
      const foot = document.querySelector('.chat-foot');
      const campo = document.querySelector('.composer textarea, .composer input');
      const cr = chat?.getBoundingClientRect();
      const fr = feed?.getBoundingClientRect();
      const cor = campo?.getBoundingClientRect();
      const che = (n) => n ? getComputedStyle(n).display !== 'none' : false;
      return {
        alturaUtil: cr ? Math.round(cr.height) : 0,
        alturaJanela: innerHeight,
        alturaFeed: fr ? Math.round(fr.height) : 0,
        mensagens: document.querySelectorAll('.gc-msg').length,
        campoVisivel: cor ? cor.width > 0 && cor.bottom <= innerHeight + 1 && cor.top >= 0 : false,
        campoForaDaTab: rt && cor ? cor.bottom <= rt.top + 1 : true,
        cabecalho: che(document.querySelector('.global-chat .row')),
        scrollW: document.documentElement.scrollWidth, vw: document.documentElement.clientWidth,
      };
    `);
    if (r.mensagens < 4) throw new Error(`apenas ${r.mensagens} mensagem(ns)`);
    if (!r.campoVisivel) throw new Error('campo de mensagem fora da tela');
    if (!r.campoForaDaTab) throw new Error('campo coberto pela tabbar');
    // A area vazia e o que sobra: o chat deve ocupar a altura util.
    const sobra = r.alturaJanela - r.alturaUtil;
    if (r.alturaUtil < r.alturaJanela * 0.75) throw new Error(`chat ocupa so ${r.alturaUtil}px de ${r.alturaJanela}px`);
    if (sobra > 130) throw new Error(`${sobra}px de espaco vazio abaixo do chat`);
    if (r.scrollW > r.vw + 1) throw new Error(`overflow ${r.scrollW}>${r.vw}`);
    if (!r.cabecalho) throw new Error('sem cabecalho');
    return `${r.mensagens} mensagens, altura ${r.alturaUtil}/${r.alturaJanela}px (sobra ${sobra}px), campo visivel e acima da tabbar`;
  });
}

const resumo = report.summary();
await browser.close();
await server.stop();
process.exit(resumo.failed > 0 ? 1 : 0);