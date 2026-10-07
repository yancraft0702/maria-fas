/**
 * CAMERA E MICROFONE da LIVE (e do editor, que reaproveita a mesma classe).
 *
 * Este modulo existe isolado porque ele e a ORIGEM do enquadramento: tudo o
 * que decide se a pessoa aparece com zoom, cortada ou normal acontece aqui,
 * antes de o stream chegar a qualquer `<video>`. Nao ha canvas, nao ha video
 * intermediario e nao ha CSS: o que sai daqui ja entra no quadro certo.
 *
 * As decisoes de captura:
 *
 *   1. `videoConstraint` nao sugere resolucao ou proporcao: o driver escolhe
 *      seu modo padrao, sem ser induzido a recortar o sensor.
 *   2. `neutralizarZoom` usa somente o limite minimo declarado pela camera,
 *      quando a capability existe.
 *
 * Fica em arquivo proprio tambem para poder ser testado em Node, sem camera:
 * a camera falsa do Chrome mente demais para validar captura (ver
 * `scripts/verify-live-captura.mjs`).
 *
 * Este modulo nao usa nada de navegador alem de `navigator.mediaDevices`.
 */
export class MediaDevices {
  constructor() {
    this.stream = null;
    this.camera = 'user';
    this.micEnabled = true;
    this.cameraEnabled = true;
  }

  static isSupported() {
    return Boolean(navigator.mediaDevices?.getUserMedia && navigator.mediaDevices?.enumerateDevices);
  }

  /**
   * Constraints de video da camera. Nao sugere resolucao nem proporcao: alguns
   * drivers escolhem um recorte mais fechado quando recebem essas preferencias.
   * O enquadramento usa depois as dimensoes realmente entregues pelo track.
   *
   * @param {string|null} deviceId camera especifica, se houver
   * @param {string} facing `user` (frontal) ou `environment` (traseira)
   * @returns {object} constraint de video
   */
  static videoConstraint({ deviceId = null, facing = 'user' } = {}) {
    return {
      // `ideal` e nao `exact`: respeita a escolha real do usuario.
      facingMode: deviceId ? undefined : { ideal: facing },
      deviceId: deviceId ? { exact: deviceId } : undefined,
      frameRate: { ideal: 30 },
    };
  }

  /**
   * Zera o ZOOM NATIVO do driver, se existir.
   *
   * Alguns aparelhos (principalmente Android com camera frontal) expoem `zoom`
   * em `getCapabilities()` e ja abrem com zoom digital acima de 1.0, ou aplicam
   * recorte de "retrato"/"beauty". Isso e um zoom de verdade, do tipo que o
   * item 5 proibe - e mais uma vez invisivel no `getSettings()`, que so devolve
   * a resolucao final.
   *
   * Aqui forcamos o MINIMO declarado pelo proprio driver, que e o
   * enquadramento mais aberto que a camera sabe fazer.
   *
   * @param {MediaStream|null} stream
   * @returns {Promise<{suportado:boolean, aplicado?:boolean, valor?:number, antes?:*, depois?:*}>}
   */
  static async neutralizarZoom(stream) {
    const track = stream?.getVideoTracks?.()[0];
    const caps = track?.getCapabilities?.() || {};
    const antes = track?.getSettings?.()?.zoom ?? null;
    if (!('zoom' in caps) || !caps.zoom || !Number.isFinite(Number(caps.zoom.min))) {
      return { suportado: false, aplicado: false, antes };
    }
    const minimo = Number(caps.zoom.min);
    const erros = [];
    const tentativas = [{ zoom: minimo }, { advanced: [{ zoom: minimo }] }];
    for (const constraint of tentativas) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await track.applyConstraints(constraint);
        return {
          suportado: true,
          aplicado: true,
          valor: minimo,
          antes,
          depois: track.getSettings?.()?.zoom ?? null,
        };
      } catch (error) {
        erros.push(error instanceof Error ? error.message : String(error));
      }
    }
    return {
      suportado: true,
      aplicado: false,
      valor: minimo,
      antes,
      erro: erros.join('; '),
    };
  }

  /**
   * Le o quadro REAL que a camera entregou.
   *
   * `videoTrack.getSettings()` e a fonte da verdade: em um celular real o
   * driver pode devolver 1080x1920, 720x1280, 640x480 ou 16:9 - e o
   * enquadramento tem que reagir ao que veio, nao ao que pedimos.
   *
   * @param {MediaStream|null} stream
   * @returns {{width:number,height:number,aspectRatio:number}|null}
   */
  static settingsDoQuadro(stream) {
    const track = stream?.getVideoTracks?.()[0];
    const s = track?.getSettings?.();
    if (!s) return null;
    const width = Number(s.width) || 0;
    const height = Number(s.height) || 0;
    if (width < 1 || height < 1) return null;
    return {
      width,
      height,
      aspectRatio: Number(s.aspectRatio) || width / height,
    };
  }

async open({ video = true, audio = true, facing = 'user', deviceId = null } = {}) {
    if (!MediaDevices.isSupported()) {
      throw new Error('Este navegador nao oferece acesso a camera/microfone');
    }
    const constraints = {
      video: video ? MediaDevices.videoConstraint({ deviceId, facing }) : false,
      audio: audio ? {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      } : false,
    };
    this.stream = await navigator.mediaDevices.getUserMedia(constraints);
    // Neutraliza somente o zoom que a propria camera expoe; a proporcao do
    // track nunca e alterada depois da captura.
    this.zoom = await MediaDevices.neutralizarZoom(this.stream);
    this.quadro = MediaDevices.settingsDoQuadro(this.stream);
    return this.stream;
  }

  listCameras() {
    return navigator.mediaDevices.enumerateDevices()
      .then((devices) => devices.filter((d) => d.kind === 'videoinput'));
  }

  listMics() {
    return navigator.mediaDevices.enumerateDevices()
      .then((devices) => devices.filter((d) => d.kind === 'audioinput'));
  }

  async switchCamera(deviceId) {
    if (!this.stream) return null;
    const videoTrack = this.stream.getVideoTracks()[0];
    // Mesmas constraints da abertura: pedir so `deviceId` deixava o driver
    // escolher qualquer resolucao, e a troca de camera mudava o enquadramento
    // (item 10).
    const stream = await navigator.mediaDevices.getUserMedia({
      video: MediaDevices.videoConstraint({ deviceId }),
    });
    const newTrack = stream.getVideoTracks()[0];
    if (!newTrack) return null;
    const sender = this.onSwitchTrack?.('video', newTrack);
    if (videoTrack) {
      videoTrack.stop();
      this.stream.removeTrack(videoTrack);
    }
    this.stream.addTrack(newTrack);
    // A camera traseira tem sensor e zoom proprios: o novo track precisa da
    // mesma neutralizacao antes de entrar no `<video>`.
    this.zoom = await MediaDevices.neutralizarZoom(this.stream);
    // O quadro pode ter mudado (a camera traseira costuma entregar outra
    // proporcao). O enquadramento tem que ser recalculado com o valor novo.
    this.quadro = MediaDevices.settingsDoQuadro(this.stream);
    return newTrack;
  }

  async toggleFacing() {
    this.camera = this.camera === 'user' ? 'environment' : 'user';
    return this.switchCamera(null);
  }

  setMicEnabled(enabled) {
    this.micEnabled = enabled;
    for (const track of this.stream?.getAudioTracks() || []) track.enabled = enabled;
  }

  setCameraEnabled(enabled) {
    this.cameraEnabled = enabled;
    for (const track of this.stream?.getVideoTracks() || []) track.enabled = enabled;
  }

  /** Aplica uma MediaStream nova as conexoes WebRTC (sem PeerConnection nova). */
  onTrackReplaced = null;

  close() {
    for (const track of this.stream?.getTracks() || []) {
      try { track.stop(); } catch { /* ignore */ }
    }
    this.stream = null;
  }
}
/**
 * A DIRECAO da rotacao que o quadro precisa, quando ele e landscape e a tela
 * e portrait.
 *
 * Por que isso e uma funcao e nao um atributo: a direcao e uma propriedade do
 * BUFFER da camera, nao da tela. Dois aparelhos podem entregar o buffer girado
 * para lados opostos, e nenhum numero de `getSettings()` diz qual e o caso.
 * Por isso a camera responde apenas o que PODE ser feito (o quadro e landscape?
 * a tela e portrait?) e a DIRECAO vem do anfitriao, que ve o proprio rosto na
 * tela e sabe qual lado esta de pe.
 *
 * O anfitriao publica esse numero para os espectadores (ver `live.js`), que
 * aplicam o mesmo valor - assim todo mundo ve a pessoa de pe, sem adivinhacao.
 *
 * @param {{width:number,height:number}|null} quadro quadro capturado da camera
 * @param {number} [preferencia] 0 (nao girar), 90 ou 270
 * @returns {number} 0, 90 ou 270
 */
export function rotacaoNecessaria(quadro, preferencia = 0) {
  const largura = Number(quadro?.width) || 0;
  const altura = Number(quadro?.height) || 0;
  if (largura < 1 || altura < 1) return 0;
  const telaRetrato = typeof window !== 'undefined'
    && Number(window.innerHeight) >= Number(window.innerWidth);
  const quadroPaisagem = largura > altura;
  // So ha rotacao a fazer quando as orientacoes se CONTRADIZEM. Repare que
  // "quadro landscape" e "tela portrait" sao os DOIS lados do mesmo conflito:
  // o quadro esta deitado em relacao ao aparelho. O mesmo vale para quadro
  // portrait em tela landscape. Quando os dois apontam para o mesmo lado, o
  // quadro ja esta de pe e girar deitaria a pessoa.
  if (quadroPaisagem !== telaRetrato) return 0;
  if (preferencia === 90 || preferencia === 270) return preferencia;
  return 0;
}