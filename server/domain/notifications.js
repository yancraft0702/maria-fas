import { all, run, scalar } from '../db/index.js';
import { newId } from '../lib/ids.js';
import hub from '../realtime/hub.js';
import { EVENTS } from '../realtime/protocol.js';
import { getUserById, publicUser, isMuted, getNotificationSettings, assertSettingsExist } from './users.js';
import { blockedEitherWay } from './users.js';
import { sendPush } from '../push.js';

const SETTING_BY_TYPE = {
  like: 'likes',
  comment_like: 'likes',
  comment: 'comments',
  reply: 'replies',
  follow: 'follows',
  follow_request: 'follows',
  follow_accepted: 'follows',
  mention: 'mentions',
  repost: 'reposts',
  message: 'messages',
  live_comment: 'lives',
  live_start: 'lives',
  story_reply: 'activity',
  system: 'activity',
  activity: 'activity',
  warning: 'activity',
};

/**
 * Cria notificacao + emite evento realtime + envia push.
 * Respeita configuracao do destinatario, silenciamento e bloqueios.
 */
export function createNotification({
  userId, actorId = null, type, entityType = '', entityId = '', body = '', payload = {},
}) {
  if (!userId) return null;
  if (actorId && actorId === userId) return null;
  assertSettingsExist(userId);
  const settings = getNotificationSettings(userId);
  const settingKey = SETTING_BY_TYPE[type];
  if (settingKey && settings && settings[settingKey] === 0) return null;
  if (actorId) {
    if (blockedEitherWay(actorId, userId)) return null;
    const actor = getUserById(actorId);
    if (!actor || actor.status === 'banned' || actor.status === 'deleted') return null;
    if (isMuted(userId, 'user', actorId)) return null;
  }

  const id = newId('ntf');
  run(
    `INSERT INTO notifications (id, user_id, actor_id, type, entity_type, entity_id, body, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    { id, userId, actorId, type, entityType, entityId, body, payloadJson: JSON.stringify(payload), now: Date.now() },
  );

  const actor = actorId ? getUserById(actorId) : null;
  const notification = {
    id,
    type,
    entityType,
    entityId,
    body,
    createdAt: Date.now(),
    read: false,
    actor: actor ? publicUser(actor) : null,
    payload,
  };
  hub.publishToUser(userId, EVENTS.NOTIFICATION, { notification });
  if (settings?.push_enabled) {
    sendPush({
      userId,
      title: actor ? `@${actor.username}` : 'MARIA FÃS',
      body: notificationText(type, body),
      url: deepLinkFor(type, entityType, entityId),
      tag: `${type}:${entityId || id}`,
    }).catch(() => { /* push e best-effort: erro nunca quebra a acao */ });
  }
  return notification;
}

function notificationText(type, body) {
  const prefix = {
    like: 'curtiu seu video',
    comment_like: 'curtiu seu comentario',
    comment: 'comentou no seu video',
    reply: 'respondeu seu comentario',
    follow: 'comecou a te seguir',
    follow_request: 'solicitou te seguir',
    follow_accepted: 'aceitou seu pedido',
    mention: 'mencionou voce',
    repost: 'repostou seu video',
    message: 'enviou uma mensagem',
    live_start: 'iniciou uma LIVE',
    warning: 'recebeu um aviso da moderação',
  }[type];
  return prefix ? `${prefix}${body ? `: ${body.slice(0, 80)}` : ''}` : body.slice(0, 120);
}

function deepLinkFor(type, entityType, entityId) {
  if (entityType === 'post') return `/videos/${entityId}`;
  if (entityType === 'comment') return `/notifications`;
  if (entityType === 'conversation') return `/inbox/${entityId}`;
  if (entityType === 'live') return `/live/${entityId}`;
  return '/notifications';
}

export function listNotifications({ userId, limit = 40, offset = 0 }) {
  const rows = all(
    `SELECT * FROM notifications WHERE user_id = :userId ORDER BY created_at DESC LIMIT :limit OFFSET :offset`,
    { userId, limit, offset },
  );
  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    entityType: row.entity_type,
    entityId: row.entity_id,
    body: row.body,
    createdAt: row.created_at,
    read: Boolean(row.read_at),
    actor: row.actor_id ? publicUser(getUserById(row.actor_id)) : null,
    payload: safeJson(row.payload_json),
  }));
}

export function unreadCount(userId) {
  return scalar('SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND read_at IS NULL', { userId }, 0);
}

export function markRead({ userId, notificationId = null, all = false }) {
  if (all) {
    run('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL', { ts: Date.now(), userId });
  } else if (notificationId) {
    run('UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL', {
      ts: Date.now(), id: notificationId, userId,
    });
  }
  const count = unreadCount(userId);
  hub.publishToUser(userId, EVENTS.COUNTS, { notifications: count });
  return { unread: count };
}

export function deleteNotification({ userId, notificationId }) {
  run('DELETE FROM notifications WHERE id = ? AND user_id = ?', { id: notificationId, userId });
  return { deleted: true, unread: unreadCount(userId) };
}

function safeJson(json) {
  try { return JSON.parse(json || '{}'); } catch { return {}; }
}

export function updateNotificationSettings(userId, changes) {
  assertSettingsExist(userId);
  const allowed = ['likes', 'comments', 'replies', 'follows', 'mentions', 'reposts', 'messages', 'lives', 'activity', 'push_enabled'];
  const sets = [];
  const params = { userId, ts: Date.now() };
  for (const key of allowed) {
    if (changes[key] !== undefined) {
      sets.push(`${key} = ?`);
      params[key] = changes[key] ? 1 : 0;
    }
  }
  if (sets.length) {
    run(`UPDATE notification_settings SET ${sets.join(', ')}, updated_at = ? WHERE user_id = ?`, params);
  }
  return getNotificationSettings(userId);
}
