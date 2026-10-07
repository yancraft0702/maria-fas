/**
 * Gravador de audio do chat (🎤).
 * Fluxo real: getUserMedia -> MediaRecorder -> blob -> upload -> realtime.
 * Cancelar limpa o blob temporario e NAO envia nada.
 * Sem autoplay: o audio so toca quando o usuario aperta play.
 */
import { api } from '../core/api.js';

export class VoiceRecorder {
  constructor({ onTick, onError, onStateChange } = {}) {
    this.stream = null;
    this.recorder = null;
    this.chunks = [];
    this.blob = null;
    this.durationMs = 0;
    this.startedAt = 0;
    this.timer = null;
    this.state = 'idle'; // idle | recording | recorded | error
    this.onTick = onTick;
    this.onError = onError;
    this.onStateChange = onStateChange;
    this.maxMs = 5 * 60 * 1000;
  }

  setState(state, detail = {}) {
    this.state = state;
    this.onStateChange?.(state, detail);
  }

  static isSupported() {
    return Boolean(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
  }

  static pickMimeType() {
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/mp4',
      'audio/ogg;codecs=opus',
    ];
    for (const type of candidates) {
      if (window.MediaRecorder?.isTypeSupported?.(type)) return type;
    }
    return '';
  }

  async start() {
    if (!VoiceRecorder.isSupported()) {
      const err = new Error('Gravacao de audio nao suportada neste navegador');
      this.onError?.(err);
      throw err;
    }
    this.reset();
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (err) {
      const message = err.name === 'NotAllowedError'
        ? 'Permissao de microfone negada'
        : err.name === 'NotFoundError'
          ? 'Nenhum microfone encontrado'
          : `Falha ao abrir o microfone: ${err.message}`;
      this.setState('error', { message });
      this.onError?.(new Error(message));
      throw new Error(message);
    }

    const mimeType = VoiceRecorder.pickMimeType();
    try {
      this.recorder = mimeType
        ? new MediaRecorder(this.stream, { mimeType })
        : new MediaRecorder(this.stream);
    } catch {
      this.cleanupStream();
      const message = 'Este navegador nao conseguiu iniciar o gravador';
      this.setState('error', { message });
      this.onError?.(new Error(message));
      throw new Error(message);
    }

    this.chunks = [];
    this.recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) this.chunks.push(event.data);
    };
    this.recorder.onstop = () => {
      const type = this.recorder?.mimeType || mimeType || 'audio/webm';
      this.blob = this.chunks.length ? new Blob(this.chunks, { type }) : null;
      this.cleanupStream();
      this.setState(this.blob ? 'recorded' : 'error', {
        durationMs: this.durationMs,
        blob: this.blob,
      });
    };
    this.recorder.onerror = (event) => {
      this.cleanupStream();
      this.setState('error', { message: event.error?.message || 'Erro na gravacao' });
    };

    this.recorder.start(250);
    this.startedAt = Date.now();
    this.setState('recording', { startedAt: this.startedAt });
    this.timer = setInterval(() => {
      this.durationMs = Date.now() - this.startedAt;
      this.onTick?.(this.durationMs);
      if (this.durationMs >= this.maxMs) this.stop();
    }, 200);
  }

  stop() {
    if (this.recorder && this.recorder.state !== 'inactive') {
      this.durationMs = Date.now() - this.startedAt;
      clearInterval(this.timer);
      this.timer = null;
      this.recorder.stop();
      return this.blob;
    }
    return null;
  }

  /** Descarta a gravacao e nao envia nada. */
  cancel() {
    clearInterval(this.timer);
    this.timer = null;
    if (this.recorder && this.recorder.state !== 'inactive') {
      try { this.recorder.stop(); } catch { /* ignore */ }
    }
    this.cleanupStream();
    this.reset();
    this.setState('idle');
  }

  reset() {
    this.chunks = [];
    this.blob = null;
    this.durationMs = 0;
    this.startedAt = 0;
  }

  cleanupStream() {
    if (this.stream) {
      for (const track of this.stream.getTracks()) {
        try { track.stop(); } catch { /* ignore */ }
      }
      this.stream = null;
    }
  }

  /**
   * Envia o audio gravado. Retorna o objeto `media` do backend.
   *
   * CAUSA RAIZ do erro "O servidor nao devolveu o arquivo de audio" (item 2):
   * `api.upload()` NAO devolve a resposta - devolve `{ promise, abort }`.
   * Este codigo fazia `await api.upload(...)`, que resolve para o proprio
   * objeto `{ promise, abort }`, e lia `.media` de la (undefined). O servidor
   * respondia 201 com o arquivo certo o tempo todo; o frontend descartava.
   * Todos os outros chamadores ja desestruturavam `{ promise }` - este era o
   * unico que nao.
   */
  async upload() {
    if (!this.blob) throw new Error('Nada gravado para enviar');
    const mime = this.blob.type || 'audio/webm';
    const extension = mime.includes('mp4') ? 'm4a'
      : mime.includes('ogg') ? 'ogg'
        : 'webm';
    const file = new File([this.blob], `audio-${Date.now()}.${extension}`, { type: mime });
    const { promise } = api.upload('/api/chat/upload?purpose=audio', {
      file,
      onProgress: () => {},
    });
    const result = await promise;
    const media = result?.media || null;
    if (!media?.id) {
      // Mensagem HONESTA: mostra o que veio, em vez de dizer que o servidor
      // nao devolveu o arquivo. Se a resposta mudar de formato, o diagnostico
      // tem que apontar o formato real.
      const recebido = JSON.stringify(result).slice(0, 200);
      throw new Error(`Resposta do upload sem identificador de midia (recebido: ${recebido})`);
    }
    this.reset();
    this.setState('idle');
    return media;
  }

  dispose() {
    this.cancel();
  }
}

export function formatMs(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/**
 * Preview de audio gravado com reproducao manual (sem autoplay).
 */
export function createAudioPreview(blob, { durationMs = 0, ownerId = null } = {}) {
  const url = URL.createObjectURL(blob);
  const audio = document.createElement('audio');
  audio.controls = true;
  audio.preload = 'metadata';
  audio.src = url;

  const wrap = document.createElement('div');
  wrap.className = 'msg-audio';
  wrap.append(audio);

  const destroy = () => {
    try { audio.pause(); } catch { /* ignore */ }
    audio.removeAttribute('src');
    audio.load();
    wrap.remove();
    URL.revokeObjectURL(url);
  };
  return { element: wrap, durationMs, destroy, audio };
}
