import router from '../router.js';
import { endpoint } from '../middleware.js';
import { writeJson } from '../http.js';
import * as v from '../lib/validate.js';
import { get, run } from '../db/index.js';
import { notFound, forbidden, badRequest } from '../lib/errors.js';
import hub from '../realtime/hub.js';
import { EVENTS } from '../realtime/protocol.js';
import {
  listConversations, findOrCreateConversation, sendMessage, listMessages,
  markConversationRead, deleteMessage, totalUnread,
  sendGlobalMessage, listGlobalMessages, deleteGlobalMessage, MESSAGE_TYPES,
} from '../domain/messaging.js';
import { getUserById, publicUser } from '../domain/users.js';
import { getPost } from '../domain/posts.js';
import { readSingleFile } from './auth.js';
import { saveUpload } from '../media/upload.js';

// --------------------------------------------------------------------------
// Conversas
// --------------------------------------------------------------------------
router.get('/api/conversations', endpoint(async (ctx, res) => {
  const { limit, offset } = v.pagination(ctx.query, { defaultLimit: 50, maxLimit: 100 });
  writeJson(res, 200, {
    conversations: listConversations({ userId: ctx.user.id, limit, offset }),
    unreadTotal: totalUnread(ctx.user.id),
  });
}), { auth: true });

router.post('/api/conversations', endpoint(async (ctx, res) => {
  const target = v.id(ctx.body.userId, { field: 'userId' });
  if (!getUserById(target)) throw notFound('user_not_found', 'Usuario nao encontrado');
  const conversationId = findOrCreateConversation({ userA: ctx.user.id, userB: target });
  writeJson(res, 200, { conversationId });
}), { auth: true, rate: 'write' });

router.get('/api/conversations/:id', endpoint(async (ctx, res) => {
  const conversationId = v.id(ctx.params.id, { field: 'id' });
  const conversation = get('SELECT * FROM conversations WHERE id = ?', { id: conversationId });
  if (!conversation) throw notFound('conversation_not_found', 'Conversa nao encontrada');
  const member = get('SELECT * FROM conversation_members WHERE conversation_id = ? AND user_id = ?', { conversationId, userId: ctx.user.id });
  if (!member) throw forbidden('not_conversation_member', 'Voce nao faz parte desta conversa');
  const other = get(
    `SELECT u.* FROM conversation_members m JOIN users u ON u.id = m.user_id
      WHERE m.conversation_id = ? AND m.user_id <> ?`,
    { conversationId, userId: ctx.user.id },
  );
  const { limit } = v.pagination(ctx.query, { defaultLimit: 50, maxLimit: 100 });
  const before = ctx.query.before ? Number(ctx.query.before) : null;
  writeJson(res, 200, {
    conversation: {
      id: conversation.id,
      createdAt: conversation.created_at,
      muted: Boolean(member.muted),
      participant: publicUser(other, ctx.user),
    },
    messages: listMessages({ conversationId, userId: ctx.user.id, limit, before }),
  });
}), { auth: true });

router.get('/api/conversations/:id/messages', endpoint(async (ctx, res) => {
  const conversationId = v.id(ctx.params.id, { field: 'id' });
  const { limit } = v.pagination(ctx.query, { defaultLimit: 50, maxLimit: 100 });
  const before = ctx.query.before ? Number(ctx.query.before) : null;
  writeJson(res, 200, {
    messages: listMessages({ conversationId, userId: ctx.user.id, limit, before }),
  });
}), { auth: true });

router.post('/api/conversations/:id/messages', endpoint(async (ctx, res) => {
  const conversationId = v.id(ctx.params.id, { field: 'id' });
  const type = v.oneOf(ctx.body.type ?? 'text', MESSAGE_TYPES, { field: 'type', fallback: 'text' });
  const body = v.plainText(ctx.body.body ?? '', { field: 'body', max: 4000, required: false });
  const replyToId = ctx.body.replyToId ? v.id(ctx.body.replyToId, { field: 'replyToId' }) : null;
  const repostPostId = ctx.body.repostPostId ? v.id(ctx.body.repostPostId, { field: 'repostPostId' }) : null;
  const effectId = ctx.body.effectId ? v.id(ctx.body.effectId, { field: 'effectId' }) : null;
  const clientEventId = ctx.body.clientEventId ? v.str(ctx.body.clientEventId, { field: 'clientEventId', max: 64 }) : null;

  if (repostPostId && !getPost(repostPostId)) throw notFound('repost_target_missing', 'Conteudo nao encontrado');

  const message = sendMessage({
    conversationId, senderId: ctx.user.id, type, body,
    mediaId: ctx.body.mediaId ? v.id(ctx.body.mediaId, { field: 'mediaId' }) : null,
    repostPostId, replyToId, effectId, clientEventId,
    metadata: ctx.body.metadata && typeof ctx.body.metadata === 'object' ? ctx.body.metadata : {},
  });
  writeJson(res, 201, { message });
}), { auth: true, rate: 'chat' });

router.post('/api/conversations/:id/read', endpoint(async (ctx, res) => {
  const conversationId = v.id(ctx.params.id, { field: 'id' });
  writeJson(res, 200, markConversationRead({ conversationId, userId: ctx.user.id }));
}), { auth: true, rate: 'write' });

router.delete('/api/messages/:id', endpoint(async (ctx, res) => {
  const messageId = v.id(ctx.params.id, { field: 'id' });
  const message = get('SELECT conversation_id FROM messages WHERE id = ?', { id: messageId });
  deleteMessage({ messageId, userId: ctx.user.id, actorRole: 'user' });
  if (message) {
    hub.publishToUser(ctx.user.id, EVENTS.MESSAGE, { deleted: true, id: messageId, conversationId: message.conversation_id });
  }
  writeJson(res, 200, { ok: true });
}), { auth: true, rate: 'write' });

router.post('/api/conversations/:id/mute', endpoint(async (ctx, res) => {
  const conversationId = v.id(ctx.params.id, { field: 'id' });
  const muted = v.bool(ctx.body.muted, true);
  const member = get('SELECT 1 AS ok FROM conversation_members WHERE conversation_id = ? AND user_id = ?', { conversationId, userId: ctx.user.id });
  if (!member) throw forbidden('not_conversation_member', 'Voce nao faz parte desta conversa');
  run('UPDATE conversation_members SET muted = ? WHERE conversation_id = ? AND user_id = ?', {
    muted: muted ? 1 : 0, conversationId, userId: ctx.user.id,
  });
  writeJson(res, 200, { muted });
}), { auth: true, rate: 'write' });

// --------------------------------------------------------------------------
// Importacao de GIF oficial do GIPHY (o servidor baixa e persiste no storage)
// --------------------------------------------------------------------------
router.post('/api/chat/gif', endpoint(async (ctx, res) => {
  const { assertConfigured, fetchGifBytes } = await import('../domain/giphy.js');
  assertConfigured();
  const url = v.str(ctx.body.url, { field: 'url', min: 8, max: 1000 });
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw badRequest('invalid_gif_url', 'URL do GIF invalida');
  }
  // Somente hosts oficiais do GIPHY (evita SSRF e conteudo de terceiros)
  const allowedHosts = ['media.giphy.com', 'media0.giphy.com', 'media1.giphy.com',
    'media2.giphy.com', 'media3.giphy.com', 'media4.giphy.com', 'i.giphy.com'];
  if (parsed.protocol !== 'https:' || !allowedHosts.includes(parsed.hostname)) {
    throw badRequest('gif_host_not_allowed', 'Somente URLs oficiais do GIPHY sao aceitas');
  }
  const bytes = await fetchGifBytes(parsed.toString());
  const saved = await saveUpload({
    ownerId: ctx.user.id,
    category: 'image',
    buffer: bytes,
    declaredMime: 'image/gif',
    originalName: 'giphy.gif',
    bucket: 'chat',
    purpose: 'chat',
  });
  writeJson(res, 201, {
    // Contrato explicito (item 2): `media.id` e `media.url` sao garantidos
    // aqui, sem depender de o `saveUpload` espalhar campos. O frontend le
    // `result.media.id` em varios lugares e um `mediaId` sem `id` ja fez o
    // audio gravado falhar com "o servidor nao devolveu o arquivo".
    media: {
      id: saved.mediaId,
      mediaId: saved.mediaId,
      bucket: saved.bucket,
      key: saved.key,
      mime: saved.mime,
      size: saved.size,
      width: saved.width,
      height: saved.height,
      durationMs: saved.durationMs,
      status: saved.status,
      originalName: saved.originalName,
      url: `/api/media/stream?key=${encodeURIComponent(`${saved.bucket}/${saved.key}`)}`,
    },
  });
}), { auth: true, rate: 'upload' });

// --------------------------------------------------------------------------
// Chat global
// --------------------------------------------------------------------------
router.get('/api/chat/global', endpoint(async (ctx, res) => {
  const { limit } = v.pagination(ctx.query, { defaultLimit: 40, maxLimit: 100 });
  const before = ctx.query.before ? Number(ctx.query.before) : null;
  const messages = listGlobalMessages({ limit, before });
  writeJson(res, 200, {
    messages,
    // Somente contagem: a lista de nomes online nao e exposta.
    onlineCount: ctx.user ? hub.onlineCountForTopic('global-chat') : 0,
  });
}));

router.post('/api/chat/global', endpoint(async (ctx, res) => {
  const type = v.oneOf(ctx.body.type ?? 'text', MESSAGE_TYPES, { field: 'type', fallback: 'text' });
  const body = v.plainText(ctx.body.body ?? '', { field: 'body', max: 2000, required: false });
  const message = sendGlobalMessage({
    userId: ctx.user.id,
    type,
    body,
    mediaId: ctx.body.mediaId ? v.id(ctx.body.mediaId, { field: 'mediaId' }) : null,
    repostPostId: ctx.body.repostPostId ? v.id(ctx.body.repostPostId, { field: 'repostPostId' }) : null,
    effectId: ctx.body.effectId ? v.id(ctx.body.effectId, { field: 'effectId' }) : null,
    clientEventId: ctx.body.clientEventId ? v.str(ctx.body.clientEventId, { field: 'clientEventId', max: 64 }) : null,
    metadata: ctx.body.metadata && typeof ctx.body.metadata === 'object' ? ctx.body.metadata : {},
  });
  writeJson(res, 201, { message });
}), { auth: true, rate: 'chat' });

router.delete('/api/chat/global/:id', endpoint(async (ctx, res) => {
  const messageId = v.id(ctx.params.id, { field: 'id' });
  writeJson(res, 200, deleteGlobalMessage({ messageId, userId: ctx.user.id, actorRole: 'user' }));
}), { auth: true, rate: 'write' });

router.get('/api/chat/online', endpoint(async (ctx, res) => {
  writeJson(res, 200, {
    onlineCount: hub.onlineCountForTopic('global-chat'),
    connections: hub.stats(),
  });
}));

// --------------------------------------------------------------------------
// Upload de midia para chat (imagem, video, audio, arquivo, GIF)
// --------------------------------------------------------------------------
router.post('/api/chat/upload', endpoint(async (ctx, res) => {
  const purpose = v.oneOf(ctx.query.purpose, ['image', 'video', 'audio', 'file'], { field: 'purpose' });
  const { buffer, contentType, filename } = await readSingleFile(ctx, [purpose]);
  const bucket = { image: 'chat', video: 'chat', audio: 'chat', file: 'attachments' }[purpose];
  const saved = await saveUpload({
    ownerId: ctx.user.id, category: purpose, buffer, declaredMime: contentType,
    originalName: filename, bucket, purpose: 'chat',
  });
  if (purpose === 'video') {
    const { queueVideoProcessing } = await import('../media/upload.js');
    queueVideoProcessing({ mediaId: saved.mediaId, buffer, ownerId: ctx.user.id });
  }
  writeJson(res, 201, {
    // Contrato explicito (item 2): `media.id` e `media.url` sao garantidos
    // aqui, sem depender de o `saveUpload` espalhar campos. O frontend le
    // `result.media.id` em varios lugares e um `mediaId` sem `id` ja fez o
    // audio gravado falhar com "o servidor nao devolveu o arquivo".
    media: {
      id: saved.mediaId,
      mediaId: saved.mediaId,
      bucket: saved.bucket,
      key: saved.key,
      mime: saved.mime,
      size: saved.size,
      width: saved.width,
      height: saved.height,
      durationMs: saved.durationMs,
      status: saved.status,
      originalName: saved.originalName,
      url: `/api/media/stream?key=${encodeURIComponent(`${saved.bucket}/${saved.key}`)}`,
    },
  });
}), { auth: true, rate: 'upload' });
