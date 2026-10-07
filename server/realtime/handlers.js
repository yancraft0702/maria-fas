import hub from './hub.js';
import logger from '../lib/logger.js';
import { EVENTS, topics } from './protocol.js';
import * as messaging from '../domain/messaging.js';
import * as live from '../domain/live.js';
import { HOST_PRESENCE_TIMEOUT_MS } from '../domain/live.js';
import { all } from '../db/index.js';

/**
 * Handlers de publicacao realtime.
 * O cliente NUNCA publica direto no banco: apenas pede; o backend valida,
 * persiste e faz o fanout. Um unico registro por evento (sem duplicatas).
 */
const PUBLISH = {
  GLOBAL_CHAT_MESSAGE: 'GLOBAL_CHAT_MESSAGE',
  DM_MESSAGE: 'DM_MESSAGE',
  DM_READ: 'DM_READ',
  LIVE_COMMENT: 'LIVE_COMMENT',
  LIVE_HEART: 'LIVE_HEART',
  EFFECT_TRIGGER: 'EFFECT_TRIGGER',
  LIVE_JOIN: 'LIVE_JOIN',
  LIVE_LEAVE: 'LIVE_LEAVE',
  LIVE_VIDEO_ROTATION: 'LIVE_VIDEO_ROTATION',
  LIVE_HOST_HEARTBEAT: 'LIVE_HOST_HEARTBEAT',
};

function err(error) {
  return { error: { code: error.code || 'internal_error', message: error.expose === false ? 'Erro interno' : error.message, requestId: error.requestId } };
}

export function registerPublishHandlers() {
  hub.registerPublishHandler(PUBLISH.GLOBAL_CHAT_MESSAGE, async (ws, data) => {
    try {
      const result = messaging.sendGlobalMessage({
        userId: ws.userId,
        type: data.messageType || 'text',
        body: String(data.body ?? '').slice(0, 2000),
        mediaId: data.mediaId ?? null,
        repostPostId: data.repostPostId ?? null,
        effectId: data.effectId ?? null,
        metadata: data.metadata && typeof data.metadata === 'object' ? data.metadata : {},
        clientEventId: data.clientEventId ?? null,
      });
      return { result };
    } catch (error) {
      logger.debug('publish global chat recusado', { user: ws.userId, code: error.code });
      return err(error);
    }
  });

  hub.registerPublishHandler(PUBLISH.DM_MESSAGE, async (ws, data) => {
    try {
      const conversationId = String(data.conversationId ?? '');
      if (!conversationId) return err({ code: 'invalid_conversation', message: 'Conversa invalida' });
      const result = messaging.sendMessage({
        conversationId,
        senderId: ws.userId,
        type: data.messageType || 'text',
        body: String(data.body ?? '').slice(0, 4000),
        mediaId: data.mediaId ?? null,
        repostPostId: data.repostPostId ?? null,
        replyToId: data.replyToId ?? null,
        clientEventId: data.clientEventId ?? null,
        metadata: data.metadata && typeof data.metadata === 'object' ? data.metadata : {},
      });
      return { result };
    } catch (error) {
      return err(error);
    }
  });

  hub.registerPublishHandler(PUBLISH.DM_READ, async (ws, data) => {
    try {
      const conversationId = String(data.conversationId ?? '');
      return { result: messaging.markConversationRead({ conversationId, userId: ws.userId }) };
    } catch (error) {
      return err(error);
    }
  });

  hub.registerPublishHandler(PUBLISH.LIVE_JOIN, async (ws, data) => {
    try {
      const roomId = String(data.roomId ?? '');
      const result = live.joinRoom({ roomId, userId: ws.userId, reconnect: Boolean(data.reconnect) });
      return { result };
    } catch (error) {
      return err(error);
    }
  });

  hub.registerPublishHandler(PUBLISH.LIVE_LEAVE, async (ws, data) => {
    try {
      const roomId = String(data.roomId ?? '');
      return { result: live.leaveRoom({ roomId, userId: ws.userId, reason: 'left' }) };
    } catch (error) {
      return err(error);
    }
  });

  hub.registerPublishHandler(PUBLISH.LIVE_COMMENT, async (ws, data) => {
    try {
      const roomId = String(data.roomId ?? '');
      const body = String(data.body ?? '').slice(0, 300);
      if (!body.trim()) return err({ code: 'empty_message', message: 'Mensagem vazia' });
      const message = live.postLiveMessage({ roomId, userId: ws.userId, body });
      return { result: message };
    } catch (error) {
      return err(error);
    }
  });

  hub.registerPublishHandler(PUBLISH.LIVE_HEART, async (ws, data) => {
    try {
      const roomId = String(data.roomId ?? '');
      const quantity = Math.max(1, Math.min(50, Number(data.quantity) || 1));
      return { result: live.sendHearts({ roomId, userId: ws.userId, quantity }) };
    } catch (error) {
      return err(error);
    }
  });

  /**
 * ORIENTACAO DO QUADRO da LIVE.
 *
 * Quando a camera do anfitriao so entrega landscape e a tela e portrait, o
 * quadro e girado 90 graus - e assim cabe em tela cheia sem zoom e sem crop. Como
 * o `object-fit` e a geometria sao calculados a partir do quadro REAL em cada
 * ponta, o espectador chegaria sozinho a rotate(90deg); o que ele nao tem como
 * adivinhar e a DIRECAO (90 ou 270), que e propriedade do buffer da camera e
 * nao da tela.
 *
 * Por isso este e o unico dado que atravessa a LIVE alem do video: um inteiro
 * de 0, 90 ou 270. Nao ha transmissao extra, nao ha conexao, nao ha gravacao - o
 * hub repassa para a topica da LIVE e o ultimo valor vale. E o `LIVE_SIGNAL`
 * (WebRTC) fica intacto.
 */
hub.registerPublishHandler(PUBLISH.LIVE_VIDEO_ROTATION, async (ws, data) => {
  try {
    const roomId = String(data.roomId ?? '');
    const bruto = Number(data.rotacao);
    const rotacao = bruto === 90 || bruto === 270 ? bruto : 0;
    const room = live.getRoom(roomId);
    if (!room) return err({ code: 'live_not_found', message: 'LIVE nao encontrada' });
    if (room.host_id !== ws.userId) {
      return err({ code: 'not_live_host', message: 'Somente o anfitriao publica a orientacao' });
    }
    // Persiste na sala E avisa quem ja esta na LIVE. O banco cobre quem entra
    // depois; o fanout cobre quem esta assistindo agora.
    const salvo = live.setVideoRotation({ roomId, rotacao });
    hub.publish(topics.live(roomId), EVENTS.LIVE_VIDEO_ROTATION, {
      roomId,
      rotacao: salvo.rotacao,
    });
    return { result: salvo };
  } catch (error) {
    return err(error);
  }
});

  /**
   * HEARTBEAT DE PRESENCA DO HOST.
   *
   * O cliente envia este evento periodicamente enquanto o anfitriao esta na
   * tela da LIVE. O servidor valida que o remetente e o host e registra o
   * timestamp em `live_rooms.last_host_heartbeat`.
   *
   * O sweeper (`startHostPresenceSweeper`) verifica periodicamente as LIVEs
   * ativas e encerra aquelas cujo heartbeat esta velho demais (> 60s).
   */
  hub.registerPublishHandler(PUBLISH.LIVE_HOST_HEARTBEAT, async (ws, data) => {
    try {
      const roomId = String(data.roomId ?? '');
      const result = live.touchHostHeartbeat({ roomId, userId: ws.userId });
      return { result };
    } catch (error) {
      return err(error);
    }
  });

  hub.registerPublishHandler(PUBLISH.EFFECT_TRIGGER, async (ws, data) => {
  try {
      const roomId = String(data.roomId ?? '');
      const effectId = String(data.effectId ?? '');
      const result = live.triggerEffect({
        roomId,
        userId: ws.userId,
        effectId,
        clientEventId: data.clientEventId ?? null,
      });
      return { result };
    } catch (error) {
      return err(error);
    }
  });

  logger.info('handlers de publicacao realtime registrados', { count: Object.keys(PUBLISH).length });
}

// Presenca: o proprio hub publica a contagem de online (fonte unica: sockets
// autenticados). Aqui ficam apenas os ganchos de dominio.
export function wirePresence() {
  hub.onUserOnline = async (user) => {
    logger.debug('usuario online', { user: user.username });
  };
  hub.onUserOffline = async (userId) => {
    logger.debug('usuario offline', { userId });
  };
}

// --------------------------------------------------------------------------
// Encerramento automatico por ausencia do host (heartbeat)
// --------------------------------------------------------------------------

/** Verifica a cada segundo para encerrar a LIVE imediatamente apos o timeout. */
const PRESENCE_SWEEP_MS = 1_000;

let presenceSweeperTimer = null;

/**
 * Encerra LIVEs ativas cujo host nao envia heartbeat ha mais de 60s.
 * Roda a cada 5s. Se o host voltar antes do timeout, o heartbeat renovado
 * cancela o encerramento pendente (nao ha timer individual por LIVE).
 */
export function sweepHostPresence() {
  try {
    const cutoff = Date.now() - HOST_PRESENCE_TIMEOUT_MS;
    const stale = all("SELECT id, host_id FROM live_rooms WHERE status = 'live' AND (last_host_heartbeat IS NULL OR last_host_heartbeat < ?)", { cutoff });
    for (const room of stale) {
      logger.info('LIVE encerrada por ausencia do host', { roomId: room.id, hostId: room.host_id });
      live.endRoom({ roomId: room.id, actorId: room.host_id, actorRole: 'host', reason: 'host_timeout' });
    }
  } catch (error) {
    logger.error('sweeper de presenca falhou', { error: error.message });
  }
}

/**
 * Inicia o sweeper de presenca do host. Chamado uma unica vez na inicializacao
 * do servidor. Se o servidor reiniciar, LIVEs presas serao encerradas apos 60s.
 */
export function startHostPresenceSweeper() {
  if (presenceSweeperTimer) return; // nao duplicar
  sweepHostPresence();
  presenceSweeperTimer = setInterval(sweepHostPresence, PRESENCE_SWEEP_MS);
  presenceSweeperTimer.unref?.();
  logger.info('sweeper de presenca do host iniciado', { intervalMs: PRESENCE_SWEEP_MS, timeoutMs: HOST_PRESENCE_TIMEOUT_MS });
}

export { PUBLISH };
