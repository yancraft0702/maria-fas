/**
 * Verificador do DIAGNOSTICO DA CAMERA - prova que o comparador "A) captura"
 * contra "B) renderizacao" funciona de verdade.
 *
 * O problema que motivou isto: a camera FALSA do Chrome obedece qualquer
 * constraint, entao os testes automatizados nunca enxergam o crop interno que
 * o driver de um celular real faz. Passar 19/19 nao prova que o celular real
 * esteja certo. Este verificador nao tenta provar isso - ele prova que o
 * INSTRUMENTO de diagnostico mede as duas coisas separadamente, que e o que
 * permite descobrir no aparelho.
 *
 * Tres partes:
 *
 *   1. CAPTURA SEM PROPORCAO FORCADA: a constraint nao pede resolucao nem
 *      proporcao. O driver escolhe o modo natural da camera.
 *   2. INSTRUMENTO FUNCIONA: com o quadro portrait na viewport portrait, o
 *      veredito tem de ser A (captura) com diferenca baixa - porque o `cover`
 *      encolhe o quadro e nao amplia. Um veredito B aqui indicaria que o
 *      comparador acusaria um zoom que nao existe.
 *   3. INSTRUMENTO DETECTA ZOOM REAL: injetando um `transform: scale()` no
 *      `<video>`, o mesmo comparador tem de virar B (renderizacao). Se
 *      continuasse em A, o instrumento seria inutil - e o teste falha.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  startServer, Client, Report, sleep, randomUsername,
} from '../tests/helpers.mjs';
import { ROOT } from '../server/config.js';
import { launchChrome } from '../tests/cdp.mjs';

const SAIDA = path.join(ROOT, 'tests', 'artifacts', 'telas-rodada4');

const report = new Report('LIVE: diagnostico da camera (captura vs exibicao)');

const CENARIOS = [
  [390, 844, true, 'celular em retrato'],
  [1280, 900, false, 'desktop'],
];

async function run() {
  fs.mkdirSync(SAIDA, { recursive: true });
  const server = await startServer();
  const api = new Client(server.baseUrl);
  const browser = await launchChrome({
    extraArgs: [
      '--autoplay-policy=no-user-gesture-required',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
    ],
  });
  const telas = [];

  // `s.eval` ja embrulha o texto em `(async () => { ... })()`, entao este corpo
// pode usar `await` e `return` direto. Devolve so dados planos - canvas nao e
// serializavel por `returnByValue`.
const COMPARAR = `
    const mod = await import('/js/features/live-camera-diag.js');
    const video = document.querySelector('.live-video-wrap video.local');
    const stream = video && video.srcObject;
    if (!video || !stream) return { erro: 'sem video local com stream' };
    const info = mod.inspecionarTrack(stream.getVideoTracks()[0]);
    const comp = await mod.compararCapturaComExibicao(stream, video);
    return {
      settings: info,
      classificacao: mod.classificacaoDoQuadro(info),
      comparacao: comp.ok ? {
        caso: comp.caso,
        veredito: comp.veredito,
        diferencaMedia: comp.diferencaMedia,
        limiar: comp.limiar,
        escalaElemento: comp.escalaElemento,
        objectFit: comp.objectFit,
        quadroBruto: comp.quadroBruto,
        quadroElemento: comp.quadroElemento,
        quadroLayout: comp.quadroLayout,
        escalaTransform: comp.escalaTransform,
      } : { erro: comp.motivo },
      decidido: {
        quadro: video.dataset.quadro || null,
        zoomSuportado: video.dataset.zoomSuportado || null,
        zoomAplicado: video.dataset.zoomAplicado || null,
        portraitAplicado: video.dataset.portraitAplicado || null,
      },
    };
  `;

  try {
    for (const [w, h, mobile, rotulo] of CENARIOS) {
      const host = await api.register({ username: randomUsername('host') });
      const cookies = (await fetch(`${server.baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: host.username, password: 'Senha@Teste123' }),
      })).headers.getSetCookie();
      const s = await browser.newBrowserContext();
      s.watch();
      telas.push(s);
      await s.goto(`${server.baseUrl}/`, { waitMs: 300 });
      for (const ck of cookies) {
        const par = ck.split(';')[0];
        const nome = par.slice(0, par.indexOf('='));
        await s.send('Network.setCookie', {
          name: nome, value: decodeURIComponent(par.slice(nome.length + 1)),
          domain: '127.0.0.1', path: '/',
        });
      }
      await s.send('Emulation.setDeviceMetricsOverride', {
        width: w, height: h, deviceScaleFactor: 1, mobile,
      });
      // eslint-disable-next-line no-await-in-loop
      await s.goto(`${server.baseUrl}/iniciar-live`, { waitMs: 2600 });
      // eslint-disable-next-line no-await-in-loop
      const clicou = await s.eval(`
        const b = [...document.querySelectorAll('button')]
          .find((x) => /iniciar transmissao/i.test(x.textContent || ''));
        if (!b) return 'sem botao';
        b.click();
        return 'clicou';
      `);
      if (clicou !== 'clicou') throw new Error(`${w}x${h}: ${clicou}`);
      // eslint-disable-next-line no-await-in-loop
      await sleep(6500);

      // ---- 1) a constraint NAO pode pedir proporcao ------------------
      const settings = (await s.eval(`
        const v = document.querySelector('.live-video-wrap video.local');
        const track = v.srcObject && v.srcObject.getVideoTracks()[0];
        if (!track) return null;
        const s = track.getSettings();
        const c = track.getCapabilities();
        return {
          settings: s,
          constraints: track.getConstraints(),
          capabilities: {
            zoom: c.zoom || null,
            aspectRatio: c.aspectRatio || null,
          },
        };
      `));
      if (!settings) throw new Error(`${w}x${h}: sem track de video`);
      const pedidas = settings.constraints;
      // O app nao envia constraints de modo/resolucao depois que o browser
      // escolheu o track natural; somente o zoom minimo, caso suportado.
      if (pedidas.height || pedidas.width || pedidas.aspectRatio) {
        throw new Error(`${w}x${h} (${rotulo}): constraints do track contem `
          + `resolucao/proporcao forcada: ${JSON.stringify(pedidas)}`);
      }
      // O detector de crop e a reversao sao testados de forma DETERMINISTICA em
      // `verify-live-captura.mjs`, com tracks falsos. Nao da para confirmar
      // aqui: a camera falsa do Chrome e erratica (troca de resolucao sozinha
      // ao receber qualquer constraint), entao medir "o crop ficou ativo?"
      // sobre ela mediria a camera falsa, nao o app.
      const decidido = await s.eval(`
        const v = document.querySelector('.live-video-wrap video.local');
        return {
          zoomSuportado: v.dataset.zoomSuportado,
          zoomAplicado: v.dataset.zoomAplicado,
          portraitAplicado: v.dataset.portraitAplicado,
          quadro: v.dataset.quadro,
        };
      `);
      if (decidido.portraitAplicado !== 'false') {
        throw new Error(`${w}x${h} (${rotulo}): houve tentativa de forcar portrait`);
      }
      const zoomCaps = settings.capabilities?.zoom;
      const zoomAtual = settings.settings?.zoom;
      if (zoomCaps && Number.isFinite(Number(zoomCaps.min))) {
        if (decidido.zoomAplicado !== 'true'
            || (Number.isFinite(Number(zoomAtual))
              && Math.abs(Number(zoomAtual) - Number(zoomCaps.min)) > 0.05)) {
          throw new Error(`${w}x${h} (${rotulo}): zoom nao corresponde ao minimo `
            + `declarado (${JSON.stringify(zoomCaps)}; atual ${zoomAtual})`);
        }
      } else if (decidido.zoomAplicado === 'true') {
        throw new Error(`${w}x${h} (${rotulo}): zoom aplicado sem capability`);
      }
      report.ok(`${w}x${h} (${rotulo}): camera entregou ${decidido.quadro}; `
        + `zoom suportado=${decidido.zoomSuportado} `
        + `aplicado=${decidido.zoomAplicado} atual=${zoomAtual ?? '(n/d)'} `
        + `capabilities=${JSON.stringify(settings.capabilities)}; `
        + `portrait constraint=${decidido.portraitAplicado}`);

      // ---- 2) o instrumento separa captura de exibicao ----------------
      const semZoom = (await s.eval(COMPARAR));
      if (!semZoom || semZoom.erro) {
        throw new Error(`${w}x${h}: comparacao nao rodou: `
          + JSON.stringify(semZoom));
      }
      if (semZoom.comparacao.erro) {
        throw new Error(`${w}x${h}: comparacao falhou: ${semZoom.comparacao.erro}`);
      }
      const c1 = semZoom.comparacao;
      if (c1.diferencaMedia > c1.limiar) {
        throw new Error(`${w}x${h} (${rotulo}): com a exibicao normal o `
          + `comparador acusou diferenca de ${c1.diferencaMedia.toFixed(1)} `
          + `(limiar ${c1.limiar}) - veredito ${c1.caso}. O comparador esta `
          + 'acusando zoom onde nao ha');
      }
      report.ok(`${w}x${h} (${rotulo}): veredito ${c1.caso} - `
        + `bruto ${c1.quadroBruto.join('x')} vs exibido `
        + `${c1.quadroElemento.join('x')} (${c1.objectFit}), `
        + `escala ${c1.escalaElemento.toFixed(3)}x, `
        + `diferenca ${c1.diferencaMedia.toFixed(1)} <= ${c1.limiar}`);

      // ---- 3) o instrumento DETECTA um zoom na exibicao --------------
      // `drawImage(video)` ignora transform CSS, entao o detector de transform
      // compara `offsetWidth` (layout) com `getBoundingClientRect()` (real).
      // eslint-disable-next-line no-await-in-loop
      await s.eval(`
        const v = document.querySelector('.live-video-wrap video.local');
        // Espelho + zoom, imitando um pipeline de exibicao defeituoso.
        v.style.transform = 'scaleX(-1) scale(1.8)';
        return true;
      `);
      // eslint-disable-next-line no-await-in-loop
      await sleep(400);
      const comZoom = (await s.eval(COMPARAR));
      const c2 = comZoom.comparacao;
      if (c2.erro) throw new Error(`${w}x${h}: comparacao com zoom falhou`);
      if (c2.caso !== 'B (renderizacao)') {
        throw new Error(`${w}x${h} (${rotulo}): com scale(1.8) na exibicao o `
          + `comparador ainda disse "${c2.caso}" (transform `
          + `${(c2.escalaTransform ?? 1).toFixed(2)}x) - o instrumento nao `
          + 'detecta zoom, entao nao serve para diagnosticar o celular');
      }
      report.ok(`${w}x${h} (${rotulo}): com scale(1.8) forcado na exibicao o `
        + `comparador vira ${c2.caso} (transform `
        + `${c2.escalaTransform.toFixed(2)}x, diferenca de conteudo `
        + `${c2.diferencaMedia.toFixed(1)}) - o instrumento distingue os dois casos`);

      // Screenshot do painel de diagnostico aberto de verdade, pelo menu.
      // Screenshot do painel de diagnostico aberto de verdade, pelo menu.
      // Primeiro devolve o video ao estado normal: sem isso o `transform`
      // injetado no passo 3 fica por cima e o app pode nao reagir ao clique.
      // eslint-disable-next-line no-await-in-loop
      await s.eval(`
        const v = document.querySelector('.live-video-wrap video.local');
        v.style.transform = '';
        v.dispatchEvent(new Event('resize'));
        return true;
      `);
      // O modal e renderizado de forma assincrona: espera o item aparecer em
      // vez de torcer por um tempo fixo.
      let abriu = 'item ausente';
      for (let i = 0; i < 20; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        abriu = await s.eval(`
          const jaTemMenu = document.querySelectorAll('.live-config-item').length > 0;
          if (!jaTemMenu) {
            const cfg = document.querySelector('.live-settings-btn');
            if (cfg) cfg.click();
          }
          const item = [...document.querySelectorAll('.live-config-item')]
            .find((x) => /diagnostico da camera/i.test(x.textContent || ''));
          if (!item) return 'item ausente';
          item.click();
          await new Promise((r) => setTimeout(r, 800));
          return document.querySelector('.live-diag') ? 'abriu' : 'painel nao montou';
        `);
        if (abriu === 'abriu') break;
        // eslint-disable-next-line no-await-in-loop
        await sleep(500);
      }
      if (abriu !== 'abriu') {
        const itens = await s.eval(`
          return [...document.querySelectorAll('.live-config-item')]
            .map((x) => (x.textContent || '').trim());
        `);
        throw new Error(`${w}x${h} (${rotulo}): painel de diagnostico: ${abriu} `
          + `(itens do menu: ${JSON.stringify(itens)})`);
      }
      const painelTexto = await s.eval(`
        const p = document.querySelector('.live-diag');
        if (!p) return null;
        const linhas = [...p.querySelectorAll('.live-diag-linha')]
          .map((d) => d.textContent.trim());
        return {
          linhas,
          veredito: (p.querySelector('.live-diag-veredito') || {}).textContent || '',
          previas: p.querySelectorAll('.live-diag-canvas canvas').length,
        };
      `);
      if (!painelTexto) throw new Error(`${w}x${h}: painel sumiu antes da leitura`);
      if (painelTexto.previas < 2) {
        throw new Error(`${w}x${h} (${rotulo}): o painel mostrou `
          + `${painelTexto.previas} previa(s), esperava 2 (bruto e exibido)`);
      }
      if (!/CAMERA SETTINGS/.test(painelTexto.linhas.join(' '))
        && !painelTexto.linhas.some((l) => /width/.test(l))) {
        throw new Error(`${w}x${h} (${rotulo}): o painel nao listou os campos `);
      }
      // eslint-disable-next-line no-await-in-loop
      const tiro = await s.send('Page.captureScreenshot', { format: 'png' });
      const arq = path.join(SAIDA, `diag-camera-${w}x${h}.png`);
      fs.writeFileSync(arq, Buffer.from(tiro.data, 'base64'));
      report.ok(`${w}x${h} (${rotulo}): painel aberto com 2 previas + `
        + `veredito "${painelTexto.veredito.trim().slice(0, 80)}"; `
        + `screenshot ${path.relative(ROOT, arq)}`);
    }

    report.ok('diagnostico da camera: constraint sem proporcao forcada, '
      + 'modo nativo preservado, zoom capability auditado e comparador A/B distingue '
      + 'os dois casos');
  } catch (error) {
    report.fail('verificacao do diagnostico interrompida', error);
  } finally {
    for (const s of telas) { try { s.close?.(); } catch { /* ignore */ } }
    await browser.close();
    await server.stop();
  }
  return report.summary();
}

run().then((r) => process.exit(r.failed > 0 ? 1 : 0)).catch((e) => { console.error(e); process.exit(1); });
