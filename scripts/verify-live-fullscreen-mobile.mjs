/**
 * Verificador VISUAL da LIVE mobile em tela cheia (390x844).
 *
 * `npm test` passar nao prova nada sobre ESTE defeito, que e visual. Aqui a
 * tela e conferida pelos 10 pontos que o relato descreve, e um PNG real e
 * gravado para inspecao.
 *
 * A) a LIVE ocupa toda a tela
 * B) nao existe faixa preta gigante
 * C) nao existe faixa horizontal de video (video emFatia no meio da tela)
 * D) o rosto nao fica gigante
 * E) cabeca/ombros aparecem naturalmente
 * F) nao corta exageradamente as laterais
 * G) nao existe zoom digital
 * H) controles ficam SOBRE o video
 * I) comentarios ficam SOBRE o video
 * J) coracao fica SOBRE o video
 *
 * Para D/E/F o que e medido e a ESCALA do quadro: com `cover` numa viewport
 * portrait e um quadro portrait, o quadro so ENCOLHE (escala < 1), logo o
 * rosto e desenhado menor que o capturado - que e o oposto de zoom. O
 * descriptor usado na camera e um alvo MAIOR que a viewport, de proposito: se
 * o app cortasse demais, a largura do alvo cairia e o teste perceberia.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  startServer, Client, Report, sleep, randomUsername,
} from '../tests/helpers.mjs';
import { ROOT } from '../server/config.js';
import { launchChrome } from '../tests/cdp.mjs';

const SAIDA = path.join(ROOT, 'tests', 'artifacts', 'telas-rodada4');
const LARGURA = 390;
const ALTURA = 844;

const report = new Report('LIVE mobile em tela cheia (390x844)');

/** Maior faixa de pixels escuros contigua a partir das duas pontas de um eixo. */
function medirBarras(a, b, limite = 0.5) {
  const n = Math.min(a.length, b.length);
  const max = Math.max(1, Math.floor(n * limite));
  let inicio = 0;
  while (inicio < max && a[inicio] < 8 && b[inicio] < 8) inicio += 1;
  let fim = 0;
  while (fim < max && a[n - 1 - fim] < 8 && b[n - 1 - fim] < 8) fim += 1;
  return { inicio, fim };
}

/**
 * Fator de escala embutido num `transform: matrix(...)`.
 *
 * As COLUNAS da matriz sao as imagens dos eixos X e Y. Se uma delas for maior
 * que 1, existe `scale` - que e o que o relato proibe. Rotacao e espelho
 * mantem as duas colunas com norma 1, entao a conta separa exatamente o que
 * queremos (nao虹existe escala) do que e permitido (girar e espelhar).
 *
 * @param {string} transform valor de `getComputedStyle(...).transform`
 * @returns {number}
 */
function escalaDoTransform(transform) {
  if (!transform || transform === 'none') return 1;
  const m = /matrix\(([^)]+)\)/.exec(transform);
  if (!m) return 1;
  const [a, b, c, d] = m[1].split(',').map(Number);
  if (![a, b, c, d].every(Number.isFinite)) return 1;
  return Math.max(Math.hypot(a, b), Math.hypot(c, d));
}

/** Angulo de rotacao embutido no `transform`, em graus (0, 90, 180 ou 270). */
function anguloDoTransform(transform) {
  if (!transform || transform === 'none') return 0;
  const m = /matrix\(([^)]+)\)/.exec(transform);
  if (!m) return 0;
  const [a, b] = m[1].split(',').map(Number);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.round((Math.atan2(b, a) * 180) / Math.PI);
}

/**
 * Confere os 10 pontos do relato visual sobre uma tela ja medida.
 *
 * @param {object} estado saida da medicao no navegador
 * @param {string} quem `host` ou `espectador`, so para o texto do relatorio
 * @returns {string[]} lista de problemas (vazia = tudo certo)
 */
function conferirTela(estado, quem) {
  const falhas = [];
  const [vpL, vpA] = estado.viewport;
  const marca = quem === 'host' ? '' : ` (${quem})`;

  // ---- A) a LIVE ocupa toda a tela ---------------------------------
  if (estado.page.w !== vpL || estado.page.h !== vpA) {
    falhas.push(`A${marca}) .live-page mede ${estado.page.w}x${estado.page.h} e a `
      + `viewport e ${vpL}x${vpA}`);
  }
  if (estado.page.x !== 0 || estado.page.y !== 0) {
    falhas.push(`A${marca}) .live-page comeca em [${estado.page.x},${estado.page.y}] `
      + 'em vez de [0,0]');
  }
  // Nada de app aparecendo ao redor: o palco cobre a pagina toda.
  if (estado.wrap.w !== estado.page.w || estado.wrap.h !== estado.page.h) {
    falhas.push(`A${marca}) palco ${estado.wrap.w}x${estado.wrap.h} nao cobre a `
      + `pagina ${estado.page.w}x${estado.page.h}`);
  }
  if (!estado.wrap.dentro) {
    falhas.push(`A${marca}) o palco sai da viewport`);
  }
  // Com rotacao + `cover`, o elemento TRANSBORDA de proposito (o wrap tem
  // `overflow: hidden`): o que nao pode e o centro sair do palco, nem o
  // elemento cobrir menos que o palco.
  const girou = (Number(estado.rotacao) || 0) !== 0;
  if (girou) {
    const cx = estado.video.x + estado.video.w / 2;
    const cy = estado.video.y + estado.video.h / 2;
    if (cx < -1 || cx > estado.wrap.w + 1 || cy < -1 || cy > estado.wrap.h + 1) {
      falhas.push(`A${marca}) o centro do video girado `
        + `(${cx.toFixed(0)},${cy.toFixed(0)}) saiu do palco `
        + `${estado.wrap.w}x${estado.wrap.h}`);
    }
    if (estado.video.w < estado.wrap.w - 1 || estado.video.h < estado.wrap.h - 1) {
      falhas.push(`A${marca}) o video girado `
        + `(${estado.video.w}x${estado.video.h}) nao cobre o palco `
        + `${estado.wrap.w}x${estado.wrap.h}`);
    }
  } else if (!estado.video.dentro) {
    falhas.push(`A${marca}) o video sai da viewport`);
  }
  if (!falhas.length) {
    report.ok(`A${marca}) tela cheia: .live-page ${estado.page.w}x${estado.page.h} `
      + `em [${estado.page.x},${estado.page.y}] = viewport ${vpL}x${vpA}, `
      + 'palco e video dentro da tela, sem pagina ao redor');
  }

  // ---- G) sem zoom digital ------------------------------------------
  // A escala REAL depende da ROTACAO: com o quadro girado, quem enche a tela e
  // a altura do quadro virando largura. Medir sem trocar as dimensoes daria
  // 2,34x num quadro que na real esta encolhendo.
  const rot = Number(estado.rotacao) || 0;
  const girado = rot !== 0;
  const qLargura = girado ? estado.quadro[1] : estado.quadro[0];
  const qAltura = girado ? estado.quadro[0] : estado.quadro[1];
  const cobreX = estado.wrap.w / Math.max(1, qLargura);
  const cobreY = estado.wrap.h / Math.max(1, qAltura);
  const escala = estado.objectFit === 'cover'
    ? Math.max(cobreX, cobreY)
    : (estado.objectFit === 'contain' ? Math.min(cobreX, cobreY) : 1);
  if (escala > 1.35) {
    falhas.push(`G${marca}) ampliacao de ${escala.toFixed(2)}x com `
      + `"${estado.objectFit}" - zoom digital`);
  }
  // `transform` pode girar e espelhar (as colunas da matriz continuam com norma
  // 1); o que e proibido e ESCALAR.
  const escalaTransform = escalaDoTransform(estado.transform);
  if (escalaTransform > 1.05) {
    falhas.push(`G${marca}) transform "${estado.transform}" tem escala `
      + `${escalaTransform.toFixed(2)}x - nada de scale`);
  }
  const angulo = anguloDoTransform(estado.transform);
  if (angulo !== 0 && angulo !== 90 && angulo !== 180 && angulo !== 270) {
    falhas.push(`G${marca}) rotacao de ${angulo}° no transform - só 90/180/270`);
  }
  if (estado.objectFit === 'contain' && escala > 1.3) {
    falhas.push(`G${marca}) contain esticou ${escala.toFixed(2)}x`);
  }
  if (!falhas.length) {
    report.ok(`G${marca}) sem zoom digital: quadro ${estado.quadro.join('x')} `
      + `(na tela ${qLargura}x${qAltura}) em ${estado.wrap.w}x${estado.wrap.h} `
      + `com "${estado.objectFit}", escala ${escala.toFixed(3)}x, `
      + `transform ${estado.transform} (escala embutida `
      + `${escalaTransform.toFixed(2)}x, giro ${angulo}°)`);
  }

  // ---- B/C/F) barras e corte, lidos dos pixels REAIS -----------------
  // Mede OS DOIS eixos, e o canvas REPRODUZ o `object-fit` (ver MEDIR acima):
  // sem isso o video seria esticado e as tarjas nunca apareceriam.
  //
  const orientacaoQuadro = estado.quadro[1] > estado.quadro[0] ? 'portrait' : 'landscape';
  const orientacaoPalco = estado.wrap.h >= estado.wrap.w ? 'portrait' : 'landscape';
  const orientacoesConflitam = orientacaoQuadro !== orientacaoPalco;

  if (!estado.pixels) {
    falhas.push(`B${marca}) nao foi possivel ler os pixels do video (canvas)`);
  } else {
    const [cw, ch] = estado.amostra;
    const p = estado.pixels;
    const coluna = (x) => {
      const fora = [];
      for (let y = 0; y < ch; y += 1) {
        const i = (y * cw + x) * 4;
        fora.push((p[i] + p[i + 1] + p[i + 2]) / 3);
      }
      return fora;
    };
    const linha = (y) => {
      const fora = [];
      for (let x = 0; x < cw; x += 1) {
        const i = (y * cw + x) * 4;
        fora.push((p[i] + p[i + 1] + p[i + 2]) / 3);
      }
      return fora;
    };
    const vert = medirBarras(coluna(Math.floor(cw / 2)), coluna(1));
    const horiz = medirBarras(linha(Math.floor(ch / 2)), linha(1));
    const pctTopo = (vert.inicio / ch) * 100;
    const pctBase = (vert.fim / ch) * 100;
    const pctEsq = (horiz.inicio / cw) * 100;
    const pctDir = (horiz.fim / cw) * 100;
    const ocupacaoX = 100 - pctEsq - pctDir;
    const ocupacaoY = 100 - pctTopo - pctBase;
    const maiorBarra = Math.max(pctTopo, pctBase, pctEsq, pctDir);

    if (!orientacoesConflitam || girou) {
      // Mesmo orientacao, ou conflito resolvido pela rotacao: tela cheia nos DOIS
      // eixos e sem tarja - que e exatamente o resultado pedido.
      if (ocupacaoX < 97 || ocupacaoY < 97) {
        falhas.push(`B/C${marca}) quadro ${orientacaoQuadro} em palco `
          + `${orientacaoPalco}${girou ? ` (girado ${estado.rotacao}°)` : ''}: `
          + `esperava tela cheia, e a ocupacao foi X ${ocupacaoX.toFixed(1)}%, `
          + `Y ${ocupacaoY.toFixed(1)}%`);
      } else {
        report.ok(`B/C${marca}) quadro ${estado.quadro.join('x')} `
          + `${orientacaoQuadro} em palco ${orientacaoPalco}`
          + `${girou ? ` girado ${estado.rotacao}° -> ${qLargura}x${qAltura}` : ''}: `
          + `TELA CHEIA (X ${ocupacaoX.toFixed(1)}%, Y ${ocupacaoY.toFixed(1)}%), `
          + 'sem tarja e sem faixa');
      }
    } else {
      // Conflito SEM rotacao: nao ha como ter tela cheia e camera natural ao
      // mesmo tempo. O app escolheu nao ampliar a pessoa.
      if (estado.objectFit === 'cover') {
        falhas.push(`F${marca}) quadro ${orientacaoQuadro} em palco `
          + `${orientacaoPalco} com cover e sem rotacao: isso e o rosto gigante`);
      } else if (escala > 1.3) {
        falhas.push(`G${marca}) ${estado.objectFit} ampliou `
          + `${escala.toFixed(2)}x no conflito de orientacao`);
      } else {
        report.ok(`B/C/F${marca}) CONFLITO DE ORIENTACAO NAO GIRADO (quadro `
          + `${estado.quadro.join('x')} ${orientacaoQuadro} em palco `
          + `${estado.wrap.w}x${estado.wrap.h} ${orientacaoPalco}): o app escolheu `
          + `"${estado.objectFit}" - quadro inteiro, escala `
          + `${escala.toFixed(3)}x, ocupacao X ${ocupacaoX.toFixed(1)}% `
          + `Y ${ocupacaoY.toFixed(1)}%`);
      }
    }
    if (!falhas.length && maiorBarra > 45) {
      falhas.push(`B${marca}) tarja preta de ${maiorBarra.toFixed(1)}% do palco`);
    }
  }

  // ---- D/E) o rosto nao esta gigante --------------------------------
  // A camera falsa desenha um alvo de largura conhecida em relacao ao quadro.
  // Se o app cortasse demais, o alvo cresceria na tela. Com escala <= 1 o
  // alvo e desenhado no tamanho capturado ou MENOR - o oposto de zoom, e o
  // enquadramento de cabeca + ombros que uma camera real entrega.
  const larguraAlvo = estado.quadro[0] * 0.18;
  const pctDaTela = ((larguraAlvo * escala) / estado.wrap.w) * 100;
  if (pctDaTela > 55) {
    falhas.push(`D${marca}) o alvo ocuparia ${pctDaTela.toFixed(1)}% da `
      + 'largura da tela - rosto gigante');
  }
  if (!falhas.length) {
    report.ok(`D/E${marca}) enquadramento natural: escala ${escala.toFixed(3)}x `
      + `(${escala <= 1 ? 'encolhe o quadro' : 'ampliacao imperceptivel'}), `
      + `alvo em ~${pctDaTela.toFixed(1)}% da largura da tela - `
      + 'cabeca e ombros no tamanho natural');
  }

  // ---- H/I/J) overlays SOBRE o video --------------------------------
  const sobre = (caixa, rotulo, nome) => {
    if (!caixa) {
      falhas.push(`${rotulo}${marca}) ${nome} ausente na LIVE`);
      return;
    }
    const interage = caixa.x < estado.video.x + estado.video.w
      && caixa.x + caixa.w > estado.video.x
      && caixa.y < estado.video.y + estado.video.h
      && caixa.y + caixa.h > estado.video.y;
    if (!interage) {
      falhas.push(`${rotulo}${marca}) ${nome} ${caixa.w}x${caixa.h} em `
        + `[${caixa.x},${caixa.y}] nao esta sobre o video `
        + `[${estado.video.x},${estado.video.y} ${estado.video.w}x${estado.video.h}]`);
      return;
    }
    if (!caixa.dentro) {
      falhas.push(`${rotulo}${marca}) ${nome} saiu da viewport - esta cortado`);
    }
    report.ok(`${rotulo}${marca}) ${nome}: ${caixa.w}x${caixa.h} em `
      + `[${caixa.x},${caixa.y}] sobre o video, dentro da viewport`);
  };
  sobre(estado.top, 'H)', 'cabecalho / AO VIVO');
  sobre(estado.chat, 'I)', 'comentarios');
  sobre(estado.campo, 'H)', 'campo de comentario');
  sobre(estado.coracao, 'J)', 'coracao');
  return falhas;
}

async function run() {
  fs.mkdirSync(SAIDA, { recursive: true });

  const server = await startServer();
  const api = new Client(server.baseUrl);
  const host = await api.register({ username: randomUsername('host') });
  const cookies = (await fetch(`${server.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: host.username, password: 'Senha@Teste123' }),
  })).headers.getSetCookie();

  const browser = await launchChrome({
    extraArgs: [
      '--autoplay-policy=no-user-gesture-required',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
    ],
  });

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
  await s.send('Emulation.setDeviceMetricsOverride', {
    width: LARGURA, height: ALTURA, deviceScaleFactor: 1, mobile: true,
  });

  try {
    await s.goto(`${server.baseUrl}/iniciar-live`, { waitMs: 2600 });
    const clicou = await s.eval(`
      const b = [...document.querySelectorAll('button')]
        .find((x) => /iniciar transmissao/i.test(x.textContent || ''));
      if (!b) return 'sem botao';
      b.click();
      return 'clicou';
    `);
    if (clicou !== 'clicou') throw new Error(`botao de iniciar: ${clicou}`);
    await sleep(6500);

    // Comentario REAL de um espectador, para a regiao de mensagens existir de
    // verdade na tela - sem isso o check I (comentarios sobre o video) rodaria
    // contra um container vazio e nao provaria nada.
    const sala = (await api.get(`/api/users/${host.id}/live`)).body.live;
    if (!sala?.id) throw new Error('a LIVE nao subiu para receber comentario');
    const espCli = new Client(server.baseUrl);
    const esp = await espCli.register({ username: randomUsername('esp') });
    // Comentar exige estar NA LIVE (a rota devolve 403 `not_in_live`).
    const entrou = await espCli.post(`/api/live/${sala.id}/join`, {});
    if (entrou.status >= 400) {
      throw new Error(`espectador nao entrou na LIVE: ${entrou.status} `
        + JSON.stringify(entrou.body));
    }
    const postou = await espCli.post(`/api/live/${sala.id}/messages`, { body: 'Oi, LIVE no ponto!' });
    if (postou.status >= 400) {
      throw new Error(`comentario nao entrou: ${postou.status} ${JSON.stringify(postou.body)}`);
    }
    await sleep(1400);

    // Estado real: medidas do DOM + pixels de verdade da area do video.
    // A mesma medicao roda no host (`video.local`) e no espectador
    // (`video.remote`), porque os dois caminhos usam o mesmo enquadramento.
    const MEDIR = (classe) => `
      const page = document.querySelector('.live-page');
      const wrap = document.querySelector('.live-video-wrap');
      const video = document.querySelector('.live-video-wrap video.${classe}');
      if (!page || !wrap || !video) return null;
      const r = (el) => {
        const b = el.getBoundingClientRect();
        return {
          x: Math.round(b.left), y: Math.round(b.top),
          w: Math.round(b.width), h: Math.round(b.height),
          dentro: b.left >= -1 && b.top >= -1
            && b.right <= window.innerWidth + 1
            && b.bottom <= window.innerHeight + 1,
        };
      };
      const chat = document.querySelector('.live-chat');
      const campo = document.querySelector('.live-input-bar');
      const coracao = document.querySelector('.live-heart-btn');
      const top = document.querySelector('.live-top');
      // Desenha a area do video num canvas para ler os pixels REAIS.
      //
      // Importante: \`drawImage(video, 0, 0, w, h)\` ESTICA o conteudo e ignora
      // o \`object-fit\`, entao as tarjas de \`contain\` nunca apareceriam e o
      // teste passaria com a imagem esticada. Aqui a mesma conta do
      // \`object-fit\` e reproduzida (com \`object-position: center\`), e o que
      // sobra do canvas e pintado de preto - exatamente o que a tela mostra.
      const box = wrap.getBoundingClientRect();
      const cv = document.createElement('canvas');
      cv.width = Math.max(1, Math.round(box.width));
      cv.height = Math.max(1, Math.round(box.height));
      const ctx = cv.getContext('2d');
      const cs = getComputedStyle(video);
      const fit = cs.objectFit;
      const vw = video.videoWidth || 1;
      const vh = video.videoHeight || 1;
      // O quadro efetivo: com rotacao, largura e altura trocam de lugar.
      const rot = Number(video.dataset.rotacao) || 0;
      const efL = rot ? vh : vw;
      const efA = rot ? vw : vh;
      const escala = fit === 'cover'
        ? Math.max(cv.width / efL, cv.height / efA)
        : (fit === 'none' ? 1 : Math.min(cv.width / efL, cv.height / efA));
      const dw = efL * escala;
      const dh = efA * escala;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, cv.width, cv.height);
      // Desenha girado em torno do centro do palco, que e o que a tela mostra.
      // Com o contexto girado, o eixo X local vira o Y do palco: as dimensoes
      // do drawImage entram TROCADAS.
      ctx.save();
      ctx.translate(cv.width / 2, cv.height / 2);
      if (rot) ctx.rotate((rot * Math.PI) / 180);
      try {
        if (rot) ctx.drawImage(video, -dh / 2, -dw / 2, dh, dw);
        else ctx.drawImage(video, -dw / 2, -dh / 2, dw, dh);
      } catch { /* canvas vazio: o verificador acusa via sem pixels */ }
      ctx.restore();
      let pixels = null;
      try {
        pixels = ctx.getImageData(0, 0, cv.width, cv.height).data;
      } catch { pixels = null; }
      return {
        viewport: [window.innerWidth, window.innerHeight],
        dpr: window.devicePixelRatio,
        page: r(page),
        wrap: r(wrap),
        video: r(video),
        quadro: [video.videoWidth, video.videoHeight],
        rotacao: Number(video.dataset.rotacao) || 0,
        objectFit: getComputedStyle(video).objectFit,
        inlineFit: video.style.objectFit || '(nenhum)',
        transform: getComputedStyle(video).transform,
        chat: chat ? r(chat) : null,
        campo: campo ? r(campo) : null,
        coracao: coracao ? r(coracao) : null,
        top: top ? r(top) : null,
        pixels: pixels ? Array.from(pixels) : null,
        amostra: [Math.round(cv.width), Math.round(cv.height)],
      };
    `;
    const estado = await s.eval(MEDIR('local'));
    if (!estado) throw new Error('a LIVE nao montou palco/video local');
    if (!estado.wrap) throw new Error('a medicao nao trouxe as medidas do palco');

    const { data } = await s.send('Page.captureScreenshot', { format: 'png' });
    const arquivo = path.join(SAIDA, 'live-mobile-390x844-fullscreen.png');
    fs.writeFileSync(arquivo, Buffer.from(data, 'base64'));
    report.ok(`screenshot real gravado: ${path.relative(ROOT, arquivo)} `
      + `(${estado.viewport.join('x')} @${estado.dpr}x)`);

    const falhas = conferirTela(estado, 'host');

    // ---- ESPECTADOR: o mesmo enquadramento, na tela de quem assiste --
    const s2 = await browser.newBrowserContext();
    s2.watch();
    try {
      await s2.goto(`${server.baseUrl}/`, { waitMs: 300 });
      const espCookies = (await fetch(`${server.baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: esp.username, password: 'Senha@Teste123' }),
      })).headers.getSetCookie();
      for (const ck of espCookies) {
        const par = ck.split(';')[0];
        const nome = par.slice(0, par.indexOf('='));
        await s2.send('Network.setCookie', {
          name: nome, value: decodeURIComponent(par.slice(nome.length + 1)),
          domain: '127.0.0.1', path: '/',
        });
      }
      await s2.send('Emulation.setDeviceMetricsOverride', {
        width: LARGURA, height: ALTURA, deviceScaleFactor: 1, mobile: true,
      });
      await s2.goto(`${server.baseUrl}/live/${sala.id}`, { waitMs: 4000 });
      // O video remoto chega por WebRTC. A tela do espectador comeca com um
      // quadro de espera pequeno (180x320); medir isso nao provaria nada, entao
      // o laço so aceita o quadro real da transmissao (>= 480 de largura).
      let estadoEsp = null;
      for (let i = 0; i < 25; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        estadoEsp = await s2.eval(MEDIR('remote'));
        if (estadoEsp?.quadro[0] >= 480) break;
        // eslint-disable-next-line no-await-in-loop
        await sleep(1000);
      }
      if (!estadoEsp || !estadoEsp.quadro[0]) {
        throw new Error('o espectador nao recebeu o video remoto do host');
      }
      if (estadoEsp.quadro[0] < 480) {
        throw new Error(`espectador ficou no quadro de espera `
          + `${estadoEsp.quadro.join('x')} - a transmissao real nao chegou`);
      }
      const tiro = await s2.send('Page.captureScreenshot', { format: 'png' });
      const arquivoEsp = path.join(SAIDA, 'espectador-mobile-390x844-fullscreen.png');
      fs.writeFileSync(arquivoEsp, Buffer.from(tiro.data, 'base64'));
      report.ok(`screenshot real do espectador: `
        + `${path.relative(ROOT, arquivoEsp)}`);
      const falhasEsp = conferirTela(estadoEsp, 'espectador');
      falhas.push(...falhasEsp);
    } finally {
      try { s2.close?.(); } catch { /* ignore */ }
    }

    if (falhas.length) {
      report.fail('a LIVE mobile nao satisfaz o relato visual', falhas.join(' | '));
    } else {
      report.ok('A-J conferidos no host e no espectador: tela cheia, sem tarja, '
        + 'sem faixa horizontal, sem zoom e com todos os overlays sobre o video');
    }
  } catch (error) {
    report.fail('verificacao visual interrompida', error);
  } finally {
    try { s.close?.(); } catch { /* ignore */ }
    await browser.close();
    await server.stop();
  }
  return report.summary();
}

run().then((r) => process.exit(r.failed > 0 ? 1 : 0)).catch((e) => { console.error(e); process.exit(1); });
