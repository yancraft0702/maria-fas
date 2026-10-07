import router from '../router.js';
import { endpoint } from '../middleware.js';
import config from '../config.js';
import { writeJson } from '../http.js';
import * as v from '../lib/validate.js';
import { get, run } from '../db/index.js';
import { notFound, forbidden, badRequest } from '../lib/errors.js';
import hub from '../realtime/hub.js';
import { EVENTS, topics } from '../realtime/protocol.js';
import {
  createRoom, endRoom, getRoom, joinRoom, leaveRoom, serializeRoom, viewerCount, viewerList,
  postLiveMessage, listLiveMessages, sendHearts, triggerEffect, discoverLive, followHostsOfLive,
  liveConfig, iceServers, moderateViewer, MODERATOR_WINDOWS, activeLiveDirectory,
} from '../domain/live.js';
import { listEffects, usageToday } from '../domain/effects.js';
import { publicUser, getUserById } from '../domain/users.js';
import { saveUpload } from '../media/upload.js';
import { readSingleFile } from './auth.js';

// --------------------------------------------------------------------------
// Config / capacidade (nao exige LIVE ativa)
// --------------------------------------------------------------------------
router.get('/api/live/config', endpoint(async (ctx, res) => {
  const config = liveConfig();
  const unlimited = ctx.user.role === 'admin' || ctx.user.role === 'moderator';
  const used = usageToday(ctx.user.id);
  writeJson(res, 200, {
    ...config,
    turn: {
      // "configured" = URL de TURN com credencial disponivel. NAO e garantia de
      // relay: relay funcionando so se prova no cliente, quando um candidato
      // `relay` e gathering e o par conectado o usa.
      configured: config.iceServers.turnConfigured,
      transports: config.iceServers.turnTransports,
      // Item 3: como a credencial foi emitida e quando expira. `efemera` = o
      // segredo compartilhado nunca saiu do servidor. `estatica` = credencial
      // fixa (sem expiracao) - funciona, mas e o modo menos seguro.
      credentialMode: config.iceServers.turnCredentialMode,
      expiresAt: config.iceServers.turnExpiresAt || null,
      warning: config.iceServers.turnConfigured
        ? null
        : 'TURN nao configurado. A LIVE usa apenas STUN e pode falhar em redes com NAT restritivo ou rede movel.',
    },
    effects: {
      list: listEffects(ctx.user),
      usage: used,
      used,
      unlimited,
      ...(unlimited ? {} : { limit: config.effectDailyLimit }),
    },
    moderators: ctx.user?.role === 'user' ? MODERATOR_WINDOWS : undefined,
  });
}), { auth: true });

// --------------------------------------------------------------------------
// Descobrir LIVEs
// --------------------------------------------------------------------------
router.get('/api/live/discover', endpoint(async (ctx, res) => {
  writeJson(res, 200, {
    live: discoverLive({ viewer: ctx.user, limit: 30 }),
    following: ctx.user ? followHostsOfLive(ctx.user.id) : [],
  });
}), { auth: true });

router.get('/api/live', endpoint(async (ctx, res) => {
  writeJson(res, 200, { live: discoverLive({ viewer: ctx.user, limit: 30 }) });
}));

router.get('/api/lives/active', endpoint(async (ctx, res) => {
  writeJson(res, 200, { lives: activeLiveDirectory({ viewer: ctx.user }) });
}), { auth: true });

router.get('/api/users/:id/live', endpoint(async (ctx, res) => {
  const user = getUserById(v.id(ctx.params.id, { field: 'id' }));
  if (!user) throw notFound('user_not_found', 'Usuario nao encontrado');
  const room = get("SELECT * FROM live_rooms WHERE host_id = ? AND status = 'live'", { hostId: user.id });
  writeJson(res, 200, {
    live: room ? serializeRoom(room) : null,
    host: publicUser(user, ctx.user),
  });
}));

// --------------------------------------------------------------------------
// Host: iniciar / encerrar
// --------------------------------------------------------------------------
router.post('/api/live', endpoint(async (ctx, res) => {
  const title = v.plainText(ctx.body.title ?? '', { field: 'title', max: 120, required: false });
  const category = v.oneOf(ctx.body.category ?? 'geral', ['geral', 'jogo', 'musica', 'talk', 'ensino', 'outros'], {
    field: 'category', fallback: 'geral',
  });
  const coverMediaId = ctx.body.coverMediaId ? v.id(ctx.body.coverMediaId, { field: 'coverMediaId' }) : null;
  const room = createRoom({ hostId: ctx.user.id, title, category, coverMediaId });
  writeJson(res, 201, {
    room: serializeRoom(room, { includeMessages: true }),
    iceServers: iceServers(),
  });
}), { auth: true, rate: 'live' });

router.post('/api/live/:id/end', endpoint(async (ctx, res) => {
  const roomId = v.id(ctx.params.id, { field: 'id' });
  const result = endRoom({ roomId, actorId: ctx.user.id, actorRole: 'user', reason: 'host_ended' });
  writeJson(res, 200, result);
}), { auth: true, rate: 'live' });

router.get('/api/live/:id', endpoint(async (ctx, res) => {
  const roomId = v.id(ctx.params.id, { field: 'id' });
  const room = getRoom(roomId);
  if (!room) throw notFound('live_not_found', 'LIVE nao encontrada');
  if (!ctx.user) {
    writeJson(res, 200, { room: serializeRoom(room), viewerCount: viewerCount(roomId) });
    return;
  }
  writeJson(res, 200, {
    room: serializeRoom(room, { includeMessages: true }),
    viewerCount: viewerCount(roomId),
    viewers: viewerList(roomId),
  });
}));

// --------------------------------------------------------------------------
// Espectador: entrar / sair
// --------------------------------------------------------------------------
router.post('/api/live/:id/join', endpoint(async (ctx, res) => {
  const roomId = v.id(ctx.params.id, { field: 'id' });
  const reconnect = v.bool(ctx.body.reconnect);
  const result = joinRoom({ roomId, userId: ctx.user.id, reconnect });
  writeJson(res, 200, result);
}), { auth: true, rate: 'live' });

router.post('/api/live/:id/leave', endpoint(async (ctx, res) => {
  const roomId = v.id(ctx.params.id, { field: 'id' });
  writeJson(res, 200, leaveRoom({ roomId, userId: ctx.user.id, reason: 'left' }));
}), { auth: true, rate: 'live' });

router.get('/api/live/:id/viewers', endpoint(async (ctx, res) => {
  const roomId = v.id(ctx.params.id, { field: 'id' });
  const room = getRoom(roomId);
  if (!room) throw notFound('live_not_found', 'LIVE nao encontrada');
  const count = viewerCount(roomId);
  // Contagem e lista usam exatamente a mesma fonte (participantes ativos).
  writeJson(res, 200, {
    viewerCount: count,
    viewers: viewerList(roomId, { onlyOnline: ctx.query.onlyOnline === 'true' }),
    host: publicUser(getUserById(room.host_id), ctx.user),
  });
}));

router.get('/api/live/:id/messages', endpoint(async (ctx, res) => {
  const roomId = v.id(ctx.params.id, { field: 'id' });
  const limit = v.int(ctx.query.limit, { field: 'limit', min: 1, max: 100, required: false, fallback: 40 });
  writeJson(res, 200, { messages: listLiveMessages({ roomId, limit }) });
}));

// --------------------------------------------------------------------------
// Chat da LIVE
// --------------------------------------------------------------------------
router.post('/api/live/:id/messages', endpoint(async (ctx, res) => {
  const roomId = v.id(ctx.params.id, { field: 'id' });
  const body = v.plainText(ctx.body.body, { field: 'body', min: 1, max: 300 });
  const message = postLiveMessage({ roomId, userId: ctx.user.id, body });
  writeJson(res, 201, { message });
}), { auth: true, rate: 'chat' });

router.delete('/api/live/:id/messages/:messageId', endpoint(async (ctx, res) => {
  const roomId = v.id(ctx.params.id, { field: 'id' });
  const messageId = v.id(ctx.params.messageId, { field: 'messageId' });
  const room = getRoom(roomId);
  if (!room) throw notFound('live_not_found', 'LIVE nao encontrada');
  const isHost = room.host_id === ctx.user.id;
  if (!isHost && ctx.user.role === 'user') throw forbidden('not_live_host', 'Somente o anfitriao apaga mensagens');
  const message = get('SELECT * FROM live_messages WHERE id = ?', { id: messageId });
  if (!message || message.room_id !== roomId) throw notFound('message_not_found', 'Mensagem nao encontrada');
  run('UPDATE live_messages SET deleted_at = ? WHERE id = ?', { ts: Date.now(), id: messageId });
  hub.publish(topics.live(roomId), EVENTS.LIVE_COMMENT, {
    roomId, deleted: true, id: messageId,
  });
  writeJson(res, 200, { ok: true });
}), { auth: true, rate: 'write' });

// --------------------------------------------------------------------------
// Coracoes: 1 toque = 1 like (sem limite; nunca consome cota de efeitos)
// --------------------------------------------------------------------------
router.post('/api/live/:id/hearts', endpoint(async (ctx, res) => {
  const roomId = v.id(ctx.params.id, { field: 'id' });
  const quantity = v.int(ctx.body.quantity ?? 1, { field: 'quantity', min: 1, max: 50, required: false, fallback: 1 });
  writeJson(res, 201, sendHearts({ roomId, userId: ctx.user.id, quantity }));
}), { auth: true, rate: 'live' });

// --------------------------------------------------------------------------
// Efeitos
// --------------------------------------------------------------------------
router.get('/api/live/effects', endpoint(async (ctx, res) => {
  const used = usageToday(ctx.user.id);
  const unlimited = ctx.user.role === 'admin' || ctx.user.role === 'moderator';
  writeJson(res, 200, {
    effects: listEffects(ctx.user),
    usage: used,
    used,
    unlimited,
    ...(unlimited ? {} : { limit: config.effectDailyLimit }),
  });
}), { auth: true });

router.post('/api/live/:id/effects', endpoint(async (ctx, res) => {
  const roomId = v.id(ctx.params.id, { field: 'id' });
  const effectId = v.str(ctx.body.effectId, { field: 'effectId', min: 1, max: 64 });
  const clientEventId = ctx.body.clientEventId ? v.str(ctx.body.clientEventId, { field: 'clientEventId', max: 64 }) : null;
  const result = triggerEffect({ roomId, userId: ctx.user.id, effectId, clientEventId });
  writeJson(res, result.duplicate ? 200 : 201, result);
}), { auth: true, rate: 'live' });

// --------------------------------------------------------------------------
// Moderacao dentro da LIVE
// --------------------------------------------------------------------------
router.post('/api/live/:id/moderate', endpoint(async (ctx, res) => {
  const roomId = v.id(ctx.params.id, { field: 'id' });
  const targetUserId = v.id(ctx.body.userId, { field: 'userId' });
  const action = v.oneOf(ctx.body.action, ['mute', 'remove', 'ban'], { field: 'action' });
  // Janelas FIXAS de mute: o backend aceita apenas 2, 4, 6 ou 10 minutos.
  const minutes = v.int(ctx.body.minutes ?? 2, { field: 'minutes', min: 1, max: 60, required: false, fallback: 2 });
  if (!MODERATOR_WINDOWS.includes(minutes)) {
    throw badRequest('invalid_mute_window', `Janelas de mute permitidas: ${MODERATOR_WINDOWS.join(', ')} minutos`, {
      allowed: MODERATOR_WINDOWS,
      received: minutes,
    });
  }
  writeJson(res, 200, moderateViewer({
    roomId, actorId: ctx.user.id, actorRole: ctx.user.role, targetUserId, action, minutes,
  }));
}), { auth: true, rate: 'live' });

// --------------------------------------------------------------------------
// Upload de midia da LIVE (capa / audio)
// --------------------------------------------------------------------------
router.post('/api/live/upload', endpoint(async (ctx, res) => {
  const purpose = v.oneOf(ctx.query.purpose, ['image', 'audio', 'video'], { field: 'purpose' });
  const { buffer, contentType, filename } = await readSingleFile(ctx, [purpose]);
  const saved = await saveUpload({
    ownerId: ctx.user.id, category: purpose, buffer, declaredMime: contentType,
    originalName: filename, bucket: purpose === 'image' ? 'live' : purpose === 'audio' ? 'live' : 'live',
    purpose: 'live',
  });
  writeJson(res, 201, {
    media: { ...saved, url: `/api/media/stream?key=${encodeURIComponent(`${saved.bucket}/${saved.key}`)}` },
  });
}), { auth: true, rate: 'upload' });
