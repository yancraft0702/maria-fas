/**
 * Medicao de layout no Chrome real (desktop + mobile).
 *
 * Para cada tela e largura, reporta:
 *  - rolagem horizontal (scrollWidth > clientWidth)
 *  - elementos que ultrapassam a viewport pela direita
 *  - sobreposicoes entre blocos de texto/botoes (elementos visivelamente
 *    intersectando onde nao deveriam)
 *  - conteudo coberto pela bottom navigation
 *
 * Nao corrige nada: apenas mede, para as correcoes serem dirigidas por
 * numeros e nao por palpite.
 */
import { startServer, Client, randomUsername, makeTestVideo, makeTestImage, waitUntil } from '../tests/helpers.mjs';
import { launchChrome } from '../tests/cdp.mjs';

const server = await startServer();

// Conta com conteudo real: 1 video + texto, para as telas nao nascerem vazias.
const author = new Client(server.baseUrl);
await author.register({ username: randomUsername('ana') });
const video = await makeTestVideo({ seconds: 2, width: 480, height: 854, withAudio: true });
const up = await author.upload('/api/media/upload?purpose=video', video.buffer, {
  filename: video.filename, mime: video.mime,
});
await waitUntil(async () => {
  const { body } = await author.get(`/api/media/${up.body.media.id}/status`);
  return body.media.status === 'ready' ? body.media : null;
}, { timeoutMs: 120000, intervalMs: 800 });
await author.post('/api/posts', { type: 'video', mediaId: up.body.media.id, caption: 'video real de teste' });
for (let i = 0; i < 6; i += 1) await author.post('/api/posts', { type: 'text', caption: `texto ${i}` });
const avatar = await makeTestImage({ width: 320, height: 320, color: '#ec4899' });
await author.upload('/api/users/me/avatar', avatar.buffer, { filename: avatar.filename, mime: avatar.mime });
const cover = await makeTestImage({ width: 1200, height: 400, color: '#8b5cf6' });
await author.upload('/api/users/me/cover', cover.buffer, { filename: cover.filename, mime: cover.mime });

// Conversa real com mensagens (item 24): sem ela a tela de chat abriria vazia.
const outra = new Client(server.baseUrl);
const outraUser = await outra.register({ username: randomUsername('bruno') });
const conversa = await author.post('/api/conversations', { userId: outraUser.id });
for (const texto of ['Oi! Tudo bem?', 'Vi seu ultimo video, ficou massa', 'Bora fazer uma LIVE depois?', 'Entao, manda ver!']) {
  await author.post(`/api/conversations/${conversa.body.conversationId}/messages`, { body: texto });
}

const browser = await launchChrome();
const page = await browser.newPage();
page.watch();
await page.goto(`${server.baseUrl}/`, { waitMs: 400 });
const login = await fetch(`${server.baseUrl}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ identifier: author.user.username, password: 'Senha@Teste123' }),
});
for (const c of login.headers.getSetCookie()) {
  const [pair] = c.split(';'); const [n, v] = pair.split('=');
  await page.send('Network.setCookie', { name: n, value: decodeURIComponent(v), domain: '127.0.0.1', path: '/' });
}
await page.send('Network.setCacheDisabled', { cacheDisabled: true });
await page.goto(`${server.baseUrl}/`, { waitMs: 300 });
await page.eval(`
  const regs = await navigator.serviceWorker.getRegistrations();
  for (const r of regs) await r.unregister();
  const keys = await caches.keys();
  for (const k of keys) await caches.delete(k);
  return true;
`).catch(() => {});

const TELAS = [
  ['inicio/feed', '/'],
  ['perfil', '/perfil'],
  ['notificacoes', '/notificacoes'],
  ['inbox', '/inbox'],
  ['chat', `/inbox/${conversa.body.conversationId}`],
  ['ao-vivo', '/ao-vivo'],
  ['editor', '/criar'],
  ['busca', '/busca'],
  ['explorar', '/explorar'],
  ['configuracoes', '/configuracoes'],
  ['amigos', '/amigos'],
];

const LARGURAS = [
  ['mobile-320', 320, 640], ['mobile-360', 360, 740], ['mobile-390', 390, 844],
  ['mobile-414', 414, 896], ['tablet-768', 768, 1024],
  ['pc-1024', 1024, 900], ['pc-1280', 1280, 900], ['pc-1440', 1440, 900], ['pc-1920', 1920, 1080],
];

/** Medicao feita dentro da pagina. */
const MEDIR = `
  const de = document.documentElement;
  const vw = de.clientWidth;
  const problemas = [];

  // 1) Rolagem horizontal
  if (de.scrollWidth > vw + 1) problemas.push({ tipo: 'overflow-h', valor: de.scrollWidth, limite: vw });

  // 2) Elementos que passam da borda direita.
  //    Ignora quem esta dentro de um container COM rolagem horizontal
  //    intencional (faixa de abas, filtros, chips): ali o transbordo e o
  //    proprio mecanismo de rolagem, nao um bug de layout.
  const temScrollX = (node) => {
    for (let p = node.parentElement; p && p !== document.body; p = p.parentElement) {
      const ov = getComputedStyle(p).overflowX;
      if (ov === 'auto' || ov === 'scroll') return true;
    }
    return false;
  };
  const culpados = [];
  for (const node of document.querySelectorAll('#main *, #topbar *, #tabbar *, #side-nav *')) {
    const r = node.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const cs = getComputedStyle(node);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) continue;
    if (r.right > vw + 2 || r.left < -2) {
      if (temScrollX(node)) continue;
      culpados.push({
        sel: node.tagName.toLowerCase() + (typeof node.className === 'string' && node.className ? '.' + node.className.trim().split(/\\s+/).slice(0,2).join('.') : ''),
        left: Math.round(r.left), right: Math.round(r.right),
      });
    }
  }
  if (culpados.length) problemas.push({ tipo: 'fora-da-tela', itens: culpados.slice(0, 6) });

  // 3) Sobreposicao real entre blocos interativos/texto independentes
  const alvos = [...document.querySelectorAll('#main .page-title, #main .page-sub, #main h1, #main h2, #main .btn, #main .seg button, #main .profile-name, #main .profile-user, #main .profile-actions, .profile-tabs button')]
    .filter((n) => { const r = n.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
  const sobrepostos = [];
  for (let i = 0; i < alvos.length; i += 1) {
    for (let j = i + 1; j < alvos.length; j += 1) {
      const a = alvos[i]; const b = alvos[j];
      if (a.contains(b) || b.contains(a)) continue;
      const ra = a.getBoundingClientRect(); const rb = b.getBoundingClientRect();
      const w = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
      const h = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
      if (w > 6 && h > 6) {
        sobrepostos.push({
          a: a.tagName.toLowerCase() + '.' + String(a.className).trim().split(/\\s+/)[0],
          b: b.tagName.toLowerCase() + '.' + String(b.className).trim().split(/\\s+/)[0],
          area: Math.round(w * h),
        });
      }
    }
  }
  if (sobrepostos.length) problemas.push({ tipo: 'sobreposicao', itens: sobrepostos.slice(0, 5) });

  // 4) Conteudo escondido atras da bottom navigation
  const tab = document.querySelector('#tabbar');
  let sobTab = 0;
  if (tab && getComputedStyle(tab).display !== 'none') {
    const rt = tab.getBoundingClientRect();
    const zTab = Number(getComputedStyle(tab).zIndex) || 0;
    // So conta como "coberto" o que realmente pinta ACIMA da tabbar.
    const pintaAcima = (node) => {
      for (let p = node; p && p !== document.body; p = p.parentElement) {
        const cs = getComputedStyle(p);
        if (cs.position === 'fixed' || cs.position === 'absolute') {
          const z = Number(cs.zIndex) || 0;
          if (z > zTab) return true;
        }
      }
      return false;
    };
    for (const node of document.querySelectorAll('#main button, #main input, #main .btn')) {
      const r = node.getBoundingClientRect();
      if (r.height === 0) continue;
      if (r.bottom > rt.top + 2 && r.top < rt.bottom && r.right > 0 && !pintaAcima(node)) sobTab += 1;
    }
    if (sobTab) problemas.push({ tipo: 'coberto-pela-tabbar', valor: sobTab });
  }

  return {
    vw,
    scrollW: de.scrollWidth,
    problemas,
    alturaUtil: Math.round(document.getElementById('main')?.getBoundingClientRect().height || 0),
    vazio: document.getElementById('main')?.innerText.trim().length < 10,
  };
`;

let comProblema = 0;
for (const [nomeTela, path] of TELAS) {
  console.log(`\n=== ${nomeTela} (${path}) ===`);
  for (const [nomeLarg, w, h] of LARGURAS) {
    // Nao vale medir o feed em telas minusculas se o usuario pediu so mobile/desktop
    await page.send('Emulation.setDeviceMetricsOverride', {
      width: w, height: h, deviceScaleFactor: 1, mobile: w < 768,
    });
    await page.goto(`${server.baseUrl}${path}`, { waitMs: 1400 });
    const r = await page.eval(MEDIR);
    const p = r.problemas;
    if (!p.length) {
      console.log(`  [OK   ] ${nomeLarg.padEnd(10)} ${r.scrollW}px  altura=${r.alturaUtil}`);
    } else {
      comProblema += 1;
      const resumo = p.map((x) => x.tipo).join(', ');
      console.log(`  [RUIM ] ${nomeLarg.padEnd(10)} ${r.scrollW}px  ${resumo}`);
      for (const item of p) {
        if (item.tipo === 'fora-da-tela') {
          for (const it of item.itens) console.log(`           fora: ${it.sel} [${it.left}..${it.right}]`);
        }
        if (item.tipo === 'sobreposicao') {
          for (const it of item.itens) console.log(`           sobre: ${it.a} X ${it.b} (${it.area}px2)`);
        }
        if (item.tipo === 'overflow-h') console.log(`           overflow: ${item.valor} > ${item.limite}`);
        if (item.tipo === 'coberto-pela-tabbar') console.log(`           ${item.valor} elemento(s) sob a tabbar`);
      }
    }
  }
}

console.log(`\n${comProblema} combinacao(tela x largura) com problema de layout`);
console.log('console:', JSON.stringify(page.consoleErrors.slice(0, 6)));
await browser.close();
await server.stop();
process.exit(0);