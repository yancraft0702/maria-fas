/**
 * Foco no chat (item 24): mede quem fica sob a bottom navigation e onde
 * esta o campo de mensagem, em cada largura.
 */
import { startServer, Client, randomUsername, sleep } from '../tests/helpers.mjs';
import { launchChrome } from '../tests/cdp.mjs';

const server = await startServer();
const a = new Client(server.baseUrl);
const eu = await a.register({ username: randomUsername('ana') });
const b = new Client(server.baseUrl);
const outro = await b.register({ username: randomUsername('bruno') });
const conv = await a.post('/api/conversations', { userId: outro.id });
for (const t of ['Oi! Tudo bem?', 'Vi seu ultimo video, ficou massa', 'Bora fazer uma LIVE depois?', 'Entao, manda ver!']) {
  await a.post(`/api/conversations/${conv.body.conversationId}/messages`, { body: t });
}

const browser = await launchChrome();
const page = await browser.newPage();
page.watch();
await page.goto(`${server.baseUrl}/`, { waitMs: 400 });
const login = await fetch(`${server.baseUrl}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ identifier: eu.username, password: 'Senha@Teste123' }),
});
for (const c of login.headers.getSetCookie()) {
  const [pair] = c.split(';'); const [n, v] = pair.split('=');
  await page.send('Network.setCookie', { name: n, value: decodeURIComponent(v), domain: '127.0.0.1', path: '/' });
}
await page.send('Network.setCacheDisabled', { cacheDisabled: true });
await page.goto(`${server.baseUrl}/inbox/${conv.body.conversationId}`, { waitMs: 1800 });

const LARGURAS = [[320, 640], [360, 740], [390, 844], [414, 896], [768, 1024], [1024, 900], [1440, 900]];

for (const [w, h] of LARGURAS) {
  await page.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 768 });
  await page.goto(`${server.baseUrl}/inbox/${conv.body.conversationId}`, { waitMs: 1500 });
  await sleep(300);
  const r = await page.eval(`
    const tab = document.querySelector('#tabbar');
    const tabVisivel = tab && getComputedStyle(tab).display !== 'none';
    const rt = tabVisivel ? tab.getBoundingClientRect() : null;
    const foot = document.querySelector('.chat-foot');
    const composer = document.querySelector('.composer');
    const body = document.querySelector('.chat-thread-body');
    const head = document.querySelector('.chat-thread-head');
    const desc = (n) => n ? (() => { const r = n.getBoundingClientRect();
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width) }; })() : null;
    const sobTab = [];
    if (rt) {
      for (const n of document.querySelectorAll('.chat-foot button, .chat-foot textarea, .chat-foot .composer')) {
        const r = n.getBoundingClientRect();
        if (r.height === 0) continue;
        if (r.bottom > rt.top + 1) sobTab.push(n.className || n.tagName);
      }
    }
    return {
      vw: document.documentElement.clientWidth,
      scrollW: document.documentElement.scrollWidth,
      tabTop: rt ? Math.round(rt.top) : null,
      head: desc(head), body: desc(body), foot: desc(foot), composer: desc(composer),
      sobTab,
      msgs: document.querySelectorAll('.msg').length,
      texto: document.querySelector('.chat-thread-body')?.innerText.slice(0, 40) || '',
    };
  `);
  const ok = r.sobTab.length === 0 && r.scrollW <= r.vw + 1;
  console.log(`  [${ok ? 'OK   ' : 'RUIM '}] ${String(w).padStart(4)}px  msgs=${r.msgs} scrollW=${r.scrollW} tabTop=${r.tabTop}`);
  console.log(`          head=${JSON.stringify(r.head)}`);
  console.log(`          foot=${JSON.stringify(r.foot)} composer=${JSON.stringify(r.composer)}`);
  if (r.sobTab.length) console.log(`          SOB A TABBAR: ${r.sobTab.join(', ')}`);
}

await browser.close();
await server.stop();
process.exit(0);