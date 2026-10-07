/**
 * DIAGNOSTICO DA CAMERA REAL - separa "zoom na captura" de "zoom na exibicao".
 *
 * Por que isto existe: os testes automatizados passam com a camera FALSA do
 * Chrome, que obedece qualquer constraint e nao tem sensor para recortar. No
 * CELULAR REAL o driver da camera pode entregar um frame 720x1280 que ja vem
 * CORTADO e AMPLIADO por dentro - e `getSettings()` continua reportando
 * 720x1280, entao nada no CSS denuncia o problema.
 *
 * Este modulo responde a uma unica pergunta, com numeros lidos no aparelho:
 *
 *   A) o frame BRUTO do stream ja esta com o rosto grande?
 *   B) o frame BRUTO esta normal e so a EXIBICAO amplia?
 *
 * Metodo (independente de dispositivo, sem depender decretecnica de rosto):
 *
 *   1. Desenha-se o MediaStream direto num canvas 1:1, sem passar por nenhum
 *      `<video>` do DOM e sem CSS. Esse e o "frame bruto" (A).
 *   2. Desenha-se o `<video>` que esta na tela num canvas do mesmo tamanho
 *      que o elemento. O navegador aplica `object-fit`/`object-position`/
 *      crop nessa hora, entao esse e o "frame exibido" (B).
 *   3. Reduz-se os dois para a MESMA largura pequena (64px) e compara-se pixel
 *      a pixel. Se o conteudo for o mesmo com o mesmo tamanho aparente, a
 *      diferenca e pequena e o zoom NAO esta na renderizacao - logo esta no
 *      stream (caso A). Se o exibido for um recorte ampliado do bruto, a
 *      diferenca e grande (caso B).
 *
 * Alem dos numeros, o painel desenha tres miniaturas - bruto, exibido e a
 * PREVIA do bruto em 1:1 na largura da tela - para o olho comparar no
 * proprio aparelho.
 */

/** Largura fixa da comparacao. Pequena o bastante para ser rapida, grande o
 *  bastante para que um crop mude a assinatura de pixels. */
const LADO_DA_ASSINATURA = 48;
/** Diferenca media por canal (0-255) abaixo da qual consideramos "mesma cena". */
const LIMIAR_MESMA_CENA = 12;

/**
 * Le tudo o que o navegador sabe sobre um track.
 *
 * @param {MediaStreamTrack|null} track
 * @returns {object} objeto plano, serializavel, com os campos que importam
 */
export function inspecionarTrack(track) {
  const seguro = (fn) => {
    try {
      return fn();
    } catch {
      return null;
    }
  };
  const settings = seguro(() => track?.getSettings?.()) || {};
  const constraints = seguro(() => track?.getConstraints?.()) || {};
  const capabilities = seguro(() => track?.getCapabilities?.()) || {};
  return {
    label: settings.deviceId || constraints.deviceId || '(sem deviceId)',
    groupId: settings.groupId || null,
    // --- o que importa para o enquadramento ---
    width: settings.width ?? null,
    height: settings.height ?? null,
    aspectRatio: settings.aspectRatio ?? null,
    frameRate: settings.frameRate ?? null,
    facingMode: settings.facingMode ?? null,
    // --- zoom: a pista do crop interno do driver ---
    zoom: settings.zoom ?? null,
    capabilitiesZoom: capabilities.zoom
      ? { min: capabilities.zoom.min, max: capabilities.zoom.max, step: capabilities.zoom.step }
      : null,
    // --- outros caps que podem implicar crop/recorte ---
    capabilitiesAspectRatio: capabilities.aspectRatio
      ? { min: capabilities.aspectRatio.min, max: capabilities.aspectRatio.max }
      : null,
    capabilitiesWidth: capabilities.width ? { min: capabilities.width.min, max: capabilities.width.max } : null,
    capabilitiesHeight: capabilities.height ? { min: capabilities.height.min, max: capabilities.height.max } : null,
    // --- o que foi pedido (revela se pedimos proporcao, que forcaria crop) ---
    constraintsAsked: {
      width: constraints.width ?? null,
      height: constraints.height ?? null,
      aspectRatio: constraints.aspectRatio ?? null,
      zoom: constraints.zoom ?? null,
      advanced: Array.isArray(constraints.advanced)
        ? constraints.advanced.map((a) => Object.keys(a || {}).join('+') || '(vazio)')
        : null,
    },
  };
}

/**
 * Proporcao do quadro entregue e se ele e "portrait de verdade".
 *
 * Um sensor 4:3 (1.333) e um sensor 16:9 (1.777) sao landscape. Se o aparelho
 * entregou 720x1280 (0.5625) pedindo 9:16, alguma conversao aconteceu - e a
 * unica forma de converter landscape em portrait sem distorcer e RECORTAR.
 *
 * @param {{width:number|null,height:number|null}} q
 * @returns {{proporcao:number|null, portrait:boolean, landscape:boolean, quadrado:boolean}}
 */
export function classificacaoDoQuadro(q) {
  const w = Number(q?.width) || 0;
  const h = Number(q?.height) || 0;
  if (w < 1 || h < 1) {
    return { proporcao: null, portrait: false, landscape: false, quadrado: false };
  }
  const proporcao = w / h;
  return {
    proporcao,
    portrait: proporcao < 0.95,
    landscape: proporcao > 1.05,
    quadrado: proporcao >= 0.95 && proporcao <= 1.05,
  };
}

/**
 * Pega UM frame do stream, sem passar por nenhum elemento do DOM.
 *
 * `drawImage` nao aceita `MediaStream`. Dois caminhos:
 *
 *   1. `ImageCapture.grabFrame()` (Chromium, inclusive Android): devolve um
 *      `VideoFrame` direto do track - o frame mais cru que existe, sem DOM,
 *      sem CSS, sem `object-fit`.
 *   2. Um `<video>` criado e NAO colocado no DOM: sem CSS nao ha como o
 *      navegador aplicar `object-fit`, `transform` ou recorte. Serve de ponte
 *      para o `drawImage` e e solto logo depois.
 *
 * @param {MediaStream} stream
 * @returns {Promise<{canvas:HTMLCanvasElement, largura:number, altura:number}>}
 */
async function quadroBrutoComoCanvas(stream) {
  const track = stream.getVideoTracks()[0];
  if (!track) throw new Error('stream sem track de video');

  // Caminho 1: ImageCapture - o frame mais cru disponivel.
  if (typeof window !== 'undefined' && typeof window.ImageCapture === 'function') {
    try {
      const captura = new window.ImageCapture(track);
      const frame = await captura.grabFrame();
      const largura = frame.displayWidth || frame.codedWidth
        || Number(track.getSettings().width);
      const altura = frame.displayHeight || frame.codedHeight
        || Number(track.getSettings().height);
      const cv = document.createElement('canvas');
      cv.width = largura;
      cv.height = altura;
      cv.getContext('2d').drawImage(frame, 0, 0, largura, altura);
      frame.close?.();
      return { canvas: cv, largura, altura };
    } catch {
      // sem ImageCapture utilizavel: cai no caminho 2
    }
  }

  // Caminho 2: <video> fora do DOM (imune a CSS).
  const ponte = document.createElement('video');
  ponte.srcObject = stream;
  ponte.muted = true;
  ponte.playsInline = true;
  ponte.autoplay = true;
  try {
    await ponte.play();
  } catch {
    // `play()` pode ser bloqueado; os metadados ainda chegam.
  }
  await new Promise((resolve) => {
    if (ponte.videoWidth > 0) {
      resolve();
      return;
    }
    const limite = Date.now() + 4000;
    const tick = () => {
      if (ponte.videoWidth > 0 || Date.now() > limite) resolve();
      else requestAnimationFrame(tick);
    };
    ponte.addEventListener('loadedmetadata', () => requestAnimationFrame(tick));
    requestAnimationFrame(tick);
  });
  const largura = ponte.videoWidth;
  const altura = ponte.videoHeight;
  if (!largura || !altura) throw new Error('frame bruto indisponivel');
  const cv = document.createElement('canvas');
  cv.width = largura;
  cv.height = altura;
  cv.getContext('2d').drawImage(ponte, 0, 0, largura, altura);
  ponte.srcObject = null;
  return { canvas: cv, largura, altura };
}

/** Desenha uma fonte num canvas e devolve os pixels. */
function pixelsDe(fonte, largura, altura) {
  const cv = document.createElement('canvas');
  cv.width = Math.max(1, Math.round(largura));
  cv.height = Math.max(1, Math.round(altura));
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(fonte, 0, 0, cv.width, cv.height);
  return ctx.getImageData(0, 0, cv.width, cv.height).data;
}

/**
 * Onde o conteudo do quadro e desenhado dentro de uma caixa `w` x `h`.
 *
 * E a mesma conta que o navegador faz com `object-fit`, e e o que permite
 * comparar as duas imagens de forma justa: em vez de comparar as caixas
 * inteiras (que tem tarjas de tamanhos diferentes), compara-se so a REGIAO
 * DE CONTEUDO de cada uma, reamostrada no mesmo tamanho.
 *
 * @param {number} w largura da caixa
 * @param {number} h altura da caixa
 * @param {number} fw largura do quadro
 * @param {number} fh altura do quadro
 * @param {string} objectFit valor computed de `object-fit`
 * @returns {{x:number,y:number,w:number,h:number,escala:number}}
 */
function regiaoDeConteudo(w, h, fw, fh, objectFit) {
  const escala = objectFit === 'cover'
    ? Math.max(w / fw, h / fh)
    : (objectFit === 'contain' || objectFit === 'scale-down'
      ? Math.min(w / fw, h / fh)
      : 1); // `fill` e `none` desenham 1:1 (distorcido ou recortado)
  const cw = fw * escala;
  const ch = fh * escala;
  return { x: (w - cw) / 2, y: (h - ch) / 2, w: cw, h: ch, escala };
}

/** Recorta uma regiao e reamostra para `LADO_DA_ASSINATURA` quadrado. */
function assinaturaDaRegiao(pixels, larguraOrig, alturaOrig, regiao) {
  const LADO = LADO_DA_ASSINATURA;
  const cv = document.createElement('canvas');
  cv.width = LADO;
  cv.height = LADO;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  const fonte = document.createElement('canvas');
  fonte.width = larguraOrig;
  fonte.height = alturaOrig;
  fonte.getContext('2d').putImageData(
    new ImageData(new Uint8ClampedArray(pixels), larguraOrig, alturaOrig), 0, 0,
  );
  // O desenho vai inteiro para o canvas de origem; aqui so recortamos a regiao.
  ctx.drawImage(
    fonte,
    regiao.x, regiao.y, Math.max(1, regiao.w), Math.max(1, regiao.h),
    0, 0, LADO, LADO,
  );
  return suaviza(ctx.getImageData(0, 0, LADO, LADO).data, LADO, LADO);
}

/**
 * Desfoque de caixa 3x3.
 *
 * As duas capturas (bruta e exibida) acontecem em instantes diferentes, e a
 * cena se move no meio - na camera falsa e o alvo gira; numa camera real sao
 * olhos, luz e maos. Sem suavizar, uma borda que andou 2px ja produz diferenca
 * grande e o veredito vira "B" sem ser zoom. O desfoque compara a ESTRUTURA da
 * imagem, que e o que define o enquadramento, e nao o instante exato.
 *
 * @param {Uint8ClampedArray} dados RGBA de `lado` x `lado`
 * @param {number} lado
 * @returns {Uint8ClampedArray} copia suavizada
 */
function suaviza(dados, lado) {
  const saida = new Uint8ClampedArray(dados.length);
  for (let y = 0; y < lado; y += 1) {
    for (let x = 0; x < lado; x += 1) {
      for (let canal = 0; canal < 3; canal += 1) {
        let soma = 0;
        let conta = 0;
        for (let dy = -1; dy <= 1; dy += 1) {
          const yy = y + dy;
          if (yy < 0 || yy >= lado) continue;
          for (let dx = -1; dx <= 1; dx += 1) {
            const xx = x + dx;
            if (xx < 0 || xx >= lado) continue;
            soma += dados[(yy * lado + xx) * 4 + canal];
            conta += 1;
          }
        }
        saida[(y * lado + x) * 4 + canal] = Math.round(soma / conta);
      }
      // Alfa preservado.
      const i = (y * lado + x) * 4;
      saida[i + 3] = dados[i + 3];
    }
  }
  return saida;
}

/**
 * Diferenca media absoluta por canal entre duas assinaturas de mesmo tamanho.
 *
 * Ignora os 5% de pixels mais diferentes de cada lado: sao as bordas em
 * movimento entre as duas capturas. Sem isso, um unico detalhe em movimento
 * daria um veredito errado.
 */
function diferencaMedia(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 4) return 255;
  const amostras = [];
  for (let i = 0; i < n; i += 4) {
    amostras.push(
      (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])) / 3,
    );
  }
  amostras.sort((x, y) => x - y);
  const corte = Math.floor(amostras.length * 0.95);
  const usados = amostras.slice(0, Math.max(1, corte));
  const soma = usados.reduce((acc, v) => acc + v, 0);
  return soma / usados.length;
}

/**
 * A pergunta decisiva: o frame BRUTO ja vem ampliado, ou a exibicao amplia?
 *
 * @param {MediaStream} stream stream da camera (fonte do frame bruto)
 * @param {HTMLVideoElement} video elemento que esta na tela
 * @returns {object} veredito com numeros e o rotulo do caso
 */
export async function compararCapturaComExibicao(stream, video) {
  const track = stream?.getVideoTracks?.()[0];
  const settings = (() => {
    try {
      return track?.getSettings?.() || {};
    } catch {
      return {};
    }
  })();

  // (A) frame bruto: pego direto do track, sem DOM e sem CSS.
  let bruto;
  try {
    bruto = await quadroBrutoComoCanvas(stream);
  } catch (erro) {
    return { ok: false, motivo: `nao foi possivel pegar o frame bruto: ${erro.message}` };
  }
  const canvasBruto = bruto.canvas;
  const wBruto = bruto.largura;
  const hBruto = bruto.altura;
  if (!stream || wBruto < 2 || hBruto < 2) {
    return { ok: false, motivo: 'stream ou quadro indisponivel' };
  }
  const ctxBruto = canvasBruto.getContext('2d', { willReadFrequently: true });

  // (B) frame exibido: o elemento <video> tem `object-fit` E, quando o quadro
  // e landscape numa tela portrait, uma ROTACAO de 90 graus. Desenhar o
  // elemento reproduz o object-fit, mas NAO a transform - por isso a rotacao e
  // aplicada aqui no canvas, senao a comparacao olharia uma imagem diferente da
  // que esta na tela.
  const box = video?.getBoundingClientRect?.() || { width: 0, height: 0 };
  if (!box.width || !box.height) {
    return { ok: false, motivo: 'elemento de video sem tamanho na tela' };
  }
  const objectFit = (() => {
    try {
      return getComputedStyle(video).objectFit;
    } catch {
      return '(desconhecido)';
    }
  })();
  // Rotacao preferencialmente do atributo publicado pelo app; se faltar, do
  // proprio `transform` (a matriz de um giro de 90 tem [cos, sin] = [0, +-1]).
  let rotacao = Number(video?.dataset?.rotacao) || 0;
  if (!rotacao) {
    const m = /matrix\(([^)]+)\)/.exec(
      (() => {
        try {
          return getComputedStyle(video).transform;
        } catch {
          return '';
        }
      })(),
    );
    if (m) {
      const [a, b] = m[1].split(',').map(Number);
      if (Number.isFinite(a) && Number.isFinite(b) && Math.abs(a) < 0.01
        && Math.abs(b) > 0.99) rotacao = b > 0 ? 90 : 270;
    }
  }
  // Dimensoes do quadro como aparecem na TELA (giradas quando ha rotacao).
  const efL = rotacao ? hBruto : wBruto;
  const efA = rotacao ? wBruto : hBruto;

  const canvasExibido = document.createElement('canvas');
  canvasExibido.width = Math.round(box.width);
  canvasExibido.height = Math.round(box.height);
  const ctxExibido = canvasExibido.getContext('2d', { willReadFrequently: true });
  const s = objectFit === 'cover'
    ? Math.max(canvasExibido.width / efL, canvasExibido.height / efA)
    : (objectFit === 'none' ? 1 : Math.min(canvasExibido.width / efL, canvasExibido.height / efA));
  const dw = efL * s;
  const dh = efA * s;
  ctxExibido.fillStyle = '#000';
  ctxExibido.fillRect(0, 0, canvasExibido.width, canvasExibido.height);
  ctxExibido.save();
  ctxExibido.translate(canvasExibido.width / 2, canvasExibido.height / 2);
  if (rotacao) ctxExibido.rotate((rotacao * Math.PI) / 180);
  try {
    // Com o contexto girado, o eixo X local vira o Y do palco.
    if (rotacao) ctxExibido.drawImage(video, -dh / 2, -dw / 2, dh, dw);
    else ctxExibido.drawImage(video, -dw / 2, -dh / 2, dw, dh);
  } catch (erro) {
    return { ok: false, motivo: `nao foi possivel desenhar o video: ${erro.message}` };
  }
  ctxExibido.restore();

  const pxBruto = ctxBruto.getImageData(0, 0, wBruto, hBruto).data;
  const pxExibido = ctxExibido.getImageData(0, 0, canvasExibido.width, canvasExibido.height).data;

  // A regiao de conteudo do canvas exibido contem o quadro na escala REAL que o
  // navegador usou. E essa escala que diz se a imagem esta ampliada - e o que a
  // conta por `max` (so valida para `cover`) errava.
  const regiaoExibida = regiaoDeConteudo(
    canvasExibido.width, canvasExibido.height, efL, efA, objectFit,
  );

  const dif = diferencaMedia(
    assinaturaDaRegiao(pxBruto, wBruto, hBruto, {
      x: 0, y: 0, w: wBruto, h: hBruto,
    }),
    assinaturaDaRegiao(
      pxExibido, canvasExibido.width, canvasExibido.height, regiaoExibida,
    ),
  );
  const mesmaCena = dif <= LIMIAR_MESMA_CENA;

  // SEGUNDO SINAL: transform CSS.
  //
  // `drawImage(video)` desenha o CONTEUDO do elemento e ignora transform, entao
  // um `scale(1.8)` injetado nao muda a diferenca de pixels. Para enxergar o
  // transform, a comparacao le as COLUNAS da matriz, que sao as imagens dos
  // eixos X e Y:
  //
  //   - com norma 1, so ha rotacao e/ou espelho (o que e permitido);
  //   - com norma > 1, ha `scale` - que e o mascaramento proibido.
  //
  // E pela matriz, e nao por `offsetWidth` contra `getBoundingClientRect()`,
  // porque um giro de 90 graus TROCA largura e altura no bounding rect: a
// comparacao por tamanho leria uma rotacao pura como se fosse escala de 1.78x.
  const matrizTransform = (() => {
    try {
      return getComputedStyle(video).transform;
    } catch {
      return '';
    }
  })();
  let escalaTransform = 1;
  const m = /matrix\(([^)]+)\)/.exec(matrizTransform || '');
  if (m) {
    const [a, b, c, d] = m[1].split(',').map(Number);
    if ([a, b, c, d].every(Number.isFinite)) {
      escalaTransform = Math.max(Math.hypot(a, b), Math.hypot(c, d));
    }
  }
  const temTransform = escalaTransform > 1.05;

  // Veredito: qualquer um dos dois sinais apontando para a exibicao decide.
  const casoB = temTransform || !mesmaCena;
  const motivoB = temTransform
    ? `o elemento esta com transform de ${escalaTransform.toFixed(2)}x `
      + '(zoom na propria exibicao)'
    : `o conteudo exibido difere do frame bruto `
      + `(${dif.toFixed(1)} > ${LIMIAR_MESMA_CENA}) - object-fit/crop diferente`;

  return {
    ok: true,
    quadroBruto: [wBruto, hBruto],
    quadroElemento: [Math.round(box.width), Math.round(box.height)],
    quadroLayout: [Math.round(video?.offsetWidth || 0), Math.round(video?.offsetHeight || 0)],
    objectFit,
    rotacao,
    diferencaMedia: dif,
    limiar: LIMIAR_MESMA_CENA,
    // Escala REAL do conteudo dentro do elemento, pelo `object-fit`.
    escalaElemento: regiaoExibida.escala,
    // Escala vinda de transform CSS no elemento.
    escalaTransform,
    regiaoConteudo: {
      x: Math.round(regiaoExibida.x),
      y: Math.round(regiaoExibida.y),
      w: Math.round(regiaoExibida.w),
      h: Math.round(regiaoExibida.h),
    },
    caso: casoB ? 'B (renderizacao)' : 'A (captura)',
    veredito: casoB
      ? `B) o stream e normal e a EXIBICAO amplia: ${motivoB}.`
      : 'A) o stream JA vem enquadrado assim. O zoom e da CAPTURA '
        + '(driver/sensor), nao da exibicao.',
    canvasBruto,
    canvasExibido,
  };
}

/**
 * Monta o painel de diagnostico visivel na tela, para leitura no proprio
 * celular.
 *
 * @param {HTMLElement} page `.live-page` onde o painel entra por cima
 * @param {object} ctx {stream, video, devices}
 * @returns {{abrir:()=>void, fechar:()=>void, atualizar:()=>Promise<object>}}
 */
export function montarDiagnosticoCamera(page, ctx) {
  const { stream, video, devices } = ctx;
  let painel = null;

  const linha = (rotulo, valor) => {
    const d = document.createElement('div');
    d.className = 'live-diag-linha';
    d.innerHTML = `<span>${rotulo}</span><b></b>`;
    d.querySelector('b').textContent = valor === null || valor === undefined ? '(n/d)' : String(valor);
    return d;
  };

  const bloco = (titulo, entradas) => {
    const s = document.createElement('section');
    s.className = 'live-diag-bloco';
    const h = document.createElement('h4');
    h.textContent = titulo;
    s.append(h);
    for (const [k, v] of entradas) s.append(linha(k, v));
    return s;
  };

  const previa = (titulo, canvas, altura) => {
    const wrap = document.createElement('div');
    wrap.className = 'live-diag-previa';
    const h = document.createElement('h5');
    h.textContent = titulo;
    const holder = document.createElement('div');
    holder.className = 'live-diag-canvas';
    if (canvas) {
      canvas.style.width = '100%';
      canvas.style.height = `${altura}px`;
      holder.append(canvas);
    }
    wrap.append(h, holder);
    return wrap;
  };

  async function atualizar() {
    const track = stream?.getVideoTracks?.()[0];
    const info = inspecionarTrack(track);
    const cls = classificacaoDoQuadro(info);
    const comp = await compararCapturaComExibicao(stream, video);
    const zoomInfo = devices?.zoom || null;

    const alvo = painel.querySelector('.live-diag-corpo');
    alvo.textContent = '';

    alvo.append(bloco('CAMERA SETTINGS', [
      ['deviceId', info.label],
      ['width', info.width],
      ['height', info.height],
      ['aspectRatio', info.aspectRatio ?? (cls.proporcao?.toFixed(4) ?? null)],
      ['facingMode', info.facingMode],
      ['frameRate', info.frameRate],
    ]));

    alvo.append(bloco('ZOOM (o corte interno do driver)', [
      ['settings.zoom', info.zoom],
      ['capabilities.zoom.min', info.capabilitiesZoom?.min ?? '(sem zoom exposto)'],
      ['capabilities.zoom.max', info.capabilitiesZoom?.max ?? null],
      ['suportado', zoomInfo ? (zoomInfo.suportado ? 'sim' : 'nao') : null],
      ['neutralizado', zoomInfo ? (zoomInfo.aplicado ? `sim (${zoomInfo.valor})` : 'nao') : null],
      ['zoom antes', zoomInfo?.antes ?? null],
      ['zoom depois', zoomInfo?.depois ?? null],
      ['falha ao aplicar', zoomInfo?.erro ?? null],
    ]));

    alvo.append(bloco('O QUE PEDIMOS (constraint)', [
      ['width', info.constraintsAsked.width ? JSON.stringify(info.constraintsAsked.width) : '(nao pedido)'],
      ['height', info.constraintsAsked.height ? JSON.stringify(info.constraintsAsked.height) : '(NAO pedido)'],
      ['aspectRatio', info.constraintsAsked.aspectRatio
        ? JSON.stringify(info.constraintsAsked.aspectRatio) : '(NAO pedido)'],
      ['advanced', info.constraintsAsked.advanced ? info.constraintsAsked.advanced.join(', ') : null],
    ]));

    const leitura = cls.quadrado ? 'quadrado' : (cls.portrait ? 'portrait' : 'landscape');
    alvo.append(bloco('LEITURA DO QUADRO', [
      ['classificacao', leitura],
      ['proporcao', cls.proporcao?.toFixed(4) ?? null],
      ['9:16 e 0.5625; 4:3 e 1.3333; 16:9 e 1.7778', null],
      ['elemento na tela', `${comp.ok ? comp.quadroElemento.join('x') : '(n/d)'}`],
      ['tamanho de layout', `${comp.ok ? comp.quadroLayout.join('x') : '(n/d)'}`],
      ['object-fit no video', comp.ok ? comp.objectFit : null],
      ['escala pelo object-fit', comp.ok ? `${comp.escalaElemento.toFixed(3)}x` : null],
      ['escala por transform CSS', comp.ok ? `${comp.escalaTransform.toFixed(3)}x` : null],
    ]));

    const ver = document.createElement('section');
    ver.className = 'live-diag-bloco live-diag-veredito';
    if (!comp.ok) {
      ver.textContent = `Veredito: nao foi possivel comparar (${comp.motivo})`;
    } else {
      ver.innerHTML = `<b>${comp.caso}</b> — ${comp.veredito}<br>`
        + `<small>diferenca media entre o frame bruto e o exibido: `
        + `${comp.diferencaMedia.toFixed(1)} / 255 (limiar ${comp.limiar}) | `
        + `transform CSS: ${comp.escalaTransform.toFixed(2)}x</small>`;
    }
    alvo.append(ver);

    if (comp.ok) {
      alvo.append(previa('A) frame BRUTO do stream (1:1, sem CSS)', comp.canvasBruto, 190));
      alvo.append(previa('B) frame EXIBIDO no <video>', comp.canvasExibido, 190));
    }
    return comp;
  }

  function fechar() {
    painel?.remove();
    painel = null;
  }

  function abrir() {
    if (painel) return;
    painel = document.createElement('div');
    painel.className = 'live-diag';
    const topo = document.createElement('header');
    topo.innerHTML = '<strong>Diagnostico da camera</strong>';
    const fechar = document.createElement('button');
    fechar.type = 'button';
    fechar.textContent = 'Fechar';
    fechar.addEventListener('click', fechar);
    topo.append(fechar);
    const corpo = document.createElement('div');
    corpo.className = 'live-diag-corpo';
    painel.append(topo, corpo);
    page.append(painel);
    atualizar().catch((e) => {
      corpo.textContent = `falha no diagnostico: ${e.message}`;
    });
  }

  return { abrir, fechar, atualizar };
}
