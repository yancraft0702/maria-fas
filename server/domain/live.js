import crypto from 'node:crypto';
import config from '../config.js';
import { servidoresTurnComCredencial } from '../lib/turn-credentials.js';
import { all, get, run, transaction, scalar } from '../db/index.js';
import { newId } from '../lib/ids.js';
import { notFound, forbidden, badRequest, conflict, tooManyRequests, gone } from '../lib/errors.js';
import { getUserById, publicUser, avatarUrlForKey, blockedEitherWay, isMuted } from './users.js';
import { canJoinLive } from './privacy.js';
import hub from '../realtime/hub.js';
import { EVENTS, topics } from '../realtime/protocol.js';
import { createNotification } from './notifications.js';
import { recordEffectUsage, effectAllowedForUser, EFFECT_CATALOG } from './effects.js';
import { ADMIN_EVENTS, publishAdminEvent, adminActivity } from './admin-activity.js';

export const HOST_PRESENCE_TIMEOUT_MS = 60_000;

// --------------------------------------------------------------------------
// Token de acesso a LIVE (o backend emite; o cliente nao escolhe papel)
// --------------------------------------------------------------------------
function b64url(buf) { return Buffer.from(buf).toString('base64url'); }

export function issueLiveToken({ userId, roomId, role }) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({
    sub: userId, room: roomId, role, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 * 6,
  }));
  const signature = crypto
    .createHmac('sha256', config.liveTokenSecret)
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${signature}`;
}

export function verifyLiveToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const expected = crypto.createHmac('sha256', config.liveTokenSecret).update(`${parts[0]}.${parts[1]}`).digest('base64url');
  const a = Buffer.from(expected);
  const b = Buffer.from(parts[2]);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (!payload.exp || payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

// --------------------------------------------------------------------------
// Salas
// --------------------------------------------------------------------------
export function createRoom({ hostId, title = '', category = 'geral', coverMediaId = null }) {
  const host = getUserById(hostId);
  if (!host) throw notFound('user_not_found', 'Usuario nao encontrado');
  if (host.status !== 'active') throw forbidden('account_unavailable', 'Conta indisponivel para iniciar LIVE');
  const activeRoom = get("SELECT * FROM live_rooms WHERE host_id = ? AND status = 'live'", { hostId });
  if (activeRoom) {
    const staleBefore = Date.now() - HOST_PRESENCE_TIMEOUT_MS;
    if (activeRoom.last_host_heartbeat == null || activeRoom.last_host_heartbeat <= staleBefore) {
      endRoom({ roomId: activeRoom.id, actorId: hostId, actorRole: 'host', reason: 'host_timeout' });
    } else {
      throw conflict('already_live', 'Voce ja esta em uma LIVE ativa');
    }
  }

  const id = newId('liv');
  const now = Date.now();
  transaction(() => {
    run(
      `INSERT INTO live_rooms (id, host_id, title, category, cover_media_id, status, started_at)
       VALUES (?, ?, ?, ?, ?, 'live', ?)`,
      { id, hostId, title, category, coverMediaId, now },
    );
    run(
      `INSERT INTO live_participants (id, room_id, user_id, role, is_moderator, joined_at)
       VALUES (?, ?, ?, 'host', 1, ?)`,
      { id: newId('lpt'), roomId: id, userId: hostId, now },
    );
  });

  hub.liveControllers.set(topics.live(id), {
    canJoin: (userId) => {
      const room = get('SELECT * FROM live_rooms WHERE id = ?', { roomId: id });
      return canJoinLive(room, { id: userId });
    },
  });

  // Heartbeat inicial: o host acabou de iniciar a LIVE, entao a presenca
  // esta confirmada. O sweeper usa este valor como ponto de partida.
  initHostHeartbeat({ roomId: id });

  createNotification({ userId: hostId, actorId: hostId, type: 'live_start', entityType: 'live', entityId: id, body: title });
  hub.publishToUser(hostId, EVENTS.LIVE_JOIN, { roomId: id, role: 'host', viewerCount: viewerCount(id) });
  publishLiveDirectoryChange();
  // Item 17: o painel administrativo acompanha LIVE iniciadas em tempo real.
  publishAdminEvent(ADMIN_EVENTS.LIVE_STARTED, {
    ...adminActivity('live_started', `LIVE iniciada: ${title || 'sem titulo'}`),
    roomId: id,
    hostId,
    title,
  });
  return getRoom(id);
}

export function getRoom(roomId) {
  return get('SELECT * FROM live_rooms WHERE id = ?', { roomId });
}

/**
 * Preferencia de rotacao do quadro, escolhida pelo anfitriao.
 *
 * Vive na sala porque tem de chegar a quem entra no MEIO da LIVE: o fanout do
 * realtime e em tempo real e nao alcanca quem ainda nao estava assinado no
 * topico. O valor e lido em `roomPublico`, que o espectador recebe no
 * `GET /api/live/:id`.
 *
 * @param {string} roomId
 * @param {number} rotacao 0, 90 ou 270
 */
export function setVideoRotation({ roomId, rotacao }) {
  const valor = rotacao === 90 || rotacao === 270 ? rotacao : 0;
  run('UPDATE live_rooms SET video_rotation = ? WHERE id = ?', { valor, roomId });
  return { rotacao: valor };
}

/**
 * Heartbeat de presenca do host.
 *
 * Enquanto o anfitriao esta na tela da LIVE, o cliente envia um heartbeat
 * periodico. O servidor registra o timestamp em `last_host_heartbeat`.
 * Um sweeper no hub verifica LIVEs ativas cujo heartbeat esta velho demais
 * (> 60s) e encerra a transmissao automaticamente.
 *
 * @param {string} roomId
 * @param {string} userId
 * @returns {{ ok: boolean, roomId: string, lastHostHeartbeat: number }}
 */
export function touchHostHeartbeat({ roomId, userId }) {
  const room = getRoom(roomId);
  if (!room) throw notFound('live_not_found', 'LIVE nao encontrada');
  if (room.status !== 'live') throw gone('live_ended', 'Esta LIVE ja foi encerrada');
  if (room.host_id !== userId) {
    throw forbidden('not_live_host', 'Somente o anfitriao pode enviar heartbeat de presenca');
  }
  const now = Date.now();
  run('UPDATE live_rooms SET last_host_heartbeat = ? WHERE id = ?', { now, id: roomId });
  return { ok: true, roomId, lastHostHeartbeat: now };
}

/**
 * Marca o heartbeat inicial quando a LIVE e criada.
 * Garante que o sweeper nao encerre a LIVE antes do primeiro heartbeat do host.
 */
export function initHostHeartbeat({ roomId }) {
  const now = Date.now();
  run('UPDATE live_rooms SET last_host_heartbeat = ? WHERE id = ?', { now, id: roomId });
}

export function endRoom({ roomId, actorId, actorRole = 'user', reason = 'host_ended' }) {
  const room = getRoom(roomId);
  if (!room) throw notFound('live_not_found', 'LIVE nao encontrada');
  if (room.host_id !== actorId && actorRole === 'user') {
    throw forbidden('not_live_host', 'Somente o anfitriao ou a moderação pode encerrar esta LIVE');
  }
  if (room.status !== 'live') {
    return { alreadyEnded: true, roomId };
  }
  const now = Date.now();
  transaction(() => {
    run("UPDATE live_rooms SET status = 'ended', ended_at = ?, ended_reason = ? WHERE id = ?", { now, reason, id: roomId });
    run('UPDATE live_participants SET left_at = ? WHERE room_id = ? AND left_at IS NULL', { now, roomId });
  });
  hub.publish(topics.live(roomId), EVENTS.LIVE_LEAVE, { roomId, reason: 'ended', viewerCount: 0 });
  publishLiveDirectoryChange();
  hub.publishToUser(room.host_id, EVENTS.MODERATION, { action: 'live_ended', roomId });
  // Item 17: encerramento visivel no painel em tempo real.
  publishAdminEvent(ADMIN_EVENTS.LIVE_ENDED, {
    ...adminActivity('live_ended', `LIVE encerrada (${reason})`),
    roomId,
    reason,
    hostId: room.host_id,
    title: room.title,
  });
  hub.liveControllers.delete(topics.live(roomId));

  return { ended: true, roomId, viewerCount: 0 };
}

function publishLiveDirectoryChange() {
  hub.publish(topics.liveDirectory(), EVENTS.LIVE_DIRECTORY_CHANGE, { changedAt: Date.now() });
}

/** Contador de espectadores: fonte unica, host NUNCA conta. */
export function viewerCount(roomId) {
  return scalar(
    "SELECT COUNT(DISTINCT user_id) AS c FROM live_participants WHERE room_id = ? AND left_at IS NULL AND role <> 'host'",
    { roomId },
    0,
  );
}

/**
 * Lista de espectadores.
 *
 * A MESMA fonte da contagem: `live_participants` com `left_at IS NULL` e
 * `role <> 'host'` (o anfitriao nunca e espectador). Quem ainda nao fechou a
 * aba continua na lista com `online: false` - como em qualquer transmissao
 * real - e `onlyOnline` filtra quando o chamador quiser apenas quem esta com
 * socket aberto no momento.
 */
export function viewerList(roomId, { onlyOnline = false, limit = 500 } = {}) {
  const rows = all(
    `SELECT p.user_id, p.joined_at, p.role, u.username, u.display_name, u.avatar_key, u.avatar_version
       FROM live_participants p JOIN users u ON u.id = p.user_id
      WHERE p.room_id = :roomId AND p.left_at IS NULL AND p.role <> 'host'
      ORDER BY p.joined_at DESC LIMIT :limit`,
    { roomId, limit },
  );
  return rows
    .filter((r) => !onlyOnline || hub.isUserOnline(r.user_id))
    .map((r) => ({
      id: r.user_id,
      username: r.username,
      displayName: r.display_name,
      joinedAt: r.joined_at,
      role: r.role,
      online: hub.isUserOnline(r.user_id),
      avatarUrl: avatarUrlForKey(r.avatar_key, r.avatar_version),
    }));
}

export function joinRoom({ roomId, userId, reconnect = false }) {
  const room = getRoom(roomId);
  if (!room) throw notFound('live_not_found', 'LIVE nao encontrada');
  if (room.status !== 'live') throw gone('live_ended', 'Esta LIVE ja foi encerrada');
  if (!canJoinLive(room, { id: userId })) throw forbidden('live_not_accessible', 'Esta LIVE nao esta disponivel para sua conta');
  if (blockedEitherWay(userId, room.host_id)) throw forbidden('live_blocked', 'Nao e possivel entrar nesta LIVE');

  const existing = get(
    "SELECT * FROM live_participants WHERE room_id = ? AND user_id = ? AND left_at IS NULL",
    { roomId, userId },
  );
  const now = Date.now();
  if (existing) {
    run('UPDATE live_participants SET disconnect_count = disconnect_count + 1 WHERE id = ?', { id: existing.id });
  } else {
    const count = viewerCount(roomId);
    if (count >= config.liveMaxViewers) {
      throw tooManyRequests('live_full', 'Esta LIVE atingiu o limite de espectadores');
    }
    run(
      `INSERT INTO live_participants (id, room_id, user_id, role, joined_at) VALUES (?, ?, ?, 'viewer', ?)`,
      { id: newId('lpt'), roomId, userId, now },
    );
    run('UPDATE live_rooms SET total_views = total_views + 1 WHERE id = ?', { id: roomId });
  }

  const participant = get(
    "SELECT * FROM live_participants WHERE room_id = ? AND user_id = ? AND left_at IS NULL",
    { roomId, userId },
  );
  const role = participant.role;
  const count = viewerCount(roomId);
  run('UPDATE live_rooms SET peak_viewers = MAX(peak_viewers, ?) WHERE id = ?', { count, id: roomId });

  const user = publicUser(getUserById(userId));
  hub.publish(topics.live(roomId), EVENTS.LIVE_JOIN, { roomId, userId, user, username: user?.username, viewerCount: count, role });
  publishLiveDirectoryChange();
  return {
    room: serializeRoom(room, { includeMessages: true }),
    role,
    token: issueLiveToken({ userId, roomId, role }),
    viewerCount: count,
    peerLimit: Math.max(1, Math.min(config.liveMaxPeers - 1, count + 1)),
    iceServers: iceServers(),
  };
}

export function leaveRoom({ roomId, userId, reason = 'left' }) {
  const participant = get(
    "SELECT * FROM live_participants WHERE room_id = ? AND user_id = ? AND left_at IS NULL",
    { roomId, userId },
  );
  if (!participant) return { left: false };
  const now = Date.now();
  run('UPDATE live_participants SET left_at = ? WHERE id = ?', { now, id: participant.id });
  const count = viewerCount(roomId);
  hub.publish(topics.live(roomId), EVENTS.LIVE_LEAVE, { roomId, userId, viewerCount: count, reason });
  publishLiveDirectoryChange();
  return { left: true, viewerCount: count };
}

export function activeParticipants(roomId) {
  return all(
    "SELECT user_id, role FROM live_participants WHERE room_id = ? AND left_at IS NULL",
    { roomId },
  );
}

// --------------------------------------------------------------------------
// Chat da LIVE (comentarios)
// --------------------------------------------------------------------------
export function postLiveMessage({ roomId, userId, body }) {
  const room = getRoom(roomId);
  if (!room || room.status !== 'live') throw gone('live_ended', 'Esta LIVE nao esta mais ativa');
  const participant = get(
    "SELECT 1 AS ok FROM live_participants WHERE room_id = ? AND user_id = ? AND left_at IS NULL",
    { roomId, userId },
  );
  if (!participant) throw forbidden('not_in_live', 'Entre na LIVE para comentar');
  if (isMuted(userId, 'user', room.host_id)) throw forbidden('live_muted_user', 'Voce silenciou este anfitriao');

  const id = newId('lms');
  const now = Date.now();
  run('INSERT INTO live_messages (id, room_id, user_id, body, created_at) VALUES (?, ?, ?, ?, ?)', {
    id, roomId, userId, body, now,
  });
  run('UPDATE live_rooms SET comment_count = comment_count + 1 WHERE id = ?', { id: roomId });

  const message = serializeLiveMessage(get('SELECT * FROM live_messages WHERE id = ?', { id }));
  hub.publish(topics.live(roomId), EVENTS.LIVE_COMMENT, { roomId, message });
  if (room.host_id !== userId) {
    const mutedByHost = isMuted(room.host_id, 'user', userId);
    if (!mutedByHost) {
      createNotification({
        userId: room.host_id, actorId: userId, type: 'live_comment',
        entityType: 'live', entityId: roomId, body,
      });
    }
  }
  return message;
}

export function listLiveMessages({ roomId, limit = 40 }) {
  const rows = all(
    'SELECT * FROM live_messages WHERE room_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT ?',
    { roomId, limit },
  );
  return rows.reverse().map((row) => serializeLiveMessage(row));
}

export function serializeLiveMessage(row) {
  if (!row) return null;
  const author = getUserById(row.user_id);
  return {
    id: row.id,
    roomId: row.room_id,
    text: row.body,
    createdAt: row.created_at,
    author: {
      id: author.id,
      username: author.username,
      displayName: author.display_name,
      avatarUrl: avatarUrlForKey(author.avatar_key, author.avatar_version),
      isHost: false,
    },
  };
}

// --------------------------------------------------------------------------
// Coracoes (likes ilimitados): 1 toque = 1 like
// --------------------------------------------------------------------------
export function sendHearts({ roomId, userId, quantity = 1 }) {
  const qty = Math.max(1, Math.min(50, Number(quantity) || 1));
  const room = getRoom(roomId);
  if (!room || room.status !== 'live') throw gone('live_ended', 'Esta LIVE nao esta mais ativa');
  const participant = get(
    "SELECT 1 AS ok FROM live_participants WHERE room_id = ? AND user_id = ? AND left_at IS NULL",
    { roomId, userId },
  );
  if (!participant) throw forbidden('not_in_live', 'Entre na LIVE para enviar coracoes');
  const id = newId('hrt');
  const now = Date.now();
  run('INSERT INTO live_likes (id, room_id, user_id, quantity, created_at) VALUES (?, ?, ?, ?, ?)', {
    id, roomId, userId, quantity: qty, now,
  });
  run('UPDATE live_rooms SET heart_count = heart_count + ? WHERE id = ?', { qty, id: roomId });
  // 1 toque = 1 like: o evento carrega a quantidade exata.
  hub.publish(topics.live(roomId), EVENTS.LIVE_HEART, { roomId, userId, quantity: qty, at: now });
  return { quantity: qty };
}

export function heartCount(roomId) {
  return scalar('SELECT COALESCE(SUM(quantity),0) AS c FROM live_likes WHERE room_id = ?', { roomId }, 0);
}

// --------------------------------------------------------------------------
// Efeitos (limite diario no backend; admin sem limite; coracao e separado)
// --------------------------------------------------------------------------
export function triggerEffect({ roomId, userId, effectId, clientEventId = null }) {
  const room = getRoom(roomId);
  if (!room || room.status !== 'live') throw gone('live_ended', 'Esta LIVE nao esta mais ativa');
  const user = getUserById(userId);
  const effect = get('SELECT * FROM effects WHERE id = ? OR slug = ?', { effectId, slug: effectId });
  if (!effect || !effect.enabled) throw notFound('effect_not_found', 'Efeito nao encontrado');
  const role = get(
    'SELECT role FROM live_participants WHERE room_id = ? AND user_id = ? AND left_at IS NULL',
    { roomId, userId },
  );
  if (!role) throw forbidden('not_in_live', 'Entre na LIVE para usar efeitos');

  // Idempotencia por client_event_id: sem duplicacao de animacao.
  if (clientEventId) {
    const existing = get(
      'SELECT * FROM effect_events WHERE room_id = ? AND user_id = ? AND client_event_id = ?',
      { roomId, userId, clientEventId },
    );
    if (existing) {
      return { duplicate: true, event: existing, effect };
    }
  }

  effectAllowedForUser(user); // lanca 403/429 se excedeu o limite diario

  const now = Date.now();
  const seq = (scalar('SELECT COALESCE(MAX(sequence), 0) AS s FROM effect_events WHERE room_id = ?', { roomId }, 0)) + 1;
  const id = newId('evt');
  transaction(() => {
    run(
      `INSERT INTO effect_events (id, room_id, effect_id, user_id, sequence, client_event_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      { id, roomId, effectId: effect.id, userId, sequence: seq, clientEventId, now },
    );
    run('UPDATE live_rooms SET effect_count = effect_count + 1 WHERE id = ?', { id: roomId });
    recordEffectUsage(user);
  });

  const effectMedia = effect.media_id
    ? get('SELECT bucket, storage_key, meta_json FROM media WHERE id = ?', { mediaId: effect.media_id })
    : null;
  const effectMeta = effectMedia ? safeJson(effectMedia.meta_json) : {};
  // Item 9: o arquivo de som do efeito (o mesmo que `queueEffectSound`
  // registrou). `null` quando o efeito nao tem som - e nesse caso o evento
  // carrega `hasAudio: false`.
  const effectSound = effect.sound_id
    ? get('SELECT bucket, storage_key, meta_json FROM media WHERE id = ?', { mediaId: effect.sound_id })
    : null;
  const effectSoundMeta = effectSound ? safeJson(effectSound.meta_json) : {};
  const alphaReady = Boolean(effect.alpha_ready);
  const catalogItem = EFFECT_CATALOG.find((e) => e.slug === effect.slug);

  const payload = {
    eventId: id,
    roomId,
    sequence: seq,
    effect: {
      id: effect.id,
      slug: effect.slug,
      name: effect.name,
      emoji: effect.emoji,
      mediaUrl: effectMedia
        ? `/api/media/stream?key=${encodeURIComponent(`${effectMedia.bucket}/${effectMedia.storage_key}`)}`
        : null,
      alpha: alphaReady,
      // Quando o arquivo nao tem canal alfa, o cliente remove o fundo por
      // chroma-key na GPU (remocao real, calculada por quadro).
      chromaKey: alphaReady
        ? null
        : (effectMeta.chromaKey || {
          color: catalogItem?.keyMode === 'light' ? 'white' : 'black',
          similarity: 0.22,
          smoothness: 0.1,
        }),
      durationMs: effect.duration_ms,
      position: effect.position,
      scale: effect.scale,
      // Item 9: o SOM do efeito viaja no MESMO evento, para que host e
      // espectadores toquem exatamente o mesmo arquivo no mesmo instante da
      // animacao. Quando `soundUrl` e null, `hasAudio` e false e o cliente nao
      // toca nada - nao se finge som onde nao existe.
      hasAudio: Boolean(effectSound),
      soundUrl: effectSound
        ? `/api/media/stream?key=${encodeURIComponent(`${effectSound.bucket}/${effectSound.storage_key}`)}`
        : null,
      soundDurationMs: effectSoundMeta.durationMs ?? effectSoundMeta.duration_ms ?? null,
    },
    user: {
      id: user.id,
      username: user.username,
      displayName: user.display_name,
      avatarUrl: avatarUrlForKey(user.avatar_key, user.avatar_version),
    },
    at: now,
  };
  // Somente quem esta conectado AGORA recebe: ninguem recebe efeitos antigos.
  hub.publish(topics.live(roomId), EVENTS.EFFECT_TRIGGER, payload);
  return { duplicate: false, event: { id, sequence: seq }, payload };
}

// --------------------------------------------------------------------------
// Moderacao dentro da LIVE
// --------------------------------------------------------------------------
/** Mute temporario: 2, 4, 6 ou 10 minutos (janelas fechadas, sem valor livre). */
export const MODERATOR_WINDOWS = [2, 4, 6, 10];

export function moderateViewer({ roomId, actorId, actorRole, targetUserId, action, minutes = 2 }) {
  const room = getRoom(roomId);
  if (!room) throw notFound('live_not_found', 'LIVE nao encontrada');
  if (room.host_id !== actorId && actorRole === 'user') {
    throw forbidden('not_live_host', 'Somente o anfitriao ou a moderacao pode agir nesta LIVE');
  }
  if (targetUserId === room.host_id) {
    throw forbidden('cannot_moderate_host', 'Nao e possivel moderar o anfitriao');
  }
  if (action === 'mute') {
    const value = MODERATOR_WINDOWS.includes(Number(minutes)) ? Number(minutes) : MODERATOR_WINDOWS[0];
    const until = Date.now() + value * 60 * 1000;
    // Mute temporario registrado em `mutes` (bloqueia comentario, DM e perfil).
    run(
      `INSERT INTO mutes (user_id, target_type, target_id, created_at) VALUES (?, 'user', ?, ?)`,
      { userId: targetUserId, targetId: actorId, ts: Date.now() },
    );
    hub.publishToUser(targetUserId, EVENTS.MODERATION, { action: 'muted', roomId, minutes: value, until });
    return { muted: true, minutes: value, until };
  }
  if (action === 'remove') {
    const result = leaveRoom({ roomId, userId: targetUserId, reason: 'removed_by_host' });
    hub.publishToUser(targetUserId, EVENTS.MODERATION, { action: 'removed', roomId });
    return result;
  }
  if (action === 'ban') {
    run(
      'INSERT OR IGNORE INTO blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)',
      { blockerId: room.host_id, blockedId: targetUserId, ts: Date.now() },
    );
    run('DELETE FROM follows WHERE (follower_id = ? AND followee_id = ?) OR (follower_id = ? AND followee_id = ?)', {
      a1: room.host_id, b1: targetUserId, a2: targetUserId, b2: room.host_id,
    });
    const result = leaveRoom({ roomId, userId: targetUserId, reason: 'banned' });
    hub.publishToUser(targetUserId, EVENTS.MODERATION, { action: 'banned', roomId });
    return result;
  }
  throw badRequest('invalid_moderation_action', `Acao invalida: ${action}`);
}

// --------------------------------------------------------------------------
// ICE
// --------------------------------------------------------------------------
export function iceServers({ rotulo = 'app' } = {}) {
  // Item 3: as credenciais do TURN sao geradas AQUI, com expiracao, quando ha
  // `TURN_SECRET`. O segredo compartilhado nunca sai do servidor; sem ele, o
  // modo estatico (`TURN_USERNAME`/`TURN_CREDENTIAL`) continua disponivel.
  const turn = servidoresTurnComCredencial({ rotulo, ttlSegundos: config.turnTtlSeconds });
  return {
    iceServers: [{ urls: config.stunUrls }],
    turnServers: turn,
    turnConfigured: turn.length > 0,
    // Como a credencial foi emitida. O diagnostico da LIVE usa isto para dizer
    // "credencial efemera" ou "credencial estatica" sem mentir sobre seguranca.
    turnCredentialMode: turn.length ? turn[0].modo : 'nenhum',
    // Quando a credencial efemera expira (epoch ms). 0 = sem expiracao (modo
    // estatico). O cliente nao precisa usar isso, mas o diagnostico mostra.
    turnExpiresAt: turn.length ? turn[0].expiresAt : 0,
    // Rotulos das URLs (sem usuario/senha) para o diagnostico da LIVE: e util
    // saber se o relay e UDP ou TLS sem expor a credencial em nenhum lugar.
    turnTransports: turn.map((t) => t.urls[0].replace(/:\d+.*$/, ':port')),
  };
}

export function liveConfig() {
  return {
    iceServers: iceServers(),
    maxViewers: config.liveMaxViewers,
    maxPeers: config.liveMaxPeers,
    effectDailyLimit: config.effectDailyLimit,
    moderatorWindows: MODERATOR_WINDOWS,
  };
}

// --------------------------------------------------------------------------
// Serializacao
// --------------------------------------------------------------------------
export function serializeRoom(room, { includeMessages = false } = {}) {
  if (!room) return null;
  const host = getUserById(room.host_id);
  const live = room.status === 'live';
  return {
    id: room.id,
    title: room.title ?? '',
    category: room.category ?? 'geral',
    status: room.status,
    startedAt: room.started_at,
    endedAt: room.ended_at ?? null,
    viewerCount: viewerCount(room.id),
    peakViewers: room.peak_viewers ?? 0,
    heartCount: heartCount(room.id),
    commentCount: room.comment_count ?? 0,
    effectCount: room.effect_count ?? 0,
    // Preferencia de rotacao do quadro (0, 90 ou 270). Vai junto para quem
    // entra no MEIO da LIVE: o anuncio do realtime e em tempo real e nao
    // alcanca quem ainda nao estava na sala.
    videoRotation: room.video_rotation ?? 0,
    host: publicUser(host),
    isLive: live,
    coverUrl: room.cover_media_id
      ? (() => {
        const m = get('SELECT bucket, storage_key FROM media WHERE id = ?', { mediaId: room.cover_media_id });
        return m ? `/api/media/stream?key=${encodeURIComponent(`${m.bucket}/${m.storage_key}`)}` : null;
      })()
      : null,
    messages: includeMessages ? listLiveMessages({ roomId: room.id, limit: 40 }) : undefined,
  };
}

export function discoverLive({ viewer, limit = 30 }) {
  const rows = all(
    `SELECT * FROM live_rooms WHERE status = 'live' ORDER BY started_at DESC LIMIT :limit`,
    { limit },
  );
  return rows
    .filter((room) => canJoinLive(room, viewer))
    .map((room) => serializeRoom(room));
}

export function activeLiveDirectory({ viewer } = {}) {
  const heartbeatCutoff = Date.now() - HOST_PRESENCE_TIMEOUT_MS;
  const rows = all(
    `SELECT r.id, r.host_id, r.started_at, r.status,
            COUNT(DISTINCT CASE WHEN p.left_at IS NULL AND p.role <> 'host' THEN p.user_id END) AS viewer_count
       FROM live_rooms r
       LEFT JOIN live_participants p ON p.room_id = r.id
      WHERE r.status = 'live'
        AND r.last_host_heartbeat > :heartbeatCutoff
      GROUP BY r.id
      ORDER BY r.started_at DESC`,
    { heartbeatCutoff },
  );
  return rows.filter((room) => canJoinLive(room, viewer)).map((room) => {
    const user = publicUser(getUserById(room.host_id), viewer);
    return {
      id: room.id,
      status: 'live',
      startedAt: room.started_at,
      viewerCount: Number(room.viewer_count) || 0,
      host: user ? {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
      } : null,
    };
  });
}

export function followHostsOfLive(viewerId) {
  const rows = all(
    `SELECT r.* FROM live_rooms r
      WHERE r.status = 'live'
        AND EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = :viewerId AND f.followee_id = r.host_id AND f.status = 'accepted')
        AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = :viewerId AND b.blocked_id = r.host_id) OR (b.blocker_id = r.host_id AND b.blocked_id = :viewerId))
      ORDER BY r.started_at DESC`,
    { viewerId },
  );
  return rows.map((room) => serializeRoom(room));
}

export function purgeEndedRooms(olderThanMs = 24 * 60 * 60 * 1000) {
  return run(
    "DELETE FROM live_rooms WHERE status = 'ended' AND ended_at < ?",
    { ts: Date.now() - olderThanMs },
  ).changes;
}

function safeJson(json) {
  try { return JSON.parse(json || '{}'); } catch { return {}; }
}
