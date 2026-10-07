/**
 * Cliente realtime (WebSocket unico).
 * - Reconnect com backoff e jitter
 * - Deduplicacao por event_id (idempotencia no cliente)
 * - Assinaturas de topicos com refcount
 * - Cleanup explicito (nada de socket duplicado)
 */

const TOPICS = {
  user: (id) => `user:${id}`,
  live: (roomId) => `live:${roomId}`,
  liveDirectory: () => 'live:directory',
  liveHost: (id) => `live:host:${id}`,
  post: (id) => `post:${id}`,
  globalChat: () => 'global-chat',
};

const RECONNECT_STEPS = [500, 1000, 2000, 4000, 8000, 12000, 20000];

export class RealtimeClient extends EventTarget {
  constructor() {
    super();
    this.ws = null;
    this.state = 'idle';
    this.seq = 0;
    this.socketId = null;
    this.userId = null;
    this.token = null;
    this.subs = new Map(); // topic -> refcount
    this.seenEvents = new Set();
    this.seenOrder = [];
    this.attempt = 0;
    this.closedByUser = false;
    this.connectPromise = null;
    this.pending = [];
    this.pingTimer = null;
    this.latency = null;
    this.latencyTimer = null;
  }

  get url() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${location.host}/ws`;
  }

  isOpen() {
    return this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  /** Socket aberto E autenticado pelo servidor. */
  isAuthenticated() {
    return this.isOpen() && Boolean(this.userId);
  }

  /**
   * Conecta ao servidor realtime.
   *
   * Nao ha token: a autenticacao usa a MESMA cookie HttpOnly da API, que o
   * navegador envia sozinho no handshake do WebSocket (o JS nao consegue - nem
   * deve - ler a cookie). O parametro `token` existe so para clientes nativos,
   * que nao tem cookie.
   */
  async connect(token) {
    if (token) this.token = token;
    this.closedByUser = false;
    if (this.isOpen()) return this;
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = new Promise((resolve, reject) => {
      let settled = false;
      let ws;
      try {
        ws = new WebSocket(this.url);
      } catch (err) {
        this.connectPromise = null;
        reject(err);
        return;
      }
      this.ws = ws;
      this.state = 'connecting';
      this.emit('state', { state: 'connecting' });

      ws.onopen = () => {
        this.state = 'open';
        this.attempt = 0;
        this.emit('state', { state: 'open' });
        // Sem token: o servidor autentica pela cookie e responde AUTH_OK.
        // Com token (cliente nativo): pedimos explicitamente.
        if (this.token) this.send({ type: 'AUTH', data: { token: this.token } });
      };

      ws.onmessage = (event) => {
        let frame;
        try { frame = JSON.parse(event.data); } catch { return; }
        this.handleFrame(frame);
        if (frame.type === 'AUTH_OK' && !settled) {
          settled = true;
          this.connectPromise = null;
          resolve(this);
        }
      };

      ws.onerror = () => {
        if (!settled) {
          settled = true;
          this.connectPromise = null;
          reject(new Error('Falha ao conectar no realtime'));
        }
      };

      ws.onclose = (event) => {
        const wasOpen = this.state === 'open';
        this.state = 'closed';
        this.emit('state', { state: 'closed', code: event.code });
        this.stopHeartbeat();
        if (!settled) {
          settled = true;
          this.connectPromise = null;
          // Fechou sem AUTH_OK: sem sessao (cookie expirada) ou socket recusado.
          reject(new Error(
            event.code === 4401 || event.code === 4403
              ? 'Realtime recusou a sessao'
              : 'Conexao realtime encerrada',
          ));
        }
        if (wasOpen) this.emit('disconnected', { code: event.code, reason: event.reason });
        if (!this.closedByUser) this.scheduleReconnect();
      };
    });

    return this.connectPromise;
  }

  scheduleReconnect() {
    if (this.reconnectTimer) return;
    const base = RECONNECT_STEPS[Math.min(this.attempt, RECONNECT_STEPS.length - 1)];
    const delay = base + Math.floor(Math.random() * 400);
    this.attempt += 1;
    this.emit('reconnecting', { attempt: this.attempt, delay });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect(this.token).catch(() => { /* nova tentativa no proximo onclose */ });
    }, delay);
  }

  disconnect() {
    this.closedByUser = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.stopHeartbeat();
    if (this.ws) {
      try { this.ws.close(1000, 'client disconnect'); } catch { /* ignore */ }
    }
    this.ws = null;
    this.state = 'idle';
    this.subs.clear();
  }

  send(frame) {
    if (!this.isOpen()) {
      this.pending.push(frame);
      if (this.pending.length > 60) this.pending.shift();
      return false;
    }
    try {
      this.ws.send(JSON.stringify(frame));
      return true;
    } catch {
      return false;
    }
  }

  handleFrame(frame) {
    switch (frame.type) {
      case 'HELLO':
        this.socketId = frame.data.socketId;
        this.emit('hello', frame.data);
        break;
      case 'AUTH_OK':
        this.userId = frame.data.userId;
        this.emit('auth', frame.data);
        this.flushSubscriptions();
        this.startHeartbeat();
        break;
      case 'SUBSCRIBED':
        this.emit('subscribed', frame.data);
        break;
      case 'PONG':
        if (frame.data?.t) {
          this.latency = Date.now() - frame.data.t;
          this.emit('latency', { ms: this.latency });
        }
        break;
      case 'EVENT': {
        const event = frame.data;
        // Idempotencia: ignora eventos ja processados
        if (event.event_id) {
          if (this.seenEvents.has(event.event_id)) return;
          this.seenEvents.add(event.event_id);
          this.seenOrder.push(event.event_id);
          if (this.seenOrder.length > 800) {
            const drop = this.seenOrder.shift();
            this.seenEvents.delete(drop);
          }
        }
        if (event.seq) this.seq = Math.max(this.seq, event.seq);
        this.emit(event.type, event.payload ?? {}, event);
        this.emit('*', event);
        break;
      }
      case 'ERROR':
        this.emit('error:server', frame.data);
        break;
      case 'SESSION_REVOKED':
        this.emit('revoked', frame.data);
        break;
      default:
        break;
    }
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.pingTimer = setInterval(() => this.send({ type: 'PING', data: { t: Date.now() } }), 20000);
    this.latencyTimer = setInterval(() => this.emit('latency', { ms: this.latency }), 5000);
  }

  stopHeartbeat() {
    clearInterval(this.pingTimer);
    clearInterval(this.latencyTimer);
    this.pingTimer = null;
    this.latencyTimer = null;
  }

  flushSubscriptions() {
    const topics = [...this.subs.keys()];
    if (topics.length) this.send({ type: 'SUBSCRIBE', data: { topics } });
    while (this.pending.length) {
      const frame = this.pending.shift();
      this.send(frame);
    }
  }

  subscribe(...topics) {
    const fresh = [];
    for (const topic of topics) {
      if (typeof topic !== 'string') continue;
      const count = this.subs.get(topic) || 0;
      this.subs.set(topic, count + 1);
      if (count === 0) fresh.push(topic);
    }
    if (fresh.length && this.isOpen() && this.userId) {
      this.send({ type: 'SUBSCRIBE', data: { topics: fresh } });
    }
    return () => this.unsubscribe(...fresh);
  }

  unsubscribe(...topics) {
    const gone = [];
    for (const topic of topics) {
      const count = this.subs.get(topic);
      if (count === undefined) continue;
      if (count <= 1) {
        this.subs.delete(topic);
        gone.push(topic);
      } else {
        this.subs.set(topic, count - 1);
      }
    }
    if (gone.length && this.isOpen()) {
      this.send({ type: 'UNSUBSCRIBE', data: { topics: gone } });
    }
  }

  publish(event, data = {}) {
    return this.send({ type: 'PUBLISH', data: { event, ...data } });
  }

  signal(roomId, to, signal) {
    return this.send({ type: 'LIVE_SIGNAL', data: { roomId, to, signal } });
  }

  /**
   * `addEventListener` do EventTarget nao devolve nada. Aqui devolve a funcao
   * de cancelamento, que e o que as telas guardam em `cleanups`.
   */
  addEventListener(type, handler, options) {
    super.addEventListener(type, handler, options);
    return () => super.removeEventListener(type, handler, options);
  }

  on(type, handler, options) {
    super.addEventListener(type, handler, options);
    // `EventTarget.addEventListener` devolve `undefined`. Como as telas fazem
    // `cleanups.push(realtime.addEventListener(...))`, sem isto cada cleanup
    // guardava `undefined` e o `destroy()` quebrava com
    // "fn is not a function" (além de vazar o listener).
    return () => super.removeEventListener(type, handler, options);
  }

  emit(type, detail, raw = null) {
    this.dispatchEvent(new CustomEvent(type, { detail: raw ? { ...detail, __event: raw } : detail }));
  }

  stats() {
    return {
      state: this.state,
      userId: this.userId,
      subscriptions: this.subs.size,
      seq: this.seq,
      latency: this.latency,
      attempts: this.attempt,
    };
  }
}

export const realtime = new RealtimeClient();
export { TOPICS };
export default realtime;
