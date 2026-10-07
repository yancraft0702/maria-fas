/**
 * ITEM 5 - enquadramento NATURAL do video da LIVE.
 *
 * A captura e a preferencia de rotacao permanecem como estao. Depois da
 * rotacao existente, o quadro sempre usa `cover`: qualquer corte necessario
 * e preferivel a barras pretas ou a um video menor que a viewport.
 *
 * @param {HTMLVideoElement} video elemento da transmissao
 * @param {() => HTMLElement|null} [palco] area visivel (padrao: o pai)
 * @param {object} [opcoes]
 * @param {number} [opcoes.rotacao] graus de rotacao a aplicar no elemento
 *        (0, 90 ou 270). Vem do anfitriao: ver `MediaDevices.rotacaoNecessaria`.
 * @param {() => number} [opcoes.mirror] devolve 1 ou -1 para o espelho local
 * @returns {() => void} cleanup
 */
export function ajustarEnquadramento(video, palco, opcoes = {}) {
  if (!video) return () => {};
  // A rotacao pode mudar em tempo real (o anfitriao muda a preferencia, ou o
  // quadro muda de tamanho ao trocar de camera), entao e lida por funcao.
  const lerRotacao = () => Number(typeof opcoes.rotacao === 'function'
    ? opcoes.rotacao()
    : opcoes.rotacao) || 0;
  const mirror = opcoes.mirror;

  const areaDoPalco = () => {
    const alvo = typeof palco === 'function' ? palco() : (palco || video.parentElement);
    return alvo ? alvo.getBoundingClientRect() : null;
  };

  const aplicar = () => {
    // So depois que o navegador sabe o tamanho do quadro.
    if (!video.videoWidth || !video.videoHeight) return;
    const alvo = areaDoPalco();
    if (!alcoSegura(alvo)) return;

    const decisao = escolherEnquadramento(
      { largura: video.videoWidth, altura: video.videoHeight },
      { largura: alvo.width, altura: alvo.height },
      { rotacaoPreferida: lerRotacao() },
    );

    if (video.style.objectFit !== 'cover') video.style.objectFit = 'cover';

    if (decisao.rotacao === 0) {
      // Sem rotacao: o elemento ocupa a area; `cover` centralizado decide
      // somente o crop necessario para preencher o palco.
      video.style.width = '';
      video.style.height = '';
      video.style.left = '';
      video.style.top = '';
      video.style.transform = '';
      video.style.transformOrigin = '';
    } else {
      // Com rotacao, o elemento NAO pode ocupar a area inteira: ele tem de ter
      // as medidas do quadro NAO-rotacionado, para que depois de girar em 90
      // graus o conteudo fique com a proporcao e o tamanho certos.
      //
      //   quadro 1280x720 girado -> conteudo 720x1280 (portrait)
      //   escala = max(390/720, 844/1280) = 0.659 (so encolhe)
      //   caixa  = 1280x0.659 x 720x0.659 = 844 x 475
      //   girada -> ocupa 475 x 844, centralizada, cobrindo os 390x844
      //
      // O `left`/`top` sao calculados aqui (em vez de `translate(-50%,-50%)`)
      // porque o espelho local e um `scaleX(-1)`: um `translate` na mesma
      // lista seria espelhado junto e a centralizacao viraria para o lado
      // errado. Centralizando pela posicao, o `transform` fica SO com a
      // rotacao e o espelho, ambos em torno do centro, que nao deslocam nada.
      const larguraCaixa = Math.round(video.videoWidth * decisao.escala);
      const alturaCaixa = Math.round(video.videoHeight * decisao.escala);
      video.style.width = `${larguraCaixa}px`;
      video.style.height = `${alturaCaixa}px`;
      video.style.left = `${Math.round((alvo.width - larguraCaixa) / 2)}px`;
      video.style.top = `${Math.round((alvo.height - alturaCaixa) / 2)}px`;
      video.style.transformOrigin = 'center center';
      const espelho = typeof mirror === 'function' ? (mirror() < 0 ? -1 : 1) : 1;
      // `scaleX(-1) rotate(...)`: o espelho e aplicado DEPOIS da rotacao, ou
      // seja, no espaco ja orientado - e o que faz a selfie aparecer como
      // espelho, e nao virada de cabeca para baixo.
      video.style.transform = espelho < 0
        ? `scaleX(-1) rotate(${decisao.rotacao}deg)`
        : `rotate(${decisao.rotacao}deg)`;
    }

    video.dataset.fit = decisao.fit;
    video.dataset.rotacao = String(decisao.rotacao);
    video.dataset.ampliacao = decisao.escala.toFixed(3);
    video.dataset.recorte = decisao.recorte.toFixed(3);
    if (opcoes.aoMudar) opcoes.aoMudar(decisao);
  };
  video.addEventListener('loadedmetadata', aplicar);
  video.addEventListener('resize', aplicar);
  window.addEventListener('resize', aplicar);
  window.addEventListener('orientationchange', aplicar);
  const visualViewport = window.visualViewport;
  visualViewport?.addEventListener('resize', aplicar);
  const palcoAtual = typeof palco === 'function' ? palco() : (palco || video.parentElement);
  const resizeObserver = typeof ResizeObserver === 'function' && palcoAtual
    ? new ResizeObserver(aplicar)
    : null;
  resizeObserver?.observe(palcoAtual);
  // Garante que o ajuste rode assim que o video tiver o tamanho do quadro, mesmo
  // que `loadedmetadata` ja tenha disparado antes deste listener existir. O
  // intervalo se desliga sozinho no primeiro quadro valido (ou depois de 5s).
  let tentativas = 0;
  const intervalo = setInterval(() => {
    aplicar();
    tentativas += 1;
    if ((video.videoWidth && video.videoHeight) || tentativas > 50) {
      clearInterval(intervalo);
    }
  }, 100);
  aplicar();
  return () => {
    clearInterval(intervalo);
    video.removeEventListener('loadedmetadata', aplicar);
    video.removeEventListener('resize', aplicar);
    window.removeEventListener('resize', aplicar);
    window.removeEventListener('orientationchange', aplicar);
    visualViewport?.removeEventListener('resize', aplicar);
    resizeObserver?.disconnect();
  };
}

function alcoSegura(alvo) {
  return Boolean(alvo && alvo.width > 1 && alvo.height > 1);
}

/**
 * Certeza que decide o enquadramento: QUANTO do quadro o `cover` descarta.
 *
 * Medir ampliacao nao funciona. Dois casos com a MESMA ampliacao (1.17x):
 *
 *   - quadro portrait 405x720 em viewport 390x844: descarta 18% da LARGURA
 *     (arredonda as laterais) - tela cheia normal de LIVE vertical;
 *   - quadro landscape 1280x720 na MESMA viewport: descarta 74% da LARGURA -
 *     o rosto ocupa a tela toda. E o defeito relatado.
 *
 * A diferenca entre os dois e o RECORTE, nao a escala. Por isso o limite e de
 * corte: ate 25% o corte e o arredondamento de canto que qualquer aplicativo
 * de LIVE faz; acima disso comeca a devorar a pessoa.
 */
export const LIMITE_DE_RECORTE = 0.25;

/**
 * Teto ABSOLUTO de ampliacao do `cover`, como rede de seguranca.
 *
 * Com um quadro minúsculo (o de teste, 320x180), o recorte pode ficar dentro
 * do limite e ainda assim o `cover` esticar 3x. Este teto barra esse caso
 * sem depender do recorte.
 */
export const TOLERANCIA_DE_AMPLIACAO = 1.35;

/**
 * Ampliacao maxima aceita pelo `contain`.
 *
 * `contain` so entra quando o `cover` foi recusado por recorte, ou seja, num
 * quadro que precisa caber inteiro. Ate 1.3x de ampliacao e imperceptivel e
 * evita uma tarja desnecessaria; acima disso (o quadro de teste 320x180 daria
 * 3.25x) a imagem esticada vira exatamente o rosto gigante, e o quadro deve ser
 * mostrado no tamanho capturado.
 */
export const TOLERANCIA_DE_ESTIQUE = 1.3;

/**
 * Escolhe o enquadramento a partir do quadro REAL e da area REAL.
 *
 * Funcao pura: preserva a selecao de rotacao atual e sempre retorna `cover`
 * para que a imagem preencha o palco, aceitando o corte necessario.
 *
 * @param {{largura:number, altura:number}} quadro quadro capturado da camera
 * @param {{largura:number, altura:number}} area area visivel do video
 * @param {{rotacaoPreferida?:number}} [opcoes] direcao preferida (90 ou 270)
 * @returns {{fit:'cover', escala:number, recorte:number, rotacao:number, motivo:string}}
 */
export function escolherEnquadramento(quadro, area, opcoes = {}) {
  const largura = Number(quadro?.largura) || 0;
  const altura = Number(quadro?.altura) || 0;
  const areaLargura = Number(area?.largura) || 0;
  const areaAltura = Number(area?.altura) || 0;
  if (largura < 1 || altura < 1 || areaLargura < 1 || areaAltura < 1) {
    return { fit: 'cover', escala: 1, recorte: 0, rotacao: 0, motivo: 'medida incompleta' };
  }

  // ---- 1) A ROTAÇÃO ------------------------------------------------
  //
  // Se o quadro e a tela estão em orientações opostas, existe uma terceira
  // saída, e ela e a boa: GIRAR o quadro 90 graus. Um quadro 16:9 rotacionado
  // vira 9:16, que e exatamente a proporção de uma tela de celular - e então o
  // `cover` cabe com o MESMO corte mínimo de qualquer LIVE vertical, sem
  // ampliar nada e sem cortar a pessoa.
  //
  // Sem rotar, as duas saidas sao ruins: `cover` devolve o rosto gigante
  // (descarta ~74% da largura) e `contain` deixa o quadro deitado numa faixa.
  // Girar resolve as duas de uma vez.
  //
  // A rotacao so entra quando:
  //   - o quadro e a tela estao em orientacoes opostas;
  //   - o corte com rotacao e MELHOR que sem (folga de 5 pontos percentuais);
  //   - a escala com rotacao continua dentro da tolerancia, para nunca
  //     transformar um quadro pequeno num zoom.
  //
  // A DIRECAO (90 ou 270) e uma propriedade do BUFFER da camera, nao da tela:
  // por isso ela vem de fora (`rotacaoPreferida`, enviada pelo anfitriao) em
  // vez de ser inventada aqui. Por padrao assume-se 90 graus.
  const conflito = (largura > altura) !== (areaLargura > areaAltura);
  // Se o anfitriao escolheu NAO girar (0), o espectador respeita. Sem isto,
  // a preferencia 0 cairia no fallback 270 e o quadro seria girado contra a
  // vontade explicita do anfitriao (o socket do espectador ficaria com 0 e o
  // video do host com 270 - o mesmo BUG do LIVE_VIDEO_ROTATION).
  const semGiroExplicito = Number(opcoes.rotacaoPreferida) === 0;
  const preferida = semGiroExplicito ? 0
    : [90, 270].includes(Number(opcoes.rotacaoPreferida))
      ? Number(opcoes.rotacaoPreferida)
      : 270;

  const medir = (fLargura, fAltura) => {
    const cobreX = areaLargura / fLargura;
    const cobreY = areaAltura / fAltura;
    const escalaCover = Math.max(cobreX, cobreY);
    const escalaContain = Math.min(cobreX, cobreY);
    const aproveitaX = cobreX / escalaCover;
    const aproveitaY = cobreY / escalaCover;
    return {
      escalaCover,
      escalaContain,
      recorte: 1 - Math.min(aproveitaX, aproveitaY),
    };
  };

  const direto = medir(largura, altura);
  const girado = medir(altura, largura); // 90 graus troca largura por altura
  const rotacaoAjuda = conflito
    && girado.recorte + 0.05 < direto.recorte
    && girado.escalaCover <= TOLERANCIA_DE_AMPLIACAO;
  const rotacao = rotacaoAjuda ? preferida : 0;
  const base = rotacao ? girado : direto;

  // ---- 2) `cover` sempre, sobre o quadro ja rotacionado --------------
  return {
    fit: 'cover',
    escala: base.escalaCover,
    recorte: base.recorte,
    rotacao,
    motivo: `tela cheia com cover; corte de ${(base.recorte * 100).toFixed(0)}%`,
  };
}

/**
 * Ajuste de layout da LIVE (itens 10, 11 e 13).
 *
 * Problema real: `.live-input-bar` ficava com uma altura FIXA calculada com
 * `calc(64px + safe-area)` e o chat usava o mesmo palpite. Resultado: em telas
 * estreitas os controles se encostavam, e com o teclado aberto a barra ficava
 * escondida atras dele.
 *
 * Aqui a altura da barra e MEDIDA (ResizeObserver no proprio elemento) e
 * publicada em `--live-bar-h`. A medicao do TECLADO foi movida para
 * `core/viewport.js`, que e o modulo unico do projeto para ler a viewport
 * visivel: a LIVE e os chats usam a MESMA fonte, em vez de cada tela ter o
 * seu proprio palpite - duplicacao que ja gerou folga morta no chat (item 30).
 */

import { observarViewport } from '../core/viewport.js';

/**
 * @param {HTMLElement} page elemento `.live-page`
 * @param {HTMLElement} bar elemento `.live-input-bar`
 * @returns {() => void} cleanup
 */
export function observeLiveLayout(page, bar) {
  if (!page || !bar) return () => {};

  const publish = () => {
    const altura = Math.round(bar.getBoundingClientRect().height);
    if (altura > 0) page.style.setProperty('--live-bar-h', `${altura}px`);
  };

  let observer = null;
  if (typeof ResizeObserver === 'function') {
    observer = new ResizeObserver(publish);
    observer.observe(bar);
  } else {
    window.addEventListener('resize', publish);
  }
  publish();

  // `--live-kb` vem do modulo compartilhado (mesma leitura usada pelo chat).
  const pararViewport = observarViewport(page, { prefix: 'live', comTeclado: true });

  return () => {
    observer?.disconnect();
    window.removeEventListener('resize', publish);
    pararViewport();
  };
}
