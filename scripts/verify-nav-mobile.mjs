/**
 * Verifica os itens 2 (navegacao), 4 (Home mobile), 8 (bottom nav) e
 * 9 (menu do "+") em desktop e mobile, medindo de verdade.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { startServer, Client, Report, randomUsername, sleep } from '../tests/helpers.mjs';
import { launchChrome } from '../tests/cdp.mjs';

const report = new Report('Navegacao, Home mobile e menu de criacao');

// Banco proprio para este teste, para promover um admin de verdade.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-nav-'));
const databasePath = path.join(dir, 'nav.db');
const server = await startServer({ env: { DATABASE_PATH: databasePath } });

const comum = new Client(server.baseUrl);
const usuario = await comum.register({ username: randomUsername('nav') });

const adminCli = new Client(server.baseUrl);
const adminUser = await adminCli.register({ username: randomUsername('adm') });
{
  const db = new DatabaseSync(databasePath);
  db.prepare("UPDATE users SET role = 'admin', status = 'active' WHERE username = ?").run(adminUser.username);
  db.close();
}

const browser = await launchChrome();

async function sessao(u, width, height, mobile) {
  const s = await browser.newBrowserContext();
  s.watch();
  await s.goto(`${server.baseUrl}/`, { waitMs: 300 });
  const r = await fetch(`${server.baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: u.username, password: 'Senha@Teste123' }),
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

const MOBILE = { w: 390, h: 844 };

try {
  // ---- 1) Sidebar do usuario comum (item 2) ---------------------------
  const desk = await sessao(usuario, 1440, 900, false);
  await desk.goto(`${server.baseUrl}/`, { waitMs: 2500 });

  await report.step('sidebar: apenas Inicio, Publicar, Inbox, LIVE, Perfil, Notificacoes', async () => {
    const st = await desk.eval(`
      const visiveis = (sel) => getComputedStyle(document.querySelector(sel)).display !== 'none';
      const links = [...document.querySelectorAll('#side-nav .side-link')]
        .filter((a) => a.offsetParent !== null)
        .map((a) => (a.getAttribute('aria-label') || a.textContent.trim()));
      return { links, sidebarVisivel: visiveis('#sidebar') };
    `);
    const esperado = ['Inicio', 'Publicar', 'Inbox', 'LIVE', 'Perfil', 'Notificacoes'];
    const faltando = esperado.filter((x) => !st.links.includes(x));
    const sobrando = st.links.filter((x) => !esperado.includes(x));
    if (faltando.length) throw new Error(`faltando na sidebar: ${faltando.join(', ')}`);
    if (sobrando.length) throw new Error(`itens na solicitados: ${sobrando.join(', ')}`);
    if (!st.sidebarVisivel) throw new Error('sidebar nao visivel no desktop');
    return st.links.join(' | ');
  });

  await report.step('rotas removidas da navegacao continuam funcionando', async () => {
    for (const [rota, marcador] of [['/busca', 'input'], ['/explorar', '.page'], ['/amigos', '.page']]) {
      await desk.goto(`${server.baseUrl}${rota}`, { waitMs: 2000 });
      const st = await desk.eval(`
        return { path: location.pathname, texto: (document.getElementById('main')?.innerText || '').length };
      `);
      if (st.texto < 10) throw new Error(`${rota} ficou sem conteudo`);
      void marcador;
    }
    return '/busca, /explorar e /amigos respondem';
  });

  // ---- 2) Administrador (item 2) -------------------------------------
  await report.step('administrador ve Administracao na sidebar (e o comum nao)', async () => {
    await celularAdmin();
    const st = await desk.eval(`
      return [...document.querySelectorAll('#side-nav .side-link')]
        .filter((a) => a.offsetParent !== null)
        .map((a) => a.getAttribute('aria-label') || a.textContent.trim());
    `);
    if (!st.includes('Administracao')) throw new Error(`sidebar do admin sem Administracao: ${st.join(', ')}`);
    const extras = st.filter((x) => !['Inicio', 'Publicar', 'Inbox', 'LIVE', 'Perfil', 'Notificacoes', 'Administracao'].includes(x));
    if (extras.length) throw new Error(`itens a mais no admin: ${extras.join(', ')}`);
    return st.join(' | ');
  });

  // ---- 3) Bottom nav mobile (item 8) ---------------------------------
  async function celularAdmin() {
    const r = await fetch(`${server.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: adminUser.username, password: 'Senha@Teste123' }),
    });
    for (const ck of r.headers.getSetCookie()) {
      const pair = ck.split(';')[0];
      const n = pair.split('=')[0];
      await desk.send('Network.setCookie', { name: n, value: decodeURIComponent(pair.slice(n.length + 1)), domain: '127.0.0.1', path: '/' });
    }
    await desk.goto(`${server.baseUrl}/`, { waitMs: 2500 });
  }

  const cel = await sessao(usuario, MOBILE.w, MOBILE.h, true);
  await cel.goto(`${server.baseUrl}/`, { waitMs: 2500 });

  await report.step('bottom nav: Inicio, Amigos, +, Inbox, Perfil', async () => {
    const st = await cel.eval(`
      const barra = document.getElementById('tabbar');
      const filhos = [...barra.children];
      const box = barra.getBoundingClientRect();
      return {
        itens: filhos.map((f) => f.getAttribute('aria-label') || f.textContent.trim()),
        temMais: filhos.filter((f) => f.classList.contains('tab-create')).length,
        altura: Math.round(box.height),
        fixo: getComputedStyle(barra).position,
        largura: Math.round(box.width),
        viewport: document.documentElement.clientWidth,
      };
    `);
    const esperado = ['Inicio', 'Amigos', 'Criar', 'Inbox', 'Perfil'];
    if (JSON.stringify(st.itens) !== JSON.stringify(esperado)) {
      throw new Error(`bottom nav = ${JSON.stringify(st.itens)} (esperado ${JSON.stringify(esperado)})`);
    }
    if (st.temMais !== 1) throw new Error(`${st.temMais} botoes "+" (esperado 1)`);
    if (st.largura > st.viewport + 1) throw new Error(`barra com ${st.largura}px em viewport de ${st.viewport}px`);
    if (st.altura > 76) throw new Error(`barra alta demais: ${st.altura}px`);
    return `${st.itens.join(' | ')} - ${st.altura}px, ${st.fixo}`;
  });

  // ---- 4) Menu do "+" (item 9) ---------------------------------------
  await report.step('"+" abre menu com as opcoes de criacao', async () => {
    await cel.eval(`
      document.querySelector('#tabbar .tab-create').click();
      return true;
    `);
    await sleep(700);
    const st = await cel.eval(`
      const folha = document.querySelector('.sheet-panel') || document.querySelector('.modal .modal') || document.querySelector('.modal');
      const itens = [...(folha?.querySelectorAll('.create-menu-item') || [])];
      const box = folha?.getBoundingClientRect();
      const vh = window.innerHeight;
      return {
        abriu: Boolean(folha),
        itens: itens.map((i) => i.querySelector('.create-menu-label')?.textContent || ''),
        altura: box ? Math.round(box.height) : 0,
        dentroDaTela: box ? box.bottom <= vh + 1 : false,
        cobreTela: box ? box.height > vh * 0.92 : false,
        areaDeToque: itens.map((i) => Math.round(i.getBoundingClientRect().height)),
      };
    `);
    if (!st.abriu) throw new Error('menu do "+" nao abriu');
    // "Postar audio" entrou na rodada do item 16 (publicacao so com audio) e
    // NAO pode ser removido: a lista e a ordem reais do menu.
    const esperado = ['Enviar foto/video', 'Gravar video', 'Texto', 'Postar audio', 'Iniciar LIVE'];
    if (JSON.stringify(st.itens) !== JSON.stringify(esperado)) {
      throw new Error(`itens = ${JSON.stringify(st.itens)} (esperado ${JSON.stringify(esperado)})`);
    }
    if (!st.dentroDaTela) throw new Error(`menu ultrapassa a tela (${st.altura}px)`);
    if (st.cobreTela) throw new Error(`menu cobre a tela inteira (${st.altura}px de ${MOBILE.h})`);
    if (st.areaDeToque.some((h) => h < 44)) throw new Error(`area de toque pequena: ${st.areaDeToque.join(',')}`);
    return `${st.itens.join(' | ')} - ${st.altura}px, toque ${st.areaDeToque.join('/')}px`;
  });

  await report.step('"Postar texto" publica no backend e abre o post', async () => {
    await cel.eval(`
      document.querySelector('[data-create="texto"]').click();
      return true;
    `);
    await sleep(700);
    await cel.eval(`
      const ta = document.querySelector('.modal textarea');
      ta.value = 'Post de verificacao do menu de criacao';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    `);
    await sleep(300);
    await cel.eval(`
      const b = [...document.querySelectorAll('.modal button')].find((x) => x.textContent.trim() === 'Publicar');
      b.click();
      return true;
    `);
    const st = await cel.waitForFunction(`
      const m = location.pathname.match(/^\\/video\\/([^/]+)$/);
      if (m && m[1] && m[1] !== 'undefined') return { path: location.pathname };
      return null;
    `, 15000).catch(() => null);
    if (!st) {
      const erro = await cel.eval(`return document.querySelector('.modal .create-error')?.textContent || '';`);
      throw new Error(`nao navegou para o post; caminho=${(await cel.eval('return location.pathname;'))}; aviso: "${erro}"`);
    }
    return `publicado e aberto em ${st.path}`;
  });

  await report.step('"Enviar foto/video" envia a imagem de verdade e abre o post', async () => {
    await cel.eval(`
      document.querySelector('#tabbar .tab-create').click();
      return true;
    `);
    await sleep(700);
    await cel.eval(`
      document.querySelector('[data-create="midia"]').click();
      return true;
    `);
    await sleep(800);
    // Uma imagem 1x1 PNG valida, gerada no proprio navegador.
    const escolheu = await cel.eval(`
      const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
      const bin = atob(b64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) arr[i] = bin.charCodeAt(i);
      const file = new File([arr], 'foto.png', { type: 'image/png' });
      const dt = new DataTransfer();
      dt.items.add(file);
      const input = document.querySelector('.modal input[type="file"]');
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((x) => setTimeout(x, 600));
      const previa = document.querySelector('.create-photo-preview img');
      const enviar = [...document.querySelectorAll('.modal button')].find((x) => /Publicar (foto|video)/.test(x.textContent.trim()));
      return { previa: Boolean(previa), enviado: Boolean(enviar) && !enviar.disabled };
    `);
    if (!escolheu.previa) throw new Error('a previa da foto nao apareceu');
    if (!escolheu.enviado) throw new Error('"Publicar foto" continuou desabilitado');
    await cel.eval(`
      const enviar = [...document.querySelectorAll('.modal button')].find((x) => x.textContent.trim() === 'Publicar foto');
      enviar.click();
      return true;
    `);
    const st = await cel.waitForFunction(`
      const m = location.pathname.match(/^\\/video\\/([^/]+)$/);
      return m && m[1] && m[1] !== 'undefined' ? { path: location.pathname } : null;
    `, 20000).catch(() => null);
    if (!st) {
      const erro = await cel.eval(`return document.querySelector('.modal .create-error')?.textContent || '';`);
      throw new Error(`a foto nao foi publicada; aviso: "${erro}"`);
    }
    return `foto enviada e post aberto em ${st.path}`;
  });

  await report.step('"Publicar" da sidebar desktop abre o mesmo menu', async () => {
    await desk.goto(`${server.baseUrl}/`, { waitMs: 2000 });
    await desk.eval(`
      document.querySelector('#side-nav .side-create').click();
      return true;
    `);
    await sleep(700);
    const st = await desk.eval(`
      const m = document.querySelector('.modal');
      return {
        abriu: Boolean(m),
        itens: [...(m?.querySelectorAll('.create-menu-item') || [])]
          .map((i) => i.querySelector('.create-menu-label')?.textContent || ''),
      };
    `);
    if (!st.abriu) throw new Error('menu da sidebar nao abriu');
    // O menu tem as MESMAS opcoes do "+" do mobile - incluindo "Postar audio"
    // (item 16). Comparar as duas listas e o que garante que nao houve
    // divergencia entre os dois pontos de entrada.
    const esperadoSidebar = ['Enviar foto/video', 'Gravar video', 'Texto', 'Postar audio', 'Iniciar LIVE'];
    if (JSON.stringify(st.itens) !== JSON.stringify(esperadoSidebar)) {
      throw new Error(`menu da sidebar = ${JSON.stringify(st.itens)} (esperado ${JSON.stringify(esperadoSidebar)})`);
    }
    return st.itens.join(' | ');
  });

  // ---- 5) Home mobile (item 4) ---------------------------------------
  await report.step('Home mobile comeca pelas abas (sem bloco gigante antes)', async () => {
    await cel.goto(`${server.baseUrl}/`, { waitMs: 2500 });
    const st = await cel.eval(`
      const tabs = document.querySelector('.feed-tabs');
      const r = tabs?.getBoundingClientRect();
      const main = document.getElementById('main');
      const stage = document.querySelector('.feed-stage, .feed-slides, .feed-stage');
      const sr = stage?.getBoundingClientRect();
      return {
        topoAbas: r ? Math.round(r.top) : null,
        abas: [...(tabs?.querySelectorAll('[role="tab"]') || [])].map((t) => t.textContent.trim()),
        lupa: Boolean(tabs?.querySelector('.feed-search-btn')),
        topoConteudo: sr ? Math.round(sr.top) : null,
        // Avatar dentro de slide INATIVO tem rect 0 (display:none): nao conta.
        temAvatarAntes: [...main.querySelectorAll('.avatar')].some((a) => {
          const slide = a.closest('.slide, .feed-slide');
          if (slide && !slide.classList.contains('active')) return false;
          if (!slide) return true;
          const box = slide.getBoundingClientRect();
          if (box.height < 40) return false;
          return a.getBoundingClientRect().top < (r?.top || 0);
        }),
        temCoracaoAntes: Boolean(document.querySelector('main .brand-heart, main .brand-logo')),
        espacoVazio: r && sr ? Math.round(sr.top - r.bottom) : null,
        overflowH: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    `);
    if (!st.abas.length) throw new Error('Home mobile sem abas de feed');
    if (st.topoAbas === null) throw new Error('abas de feed nao encontradas');
    if (st.topoAbas > 150) throw new Error(`abas comecam em ${st.topoAbas}px: ha area grande antes delas`);
    if (st.temAvatarAntes) {
      const onde = await cel.eval(`
        const tabs = document.querySelector('.feed-tabs');
        const topo = tabs.getBoundingClientRect().top;
        return [...document.querySelectorAll('#main .avatar')].map((a) => {
          const r = a.getBoundingClientRect();
          const slide = a.closest('.slide, .feed-slide');
          return { top: Math.round(r.top), ativo: slide ? slide.classList.contains('active') : null, pai: a.parentElement?.className || '' };
        }).filter((x) => x.ativo !== false && x.top < topo && x.top > 0);
      `);
      throw new Error(`avatar antes das abas (topo abas=${st.topoAbas}): ${JSON.stringify(onde)}`);
    }
    if (st.temCoracaoAntes) throw new Error('coracao da marca ocupa a Home antes das abas');
    if (st.espacoVazio !== null && st.espacoVazio > 24) throw new Error(`${st.espacoVazio}px de vao entre abas e conteudo`);
    if (st.overflowH > 1) throw new Error(`scroll horizontal de ${st.overflowH}px`);
    return `abas em ${st.topoAbas}px: ${st.abas.join(' | ')} + lupa=${st.lupa}, conteudo em ${st.topoConteudo}px`;
  });
} catch (err) {
  report.fail('erro inesperado', err);
}

const resumo = report.summary();
await browser.close();
await server.stop();
process.exit(resumo.failed > 0 ? 1 : 0);
