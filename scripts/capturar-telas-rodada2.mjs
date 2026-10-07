/**
 * Capturas visuais da rodada (itens 1, 2, 5/6, 7, 9, 21, 22 e 30).
 *
 * Nao e teste: e a PROVA visual de que o que os verificadores mediram aparece
 * na tela. As imagens vao para `tests/artifacts/telas-rodada2/`.
 *
 * A safe-area de um iPhone e injetada (`--safe-t`/`--safe-b`), porque o Chrome
 * headless reporta `env(safe-area-inset-*) = 0` e sem isso a captura nao
 * mostraria a situacao real do aparelho.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  startServer, Client, Report, sleep, randomUsername, makeTestAudio, makeTestVideo,
} from '../tests/helpers.mjs';
import { ROOT } from '../server/config.js';
import { launchChrome } from '../tests/cdp.mjs';

const report = new Report('Capturas visuais da rodada');
const SAIDA = path.resolve(ROOT, 'tests', 'artifacts', 'telas-rodada2');

const APLICAR_SAFE_AREA = `
  const r = document.documentElement.style;
  r.setProperty('--safe-t', '47px');
  r.setProperty('--safe-b', '34px');
  return true;
`;

async function run() {
  fs.mkdirSync(SAIDA, { recursive: true });
  const server = await startServer();
  const api = new Client(server.baseUrl);

  const host = await api.register({ username: randomUsername('host') });
  // Cada usuario precisa do PROPRIO cliente: com o mesmo cliente, o segundo
  // registro sobrescreve a sessao e a conversa vira "consigo mesmo" (400).
  const espCli = new Client(server.baseUrl);
  const esp = await espCli.register({ username: randomUsername('esp') });
  const pessoaCli = new Client(server.baseUrl);
  const pessoa = await pessoaCli.register({ username: randomUsername('alvo') });
  const { makeTestImage } = await import('../tests/helpers.mjs');
  const avatar = await makeTestImage({ width: 160, height: 160 });
  await pessoaCli.upload('/api/users/me/avatar', avatar.buffer, { filename: avatar.filename, mime: avatar.mime });

  // Conteudo real: audio publicado, conversa privada com audio, global.
  const audio = await makeTestAudio({ seconds: 9 });
  const upAudio = await api.upload('/api/media/upload?purpose=audio', audio.buffer, {
    filename: audio.filename, mime: audio.mime,
  });
  const postAudio = await api.post('/api/posts', {
    type: 'audio', mediaId: upAudio.body.media.id, caption: 'audio gravado',
  });
  const video = await makeTestVideo({ seconds: 20, width: 480, height: 854, withAudio: true });
  const upVideo = await api.upload('/api/media/upload?purpose=video', video.buffer, {
    filename: video.filename, mime: video.mime,
  });
  await api.post('/api/posts', {
    type: 'video', caption: 'um video sobre maquiagem e viagem #maquiagem #viagem',
    mediaId: upVideo.body.media.id,
  });

  const conv = await api.post('/api/conversations', { userId: esp.id });
  const convId = conv.body.conversationId;
  if (!convId) {
    throw new Error(`a conversa nao foi criada (${conv.status}): ${JSON.stringify(conv.body).slice(0, 200)}`);
  }
  // Confirma que o host consegue abrir a conversa: sem isso a tela cairia no
  // /inbox sem conversa e a captura mostraria a lista vazia.
  const conversa = await api.get(`/api/conversations/${convId}`, { limit: 5 });
  if (!conversa.body?.conversation?.id) {
    throw new Error(`GET /api/conversations/${convId} nao devolveu a conversa `
      + `(${conversa.status}): ${JSON.stringify(conversa.body).slice(0, 200)}`);
  }
  for (let i = 0; i < 10; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await api.post(`/api/conversations/${convId}/messages`, {
      type: 'text', body: `Mensagem ${i} com texto suficiente para encher a conversa.`,
    });
    // eslint-disable-next-line no-await-in-loop
    await espCli.post(`/api/conversations/${convId}/messages`, { type: 'text', body: `Resposta ${i}.` });
  }
  const upDm = await api.upload('/api/chat/upload?purpose=audio', audio.buffer, {
    filename: audio.filename, mime: audio.mime,
  });
  await api.post(`/api/conversations/${convId}/messages`, {
    type: 'audio', body: '', mediaId: upDm.body.media.id,
  });
  for (let i = 0; i < 4; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await api.post('/api/chat/global', { body: `Ola, chat global ${i}!` });
  }

  const cookies = await fetch(`${server.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: host.username, password: 'Senha@Teste123' }),
  }).then((r) => r.headers.getSetCookie());

  const browser = await launchChrome({
    extraArgs: [
      '--autoplay-policy=no-user-gesture-required',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
    ],
  });
  const feito = [];
  const s = await browser.newBrowserContext();
  s.watch();
  const capturar = async (nome) => {
    const { data } = await s.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SAIDA, `${nome}.png`), Buffer.from(data, 'base64'));
    feito.push(nome);
  };
  const irPara = async (url, w, h, mobile) => {
    await s.goto(`${server.baseUrl}/`, { waitMs: 250 });
    await s.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile });
    await s.goto(`${server.baseUrl}${url}`, { waitMs: 2400 });
    await s.eval(APLICAR_SAFE_AREA);
    await sleep(1600);
  };

  try {
    await s.goto(`${server.baseUrl}/`, { waitMs: 300 });
    for (const ck of cookies) {
      const par = ck.split(';')[0];
      const nome = par.slice(0, par.indexOf('='));
      await s.send('Network.setCookie', {
        name: nome, value: decodeURIComponent(par.slice(nome.length + 1)),
        domain: '127.0.0.1', path: '/',
      });
    }

    // ---- item 1: topo com o botao de Chat Global (mobile e desktop) -------
    await irPara('/', 390, 844, true);
    await capturar('01-topo-mobile-chat-global');
    await irPara('/', 1280, 900, false);
    await capturar('02-topo-desktop-chat-global');

    // ---- item 29: chat global aberto --------------------------------------
    await irPara('/chat-global', 390, 844, true);
    // Digita de verdade: sem despachar `input`, o auto-crescimento do campo
    // (que existe em `createComposer`) nao roda e a captura mostraria o texto
    // cortado - artefato da captura, nao da tela.
    await s.eval(`
      const campo = document.querySelector('.composer textarea, .composer input');
      if (!campo) return 'sem campo';
      campo.focus();
      campo.value = 'Mensagem de teste no chat global';
      campo.dispatchEvent(new Event('input', { bubbles: true }));
      return 'digitou';
    `);
    await sleep(900);
    await capturar('03-chat-global-mobile');
    await irPara('/chat-global', 1280, 900, false);
    await capturar('04-chat-global-desktop');

    // ---- item 30: conversa privada, fim da rolagem (sem vazio preto) ------
    await irPara(`/inbox/${convId}`, 390, 844, true);
    // A conversa abre depois do fetch da lista: espera o corpo aparecer.
    for (let i = 0; i < 16; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const pronto = await s.eval("return Boolean(document.querySelector('.chat-thread-body'));");
      if (pronto) break;
      // eslint-disable-next-line no-await-in-loop
      await sleep(700);
    }
    await capturar('05-conversa-privada-mobile');
    await s.eval(`
      const c = document.querySelector('.chat-thread-body');
      if (!c) return 'sem corpo da conversa';
      c.scrollTop = c.scrollHeight;
      return 'rolou';
    `);
    await sleep(1100);
    await capturar('06-conversa-privada-fim-da-rolagem');
    await irPara(`/inbox/${convId}`, 1280, 900, false);
    await capturar('07-conversa-privada-desktop');

    // ---- item 21/22: busca ------------------------------------------------
    await irPara('/busca', 390, 844, true);
    await s.eval(`
      const campo = document.querySelector('input[type="search"]');
      campo.focus();
      campo.value = ${JSON.stringify(pessoa.username)};
      campo.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    `);
    await sleep(2400);
    await capturar('08-busca-pessoa');
    await s.eval(`
      const campo = document.querySelector('input[type="search"]');
      campo.value = 'maquiagem';
      campo.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    `);
    await sleep(2400);
    await capturar('09-busca-palavra');

    // ---- item 2: audio publicado ------------------------------------------
    await irPara(`/video/${postAudio.body.post.id}`, 390, 844, true);
    await sleep(1800);
    await capturar('10-audio-publicado-mobile');

    // ---- itens 5/6/7/9: LIVE com efeito e menu compacto -------------------
    await irPara('/iniciar-live', 390, 844, true);
    await s.eval(`
      const b = [...document.querySelectorAll('button')].find((x) => /iniciar transmissao/i.test(x.textContent || ''));
      if (b) b.click();
      return true;
    `);
    await sleep(6000);
    await s.eval(`
      const b = document.querySelector('.live-heart-btn');
      if (b) { b.click(); b.click(); b.click(); }
      return true;
    `);
    await sleep(900);
    // Aplica um efeito COM som pelo endpoint, pela mesma via que a UI usa.
    const catalogo = await api.get('/api/live/effects');
    const comSom = (catalogo.body.effects || []).filter((e) => e.hasAudio);
    const sala = (await api.get(`/api/users/${host.id}/live`)).body.live;
    const efeitos = await api.get(`/api/live/${sala.id}/effects`);
    void efeitos;
    const escId = comSom[0]?.id;
    if (escId) {
      await s.eval(`
        const csrf = (document.cookie.split(';').find((c) => c.trim().startsWith('pulse_csrf=')) || '').split('=')[1] || '';
        const r = await fetch('/api/live/${sala.id}/effects', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': decodeURIComponent(csrf) },
          body: JSON.stringify({ effectId: ${JSON.stringify(escId)}, clientEventId: 'captura-1' }),
        });
        return r.status;
      `);
      await sleep(1200);
      await capturar('11-live-host-efeito-coracao-mobile');
    }
    // Menu de efeitos compacto.
    await s.eval(`
      document.querySelector('.live-effects-btn')?.click();
      return true;
    `);
    await sleep(1600);
    await capturar('12-live-menu-efeitos-mobile');
    await s.eval(`
      const campo = document.querySelector('.effect-picker-busca');
      if (campo) {
        campo.focus();
        campo.value = 'a';
        campo.dispatchEvent(new Event('input', { bubbles: true }));
      }
      return true;
    `);
    await sleep(900);
    await capturar('13-live-menu-efeitos-busca-teclado');
    await s.eval(`
      document.querySelector('.modal-backdrop')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return true;
    `);
    await sleep(500);

    // Mesma LIVE, agora no desktop, com o efeito visivel sobre o video.
    const s2 = await browser.newBrowserContext();
    s2.watch();
    await s2.goto(`${server.baseUrl}/`, { waitMs: 300 });
    for (const ck of cookies) {
      const par = ck.split(';')[0];
      const nome = par.slice(0, par.indexOf('='));
      await s2.send('Network.setCookie', {
        name: nome, value: decodeURIComponent(par.slice(nome.length + 1)),
        domain: '127.0.0.1', path: '/',
      });
    }
    await s2.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await s2.goto(`${server.baseUrl}/live/${sala.id}`, { waitMs: 4000 });
    await s2.eval(`
      const csrf = (document.cookie.split(';').find((c) => c.trim().startsWith('pulse_csrf=')) || '').split('=')[1] || '';
      const efeitos = await fetch('/api/live/effects').then((r) => r.json());
      const comSom = (efeitos.effects || []).filter((e) => e.hasAudio);
      await fetch('/api/live/${sala.id}/effects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': decodeURIComponent(csrf) },
        body: JSON.stringify({ effectId: comSom[1].id, clientEventId: 'captura-2' }),
      });
      return true;
    `);
    await sleep(1800);
    const { data } = await s2.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SAIDA, '14-live-espectador-desktop-efeito.png'), Buffer.from(data, 'base64'));
    feito.push('14-live-espectador-desktop-efeito');
    // Menu compacto no desktop.
    await s2.eval(`
      document.querySelector('.live-effects-btn')?.click();
      return true;
    `);
    await sleep(1800);
    const m2 = await s2.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SAIDA, '15-live-menu-efeitos-desktop.png'), Buffer.from(m2.data, 'base64'));
    feito.push('15-live-menu-efeitos-desktop');
    try { s2.close?.(); } catch { /* ignore */ }

    report.ok(`${feito.length} capturas em tests/artifacts/telas-rodada2: ${feito.join(', ')}`);
  } catch (error) {
    report.fail('capturas interrompidas', error);
  } finally {
    try { s.close?.(); } catch { /* ignore */ }
    await browser.close();
    await server.stop();
  }
  return report.summary();
}

run().then((r) => process.exit(r.failed > 0 ? 1 : 0)).catch((e) => { console.error(e); process.exit(1); });