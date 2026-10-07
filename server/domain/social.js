import { all, get, run, transaction, scalar } from '../db/index.js';
import { newId } from '../lib/ids.js';
import { notFound, forbidden, badRequest, conflict } from '../lib/errors.js';
import {
  getUserById, publicUser, avatarUrlForKey, getProfile, getFollowState, isFollowing, isFriend,
  blockedEitherWay, isMuted, getUserCounts, resolveMentionedUsers,
} from './users.js';
import { canFollow, audienceAllows } from './privacy.js';
import { syncCount } from './posts.js';
import { createNotification } from './notifications.js';

// --------------------------------------------------------------------------
// Follow / unfollow / requests
// --------------------------------------------------------------------------
export function follow({ followerId, followeeId }) {
  if (followerId === followeeId) throw badRequest('cannot_follow_self', 'Voce nao pode seguir a si mesmo');
  const target = getUserById(followeeId);
  if (!target) throw notFound('user_not_found', 'Usuario nao encontrado');
  if (blockedEitherWay(followerId, followeeId)) {
    throw forbidden('follow_blocked', 'Nao e possivel seguir esta conta');
  }
  if (!canFollow(followerId, followeeId)) {
    throw forbidden('follow_not_allowed', 'A conta nao permite seguir voce');
  }
  const existing = getFollowState(followerId, followeeId);
  if (existing?.status === 'accepted') {
    return { status: 'accepted', changed: false, counts: getUserCounts(followeeId) };
  }
  const profile = getProfile(followeeId);
  const requiresApproval = Boolean(
    (profile?.account_privacy === 'private' || profile?.friend_only) &&
    !['everyone'].includes(profile?.who_can_follow) &&
    profile?.who_can_follow !== 'followers',
  );
  const status = requiresApproval ? 'pending' : 'accepted';
  const now = Date.now();

  transaction(() => {
    run(
      `INSERT INTO follows (follower_id, followee_id, status, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(follower_id, followee_id) DO UPDATE SET status = excluded.status`,
      { followerId, followeeId, status, now },
    );
    // Amizade e mutua: nasce apenas quando os dois lados aceitam.
    if (status === 'accepted' && isFollowing(followeeId, followerId)) {
      addFriendship(followerId, followeeId);
      addFriendship(followeeId, followerId);
    }
  });

  if (status === 'accepted') {
    createNotification({
      userId: followeeId, actorId: followerId, type: 'follow',
      body: 'comecou a te seguir',
    });
  } else {
    createNotification({
      userId: followeeId, actorId: followerId, type: 'follow_request',
      body: 'solicitou te seguir',
    });
  }

  return {
    status,
    changed: true,
    counts: getUserCounts(followeeId),
    isFollowing: status === 'accepted',
    isFriend: isFriend(followerId, followeeId),
  };
}

export function unfollow({ followerId, followeeId }) {
  const existing = getFollowState(followerId, followeeId);
  if (!existing) return { status: 'none', changed: false, counts: getUserCounts(followeeId) };
  transaction(() => {
    run('DELETE FROM follows WHERE follower_id = ? AND followee_id = ?', { followerId, followeeId });
    run('DELETE FROM friendships WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)', {
      a1: followerId, b1: followeeId, a2: followeeId, b2: followerId,
    });
  });
  return { status: 'none', changed: true, counts: getUserCounts(followeeId), isFollowing: false, isFriend: false };
}

export function addFriendship(a, b) {
  if (a === b) return;
  run('INSERT OR IGNORE INTO friendships (user_id, friend_id, created_at) VALUES (?, ?, ?)', {
    userId: a, friendId: b, ts: Date.now(),
  });
}

export function removeFriend({ userId, friendId }) {
  transaction(() => {
    run('DELETE FROM friendships WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)', {
      a1: userId, b1: friendId, a2: friendId, b2: userId,
    });
  });
  return { removed: true };
}

export function followRequests({ userId, limit = 50 }) {
  return all(
    `SELECT f.follower_id AS userId, f.created_at AS createdAt, u.username, u.display_name, u.avatar_key, u.avatar_version
       FROM follows f JOIN users u ON u.id = f.follower_id
      WHERE f.followee_id = :userId AND f.status = 'pending'
      ORDER BY f.created_at DESC LIMIT :limit`,
    { userId, limit },
  ).map((r) => ({
    userId: r.userId,
    createdAt: r.createdAt,
    user: {
      id: r.userId,
      username: r.username,
      displayName: r.display_name,
      avatarUrl: avatarUrlForKey(r.avatar_key, r.avatar_version),
    },
  }));
}

export function acceptFollowRequest({ userId, followerId }) {
  const row = get('SELECT status FROM follows WHERE follower_id = ? AND followee_id = ?', { followerId, followeeId: userId });
  if (!row) throw notFound('follow_request_not_found', 'Solicitacao nao encontrada');
  run("UPDATE follows SET status = 'accepted' WHERE follower_id = ? AND followee_id = ?", { followerId, followeeId: userId });
  if (isFollowing(userId, followerId)) {
    addFriendship(userId, followerId);
    addFriendship(followerId, userId);
  }
  createNotification({ userId: followerId, actorId: userId, type: 'follow_accepted', body: 'aceitou seu pedido de seguir' });
  return { status: 'accepted', counts: getUserCounts(userId) };
}

export function rejectFollowRequest({ userId, followerId }) {
  run('DELETE FROM follows WHERE follower_id = ? AND followee_id = ? AND status = ?', {
    followerId, followeeId: userId, status: 'pending',
  });
  return { status: 'none' };
}

export function removeFollower({ userId, followerId }) {
  const row = get('SELECT status FROM follows WHERE follower_id = ? AND followee_id = ?', { followerId, followeeId: userId });
  if (!row) throw notFound('follower_not_found', 'Este usuario nao te segue');
  run('DELETE FROM follows WHERE follower_id = ? AND followee_id = ?', { followerId, followeeId: userId });
  run('DELETE FROM friendships WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)', {
    a1: userId, b1: followerId, a2: followerId, b2: userId,
  });
  return { removed: true, counts: getUserCounts(userId) };
}

export function followers({ userId, viewer, limit = 50, offset = 0 }) {
  return all(
    `SELECT u.id, u.username, u.display_name, u.avatar_key, u.avatar_version, u.cover_key, f.created_at
       FROM follows f JOIN users u ON u.id = f.follower_id
      WHERE f.followee_id = :userId AND f.status = 'accepted'
      ORDER BY f.created_at DESC LIMIT :limit OFFSET :offset`,
    { userId, limit, offset },
  ).map((r) => decorate(r, viewer));
}

export function following({ userId, viewer, limit = 50, offset = 0 }) {
  return all(
    `SELECT u.id, u.username, u.display_name, u.avatar_key, u.avatar_version, u.cover_key, f.created_at
       FROM follows f JOIN users u ON u.id = f.followee_id
      WHERE f.follower_id = :userId AND f.status = 'accepted'
      ORDER BY f.created_at DESC LIMIT :limit OFFSET :offset`,
    { userId, limit, offset },
  ).map((r) => decorate(r, viewer));
}

export function friends({ userId, viewer, limit = 100, offset = 0 }) {
  return all(
    `SELECT u.id, u.username, u.display_name, u.avatar_key, u.avatar_version, u.cover_key, f.created_at
       FROM friendships f JOIN users u ON u.id = f.friend_id
      WHERE f.user_id = :userId
      ORDER BY f.created_at DESC LIMIT :limit OFFSET :offset`,
    { userId, limit, offset },
  ).map((r) => decorate(r, viewer));
}

function decorate(row, viewer) {
  const user = getUserById(row.id);
  const base = publicUser(user, viewer);
  return {
    ...base,
    followedAt: row.created_at,
    isFollowing: viewer ? isFollowing(viewer.id, row.id) : false,
    isFriend: viewer ? isFriend(viewer.id, row.id) : false,
  };
}

export function suggestions({ viewerId, limit = 20 }) {
  const rows = all(
    `SELECT u.id FROM users u
      WHERE u.status = 'active' AND u.id <> :viewerId
        AND NOT EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = :viewerId AND f.followee_id = u.id)
        AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = :viewerId AND b.blocked_id = u.id) OR (b.blocker_id = u.id AND b.blocked_id = :viewerId))
      ORDER BY (
        (SELECT COUNT(*) FROM follows f2 WHERE f2.followee_id = u.id AND f2.status = 'accepted')
        + (SELECT COALESCE(SUM(like_count),0) FROM posts p WHERE p.author_id = u.id AND p.status = 'published') * 0.1
      ) DESC
      LIMIT :limit`,
    { viewerId, limit },
  );
  return rows.map((r) => decorate({ ...r, created_at: Date.now() }, getUserById(viewerId)));
}

// --------------------------------------------------------------------------
// Bloqueio / silenciamento
// --------------------------------------------------------------------------
export function block({ blockerId, blockedId }) {
  if (blockerId === blockedId) throw badRequest('cannot_block_self', 'Voce nao pode bloquear a si mesmo');
  const target = getUserById(blockedId);
  if (!target) throw notFound('user_not_found', 'Usuario nao encontrado');
  transaction(() => {
    run('INSERT OR IGNORE INTO blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)', {
      blockerId, blockedId, ts: Date.now(),
    });
    run('DELETE FROM follows WHERE (follower_id = ? AND followee_id = ?) OR (follower_id = ? AND followee_id = ?)', {
      a1: blockerId, b1: blockedId, a2: blockedId, b2: blockerId,
    });
    run('DELETE FROM friendships WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)', {
      a1: blockerId, b1: blockedId, a2: blockedId, b2: blockerId,
    });
  });
  return { blocked: true };
}

export function unblock({ blockerId, blockedId }) {
  run('DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?', { blockerId, blockedId });
  return { blocked: false };
}

export function mute({ userId, targetType, targetId }) {
  if (!['user', 'post', 'sound', 'hashtag', 'chat'].includes(targetType)) {
    throw badRequest('invalid_mute_target', 'Alvo de silenciamento invalido');
  }
  run(
    'INSERT OR IGNORE INTO mutes (user_id, target_type, target_id, created_at) VALUES (?, ?, ?, ?)',
    { userId, targetType, targetId, ts: Date.now() },
  );
  return { muted: true };
}

export function unmute({ userId, targetType, targetId }) {
  run('DELETE FROM mutes WHERE user_id = ? AND target_type = ? AND target_id = ?', { userId, targetType, targetId });
  return { muted: false };
}

// --------------------------------------------------------------------------
// Comentarios
// --------------------------------------------------------------------------
export const COMMENT_TYPES = ['text', 'emoji', 'gif', 'sticker', 'image', 'video', 'audio'];

/**
 * Cria um comentario.
 *
 * `body` e `attachment` sao independentes DE PROPOSITO: um comentario pode ser
 * so um GIF, so uma figurinha, so um audio, ou texto + anexo. Antes o texto era
 * obrigatorio e escolher um GIF respondia "Campo obrigatorio".
 *
 * @param {string} [body] texto (pode ser vazio se houver anexo)
 * @param {string} [type] um de COMMENT_TYPES
 * @param {string} [mediaId] arquivo enviado pelo usuario
 * @param {object} [metadata] dados minimos (URL da GIPHY, id do GIF)
 */
export function createComment({ postId, authorId, body = '', type = 'text', mediaId = null, metadata = {}, parentId = null }) {
  const post = get('SELECT * FROM posts WHERE id = ?', { id: postId });
  if (!post || post.status !== 'published') throw notFound('post_not_found', 'Post nao encontrado');
  if (!post.comments_enabled) throw forbidden('comments_disabled', 'Comentarios estao desativados neste conteudo');
  if (blockedEitherWay(authorId, post.author_id)) {
    throw forbidden('comment_blocked', 'Nao e possivel comentar neste conteudo');
  }
  if (!audienceAllows(getProfile(post.author_id)?.who_can_comment ?? 'everyone', authorId, post.author_id)) {
    throw forbidden('comment_not_allowed', 'Esta conta limita quem pode comentar');
  }
  if (isMuted(authorId, 'user', post.author_id)) {
    throw forbidden('comment_muted_user', 'Voce silenciou este usuario');
  }
  // Sem texto E sem anexo nao ha comentario: erro claro, nao um registro vazio.
  if (!body && !mediaId && type === 'text') {
    throw badRequest('comment_empty', 'Escreva algo ou escolha um GIF, figurinha ou audio');
  }
  if (mediaId) {
    const media = get('SELECT * FROM media WHERE id = ?', { id: mediaId });
    if (!media) throw notFound('media_not_found', 'Arquivo nao encontrado');
    if (media.owner_id !== authorId) throw forbidden('not_media_owner', 'Este arquivo nao e seu');
    if (media.status === 'failed') throw badRequest('media_processing_failed', 'O arquivo enviado nao pode ser usado');
  }
  if (parentId) {
    const parent = get('SELECT * FROM comments WHERE id = ?', { id: parentId });
    if (!parent || parent.post_id !== postId || parent.status !== 'published') {
      throw notFound('parent_comment_not_found', 'Comentario original nao encontrado');
    }
  }

  const id = newId('cmt');
  const now = Date.now();
  transaction(() => {
    run(
      `INSERT INTO comments (id, post_id, author_id, parent_id, body, type, media_id, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      {
        id,
        postId,
        authorId,
        parentId,
        body,
        type,
        mediaId,
        metadataJson: JSON.stringify(metadata || {}),
        now,
        ts: now,
      },
    );
    if (parentId) {
      run('UPDATE comments SET reply_count = reply_count + 1 WHERE id = ?', { id: parentId });
    }
    syncCount(postId, 'comments');
    for (const mentioned of resolveMentionedUsers(body)) {
      run('INSERT OR IGNORE INTO comment_mentions (comment_id, user_id) VALUES (?, ?)', { commentId: id, userId: mentioned.id });
    }
  });

  if (post.author_id !== authorId) {
    createNotification({ userId: post.author_id, actorId: authorId, type: 'comment', entityType: 'post', entityId: postId, body });
  }
  if (parentId) {
    const parent = get('SELECT author_id FROM comments WHERE id = ?', { id: parentId });
    if (parent && parent.author_id !== authorId && parent.author_id !== post.author_id) {
      createNotification({ userId: parent.author_id, actorId: authorId, type: 'reply', entityType: 'comment', entityId: id, body });
    }
  }
  for (const mentioned of resolveMentionedUsers(body)) {
    if (mentioned.id === authorId || mentioned.id === post.author_id) continue;
    createNotification({ userId: mentioned.id, actorId: authorId, type: 'mention', entityType: 'comment', entityId: id, body });
  }

  return serializeComment(get('SELECT * FROM comments WHERE id = ?', { id }), authorId);
}

export function listComments({ postId, viewer, sort = 'top', limit = 30, offset = 0, parentId = null }) {
  const order = sort === 'recent'
    ? 'c.created_at DESC'
    : sort === 'oldest' ? 'c.created_at ASC' : '(c.like_count * 2 + c.reply_count) DESC, c.created_at DESC';
  const parentFilter = parentId === null ? 'AND c.parent_id IS NULL' : 'AND c.parent_id = :parentId';
  // LIMIT/OFFSET sao normalizados para inteiro no nucleo do banco.
  const params = { postId, limit, offset };
  if (parentId !== null) params.parentId = parentId;
  const rows = all(
    `SELECT c.* FROM comments c WHERE c.post_id = :postId AND c.status = 'published' ${parentFilter}
      ORDER BY ${order} LIMIT :limit OFFSET :offset`,
    params,
  );
  return rows.map((row) => serializeComment(row, viewer?.id ?? null));
}

export function serializeComment(comment, viewerId = null) {
  if (!comment) return null;
  const author = getUserById(comment.author_id);
  const liked = viewerId
    ? Boolean(scalar('SELECT 1 FROM comment_likes WHERE user_id = ? AND comment_id = ?', { userId: viewerId, commentId: comment.id }, 0))
    : false;
  const replies = comment.reply_count
    ? all(
      `SELECT * FROM comments WHERE parent_id = :parentId AND status = 'published'
        ORDER BY created_at ASC LIMIT 3`,
      { parentId: comment.id },
    ).map((r) => serializeComment(r, viewerId))
    : [];
  return {
    id: comment.id,
    postId: comment.post_id,
    parentId: comment.parent_id ?? null,
    body: comment.status === 'deleted' ? '' : comment.body,
    deleted: comment.status === 'deleted',
    createdAt: comment.created_at,
    author: publicUser(author),
    counts: { likes: comment.like_count ?? 0, replies: comment.reply_count ?? 0 },
    viewerState: { liked, canDelete: viewerId === comment.author_id },
    // Anexo do comentario: GIF/figurinha/imagem/audio/video. Um comentario so
    // com anexo e valido e aparece igual aos demais.
    ...(comment.type && comment.type !== 'text' ? { type: comment.type } : {}),
    media: serializeCommentMedia(comment),
    replies,
  };
}

/**
 * Anexo do comentario no mesmo formato do post: `kind`, `url` e `posterUrl`.
 * O GIF vem da GIPHY (URL externa) e por isso vive em `metadata_json`; os
 * demais aponta para a tabela `media`.
 */
function serializeCommentMedia(comment) {
  if (!comment || comment.status === 'deleted') return null;
  // `gif` e `sticker` sao o MESMO tipo de anexo (URL externa da GIPHY guardada
  // em `metadata_json`), so mudam o `kind`. Antes so `gif` tinha ramo aqui: a
  // figurinha era GRAVADA no banco com `type: 'sticker'` e voltava da API sem
  // `media`, ou seja, aparecia no comentario sem imagem nenhuma.
  if (comment.type === 'gif' || comment.type === 'sticker') {
    const meta = safeJson(comment.metadata_json);
    const url = meta.url || null;
    if (!url) return null;
    return {
      kind: comment.type,
      url,
      id: meta.id || null,
      posterUrl: meta.posterUrl || null,
      title: meta.title || null,
    };
  }
  if (!comment.media_id) return null;
  const media = get('SELECT * FROM media WHERE id = ?', { mediaId: comment.media_id });
  if (!media) return null;
  const meta = safeJson(media.metadata_json ?? '{}');
  return {
    kind: media.kind,
    id: media.id,
    durationMs: media.duration_ms ?? 0,
    url: `/api/media/stream?key=${encodeURIComponent(`${media.bucket}/${media.storage_key}`)}`,
    posterUrl: media.poster_key
      ? `/api/media/stream?key=${encodeURIComponent(`${media.bucket}/${media.poster_key}`)}`
      : (meta.posterKey ? `/api/media/stream?key=${encodeURIComponent(`${media.bucket}/${meta.posterKey}`)}` : null),
  };
}

function safeJson(json) {
  try { return JSON.parse(json || '{}'); } catch { return {}; }
}

export function toggleCommentLike({ commentId, userId }) {
  const comment = get('SELECT * FROM comments WHERE id = ?', { id: commentId });
  if (!comment || comment.status !== 'published') throw notFound('comment_not_found', 'Comentario nao encontrado');
  const existing = get('SELECT 1 FROM comment_likes WHERE user_id = ? AND comment_id = ?', { userId, commentId });
  const liked = !existing;
  if (liked) {
    run('INSERT OR IGNORE INTO comment_likes (user_id, comment_id, created_at) VALUES (?, ?, ?)', { userId, commentId, ts: Date.now() });
  } else {
    run('DELETE FROM comment_likes WHERE user_id = ? AND comment_id = ?', { userId, commentId });
  }
  const count = scalar('SELECT COUNT(*) AS c FROM comment_likes WHERE comment_id = ?', { commentId }, 0);
  run('UPDATE comments SET like_count = ? WHERE id = ?', { count, id: commentId });
  if (liked && comment.author_id !== userId) {
    const post = get('SELECT author_id, id FROM posts WHERE id = ?', { id: comment.post_id });
    createNotification({
      userId: comment.author_id, actorId: userId, type: 'comment_like',
      entityType: 'comment', entityId: commentId,
    });
  }
  return { liked, likeCount: count };
}

export function deleteComment({ commentId, userId, actorRole = 'user' }) {
  const comment = get('SELECT * FROM comments WHERE id = ?', { id: commentId });
  if (!comment) throw notFound('comment_not_found', 'Comentario nao encontrado');
  if (comment.author_id !== userId && actorRole === 'user') {
    throw forbidden('not_comment_author', 'Somente o autor pode apagar este comentario');
  }
  const now = Date.now();
  transaction(() => {
    run("UPDATE comments SET status = 'deleted', body = '', deleted_at = ? WHERE id = ?", { now, id: commentId });
    if (comment.parent_id) {
      run('UPDATE comments SET reply_count = MAX(0, reply_count - 1) WHERE id = ?', { id: comment.parent_id });
    }
    syncCount(comment.post_id, 'comments');
  });
  return { deleted: true };
}

// --------------------------------------------------------------------------
// Repost
// --------------------------------------------------------------------------
export function repost({ userId, postId, comment = '' }) {
  const original = get('SELECT * FROM posts WHERE id = ?', { id: postId });
  if (!original || original.status !== 'published') throw notFound('post_not_found', 'Conteudo nao encontrado');
  if (original.author_id === userId) throw badRequest('cannot_repost_own', 'Voce nao pode repostar seu proprio conteudo');
  if (blockedEitherWay(userId, original.author_id)) throw forbidden('repost_blocked', 'Nao e possivel repostar este conteudo');
  const existing = get('SELECT * FROM posts WHERE author_id = ? AND type = ? AND repost_of_id = ?', {
    authorId: userId, type: 'repost', postId,
  });
  if (existing) throw conflict('already_reposted', 'Voce ja repostou este conteudo');
  const now = Date.now();
  let repostId;
  transaction(() => {
    repostId = newId('pst');
    run(
      `INSERT INTO posts (id, author_id, type, caption, visibility, repost_of_id, status, created_at, updated_at, published_at, comments_enabled)
       VALUES (?, ?, 'repost', ?, 'public', ?, 'published', ?, ?, ?, 1)`,
      {
        id: repostId,
        authorId: userId,
        comment,
        postId,
        createdAt: now,
        updatedAt: now,
        publishedAt: now,
      },
    );
    syncCount(postId, 'reposts');
  });
  createNotification({
    userId: original.author_id, actorId: userId, type: 'repost',
    entityType: 'post', entityId: postId,
  });
  return { repostId, counts: { reposts: scalar("SELECT COUNT(*) AS c FROM posts WHERE repost_of_id = :postId AND status = 'published'", { postId }, 0) } };
}

export function undoRepost({ userId, postId }) {
  const existing = get('SELECT * FROM posts WHERE author_id = ? AND type = ? AND repost_of_id = ?', {
    authorId: userId, type: 'repost', postId,
  });
  if (!existing) return { reposted: false };
  const now = Date.now();
  transaction(() => {
    run("UPDATE posts SET status = 'deleted', deleted_at = ? WHERE id = ?", { now, id: existing.id });
    syncCount(postId, 'reposts');
  });
  return { reposted: false };
}

export { isFollowing, isFriend, publicUser };
