/**
 * Verificador do enquadramento fullscreen da camera na LIVE.
 *
 * A verificacao tem DUAS metades:
 *
 *   1. A REGUA, em Node puro: `escolherEnquadramento()` e chamada com os
 *      cenarios que quebraram o produto - inclusive camera 16:9 numa viewport
 *      390x844 - e exige que cada quadro cubra o palco. Isso trava a regra sem
 *      depender de uma camera real.
 *   2. O NAVEGADOR: a mesma funcao e exercitada com o quadro que a camera
 *      realmente entregou, medindo `object-fit`, escala e cobertura no DOM.
 *
 * A camera e a FALSA do Chrome, que para o WebRTC e um dispositivo real: o
 * host ve exatamente o que o espectador receberia.
 */
import {
  startServer, Client, Report, sleep, randomUsername,
} from '../tests/helpers.mjs';
import { launchChrome } from '../tests/cdp.mjs';
import {
  escolherEnquadramento, TOLERANCIA_DE_AMPLIACAO, TOLERANCIA_DE_ESTIQUE,
  LIMITE_DE_RECORTE,
} from '../web/js/features/live-layout.js';

const report = new Report('LIVE: enquadramento fullscreen com cover');

// [largura, altura, mobile, rotulo do cenario]
const CENARIOS = [
  [390, 844, true, 'celular em retrato'],
  [768, 1024, false, 'tablet'],
  [1024, 900, false, 'desktop'],
  [1280, 900, false, 'desktop largo'],
  [1920, 1080, false, 'desktop 1080p'],
];

/**
 * REGUA: cenarios puros, sem navegador.
 *
 * Cada entrada registra quadro e area para confirmar cover em qualquer
 * proporcao; o corte e esperado quando as proporcoes nao coincidem.
 */
const REGUA = [
  {
    nome: 'celular em tela cheia: quadro portrait na viewport portrait',
    quadro: { largura: 720, altura: 1280 },
    area: { largura: 390, altura: 844 },
    fit: 'cover',
    motivo: 'tela cheia sem tarja, e o quadro so encolhe',
    maxEscala: 1.0,
    maxRecorte: 0.20,
  },
  {
    nome: 'celular: camera portrait de alta resolucao (1080x1920)',
    quadro: { largura: 1080, altura: 1920 },
    area: { largura: 390, altura: 844 },
    fit: 'cover',
    motivo: '1080x1920 tambem encolhe em 390x844',
    maxEscala: 1.0,
    maxRecorte: 0.20,
  },
  {
    // O caso que a camera FALSA do Chrome entregou no celular: portrait curto
    // (405x720) numa viewport portrait. O cover exige 1.17x de ampliacao, mas
    // o CORTE e de so 18% - e o arredondamento normal de uma LIVE vertical.
    // Medir ampliacao aqui mandaria para `contain` e criaria tarja preta.
    nome: 'celular: portrait curto (405x720) - corte pequeno, tela cheia',
    quadro: { largura: 405, altura: 720 },
    area: { largura: 390, altura: 844 },
    fit: 'cover',
    motivo: 'corte de 18% arredonda as laterais sem devorar a pessoa',
    maxEscala: TOLERANCIA_DE_AMPLIACAO,
    maxRecorte: LIMITE_DE_RECORTE,
  },
  {
    // O MESMO par de proporcoes de tela, mas com o sensor landscape: sem a
    // rotacao, o cover cortaria 74% da largura (o defeito do rosto gigante).
    // Com a rotacao, o cover fica legitimo porque opera sobre o quadro JA
    // girado, que e 9:16 - e ainda encolhe (0.659x).
    nome: 'celular: camera 16:9 em viewport 9:16, girada -> tela cheia sem zoom',
    quadro: { largura: 1280, altura: 720 },
    area: { largura: 390, altura: 844 },
    fit: 'cover',
    rotacao: 90,
    motivo: 'girado, o quadro vira 9:16 e o cover encolhe em vez de ampliar',
    maxEscala: 1.0,
    maxRecorte: LIMITE_DE_RECORTE,
  },
  {
    nome: 'desktop: quadro 16:9 em area quase quadrada',
    quadro: { largura: 1280, altura: 720 },
    area: { largura: 744, altura: 848 },
    fit: 'cover',
    rotacao: 90,
    motivo: 'girado ainda nao cabe sem cortar 36%; exibido inteiro',
    maxEscala: 1.0,
    maxRecorte: 0.0,
  },
  {
    nome: 'espectador: quadro 320x180 cobre a area grande',
    quadro: { largura: 320, altura: 180 },
    area: { largura: 1040, altura: 848 },
    fit: 'cover',
    motivo: 'qualquer ajuste esticaria 3.25x',
    maxEscala: 1.0,
    maxRecorte: 0.0,
  },
  {
    nome: 'espectador: quadro portrait 720x1280 em desktop',
    quadro: { largura: 720, altura: 1280 },
    area: { largura: 1040, altura: 848 },
    fit: 'cover',
    motivo: 'cover descartaria 54% do quadro',
    maxEscala: 1.0,
    maxRecorte: 0.0,
  },
  {
    nome: 'tablet: quadro portrait em area quase quadrada (corte no limite)',
    quadro: { largura: 720, altura: 1280 },
    area: { largura: 768, altura: 1024 },
    fit: 'cover',
    motivo: 'corte de 25%, exatamente no limite',
    maxEscala: TOLERANCIA_DE_AMPLIACAO,
    maxRecorte: LIMITE_DE_RECORTE,
  },
  {
    nome: 'medida incompleta mantem cover como apresentacao',
    quadro: { largura: 0, altura: 0 },
    area: { largura: 390, altura: 844 },
    fit: 'cover',
    motivo: 'sem quadro conhecido, o padrao seguro e contain',
    maxEscala: 1.0,
    maxRecorte: 0.0,
  },
];

/**
 * REGUA DA ROTACAO: os dois lados do aparelho, com a mesma camera.
 *
 * A camera e a MESMA (1280x720 landscape) nas duas linhas. Muda so o que o
 * aparelho pediu - e o que o espectador pode fazer com o mesmo quadro.
 */
const REGUA_ROTACAO = [
  {
    nome: 'celular: quadro landscape, tela portrait -> gira 90°',
    quadro: { largura: 1280, altura: 720 },
    area: { largura: 390, altura: 844 },
    rotacaoPreferida: 90,
    rotacao: 90,
    fit: 'cover',
    maxEscala: 1.0,
    maxRecorte: LIMITE_DE_RECORTE,
  },
  {
    nome: 'celular: a direcao 270 tambem vale (o anfitriao escolhe)',
    quadro: { largura: 1280, altura: 720 },
    area: { largura: 390, altura: 844 },
    rotacaoPreferida: 270,
    rotacao: 270,
    fit: 'cover',
    maxEscala: 1.0,
    maxRecorte: LIMITE_DE_RECORTE,
  },
  {
    // REGRA A: com portrait NATIVO nao se gira nada.
    nome: 'REGRA A: quadro portrait nativo -> NAO gira',
    quadro: { largura: 720, altura: 1280 },
    area: { largura: 390, altura: 844 },
    rotacaoPreferida: 90,
    rotacao: 0,
    fit: 'cover',
    maxEscala: 1.0,
    maxRecorte: LIMITE_DE_RECORTE,
  },
  {
    // REGRA A tambem vale com preferencia de giro ligada: portrait nativo
    // sempre tem prioridade, porque girar um quadro ja portrait deitaria a
    // pessoa.
    nome: 'REGRA A: portrait nativo ignora a preferencia de girar',
    quadro: { largura: 1080, altura: 1920 },
    area: { largura: 390, altura: 844 },
    rotacaoPreferida: 270,
    rotacao: 0,
    fit: 'cover',
    maxEscala: 1.0,
    maxRecorte: LIMITE_DE_RECORTE,
  },
  {
    // REGRA A tambem vale no desktop, onde a tela e landscape e um quadro
    // portrait nao tem por que ser girado.
    nome: 'REGRA A: portrait nativo em tela landscape -> nao gira',
    quadro: { largura: 720, altura: 1280 },
    area: { largura: 868, altura: 848 },
    rotacaoPreferida: 90,
    rotacao: 0,
    fit: 'cover',
    maxEscala: 1.0,
    maxRecorte: 0.0,
  },
  {
    // Num desktop o quadro landscape JA esta de acordo com a tela: girar
    // pioraria tudo.
    nome: 'desktop: quadro landscape em tela landscape -> nao gira',
    quadro: { largura: 1280, altura: 720 },
    area: { largura: 868, altura: 848 },
    rotacaoPreferida: 90,
    rotacao: 0,
    fit: 'cover',
    maxEscala: 1.0,
    maxRecorte: 0.0,
  },
  {
    // A regra de rotacao existente continua rejeitando o giro deste quadro.
    nome: 'celular: quadro minusculo conserva a regra de rotacao e usa cover',
    quadro: { largura: 320, altura: 180 },
    area: { largura: 390, altura: 844 },
    rotacaoPreferida: 90,
    rotacao: 0,
    fit: 'cover',
    maxEscala: TOLERANCIA_DE_ESTIQUE,
    maxRecorte: 0.0,
  },
];

/** Confere a régua: a regra pura deve sempre cobrir a área. */
function conferirRegua() {
  for (const caso of REGUA) {
    const r = escolherEnquadramento(caso.quadro, caso.area);
    if (caso.fit !== 'cover' || r.fit !== 'cover') {
      throw new Error(`régua "${caso.nome}": esperava cover, veio ${r.fit} `
        + `(${r.motivo})`);
    }
    if (caso.quadro.largura > 0 && caso.quadro.altura > 0) {
      const larguraOrientada = r.rotacao ? caso.quadro.altura : caso.quadro.largura;
      const alturaOrientada = r.rotacao ? caso.quadro.largura : caso.quadro.altura;
      const expectedScale = Math.max(
        caso.area.largura / larguraOrientada,
        caso.area.altura / alturaOrientada,
      );
      if (Math.abs(r.escala - expectedScale) > 1e-9) {
        throw new Error(`régua "${caso.nome}": cover nao calculou a escala para preencher a area`);
      }
    }
    report.ok(`régua: ${caso.nome} -> ${r.fit}, escala `
      + `${r.escala.toFixed(3)}x, corte ${(r.recorte * 100).toFixed(1)}%`);
  }

  for (const caso of REGUA_ROTACAO) {
    const r = escolherEnquadramento(caso.quadro, caso.area, {
      rotacaoPreferida: caso.rotacaoPreferida,
    });
    if (r.rotacao !== caso.rotacao) {
      throw new Error(`régua de rotação "${caso.nome}": esperava `
        + `${caso.rotacao}°, veio ${r.rotacao}° (${r.motivo})`);
    }
    if (r.fit !== 'cover') {
      throw new Error(`régua de rotação "${caso.nome}": esperava `
        + `cover, veio ${r.fit} (${r.motivo})`);
    }
    const larguraOrientada = r.rotacao ? caso.quadro.altura : caso.quadro.largura;
    const alturaOrientada = r.rotacao ? caso.quadro.largura : caso.quadro.altura;
    const expectedScale = Math.max(caso.area.largura / larguraOrientada, caso.area.altura / alturaOrientada);
    if (Math.abs(r.escala - expectedScale) > 1e-9) {
      throw new Error(`régua de rotação "${caso.nome}": cover nao preenche a area`);
    }
    report.ok(`régua de rotação: ${caso.nome} -> ${r.rotacao}° + ${r.fit}, `
      + `escala ${r.escala.toFixed(3)}x, corte ${(r.recorte * 100).toFixed(1)}%`);
  }

  report.ok('régua: todos os quadros cobrem a área e a política de rotação permanece');
}

async function run() {
  const server = await startServer();
  const api = new Client(server.baseUrl);
  // Um usuario por cenario: com o mesmo host, a LIVE do cenario anterior segue
  // ativa e a proxima tela recusaria iniciar - falha de teste, nao do produto.
  const entrar = async (username) => {
    const r = await fetch(`${server.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: username, password: 'Senha@Teste123' }),
    });
    return r.headers.getSetCookie();
  };
  let host = null;

  const browser = await launchChrome({
    extraArgs: [
      '--autoplay-policy=no-user-gesture-required',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
    ],
  });
  const telas = [];
  const abrir = async (w, h, mobile, cookies) => {
    const s = await browser.newBrowserContext();
    s.watch();
    await s.goto(`${server.baseUrl}/`, { waitMs: 300 });
    await s.eval(`localStorage.setItem('mariafas.live.rotacao', '90')`);
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

  try {
    // Metade 1: a regra pura, sem navegador. Falha aqui significa que a
    // arquitetura do enquadramento esta errada, independente de camera.
    conferirRegua();

    for (const [w, h, mobile, rotulo] of CENARIOS) {
      host = await api.register({ username: randomUsername('cam') });
      const s = await abrir(w, h, mobile, await entrar(host.username));
      telas.push(s);
      await s.goto(`${server.baseUrl}/iniciar-live`, { waitMs: 2400 });
      const clicou = await s.eval(`
        const b = [...document.querySelectorAll('button')].find((x) => /iniciar transmissao/i.test(x.textContent || ''));
        if (!b) return 'sem botao';
        b.click();
        return 'clicou';
      `);
      if (clicou !== 'clicou') throw new Error(`${w}x${h}: ${clicou}`);
      await sleep(5400);

      const medido = await s.eval(`
        const video = document.querySelector('.live-video-wrap video.local');
        const palco = document.querySelector('.live-video-wrap');
        if (!video || !palco) return null;
        const pb = palco.getBoundingClientRect();
        const vb = video.getBoundingClientRect();
        const cs = getComputedStyle(video);
        const cobreX = pb.width / (video.videoWidth || 1);
        const cobreY = pb.height / (video.videoHeight || 1);
        const escalaCover = Math.max(cobreX, cobreY);
        const escalaContain = Math.min(cobreX, cobreY);
        // Rotacao: com o quadro girado, largura e altura trocam de lugar na
        // medicao. E o que separa "0.66x encolhe" de "2.34x amplia".
        const rot = Number(video.dataset.rotacao) || 0;
        const giroX = rot ? pb.width / (video.videoHeight || 1) : cobreX;
        const giroY = rot ? pb.height / (video.videoWidth || 1) : cobreY;
        const escalaCoverEfetiva = rot ? Math.max(giroX, giroY) : escalaCover;
        const escalaContainEfetiva = rot ? Math.min(giroX, giroY) : escalaContain;
        const aproveitaX = cobreX / escalaCover;
        const aproveitaY = cobreY / escalaCover;
        const ajuste = getComputedStyle(document.querySelector('.live-page'));
        const pageBox = document.querySelector('.live-page').getBoundingClientRect();
        const track = video.srcObject?.getVideoTracks?.()[0];
        const cameraSettings = (() => {
          try { return track?.getSettings?.() || null; } catch { return null; }
        })();
        const cameraCapabilities = (() => {
          try {
            const caps = track?.getCapabilities?.() || {};
            return {
              zoom: caps.zoom
                ? { min: caps.zoom.min, max: caps.zoom.max, step: caps.zoom.step }
                : null,
            };
          } catch { return null; }
        })();
        const cameraConstraints = (() => {
          try { return track?.getConstraints?.() || null; } catch { return null; }
        })();
        return {
          quadro: [video.videoWidth, video.videoHeight],
          rotacao: Number(video.dataset.rotacao) || 0,
          escalaCoverEfetiva,
          escalaContainEfetiva,
          // O que o app leu de videoTrack.getSettings() apos abrir o stream.
          quadroDeclarado: video.dataset.quadro || '(nenhum)',
          proporcaoDeclarada: video.dataset.quadroProporcao || '(nenhuma)',
          video: [Math.round(vb.width), Math.round(vb.height)],
          palco: [Math.round(pb.width), Math.round(pb.height)],
          // O elemento tem que COBRIR o palco inteiro: um elemento encolhido
          // nasce um retangulo preto no meio da tela.
          elementoCobrePalco: vb.width >= pb.width - 1 && vb.height >= pb.height - 1,
          viewport: [window.innerWidth, window.innerHeight],
          // getComputedStyle().width vem como texto ("390px"); o rect e
          // numerico e mede a caixa de verdade.
          pageRect: [Math.round(pageBox.width), Math.round(pageBox.height)],
          pageBox: [Math.round(pageBox.left), Math.round(pageBox.top)],
          pagePosition: ajuste.position,
          objectFit: cs.objectFit,
          objectPosition: cs.objectPosition,
          cssZoom: cs.zoom,
          cameraSettings,
          cameraCapabilities,
          cameraConstraints,
          zoomAplicado: video.dataset.zoomAplicado,
          inlineFit: video.style.objectFit || '(nenhum)',
          atributoFit: video.dataset.fit || '(nenhum)',
          ampliacaoDeclarada: video.dataset.ampliacao || null,
          recorteDeclarado: video.dataset.recorte || null,
          escalaCover,
          escalaContain,
          // Corte EFETIVO: medido sobre o quadro ja girado, que e o que vale na tela.
          recorte: rot
            ? 1 - Math.min(
              (pb.width / (video.videoHeight || 1)) / escalaCoverEfetiva,
              (pb.height / (video.videoWidth || 1)) / escalaCoverEfetiva,
            )
            : 1 - Math.min(aproveitaX, aproveitaY),
          transform: cs.transform,
          transformInline: video.style.transform || '(nenhum)',
          visivel: video.videoWidth > 0 && video.videoHeight > 0,
        };
      `);
      if (!medido) throw new Error(`${w}x${h}: a LIVE nao mostrou o video local`);
      if (!medido.visivel) {
        throw new Error(`${w}x${h}: o video ainda nao tinha dimensao de quadro `
          + `(videoWidth=${medido.quadro[0]}) - o enquadramento nao pode ser medido`);
      }

      // A MESMA regra pura que roda no app, aplicada ao quadro que a camera
      // realmente entregou neste viewport.
      const esperado = escolherEnquadramento(
        { largura: medido.quadro[0], altura: medido.quadro[1] },
        { largura: medido.palco[0], altura: medido.palco[1] },
        { rotacaoPreferida: 90 },
      );
      if (medido.rotacao !== esperado.rotacao) {
        throw new Error(`${w}x${h} (${rotulo}): o DOM girou `
          + `${medido.rotacao}° e a regra decidiu ${esperado.rotacao}° `
          + `(${esperado.motivo})`);
      }
      if (medido.objectFit !== 'cover' || esperado.fit !== 'cover') {
        throw new Error(`${w}x${h} (${rotulo}): quadro ${medido.quadro.join('x')} em `
          + `${medido.palco.join('x')} decidiu "${esperado.fit}" (${esperado.motivo}), `
          + `mas o navegador ficou com "${medido.objectFit}"`);
      }
      if (medido.objectPosition !== '50% 50%') {
        throw new Error(`${w}x${h} (${rotulo}): object-position esperado center, `
          + `recebido "${medido.objectPosition}"`);
      }
      if (Number(medido.cssZoom) !== 1) {
        throw new Error(`${w}x${h} (${rotulo}): zoom CSS ${medido.cssZoom}`);
      }
      const constraints = medido.cameraConstraints || {};
      if (constraints.width || constraints.height || constraints.aspectRatio) {
        throw new Error(`${w}x${h} (${rotulo}): track recebeu constraint de `
          + `resolucao/proporcao ${JSON.stringify(constraints)}`);
      }
      const zoomCapability = medido.cameraCapabilities?.zoom;
      const zoomSetting = medido.cameraSettings?.zoom;
      if (zoomCapability && Number.isFinite(Number(zoomCapability.min))) {
        if (medido.zoomAplicado !== 'true'
            || (Number.isFinite(Number(zoomSetting))
              && Math.abs(Number(zoomSetting) - Number(zoomCapability.min)) > 0.05)) {
          throw new Error(`${w}x${h} (${rotulo}): zoom atual ${zoomSetting} nao `
            + `corresponde ao minimo anunciado ${zoomCapability.min}`);
        }
      } else if (medido.zoomAplicado === 'true') {
        throw new Error(`${w}x${h} (${rotulo}): zoom aplicado sem capability`);
      }
      // O cover preenche a area sobre o quadro ja girado, aceitando qualquer
      // corte necessario para eliminar barras.
      const escalaReal = medido.escalaCoverEfetiva;
      if (esperado.fit !== 'cover') {
        throw new Error(`${w}x${h} (${rotulo}): regra retornou "${esperado.fit}" em vez de cover`);
      }
      if (Math.abs(escalaReal - esperado.escala) > 0.02) {
        throw new Error(`${w}x${h} (${rotulo}): escala do DOM ${escalaReal.toFixed(3)}x `
          + `diverge da regra ${esperado.escala.toFixed(3)}x`);
      }
      if (!medido.elementoCobrePalco) {
        throw new Error(`${w}x${h} (${rotulo}): elemento ${medido.video.join('x')} `
          + `nao cobre o palco ${medido.palco.join('x')} - sobra uma area preta`);
      }
      // A LIVE e a viewport inteira, em qualquer tamanho de tela.
      const telaCheia = Math.abs(medido.pageRect[0] - medido.viewport[0]) <= 1
        && Math.abs(medido.pageRect[1] - medido.viewport[1]) <= 1
        && Math.abs(medido.pageBox[0]) <= 1
        && Math.abs(medido.pageBox[1]) <= 1;
      if (!telaCheia || medido.pagePosition !== 'fixed') {
        throw new Error(`${w}x${h} (${rotulo}): .live-page (${medido.pagePosition}) mede `
          + `${medido.pageRect.join('x')} em [${medido.pageBox.join(',')}] e a viewport e `
          + `${medido.viewport.join('x')} - a LIVE nao ocupa a tela inteira`);
      }
      const palcoCobrePagina = Math.abs(medido.palco[0] - medido.pageRect[0]) <= 1
        && Math.abs(medido.palco[1] - medido.pageRect[1]) <= 1;
      if (!palcoCobrePagina) {
        throw new Error(`${w}x${h} (${rotulo}): palco ${medido.palco.join('x')} `
          + `nao cobre a pagina ${medido.pageRect.join('x')} - ha area preta entre os dois`);
      }
      // O quadro REAL lido de getSettings() tem de bater com o que o elemento
      // renderizou - e nenhum dos dois pode ser uma suposicao de proporcao.
      if (medido.quadroDeclarado === '(nenhum)') {
        throw new Error(`${w}x${h} (${rotulo}): o app nao publicou `
          + 'data-quadro (videoTrack.getSettings() nao foi lido)');
      }
      const declarado = medido.quadroDeclarado.split('x').map(Number);
      if (declarado[0] !== medido.quadro[0] || declarado[1] !== medido.quadro[1]) {
        throw new Error(`${w}x${h} (${rotulo}): data-quadro `
          + `"${medido.quadroDeclarado}" difere do quadro renderizado `
          + `${medido.quadro.join('x')}`);
      }
      // `transform` pode girar e espelhar; o que e proibido e ESCALAR. As COLUNAS
      // da matriz sao as imagens dos eixos: com norma 1, so ha rotacao/espelho;
      // acima de 1 ha `scale`, que e o mascaramento que o item 5 proibe.
      if (medido.transform && medido.transform !== 'none') {
        const m = /matrix\(([^)]+)\)/.exec(medido.transform);
        if (!m) {
          throw new Error(`${w}x${h}: transform nao-matriz `
            + `"${medido.transform}" no video local`);
        }
        const [a, b, c, d] = m[1].split(',').map(Number);
        const escalaX = Math.hypot(a, b);
        const escalaY = Math.hypot(c, d);
        if (Math.max(escalaX, escalaY) > 1.05) {
          throw new Error(`${w}x${h}: transform "${medido.transform}" tem `
            + `escala ${Math.max(escalaX, escalaY).toFixed(2)}x - nada de scale `
            + 'para mascarar');
        }
      }
      report.ok(`${w}x${h} (${rotulo}): quadro ${medido.quadro.join('x')} no palco `
        + `${medido.palco.join('x')} (page ${medido.pageRect.join('x')} `
        + `${medido.pagePosition} = viewport ${medido.viewport.join('x')}) -> `
        + `${medido.rotacao}° + ${medido.objectFit}, escala `
        + `${escalaReal.toFixed(3)}x, `
        + `descarte ${medido.objectFit === 'cover'
          ? `${(medido.recorte * 100).toFixed(1)}%` : 'nenhum'}, `
        + `getSettings() ${medido.quadroDeclarado}; proporcao `
        + `${(medido.quadro[0] / medido.quadro[1]).toFixed(4)}; zoom capability `
        + `${JSON.stringify(zoomCapability)}, setting ${zoomSetting ?? '(ausente)'}`);

    }

    // O espectador recebe a mesma exibicao fullscreen com cover.
    const espCli = new Client(server.baseUrl);
    const esp = await espCli.register({ username: randomUsername('esp') });
    const cookiesEsp = await fetch(`${server.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: esp.username, password: 'Senha@Teste123' }),
    }).then((r) => r.headers.getSetCookie());
    const sHost = telas[2];
    const sala = (await api.get(`/api/users/${host.id}/live`)).body.live;
    if (!sala?.id) throw new Error('a LIVE nao subiu para a checagem do espectador');
    const s2 = await browser.newBrowserContext();
    s2.watch();
    telas.push(s2);
    await s2.goto(`${server.baseUrl}/`, { waitMs: 300 });
    for (const ck of cookiesEsp) {
      const par = ck.split(';')[0];
      const nome = par.slice(0, par.indexOf('='));
      await s2.send('Network.setCookie', {
        name: nome, value: decodeURIComponent(par.slice(nome.length + 1)),
        domain: '127.0.0.1', path: '/',
      });
    }
    await s2.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await s2.goto(`${server.baseUrl}/live/${sala.id}`, { waitMs: 3800 });
    let remoto = null;
    for (let i = 0; i < 24; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      remoto = await s2.eval(`
        const v = document.querySelector('.live-video-wrap video.remote');
        if (!v || !v.srcObject || !v.videoWidth) return null;
        const palco = document.querySelector('.live-video-wrap').getBoundingClientRect();
        const cobreX = palco.width / v.videoWidth;
        const cobreY = palco.height / v.videoHeight;
        const cs = getComputedStyle(v);
        const track = v.srcObject.getVideoTracks()[0];
        const settings = track.getSettings();
        const caps = track.getCapabilities();
        const elemento = v.getBoundingClientRect();
        return {
          quadro: [v.videoWidth, v.videoHeight],
          palco: [Math.round(palco.width), Math.round(palco.height)],
          elemento: [Math.round(elemento.width), Math.round(elemento.height)],
          elementoCobrePalco: elemento.width >= palco.width - 1
            && elemento.height >= palco.height - 1,
          pagina: (() => {
            const page = document.querySelector('.live-page');
            const bounds = page.getBoundingClientRect();
            const style = getComputedStyle(page);
            return {
              width: Math.round(bounds.width),
              height: Math.round(bounds.height),
              left: Math.round(bounds.left),
              top: Math.round(bounds.top),
              position: style.position,
              viewportWidth: window.innerWidth,
              viewportHeight: window.innerHeight,
            };
          })(),
          objectFit: cs.objectFit,
          objectPosition: cs.objectPosition,
          cssZoom: cs.zoom,
          cameraSettings: settings,
          cameraZoom: caps.zoom
            ? { min: caps.zoom.min, max: caps.zoom.max, step: caps.zoom.step }
            : null,
          inlineFit: v.style.objectFit || '(nenhum)',
          escalaCover: Math.max(cobreX, cobreY),
          escalaContain: Math.min(cobreX, cobreY),
        };
      `);
      if (remoto && remoto.quadro[0] >= 480) break;
      // eslint-disable-next-line no-await-in-loop
      await sleep(1200);
    }
    if (!remoto) throw new Error('o espectador nao recebeu video com dimensao');
    if (remoto.quadro[0] < 480) {
      throw new Error(`o espectador recebeu um quadro de teste (${remoto.quadro.join('x')}), `
        + 'e nao a transmissao real - a LIVE do host ja tinha encerrado');
    }
    const esperadoEsp = escolherEnquadramento(
      { largura: remoto.quadro[0], altura: remoto.quadro[1] },
      { largura: remoto.palco[0], altura: remoto.palco[1] },
    );
    if (remoto.objectFit !== esperadoEsp.fit) {
      throw new Error(`espectador: quadro ${remoto.quadro.join('x')} em `
        + `${remoto.palco.join('x')} decidiu "${esperadoEsp.fit}" `
        + `(${esperadoEsp.motivo}), mas ficou "${remoto.objectFit}"`);
    }
    if (remoto.objectFit !== 'cover') {
      throw new Error(`espectador: object-fit esperado "cover", recebido "${remoto.objectFit}"`);
    }
    if (remoto.objectPosition !== '50% 50%' || Number(remoto.cssZoom) !== 1) {
      throw new Error(`espectador: object-position/zoom CSS inesperados `
        + `(${remoto.objectPosition}, ${remoto.cssZoom})`);
    }
    if (esperadoEsp.fit !== 'cover') {
      throw new Error(`espectador: a regra retornou "${esperadoEsp.fit}" em vez de cover`);
    }
    const escalaEsp = remoto.escalaCover;
    if (!remoto.elementoCobrePalco) {
      throw new Error(`espectador: elemento ${remoto.elemento.join('x')} nao cobre `
        + `o palco ${remoto.palco.join('x')} - sobra uma area preta`);
    }
    const pagina = remoto.pagina;
    if (pagina.position !== 'fixed'
        || pagina.width !== pagina.viewportWidth
        || pagina.height !== pagina.viewportHeight
        || pagina.left !== 0
        || pagina.top !== 0
        || remoto.palco[0] !== pagina.width
        || remoto.palco[1] !== pagina.height) {
      throw new Error(`espectador: LIVE nao ocupa a viewport inteira `
        + `(${pagina.width}x${pagina.height}, palco ${remoto.palco.join('x')}, `
        + `viewport ${pagina.viewportWidth}x${pagina.viewportHeight})`);
    }
    report.ok(`espectador: quadro ${remoto.quadro.join('x')} em `
      + `elemento ${remoto.elemento.join('x')} / area ${remoto.palco.join('x')}, `
      + `object-fit ${remoto.objectFit} (inline "${remoto.inlineFit}"), `
      + `escala ${escalaEsp.toFixed(3)}x, track ${remoto.cameraSettings.width}x`
      + `${remoto.cameraSettings.height} ratio `
      + `${(remoto.cameraSettings.width / remoto.cameraSettings.height).toFixed(4)}`);
    void sHost;

    report.ok('enquadramento fullscreen com cover no host e no espectador');
  } catch (error) {
    report.fail('verificacao do enquadramento interrompida', error);
  } finally {
    for (const s of telas) { try { s.close?.(); } catch { /* ignore */ } }
    await browser.close();
    await server.stop();
  }
  return report.summary();
}

run().then((r) => process.exit(r.failed > 0 ? 1 : 0)).catch((e) => { console.error(e); process.exit(1); });