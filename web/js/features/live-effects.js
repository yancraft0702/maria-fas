/**
 * Sobreposicao de efeitos da LIVE.
 *
 * Remocao de fundo REAL, por dois caminhos:
 *  1. `effect.alpha === true`: o WebM tem canal alfa gravado pelo servidor;
 *  2. `effect.chromaKey`: chave de cor aplicada por shader WebGL POR QUADRO
 *     na GPU (nao e imagem estatica nem animacao falsa).
 *
 * Cada instancia:
 * - toca o arquivo oficial de animacao uma unica vez
 * - some sozinho ao terminar (sem timer vazando)
 * - nunca dispara ao carregar o historico do chat
 * - deduplica por event_id e por sequence
 */

const VERTEX_SHADER = `
attribute vec2 aPosition;
attribute vec2 aTexCoord;
varying vec2 vTexCoord;
void main() {
  vTexCoord = aTexCoord;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}`;

// Chroma-key: calcula distancia entre a cor do pixel e a cor-chave e
// transforma em alpha. `similarity` e a tolerancia, `smoothness` a suavizacao.
const FRAGMENT_SHADER = `
precision mediump float;
uniform sampler2D uTexture;
uniform vec3 uKeyColor;
uniform float uSimilarity;
uniform float uSmoothness;
uniform float uInvert;
varying vec2 vTexCoord;

void main() {
  vec4 color = texture2D(uTexture, vTexCoord);
  vec3 target = mix(uKeyColor, vec3(1.0) - uKeyColor, uInvert);
  float dist = distance(color.rgb, target);
  float alpha = smoothstep(uSimilarity, uSimilarity + max(uSmoothness, 0.001), dist);
  gl_FragColor = vec4(color.rgb, alpha);
}`;

function parseColor(name) {
  const map = {
    black: [0, 0, 0],
    white: [1, 1, 1],
    green: [0, 0.502, 0],
  };
  return map[String(name || 'black').toLowerCase()] || map.black;
}

function hexToRgb(hex) {
  const clean = String(hex || '').replace('#', '');
  if (clean.length !== 6) return null;
  const value = parseInt(clean, 16);
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}

/** Camada de video + canvas WebGL com chroma-key. */
class KeyedLayer {
  constructor({ src, chromaKey, crossOrigin = null }) {
    this.video = document.createElement('video');
    this.video.src = src;
    this.video.muted = true;          // o audio da LIVE vem do stream
    this.video.loop = false;
    this.video.playsInline = true;
    this.video.setAttribute('playsinline', '');
    this.video.preload = 'auto';
    if (crossOrigin) this.video.crossOrigin = crossOrigin;

    this.canvas = document.createElement('canvas');
    this.canvas.width = 512;
    this.canvas.height = 512;

    this.gl = null;
    this.program = null;
    this.texture = null;
    this.ready = false;
    this.chromaKey = chromaKey;
    this.rafId = null;
    this.destroyed = false;

    this.video.addEventListener('loadeddata', () => {
      this.setupGl();
      this.ready = true;
      this.canvas.width = this.video.videoWidth || 512;
      this.canvas.height = this.video.videoHeight || 512;
      if (this.gl) this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      this.video.play().catch(() => { /* autoplay bloqueado: tenta no proximo gesto */ });
      this.render();
    });
    this.video.addEventListener('ended', () => {
      if (this.onEnded && !this.destroyed) this.onEnded();
    });
  }

  setupGl() {
    if (this.destroyed) return;
    const gl = this.canvas.getContext('webgl', { alpha: true, premultipliedAlpha: false, antialias: true })
      || this.canvas.getContext('experimental-webgl', { alpha: true });
    if (!gl) {
      // Sem WebGL: usa o proprio video (sem remocao, mas nunca quebrado)
      this.gl = null;
      return;
    }
    this.gl = gl;
    gl.clearColor(0, 0, 0, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    const compile = (type, source) => {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.warn('[efeitos] shader:', gl.getShaderInfoLog(shader));
        return null;
      }
      return shader;
    };

    const vertex = compile(gl.VERTEX_SHADER, VERTEX_SHADER);
    const fragment = compile(gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
    if (!vertex || !fragment) { this.gl = null; return; }

    const program = gl.createProgram();
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.warn('[efeitos] link:', gl.getProgramInfoLog(program));
      this.gl = null;
      return;
    }
    this.program = program;
    gl.useProgram(program);

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, 1, 0, 0,
      1, 1, 1, 0,
      -1, -1, 0, 1,
      1, -1, 1, 1,
    ]), gl.STATIC_DRAW);

    const aPosition = gl.getAttribLocation(program, 'aPosition');
    gl.enableVertexAttribArray(aPosition);
    gl.vertexAttribPointer(aPosition, 2, gl.FLOAT, false, 16, 0);

    const aTexCoord = gl.getAttribLocation(program, 'aTexCoord');
    gl.enableVertexAttribArray(aTexCoord);
    gl.vertexAttribPointer(aTexCoord, 2, gl.FLOAT, false, 16, 8);

    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    gl.uniform1f(gl.getUniformLocation(program, 'uSimilarity'), this.chromaKey?.similarity ?? 0.22);
    gl.uniform1f(gl.getUniformLocation(program, 'uSmoothness'), this.chromaKey?.smoothness ?? 0.1);
    const rgb = hexToRgb(this.chromaKey?.color) || parseColor(this.chromaKey?.color);
    gl.uniform3f(gl.getUniformLocation(program, 'uKeyColor'), rgb[0], rgb[1], rgb[2]);
    gl.uniform1f(gl.getUniformLocation(program, 'uInvert'), 0);
    gl.uniform1i(gl.getUniformLocation(program, 'uTexture'), 0);
  }

  render() {
    if (this.destroyed) return;
    const gl = this.gl;
    if (!gl || !this.program || this.video.readyState < 2) {
      this.rafId = requestAnimationFrame(() => this.render());
      return;
    }
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.video);
    } catch {
      // tainted canvas (CORS): cai para video sem chave
      this.gl = null;
    }
    if (this.gl) {
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      this.rafId = requestAnimationFrame(() => this.render());
    }
  }

  retryPlay() {
    if (this.destroyed) return;
    this.video.play().catch(() => {});
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    cancelAnimationFrame(this.rafId);
    this.rafId = null;
    try { this.video.pause(); } catch { /* ignore */ }
    this.video.removeAttribute('src');
    this.video.load();
    if (this.gl) {
      const lose = this.gl.getExtension('WEBGL_lose_context');
      lose?.loseContext();
    }
    this.gl = null;
    this.canvas.width = 0;
    this.canvas.height = 0;
  }
}

/**
 * Gerenciador da camada de efeitos.
 *
 * ITEM 6 - composicao em camadas. A camada vivia no `<body>` com
 * `z-index: 55`, enquanto a `.live-page` tem `z-index: 60`. Como a page cria um
 * contexto de empilhamento proprio, os efeitos ficavam ATRAS do video (a
 * "faixa rosa aparecendo atras da transmissao") e, no mobile, onde a page cobre
 * a tela inteira, nem apareciam.
 *
 * A correcao nao e um z-index maior: e `mountIn()`, que move a camada para
 * DENTRO da `.live-page`. Assim a ordem passa a ser exatamente a pedida:
 *
 *   video  ->  #live-effects  ->  #live-hearts  ->  chat / controles
 *
 * `unmount()` devolve o no ao `<body>` quando a LIVE fecha.
 */
// --------------------------------------------------------------------------
// Item 9 - som dos efeitos
//
// A preferencia fica em localStorage (por sessao do navegador) e o volume em
// 0.6: um efeito de LIVE e ambiente, nao algo para tomar conta da tela. A
// funcao e unica para host e espectador usarem a MESMA leitura - nada de um
// cliente ter som e outro nao por causa de um valor duplicado.
// --------------------------------------------------------------------------
const CHAVE_SOM = 'mariafas.live.som';
const CHAVE_VOLUME = 'mariafas.live.volume';

function lerPreferenciaSom() {
  try {
    const v = localStorage.getItem(CHAVE_SOM);
    return v === null ? true : v !== '0';
  } catch {
    return true;
  }
}

function gravarPreferenciaSom(ligado) {
  try { localStorage.setItem(CHAVE_SOM, ligado ? '1' : '0'); } catch { /* sem storage */ }
}

function volumeDoSom() {
  try {
    const bruto = localStorage.getItem(CHAVE_VOLUME);
    // `Number(null)` e 0, nao NaN: sem esta guarda, a primeira visita (sem
    // preferencia gravada) caia no ramo "valido" e deixava TODO efeito mudo.
    if (bruto !== null && bruto !== '') {
      const v = Number(bruto);
      if (Number.isFinite(v) && v >= 0 && v <= 1) return v;
    }
  } catch { /* sem storage */ }
  return 0.4;
}

export function lerSomLigado() {
  return lerPreferenciaSom();
}

export function definirSomGlobal(ligado) {
  gravarPreferenciaSom(ligado);
  return lerPreferenciaSom();
}

export function volumeGlobal() {
  return volumeDoSom();
}

export class EffectOverlay {
  constructor(host) {
    this.host = host || document.getElementById('live-effects');
    /** Onde o no vive antes de `mountIn` (para devolver no fim). */
    this.origin = this.host?.parentElement || null;
    this.originNext = this.host?.nextSibling || null;
    /** @type {Map<string, {node: HTMLElement, layer: KeyedLayer|null, video: HTMLVideoElement|null, timer: any}>} */
    this.instances = new Map();
    this.seenEventIds = new Set();
    this.seenSequence = 0;
    this.maxInstances = 6;
    // Item 9: som dos efeitos. `somLigado` e a preferencia do usuario (por
    // sessao, em localStorage) e e lida pelo `audio.play()`; sem audio o
    // elemento nao e nem criado.
    this.somLigado = lerPreferenciaSom();
    // Contador de sons tocados: o verificador usa para provar que o som rodou
    // uma vez por evento em cada cliente (e nao duas, nem zero).
    this.sonsTocados = 0;
  }

  /**
   * Liga/desliga o som dos efeitos nesta tela.
   * @param {boolean} ligado
   * @returns {boolean} o estado gravado
   */
  definirSom(ligado) {
    this.somLigado = Boolean(ligado);
    gravarPreferenciaSom(this.somLigado);
    if (!this.somLigado) {
      // Corta o que estiver tocando agora, nao so o futuro.
      for (const entry of this.instances.values()) {
        try { entry.audio?.pause(); } catch { /* ignore */ }
      }
    }
    return this.somLigado;
  }

  /**
   * Cria (ou nao) o audio de um efeito.
   *
   * Regras do item 9:
   *  - sem `soundUrl`, nao cria audio nenhum (nao finge som);
   *  - com o som desligado pelo usuario, nao toca;
   *  - um `<audio>` por instancia, com `volume` do usuario e reinicio em 0, para
   *    dois efeitos seguidos tocarem do inicio.
   *
   * @param {object} effect efeito do evento
   * @returns {HTMLAudioElement|null}
   */
  criarAudio(effect) {
    if (!effect?.soundUrl) return null;
    if (!this.somLigado) return null;
    let audio = null;
    try {
      audio = new Audio(effect.soundUrl);
      audio.preload = 'auto';
      audio.volume = volumeDoSom();
      audio.currentTime = 0;
    } catch {
      return null;
    }
    return audio;
  }

  /** Coloca a camada dentro da tela da LIVE, entre o video e a interface. */
  mountIn(parent) {
    if (!this.host || !parent || this.host.parentElement === parent) return;
    if (!this.origin) {
      this.origin = this.host.parentElement;
      this.originNext = this.host.nextSibling;
    }
    parent.append(this.host);
  }

  /** Devolve a camada ao lugar original (fim da LIVE). */
  unmount() {
    if (!this.host || !this.origin) return;
    if (this.originNext && this.originNext.parentElement === this.origin) {
      this.origin.insertBefore(this.host, this.originNext);
    } else {
      this.origin.append(this.host);
    }
  }

  /** Registro de deduplicacao por event_id (idempotencia). */
  markSeen(eventId) {
    if (!eventId) return false;
    if (this.seenEventIds.has(eventId)) return false;
    this.seenEventIds.add(eventId);
    if (this.seenEventIds.size > 500) {
      const first = this.seenEventIds.values().next().value;
      this.seenEventIds.delete(first);
    }
    return true;
  }

  shouldPlay(payload) {
    if (!payload?.effect?.mediaUrl) return false;
    if (payload.sequence && payload.sequence <= this.seenSequence) return false;
    if (!this.markSeen(payload.eventId)) return false;
    if (payload.sequence) this.seenSequence = payload.sequence;
    return true;
  }

  /**
   * Retangulo do quadro REALMENTE visivel de um <video>.
   *
   * `getBoundingClientRect` do elemento devolve a caixa inteira, que com
   * `object-fit: contain` e maior que o desenho: o quadro aparece centralizado,
   * com tarja preta. E o quadro que o espectador ve, entao e nele que o efeito
   * tem de caber - medir o elemento punha o efeito fora do video.
   *
   * @param {HTMLVideoElement} video
   * @returns {{left:number,top:number,right:number,bottom:number,width:number,height:number}}
   */
  quadroVisivel(video) {
    const caixa = video.getBoundingClientRect();
    if (!video.videoWidth || !video.videoHeight) return caixa;
    const estilo = getComputedStyle(video);
    // `fill` e `none` desenham o quadro inteiro na caixa; `cover` tambem
    // preenche. So `contain` centraliza com tarja.
    if (estilo.objectFit !== 'contain' && estilo.objectFit !== 'scale-down') return caixa;
    const escala = Math.min(caixa.width / video.videoWidth, caixa.height / video.videoHeight);
    const largura = video.videoWidth * escala;
    const altura = video.videoHeight * escala;
    const esquerda = caixa.left + (caixa.width - largura) / 2;
    const topo = caixa.top + (caixa.height - altura) / 2;
    return {
      left: esquerda, top: topo, right: esquerda + largura, bottom: topo + altura,
      width: largura, height: altura,
    };
  }

  /**
   * Reproduz um efeito (acionado por evento realtime, nunca pelo historico).
   * @param {object} payload evento EFFECT_TRIGGER
   */
  play(payload) {
    if (!this.shouldPlay(payload)) return null;
    const effect = payload.effect;
    const key = payload.eventId;

    // Limite de instancias simultaneas (protege a GPU)
    while (this.instances.size >= this.maxInstances) {
      const oldestKey = this.instances.keys().next().value;
      this.dispose(oldestKey);
    }

    const node = document.createElement('div');
    node.className = 'effect-instance';
    node.dataset.effectId = effect.id;

    // --------------------------------------------------------------- dimensoes
    //
    // CAUSA RAIZ do item 6 ("uma faixa/efeito aparecendo atras do video"): o
    // tamanho vinha de `innerWidth * scale` e a altura era `largura * 1.6`, sem
    // limite nenhum. Numa tela de 1280x900 com scale 0.85 isso dava
    // 1088x1741px - maior que a tela. A camada tem `overflow: hidden`, entao
    // aparecia so um pedaco recortado do efeito (a "faixa"), cortado no meio.
    //
    // Agora o efeito e medido contra a AREA REAL DO VIDEO e obrigado a caber
    // nela nas duas dimensoes (a altura e `largura * 1.6`), alem de respeitar a
    // barra inferior e o cabecalho.
    const camadaBox = this.host.getBoundingClientRect();
    const elementoVideo = this.host.parentElement?.querySelector('video');
    // ITEM 5: com `object-fit: contain` (escolhido quando a proporcao da tela
    // difere muito da captura), o ELEMENTO do video e a area inteira, mas o
    // QUADRO visivel fica centralizado dentro dela, com tarja preta em cima e
    // embaixo. Medir o elemento punha o efeito fora do desenho - era isso que
    // o fazia "sair" do video. Aqui a area e a do quadro realmente visivel.
    const videoBox = elementoVideo ? this.quadroVisivel(elementoVideo) : null;

    // INTERSECCAO entre a area do video e a camada. Isso e obrigatorio: um
    // `<video>` sem dimensionamento por CSS tem o tamanho INTRINSECO da camera
    // (1080x1920) e extrapolaria a tela, levando o efeito junto. Com a
    // intersecao, o efeito nunca passa da camada, aconteca o que acontecer com
    // o video.
    const limite = (a, b) => Math.max(a, b);
    const x1 = limite(camadaBox.left, videoBox ? videoBox.left : camadaBox.left);
    const y1 = limite(camadaBox.top, videoBox ? videoBox.top : camadaBox.top);
    const x2 = Math.min(camadaBox.right, videoBox ? videoBox.right : camadaBox.right);
    const y2 = Math.min(camadaBox.bottom, videoBox ? videoBox.bottom : camadaBox.bottom);
    const area = {
      x: x1 - camadaBox.left,
      y: y1 - camadaBox.top,
      w: Math.max(1, x2 - x1),
      h: Math.max(1, y2 - y1),
    };

    // O efeito nao pode ficar EMBAIXO do cabecalho nem da barra de mensagens,
    // mas a reserva tem de ser a MENOR possivel: o ITEM da rodada atual pede
    // efeitos MAIORES, e uma reserva de 25%/30% da altura do quadro os fazia
    // aparecer espremidos. Mede a barra e o topo, limita a cada vez a 12% da
    // area livre, e o restante vira a area de efeito.
    const alturaDe = (sel) => {
      const n = this.host.parentElement?.querySelector(sel);
      if (!n) return 0;
      const b = n.getBoundingClientRect();
      return Math.max(0, Math.round(b.height));
    };
    const alturaTopo = Math.min(alturaDe('.live-top'), Math.round(area.h * 0.12));
    const alturaBarra = Math.min(alturaDe('.live-input-bar'), Math.round(area.h * 0.12));
    area.y += alturaTopo;
    area.h = Math.max(1, area.h - alturaTopo - alturaBarra);

    const escala = Math.min(Math.max(Number(effect.scale) || 0.55, 0.1), 1);
    const LARGURA_ALTURA = 1.6;
    // Caber na largura E na altura da area livre.
    const largura = Math.max(96, Math.round(Math.min(
      area.w * escala,
      (area.h * escala) / LARGURA_ALTURA,
    )));
    const altura = Math.round(largura * LARGURA_ALTURA);
    node.style.width = `${largura}px`;
    node.style.height = `${altura}px`;

    // ITEM atual: EFEITOS MAIORES E NO CENTRO. O sprite e centralizado tanto
    // no eixo horizontal quanto no vertical da area livre (video menos topo e
    // barra de mensagens). A largura vai ate o maior que caiba sem cortar:
    // limitada por uma fracao da largura ou da altura (altura = largura x 1.6).
    // Sem `position: center` de catalogo, o item do evento continua existindo
    // mas o encaminhamento visual passa a ser sempre o centro.
    const esquerda = area.x + Math.max(0, Math.round((area.w - largura) / 2));
    const topo = area.y + Math.max(0, Math.round((area.h - altura) / 2));

    // `left`/`top` explicitos (em vez de `right`/`bottom`) porque o efeito e
    // posicionado em relacao a AREA DO VIDEO, que pode estar deslocada dentro
    // da camada.
    //
    // Item 6: a posicao e TRAVADA dentro da area livre. Antes, um efeito com
    // escala alta (`cinema-impacto` usa 0.95) dava
    // `direita = area.x + area.w - margem - largura` negativo: medido em
    // 390x844, o efeito abria em x=-4 e saia da tela. A largura e
    // `area.w * escala`, entao com escala perto de 1 a propria margem ja come
    // a folga. Aqui o resultado e limitado a [area.x, area.x + area.w -
    // largura] nos dois eixos - o efeito nunca mais invade a barra de
    // mensagens nem o cabecalho, em nenhum tamanho de tela.
    const limitar = (valor, minimo, maximo) => Math.round(Math.max(minimo, Math.min(valor, maximo)));
    const xEsquerdo = limitar(esquerda, area.x, area.x + area.w - largura);
    const yTopo = limitar(topo, area.y, area.y + area.h - altura);
    node.style.left = `${xEsquerdo}px`;
    node.style.top = `${yTopo}px`;
    node.style.right = 'auto';
    node.style.bottom = 'auto';
    node.style.pointerEvents = 'none';

    let layer = null;
    let video = null;
    let image = null;
    // `retry` existe para <video>/canvas (autoplay bloqueado). Com <img>
    // (APNG) ele simplesmente nao e criado - por isso e declarado aqui: antes,
    // referencia-lo na entry dava ReferenceError e a instancia nunca era
    // registrada, logo nunca expirava e ficava visivel para sempre.
    let retry = null;
    // Item 9: listener separado para o som, para poder ser removido sozinho.
    let audioRetry = null;

    if (effect.alpha) {
      // Arquivo com ALFA REAL (APNG): o proprio navegador compose o fundo
      // transparente. Sem canvas, sem chroma-key, sem retangulo preto.
      image = document.createElement('img');
      image.src = effect.mediaUrl;
      image.alt = '';
      image.decoding = 'async';
      image.style.width = '100%';
      image.style.height = '100%';
      image.style.objectFit = 'contain';
      image.style.opacity = '0';
      node.append(image);
    } else if (effect.mediaUrl && !/\.(webm|mp4|mov|m4v)$/i.test(effect.mediaUrl.split('?')[0])) {
      // Arquivo de imagem com alfa. A midia e servida por /api/media/stream
      // (sem extensao), entao so uma URL de video e tratada como video.
      image = document.createElement('img');
      image.src = effect.mediaUrl;
      image.alt = '';
      image.style.width = '100%';
      image.style.height = '100%';
      image.style.objectFit = 'contain';
      image.style.opacity = '0';
      node.append(image);
    } else {
      // Somente para arquivos antigos sem alfa: remocao por quadro na GPU.
      layer = new KeyedLayer({ src: effect.mediaUrl, chromaKey: effect.chromaKey || { color: 'black' } });
      node.append(layer.canvas);
      layer.onEnded = () => this.dispose(key);
    }

    // Etiqueta com quem disparou
    if (payload.user?.username) {
      const tag = document.createElement('div');
      tag.className = 'effect-bubble tiny';
      tag.style.cssText = 'position:absolute;bottom:4px;left:4px;background:rgba(0,0,0,.55);color:#fff;padding:2px 8px;border-radius:10px;display:flex;gap:4px;align-items:center';
      tag.textContent = `${effect.emoji || ''} @${payload.user.username}`;
      node.append(tag);
    }

    this.host.append(node);
    // Fade in.
    //
    // `opacity: 0` no estilo inline era um problema real: se o
    // `requestAnimationFrame` nao rodasse (aba em segundo plano, renderizador
    // ocupado), a instancia ficava permanentemente invisivel - o no existia,
    // ocupava espaco e nao aparecia. Por isso o valor inicial e '1' e a
    // animacao de entrada e que faz o fade, com o estado final garantido.
    node.style.opacity = '1';
    node.animate(
      [{ opacity: 0 }, { opacity: 1 }],
      { duration: 180, easing: 'ease', fill: 'backwards' },
    );

    // <img> com APNG anima sozinho; so <video>/canvas precisam de play().
    const playMedia = () => {
      if (video) video.play().catch(() => {});
      else layer?.retryPlay();
    };
    if (video || layer) {
      playMedia();
      // Se o navegador bloquear o autoplay, tenta no primeiro toque da tela.
      retry = () => {
        playMedia();
        window.removeEventListener('pointerdown', retry);
      };
      window.addEventListener('pointerdown', retry, { once: true });
    }

    // Start the audio as soon as the transparent visual is decoded, so visual
    // and sound share the same event start instead of drifting on network load.
    const audio = this.criarAudio(effect);
    if (audio) {
      let started = false;
      const tocarSom = () => {
        if (started) return;
        started = true;
        audio.currentTime = 0;
        audio.play().then(() => {
          this.sonsTocados += 1;
          window.removeEventListener('pointerdown', audioRetry);
        }).catch(() => {
          started = false;
        });
      };
      audioRetry = () => {
        if (!image || image.complete) {
          tocarSom();
          window.removeEventListener('pointerdown', audioRetry);
        }
      };
      window.addEventListener('pointerdown', audioRetry);
      if (image) {
        image.decode().then(() => {
          if (this.instances.get(key)?.node !== node) return;
          image.style.opacity = '1';
          tocarSom();
        }).catch(() => {
          if (this.instances.get(key)?.node !== node) return;
          image.style.opacity = '1';
          tocarSom();
        });
      } else {
        tocarSom();
      }
    } else if (image) {
      image.decode().then(() => {
        if (this.instances.get(key)?.node === node) image.style.opacity = '1';
      }).catch(() => {
        if (this.instances.get(key)?.node === node) image.style.opacity = '1';
      });
    }

    const duration = Number(effect.durationMs) || 6000;
    const timer = setTimeout(() => this.dispose(key), duration + 800);

    // O FIM do efeito e do temporizador (`durationMs` + folga) e do
    // `layer.onEnded`. Nao ha `animationend` aqui: a animacao de ENTRADA
    // dispara `animationend` e encerrava o efeito logo depois de nascer.
    const entry = { node, layer, video, image, audio, timer, retry, audioRetry };
    this.instances.set(key, entry);

    return entry;
  }

  dispose(key) {
    const entry = this.instances.get(key);
    if (!entry) return;
    clearTimeout(entry.timer);
    window.removeEventListener('pointerdown', entry.retry);
    window.removeEventListener('pointerdown', entry.audioRetry);
    try { entry.video?.pause(); } catch { /* ignore */ }
    // Item 9: o som NAO pode continuar depois que o efeito sai da tela.
    try {
      entry.audio?.pause();
      if (entry.audio) entry.audio.src = '';
    } catch { /* ignore */ }
    if (entry.image) { entry.image.src = ''; }
    entry.layer?.destroy();
    entry.node.style.opacity = '0';
    setTimeout(() => entry.node.remove(), 200);
    this.instances.delete(key);
  }

  clear() {
    for (const key of [...this.instances.keys()]) this.dispose(key);
  }

  get count() {
    return this.instances.size;
  }
}

/**
 * Coracoes flutuantes da LIVE: 1 toque = 1 like.
 * Os pequenos coracoes sobem pela tela (animacao visual); o like real e
 * enviado ao backend em cada toque.
 */
/** Teto de coracoes no DOM: os mais antigos saem, nada acumula (item 8). */
const MAXIMO_CORACOES = 40;

export class HeartLayer {
  constructor(host) {
    this.host = host || document.getElementById('live-hearts');
    // Mesmo motivo do `EffectOverlay` (item 6): a camada de coracoes precisa
    // ficar DENTRO da `.live-page` para ficar acima do video e dos controles,
    // e nao atras deles.
    this.origin = this.host?.parentElement || null;
    this.originNext = this.host?.nextSibling || null;
    this.count = 0;
  }

  /** Coloca a camada dentro da tela da LIVE. */
  mountIn(parent) {
    if (!this.host || !parent || this.host.parentElement === parent) return;
    if (!this.origin) {
      this.origin = this.host.parentElement;
      this.originNext = this.host.nextSibling;
    }
    parent.append(this.host);
  }

  /** Devolve a camada ao `<body>` quando a LIVE fecha. */
  unmount() {
    if (!this.host || !this.origin) return;
    if (this.originNext && this.originNext.parentElement === this.origin) {
      this.origin.insertBefore(this.host, this.originNext);
    } else {
      this.origin.append(this.host);
    }
  }

  spawn(origin = null) {
    if (!this.host) return;
    this.count += 1;
    const node = document.createElement('div');
    node.className = 'flying-heart';
    // Escape unicode: o emoji literal vira "?" quando o arquivo e lido como
    // latin-1, e o coracao saia como texto corrompido. Aqui nao ha como.
    node.textContent = '\u2764\uFE0F';
    const x = origin?.x ?? (window.innerWidth - 70 - Math.random() * 40);
    const y = origin?.y ?? (window.innerHeight * 0.55);
    node.style.left = `${x}px`;
    node.style.top = `${y}px`;
    // Cada coracao tem desvio lateral, inclinacao, tamanho e duracao proprios:
    // e o que faz parecer um choveiro e nao uma coluna reta.
    node.style.setProperty('--dx', `${(Math.random() - 0.5) * 80}px`);
    node.style.setProperty('--rot', `${(Math.random() - 0.5) * 48}deg`);
    node.style.fontSize = `${18 + Math.random() * 14}px`;
    node.style.setProperty('--dur', `${(2 + Math.random() * 0.8).toFixed(2)}s`);
    this.host.append(node);
    // `animationend` e quem remove; o timeout cobre o caso de aba em segundo
    // plano, em que o evento nao chega.
    node.addEventListener('animationend', () => node.remove(), { once: true });
    setTimeout(() => node.remove(), 4000);
    // Limite de coracoes no DOM: os mais antigos saem, nada acumula.
    while (this.host.children.length > MAXIMO_CORACOES) this.host.firstChild.remove();
  }

  clear() {
    this.host?.replaceChildren();
    this.count = 0;
  }
}
