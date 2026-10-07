/**
 * LIVE/WebRTC sobre HTTPS (item 11): camera -> getUserMedia -> MediaStream ->
 * RTCPeerConnection -> SDP -> ICE -> video remoto.
 *
 * Nao substitui nada por simulacao: o stream vem de getUserMedia, o
 * transporte e WebRTC de verdade e o espectador recebe o video do host.
 * A correcao de "a oferta podia se perder entre o SUBSCRIBE e a criacao da
 * mesh" continua valida aqui (o espectador entra logo apos o host).
 */
import fs from 'node:fs';
import { startServer, Client, Report, randomUsername, sleep } from '../tests/helpers.mjs';
import { launchChrome } from '../tests/cdp.mjs';

const report = new Report('LIVE/WebRTC em HTTPS');

// Sem argumento: servidor proprio em HTTP (CI). Com argumento: o servidor
// HTTPS de desenvolvimento ja em execucao, que e o cenario do celular.
const ALVO = process.argv[2] || null;
const temCa = fs.existsSync('.certs/ca.crt');
const tlsWa = { ca: temCa ? fs.readFileSync('.certs/ca.crt') : undefined };
// Certificado local autoassinado: as chamadas HTTP deste teste desligam a
// validacao de CA do Node (a cadeia ja foi verificada em verify-https.mjs).
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const server = ALVO ? null : await startServer({ env: { TLS_CERT_PATH: '', TLS_KEY_PATH: '', TLS_CA_PATH: '' } });
const BASE = ALVO || server.baseUrl;
void tlsWa;

async function criarCliente(baseUrl) {
  const cli = new Client(baseUrl);
  return cli;
}

const hostCli = await criarCliente(BASE);
const viewCli = await criarCliente(BASE);
const hostUser = await hostCli.register({ username: randomUsername('host') });
const viewUser = await viewCli.register({ username: randomUsername('view') });

const browser = await launchChrome({ extraArgs: ['--ignore-certificate-errors'] });

async function sessao(u, width, height, mobile) {
  const s = await browser.newBrowserContext();
  s.watch();
  // O cookie precisa ser do host que sera acessado: com o servidor HTTPS de
  // desenvolvimento o host e `localhost`, nao `127.0.0.1`.
  const host = new URL(BASE).hostname;
  await s.goto(`${BASE}/`, { waitMs: 300 });
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: u.username, password: 'Senha@Teste123' }),
  }).catch((e) => { throw new Error(`login falhou em ${BASE}: ${e.message}`); });
  if (!r.ok) throw new Error(`login em ${BASE} devolveu HTTP ${r.status}`);
  for (const ck of r.headers.getSetCookie()) {
    const pair = ck.split(';')[0];
    const n = pair.split('=')[0];
    await s.send('Network.setCookie', { name: n, value: decodeURIComponent(pair.slice(n.length + 1)), domain: host, path: '/' });
  }
  await s.send('Network.setCacheDisabled', { cacheDisabled: true });
  await s.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
  return s;
}

try {
  const host = await sessao(hostUser, 390, 844, true);
  const viewer = await sessao(viewUser, 390, 844, true);

  await report.step('host: getUserMedia entrega video+audio reais', async () => {
    await host.goto(`${BASE}/iniciar-live`, { waitMs: 2200 });
    await host.eval(`
      const b = [...document.querySelectorAll('#main button')].find((x) => /Iniciar transmissao/i.test(x.innerText));
      b.click();
      return true;
    `);
    const st = await host.waitForFunction(`
      const v = document.querySelector('#main video');
      return v && v.videoWidth ? { w: v.videoWidth, h: v.videoHeight } : null;
    `, 25000).catch(() => null);
    if (!st) {
      const tela = await host.eval(`return (document.getElementById('main')?.innerText || '').slice(0, 160);`);
      throw new Error(`host sem preview: ${tela}`);
    }
    const tracks = await host.eval(`
      const v = document.querySelector('#main video');
      const st = v.srcObject;
      return st ? { video: st.getVideoTracks().length, audio: st.getAudioTracks().length } : null;
    `);
    if (!tracks?.video || !tracks?.audio) throw new Error(`MediaStream sem tracks: ${JSON.stringify(tracks)}`);
    return `preview ${st.w}x${st.h}, ${tracks.video} video track + ${tracks.audio} audio track`;
  });

  await sleep(3000);
  const sala = (await hostCli.get('/api/live/discover')).body.live?.[0];
  if (!sala) throw new Error('sala nao criada');

  await report.step('espectador entra e recebe o video do host via WebRTC', async () => {
    await viewer.goto(`${BASE}/live/${sala.id}`, { waitMs: 3000 });
    await viewer.eval(`
      const b = [...document.querySelectorAll('button')].find((x) => /^(Entrar|Assistir)/i.test((x.innerText || '').trim()));
      if (b) b.click();
      return true;
    `);
    await sleep(1500);
    await viewer.eval(`
      const b = [...document.querySelectorAll('button')].find((x) => /^(Entrar|Assistir)/i.test((x.innerText || '').trim()));
      if (b) b.click();
      return true;
    `);
    const st = await viewer.waitForFunction(`
      const v = document.querySelector('video');
      return v && v.videoWidth ? { w: v.videoWidth, h: v.videoHeight, tocando: !v.paused } : null;
    `, 40000).catch(() => null);
    if (!st) {
      const tela = await viewer.eval(`return (document.getElementById('main')?.innerText || '').slice(0, 200);`);
      throw new Error(`espectador sem video (a oferta pode ter se perdido): ${tela.replace(/\\s+/g, ' ')}`);
    }
    const pc = await viewer.eval(`
      return { secure: window.isSecureContext, origem: location.origin };
    `);
    return `espectador recebendo ${st.w}x${st.h} (tocando=${st.tocando}) em ${pc.origem}, seguro=${pc.secure}`;
  });

  await report.step('efeito da LIVE chega aos dois lados, sem erro de console', async () => {
    await host.eval(`
      document.querySelector('button[aria-label="Efeitos"]').click();
      return true;
    `);
    await sleep(2500);
    await host.eval(`
      document.querySelector('.modal .effect-card')?.click();
      return true;
    `);
    await sleep(2000);
    const noHost = await host.eval("return document.querySelectorAll('.live-effects .effect-instance').length;");
    const noViewer = await viewer.eval("return document.querySelectorAll('.live-effects .effect-instance').length;");
    if (noHost < 1) throw new Error('host sem instancia de efeito');
    if (noViewer < 1) throw new Error('espectador sem instancia de efeito');
    return `anfitriao=${noHost}, espectador=${noViewer}`;
  });

  await report.step('encerrar a LIVE libera conexao e nao deixa efeito pendente', async () => {
    await host.eval(`
      const b = [...document.querySelectorAll('button')].find((x) => /Encerrar/i.test(x.getAttribute('aria-label') || ''));
      if (b) b.click();
      return true;
    `);
    await sleep(1200);
    await host.eval(`
      const modal = [...document.querySelectorAll('.modal')].find((m) => /Encerrar/i.test(m.querySelector('h2')?.textContent || '')) || document.querySelector('.modal');
      const c = [...(modal?.querySelectorAll('button') || [])].find((x) => /Encerrar/i.test(x.innerText || ''));
      if (c) c.click();
      return true;
    `);
    let fim = false;
    for (let i = 0; i < 30 && !fim; i += 1) {
      fim = (await hostCli.get(`/api/live/${sala.id}`).catch(() => null))?.body?.room?.status === 'ended';
      if (!fim) await sleep(500);
    }
    if (!fim) throw new Error('a LIVE nao mudou de status para encerrada');
    await sleep(2500);
    const residuo = await host.eval(`
      return [...document.querySelectorAll('.live-effects .effect-instance')]
        .filter((n) => getComputedStyle(n).opacity !== '0').length;
    `);
    const erros = [...host.consoleErrors, ...viewer.consoleErrors].filter((e) => !/favicon|ERR_ABORTED|net::ERR/i.test(e));
    if (residuo > 0) throw new Error(`${residuo} efeito(s) residual(is)`);
    if (erros.length) throw new Error(erros.slice(0, 2).join(' | '));
    return `encerrada, ${residuo} efeito residual, ${erros.length} erro(s) de console`;
  });
} catch (err) {
  report.fail('erro inesperado', err);
}

const resumo = report.summary();
await browser.close();
if (server) await server.stop();
process.exit(resumo.failed > 0 ? 1 : 0);
