import router from '../router.js';
import { endpoint } from '../middleware.js';
import { writeJson } from '../http.js';
import * as v from '../lib/validate.js';
import { get, run, all } from '../db/index.js';
import { notFound, forbidden, badRequest } from '../lib/errors.js';
import hub from '../realtime/hub.js';
import { EVENTS, topics } from '../realtime/protocol.js';
import {
  forYouFeed, followingFeed, friendsFeed, trendingPosts, serializePost, getPost,
  toggleLike, toggleFavorite, countsFor, hidePost, recordShare,
  incrementView, relatedPosts, hashtagPosts, soundPage, createPost, updatePost, deletePost,
} from '../domain/posts.js';
import {
  toggleCommentLike, createComment, listComments, deleteComment, repost, undoRepost, COMMENT_TYPES,
} from '../domain/social.js';
import {
  recordWatchEvent, resetRecommendations, blockCreator,
  updateRecommendationSettings, recommendationSettings,
} from '../domain/recommend.js';
import { createNotification } from '../domain/notifications.js';
import { saveDraft, getDraft, listDrafts, deleteDraft } from '../domain/content.js';
import { canViewPost, canComment, assertCanViewPost } from '../domain/privacy.js';
import { resolveMentionedUsers } from '../domain/users.js';
import { trendingHashtags } from '../domain/search.js';
import { ADMIN_EVENTS, publishAdminEvent, adminActivity } from '../domain/admin-activity.js';

const VISIBILITIES = ['public', 'followers', 'friends', 'private'];
const AUDIENCE = ['everyone', 'followers', 'friends', 'nobody'];

// --------------------------------------------------------------------------
// Feeds
// --------------------------------------------------------------------------
router.get('/api/feed/for-you', endpoint(async (ctx, res) => {
  const { limit, offset } = v.pagination(ctx.query, { defaultLimit: 8, maxLimit: 20 });
  const postId = ctx.query.postId ? v.id(ctx.query.postId, { field: 'postId' }) : null;
  const posts = forYouFeed({ viewer: ctx.user, limit, offset, postId });
  writeJson(res, 200, { feed: 'for_you', posts, nextOffset: offset + limit });
}), { auth: true });

router.get('/api/feed/following', endpoint(async (ctx, res) => {
  if (!ctx.user) throw forbidden('login_required', 'Faca login para ver o feed de quem voce segue');
  const { limit, offset } = v.pagination(ctx.query, { defaultLimit: 8, maxLimit: 20 });
  writeJson(res, 200, { feed: 'following', posts: followingFeed({ viewer: ctx.user, limit, offset }), nextOffset: offset + limit });
}), { auth: true });

router.get('/api/feed/friends', endpoint(async (ctx, res) => {
  if (!ctx.user) throw forbidden('login_required', 'Faca login para ver o feed de amigos');
  const { limit, offset } = v.pagination(ctx.query, { defaultLimit: 8, maxLimit: 20 });
  writeJson(res, 200, { feed: 'friends', posts: friendsFeed({ viewer: ctx.user, limit, offset }), nextOffset: offset + limit });
}), { auth: true });

router.get('/api/feed/explore', endpoint(async (ctx, res) => {
  const limit = v.int(ctx.query.limit, { field: 'limit', min: 1, max: 50, required: false, fallback: 24 });
  writeJson(res, 200, { posts: trendingPosts({ viewer: ctx.user, limit }) });
}));

// --------------------------------------------------------------------------
// Publicacao
// --------------------------------------------------------------------------
router.post('/api/posts', endpoint(async (ctx, res) => {
  // 'live' entrou para o botao REPUBLICAR da LIVE (item 13): o post aponta
  // para a sala em `live_room_id` e o feed mostra o cartao da transmissao.
  // 'audio' entrou no item 16: publicar so um audio e uma publicacao valida.
  // Sem ele, o type enviado caia fora da lista e a validacao respondia
  // "Campo obrigatorio" - mensagem que nao explicava nada.
  const type = v.oneOf(ctx.body.type, ['video', 'image', 'text', 'repost', 'live', 'audio'], { field: 'type' });
  const roomId = ctx.body.roomId ? v.id(ctx.body.roomId, { field: 'roomId' }) : null;
  const caption = v.plainText(ctx.body.caption ?? '', { field: 'caption', max: 2200, required: false });
  const mediaId = ctx.body.mediaId ? v.id(ctx.body.mediaId, { field: 'mediaId' }) : null;
  const repostOfId = ctx.body.repostOfId ? v.id(ctx.body.repostOfId, { field: 'repostOfId' }) : null;
  const soundId = ctx.body.soundId ? v.id(ctx.body.soundId, { field: 'soundId' }) : null;
  const visibility = v.oneOf(ctx.body.visibility ?? 'public', VISIBILITIES, { field: 'visibility', fallback: 'public' });
  const downloadAllowed = v.oneOf(ctx.body.downloadAllowed ?? 'everyone', AUDIENCE, { field: 'downloadAllowed', fallback: 'everyone' });
  const remixAllowed = v.oneOf(ctx.body.remixAllowed ?? 'everyone', AUDIENCE, { field: 'remixAllowed', fallback: 'everyone' });
  const commentsEnabled = v.bool(ctx.body.commentsEnabled, true);
  const duetAllowed = v.bool(ctx.body.duetAllowed, true);
  const location = v.str(ctx.body.location ?? '', { field: 'location', max: 80, required: false });

  if (type === 'repost' && !repostOfId) throw badRequest('repost_required', 'Informe o post original');
  if (type === 'video' && !mediaId) throw badRequest('media_required', 'Informe o arquivo de video');
  // Audio sozinho e conteudo valido; audio sem arquivo, nao.
  if (type === 'audio' && !mediaId) throw badRequest('audio_required', 'Grave ou envie um arquivo de audio');

  // Republicar LIVE: a sala precisa existir e estar no ar. Sem sala valida o
  // post seria um link morto.
  if (type === 'live') {
    if (!roomId) throw badRequest('live_room_required', 'Informe a LIVE para republicar');
    const room = get('SELECT id, status FROM live_rooms WHERE id = ?', { id: roomId });
    if (!room) throw notFound('live_not_found', 'LIVE nao encontrada');
  }

  if (mediaId) {
    const media = get('SELECT * FROM media WHERE id = ?', { id: mediaId });
    if (!media) throw notFound('media_not_found', 'Arquivo nao encontrado');
    if (media.owner_id !== ctx.user.id) throw forbidden('not_media_owner', 'Este arquivo nao e seu');
    if (media.kind !== 'video' && type === 'video') throw badRequest('media_kind_mismatch', 'O arquivo nao e um video');
    if (media.kind !== 'image' && type === 'image') throw badRequest('media_kind_mismatch', 'O arquivo nao e uma imagem');
    // Item 16: o arquivo declarado como audio precisa SER audio. Sem esta
    // checagem dava para publicar um video rotulado como audio.
    if (media.kind !== 'audio' && type === 'audio') throw badRequest('media_kind_mismatch', 'O arquivo nao e um audio');
    if (media.status === 'failed') {
      throw badRequest('media_processing_failed', `Processamento do arquivo falhou: ${media.processing_error || 'motivo desconhecido'}`);
    }
  }
  if (repostOfId) {
    const original = getPost(repostOfId);
    if (!original) throw notFound('repost_target_missing', 'Conteudo original nao encontrado');
    if (!canViewPost(original, ctx.user)) throw forbidden('repost_not_visible', 'Conteudo original indisponivel');
  }
  if (type === 'text' && !caption.trim()) throw badRequest('caption_required', 'Escreva algo para publicar');
  const post = createPost({
    authorId: ctx.user.id, type, caption, mediaId, visibility, commentsEnabled,
    downloadAllowed, remixAllowed, duetAllowed, location, soundId, repostOfId,
    liveRoomId: roomId,
  });

  // Real-time: followers + topic do post + quem tem o autor como following
  const serialized = serializePost(post, ctx.user);
  notifyFollowersOfNewPost(ctx.user.id, serialized);
  // O feed publico recebe apenas o ID. Cada cliente consulta o feed com sua
  // propria sessao para que bloqueios/ocultacoes sejam aplicados antes dos
  // dados do post serem entregues. A query tambem garante visibilidade global.
  publishForYouPost(post);
  // Item 17: o painel administrativo ve a publicacao sem F5.
  publishAdminEvent(ADMIN_EVENTS.VIDEO_CREATED, {
    ...adminActivity(
      'video_created',
      `@${ctx.user.username} publicou ${type === 'video' ? 'um video' : type === 'image' ? 'uma foto' : type === 'text' ? 'um texto' : 'uma republicacao'}`,
    ),
    postId: post.id,
    type,
    username: ctx.user.username,
    caption: caption.slice(0, 80),
  });

  if (repostOfId) {
    const original = get('SELECT * FROM posts WHERE id = ?', { id: repostOfId });
    hub.publish(topics.post(repostOfId), EVENTS.REPOST, { postId: repostOfId, count: countsFor(repostOfId).reposts });
  }
  for (const mentioned of resolveMentionedUsers(caption)) {
    if (mentioned.id === ctx.user.id) continue;
    createNotification({
      userId: mentioned.id, actorId: ctx.user.id, type: 'mention',
      entityType: 'post', entityId: post.id, body: caption,
    });
  }

  writeJson(res, 201, { post: serialized });
}), { auth: true, rate: 'write' });

// --------------------------------------------------------------------------
// Detalhe / listagem
// --------------------------------------------------------------------------
router.get('/api/posts/:id', endpoint(async (ctx, res) => {
  const post = getPost(v.id(ctx.params.id, { field: 'id' }));
  assertCanViewPost(post, ctx.user);
  const repostOf = post.repost_of_id ? get('SELECT * FROM posts WHERE id = ?', { id: post.repost_of_id }) : null;
  writeJson(res, 200, {
    post: serializePost(post, ctx.user, { repostOf }),
    related: relatedPosts(post, ctx.user, 8),
  });
}));

router.patch('/api/posts/:id', endpoint(async (ctx, res) => {
  const id = v.id(ctx.params.id, { field: 'id' });
  const changes = {};
  if (ctx.body.caption !== undefined) changes.caption = v.plainText(ctx.body.caption, { field: 'caption', max: 2200, required: false });
  if (ctx.body.visibility !== undefined) changes.visibility = v.oneOf(ctx.body.visibility, VISIBILITIES, { field: 'visibility' });
  if (ctx.body.commentsEnabled !== undefined) changes.commentsEnabled = v.bool(ctx.body.commentsEnabled);
  if (ctx.body.downloadAllowed !== undefined) changes.downloadAllowed = v.oneOf(ctx.body.downloadAllowed, AUDIENCE, { field: 'downloadAllowed' });
  if (ctx.body.remixAllowed !== undefined) changes.remixAllowed = v.oneOf(ctx.body.remixAllowed, AUDIENCE, { field: 'remixAllowed' });
  if (ctx.body.location !== undefined) changes.location = v.str(ctx.body.location, { field: 'location', max: 80, required: false });
  if (ctx.body.soundId !== undefined) changes.soundId = ctx.body.soundId ? v.id(ctx.body.soundId, { field: 'soundId' }) : null;
  const post = updatePost(id, ctx.user.id, changes);
  const serialized = serializePost(post, ctx.user);
  hub.publish(topics.post(id), EVENTS.POST_UPDATED, { post: serialized });
  writeJson(res, 200, { post: serialized });
}), { auth: true, rate: 'write' });

router.delete('/api/posts/:id', endpoint(async (ctx, res) => {
  const id = v.id(ctx.params.id, { field: 'id' });
  deletePost(id, { actorId: ctx.user.id, actorRole: 'user' });
  hub.publish(topics.post(id), EVENTS.POST_DELETED, { postId: id });
  writeJson(res, 200, { ok: true });
}), { auth: true, rate: 'write' });

// --------------------------------------------------------------------------
// Visualizacao + sinalizacao de consumo
// --------------------------------------------------------------------------
router.post('/api/posts/:id/view', endpoint(async (ctx, res) => {
  const id = v.id(ctx.params.id, { field: 'id' });
  const post = getPost(id);
  assertCanViewPost(post, ctx.user);
  incrementView(id);
  writeJson(res, 200, { ok: true, counts: countsFor(id) });
}));

router.post('/api/posts/:id/share', endpoint(async (ctx, res) => {
  const id = v.id(ctx.params.id, { field: 'id' });
  const post = getPost(id);
  assertCanViewPost(post, ctx.user);
  recordShare(id);
  writeJson(res, 200, { ok: true, counts: countsFor(id) });
}));

router.post('/api/posts/:id/watch', endpoint(async (ctx, res) => {
  const id = v.id(ctx.params.id, { field: 'id' });
  const post = getPost(id);
  assertCanViewPost(post, ctx.user);
  const event = recordWatchEvent({
    userId: ctx.user.id,
    postId: id,
    watchMs: v.num(ctx.body.watchMs, { field: 'watchMs', min: 0, max: 24 * 3600 * 1000, required: false, fallback: 0 }),
    completed: v.bool(ctx.body.completed),
    replayed: v.bool(ctx.body.replayed),
    skipped: v.bool(ctx.body.skipped),
    liked: v.bool(ctx.body.liked),
    commented: v.bool(ctx.body.commented),
    shared: v.bool(ctx.body.shared),
    favorited: v.bool(ctx.body.favorited),
    reposted: v.bool(ctx.body.reposted),
    followedAuthor: v.bool(ctx.body.followedAuthor),
    profileVisited: v.bool(ctx.body.profileVisited),
  });
  writeJson(res, 202, { ok: true, eventId: event });
}), { auth: true, rate: 'write' });

// --------------------------------------------------------------------------
// Interacoes
// --------------------------------------------------------------------------
router.post('/api/posts/:id/like', endpoint(async (ctx, res) => {
  const id = v.id(ctx.params.id, { field: 'id' });
  const post = getPost(id);
  assertCanViewPost(post, ctx.user);
  if (!canComment(ctx.user.id, post, post.author_id)) {
    throw forbidden('interaction_not_allowed', 'Voce nao pode interagir com este conteudo');
  }
  const result = toggleLike({ userId: ctx.user.id, postId: id });
  const payload = { postId: id, liked: result.liked, counts: result.counts, by: ctx.user.id };
  hub.publish(topics.post(id), result.liked ? EVENTS.LIKE : EVENTS.UNLIKE, payload);
  if (result.liked && post.author_id !== ctx.user.id) {
    createNotification({
      userId: post.author_id, actorId: ctx.user.id, type: 'like',
      entityType: 'post', entityId: id,
    });
  }
  writeJson(res, 200, result);
}), { auth: true, rate: 'write' });

router.post('/api/posts/:id/favorite', endpoint(async (ctx, res) => {
  const id = v.id(ctx.params.id, { field: 'id' });
  const post = getPost(id);
  assertCanViewPost(post, ctx.user);
  const result = toggleFavorite({ userId: ctx.user.id, postId: id });
  hub.publish(topics.post(id), result.favorited ? EVENTS.FAVORITE : EVENTS.UNFAVORITE, {
    postId: id, favorited: result.favorited, by: ctx.user.id,
  });
  writeJson(res, 200, result);
}), { auth: true, rate: 'write' });

router.post('/api/posts/:id/repost', endpoint(async (ctx, res) => {
  const id = v.id(ctx.params.id, { field: 'id' });
  const result = repost({ userId: ctx.user.id, postId: id, comment: v.plainText(ctx.body.comment ?? '', { field: 'comment', max: 500, required: false }) });
  const counts = countsFor(id);
  hub.publish(topics.post(id), EVENTS.REPOST, { postId: id, counts });
  const repostPost = get('SELECT * FROM posts WHERE id = ?', { id: result.repostId });
  if (repostPost) notifyFollowersOfNewPost(ctx.user.id, serializePost(repostPost, ctx.user));
  writeJson(res, 201, { ...result, counts });
}), { auth: true, rate: 'write' });

router.delete('/api/posts/:id/repost', endpoint(async (ctx, res) => {
  const id = v.id(ctx.params.id, { field: 'id' });
  const result = undoRepost({ userId: ctx.user.id, postId: id });
  const counts = countsFor(id);
  hub.publish(topics.post(id), EVENTS.UNREPOST, { postId: id, counts });
  writeJson(res, 200, { ...result, counts });
}), { auth: true, rate: 'write' });

router.post('/api/posts/:id/not-interested', endpoint(async (ctx, res) => {
  const id = v.id(ctx.params.id, { field: 'id' });
  const post = getPost(id);
  if (!post) throw notFound('post_not_found', 'Conteudo nao encontrado');
  hidePost({ userId: ctx.user.id, postId: id, reason: 'not_interested' });
  writeJson(res, 200, { ok: true });
}), { auth: true, rate: 'write' });

router.post('/api/posts/:id/hide-author', endpoint(async (ctx, res) => {
  const id = v.id(ctx.params.id, { field: 'id' });
  const post = getPost(id);
  if (!post) throw notFound('post_not_found', 'Conteudo nao encontrado');
  const result = blockCreator({ userId: ctx.user.id, creatorId: post.author_id });
  writeJson(res, 200, result);
}), { auth: true, rate: 'write' });

// --------------------------------------------------------------------------
// Comentarios
// --------------------------------------------------------------------------
router.get('/api/posts/:id/comments', endpoint(async (ctx, res) => {
  const id = v.id(ctx.params.id, { field: 'id' });
  const post = getPost(id);
  assertCanViewPost(post, ctx.user);
  const { limit, offset } = v.pagination(ctx.query, { defaultLimit: 30, maxLimit: 100 });
  const sort = v.oneOf(ctx.query.sort ?? 'top', ['top', 'recent', 'oldest'], { field: 'sort', fallback: 'top' });
  const comments = listComments({ postId: id, viewer: ctx.user, sort, limit, offset });
  writeJson(res, 200, { postId: id, comments, counts: countsFor(id) });
}));

router.post('/api/posts/:id/comments', endpoint(async (ctx, res) => {
  const id = v.id(ctx.params.id, { field: 'id' });
  const parentId = ctx.body.parentId ? v.id(ctx.body.parentId, { field: 'parentId' }) : null;
  // Texto e anexo sao independentes (itens 15 e 16): um comentario pode ser so
  // um GIF, so uma figurinha, so um audio, ou texto + anexo. Antes `body` era
  // obrigatorio e escolher um GIF respondia "Campo obrigatorio".
  const tipo = v.oneOf(ctx.body.type ?? 'text', COMMENT_TYPES, { field: 'type', fallback: 'text' });
  const body = v.plainText(ctx.body.body ?? '', { field: 'body', max: 2000, required: false });
  const mediaId = ctx.body.mediaId ? v.id(ctx.body.mediaId, { field: 'mediaId' }) : null;
  const metadata = ctx.body.metadata && typeof ctx.body.metadata === 'object'
    ? {
      url: v.str(ctx.body.metadata.url ?? '', { field: 'metadata.url', max: 500, required: false }) || null,
      id: v.str(ctx.body.metadata.id ?? '', { field: 'metadata.id', max: 80, required: false }) || null,
      posterUrl: v.str(ctx.body.metadata.posterUrl ?? '', { field: 'metadata.posterUrl', max: 500, required: false }) || null,
      title: v.str(ctx.body.metadata.title ?? '', { field: 'metadata.title', max: 120, required: false }) || null,
    }
    : {};
  if (!body && !mediaId && tipo === 'text') {
    throw badRequest('comment_empty', 'Escreva algo ou escolha um GIF, figurinha ou audio');
  }
  const comment = createComment({
    postId: id, authorId: ctx.user.id, body, type: tipo, mediaId, metadata, parentId,
  });
  const counts = countsFor(id);
  hub.publish(topics.post(id), EVENTS.COMMENT, { postId: id, comment, counts });
  const post = get('SELECT author_id FROM posts WHERE id = ?', { id });
  if (post) {
    hub.publish(topics.user(post.author_id), EVENTS.COMMENT, { postId: id, comment, counts });
  }
  writeJson(res, 201, { comment, counts });
}), { auth: true, rate: 'write' });

router.post('/api/comments/:id/like', endpoint(async (ctx, res) => {
  const commentId = v.id(ctx.params.id, { field: 'id' });
  const result = toggleCommentLike({ commentId, userId: ctx.user.id });
  const comment = get('SELECT post_id FROM comments WHERE id = ?', { id: commentId });
  if (comment) {
    hub.publish(topics.post(comment.post_id), EVENTS.COMMENT, {
      postId: comment.post_id, commentId, likeCount: result.likeCount, liked: result.liked, by: ctx.user.id,
    });
  }
  writeJson(res, 200, result);
}), { auth: true, rate: 'write' });

router.delete('/api/comments/:id', endpoint(async (ctx, res) => {
  const commentId = v.id(ctx.params.id, { field: 'id' });
  const comment = get('SELECT post_id FROM comments WHERE id = ?', { id: commentId });
  deleteComment({ commentId, userId: ctx.user.id, actorRole: 'user' });
  hub.publish(topics.post(comment.post_id), EVENTS.COMMENT_DELETE, {
    postId: comment.post_id, commentId, counts: countsFor(comment.post_id),
  });
  writeJson(res, 200, { ok: true });
}), { auth: true, rate: 'write' });

router.get('/api/comments/:id/replies', endpoint(async (ctx, res) => {
  const commentId = v.id(ctx.params.id, { field: 'id' });
  const comment = get('SELECT * FROM comments WHERE id = ?', { id: commentId });
  if (!comment) throw notFound('comment_not_found', 'Comentario nao encontrado');
  const post = getPost(comment.post_id);
  assertCanViewPost(post, ctx.user);
  const { limit, offset } = v.pagination(ctx.query, { defaultLimit: 30, maxLimit: 100 });
  writeJson(res, 200, { comments: listComments({ postId: comment.post_id, viewer: ctx.user, limit, offset, parentId: commentId }) });
}));

// --------------------------------------------------------------------------
// Hashtags / sons
// --------------------------------------------------------------------------
router.get('/api/hashtags/:tag', endpoint(async (ctx, res) => {
  const { limit, offset } = v.pagination(ctx.query, { defaultLimit: 24, maxLimit: 50 });
  const order = v.oneOf(ctx.query.order ?? 'top', ['top', 'recent'], { field: 'order', fallback: 'top' });
  const result = hashtagPosts({ tag: ctx.params.tag, viewer: ctx.user, limit, offset, order });
  if (!result.hashtag) throw notFound('hashtag_not_found', 'Hashtag nao encontrada');
  run('UPDATE hashtags SET view_count = view_count + 1 WHERE id = ?', { id: result.hashtag.id });
  writeJson(res, 200, result);
}));

router.get('/api/hashtags', endpoint(async (ctx, res) => {
  const limit = v.int(ctx.query.limit, { field: 'limit', min: 1, max: 50, required: false, fallback: 20 });
  writeJson(res, 200, { hashtags: trendingHashtags({ limit }) });
}));

router.get('/api/sounds/:id', endpoint(async (ctx, res) => {
  const { limit, offset } = v.pagination(ctx.query, { defaultLimit: 24, maxLimit: 50 });
  writeJson(res, 200, soundPage({ soundId: v.id(ctx.params.id, { field: 'id' }), viewer: ctx.user, limit, offset }));
}));

// --------------------------------------------------------------------------
// Rascunhos
// --------------------------------------------------------------------------
router.get('/api/drafts', endpoint(async (ctx, res) => {
  writeJson(res, 200, { drafts: listDrafts(ctx.user.id) });
}), { auth: true });

router.post('/api/drafts', endpoint(async (ctx, res) => {
  const payload = ctx.body.payload && typeof ctx.body.payload === 'object' ? ctx.body.payload : {};
  if (JSON.stringify(payload).length > 200_000) throw badRequest('draft_too_large', 'Rascunho excede 200 KB');
  const draft = saveDraft({
    userId: ctx.user.id,
    payload,
    draftId: ctx.body.id ? v.id(ctx.body.id, { field: 'id' }) : null,
  });
  writeJson(res, ctx.body.id ? 200 : 201, { draft });
}), { auth: true, rate: 'write' });

router.get('/api/drafts/:id', endpoint(async (ctx, res) => {
  const draft = getDraft(v.id(ctx.params.id, { field: 'id' }), ctx.user.id);
  if (!draft) throw notFound('draft_not_found', 'Rascunho nao encontrado');
  writeJson(res, 200, { draft });
}), { auth: true });

router.delete('/api/drafts/:id', endpoint(async (ctx, res) => {
  deleteDraft({ draftId: v.id(ctx.params.id, { field: 'id' }), userId: ctx.user.id });
  writeJson(res, 200, { ok: true });
}), { auth: true, rate: 'write' });

router.post('/api/drafts/:id/publish', endpoint(async (ctx, res) => {
  const draft = getDraft(v.id(ctx.params.id, { field: 'id' }), ctx.user.id);
  if (!draft) throw notFound('draft_not_found', 'Rascunho nao encontrado');
  const p = draft.payload || {};
  const type = v.oneOf(p.type ?? 'video', ['video', 'image', 'text'], { field: 'type' });
  const mediaId = p.mediaId ? v.id(p.mediaId, { field: 'mediaId' }) : null;
  if (type !== 'text' && !mediaId) throw badRequest('media_required', 'Rascunho sem arquivo');
  const post = createPost({
    authorId: ctx.user.id,
    type,
    caption: v.plainText(p.caption ?? '', { field: 'caption', max: 2200, required: false }),
    mediaId,
    visibility: v.oneOf(p.visibility ?? 'public', VISIBILITIES, { field: 'visibility', fallback: 'public' }),
    commentsEnabled: p.commentsEnabled !== false,
    downloadAllowed: v.oneOf(p.downloadAllowed ?? 'everyone', AUDIENCE, { field: 'downloadAllowed', fallback: 'everyone' }),
    remixAllowed: v.oneOf(p.remixAllowed ?? 'everyone', AUDIENCE, { field: 'remixAllowed', fallback: 'everyone' }),
    duetAllowed: p.duetAllowed !== false,
    location: v.str(p.location ?? '', { field: 'location', max: 80, required: false }),
    soundId: p.soundId ? v.id(p.soundId, { field: 'soundId' }) : null,
  });
  deleteDraft({ draftId: draft.id, userId: ctx.user.id });
  const serialized = serializePost(post, ctx.user);
  notifyFollowersOfNewPost(ctx.user.id, serialized);
  publishForYouPost(post);
  writeJson(res, 201, { post: serialized, publishedFromDraft: draft.id });
}), { auth: true, rate: 'write' });

// --------------------------------------------------------------------------
// Recomendacao: reset / configuracao
// --------------------------------------------------------------------------
router.post('/api/me/recommendations/reset', endpoint(async (ctx, res) => {
  writeJson(res, 200, resetRecommendations(ctx.user.id));
}), { auth: true, rate: 'write' });

router.patch('/api/me/recommendations', endpoint(async (ctx, res) => {
  const changes = {};
  if (ctx.body.optOut !== undefined) changes.optOut = v.bool(ctx.body.optOut);
  if (ctx.body.reducedMode !== undefined) changes.reducedMode = v.bool(ctx.body.reducedMode);
  if (ctx.body.preferredLanguage !== undefined) changes.preferredLanguage = v.str(ctx.body.preferredLanguage, { field: 'preferredLanguage', max: 10 });
  writeJson(res, 200, { recommendation: updateRecommendationSettings(ctx.user.id, changes) });
}), { auth: true, rate: 'write' });

router.get('/api/me/recommendations', endpoint(async (ctx, res) => {
  writeJson(res, 200, { recommendation: recommendationSettings(ctx.user.id) });
}), { auth: true });

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------
/** Avisa seguidores (e o host de LIVE) sobre a nova publicacao. */
function notifyFollowersOfNewPost(authorId, serializedPost) {
  const followers = all(
    "SELECT follower_id AS id FROM follows WHERE followee_id = ? AND status = 'accepted' LIMIT 5000",
    { authorId },
  ).map((r) => r.id);
  if (!followers.length) return 0;
  for (const followerId of followers) {
    hub.publishToUser(followerId, EVENTS.POST_CREATED, { post: serializedPost });
  }
  return followers.length;
}

function publishForYouPost(post) {
  if (!forYouFeed({ viewer: null, limit: 1, postId: post.id }).length) return false;
  hub.publish(topics.feedNew(), EVENTS.POST_CREATED, { postId: post.id });
  return true;
}
