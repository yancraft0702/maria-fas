import { all, get, run, transaction, scalar } from '../db/index.js';
import { newId } from '../lib/ids.js';
import { notFound, forbidden, badRequest } from '../lib/errors.js';
import {
  getUserById, publicUser, isMuted, blockedEitherWay, resolveMentionedUsers,
} from './users.js';
import { canMessage } from './privacy.js';
import hub from '../realtime/hub.js';
import { EVENTS, topics } from '../realtime/protocol.js';
import { createNotification } from './notifications.js';

export const MESSAGE_TYPES = ['text', 'emoji', 'gif', 'sticker', 'image', 'video', 'audio', 'file', 'repost', 'effect', 'system'];

// --------------------------------------------------------------------------
// Conversas 1:1
// --------------------------------------------------------------------------
export function findOrCreateConversation({ userA, userB }) {
  if (userA === userB) throw badRequest('cannot_dm_self', 'Nao e possivel conversar consigo mesmo');
  if (!canMessage(userA, userB)) {
    throw forbidden('dm_not_allowed', 'Esta conta nao permite receber mensagens');
  }
  const existing = get(
    `SELECT c.id FROM conversations c
       JOIN conversation_members m1 ON m1.conversation_id = c.id AND m1.user_id = :userA
       JOIN conversation_members m2 ON m2.conversation_id = c.id AND m2.user_id = :userB
      LIMIT 1`,
    { userA, userB },
  );
  if (existing) return existing.id;
  const id = newId('cnv');
  const now = Date.now();
  transaction(() => {
    run('INSERT INTO conversations (id, created_at, updated_at) VALUES (?, ?, ?)', {
      id,
      createdAt: now,
      updatedAt: now,
    });
    run('INSERT INTO conversation_members (conversation_id, user_id, joined_at) VALUES (?, ?, ?)', { id, userId: userA, now });
    run('INSERT INTO conversation_members (conversation_id, user_id, joined_at) VALUES (?, ?, ?)', { id, userId: userB, now });
  });
  return id;
}

export function getConversationForUser(conversationId, userId) {
  const row = get('SELECT * FROM conversations WHERE id = ?', { conversationId });
  if (!row) throw notFound('conversation_not_found', 'Conversa nao encontrada');
  const member = get('SELECT * FROM conversation_members WHERE conversation_id = ? AND user_id = ?', { conversationId, userId });
  if (!member) throw forbidden('not_conversation_member', 'Voce nao faz parte desta conversa');
  const other = get(
    `SELECT u.* FROM conversation_members m JOIN users u ON u.id = m.user_id
      WHERE m.conversation_id = ? AND m.user_id <> ?`,
    { conversationId, userId },
  );
  return { conversation: row, member, other };
}

export function listConversations({ userId, limit = 50, offset = 0 }) {
  const rows = all(
    `SELECT c.id, c.updated_at, c.last_message_id,
            m.last_read_message_id AS lastRead, m.muted,
            o.id AS other_id, o.username AS other_username, o.display_name AS other_display_name,
            o.avatar_key AS other_avatar, o.avatar_version AS other_avatar_version, o.status AS other_status,
            lm.created_at AS last_message_at, lm.body AS last_message_body, lm.type AS last_message_type,
            lm.sender_id AS last_message_sender,
            (SELECT COUNT(*) FROM messages msg
               WHERE msg.conversation_id = c.id AND msg.created_at > COALESCE(m.last_read_at, 0)
                 AND msg.sender_id <> :userId) AS unread
       FROM conversations c
       JOIN conversation_members m ON m.conversation_id = c.id AND m.user_id = :userId
       JOIN conversation_members om ON om.conversation_id = c.id AND om.user_id <> :userId
       JOIN users o ON o.id = om.user_id
       LEFT JOIN messages lm ON lm.id = c.last_message_id
      ORDER BY COALESCE(lm.created_at, c.created_at) DESC
      LIMIT :limit OFFSET :offset`,
    { userId, limit, offset },
  );
  return rows.map((row) => ({
    id: row.id,
    updatedAt: row.updated_at,
    unread: row.unread ?? 0,
    muted: Boolean(row.muted),
    lastMessage: row.last_message_id
      ? {
        id: row.last_message_id,
        body: row.last_message_body ?? '',
        type: row.last_message_type,
        senderId: row.last_message_sender,
        createdAt: row.last_message_at,
      }
      : null,
    participant: publicUser(getUserById(row.other_id), getUserById(userId)),
  }));
}

export function sendMessage({ conversationId, senderId, type = 'text', body = '', mediaId = null, repostPostId = null, replyToId = null, effectId = null, metadata = {}, clientEventId = null }) {
  const { other } = getConversationForUser(conversationId, senderId);
  if (!MESSAGE_TYPES.includes(type)) throw badRequest('invalid_message_type', `Tipo de mensagem invalido: ${type}`);
  if (blockedEitherWay(senderId, other.id)) throw forbidden('dm_blocked', 'Nao e possivel enviar mensagens');
  if (isMuted(senderId, 'user', other.id)) throw forbidden('dm_muted_user', 'Voce silenciou este usuario');
  if (type !== 'system' && !body && !mediaId && !repostPostId && !effectId) {
    throw badRequest('empty_message', 'Mensagem vazia');
  }

  // Idempotencia: mesmo clientEventId nao cria duplicata.
  if (clientEventId) {
    const existing = get(
      'SELECT * FROM messages WHERE conversation_id = ? AND sender_id = ? AND client_event_id = ?',
      { conversationId, senderId, clientEventId },
    );
    if (existing) return serializeMessage(existing, senderId, other.id);
  }

  const id = newId('msg');
  const now = Date.now();
  transaction(() => {
    run(
      `INSERT INTO messages (id, conversation_id, sender_id, type, body, media_id, repost_post_id,
         reply_to_id, effect_id, metadata_json, created_at, client_event_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      {
        id, conversationId, senderId, type, body, mediaId, repostPostId, replyToId, effectId,
        metadataJson: JSON.stringify(metadata || {}), now, clientEventId,
      },
    );
    run('UPDATE conversations SET last_message_id = ?, updated_at = ? WHERE id = ?', { id, ts: now, id2: conversationId });
    run('UPDATE conversation_members SET last_read_message_id = ?, last_read_at = ? WHERE conversation_id = ? AND user_id = ?', {
      id, now, conversationId, userId: senderId,
    });
    run('INSERT OR IGNORE INTO message_reads (message_id, user_id, read_at) VALUES (?, ?, ?)', { messageId: id, userId: senderId, now });
  });

  const message = serializeMessage(get('SELECT * FROM messages WHERE id = ?', { id }), senderId, other.id);
  // DM e' privado: fanout apenas nos topicos pessoais dos dois membros.
  hub.publishToUser(senderId, EVENTS.MESSAGE, { message, conversationId });
  hub.publishToUser(other.id, EVENTS.MESSAGE, { message, conversationId });
  hub.publishToUser(senderId, EVENTS.COUNTS, { messages: totalUnread(senderId) });

  if (!isMuted(other.id, 'user', senderId)) {
    createNotification({
      userId: other.id, actorId: senderId, type: 'message',
      entityType: 'conversation', entityId: conversationId, body: previewOf(message),
    });
  }
  return message;
}

function previewOf(message) {
  if (message.text) return message.text.slice(0, 80);
  if (message.media) return `[${message.media.kind}]`;
  if (message.repost) return 'repostou um video';
  return 'nova mensagem';
}

export function totalUnread(userId) {
  return scalar(
    `SELECT COUNT(*) AS c FROM messages msg
       JOIN conversation_members m ON m.conversation_id = msg.conversation_id AND m.user_id = :userId
      WHERE msg.created_at > COALESCE(m.last_read_at, 0) AND msg.sender_id <> :userId
        AND msg.status = 'sent'`,
    { userId },
    0,
  );
}

export function listMessages({ conversationId, userId, limit = 50, before = null }) {
  getConversationForUser(conversationId, userId);
  const params = { conversationId, userId, limit };
  let cursorFilter = '';
  if (before) {
    cursorFilter = 'AND created_at < :before';
    params.before = before;
  }
  const rows = all(
    `SELECT * FROM messages WHERE conversation_id = :conversationId ${cursorFilter}
      ORDER BY created_at DESC LIMIT :limit`,
    params,
  );
  const messages = rows.reverse().map((row) => serializeMessage(row, userId));
  markConversationRead({ conversationId, userId });
  return messages;
}

export function markConversationRead({ conversationId, userId }) {
  const rows = all(
    `SELECT m.id FROM messages m
      WHERE m.conversation_id = :conversationId AND m.sender_id <> :userId AND m.status = 'sent'
        AND m.created_at > COALESCE((SELECT last_read_at FROM conversation_members WHERE conversation_id = :conversationId AND user_id = :userId), 0)`,
    { conversationId, userId },
  );
  if (!rows.length) return { read: 0 };
  const now = Date.now();
  transaction(() => {
    for (const row of rows) {
      run('INSERT OR IGNORE INTO message_reads (message_id, user_id, read_at) VALUES (?, ?, ?)', {
        messageId: row.id, userId, now,
      });
    }
    const last = get('SELECT id FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1', { conversationId });
    run('UPDATE conversation_members SET last_read_at = ?, last_read_message_id = ? WHERE conversation_id = ? AND user_id = ?', {
      now, id: last?.id ?? null, conversationId, userId,
    });
  });
  hub.publish(topics.user(userId), EVENTS.MESSAGE_READ, { conversationId, userId, count: rows.length, at: now });
  hub.publishToUser(userId, EVENTS.COUNTS, { messages: totalUnread(userId) });
  return { read: rows.length };
}

export function deleteMessage({ messageId, userId, actorRole = 'user' }) {
  const message = get('SELECT * FROM messages WHERE id = ?', { id: messageId });
  if (!message) throw notFound('message_not_found', 'Mensagem nao encontrada');
  if (message.sender_id !== userId && actorRole === 'user') {
    throw forbidden('not_message_author', 'Somente o autor pode apagar esta mensagem');
  }
  run("UPDATE messages SET status = 'deleted', body = '', deleted_at = ? WHERE id = ?", { ts: Date.now(), id: messageId });
  return { deleted: true };
}

/** Interlocutor de uma conversa 1:1 (qualquer membro que nao seja o viewer). */
function counterpartOf(conversationId, viewerId) {
  if (!conversationId) return null;
  const row = get(
    'SELECT user_id FROM conversation_members WHERE conversation_id = ? AND user_id <> ? LIMIT 1',
    { conversationId, viewerId },
  );
  return row?.user_id ?? null;
}

export function serializeMessage(message, viewerId = null, otherId = null) {
  if (!message) return null;
  // Sem `otherId` explicito (ex.: ao listar historico), deriva o interlocutor
  // da propria conversa: sem isso o status "lido" nunca apareceria para quem
  // enviou a mensagem.
  const counterpart = otherId ?? counterpartOf(message.conversation_id, viewerId);
  const author = getUserById(message.sender_id);
  const media = message.media_id ? get('SELECT * FROM media WHERE id = ?', { mediaId: message.media_id }) : null;
  const effect = message.effect_id ? get('SELECT * FROM effects WHERE id = ?', { effectId: message.effect_id }) : null;
  const repost = message.repost_post_id ? get('SELECT * FROM posts WHERE id = ?', { id: message.repost_post_id }) : null;
  const readBy = message.status === 'deleted'
    ? []
    : all('SELECT user_id FROM message_reads WHERE message_id = ?', { messageId: message.id }).map((r) => r.user_id);
  const replyTo = message.reply_to_id
    ? (() => {
      const r = get('SELECT id, sender_id, body, type FROM messages WHERE id = ?', { id: message.reply_to_id });
      if (!r || r.status === 'deleted') return null;
      return {
        id: r.id,
        senderId: r.sender_id,
        text: r.body,
        type: r.type,
        author: publicUser(getUserById(r.sender_id)),
      };
    })()
    : null;

  return {
    id: message.id,
    conversationId: message.conversation_id,
    type: message.type,
    text: message.status === 'deleted' ? '' : message.body,
    deleted: message.status === 'deleted',
    createdAt: message.created_at,
    senderId: message.sender_id,
    isMine: viewerId ? message.sender_id === viewerId : false,
    author: publicUser(author),
    media: media
      ? {
        id: media.id,
        kind: media.kind,
        mime: media.mime,
        size: media.size,
        width: media.width ?? 0,
        height: media.height ?? 0,
        durationMs: media.duration_ms ?? 0,
        url: `/api/media/stream?key=${encodeURIComponent(`${media.bucket}/${media.storage_key}`)}`,
        originalName: media.original_name,
      }
      : null,
    repost: repost
      ? {
        id: repost.id,
        caption: repost.caption,
        author: publicUser(getUserById(repost.author_id)),
        mediaUrl: repost.media_id
          ? (() => {
            const m = get('SELECT bucket, storage_key FROM media WHERE id = ?', { mediaId: repost.media_id });
            return m ? `/api/media/stream?key=${encodeURIComponent(`${m.bucket}/${m.storage_key}`)}` : null;
          })()
          : null,
      }
      : null,
    effect: effect ? { id: effect.id, slug: effect.slug, name: effect.name, emoji: effect.emoji } : null,
    metadata: safeJson(message.metadata_json),
    replyTo,
    status: message.status === 'deleted'
      ? 'deleted'
      : (readBy.includes(counterpart) ? 'read' : 'delivered'),
    readBy,
    clientEventId: message.client_event_id ?? null,
  };
}

function safeJson(json) {
  try { return JSON.parse(json || '{}'); } catch { return {}; }
}

// --------------------------------------------------------------------------
// Chat global
// --------------------------------------------------------------------------
export function sendGlobalMessage({ userId, type = 'text', body = '', mediaId = null, repostPostId = null, effectId = null, metadata = {}, clientEventId = null }) {
  if (!MESSAGE_TYPES.includes(type)) throw badRequest('invalid_message_type', `Tipo invalido: ${type}`);
  if (type !== 'system' && !body && !mediaId && !repostPostId && !effectId) {
    throw badRequest('empty_message', 'Mensagem vazia');
  }
  if (clientEventId) {
    const existing = get('SELECT * FROM global_chat WHERE user_id = ? AND client_event_id = ?', { userId, clientEventId });
    if (existing) return serializeGlobalMessage(existing, userId);
  }
  const id = newId('gch');
  const now = Date.now();
  run(
    `INSERT INTO global_chat (id, user_id, type, body, media_id, repost_post_id, effect_id, metadata_json, created_at, client_event_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    { id, userId, type, body, mediaId, repostPostId, effectId, metadataJson: JSON.stringify(metadata || {}), now, clientEventId },
  );
  const message = serializeGlobalMessage(get('SELECT * FROM global_chat WHERE id = ?', { id }), userId);
  hub.publish(topics.globalChat(), EVENTS.GLOBAL_CHAT_MESSAGE, { message });
  for (const mentioned of resolveMentionedUsers(body)) {
    createNotification({ userId: mentioned.id, actorId: userId, type: 'mention', entityType: 'chat', entityId: id, body });
  }
  return message;
}

export function listGlobalMessages({ limit = 40, before = null }) {
  const params = { limit };
  let filter = '';
  if (before) { filter = 'AND created_at < :before'; params.before = before; }
  const rows = all(
    `SELECT * FROM global_chat WHERE status = 'sent' ${filter} ORDER BY created_at DESC LIMIT :limit`,
    params,
  );
  return rows.reverse().map((row) => serializeGlobalMessage(row));
}

export function deleteGlobalMessage({ messageId, userId, actorRole = 'user' }) {
  const message = get('SELECT * FROM global_chat WHERE id = ?', { id: messageId });
  if (!message) throw notFound('message_not_found', 'Mensagem nao encontrada');
  if (message.user_id !== userId && actorRole === 'user') {
    throw forbidden('not_message_author', 'Somente o autor pode apagar esta mensagem');
  }
  run("UPDATE global_chat SET status = 'deleted', body = '', deleted_at = ? WHERE id = ?", { ts: Date.now(), id: messageId });
  hub.publish(topics.globalChat(), EVENTS.GLOBAL_CHAT_DELETE, { id: messageId });
  return { deleted: true };
}

export function serializeGlobalMessage(row, viewerId = null) {
  if (!row) return null;
  const author = getUserById(row.user_id);
  const media = row.media_id ? get('SELECT * FROM media WHERE id = ?', { mediaId: row.media_id }) : null;
  const repost = row.repost_post_id ? get('SELECT * FROM posts WHERE id = ?', { id: row.repost_post_id }) : null;
  const effect = row.effect_id ? get('SELECT * FROM effects WHERE id = ?', { effectId: row.effect_id }) : null;
  return {
    id: row.id,
    type: row.type,
    text: row.status === 'deleted' ? '' : row.body,
    deleted: row.status === 'deleted',
    createdAt: row.created_at,
    userId: row.user_id,
    isMine: viewerId ? row.user_id === viewerId : false,
    author: publicUser(author),
    media: media
      ? {
        id: media.id,
        kind: media.kind,
        mime: media.mime,
        width: media.width ?? 0,
        height: media.height ?? 0,
        size: media.size,
        durationMs: media.duration_ms ?? 0,
        url: `/api/media/stream?key=${encodeURIComponent(`${media.bucket}/${media.storage_key}`)}`,
      }
      : null,
    repost: repost
      ? {
        id: repost.id,
        caption: repost.caption,
        author: publicUser(getUserById(repost.author_id)),
        mediaUrl: repost.media_id
          ? (() => {
            const m = get('SELECT bucket, storage_key FROM media WHERE id = ?', { mediaId: repost.media_id });
            return m ? `/api/media/stream?key=${encodeURIComponent(`${m.bucket}/${m.storage_key}`)}` : null;
          })()
          : null,
      }
      : null,
    effect: effect ? { id: effect.id, slug: effect.slug, emoji: effect.emoji } : null,
    metadata: safeJson(row.metadata_json),
    clientEventId: row.client_event_id ?? null,
  };
}
