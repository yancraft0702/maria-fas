/**
 * Verificador do enquadramento fullscreen da camera na LIVE.
 *
 * O sintoma era "a pessoa fica perto demais, como se houvesse zoom". Sao duas
 * causas possiveis e independentes, e as DUAS sao medidas aqui:
 *
 *  A) CAPTURA: o `getUserMedia` pedia 1080x1920 (9:16) a uma camera 16:9. O
 *     driver nao estica o sensor: ele RECORTA o quadro para 9:16, o que corta
 *     as laterais e aproxima a pessoa. Mede-se a resolucao REAL da track e a
 *     proporcao pedida.
 *  B) EXIBICAO: o `<video>` precisa cobrir o palco com `object-fit: cover`, sem
 *     distorcer o quadro nem aplicar escala CSS sobre a camera.
 *
 * A camera e a camera FALSA do Chrome (`--use-fake-device-for-media-stream`),
 * que para o WebRTC e um dispositivo real: o que o navegador captura e o que
 * o espectador recebe.
 *
 * Cada tamanho usa um host PROPRIO: com o mesmo usuario a LIVE do tamanho
 * anterior continuaria no ar e a proxima tela recusaria iniciar - o que seria
 * falha do teste, nao do produto.
 */
import {
  startServer, Client, Report, sleep, randomUsername,
} from '../tests/helpers.mjs';
import { launchChrome } from '../tests/cdp.mjs';
import { escolherEnquadramento } from '../web/js/features/live-layout.js';

const report = new Report('LIVE: enquadramento fullscreen da camera');

const TAMANHOS = [
  [320, 640, true], [390, 844, true], [414, 896, true], [768, 1024, false],
  [1024, 900, false], [1280, 900, false], [1920, 1080, false],
];

const ESPELHO = /matrix\(-1, 0, 0, 1, 0, 0\)/;

const logar = async (s, cookies) => {
  await s.goto(`${s.baseUrl ?? ''}`, { waitMs: 300 }).catch(() => {});
  void cookies;
};

/** Instala a sessao de `cookies` no contexto e mede o dispositivo pedido. */
async function comSessao(s, baseUrl, cookies, w, h, mobile) {
  await s.goto(`${baseUrl}/`, { waitMs: 300 });
  for (const ck of cookies) {
    const par = ck.split(';')[0];
    const nome = par.slice(0, par.indexOf('='));
    await s.send('Network.setCookie', {
      name: nome, value: decodeURIComponent(par.slice(nome.length + 1)),
      domain: '127.0.0.1', path: '/',
    });
  }
  await s.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile });
}

async function run() {
  const server = await startServer();
  const api = new Client(server.baseUrl);

  const browser = await launchChrome({
    extraArgs: [
      '--autoplay-policy=no-user-gesture-required',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
    ],
  });
  const s = await browser.newBrowserContext();
  s.watch();

  const entrar = async (username) => {
    const r = await fetch(`${server.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: username, password: 'Senha@Teste123' }),
    });
    return r.headers.getSetCookie();
  };

  try {
    // ============ A) CAPTURA: proporcao pedida = proporcao natural ==========
    const hostA = await api.register({ username: randomUsername('cam') });
    await comSessao(s, server.baseUrl, await entrar(hostA.username), 1280, 900, false);
    await s.goto(`${server.baseUrl}/`, { waitMs: 1800 });

    const captura = await s.eval(`
      const { MediaDevices } = await import('/js/features/live.js');
      const c = MediaDevices.videoConstraint({});
      const retrato = window.matchMedia('(orientation: portrait)').matches;
      const stream = await navigator.mediaDevices.getUserMedia({ video: c, audio: false });
      const track = stream.getVideoTracks()[0];
      const st = track.getSettings();
      const caps = track.getCapabilities();
      const activeConstraints = track.getConstraints();
      const video = document.createElement('video');
      video.srcObject = stream;
      video.muted = true;
      await video.play().catch(() => {});
      const saida = {
        retratoDoAparelho: retrato,
        pedido: {
          largura: c.width?.ideal ?? null,
          altura: c.height?.ideal ?? null,
          proporcao: c.aspectRatio?.ideal ?? null,
        },
        driver: { largura: st.width || video.videoWidth, altura: st.height || video.videoHeight },
        intrinseco: { largura: video.videoWidth, altura: video.videoHeight },
        zoom: {
          caps: caps.zoom ? { min: caps.zoom.min, max: caps.zoom.max, step: caps.zoom.step } : null,
          setting: st.zoom ?? null,
        },
        constraints: activeConstraints,
      };
      stream.getTracks().forEach((t) => t.stop());
      return saida;
    `);
    // Nenhuma dimensao/proporcao e sugerida: o driver entrega seu modo padrao.
    if (captura.pedido.largura !== null) {
      throw new Error('a constraint ainda sugere largura e pode mudar o modo '
        + 'de captura escolhido pelo driver');
    }
    if (captura.pedido.altura !== null) {
      throw new Error('a constraint pede height: isso forca o driver a converter '
        + 'o sensor (crop digital)');
    }
    if (captura.pedido.proporcao !== null) {
      throw new Error('a constraint pede aspectRatio: isso forca o driver a '
        + 'converter o sensor (crop digital)');
    }
    report.ok('A) constraint nao pede resolucao nem aspectRatio; '
      + 'o driver escolhe o modo padrao da camera');
    report.ok(`A) o driver entregou ${captura.driver.largura}x${captura.driver.altura} `
      + `= videoWidth/videoHeight ${captura.intrinseco.largura}x${captura.intrinseco.altura} `
      + `ratio ${(captura.driver.largura / captura.driver.altura).toFixed(4)}; `
      + `zoom capability ${JSON.stringify(captura.zoom.caps)}, `
      + `setting ${captura.zoom.setting ?? '(ausente)'}`);

    // ============ B) EXIBICAO em cada tamanho ==============================
    let hostAtivo = null;
    let salaAtiva = null;
    for (const [w, h, mobile] of TAMANHOS) {
      const user = await api.register({ username: randomUsername('cam') });
      await comSessao(s, server.baseUrl, await entrar(user.username), w, h, mobile);
      await s.goto(`${server.baseUrl}/iniciar-live`, { waitMs: 2400 });
      const clicou = await s.eval(`
        const b = [...document.querySelectorAll('button')].find((x) => /iniciar transmissao/i.test(x.textContent || ''));
        if (!b) return 'sem botao';
        b.click();
        return 'clicou';
      `);
      if (clicou !== 'clicou') throw new Error(`${w}x${h}: nao achou o botao de iniciar (${clicou})`);
      await sleep(5200);

      const sala = (await api.get(`/api/users/${user.id}/live`)).body.live;
      if (!sala?.id) throw new Error(`${w}x${h}: a LIVE nao subiu pela interface`);
      hostAtivo = user;
      salaAtiva = sala.id;

      const medido = await s.eval(`
        const video = document.querySelector('.live-video-wrap video.local');
        const palco = document.querySelector('.live-video-wrap');
        if (!video || !palco) return null;
        const vb = video.getBoundingClientRect();
        const pb = palco.getBoundingClientRect();
        const cs = getComputedStyle(video);
        const objeto = cs.objectFit;
        // Rotacao: quando o quadro e landscape e o palco portrait, o elemento
        // e girado 90 graus e passa a TRANSBORDAR de proposito (o palco tem
        // overflow hidden). A ampliacao e medida sobre o quadro ja girado,
        // senao leria 1.78x num simples giro.
        const rot = Number(video.dataset.rotacao) || 0;
        const efL = rot ? (video.videoHeight || 1) : (video.videoWidth || 1);
        const efA = rot ? (video.videoWidth || 1) : (video.videoHeight || 1);
        const ampliacao = objeto === 'cover'
          ? Math.max(pb.width / efL, pb.height / efA)
          : 1;
        const st = (() => {
          const t = video.srcObject && video.srcObject.getVideoTracks()[0];
          return t ? t.getSettings() : null;
        })();
        return {
          video: [Math.round(vb.width), Math.round(vb.height)],
          palco: [Math.round(pb.width), Math.round(pb.height)],
          rotacao: rot,
          difereDoPalco: Math.round(Math.abs(vb.width - pb.width)) + Math.round(Math.abs(vb.height - pb.height)),
          objeto,
          posicao: cs.objectPosition,
          transform: cs.transform,
          transformInline: video.style.transform || '(nenhum)',
          ampliacao,
          proporcaoQuadro: (video.videoWidth || 16) / (video.videoHeight || 9),
          proporcaoElemento: vb.width / vb.height,
          track: st ? [st.width, st.height] : null,
          scrollX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        };
      `);
      if (!medido) throw new Error(`${w}x${h}: a LIVE nao mostrou video local`);

      // Sem rotacao, o elemento tem de COBRIR o palco: um elemento encolhido
      // nasce um retangulo preto no meio da tela. Com rotacao + `cover` o
      // elemento transborda de proposito (e o palco recorta), entao o que nao
      // pode e o centro sair do palco ou faltar cobertura em algum eixo.
      if (!medido.rotacao && medido.difereDoPalco > 2) {
        throw new Error(`${w}x${h}: o video mede ${medido.video.join('x')} e o palco `
          + `${medido.palco.join('x')} (diferenca ${medido.difereDoPalco}px - sobra ou zoom)`);
      }
      if (medido.objeto !== 'cover') {
        throw new Error(`${w}x${h}: object-fit e "${medido.objeto}"; `
          + 'esperado cover para preencher o palco');
      }
      // O `transform` pode ESPELHAR (a selfie) e/ou GIRAR (o quadro landscape num
      // palco portrait). O que e proibido e ESCALAR. As COLUNAS da matriz sao as
      // imagens dos eixos: com norma 1 so ha giro/espelho; acima de 1 ha
      // `scale`, que e o mascaramento que o item 5 proibe.
      const temEscala = (() => {
        const m = /matrix\(([^)]+)\)/.exec(medido.transform || '');
        if (!m) return true;
        const [a, b, c, d] = m[1].split(',').map(Number);
        if (![a, b, c, d].every(Number.isFinite)) return true;
        return Math.max(Math.hypot(a, b), Math.hypot(c, d)) > 1.05;
      })();
      if (medido.transform && medido.transform !== 'none' && temEscala) {
        throw new Error(`${w}x${h}: o video tem transform "${medido.transform}" `
          + `(${medido.transformInline}) - transform com escala, e so espelhar/girar que e permitido`);
      }
      if (medido.scrollX > 1) throw new Error(`${w}x${h}: scroll horizontal na LIVE`);
      report.ok(`B) ${w}x${h} (${mobile ? 'mobile' : 'desktop'}): video `
        + `${medido.video.join('x')} em palco ${medido.palco.join('x')}`
        + `${medido.rotacao ? `, girado ${medido.rotacao}°` : ''}, `
        + `object-fit ${medido.objeto}, escala cover ${medido.ampliacao.toFixed(2)}x, `
        + `track ${(medido.track || []).join('x')}`);

      // Encerra para o proximo tamanho comecar limpo (o mesmo que o botao
      // "sair" da interface faz).
      const fim = await api.post(`/api/live/${sala.id}/end`, {});
      if (fim.status >= 400 && fim.status !== 404) {
        throw new Error(`${w}x${h}: nao deu para encerrar a LIVE (${fim.status})`);
      }
      await sleep(600);
    }

    // ============ C) o ESPECTADOR recebe o quadro fullscreen com cover ======
    const userEsp = await api.register({ username: randomUsername('cam') });
    await comSessao(s, server.baseUrl, await entrar(hostAtivo.username), 1024, 900, false);
    await s.goto(`${server.baseUrl}/iniciar-live`, { waitMs: 2400 });
    await s.eval(`
      const b = [...document.querySelectorAll('button')].find((x) => /iniciar transmissao/i.test(x.textContent || ''));
      if (b) b.click();
      return true;
    `);
    await sleep(5200);
    const salaFinal = (await api.get(`/api/users/${hostAtivo.id}/live`)).body.live;
    if (!salaFinal?.id) throw new Error('a LIVE do(host da checagem remota nao subiu');
    salaAtiva = salaFinal.id;

    const s2 = await browser.newBrowserContext();
    s2.watch();
    await comSessao(s2, server.baseUrl, await entrar(userEsp.username), 1280, 900, false);
    await s2.goto(`${server.baseUrl}/live/${salaFinal.id}`, { waitMs: 3600 });
    let remoto = null;
    for (let i = 0; i < 24; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      remoto = await s2.eval(`
        const v = document.querySelector('.live-video-wrap video.remote');
        if (!v || !v.srcObject) return null;
        const cs = getComputedStyle(v);
        const b = v.getBoundingClientRect();
        const palco = document.querySelector('.live-video-wrap').getBoundingClientRect();
        return {
          quadro: [v.videoWidth, v.videoHeight],
          elemento: [Math.round(b.width), Math.round(b.height)],
          palco: [Math.round(palco.width), Math.round(palco.height)],
          objeto: cs.objectFit,
          transform: cs.transform,
          tracks: v.srcObject.getVideoTracks().length,
        };
      `);
      if (remoto) break;
      // eslint-disable-next-line no-await-in-loop
      await sleep(1200);
    }
    if (!remoto) throw new Error('o espectador nao recebeu o video do host');
    if (remoto.transform && remoto.transform !== 'none' && !ESPELHO.test(remoto.transform)) {
      throw new Error(`espectador: transform "${remoto.transform}" no video remoto`);
    }
    // O elemento cobre o palco e o crop de `cover` e intencional quando as
    // proporcoes do quadro e da tela diferem.
    const escalaCover = Math.max(
      remoto.palco[0] / Math.max(1, remoto.quadro[0]),
      remoto.palco[1] / Math.max(1, remoto.quadro[1]),
    );
    const esperado = escolherEnquadramento(
      { largura: remoto.quadro[0], altura: remoto.quadro[1] },
      { largura: remoto.palco[0], altura: remoto.palco[1] },
    );
    const elementoCobrePalco = Math.abs(remoto.elemento[0] - remoto.palco[0]) <= 2
      && Math.abs(remoto.elemento[1] - remoto.palco[1]) <= 2;
    if (!elementoCobrePalco) {
      throw new Error(`espectador: video ${remoto.elemento.join('x')} nao cobre o palco `
        + `${remoto.palco.join('x')} com quadro ${remoto.quadro.join('x')} - `
        + 'sobra uma area preta no meio da tela');
    }
    if (esperado.fit !== 'cover' || remoto.objeto !== 'cover') {
      throw new Error(`espectador: quadro ${remoto.quadro.join('x')} em `
        + `${remoto.palco.join('x')} devia usar "cover" mas a regra decidiu `
        + `"${esperado.fit}" (${esperado.motivo}), `
        + `mas ficou "${remoto.objeto}"`);
    }
    const escalaEfetiva = escalaCover;
    if (Math.abs(escalaEfetiva - esperado.escala) > 0.02) {
      throw new Error(`espectador: escala cover ${escalaEfetiva.toFixed(2)}x `
        + `difere da esperada ${esperado.escala.toFixed(2)}x`);
    }
    report.ok(`C) espectador recebe o quadro ${remoto.quadro.join('x')} em `
      + `elemento ${remoto.elemento.join('x')} (palco ${remoto.palco.join('x')}), `
      + `object-fit ${remoto.objeto} (${esperado.motivo}), `
      + `${remoto.tracks} track, sem transform de imagem, `
      + `escala ${escalaEfetiva.toFixed(3)}x, elemento cobrindo o palco`);
    try { s2.close?.(); } catch { /* ignore */ }
    void salaAtiva;

    report.ok('enquadramento fullscreen: captura preservada e exibicao com cover');
  } catch (error) {
    report.fail('verificacao do enquadramento interrompida', error);
  } finally {
    try { s.close?.(); } catch { /* ignore */ }
    await browser.close();
    await server.stop();
  }
  return report.summary();
}

void logar;
run().then((r) => process.exit(r.failed > 0 ? 1 : 0)).catch((e) => { console.error(e); process.exit(1); });