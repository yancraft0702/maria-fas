import { WebSocketServer } from 'ws';
import logger from '../lib/logger.js';
import { newId } from '../lib/ids.js';
import { getUserById } from '../domain/users.js';
import { resolveSession } from '../domain/sessions.js';
import { SESSION_COOKIE } from '../domain/auth.js';
import { EVENTS, CLIENT_FRAMES, topics, isValidTopic } from './protocol.js';

/** Le um cookie do header `Cookie` do handshake. */
function readCookie(header, name) {
  if (!header) return null;
  for (const part of String(header).split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

const HEARTBEAT_MS = 30_000;

/**
 * Hub realtime unico da plataforma.
 * - Um unico WebSocketServer (upgrade em /ws)
 * - Multiplos sockets por usuario (varias abas / dispositivos)
 * - Topics com contagem de referencia e unsubscribe automatico
 * - Backpressure: fecha socket que excede o buffer
 * - Idempotencia: `event_id` unico por publicacao; o cliente deduplica
 */
class RealtimeHub {
  constructor() {
    this.wss = null;
    /** @type {Set<object>} */
    this.sockets = new Set();
    /** @type {Map<string, Set<object>>} */
    this.topics = new Map();
    /** @type {Map<string, Set<object>>} userId -> sockets */
    this.byUser = new Map();
    this.seq = 0;
    this.liveControllers = new Map();
  }

  attach(server, path = '/ws') {
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
    server.on('upgrade', (req, socket, head) => {
      let url;
      try {
        url = new URL(req.url, 'http://localhost');
      } catch {
        socket.destroy();
        return;
      }
      if (url.pathname !== path) {
        socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.wss.emit('connection', ws, req, url);
      });
    });

    this.wss.on('connection', (ws, req, url) => this.onConnection(ws, req, url));

    const timer = setInterval(() => this.sweep(), HEARTBEAT_MS);
    timer.unref?.();
    this.heartbeatTimer = timer;
    return this;
  }

  onConnection(ws, req, url) {
    ws.isAlive = true;
    ws.id = newId('sock');
    ws.userId = null;
    ws.sessionId = null;
    ws.topics = new Set();
    ws.authenticatedAt = Date.now();
    ws.subscriptions = new Set();

    // Autenticacao pela MESMA cookie de sessao do HTTP (o navegador envia a
    // cookie no handshake do WebSocket porque e same-origin). Sem isto o
    // socket nunca autenticaria e todo o realtime ficaria mudo no cliente.
    // `?token=` continua aceito para clientes nativos/sem cookie.
    const cookieToken = readCookie(req.headers?.cookie, SESSION_COOKIE);
    ws.providedToken = cookieToken || url?.searchParams?.get('token') || null;
    this.sockets.add(ws);

    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (raw) => {
      this.onMessage(ws, raw);
    });

    ws.on('close', () => this.onClose(ws));
    ws.on('error', (err) => {
      logger.debug('erro de socket realtime', { socket: ws.id, error: err.message });
      this.onClose(ws);
    });

    this.send(ws, {
      type: 'HELLO',
      data: { socketId: ws.id, serverTime: Date.now(), heartbeatMs: HEARTBEAT_MS },
    });

    // Autentica imediatamente quando a cookie bastou: o cliente nao precisa
    // (nao consegue) enviar o token de sessao da API por JavaScript.
    if (ws.providedToken) this.handleAuth(ws, { data: { token: ws.providedToken } });
  }

  onMessage(ws, raw) {
    let frame;
    try {
      frame = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
    } catch {
      this.sendError(ws, 'invalid_json', 'Frame JSON invalido');
      return;
    }
    if (!frame || typeof frame !== 'object' || typeof frame.type !== 'string') {
      this.sendError(ws, 'invalid_frame', 'Frame invalido');
      return;
    }
    try {
      this.handleFrame(ws, frame);
    } catch (err) {
      logger.error('erro ao processar frame realtime', { socket: ws.id, error: err.message });
      this.sendError(ws, err.code || 'internal_error', err.expose === false ? 'Erro interno' : err.message);
    }
  }

  handleFrame(ws, frame) {
    switch (frame.type) {
      case CLIENT_FRAMES.AUTH:
        return this.handleAuth(ws, frame);
      case CLIENT_FRAMES.SUBSCRIBE:
        return this.handleSubscribe(ws, frame);
      case CLIENT_FRAMES.UNSUBSCRIBE:
        return this.handleUnsubscribe(ws, frame);
      case CLIENT_FRAMES.PUBLISH:
        return this.handlePublish(ws, frame);
      case CLIENT_FRAMES.LIVE_SIGNAL:
        return this.handleLiveSignal(ws, frame);
      case CLIENT_FRAMES.PING:
        return this.send(ws, { type: 'PONG', data: { t: frame.data?.t ?? Date.now() } });
      default:
        return this.sendError(ws, 'unknown_frame', `Tipo de frame desconhecido: ${frame.type}`);
    }
  }

  handleAuth(ws, frame) {
    if (ws.userId) {
      this.send(ws, { type: 'AUTH_OK', data: { userId: ws.userId, seq: this.seq } });
      return;
    }
    const token = frame.data?.token || ws.providedToken;
    if (!token) {
      this.sendError(ws, 'auth_token_missing', 'Token de sessao ausente');
      ws.close(4401, 'auth required');
      return;
    }
    const session = resolveSession(token);
    if (!session) {
      this.sendError(ws, 'auth_invalid_session', 'Sessao invalida ou expirada');
      ws.close(4401, 'invalid session');
      return;
    }
    const user = getUserById(session.user_id);
    if (!user || user.status === 'banned' || user.status === 'deleted') {
      this.sendError(ws, 'auth_user_unavailable', 'Conta indisponivel');
      ws.close(4403, 'account unavailable');
      return;
    }
    ws.userId = user.id;
    ws.sessionId = session.id;
    let set = this.byUser.get(user.id);
    if (!set) {
      set = new Set();
      this.byUser.set(user.id, set);
    }
    set.add(ws);
    this.send(ws, {
      type: 'AUTH_OK',
      data: { userId: user.id, username: user.username, role: user.role, seq: this.seq },
    });
    if (this.onUserOnline) {
      Promise.resolve(this.onUserOnline(user)).catch((e) =>
        logger.error('onUserOnline falhou', { error: e.message }));
    }
    // Entrou no sistema: a contagem de online mudou.
    this.announcePresence();
  }

  handleSubscribe(ws, frame) {
    if (!ws.userId) {
      this.sendError(ws, 'not_authenticated', 'Autentique antes de assinar topicos');
      return;
    }
    const list = Array.isArray(frame.data?.topics) ? frame.data.topics : [];
    const accepted = [];
    for (const topic of list) {
      if (!isValidTopic(topic)) continue;
      if (!this.canSubscribe(ws.userId, topic)) continue;
      this.subscribe(ws, topic);
      accepted.push(topic);
    }
    this.send(ws, { type: 'SUBSCRIBED', data: { topics: accepted, seq: this.seq } });
    if (accepted.includes('global-chat')) this.announcePresence();
  }

  handleUnsubscribe(ws, frame) {
    const list = Array.isArray(frame.data?.topics) ? frame.data.topics : [];
    for (const topic of list) this.unsubscribe(ws, topic);
    this.send(ws, { type: 'UNSUBSCRIBED', data: { topics: list } });
  }

  /**
   * Publicacao vinda do cliente SEMPRE passa por um handler de dominio
   * (registrado em routes/realtime.js). O frontend nao e autoridade.
   */
  handlePublish(ws, frame) {
    if (!ws.userId) {
      this.sendError(ws, 'not_authenticated', 'Autentique antes de publicar');
      return;
    }
    const handler = this.publishHandlers.get(frame.data?.event);
    if (!handler) {
      this.sendError(ws, 'unknown_publish_event', `Evento nao publicavel: ${frame.data?.event ?? '(vazio)'}`);
      return;
    }
    Promise.resolve(handler(ws, frame.data || {}))
      .then((result) => {
        if (result && result.error) this.sendError(ws, result.error.code, result.error.message, result.error.requestId);
      })
      .catch((err) => {
        logger.error('publish handler falhou', { event: frame.data?.event, error: err.message });
        this.sendError(ws, err.code || 'internal_error', err.expose === false ? 'Erro interno' : err.message, err.requestId);
      });
  }

  /** Sinais WebRTC (offer/answer/ice) roteados pelo host da LIVE. */
  handleLiveSignal(ws, frame) {
    if (!ws.userId) {
      this.sendError(ws, 'not_authenticated', 'Autentique antes de enviar sinais');
      return;
    }
    const { roomId, to, signal } = frame.data || {};
    if (!roomId || !to || !signal) {
      this.sendError(ws, 'invalid_signal', 'Sinal invalido (roomId, to e signal sao obrigatorios)');
      return;
    }
    const targets = this.byUser.get(to);
    if (!targets?.size) return; // destino desconectado: sinal descartado com seguranca

    // Sinalizacao de WebRTC viaja como EVENT (mesmo envelope dos demais
    // eventos: event_id para dedup, seq, timestamp). O cliente so processa
    // frames do tipo EVENT - enviar um frame cru deixaria a sinalizacao muda.
    this.seq += 1;
    const signalEvent = {
      type: 'EVENT',
      data: {
        event_id: newId('ev'),
        type: 'LIVE_SIGNAL',
        topic: topics.live(roomId),
        timestamp: Date.now(),
        seq: this.seq,
        payload: { roomId, from: ws.userId, to, signal },
      },
    };
    for (const target of targets) this.send(target, signalEvent);
  }

  // ---- Autorizacao de topico (backend e autoridade) ----------------------
  canSubscribe(userId, topic) {
    if (topic === topics.user(userId)) return true;
    if (topic === 'global-chat') return true;
    if (topic === topics.liveDirectory()) return true;
    // Item 7: o "Para voce" e aberto a qualquer usuario autenticado, entao o
    // fluxo de novas publicacoes tambem e. O post continua passando pelos
    // filtros de visibilidade do feed antes de ser exibido.
    if (topic === topics.feedNew()) return true;
    if (topic.startsWith('live:host:')) return topic === topics.liveHost(userId);
    if (topic.startsWith('live:')) return this.liveControllers.get(topic)?.canJoin?.(userId) ?? true;
    if (topic.startsWith('post:')) return true;
    // Itens 17 e 18: fluxo do painel administrativo. O papel e lido do banco
    // de verdade - o frontend nao decide quem entra.
    if (topic === topics.adminEvents()) return this.isStaff(userId);
    return false;
  }

  /** @returns {boolean} O usuario e moderador ou admin (fonte: banco). */
  isStaff(userId) {
    if (!userId) return false;
    const user = getUserById(userId);
    return user?.role === 'admin' || user?.role === 'moderator';
  }

  // ---- Publish handlers (registrados por dominio) ------------------------
  publishHandlers = new Map();

  registerPublishHandler(event, handler) {
    if (this.publishHandlers.has(event)) {
      throw new Error(`Publish handler duplicado: ${event}`);
    }
    this.publishHandlers.set(event, handler);
  }

  // ---- Fanout ------------------------------------------------------------
  /**
   * Publica um evento para um topico.
   * - `excludeSocket`: nao entrega ao socket que originou (evita eco)
   * - `onlyUserIds`: entrega apenas a esses usuarios (além dos assinantes)
   */
  publish(topic, type, payload, { excludeSocket = null, onlyUserIds = null } = {}) {
    if (!isValidTopic(topic)) throw new Error(`Topico invalido: ${topic}`);
    this.seq += 1;
    const event = {
      event_id: newId('ev'),
      type,
      topic,
      timestamp: Date.now(),
      seq: this.seq,
      payload: payload ?? {},
    };
    const frame = { type: 'EVENT', data: event };
    const delivered = new Set();

    const set = this.topics.get(topic);
    if (set?.size) {
      const ids = onlyUserIds ? new Set(onlyUserIds) : null;
      for (const ws of set) {
        if (ws === excludeSocket) continue;
        if (ids && ws.userId && !ids.has(ws.userId)) continue;
        this.send(ws, frame);
        delivered.add(ws);
      }
    }
    if (onlyUserIds) {
      for (const userId of onlyUserIds) {
        const userSockets = this.byUser.get(userId);
        if (!userSockets?.size) continue;
        for (const ws of userSockets) {
          if (ws === excludeSocket || delivered.has(ws)) continue;
          this.send(ws, frame);
        }
      }
    }
    return event;
  }

  /** Publica direto para os sockets de um usuario (sem topico). */
  publishToUser(userId, type, payload) {
    this.seq += 1;
    const event = {
      event_id: newId('ev'),
      type,
      topic: topics.user(userId),
      timestamp: Date.now(),
      seq: this.seq,
      payload: payload ?? {},
    };
    const sockets = this.byUser.get(userId);
    if (sockets?.size) {
      for (const ws of sockets) this.send(ws, { type: 'EVENT', data: event });
    }
    return event;
  }

  subscribe(ws, topic) {
    ws.topics.add(topic);
    let set = this.topics.get(topic);
    if (!set) {
      set = new Set();
      this.topics.set(topic, set);
    }
    set.add(ws);
    if (this.onTopicChange) {
      Promise.resolve(this.onTopicChange(topic, 1)).catch((e) =>
        logger.error('onTopicChange falhou', { topic, error: e.message }));
    }
  }

  unsubscribe(ws, topic) {
    ws.topics.delete(topic);
    const set = this.topics.get(topic);
    if (set) {
      set.delete(ws);
      if (set.size === 0) this.topics.delete(topic);
    }
    if (this.onTopicChange) {
      Promise.resolve(this.onTopicChange(topic, -1)).catch((e) =>
        logger.error('onTopicChange falhou', { topic, error: e.message }));
    }
  }

  onClose(ws) {
    if (!this.sockets.has(ws)) return;
    this.sockets.delete(ws);
    for (const topic of [...ws.topics]) this.unsubscribe(ws, topic);
    if (ws.userId) {
      const set = this.byUser.get(ws.userId);
      if (set) {
        set.delete(ws);
        if (set.size === 0) {
          this.byUser.delete(ws.userId);
          if (this.onUserOffline) {
            Promise.resolve(this.onUserOffline(ws.userId)).catch((e) =>
              logger.error('onUserOffline falhou', { userId: ws.userId, error: e.message }));
          }
        }
      }
    }
    if (ws.userId && this.onDisconnect) {
      Promise.resolve(this.onDisconnect(ws)).catch((e) =>
        logger.error('onDisconnect falhou', { socket: ws.id, error: e.message }));
    }
    this.announcePresence();
  }

  /**
   * Publica a contagem de usuarios conectados no chat global.
   * A contagem e derivada dos sockets AUTENTICADOS do proprio hub (fonte
   * unica) e e empurrada para quem assinou `global-chat`.
   */
  announcePresence() {
    const count = this.onlineCountForTopic('global-chat');
    const set = this.topics.get('global-chat');
    if (!set?.size) return count;
    this.seq += 1;
    const frame = {
      type: 'EVENT',
      data: {
        event_id: newId('ev'),
        type: 'PRESENCE',
        topic: 'global-chat',
        timestamp: Date.now(),
        seq: this.seq,
        payload: { onlineCount: count },
      },
    };
    for (const ws of set) this.send(ws, frame);
    return count;
  }

  send(ws, message) {
    if (!ws || ws.readyState !== 1) return false;
    try {
      ws.send(JSON.stringify(message));
      return true;
    } catch (err) {
      logger.debug('falha ao enviar frame realtime', { socket: ws.id, error: err.message });
      return false;
    }
  }

  sendError(ws, code, message, requestId = null) {
    this.send(ws, { type: 'ERROR', data: { code, message, request_id: requestId } });
  }

  /** Fecha todos os sockets de um usuario (ban, revogacao de sessao). */
  disconnectUser(userId, code = '4403', reason = 'disconnected') {
    const sockets = this.byUser.get(userId);
    if (!sockets?.size) return 0;
    let count = 0;
    for (const ws of [...sockets]) {
      this.publishToUser(userId, EVENTS.SESSION_REVOKED, { reason });
      this.send(ws, { type: 'SESSION_REVOKED', data: { reason } });
      try { ws.close(code, reason); } catch { /* ignore */ }
      count += 1;
    }
    return count;
  }

  isUserOnline(userId) {
    return Boolean(this.byUser.get(userId)?.size);
  }

  onlineUserCount() {
    return this.byUser.size;
  }

  onlineCountForTopic(topic) {
    const set = this.topics.get(topic);
    if (!set) return 0;
    const users = new Set();
    for (const ws of set) if (ws.userId) users.add(ws.userId);
    return users.size;
  }

  topicMembers(topic) {
    const set = this.topics.get(topic);
    if (!set) return [];
    const users = new Set();
    for (const ws of set) if (ws.userId) users.add(ws.userId);
    return [...users];
  }

  stats() {
    return {
      sockets: this.sockets.size,
      users: this.byUser.size,
      topics: this.topics.size,
      seq: this.seq,
    };
  }

  sweep() {
    for (const ws of this.sockets) {
      if (ws.isAlive === false) {
        this.onClose(ws);
        try { ws.terminate(); } catch { /* ignore */ }
        continue;
      }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* ignore */ }
    }
  }

  async close() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    for (const ws of this.sockets) {
      try { ws.close(1001, 'server shutting down'); } catch { /* ignore */ }
    }
    await new Promise((resolve) => {
      if (!this.wss) return resolve();
      this.wss.close(() => resolve());
      setTimeout(resolve, 2000).unref?.();
    });
    this.sockets.clear();
    this.topics.clear();
    this.byUser.clear();
  }
}

export const hub = new RealtimeHub();
export default hub;
