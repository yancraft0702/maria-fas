/**
 * Verificacao visual rapida (itens 3, 5, 8, 9, 13, 14, 15).
 * Sobe a aplicacao real e confere o que mudou na interface.
 */
import { startServer, Client, makeTestVideo, randomUsername, waitUntil, sleep } from '../tests/helpers.mjs';
import { launchChrome } from '../tests/cdp.mjs';

const server = await startServer();
const author = new Client(server.baseUrl);
await author.register({ username: randomUsername('ana') });

// Conteudo real: 1 video processado + 5 textos.
const video = await makeTestVideo({ seconds: 2, width: 480, height: 854, withAudio: true });
const up = await author.upload('/api/media/upload?purpose=video', video.buffer, {
  filename: video.filename, mime: video.mime,
});
await waitUntil(async () => {
  const { body } = await author.get(`/api/media/${up.body.media.id}/status`);
  return body.media.status === 'ready' ? body.media : null;
}, { timeoutMs: 120000, intervalMs: 800 });
await author.post('/api/posts', { type: 'video', mediaId: up.body.media.id, caption: 'video real #pulse' });
for (let i = 0; i < 5; i += 1) {
  await author.post('/api/posts', { type: 'text', caption: `texto ${i} #pulse` });
}

const sessions = [];
const browser = await launchChrome();
const page = await browser.newPage();
page.watch();
await page.goto(`${server.baseUrl}/`, { waitMs: 500 });

/**
 * O service worker faz precache do shell: sem limpar, o navegador continuaria
 * servindo o CSS/JS antigo e a verificacao mediria a versao anterior.
 */
async function freshLoad(session, path = '/', wait = 0) {
  await session.eval(`
    const regs = await navigator.serviceWorker.getRegistrations();
    for (const r of regs) await r.unregister();
    const keys = await caches.keys();
    for (const k of keys) await caches.delete(k);
    return true;
  `).catch(() => { /* sem SW: segue */ });
  await session.send('Network.setCacheDisabled', { cacheDisabled: true });
  await session.goto(`${server.baseUrl}${path}`, { waitMs: 1200 });
  await session.send('Network.setCacheDisabled', { cacheDisabled: false });
  if (wait) await sleep(wait);
}

// Login no navegador
const login = await fetch(`${server.baseUrl}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ identifier: author.user.username, password: 'Senha@Teste123' }),
});
for (const cookie of login.headers.getSetCookie()) {
  const [pair] = cookie.split(';');
  const [name, value] = pair.split('=');
  await page.send('Network.setCookie', { name, value: decodeURIComponent(value), domain: '127.0.0.1', path: '/' });
}
await page.goto(`${server.baseUrl}/`, { waitMs: 400 });
await freshLoad(page, '/', 2500);

const ok = (label, value) => console.log(`  [${value ? 'OK  ' : 'FALHA'}] ${label}`);
const report4 = async (label, fn) => {
  try {
    const detail = await fn();
    ok(label, true);
    console.log('       ->', detail);
  } catch (err) {
    ok(`${label}: ${err.message}`, false);
  }
};

const initial = await page.eval(`
  const api = await window.__PULSE_DEBUG__.api.get('/api/feed/for-you');
  return {
    slides: document.querySelectorAll('.slide').length,
    apiPosts: (api.posts || []).length,
    emptyText: document.querySelector('.page-empty')?.innerText?.slice(0, 60) || null,
    authed: document.querySelector('#side-nav a')?.textContent || null,
  };
`);
console.log('  (diagnostico inicial:', JSON.stringify(initial), ')');

// ---- Item 9: sem barra grande, com lupa nas abas
const search = await page.eval(`
  return {
    bigBar: Boolean(document.querySelector('#search-form')),
    tabs: [...document.querySelectorAll('.feed-tabs [role="tab"]')].map((t) => t.textContent),
    lupa: Boolean(document.querySelector('.feed-tabs .feed-search-btn')),
    lupaLabel: document.querySelector('.feed-tabs .feed-search-btn')?.getAttribute('aria-label') || null,
    topbarIcons: document.querySelectorAll('.topbar-actions .icon-btn').length,
  };
`);
console.log('\n== Item 9 (busca compacta) ==');
ok('barra grande removida', !search.bigBar);
ok(`abas = ${search.tabs.join(' / ')}`, search.tabs.length === 3);
ok(`lupa presente (${search.lupaLabel})`, search.lupa);

// ---- Item 8: rail removido
console.log('\n== Item 8 (5 icones removidos) ==');
ok('rail ausente', (await page.eval('return document.querySelectorAll(".rail").length;')) === 0);
ok('sidebar intacta', (await page.eval('return document.querySelectorAll("#side-nav a").length;')) > 0);

// ---- Item 4: video real tocando (com audio) ----
await report4('navega ate o video com a seta (como o usuario faz)', async () => {
  const index = await page.eval(`
    const slides = [...document.querySelectorAll('.slide')];
    return slides.findIndex((s) => s.querySelector('video'));
  `);
  if (index < 0) throw new Error('nenhum slide com video no feed');
  const activeBefore = await page.eval('return document.querySelectorAll(".slide.active").length;');
  for (let i = 0; i < index; i += 1) {
    // Seta para baixo: e o caminho real de navegacao do feed.
    await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
    await sleep(450);
  }
  return `${index} passo(s) ate o video (slides ativos antes: ${activeBefore})`;
});

const videoState = await page.waitForFunction(`
  const v = document.querySelector('.slide.active video');
  if (!v || v.readyState < 2) return null;
  return {
    readyState: v.readyState, w: v.videoWidth, h: v.videoHeight,
    paused: v.paused, muted: v.muted, currentTime: v.currentTime,
    soundBtn: document.querySelector('.slide.active .act[aria-label="Ativar som"], .slide.active .act[aria-label="Desativar som"]')
      ?.getAttribute('aria-label') || null,
  };
`, 20000).catch((e) => ({ error: e.message }));
console.log('     ', JSON.stringify(videoState));
ok('video carregou (readyState>=2)', !videoState.error && videoState.readyState >= 2);
ok('video reproduzindo', !videoState.error && !videoState.paused);
ok('tempo avancando', !videoState.error && videoState.currentTime > 0);
ok(`botao de som presente (${videoState.soundBtn})`, Boolean(videoState.soundBtn));

// Primeira interacao real liga o audio (o navegador so permite com gesto).
const afterTap = await page.eval(`
  const slide = document.querySelector('.slide.active');
  const v = slide.querySelector('video');
  const box = slide.getBoundingClientRect();
  return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
`);
await page.mouse('mousePressed', afterTap.x, afterTap.y);
await page.mouse('mouseReleased', afterTap.x, afterTap.y);
await sleep(600);
const soundState = await page.eval(`
  const slide = document.querySelector('.slide.active');
  const v = slide.querySelector('video');
  const btn = slide.querySelector('.act[aria-label="Ativar som"], .act[aria-label="Desativar som"]');
  return { muted: v.muted, paused: v.paused, btn: btn?.getAttribute('aria-label') || null };
`);
console.log('     apos 1o clique:', JSON.stringify(soundState));
ok('1a interacao habilita o som', soundState.muted === false);

// O botao alterna o som (ativar/desativar) e o clique normal faz play/pause.
const toggles = await page.eval(`
  const slide = document.querySelector('.slide.active');
  const v = slide.querySelector('video');
  const findBtn = () => slide.querySelector(
    '.act[aria-label="Ativar som"], .act[aria-label="Desativar som"]'
  );
  const out = { steps: [] };

  out.steps.push({ acao: 'inicial', muted: v.muted, paused: v.paused });

  findBtn().click();                       // desliga o som
  await new Promise((r) => setTimeout(r, 350));
  out.steps.push({ acao: 'botao', muted: v.muted, label: findBtn().getAttribute('aria-label') });

  findBtn().click();                       // religa o som
  await new Promise((r) => setTimeout(r, 350));
  out.steps.push({ acao: 'botao', muted: v.muted, label: findBtn().getAttribute('aria-label') });

  v.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 300));
  out.steps.push({ acao: 'clique no video', paused: v.paused });

  v.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 300));
  out.steps.push({ acao: 'clique no video', paused: v.paused });
  return out;
`);
console.log('     ', JSON.stringify(toggles.steps));
ok('botao desativa o som', toggles.steps[1].muted === true);
ok('botao reativa o som', toggles.steps[2].muted === false);
ok('clique pausa', toggles.steps[3].paused === true);
ok('clique retoma', toggles.steps[4].paused === false);

// ---- Item 5: abas do feed
console.log('\n== Item 5 (abas nao perdem conteudo) ==');
const beforeTabs = await page.eval('return document.querySelectorAll(".slide").length;');
const cycle = await page.eval(`
  const tab = (label) => [...document.querySelectorAll('.feed-tabs [role="tab"]')]
    .find((t) => t.textContent.trim() === label);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const labels = [];
  for (const name of ['Seguindo', 'Amigos', 'Para voce']) {
    const b = tab(name);
    if (!b) continue;
    const before = document.querySelectorAll('.slide').length;
    b.click();
    await wait(1600);
    let apiOk = null;
    try {
      const r = await window.__PULSE_DEBUG__.api.get('/api/feed/for-you');
      apiOk = (r.posts || []).length;
    } catch (e) { apiOk = 'erro: ' + e.code; }
    labels.push({
      name,
      before,
      slides: document.querySelectorAll('.slide').length,
      empty: Boolean(document.querySelector('.page-empty')),
      emptyText: document.querySelector('.page-empty')?.innerText?.slice(0, 50) || '',
      apiForYou: apiOk,
    });
  }
  return labels;
`);
for (const item of cycle) {
  console.log(`     ${item.name}: antes=${item.before} -> ${item.slides} slide(s), vazio=${item.empty}, api(for_you)=${item.apiForYou} ${JSON.stringify(item.emptyText)}`);
}
console.log('     console:', JSON.stringify(page.consoleErrors.slice(-4)));
const backToYou = cycle.find((c) => c.name === 'Para voce');
ok('"Para voce" recarrega ao voltar', backToYou && backToYou.slides >= beforeTabs - 1);

// ---- Item 3: aviso de push
console.log('\n== Item 3 (aviso de push) ==');
const push = await page.eval(`
  const p = document.getElementById('push-prompt');
  const dismiss = document.getElementById('push-dismiss');
  const accept = document.getElementById('push-accept');
  return {
    exists: Boolean(p),
    hiddenInitially: p ? p.hidden : null,
    displayHidden: p ? getComputedStyle(p).display : null,
    hasDismiss: Boolean(dismiss), hasAccept: Boolean(accept),
  };
`);
console.log('    ', JSON.stringify(push));
ok('aviso existe com os 2 botoes', push.exists && push.hasDismiss && push.hasAccept);
ok(`aviso aparece quando debido (display=${push.displayHidden})`, push.displayHidden !== 'none');
const pushFlow = await page.eval(`
  const p = document.getElementById('push-prompt');
  const dismiss = document.getElementById('push-dismiss');
  const accept = document.getElementById('push-accept');
  p.hidden = false;
  dismiss.click();
  await new Promise((r) => setTimeout(r, 200));
  const afterDismiss = { hidden: p.hidden, display: getComputedStyle(p).display, stored: localStorage.getItem('pulse_push_dismissed') };

  p.hidden = false;
  accept.click();
  await new Promise((r) => setTimeout(r, 900));
  const afterAccept = {
    hidden: p.hidden,
    display: getComputedStyle(p).display,
    acceptDisabled: accept.disabled,
    acceptText: accept.textContent,
    permission: Notification.permission,
  };
  return { afterDismiss, afterAccept };
`);
console.log('    dismiss:', JSON.stringify(pushFlow.afterDismiss));
console.log('    accept :', JSON.stringify(pushFlow.afterAccept));
ok('"Agora nao" fecha o aviso', pushFlow.afterDismiss.hidden && pushFlow.afterDismiss.display === 'none');
ok('"Ativar" fecha o aviso', pushFlow.afterAccept.hidden && pushFlow.afterAccept.display === 'none');
ok('botao "Ativar" volta a funcionar', !pushFlow.afterAccept.acceptDisabled);

// ---- Itens 13/14/15: tela de entrada
console.log('\n== Itens 13/14/15 (entrada MARIA FÃS + coracao) ==');
const entry = await page.eval(`
  const res = await fetch('/entrar');
  const html = await res.text();
  return { status: res.status };
`);
// Contexto isolado: SEM cookies, para ver a tela de entrada real.
// (No mesmo contexto a sessao logada abriria /configuracoes em vez do login.)
const auth = await browser.newBrowserContext();
auth.watch();
await auth.goto(`${server.baseUrl}/`, { waitMs: 400 });
await freshLoad(auth, '/configuracoes', 1200);
await auth.waitForFunction('return Boolean(document.querySelector(".brand-heart"));', 20000);
const loginScreen = await auth.eval(`
  return {
    title: document.title,
    heart: Boolean(document.querySelector('.brand-heart')),
    wordmark: document.querySelector('.brand-wordmark')?.textContent || null,
    heartAnim: getComputedStyle(document.querySelector('.brand-heart')).animationName,
    logoAnim: getComputedStyle(document.querySelector('.brand-logo')).animationName,
    inputs: [...document.querySelectorAll('.auth-card input:not([hidden])')].map((i) => i.id),
    labels: [...document.querySelectorAll('.auth-card label')].map((l) => l.textContent.replace(':','')),
  };
`);
console.log('    ', JSON.stringify(loginScreen));
ok('titulo = MARIA FÃS', loginScreen.title.includes('MARIA FÃS'));
ok('coracao animado presente', loginScreen.heart && loginScreen.heartAnim !== 'none');
ok('entrada suave da logo', loginScreen.logoAnim !== 'none');
ok('wordmark MARIA FÃS', loginScreen.wordmark === 'MARIA FÃS');
ok('sem campo de email', !loginScreen.inputs.some((i) => i.includes('email')));
ok(`campos = ${loginScreen.labels.join(' | ')}`, loginScreen.labels.length >= 2);

// ---- Item 11: paleta
console.log('\n== Item 11 (identidade visual) ==');
const palette = await page.eval(`
  const cs = getComputedStyle(document.documentElement);
  return {
    brand: cs.getPropertyValue('--brand').trim(),
    roxo: cs.getPropertyValue('--roxo').trim(),
    rosa: cs.getPropertyValue('--rosa').trim(),
    vermelho: cs.getPropertyValue('--vermelho').trim(),
    bg: cs.getPropertyValue('--bg').trim(),
    fg: cs.getPropertyValue('--fg').trim(),
  };
`);
console.log('    ', JSON.stringify(palette));
ok('roxo/rosa/vermelho + preto/branco', palette.roxo && palette.rosa && palette.vermelho && palette.bg === '#07060b' && palette.fg === '#fff');

// ---- Item 19: responsividade
console.log('\n== Item 12 (responsividade) ==');
const widths = [320, 390, 768, 1024, 1440, 1920];
const offenders = [];
for (const w of widths) {
  await auth.send('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: 1, mobile: w < 768 });
  await freshLoad(auth, '/', 800);
  const r = await auth.eval(`
    const de = document.documentElement;
    return { sw: de.scrollWidth, cw: de.clientWidth };
  `);
  if (r.sw > r.cw + 2) offenders.push(`${w}px (${r.sw}>${r.cw})`);
}
ok(`sem rolagem horizontal em ${widths.length} larguras`, offenders.length === 0);
if (offenders.length) console.log('     ', offenders.join(', '));

// ---- Erros de console
const errs = app_console(page);
function app_console(p) {
  return p.consoleErrors.filter((e) => !/favicon|net::ERR_ABORTED|Content Security Policy/i.test(e));
}
ok('sem erro de console inesperado', app_console(page).length === 0);
if (app_console(page).length) console.log('     ', app_console(page).slice(0, 3));

await browser.close();
await server.stop();
process.exit(0);