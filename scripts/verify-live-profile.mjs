/**
 * Verificacao no navegador dos itens 6 (INICIAR LIVE) e 7 (foto/capa).
 * Upload real de PNG gerado, com persistencia apos recarregar.
 */
import { startServer, Client, randomUsername, makeTestImage, sleep } from '../tests/helpers.mjs';
import { launchChrome } from '../tests/cdp.mjs';

const server = await startServer();
const user = new Client(server.baseUrl);
await user.register({ username: randomUsername('ana') });

const browser = await launchChrome();
const page = await browser.newPage();
page.watch();
await page.goto(`${server.baseUrl}/`, { waitMs: 400 });

const login = await fetch(`${server.baseUrl}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ identifier: user.user.username, password: 'Senha@Teste123' }),
});
for (const c of login.headers.getSetCookie()) {
  const [pair] = c.split(';'); const [n, v] = pair.split('=');
  await page.send('Network.setCookie', { name: n, value: decodeURIComponent(v), domain: '127.0.0.1', path: '/' });
}
await page.send('Network.setCacheDisabled', { cacheDisabled: true });
await page.goto(`${server.baseUrl}/`, { waitMs: 400 });
await page.eval(`
  const regs = await navigator.serviceWorker.getRegistrations();
  for (const r of regs) await r.unregister();
  const keys = await caches.keys();
  for (const k of keys) await caches.delete(k);
  return true;
`);
await page.goto(`${server.baseUrl}/`, { waitMs: 1200 });

const ok = (label, value) => console.log(`  [${value ? 'OK  ' : 'FALHA'}] ${label}`);

// ================= Item 6: INICIAR LIVE =================
console.log('\n== Item 6 (INICIAR LIVE) ==');
await page.goto(`${server.baseUrl}/ao-vivo`, { waitMs: 2000 });

const liveArea = await page.eval(`
  const btn = document.querySelector('.live-start-btn');
  const card = document.querySelector('.live-start');
  if (!btn) return { found: false };
  const title = document.querySelector('.page-title');
  const btnBox = btn.getBoundingClientRect();
  const titleBox = title.getBoundingClientRect();
  const cs = getComputedStyle(btn);
  return {
    found: true,
    text: btn.innerText.trim(),
    href: btn.getAttribute('href'),
    isPrimary: btn.classList.contains('btn-primary'),
    // visivel de primeira: o bloco fica logo abaixo do titulo
    rightAfterTitle: btnBox.top - titleBox.bottom < 260,
    minHeight: Math.round(btnBox.height),
    minWidth: Math.round(btnBox.width),
    background: cs.backgroundImage.slice(0, 40),
    insideViewport: btnBox.top >= 0 && btnBox.bottom <= innerHeight,
    cardIndex: [...document.querySelectorAll('#main .page > *')].indexOf(card),
  };
`);
console.log('    ', JSON.stringify(liveArea));
ok('bloco "Sua transmissao" presente', liveArea.found);
ok(`acao visivel: "${liveArea.text}"`, liveArea.found && /INICIAR LIVE/i.test(liveArea.text));
ok('aponta para /iniciar-live', liveArea.href === '/iniciar-live');
ok('logo abaixo do titulo', liveArea.rightAfterTitle);
ok(`botao grande (${liveArea.minWidth}x${liveArea.minHeight}px)`, liveArea.minHeight >= 42 && liveArea.minWidth >= 150);
ok('dentro da tela sem rolar', liveArea.insideViewport);

// Clicar leva a tela real de transmissao (pede camera/mic de verdade).
await page.eval('document.querySelector(".live-start-btn").click(); return true;');
await sleep(2000);
const startScreen = await page.eval(`
  return {
    path: location.pathname,
    heading: document.querySelector('.page-title')?.textContent || '',
    buttons: [...document.querySelectorAll('#main button')].map((b) => b.innerText.trim()).filter(Boolean),
    hasFakeCanvas: Boolean(document.querySelector('#main canvas')),
  };
`);
console.log('    ', JSON.stringify(startScreen));
ok('navegou para a tela de transmissao', startScreen.path === '/iniciar-live');
ok('titulo "Iniciar LIVE"', /Iniciar LIVE/i.test(startScreen.heading));
ok('controle real de transmissao', startScreen.buttons.some((b) => /Iniciar transmissao/i.test(b)));
ok('sem canvas/simulacao', !startScreen.hasFakeCanvas);

// Aciona o fluxo real: o navegador concede camera/mic (--use-fake-device).
await page.eval(`
  const btn = [...document.querySelectorAll('#main button')].find((b) => /Iniciar transmissao/i.test(b.innerText));
  btn.click();
  return true;
`);
await sleep(4000);
const streaming = await page.waitForFunction(`
  const v = document.querySelector('#main video');
  if (!v || !v.videoWidth) return null;
  return {
    hasStream: Boolean(v.srcObject),
    tracks: v.srcObject ? v.srcObject.getTracks().map((t) => ({ kind: t.kind, state: t.readyState, live: t.enabled })) : [],
    w: v.videoWidth, h: v.videoHeight, paused: v.paused,
  };
`, 25000).catch((e) => ({ error: e.message }));
console.log('    ', JSON.stringify(streaming));
ok('getUserMedia devolveu MediaStream real', !streaming.error && streaming.hasStream);
ok(`video com resolucao real (${streaming.w}x${streaming.h})`, !streaming.error && streaming.w > 0);
ok('trilha de camera + audio vivas', !streaming.error
  && streaming.tracks.some((t) => t.kind === 'video' && t.live)
  && streaming.tracks.some((t) => t.kind === 'audio' && t.live));

// A LIVE existe de verdade no servidor (contador real, sem mock).
const rooms = await user.get('/api/live/discover');
const ativas = (rooms.body.live || []).map((r) => ({ id: r.id, host: r.host?.username, viewers: r.viewerCount, title: r.title }));
console.log('     servidor ao-vivo:', JSON.stringify(ativas));
ok('LIVE criada no servidor com o host real', ativas.some((r) => r.host === user.user.username));
ok('contador real = 0 com so o anfitriao (host nao conta)', ativas.some((r) => r.host === user.user.username && r.viewers === 0));

// Espectador real entrando: o contador sobe para 1.
const viewer = new Client(server.baseUrl);
await viewer.register({ username: randomUsername('espectador') });
const entrou = await viewer.post(`/api/live/${ativas[0].id}/join`, {}).catch((e) => ({ body: {}, erro: e.message }));
const depois = await user.get('/api/live/discover');
const contagem = (depois.body.live || []).find((r) => r.id === ativas[0].id);
console.log('     contador com 1 espectador:', JSON.stringify({ viewers: contagem?.viewerCount, status: entrou.status }));
ok('contador sobe para 1 com um espectador real', contagem?.viewerCount === 1);

// ================= Item 7: foto e capa =================
console.log('\n== Item 7 (foto de perfil e capa) ==');
await page.goto(`${server.baseUrl}/perfil`, { waitMs: 2000 });

const before = await page.eval(`
  return {
    avatarBtn: Boolean(document.querySelector('.profile-avatar-edit')),
    avatarBtnLabel: document.querySelector('.profile-avatar-edit')?.getAttribute('aria-label') || null,
    coverBtn: Boolean(document.querySelector('.profile-cover-edit')),
    coverBtnText: document.querySelector('.profile-cover-edit')?.textContent || null,
    coverHasImage: getComputedStyle(document.querySelector('.profile-cover')).backgroundImage !== 'none',
    avatarHasImage: Boolean(document.querySelector('.profile-head .avatar img')),
  };
`);
console.log('    ', JSON.stringify(before));
ok('botao de alterar FOTO de perfil', before.avatarBtn);
ok('botao de alterar CAPA', before.coverBtn);

// Upload real: injeta os arquivos no <input type=file> criado por pickImage.
const avatarPng = await makeTestImage({ width: 320, height: 320, color: '#ec4899' });
const coverPng = await makeTestImage({ width: 1200, height: 400, color: '#8b5cf6' });
const uploadResult = await page.eval(`
  const b64 = '${avatarPng.buffer.toString('base64')}';
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  const file = new File([bytes], 'minha-foto.png', { type: 'image/png' });

  // pickImage cria um input[type=file] no documento; clicamos no botao e
  // entregamos o arquivo nesse input (exatamente o caminho do usuario).
  const btn = document.querySelector('.profile-avatar-edit');
  btn.click();
  await new Promise((r) => setTimeout(r, 300));
  const input = [...document.querySelectorAll('input[type="file"]')].pop();
  if (!input) return { error: 'nenhum input[type=file] criado' };
  const dt = new DataTransfer();
  dt.items.add(file);
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 2500));

  const img = document.querySelector('.profile-head .avatar img');
  return {
    hasImg: Boolean(img),
    src: img?.getAttribute('src') || null,
    avatarUrlNoCache: img ? img.src.split('?')[0] : null,
  };
`);
console.log('    ', JSON.stringify(uploadResult));
ok('foto enviada e aplicada na tela', uploadResult.hasImg && /avatar|media/.test(uploadResult.src || ''));

const coverResult = await page.eval(`
  const b64 = '${coverPng.buffer.toString('base64')}';
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  const file = new File([bytes], 'minha-capa.png', { type: 'image/png' });

  document.querySelector('.profile-cover-edit').click();
  await new Promise((r) => setTimeout(r, 300));
  const input = [...document.querySelectorAll('input[type="file"]')].pop();
  const dt = new DataTransfer();
  dt.items.add(file);
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 2500));
  const bg = getComputedStyle(document.querySelector('.profile-cover')).backgroundImage;
  return { bg: bg.slice(0, 90), hasImage: bg !== 'none' && bg.includes('media') };
`);
console.log('    ', JSON.stringify(coverResult));
ok('capa enviada e aplicada na tela', coverResult.hasImage);

// Persistencia: recarrega e confere que continua la (servidor, nao cache).
await page.goto(`${server.baseUrl}/perfil`, { waitMs: 2000 });
const afterReload = await page.eval(`
  const img = document.querySelector('.profile-head .avatar img');
  const bg = getComputedStyle(document.querySelector('.profile-cover')).backgroundImage;
  return { avatar: img ? img.src.split('?')[0] : null, cover: bg.slice(0, 90), coverOk: bg.includes('media') };
`);
console.log('    apos recarregar:', JSON.stringify(afterReload));
ok('foto persiste apos recarregar', Boolean(afterReload.avatar));
ok('capa persiste apos recarregar', afterReload.coverOk);

// O servidor tem os dois arquivos de verdade.
const api = await user.get('/api/users/me');
console.log('    servidor: avatarUrl=' + api.body.user.avatarUrl + ' coverUrl=' + api.body.user.coverUrl);
ok('servidor registrou avatar', Boolean(api.body.user.avatarUrl));
ok('servidor registrou capa', Boolean(api.body.user.coverUrl));

// Os bytes servidos sao PNG reais.
const media = await fetch(`${server.baseUrl}${api.body.user.avatarUrl}`);
const bytes = Buffer.from(await media.arrayBuffer());
ok(`PNG real servido (${bytes.length} bytes, assinatura=${bytes.subarray(1, 4).toString()})`,
  bytes.subarray(1, 4).toString() === 'PNG' && bytes.length > 100);

console.log('console:', JSON.stringify(page.consoleErrors.slice(0, 5)));
ok('sem erro de console', page.consoleErrors.filter((e) => !/favicon|ERR_ABORTED/.test(e)).length === 0);

await browser.close();
await server.stop();
process.exit(0);