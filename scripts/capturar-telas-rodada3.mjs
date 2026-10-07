/**
 * Telas da rodada 3 - os 7 itens corrigidos, com estado real.
 *
 * Nada e mock: cada tela mostra o app de verdade, com usuario real, LIVE real
 * (camera falsa do Chrome), arquivo real no seletor de sistema e efeito real
 * tocando.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  startServer, Client, Report, sleep, randomUsername, makeTestImage,
} from '../tests/helpers.mjs';
import { ROOT } from '../server/config.js';
import { launchChrome } from '../tests/cdp.mjs';

const SAIDA = path.join(ROOT, 'tests', 'artifacts', 'telas-rodada3');
const TMP = path.join(ROOT, '.tmp-telas3');

const report = new Report('Telas da rodada 3');

async function run() {
  fs.mkdirSync(SAIDA, { recursive: true });
  fs.mkdirSync(TMP, { recursive: true });

  const server = await startServer();
  const api = new Client(server.baseUrl);
  const host = await api.register({ username: randomUsername('host') });
  const Cookies = async (u) => (await fetch(`${server.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: u.username, password: 'Senha@Teste123' }),
  })).headers.getSetCookie();

  const browser = await launchChrome({
    extraArgs: [
      '--autoplay-policy=no-user-gesture-required',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
    ],
  });
  const tela = async (cookies, w, h, mobile) => {
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
  const foto = async (s, nome) => {
    const { data } = await s.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SAIDA, `${nome}.png`), Buffer.from(data, 'base64'));
    report.ok(`tela: ${nome}.png`);
  };

  const telas = [];
  try {
    // ---------- ITEM 4: a aba "+" com as duas opcoes ----------
    const mob = await tela(await Cookies(host), 390, 844, true);
    telas.push(mob);
    await mob.goto(`${server.baseUrl}/`, { waitMs: 3000 });
    await mob.eval(`
      document.querySelector('#tabbar .tab-create').click();
      await new Promise((r) => setTimeout(r, 1000));
      return true;
    `);
    await foto(mob, '01-item4-mais-menu-enviar-e-gravar');
    await mob.eval('document.body.click(); return true;');

    // ---------- ITENS 1 e 7: menu de anexo do Chat Global ----------
    await mob.goto(`${server.baseUrl}/chat-global`, { waitMs: 3400 });
    await mob.eval(`
      document.querySelector('[aria-label="Anexar arquivo"]').click();
      await new Promise((r) => setTimeout(r, 800));
      return true;
    `);
    await foto(mob, '02-item1-menu-anexo-acima-da-navegacao');
    // Esc fecha o menu. Um clique no body NAO fecha: o `attachBtn` continuaria
    // com `picker` ativo e o proximo clique apenas fecharia.
    await mob.eval(`
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await new Promise((r) => setTimeout(r, 500));
      return Boolean(document.querySelector('.picker-panel'));
    `);

    // ---------- ITENS 1 e 2: anexo entregue, os dois lados ----------
    const outroCli = new Client(server.baseUrl);
    const outro = await outroCli.register({ username: randomUsername('outro') });
    const conv = await api.post('/api/conversations', { userId: outro.id });
    const img = await makeTestImage({ width: 320, height: 240, color: 'purple' });
    const imgPath = path.join(TMP, 'anexo-real.png');
    fs.writeFileSync(imgPath, img.buffer);

    await mob.eval(`
      document.querySelector('[aria-label="Anexar arquivo"]').click();
      await new Promise((r) => setTimeout(r, 800));
      const painel = document.querySelector('.picker-panel');
      if (!painel) return 'sem painel';
      [...painel.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === 'Imagem').click();
      await new Promise((r) => setTimeout(r, 500));
      return Boolean(document.querySelector('input[type="file"]'));
    `);
    const doc = await mob.send('DOM.getDocument', { depth: -1 });
    const achou = await mob.send('DOM.querySelector', {
      nodeId: doc.root.nodeId, selector: 'input[type="file"]',
    });
    if (achou.nodeId) {
      await mob.send('DOM.setFileInputFiles', { files: [imgPath], nodeId: achou.nodeId });
      await sleep(4000);
    }
    await foto(mob, '03-item2-anexo-publicado-no-chat-global');

    // o outro usuario vendo em tempo real
    const esp = await tela(await Cookies(outro), 390, 844, true);
    telas.push(esp);
    await esp.goto(`${server.baseUrl}/chat-global`, { waitMs: 3600 });
    await foto(esp, '04-item2-anexo-recebido-em-realtime');

    // ---------- ITEM 7: teclado virtual aberto ----------
    await mob.eval(`
      const campo = document.querySelector('.chat-foot textarea');
      campo.focus();
      return true;
    `);
    await mob.send('Runtime.evaluate', {
      expression: `(() => {
        Object.defineProperty(window.visualViewport, 'height', { value: 508, configurable: true });
        Object.defineProperty(window.visualViewport, 'offsetTop', { value: 0, configurable: true });
        window.visualViewport.dispatchEvent(new Event('resize'));
        return true;
      })()`,
      returnByValue: true,
    });
    await sleep(900);
    await foto(mob, '05-item7-composer-acima-do-teclado');

    // ---------- ITEM 3: video gravado publicado ----------
    const rec = await tela(await Cookies(host), 390, 844, true);
    telas.push(rec);
    await rec.goto(`${server.baseUrl}/criar`, { waitMs: 3200 });
    await rec.eval(`
      document.querySelector('[aria-label="Gravar"]').click();
      return true;
    `);
    await sleep(4200);
    await rec.eval(`
      const b = document.querySelector('[aria-label="Gravar"]');
      if (/Parar/.test(b.textContent || '')) b.click();
      return true;
    `);
    await sleep(3000);
    await foto(rec, '06-item3-video-gravado-no-editor');
    await rec.eval(`
      const publicar = [...document.querySelectorAll('button.btn-solid')].find((b) => /Publicar/.test(b.textContent || ''));
      publicar.click();
      await new Promise((r) => setTimeout(r, 1200));
      const legenda = document.querySelector('.modal textarea');
      if (legenda) legenda.value = 'video gravado pelo botao +';
      const ok = [...document.querySelectorAll('.modal button')].find((b) => /^Publicar/.test((b.textContent || '').trim()));
      if (ok) ok.click();
      return true;
    `);
    await sleep(26000);
    const onde = await rec.eval('return location.pathname;');
    report.ok(`item 3: publicacao levou a ${onde}`);
    await rec.goto(`${server.baseUrl}/`, { waitMs: 4200 });
    await foto(rec, '07-item3-video-gravado-no-feed');

    // ---------- ITENS 5 e 6: camera natural + efeitos novos ----------
    const live = await tela(await Cookies(host), 1280, 900, false);
    telas.push(live);
    await live.goto(`${server.baseUrl}/iniciar-live`, { waitMs: 2600 });
    await live.eval(`
      const b = [...document.querySelectorAll('button')].find((x) => /iniciar transmissao/i.test(x.textContent || ''));
      if (b) b.click();
      return true;
    `);
    await sleep(6200);
    await foto(live, '08-item5-camera-enquadramento-natural');

    const sala = (await api.get(`/api/users/${host.id}/live`)).body.live;
    if (sala?.id) {
      const espLive = await tela(await Cookies(outro), 1280, 900, false);
      telas.push(espLive);
      await espLive.goto(`${server.baseUrl}/live/${sala.id}`, { waitMs: 4200 });
      await foto(espLive, '09-item5-espectador-enquadramento-natural');

      // Dispara presentes do catálogo atual para conferir a renderização.
      const catalogo = await api.get('/api/live/effects');
      const lista = catalogo.body.effects || [];
      const shooter = await tela(await Cookies(host), 390, 844, true);
      telas.push(shooter);
      await shooter.goto(`${server.baseUrl}/live/${sala.id}`, { waitMs: 4200 });

      for (const slug of ['rosa-premium', 'fogos-de-artificio', 'notas-musicais']) {
        const efeito = lista.find((e) => e.slug === slug);
        if (!efeito) continue;
        // eslint-disable-next-line no-await-in-loop
        await shooter.eval(`
          const csrf = (document.cookie.split(';').find((c) => c.trim().startsWith('pulse_csrf=')) || '').split('=')[1] || '';
          const resp = await fetch('/api/live/${sala.id}/effects', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': decodeURIComponent(csrf) },
            body: JSON.stringify({ effectId: ${JSON.stringify(efeito.id)}, clientEventId: 'tela3-${slug}' }),
          });
          return resp.status;
        `);
        await sleep(1500);
        // eslint-disable-next-line no-await-in-loop
        await foto(live, `10-item6-novo-efeito-${slug}`);
        await sleep(2600);
      }
    }

    // ---------- ITEM 6: o menu com os 15 presentes autorais ----------
    await live.eval(`
      const b = [...document.querySelectorAll('button')].find((x) => /Efeitos/i.test(x.getAttribute('aria-label') || ''));
      if (b) b.click();
      await new Promise((r) => setTimeout(r, 1200));
      return true;
    `);
    await foto(live, '11-item6-menu-com-15-presentes');

    report.ok(`${telas.length} tela(s) capturada(s) em tests/artifacts/telas-rodada3`);
  } catch (error) {
    report.fail('captura interrompida', error);
  } finally {
    for (const s of telas) { try { s.close?.(); } catch { /* ignore */ } }
    await browser.close();
    await server.stop();
  }
  return report.summary();
}

run().then((r) => process.exit(r.failed > 0 ? 1 : 0)).catch((e) => { console.error(e); process.exit(1); });