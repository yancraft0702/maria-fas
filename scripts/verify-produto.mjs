/**
 * Verificacao funcional no Chrome real, em DESKTOP e MOBILE.
 *
 * Cobre os itens desta rodada: guarda de login, logo/coracao, busca compacta,
 * 5 icones removidos, publicacao no PC, audio e mute real, botao de musica
 * removido, feed (troca de abas), perfil (foto/capa), notificacoes, push,
 * LIVE, GIPHY e底部 nav.
 */
import { startServer, Client, Report, makeTestVideo, makeTestImage, randomUsername, waitUntil, sleep } from '../tests/helpers.mjs';
import { launchChrome } from '../tests/cdp.mjs';

const report = new Report('Verificacao de produto (desktop + mobile)');
const server = await startServer();

const author = new Client(server.baseUrl);
const eu = await author.register({ username: randomUsername('ana') });
const video = await makeTestVideo({ seconds: 2, width: 480, height: 854, withAudio: true });
const up = await author.upload('/api/media/upload?purpose=video', video.buffer, {
  filename: video.filename, mime: video.mime,
});
await waitUntil(async () => {
  const { body } = await author.get(`/api/media/${up.body.media.id}/status`);
  return body.media.status === 'ready' ? body.media : null;
}, { timeoutMs: 120000, intervalMs: 800 });
await author.post('/api/posts', { type: 'video', mediaId: up.body.media.id, caption: 'video real #produto' });
for (let i = 0; i < 5; i += 1) await author.post('/api/posts', { type: 'text', caption: `texto ${i}` });

// Conversa com mensagens (chat).
const outro = new Client(server.baseUrl);
const amigo = await outro.register({ username: randomUsername('bruno') });
const conv = await author.post('/api/conversations', { userId: amigo.id });
for (const texto of ['Oi! Tudo bem?', 'Vi seu ultimo video', 'Bora fazer uma LIVE?', 'Manda ver!']) {
  await author.post(`/api/conversations/${conv.body.conversationId}/messages`, { body: texto });
}

const browser = await launchChrome();

/** Prepara uma sessao (com cookie) e um tamanho de tela. */
async function sessao(width, height, { autenticado = true, usuario = null } = {}) {
  const conta = usuario || eu;
  const s = autenticado ? await browser.newPage() : await browser.newBrowserContext();
  s.watch();
  await s.goto(`${server.baseUrl}/`, { waitMs: 300 });
  if (autenticado) {
    const r = await fetch(`${server.baseUrl}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: conta.username, password: 'Senha@Teste123' }),
    });
    for (const c of r.headers.getSetCookie()) {
      const [pair] = c.split(';'); const [n, v] = pair.split('=');
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

const MOBILE = [390, 844];
const DESKTOP = [1440, 900];

try {
  // ------------------------------------------- 4) LOGIN OBRIGATORIO
  await report.step('sem sessao, toda URL privada vai para /entrar (frontend)', async () => {
    const s = await sessao(1280, 900, { autenticado: false });
    const alvos = ['/', '/perfil', '/busca', '/explorar', '/ao-vivo', '/inbox', '/notificacoes', '/criar', '/configuracoes', '/iniciar-live'];
    const resultados = [];
    for (const alvo of alvos) {
      await s.goto(`${server.baseUrl}${alvo}`, { waitMs: 300 });
      await s.waitForFunction('return Boolean(document.querySelector(".auth-card")) || location.pathname !== "/entrar";', 8000);
      const r = await s.eval(`
        return { path: location.pathname, temLogin: Boolean(document.querySelector('.auth-card')), temSidebar: document.querySelectorAll('#side-nav a').length };
      `);
      resultados.push(`${alvo} -> ${r.path}${r.temLogin ? ' (login)' : ' !! SEM LOGIN !!'}`);
      if (r.path !== '/entrar' || !r.temLogin) throw new Error(`${alvo} nao foi para o login: ${JSON.stringify(r)}`);
      if (r.temSidebar !== 0) throw new Error(`${alvo} mostrou navegacao privada sem sessao`);
    }
    return `${alvos.length} URLs redirecionadas; ${resultados[0]}; ${resultados[alvos.length - 1]}`;
  });

  await report.step('login volta para a pagina que o usuario tentou acessar', async () => {
    const s = await sessao(1280, 900, { autenticado: false });
    await s.goto(`${server.baseUrl}/perfil?x=1`, { waitMs: 300 });
    await s.waitForFunction('return Boolean(document.querySelector(".auth-card"));', 8000);
    const antes = await s.eval('return location.pathname + location.search;');
    if (!antes.startsWith('/entrar')) throw new Error(`sem sessao abriu ${antes}`);
    const redirect = await s.eval('return new URLSearchParams(location.search).get("redirect");');
    await s.eval(`
      document.querySelector('#login-identifier').value = ${JSON.stringify(eu.username)};
      document.querySelector('#login-password').value = 'Senha@Teste123';
      document.querySelector('.auth-card form').requestSubmit();
      return true;
    `);
    await sleep(2500);
    const depois = await s.eval('return location.pathname;');
    if (depois !== '/perfil') throw new Error(`apos o login foi para ${depois} (redirect=${redirect})`);
    const logado = await s.eval('return document.querySelectorAll("#side-nav a").length;');
    return `redirect=${redirect} -> ${depois}, sidebar com ${logado} itens`;
  });

  // ------------------------------------------- 2/27) LOGO CORACAO
  for (const [nome, w, h] of [['desktop', ...DESKTOP], ['mobile', ...MOBILE]]) {
    const s = await sessao(w, h);
    await report.step(`coracao da marca no ${nome} (sem a letra P)`, async () => {
      await s.goto(`${server.baseUrl}/`, { waitMs: 1500 });
      const info = await s.eval(`
        const visivel = (n) => n && getComputedStyle(n).display !== 'none' && n.getBoundingClientRect().width > 0;
        const coracoes = [...document.querySelectorAll('.heart-logo')].filter(visivel);
        const temPLetra = [...document.querySelectorAll('.brand-mark, .brand-text')]
          .some((n) => /^[A-Z]$/.test(n.textContent.trim()));
        return {
          coracoes: coracoes.length,
          corpo: Boolean(document.querySelector('.heart-logo .heart-body')),
          temPLetra,
          titulo: document.title,
        };
      `);
      if (!info.coracoes) throw new Error('nenhum coracao da marca visivel');
      if (!info.corpo) throw new Error('o coracao sem preenchimento');
      if (info.temPLetra) throw new Error('ainda aparece a letra P como logo');
      if (!info.titulo.includes('MARIA FÃS')) throw new Error(`titulo "${info.titulo}"`);
      return `${info.coracoes} coracao(oes) visivel(is), sem letra P`;
    });
  }

  // ------------------------------------------- 9/10) MUSICA E MUTE
  for (const [nome, w, h] of [['desktop', ...DESKTOP], ['mobile', ...MOBILE]]) {
    const s = await sessao(w, h);
    await report.step(`${nome}: sem botao de musica e mute com estado real do video`, async () => {
      await s.goto(`${server.baseUrl}/`, { waitMs: 2500 });
      // Vai ate o slide que tem video, como o usuario faria.
      const achou = await s.eval(`
        const slides = [...document.querySelectorAll('.slide')];
        return slides.findIndex((x) => x.querySelector('video'));
      `);
      if (achou < 0) throw new Error('nenhum slide com video');
      for (let i = 0; i < achou; i += 1) {
        await s.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
        await s.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
        await sleep(420);
      }
      const r = await s.waitForFunction(`
        const slide = document.querySelector('.slide.active');
        const v = slide?.querySelector('video');
        if (!v || v.readyState < 2) return null;
        const acoes = [...slide.querySelectorAll('.act')];
        return {
          temMusica: acoes.some((b) => (b.getAttribute('aria-label') || '').toLowerCase().includes('som do post') || b.querySelector('svg')?.classList.contains('music')),
          rotulos: acoes.map((b) => b.getAttribute('aria-label')),
          sound: slide.querySelector('.act-sound')?.dataset.sound || null,
          muted: v.muted,
          corOn: slide.querySelector('.act-sound') ? getComputedStyle(slide.querySelector('.act-sound')).color : null,
        };
      `, 20000);
      if (r.temMusica) throw new Error(`ainda ha botao de musica: ${r.rotulos.join(' | ')}`);
      if (!r.sound) throw new Error('sem botao de som');
      if (r.sound !== (r.muted ? 'off' : 'on')) throw new Error(`estado visual "${r.sound}" x video.muted=${r.muted}`);

      // Clica e confere que o estado deriva do video real.
      const depois = await s.eval(`
        const slide = document.querySelector('.slide.active');
        const v = slide.querySelector('video');
        const btn = slide.querySelector('.act-sound');
        const antes = { muted: v.muted, estado: btn.dataset.sound, rotulo: btn.getAttribute('aria-label') };
        btn.click();
        await new Promise((r) => setTimeout(r, 400));
        const meio = { muted: v.muted, estado: btn.dataset.sound, rotulo: btn.getAttribute('aria-label') };
        btn.click();
        await new Promise((r) => setTimeout(r, 400));
        const fim = { muted: v.muted, estado: btn.dataset.sound, rotulo: btn.getAttribute('aria-label') };
        return { antes, meio, fim };
      `);
      if (depois.meio.muted === depois.antes.muted) throw new Error('o clique nao mudou video.muted');
      if (depois.meio.estado === depois.antes.estado) throw new Error('o botao nao mudou de estado visual');
      if (depois.fim.muted !== depois.antes.muted) throw new Error('o segundo clique nao voltou');
      if (depois.fim.estado !== depois.antes.estado) throw new Error('o estado visual nao voltou');
      return `mutido("${depois.antes.estado}") -> com audio("${depois.meio.estado}") -> mutido("${depois.fim.estado}"), sempre acompanhando video.muted`;
    });
  }

  // ------------------------------------------- 8/18) ICONES
  for (const [nome, w, h] of [['desktop', ...DESKTOP], ['mobile', ...MOBILE]]) {
    const s = await sessao(w, h);
    await report.step(`${nome}: sem os 5 icones redundantes e com busca compacta`, async () => {
      await s.goto(`${server.baseUrl}/`, { waitMs: 1500 });
      const info = await s.eval(`
        return {
          rail: document.querySelectorAll('.rail').length,
          barraBusca: Boolean(document.querySelector('#search-form')),
          abas: [...document.querySelectorAll('.feed-tabs [role="tab"]')].map((t) => t.textContent.trim()),
          lupa: Boolean(document.querySelector('.feed-tabs .feed-search-btn')),
          topbar: document.querySelectorAll('#topbar-actions .icon-btn').length,
        };
      `);
      if (info.rail !== 0) throw new Error('rail de 5 icones de volta');
      if (info.barraBusca) throw new Error('barra de busca grande de volta');
      if (info.abas.length !== 3) throw new Error(`abas: ${info.abas.join(', ')}`);
      if (!info.lupa) throw new Error('sem lupa nas abas');
      return `abas ${info.abas.join(' / ')} + lupa; ${info.topbar} icone(s) no topo; sem barra grande`;
    });
  }

  // ------------------------------------------- 19) BUSCA
  for (const [nome, w, h] of [['desktop', ...DESKTOP], ['mobile', ...MOBILE]]) {
    const s = await sessao(w, h);
    await report.step(`${nome}: a lupa abre a busca e traz pessoas/hashtags/sons`, async () => {
      await s.goto(`${server.baseUrl}/`, { waitMs: 1500 });
      await s.eval('document.querySelector(".feed-tabs .feed-search-btn").click(); return true;');
      await sleep(1600);
      const abriu = await s.eval(`
        return {
          path: location.pathname,
          temInput: Boolean(document.querySelector('#main input[type="search"], #main input')),
          texto: document.getElementById('main').innerText.slice(0, 60),
        };
      `);
      if (abriu.path !== '/busca') throw new Error(`foi para ${abriu.path}`);
      if (!abriu.temInput) throw new Error('sem campo de busca');
      if (/undefined/.test(abriu.texto)) throw new Error('tela de busca renderizou "undefined"');

      await s.eval(`
        const input = document.querySelector('#main input');
        input.value = 'ana';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      `);
      await sleep(2200);
      const achou = await s.eval(`
        return {
          resultados: document.querySelectorAll('#main .list-item, #main .seg button, #main a[href^="/@"]').length,
          texto: document.getElementById('main').innerText.slice(0, 120),
        };
      `);
      if (!achou.resultados) throw new Error(`busca "ana" sem resultados: ${achou.texto}`);
      return `abriu ${abriu.path}, "ana" devolveu ${achou.resultados} resultado(s)`;
    });
  }

  // ------------------------------------------- 11) PUBLICAR NO PC
  await report.step('desktop tem entrada clara para publicar e abre o editor existente', async () => {
    const s = await sessao(...DESKTOP);
    await s.goto(`${server.baseUrl}/`, { waitMs: 1500 });
    const link = await s.eval(`
      const a = [...document.querySelectorAll('#side-nav .side-create')][0];
      if (!a) return null;
      const r = a.getBoundingClientRect();
      return { texto: (a.innerText || '').trim(), w: Math.round(r.width), h: Math.round(r.height), visivel: r.width > 0 };
    `);
    if (!link) throw new Error('sem "Publicar" na navegacao do PC');
    if (link.h < 40) throw new Error(`botao pequeno: ${link.h}px`);
    // Item 9: o "Publicar" da sidebar abre o menu de criacao (mesmo do "+").
    await s.eval(`
      document.querySelector('#side-nav .side-create').click();
      return true;
    `);
    await sleep(700);
    const menu = await s.eval(`
      const itens = [...document.querySelectorAll('.modal .create-menu-item .create-menu-label')]
        .map((n) => n.textContent.trim());
      return { itens, aberto: Boolean(document.querySelector('.modal')) };
    `);
    if (!menu.aberto) throw new Error('o menu de criacao nao abriu');
    for (const esperado of ['Postar video', 'Postar foto', 'Texto', 'Iniciar LIVE']) {
      if (!menu.itens.includes(esperado)) {
        throw new Error(`menu sem "${esperado}" (${menu.itens.join(', ')})`);
      }
    }
    // E o item "Postar video" leva ao editor existente.
    await s.eval(`
      document.querySelector('.modal [data-create="video"]').click();
      return true;
    `);
    const noEditor = await s.waitForFunction(`
      return location.pathname === '/criar' && Boolean(document.querySelector('.editor')) ? true : null;
    `, 12000).catch(() => null);
    if (!noEditor) throw new Error('"Postar video" nao abriu o editor');
    const editor = await s.eval(`
      return {
        temEditor: Boolean(document.querySelector('.editor')),
        temBotooGravar: /Gravar|Escolher|Arraste/.test(document.getElementById('main').innerText),
        temFerramentas: document.querySelectorAll('.editor-tools .tool-btn').length,
      };
    `);
    if (!editor.temEditor) throw new Error('editor nao abriu');
    if (!editor.temBotooGravar) throw new Error('editor sem acao de midia');
    if (!editor.temFerramentas) throw new Error('editor sem ferramentas');
    return `"${link.texto}" ${link.w}x${link.h}px -> /criar com ${editor.temFerramentas} ferramenta(s)`;
  });

  await report.step('mobile: o "+" da bottom nav abre o menu de criacao sem estourar a tela', async () => {
    const s = await sessao(...MOBILE);
    await s.goto(`${server.baseUrl}/`, { waitMs: 1500 });
    const antes = await s.eval(`
      const mais = [...document.querySelectorAll('#tabbar a, #tabbar button')]
        .find((x) => /criar/i.test(x.getAttribute('aria-label') || ''));
      return { temMais: Boolean(mais), itens: document.querySelectorAll('#tabbar a, #tabbar button').length };
    `);
    if (!antes.temMais) throw new Error('sem "+" na bottom nav');
    // Item 9: o "+" abre o menu compacto com as 4 acoes.
    await s.eval(`
      document.querySelector('#tabbar .tab-create').click();
      return true;
    `);
    await sleep(700);
    const menu = await s.eval(`
      const painel = document.querySelector('.sheet-panel');
      const itens = [...document.querySelectorAll('.create-menu-item .create-menu-label')].map((n) => n.textContent.trim());
      const r = painel?.getBoundingClientRect();
      return {
        itens,
        aberto: Boolean(painel),
        dentroDaTela: r ? r.bottom <= window.innerHeight + 1 : false,
        cobreTela: r ? r.height > window.innerHeight * 0.9 : false,
      };
    `);
    if (!menu.aberto) throw new Error('o "+" nao abriu o menu de criacao');
    for (const esperado of ['Postar video', 'Postar foto', 'Texto', 'Iniciar LIVE']) {
      if (!menu.itens.includes(esperado)) throw new Error(`menu sem "${esperado}" (${menu.itens.join(', ')})`);
    }
    if (!menu.dentroDaTela) throw new Error('menu ultrapassa a tela');
    if (menu.cobreTela) throw new Error('menu cobre a tela inteira');
    await s.eval(`
      document.querySelector('.create-menu-item[data-create="video"]').click();
      return true;
    `);
    const abriuEditor = await s.waitForFunction(`
      return location.pathname === '/criar' && Boolean(document.querySelector('.editor')) ? true : null;
    `, 12000).catch(() => null);
    if (!abriuEditor) throw new Error('"Postar video" nao abriu o editor');
    const r = await s.eval(`
      const de = document.documentElement;
      const ferramentas = document.querySelector('.editor-tools');
      const fora = [...ferramentas.children].filter((n) => n.getBoundingClientRect().right > de.clientWidth + 2).length;
      const botoes = [...document.querySelectorAll('.editor-bar button, .editor-bar .btn')];
      return {
        scrollW: de.scrollWidth, vw: de.clientWidth,
        ferramentasFora: fora,
        botoesFora: botoes.filter((b) => b.getBoundingClientRect().right > de.clientWidth + 2).length,
        barraVisivel: Boolean(document.querySelector('.editor-bar')),
      };
    `);
    if (r.scrollW > r.vw + 1) throw new Error(`overflow horizontal: ${r.scrollW} > ${r.vw}`);
    if (r.ferramentasFora || r.botoesFora) throw new Error(`${r.ferramentasFora + r.botoesFora} controle(s) fora da tela`);
    if (!r.barraVisivel) throw new Error('sem barra de acao do editor');
    return `${antes.itens} itens na bottom nav; menu com ${menu.itens.length} acoes; editor sem overflow e controles dentro da tela`;
    if (!r.barraVisivel) throw new Error('sem barra de acao do editor');
    return `${antes.itens} itens na bottom nav; editor sem overflow e controles dentro da tela`;
  });

  // ------------------------------------------- 8) TROCA DE ABAS (varias vezes)
  await report.step('Para voce/Seguindo/Amigos repetidas vezes nao perdem conteudo', async () => {
    const s = await sessao(...DESKTOP);
    await s.goto(`${server.baseUrl}/`, { waitMs: 2000 });
    const r = await s.eval(`
      const tab = (n) => [...document.querySelectorAll('.feed-tabs [role="tab"]')].find((t) => t.textContent.trim() === n);
      const wait = (ms) => new Promise((x) => setTimeout(x, ms));
      const passes = [];
      for (let volta = 1; volta <= 4; volta += 1) {
        for (const nome of ['Seguindo', 'Amigos', 'Para voce']) {
          const b = tab(nome);
          if (!b) continue;
          b.click();
          await wait(1300);
          passes.push({
            volta, nome,
            slides: document.querySelectorAll('.slide[data-post-id]').length,
            vazio: Boolean(document.querySelector('.page-empty')),
          });
        }
      }
      return passes;
    `);
    const paraVoce = r.filter((p) => p.nome === 'Para voce');
    if (!paraVoce.length) throw new Error('aba "Para voce" nao encontrada');
    for (const p of paraVoce) {
      if (p.slides === 0) throw new Error(`volta ${p.volta}: "Para voce" ficou vazia`);
      if (p.vazio) throw new Error(`volta ${p.volta}: "Para voce" mostrou estado vazio`);
    }
    const outros = r.filter((p) => p.nome !== 'Para voce');
    for (const p of outros) {
      if (p.slides > 0) throw new Error(`"${p.nome}" com conteudo de outra aba (volta ${p.volta})`);
    }
    return `4 voltas x 3 abas: "Para voce" sempre com ${paraVoce[0].slides} slides; Seguindo/Amigos vazios de verdade`;
  });

  // ------------------------------------------- 15/16) PERFIL
  for (const [nome, w, h] of [['desktop', ...DESKTOP], ['mobile', ...MOBILE]]) {
    const s = await sessao(w, h);
    await report.step(`${nome}: hierarquia do perfil sem sobreposicao`, async () => {
      await s.goto(`${server.baseUrl}/perfil`, { waitMs: 1800 });
      const info = await s.eval(`
        const box = (sel) => { const n = document.querySelector(sel); if (!n) return null;
          const r = n.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right) }; };
        const nomes = { capa: '.profile-cover', avatar: '.profile-row .avatar', nome: '.profile-name',
          usuario: '.profile-user', stats: '.profile-stats', abas: '.profile-tabs' };
        const out = {};
        for (const [k, sel] of Object.entries(nomes)) out[k] = box(sel);
        const botoes = [...document.querySelectorAll('.profile-actions .btn')].map((b) => {
          const r = b.getBoundingClientRect(); return { t: (r.textContent || '').trim(), top: Math.round(r.top), left: Math.round(r.left), right: Math.round(r.right) };
        });
        const capaEdit = box('.profile-cover-edit');
        return { out, botoes, capaEdit, vw: document.documentElement.clientWidth,
          scrollW: document.documentElement.scrollWidth };
      `);
      const o = info.out;
      if (!o.capa || !o.avatar || !o.nome || !o.usuario || !o.stats || !o.abas) {
        throw new Error(`faltando bloco: ${Object.entries(o).filter(([, v]) => !v).map(([k]) => k).join(', ')}`);
      }
      // Ordem vertical estrita: cada bloco comeca onde o anterior termina.
      if (o.nome.bottom > o.usuario.top + 1) throw new Error('nome invade @usuario');
      if (o.usuario.bottom > o.stats.top + 1) throw new Error('@usuario invade contadores');
      if (o.stats.bottom > o.abas.top + 1) throw new Error('contadores invadem abas');
      if (o.capa.bottom > o.avatar.top + o.avatar.h * 0.7) throw new Error('capa cobrindo o avatar');
      if (info.scrollW > info.vw + 1) throw new Error(`overflow horizontal ${info.scrollW}>${info.vw}`);
      // Nenhum botao pode COBRIR o nome ou o @usuario: interseccao real
      // nos dois eixos (o botao fica na MESMA linha do avatar, acima do nome).
      const cruza = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 4
        && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 4;
      for (const b of info.botoes) {
        const box = { top: b.top, left: b.left, right: b.right, bottom: b.top + (b.h || 44) };
        if (cruza(box, o.nome)) throw new Error(`botao \"${b.t}\" cobre o nome`);
        if (cruza(box, o.usuario)) throw new Error(`botao \"${b.t}\" cobre o @usuario`);
      }
      return `capa->avatar->nome->@usuario->contadores->abas em ordem; ${info.botoes.length} botao(s) sem sobreposicao; largura ${info.vw}px`;
    });
  }

  // ------------------------------------------- 14) FOTO E CAPA
  await report.step('foto de perfil: upload real, aparece na hora e persiste', async () => {
    const s = await sessao(...MOBILE);
    await s.goto(`${server.baseUrl}/perfil`, { waitMs: 2000 });
    const antes = await s.eval(`
      return {
        botao: Boolean(document.querySelector('.profile-avatar-edit')),
        temImg: Boolean(document.querySelector('.profile-head .avatar img')),
      };
    `);
    if (!antes.botao) throw new Error('sem botao de alterar foto');
    const png = await makeTestImage({ width: 320, height: 320, color: '#ec4899' });
    const r = await s.eval(`
      const b64 = '${png.buffer.toString('base64')}';
      const bin = atob(b64); const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
      const file = new File([bytes], 'foto.png', { type: 'image/png' });
      document.querySelector('.profile-avatar-edit').click();
      await new Promise((x) => setTimeout(x, 300));
      const input = [...document.querySelectorAll('input[type="file"]')].pop();
      if (!input) return { erro: 'sem input de arquivo' };
      const dt = new DataTransfer(); dt.items.add(file); input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((x) => setTimeout(x, 2600));
      const img = document.querySelector('.profile-head .avatar img');
      return { temImg: Boolean(img), src: img ? img.getAttribute('src') : null };
    `);
    if (r.erro) throw new Error(r.erro);
    if (!r.temImg || !/avatar/.test(r.src || '')) throw new Error(`foto nao aplicada: ${JSON.stringify(r)}`);
    await s.goto(`${server.baseUrl}/perfil`, { waitMs: 1800 });
    const depois = await s.eval(`
      const img = document.querySelector('.profile-head .avatar img');
      const bg = getComputedStyle(document.querySelector('.profile-cover')).backgroundImage;
      return { avatar: Boolean(img), capa: bg.includes('media') };
    `);
    if (!depois.avatar) throw new Error('foto sumiu ao recarregar');
    return `upload real aplicado (${r.src.slice(0, 46)}...) e persistindo; capa ja existente: ${depois.capa}`;
  });

  await report.step('capa: upload real, proporcao correta e persiste', async () => {
    const s = await sessao(...MOBILE);
    await s.goto(`${server.baseUrl}/perfil`, { waitMs: 2000 });
    const png = await makeTestImage({ width: 1200, height: 400, color: '#8b5cf6' });
    const r = await s.eval(`
      const b64 = '${png.buffer.toString('base64')}';
      const bin = atob(b64); const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
      const file = new File([bytes], 'capa.png', { type: 'image/png' });
      document.querySelector('.profile-cover-edit').click();
      await new Promise((x) => setTimeout(x, 300));
      const input = [...document.querySelectorAll('input[type="file"]')].pop();
      const dt = new DataTransfer(); dt.items.add(file); input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((x) => setTimeout(x, 2600));
      const capa = document.querySelector('.profile-cover');
      const bg = getComputedStyle(capa).backgroundImage;
      const r = capa.getBoundingClientRect();
      const av = document.querySelector('.profile-row .avatar').getBoundingClientRect();
      return {
        temCapa: bg.includes('media'),
        proporcao: Math.round(r.width / r.height),
        capaNaoCobreAvatar: r.bottom <= av.top + av.height * 0.6,
        avatarDentro: av.left >= r.left - 1 && av.right <= r.right + 1,
      };
    `);
    if (!r.temCapa) throw new Error('capa nao aplicada');
    if (!r.capaNaoCobreAvatar) throw new Error('a capa cobre o avatar');
    if (!r.avatarDentro) throw new Error('avatar fora da capa');
    await s.goto(`${server.baseUrl}/perfil`, { waitMs: 1800 });
    const persistiu = await s.eval(`
      return getComputedStyle(document.querySelector('.profile-cover')).backgroundImage.includes('media');
    `);
    if (!persistiu) throw new Error('capa sumiu ao recarregar');
    return `capa aplicada (proporcao ${r.proporcao}:1), avatar dentro e visivel, persistindo`;
  });

  // ------------------------------------------- 25) NOTIFICACOES
  for (const [nome, w, h] of [['desktop', ...DESKTOP], ['mobile', ...MOBILE]]) {
    const s = await sessao(w, h);
    await report.step(`${nome}: notificacoes com titulo e acoes sem sobrepor`, async () => {
      await s.goto(`${server.baseUrl}/notificacoes`, { waitMs: 1800 });
      const r = await s.eval(`
        const titulo = document.querySelector('.page-title');
        const acoes = [...document.querySelectorAll('.page-head-actions .btn')];
        const tb = titulo?.getBoundingClientRect();
        const intersecao = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 4
          && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 4;
        return {
          titulo: titulo?.textContent || null,
          botoes: acoes.map((b) => b.textContent.trim()),
          sobrepostos: acoes.filter((b) => tb && intersecao(tb, b.getBoundingClientRect())).length,
          dentroDaTela: acoes.every((b) => b.getBoundingClientRect().right <= document.documentElement.clientWidth + 1),
          scrollW: document.documentElement.scrollWidth, vw: document.documentElement.clientWidth,
        };
      `);
      if (!r.titulo) throw new Error('sem titulo');
      if (!r.botoes.length) throw new Error('sem acoes');
      if (r.sobrepostos) throw new Error(`${r.sobrepostos} botao(s) em cima do titulo`);
      if (!r.dentroDaTela) throw new Error('botao fora da tela');
      if (r.scrollW > r.vw + 1) throw new Error(`overflow ${r.scrollW}>${r.vw}`);
      return `"${r.titulo}" + [${r.botoes.join(' | ')}] sem sobreposicao em ${r.vw}px`;
    });
  }

  // ------------------------------------------- 24) CHAT
  for (const [nome, w, h] of [['desktop', ...DESKTOP], ['mobile', ...MOBILE]]) {
    const s = await sessao(w, h);
    await report.step(`${nome}: chat com mensagens e campo acima da bottom nav`, async () => {
      await s.goto(`${server.baseUrl}/inbox/${conv.body.conversationId}`, { waitMs: 2500 });
      const r = await s.eval(`
        const tab = document.querySelector('#tabbar');
        const tabVisivel = tab && getComputedStyle(tab).display !== 'none';
        const rt = tabVisivel ? tab.getBoundingClientRect() : null;
        const foot = document.querySelector('.chat-foot');
        const campo = document.querySelector('.composer textarea, .composer input');
        const fr = foot?.getBoundingClientRect();
        const cr = campo?.getBoundingClientRect();
        return {
          mensagens: document.querySelectorAll('.msg').length,
          temCabecalho: Boolean(document.querySelector('.chat-thread-head')),
          temStatus: /online|online|@/.test(document.querySelector('.chat-thread-head')?.innerText || ''),
          campoVisivel: cr ? cr.width > 0 && cr.bottom <= (document.documentElement.clientHeight + 1) : false,
          campoForaDaTab: rt && cr ? cr.bottom <= rt.top + 1 : true,
          threadVisivel: (document.querySelector('.chat-thread-head')?.getBoundingClientRect().width || 0) > 0,
        };
      `);
      if (r.mensagens < 4) throw new Error(`apenas ${r.mensagens} mensagem(ns) na tela`);
      if (!r.temCabecalho) throw new Error('sem cabecalho da conversa');
      if (!r.campoVisivel) throw new Error('campo de mensagem fora da tela');
      if (!r.campoForaDaTab) throw new Error('campo coberto pela bottom nav');
      if (!r.threadVisivel) throw new Error('conversa fora da tela');
      return `${r.mensagens} mensagens, cabecalho e campo visiveis, campo acima da tabbar`;
    });
  }

  // ------------------------------------------- 12) LIVE
  for (const [nome, w, h] of [['desktop', ...DESKTOP], ['mobile', ...MOBILE]]) {
    // Anfitriao e espectador novos para esta plataforma.
    const hostCli = new Client(server.baseUrl);
    const hostUser = await hostCli.register({ username: randomUsername(`host${nome}`) });
    const sessaoCli = new Client(server.baseUrl);
    const sessaoUser = await sessaoCli.register({ username: randomUsername(`spec${nome}`) });
    const s = await sessao(w, h, { usuario: hostUser });
    await report.step(`${nome}: INICIAR LIVE com MediaStream real e espectador entrando`, async () => {
      await s.goto(`${server.baseUrl}/ao-vivo`, { waitMs: 2000 });
      const area = await s.eval(`
        const btn = document.querySelector('.live-start-btn');
        if (!btn) return { erro: 'sem botao de iniciar LIVE' };
        const r = btn.getBoundingClientRect();
        return { texto: btn.innerText.trim(), href: btn.getAttribute('href'), w: Math.round(r.width), h: Math.round(r.height), naTela: r.top >= 0 && r.bottom <= innerHeight };
      `);
      if (area.erro) throw new Error(area.erro);
      if (area.href !== '/iniciar-live') throw new Error(`destino ${area.href}`);
      await s.goto(`${server.baseUrl}/iniciar-live`, { waitMs: 1500 });
      await s.eval(`
        const b = [...document.querySelectorAll('#main button')].find((x) => /Iniciar transmissao/i.test(x.innerText));
        b.click();
        return true;
      `);
      const stream = await s.waitForFunction(`
        const v = document.querySelector('#main video');
        if (!v || !v.videoWidth) return null;
        return { w: v.videoWidth, h: v.videoHeight, tracks: v.srcObject ? v.srcObject.getTracks().map((t) => t.kind) : [] };
      `, 25000).catch((e) => ({ erro: e.message }));
      if (stream.erro) throw new Error(`sem MediaStream real: ${stream.erro}`);
      const temAudio = stream.tracks.includes('audio');
      const temVideo = stream.tracks.includes('video');
      if (!temAudio || !temVideo) throw new Error(`trilhas: ${stream.tracks.join(',')}`);

      // Espectador real entrando (contador do servidor).
      const lista = await hostCli.get('/api/live/discover');
      const sala = (lista.body.live || [])[0];
      if (!sala) throw new Error('LIVE nao apareceu na lista');
      const esp = await sessaoCli.post(`/api/live/${sala.id}/join`, {});
      if (esp.status !== 200) throw new Error(`espectador nao entrou: ${esp.status}`);
      const depois = await hostCli.get('/api/live/discover');
      const contagemVista = (depois.body.live || []).find((r) => r.id === sala.id);
      if (contagemVista?.viewerCount !== 1) throw new Error(`contador ${contagemVista?.viewerCount}`);
      return `MediaStream real ${stream.w}x${stream.h} (${stream.tracks.join('+')}); sala ${sala.id}; espectador entrou -> contador 1`;
    });
  }

  // ------------------------------------------- 3) GIPHY
  for (const [nome, w, h] of [['desktop', ...DESKTOP], ['mobile', ...MOBILE]]) {
    const s = await sessao(w, h);
    await report.step(`${nome}: GIPHY entrega GIFs e stickers reais`, async () => {
      await s.goto(`${server.baseUrl}/criar`, { waitMs: 1800 });
      const status = await s.eval('return (await (await fetch("/api/giphy/status")).json());');
      if (!status.configured) throw new Error('GIPHY sem configuracao');
      const gif = await s.eval(`
        const r = await fetch('/api/giphy/search?q=gato&limit=6');
        const j = await r.json();
        return { status: r.status, itens: j.items || [], temChave: JSON.stringify(j).includes('dc6zaTOxFJmz') };
      `);
      if (gif.status !== 200 || !gif.itens.length) throw new Error(`busca: HTTP ${gif.status}, ${gif.itens.length} itens`);
      if (gif.temChave) throw new Error('a chave do GIPHY apareceu na resposta');
      const stickers = await s.eval(`
        const r = await fetch('/api/giphy/search?q=feliz&kind=stickers&limit=6');
        const j = await r.json();
        return { status: r.status, itens: (j.items || []).length, kinds: [...new Set((j.items || []).map((i) => i.kind))] };
      `);
      if (stickers.status !== 200 || !stickers.itens) throw new Error(`stickers: HTTP ${stickers.status}`);
      if (!stickers.kinds.includes('sticker')) throw new Error(`stickers sem kind sticker: ${stickers.kinds}`);
      return `${gif.itens.length} GIFs + ${stickers.itens} stickers, chave nunca exposta`;
    });
  }

  // ------------------------------------------- 6) PUSH
  for (const [nome, w, h] of [['desktop', ...DESKTOP], ['mobile', ...MOBILE]]) {
    const s = await sessao(w, h);
    await report.step(`${nome}: aviso de push fecha e libera a interface`, async () => {
      await s.goto(`${server.baseUrl}/`, { waitMs: 1200 });
      const r = await s.eval(`
        const p = document.getElementById('push-prompt');
        const d = document.getElementById('push-dismiss');
        const a = document.getElementById('push-accept');
        if (!p || !d || !a) return { erro: 'aviso incompleto' };
        const oculto = () => p.hidden && getComputedStyle(p).display === 'none';
        // 1) "Agora nao"
        localStorage.removeItem('pulse_push_dismissed');
        p.hidden = false; d.click();
        await new Promise((x) => setTimeout(x, 200));
        const depoisNao = { oculto: oculto(), livre: document.elementFromPoint(innerWidth / 2, innerHeight / 2)?.closest('#push-prompt') == null };
        // 2) "Ativar"
        p.hidden = false; a.click();
        await new Promise((x) => setTimeout(x, 1200));
        const depoisAtivar = { oculto: oculto(), desabilitado: a.disabled, rotulo: a.textContent.trim(), permissao: Notification.permission };
        // 3) A interface responde depois do aviso (clique real no conteudo)
        let interfaceViva = false;
        try {
          // Clica num destino de verdade (fora da home) e confere que navegou.
          const link = [...document.querySelectorAll('#side-nav a, #tabbar a')]
            .find((x) => { const h = x.getAttribute('href') || ''; return h.startsWith('/') && h !== '/'; });
          if (link) {
            link.click();
            await new Promise((x) => setTimeout(x, 1200));
            interfaceViva = location.pathname !== '/entrar' && document.querySelector('#main')?.innerText.trim().length > 5;
          }
        } catch { interfaceViva = false; }
        return { depoisNao, depoisAtivar, interfaceViva };
      `);
      if (r.erro) throw new Error(r.erro);
      if (!r.depoisNao.oculto) throw new Error('"Agora nao" nao fechou o aviso');
      if (!r.depoisNao.livre) throw new Error('overlay continua bloqueando cliques');
      if (!r.depoisAtivar.oculto) throw new Error('"Ativar" nao fechou o aviso');
      if (r.depoisAtivar.desabilitado) throw new Error('botao "Ativar" ficou travado');
      if (!r.interfaceViva) throw new Error('interface travada apos o aviso');
      if (r.depoisAtivar.permissao === 'granted' && r.depoisAtivar.rotulo !== 'Ativar') {
        throw new Error(`botao nao voltou ao normal: "${r.depoisAtivar.rotulo}"`);
      }
      return `"Agora nao" fecha e libera; "Ativar" fecha, botao liberado ("${r.depoisAtivar.rotulo}"), permissao=${r.depoisAtivar.permissao}, interface responde`;
    });
  }

  // ------------------------------------------- 26) BOTTOM NAV
  await report.step('mobile: bottom nav fixa, com safe-area e sem cobrir conteudo', async () => {
    const s = await sessao(...MOBILE);
    await s.goto(`${server.baseUrl}/`, { waitMs: 1500 });
    const r = await s.eval(`
      const tab = document.querySelector('#tabbar');
      const cs = getComputedStyle(tab);
      const rt = tab.getBoundingClientRect();
      const itens = [...tab.children];
      const main = document.querySelector('#main');
      const mr = main.getBoundingClientRect();
      return {
        visivel: cs.display !== 'none',
        altura: Math.round(rt.height),
        fixo: cs.position === 'sticky' || cs.position === 'fixed',
        itens: itens.length,
        centralEhMais: (() => {
          const meio = itens[Math.floor(itens.length / 2)];
          // Item 9: o "+" virou botao (abre o menu de criacao), nao link.
          return Boolean(meio && /criar/i.test(meio.getAttribute('aria-label') || meio.getAttribute('href') || ''));
        })(),
        paddingBottom: cs.paddingBottom,
        mainNaoEhSob: mr.bottom <= rt.top + 1 || getComputedStyle(main).overflowY !== 'visible',
        larguraCheia: Math.round(rt.width) === Math.round(document.documentElement.clientWidth),
      };
    `);
    if (!r.visivel) throw new Error('bottom nav ausente');
    if (!r.fixo) throw new Error('bottom nav nao fica fixa');
    if (r.itens !== 5) throw new Error(`${r.itens} itens (esperado 5)`);
    if (!r.centralEhMais) throw new Error('o "+" nao e o item central');
    if (!r.larguraCheia) throw new Error('bottom nav nao ocupa a largura toda');
    if (!r.mainNaoEhSob) throw new Error('conteudo passa por baixo da bottom nav');
    return `${r.itens} itens, ${r.altura}px, padding-bottom=${r.paddingBottom}, "+" central`;
  });

} catch (err) {
  report.fail('erro inesperado', err);
}

const resultado = report.summary();
await browser.close();
await server.stop();
process.exit(resultado.failed > 0 ? 1 : 0);