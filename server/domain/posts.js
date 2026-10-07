import { all, get, run, transaction, scalar } from '../db/index.js';
import { newId, normalizeHashtag } from '../lib/ids.js';
import { notFound, forbidden, badRequest, unauthorized } from '../lib/errors.js';
import {
  getUserById, publicUser, upsertHashtag, extractHashtags, resolveMentionedUsers,
} from './users.js';
import { canViewPost, canDownloadPost, canRemixPost, canMention } from './privacy.js';
import { createNotification } from './notifications.js';

/** Serializa um post para o frontend (campos sempre definidos, nunca undefined). */
export function serializePost(post, viewer = null, { includeSound = true, repostOf = null } = {}) {
  if (!post) return null;
  const viewerId = viewer?.id ?? null;
  const author = getUserById(post.author_id);
  const liked = viewerId
    ? Boolean(scalar('SELECT 1 AS ok FROM likes WHERE user_id = ? AND post_id = ?', { userId: viewerId, postId: post.id }, 0))
    : false;
  const favorited = viewerId
    ? Boolean(scalar('SELECT 1 AS ok FROM favorites WHERE user_id = ? AND post_id = ?', { userId: viewerId, postId: post.id }, 0))
    : false;
  const reposted = viewerId
    ? Boolean(scalar('SELECT 1 AS ok FROM posts WHERE author_id = ? AND type = ? AND repost_of_id = ? AND status = ?', {
      userId: viewerId, type: 'repost', postId: post.id, status: 'published',
    }, 0))
    : false;
  const hidden = viewerId
    ? Boolean(scalar('SELECT 1 AS ok FROM hidden_posts WHERE user_id = ? AND post_id = ?', { userId: viewerId, postId: post.id }, 0))
    : false;

  const media = post.media_id ? get('SELECT * FROM media WHERE id = ?', { mediaId: post.media_id }) : null;
  const mediaMeta = media ? safeJson(media.meta_json) : null;
  const sound = includeSound && post.sound_id ? get('SELECT * FROM sounds WHERE id = ?', { soundId: post.sound_id }) : null;

  return {
    id: post.id,
    type: post.type,
    status: post.status,
    caption: post.caption ?? '',
    visibility: post.visibility,
    commentsEnabled: Boolean(post.comments_enabled),
    // Audiencia configurada pelo autor (everyone/followers/friends/nobody).
    downloadAudience: post.download_allowed || 'everyone',
    remixAudience: post.remix_allowed || 'everyone',
    // Permissao ja resolvida para ESTE espectador (usada pela UI e pelo
    // botao de download). Manter os dois campos evita confusao entre
    // "configuracao" e "pode fazer agora".
    downloadAllowed: Boolean(canDownloadPost(viewerId, post)),
    remixAllowed: Boolean(canRemixPost(viewerId, post)),
    location: post.location ?? '',
    createdAt: post.created_at,
    publishedAt: post.published_at ?? post.created_at,
    author: publicUser(author, viewer),
    media: media
      ? {
        id: media.id,
        kind: media.kind,
        mime: media.mime,
        width: media.width ?? 0,
        height: media.height ?? 0,
        durationMs: media.duration_ms ?? 0,
        hasAudio: Boolean(media.has_audio),
        status: media.status,
        posterUrl: mediaMeta?.thumbnail?.posterKey
          ? `/api/media/stream?key=${encodeURIComponent(`thumbnails/${mediaMeta.thumbnail.posterKey}`)}`
          : null,
        spriteUrl: mediaMeta?.thumbnail?.spriteKey
          ? `/api/media/stream?key=${encodeURIComponent(`thumbnails/${mediaMeta.thumbnail.spriteKey}`)}`
          : null,
        url: `/api/media/stream?key=${encodeURIComponent(`${media.bucket}/${media.storage_key}`)}`,
        renditions: (mediaMeta?.renditions || []).map((r) => ({
          label: r.label,
          width: r.width,
          height: r.height,
          url: `/api/media/stream?key=${encodeURIComponent(`videos/${r.key}`)}`,
        })),
        hlsUrl: mediaMeta?.hlsKey ? `/api/media/hls?key=${encodeURIComponent(`videos/${mediaMeta.hlsKey}`)}` : null,
        normalizedUrl: mediaMeta?.normalizedKey && mediaMeta.normalizedKey !== media.storage_key
          ? `/api/media/stream?key=${encodeURIComponent(`${media.bucket}/${mediaMeta.normalizedKey}`)}`
          : null,
        error: media.processing_error ?? null,
      }
      : null,
    sound: sound
      ? {
        id: sound.id,
        title: sound.title,
        artist: sound.artist ?? '',
        isOriginal: Boolean(sound.is_original),
        url: sound.media_id ? `/api/media/stream?key=${encodeURIComponent(`sounds/${getMediaKey(sound.media_id)}`)}` : null,
        durationMs: sound.duration_ms ?? 0,
        useCount: sound.use_count ?? 0,
      }
      : null,
    hashtags: listPostHashtags(post.id),
    counts: {
      likes: post.like_count ?? 0,
      comments: post.comment_count ?? 0,
      reposts: post.repost_count ?? 0,
      shares: post.share_count ?? 0,
      views: post.view_count ?? 0,
    },
    viewerState: { liked, favorited, reposted, hidden },
    repostOf: repostOf ? serializePost(repostOf, viewer, { repostOf: repostOf.repost_of_id ? get('SELECT * FROM posts WHERE id = ?', { id: repostOf.repost_of_id }) : null }) : null,
  };
}

function safeJson(json) {
  try { return JSON.parse(json || '{}'); } catch { return {}; }
}

function getMediaKey(mediaId) {
  const media = get('SELECT bucket, storage_key FROM media WHERE id = ?', { mediaId });
  return media ? media.storage_key : '';
}

export function listPostHashtags(postId) {
  return all(
    `SELECT h.tag FROM post_hashtags ph JOIN hashtags h ON h.id = ph.hashtag_id
      WHERE ph.post_id = ? ORDER BY ph.position ASC`,
    { postId },
  ).map((r) => `#${r.tag}`);
}

// --------------------------------------------------------------------------
// Criacao / publicacao
// --------------------------------------------------------------------------
export function createPost({
  authorId, type, caption = '', mediaId = null, visibility = 'public', commentsEnabled = true,
  downloadAllowed = 'everyone', remixAllowed = 'everyone', duetAllowed = true, location = '',
  soundId = null, repostOfId = null, status = 'published', liveRoomId = null,
}) {
  if (!['video', 'image', 'text', 'repost', 'live', 'audio'].includes(type)) {
    throw badRequest('invalid_post_type', `Tipo de post invalido: ${type}`);
  }
  if (type === 'video' && !mediaId) throw badRequest('media_required', 'Video exige arquivo de midia');
  // Item 16: audio e uma publicacao valida por si so.
  if (type === 'audio' && !mediaId) throw badRequest('audio_required', 'Audio exige arquivo de midia');
  if (type === 'repost' && !repostOfId) throw badRequest('repost_required', 'Repost exige o post original');
  // Republicar LIVE: sem a sala nao existe link para onde ir.
  if (type === 'live' && !liveRoomId) throw badRequest('live_room_required', 'LIVE exige a sala de origem');
  if (repostOfId) {
    const original = get('SELECT * FROM posts WHERE id = ?', { id: repostOfId });
    if (!original || original.status !== 'published') {
      throw notFound('repost_target_missing', 'O conteudo original nao existe mais');
    }
  }

  const id = newId('pst');
  const now = Date.now();
  const resolvedVisibility = visibility;

  transaction(() => {
    run(
      `INSERT INTO posts (id, author_id, media_id, type, caption, visibility, comments_enabled,
        download_allowed, remix_allowed, duet_allowed, location, sound_id, repost_of_id, live_room_id, status,
        created_at, updated_at, published_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      {
        id,
        authorId,
        mediaId,
        type,
        caption,
        resolvedVisibility,
        commentsEnabled: commentsEnabled ? 1 : 0,
        downloadAllowed,
        remixAllowed,
        duetAllowed: duetAllowed ? 1 : 0,
        location,
        soundId,
        repostOfId,
        liveRoomId,
        status,
        now,
        ts: now,
        publishedAt: status === 'published' ? now : null,
      },
    );

    if (type === 'repost' && repostOfId) {
      run('UPDATE posts SET repost_count = repost_count + 1, updated_at = ? WHERE id = ?', { now, id: repostOfId });
    }

    const hashtags = extractHashtags(caption);
    hashtags.forEach((tag, index) => {
      const hashtagId = upsertHashtag(tag);
      run('INSERT OR IGNORE INTO post_hashtags (post_id, hashtag_id, position) VALUES (?, ?, ?)', {
        postId: id, hashtagId, position: index,
      });
      run('UPDATE hashtags SET use_count = use_count + 1 WHERE id = ?', { hashtagId });
    });

    if (soundId) {
      run('INSERT OR IGNORE INTO post_sounds (post_id, sound_id, offset_ms) VALUES (?, ?, 0)', { postId: id, soundId });
      run('UPDATE sounds SET use_count = use_count + 1 WHERE id = ?', { soundId });
    }

    for (const mentioned of resolveMentionedUsers(caption)) {
      run('INSERT OR IGNORE INTO mentions (post_id, user_id) VALUES (?, ?)', { postId: id, userId: mentioned.id });
    }
  });

  // Notificacao de mencao: enviada fora da transacao para nao gravar
  // notificacao que o proprio rollback apagaria.
  for (const mentioned of resolveMentionedUsers(caption)) {
    if (mentioned.id === authorId) continue;
    if (!canMention(authorId, mentioned.id)) continue;
    createNotification({
      userId: mentioned.id,
      actorId: authorId,
      type: 'mention',
      entityType: 'post',
      entityId: id,
      body: caption.slice(0, 120),
    });
  }

  // Notifica quem o post original mencionou (repost/duet).
  if (repostOfId) {
    const original = get('SELECT author_id FROM posts WHERE id = ?', { id: repostOfId });
    if (original && original.author_id !== authorId) {
      createNotification({
        userId: original.author_id,
        actorId: authorId,
        type: 'repost',
        entityType: 'post',
        entityId: id,
        body: caption.slice(0, 120),
      });
    }
  }

  return get('SELECT * FROM posts WHERE id = ?', { id });
}

export function updatePost(postId, authorId, changes) {
  const post = get('SELECT * FROM posts WHERE id = ?', { id: postId });
  if (!post) throw notFound('post_not_found', 'Post nao encontrado');
  if (post.author_id !== authorId) throw forbidden('not_post_author', 'Somente o autor pode editar este post');
  // A ordem das chaves do objeto DEVE seguir a ordem dos `?` da SQL.
  const sets = [];
  const params = {};
  if (changes.caption !== undefined) {
    sets.push('caption = ?');
    params.caption = changes.caption;
  }
  if (changes.visibility !== undefined) { sets.push('visibility = ?'); params.visibility = changes.visibility; }
  if (changes.commentsEnabled !== undefined) { sets.push('comments_enabled = ?'); params.comments_enabled = changes.commentsEnabled ? 1 : 0; }
  if (changes.downloadAllowed !== undefined) { sets.push('download_allowed = ?'); params.downloadAllowed = changes.downloadAllowed; }
  if (changes.remixAllowed !== undefined) { sets.push('remix_allowed = ?'); params.remixAllowed = changes.remixAllowed; }
  if (changes.location !== undefined) { sets.push('location = ?'); params.location = changes.location; }
  if (changes.soundId !== undefined) { sets.push('sound_id = ?'); params.soundId = changes.soundId; }
  if (sets.length) {
    params.updatedAt = Date.now();
    params.id = postId;
    run(`UPDATE posts SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, params);
  }

  if (changes.caption !== undefined) {
    run('DELETE FROM post_hashtags WHERE post_id = ?', { postId });
    run('DELETE FROM mentions WHERE post_id = ?', { postId });
    extractHashtags(changes.caption).forEach((tag, index) => {
      const hashtagId = upsertHashtag(tag);
      run('INSERT OR IGNORE INTO post_hashtags (post_id, hashtag_id, position) VALUES (?, ?, ?)', { postId, hashtagId, position: index });
      run('UPDATE hashtags SET use_count = use_count + 1 WHERE id = ?', { hashtagId });
    });
    for (const mentioned of resolveMentionedUsers(changes.caption)) {
      run('INSERT OR IGNORE INTO mentions (post_id, user_id) VALUES (?, ?)', { postId, userId: mentioned.id });
    }
  }
  return get('SELECT * FROM posts WHERE id = ?', { id: postId });
}

export function deletePost(postId, { actorId, actorRole = 'user' } = {}) {
  const post = get('SELECT * FROM posts WHERE id = ?', { id: postId });
  if (!post) throw notFound('post_not_found', 'Post nao encontrado');
  if (post.author_id !== actorId && actorRole === 'user') {
    throw forbidden('not_post_author', 'Somente o autor pode remover este post');
  }
  const now = Date.now();
  transaction(() => {
    run("UPDATE posts SET status = 'deleted', deleted_at = ?, updated_at = ? WHERE id = ?", {
      deletedAt: now, updatedAt: now, id: postId,
    });
    if (post.repost_of_id) {
      run('UPDATE posts SET repost_count = MAX(0, repost_count - 1) WHERE id = ?', { id: post.repost_of_id });
    }
    run('DELETE FROM hidden_posts WHERE post_id = ?', { postId });
  });
  return true;
}

export function getPost(postId, { includeDeleted = false } = {}) {
  const post = get('SELECT * FROM posts WHERE id = ?', { id: postId });
  if (!post) return null;
  if (post.status === 'deleted' && !includeDeleted) return null;
  return post;
}

export function incrementView(postId) {
  run('UPDATE posts SET view_count = view_count + 1 WHERE id = ?', { id: postId });
}

// --------------------------------------------------------------------------
// Feeds
// --------------------------------------------------------------------------
const BASE_FEED_FILTER = `
  p.status = 'published'
  AND p.type NOT IN ('repost', 'live')
    -- Post de TEXTO nao tem linha na tabela media: sem o COALESCE o NULL faz
    -- a comparacao virar NULL e some com o post do feed.
    AND COALESCE(m.status, 'none') <> 'failed'
    -- 'pending' entra: entre o upload e o inicio do processamento o autor
    -- precisa ver o proprio post (com o selo "Processando video").
    AND (
      p.media_id IS NULL
      OR m.status IN ('ready', 'processing', 'pending')
      OR p.type = 'text'
      -- (Item 16) 'audio' nao passa pelo processamento de video: o upload de
      -- audio nao entra na fila do ffmpeg, entao o status da media nunca vira
      -- 'ready' pelo caminho do video e o post sumia do feed.
      OR p.type = 'audio'
    )
`;

/**
 * Filtro de visibilidade DA CONTA em SQL, aplicavel a qualquer feed.
 *
 * Um post so entra no feed quando o autor e visivel para o espectador:
 *  - o proprio autor;
 *  - conta publica (e nao "somente amigos");
 *  - conta "somente amigos" com amizade MUTUA.
 *
 * `:viewerId` pode ser nulo (anonimo): nesse caso so passa conta publica.
 * Sem este filtro, posts de contas privadas vazavam no feed.
 */
const ACCOUNT_VISIBILITY_FILTER = `
  (
    :viewerId IS NOT NULL AND p.author_id = :viewerId
  )
  OR EXISTS (
    SELECT 1 FROM profiles pr
     WHERE pr.user_id = p.author_id
       AND pr.account_privacy = 'public'
       AND pr.friend_only = 0
  )
  OR (
    :viewerId IS NOT NULL
    AND EXISTS (SELECT 1 FROM profiles pr2
                 WHERE pr2.user_id = p.author_id AND pr2.friend_only = 1)
    AND EXISTS (SELECT 1 FROM friendships f1
                 WHERE f1.user_id = :viewerId AND f1.friend_id = p.author_id)
    AND EXISTS (SELECT 1 FROM friendships f2
                 WHERE f2.user_id = p.author_id AND f2.friend_id = :viewerId)
  )
`;

/**
 * Feed "Para voce": historico global de publicacoes publicas, em ordem
 * cronologica estavel. `postId` aplica os mesmos filtros de elegibilidade ao
 * consultar um evento realtime individual.
 */
export function forYouFeed({ viewer = null, limit = 12, cursor = null, offset = null, postId = null } = {}) {
  const viewerId = viewer?.id ?? null;
  const params = {
    limit,
    offset: offset ?? 0,
    nowMs: Date.now(),
    viewerId,
    affinity: viewerId,
    skipViewer: viewerId,
    pending: 'pending',
    postId,
  };

  const where = [
    BASE_FEED_FILTER,
    "p.visibility = 'public'",
    `EXISTS (
      SELECT 1 FROM profiles public_profile
       WHERE public_profile.user_id = p.author_id
         AND public_profile.account_privacy = 'public'
         AND public_profile.friend_only = 0
    )`,
    '(:viewerId IS NULL OR NOT EXISTS (SELECT 1 FROM hidden_posts hp WHERE hp.post_id = p.id AND hp.user_id = :viewerId))',
    `(:viewerId IS NULL OR NOT EXISTS (
        SELECT 1 FROM blocks b
         WHERE (b.blocker_id = :viewerId AND b.blocked_id = p.author_id)
            OR (b.blocker_id = p.author_id AND b.blocked_id = :viewerId)))`,
    `NOT EXISTS (
      SELECT 1 FROM follows fl
       WHERE fl.follower_id = :viewerId AND fl.followee_id = p.author_id AND fl.status = :pending)`,
    '(:postId IS NULL OR p.id = :postId)',
  ];

  const affinity = `
    (:affinity IS NULL) * 0.0
    + COALESCE((SELECT COUNT(*) * 3.0 FROM post_hashtags ph
                  JOIN watch_events we ON we.post_id = ph.post_id AND we.user_id = :affinity
                 WHERE ph.post_id = p.id), 0)
    + COALESCE((SELECT COUNT(*) * 2.0 FROM likes l
                  WHERE l.post_id = p.id AND l.user_id = :affinity), 0)
    + COALESCE((SELECT COUNT(*) * 6.0 FROM follows f
                  WHERE f.follower_id = :affinity AND f.followee_id = p.author_id
                    AND f.status = 'accepted'), 0)`;

  const sql = `
    SELECT p.*, m.status AS media_status,
      (${affinity}) AS affinity,
      (:nowMs - COALESCE(p.published_at, p.created_at)) / 3600000.0 AS age_hours,
      (p.like_count * 1.0 + p.comment_count * 2.0 + p.repost_count * 3.0 + p.view_count * 0.05) AS engagement
    FROM posts p
    LEFT JOIN media m ON m.id = p.media_id
    WHERE ${where.join('\n      AND ')}
    -- Item 5: a ordenacao do "Para voce" e CRONOLOGICA de verdade, pelo
    -- timestamp real de publicacao (mais novo -> mais antigo). A pontuacao
    -- por engajamento/afinidade entrava no sort e fazia video antigo subir
    -- acima de video novo, alem de tornar a ordem imprevisivel entre
    -- paginas. Os valores continuam no SELECT para uso do cliente.
    ORDER BY COALESCE(p.published_at, p.created_at) DESC, p.id DESC
    LIMIT :limit OFFSET :offset
  `;

  const rows = all(sql, params);
  return rows.map((row) => hydrate(row, viewer));
}

export function followingFeed({ viewer, limit = 12, cursor = null, offset = null }) {
  if (!viewer) throw unauthorized('login_required', 'Faca login para ver o feed de quem voce segue');
  const viewerId = viewer.id;
  const params = {
    limit, now: Date.now(), viewerId, pending: 'pending',
    offset: offset ?? 0, accepted: 'accepted',
  };
  const rows = all(
    `SELECT p.*, m.status AS media_status FROM posts p
      LEFT JOIN media m ON m.id = p.media_id
      WHERE p.status = 'published'
        AND p.visibility <> 'private'
        AND EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = :viewerId AND f.followee_id = p.author_id AND f.status = :accepted)
        AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = :viewerId AND b.blocked_id = p.author_id) OR (b.blocker_id = p.author_id AND b.blocked_id = :viewerId))
        AND NOT EXISTS (SELECT 1 FROM hidden_posts hp WHERE hp.post_id = p.id AND hp.user_id = :viewerId)
        AND (${ACCOUNT_VISIBILITY_FILTER})
      ORDER BY COALESCE(p.published_at, p.created_at) DESC, p.id DESC
      LIMIT :limit OFFSET :offset`,
    params,
  );
  return rows.map((row) => hydrate(row, viewer));
}

/** Feed de amigos: apenas relacoes mutuas. */
export function friendsFeed({ viewer, limit = 12, offset = null }) {
  if (!viewer) throw unauthorized('login_required', 'Faca login para ver o feed de amigos');
  const viewerId = viewer.id;
  const params = { limit, viewerId, accepted: 'accepted', offset: offset ?? 0 };
  const rows = all(
    `SELECT p.*, m.status AS media_status FROM posts p
      LEFT JOIN media m ON m.id = p.media_id
      WHERE p.status = 'published'
        AND EXISTS (
          SELECT 1 FROM friendships f1
          WHERE f1.user_id = :viewerId AND f1.friend_id = p.author_id
            AND EXISTS (SELECT 1 FROM friendships f2 WHERE f2.user_id = p.author_id AND f2.friend_id = :viewerId)
        )
        AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = :viewerId AND b.blocked_id = p.author_id) OR (b.blocker_id = p.author_id AND b.blocked_id = :viewerId))
        AND NOT EXISTS (SELECT 1 FROM hidden_posts hp WHERE hp.post_id = p.id AND hp.user_id = :viewerId)
      ORDER BY COALESCE(p.published_at, p.created_at) DESC, p.id DESC
      LIMIT :limit OFFSET :offset`,
    params,
  );
  return rows.map((row) => hydrate(row, viewer));
}

function hydrate(row, viewer) {
  const post = get('SELECT * FROM posts WHERE id = ?', { id: row.id });
  if (!post) return null;
  const repostOf = post.repost_of_id ? get('SELECT * FROM posts WHERE id = ?', { id: post.repost_of_id }) : null;
  return serializePost(post, viewer, { repostOf });
}

export function userPosts({ userId, viewer, limit = 18, offset = 0, type = null }) {
  const params = { userId, limit, offset, published: 'published' };
  let typeFilter = '';
  if (type) {
    typeFilter = 'AND p.type = :type';
    params.type = type;
  }
  const rows = all(
    `SELECT p.id FROM posts p
      WHERE p.author_id = :userId AND p.status = :published ${typeFilter}
      ORDER BY p.published_at DESC LIMIT :limit OFFSET :offset`,
    params,
  );
  const out = [];
  for (const row of rows) {
    const post = get('SELECT * FROM posts WHERE id = ?', { id: row.id });
    if (!post || !canViewPost(post, viewer)) continue;
    const repostOf = post.repost_of_id ? get('SELECT * FROM posts WHERE id = ?', { id: post.repost_of_id }) : null;
    out.push(serializePost(post, viewer, { repostOf }));
  }
  return out;
}

export function trendingPosts({ viewer, limit = 24, windowMs = 48 * 60 * 60 * 1000 }) {
  const rows = all(
    `SELECT p.*, m.status AS media_status FROM posts p
      LEFT JOIN media m ON m.id = p.media_id
      WHERE p.status = 'published' AND p.published_at > :since AND p.visibility = 'public'
      ORDER BY (p.like_count * 1.0 + p.comment_count * 2.0 + p.repost_count * 3.0 + p.view_count * 0.1) DESC
      LIMIT :limit`,
    { since: Date.now() - windowMs, limit },
  );
  return rows.map((row) => hydrate(row, viewer));
}

export function relatedPosts(post, viewer, limit = 12) {
  const hashtagIds = all('SELECT hashtag_id FROM post_hashtags WHERE post_id = ?', { postId: post.id }).map((r) => r.hashtag_id);
  const out = [];
  const seen = new Set([post.id]);
  if (post.sound_id) {
    const sameSound = all(
      `SELECT p.id FROM post_sounds ps JOIN posts p ON p.id = ps.post_id
        WHERE ps.sound_id = :soundId AND p.status = 'published' AND p.id <> :postId
        ORDER BY p.published_at DESC LIMIT :limit`,
      { soundId: post.sound_id, postId: post.id, limit },
    );
    for (const row of sameSound) {
      const p = get('SELECT * FROM posts WHERE id = ?', { id: row.id });
      if (p && !seen.has(p.id) && canViewPost(p, viewer)) { seen.add(p.id); out.push(serializePost(p, viewer)); }
    }
  }
  for (const hashtagId of hashtagIds) {
    if (out.length >= limit) break;
    const rows = all(
      `SELECT p.id FROM post_hashtags ph JOIN posts p ON p.id = ph.post_id
        WHERE ph.hashtag_id = :hashtagId AND p.status = 'published'
        ORDER BY (p.like_count + p.comment_count * 2 + p.repost_count * 3) DESC
        LIMIT :limit`,
      { hashtagId, limit },
    );
    for (const row of rows) {
      if (out.length >= limit) break;
      if (seen.has(row.id)) continue;
      const p = get('SELECT * FROM posts WHERE id = ?', { id: row.id });
      if (p && canViewPost(p, viewer)) { seen.add(p.id); out.push(serializePost(p, viewer)); }
    }
  }
  return out.slice(0, limit);
}

export function hashtagPosts({ tag, viewer, limit = 24, offset = 0, order = 'top' }) {
  const hashtag = get('SELECT * FROM hashtags WHERE tag = ?', { tag: normalizeHashtag(tag) });
  if (!hashtag) return { hashtag: null, posts: [] };
  const orderBy = order === 'recent' ? 'p.published_at DESC' : '(p.like_count + p.comment_count * 2 + p.repost_count * 3) DESC, p.published_at DESC';
  const rows = all(
    `SELECT p.id FROM posts p
      JOIN post_hashtags ph ON ph.post_id = p.id AND ph.hashtag_id = :hashtagId
      WHERE p.status = 'published'
      ORDER BY ${orderBy}
      LIMIT :limit OFFSET :offset`,
    { hashtagId: hashtag.id, limit, offset },
  );
  const posts = [];
  for (const row of rows) {
    const post = get('SELECT * FROM posts WHERE id = ?', { id: row.id });
    if (!post || !canViewPost(post, viewer)) continue;
    const repostOf = post.repost_of_id ? get('SELECT * FROM posts WHERE id = ?', { id: post.repost_of_id }) : null;
    posts.push(serializePost(post, viewer, { repostOf }));
  }
  return {
    hashtag: { id: hashtag.id, tag: hashtag.tag, useCount: hashtag.use_count, viewCount: hashtag.view_count },
    posts,
  };
}

export function soundPage({ soundId, viewer, limit = 24, offset = 0 }) {
  const sound = get('SELECT * FROM sounds WHERE id = ?', { soundId });
  if (!sound) throw notFound('sound_not_found', 'Som nao encontrado');
  const rows = all(
    `SELECT p.id FROM posts p
      JOIN post_sounds ps ON ps.post_id = p.id AND ps.sound_id = :soundId
      WHERE p.status = 'published'
      ORDER BY p.published_at DESC LIMIT :limit OFFSET :offset`,
    { soundId, limit, offset },
  );
  const posts = rows.map((r) => serializePost(get('SELECT * FROM posts WHERE id = ?', { id: r.id }), viewer));
  const media = sound.media_id ? get('SELECT * FROM media WHERE id = ?', { mediaId: sound.media_id }) : null;
  const saved = viewer ? Boolean(scalar('SELECT 1 FROM sound_saves WHERE user_id = ? AND sound_id = ?', { userId: viewer.id, soundId }, 0)) : false;
  return {
    sound: {
      id: sound.id,
      title: sound.title,
      artist: sound.artist ?? '',
      isOriginal: Boolean(sound.is_original),
      license: sound.license,
      durationMs: sound.duration_ms ?? 0,
      useCount: sound.use_count ?? 0,
      url: media ? `/api/media/stream?key=${encodeURIComponent(`${media.bucket}/${media.storage_key}`)}` : null,
      saved,
    },
    posts,
  };
}

export function userLikedPosts({ userId, viewer, limit = 24, offset = 0 }) {
  const rows = all(
    `SELECT post_id FROM likes WHERE user_id = :userId ORDER BY created_at DESC LIMIT :limit OFFSET :offset`,
    { userId, limit, offset },
  );
  const out = [];
  for (const row of rows) {
    const post = get('SELECT * FROM posts WHERE id = ?', { id: row.post_id });
    if (post && canViewPost(post, viewer)) out.push(serializePost(post, viewer));
  }
  return out;
}

export function userReposts({ userId, viewer, limit = 24, offset = 0 }) {
  const rows = all(
    `SELECT p.id FROM posts p
      WHERE p.author_id = :userId AND p.status = 'published' AND p.type = 'repost'
      ORDER BY p.published_at DESC LIMIT :limit OFFSET :offset`,
    { userId, limit, offset },
  );
  return rows.map((r) => {
    const post = get('SELECT * FROM posts WHERE id = ?', { id: r.id });
    const original = post?.repost_of_id ? get('SELECT * FROM posts WHERE id = ?', { id: post.repost_of_id }) : null;
    if (original && !canViewPost(original, viewer)) return null;
    return serializePost(post, viewer, { repostOf: original });
  }).filter(Boolean);
}

export function favoritesFeed({ viewer, limit = 24, offset = 0 }) {
  if (!viewer) return [];
  const rows = all(
    `SELECT p.id FROM favorites f JOIN posts p ON p.id = f.post_id
      WHERE f.user_id = :viewerId AND p.status = 'published'
      ORDER BY f.created_at DESC LIMIT :limit OFFSET :offset`,
    { viewerId: viewer.id, limit, offset },
  );
  const out = [];
  for (const row of rows) {
    const post = get('SELECT * FROM posts WHERE id = ?', { id: row.id });
    if (post && canViewPost(post, viewer)) out.push(serializePost(post, viewer));
  }
  return out;
}

export function historyFeed({ viewer, limit = 24, offset = 0 }) {
  if (!viewer) return [];
  const rows = all(
    `SELECT post_id, COUNT(*) AS views, MAX(created_at) AS last_seen
       FROM watch_events WHERE user_id = :viewerId
      GROUP BY post_id ORDER BY last_seen DESC LIMIT :limit OFFSET :offset`,
    { viewerId: viewer.id, limit, offset },
  );
  const out = [];
  for (const row of rows) {
    const post = get('SELECT * FROM posts WHERE id = ?', { id: row.post_id });
    if (post && canViewPost(post, viewer)) out.push(serializePost(post, viewer));
  }
  return out;
}

export function collectionsFor(userId, viewer, limit = 50, offset = 0) {
  const rows = all(
    `SELECT * FROM collections WHERE user_id = :userId ORDER BY updated_at DESC LIMIT :limit OFFSET :offset`,
    { userId, limit, offset },
  );
  return rows.map((c) => serializeCollection(c, viewer));
}

export function serializeCollection(c, viewer) {
  const items = all(
    `SELECT p.id FROM collection_items ci JOIN posts p ON p.id = ci.post_id
      WHERE ci.collection_id = :collectionId ORDER BY ci.position ASC, ci.created_at DESC`,
    { collectionId: c.id },
  );
  const posts = items.map((r) => get('SELECT * FROM posts WHERE id = ?', { id: r.id }))
    .filter((p) => p && canViewPost(p, viewer))
    .map((p) => serializePost(p, viewer));
  return {
    id: c.id,
    name: c.name,
    description: c.description ?? '',
    privacy: c.privacy,
    itemCount: posts.length,
    createdAt: c.created_at,
    updatedAt: c.updated_at,
    posts,
  };
}

// --------------------------------------------------------------------------
// Interacoes (o contador e sempre recalculado do zero: nunca "fake")
// --------------------------------------------------------------------------
export function toggleLike({ userId, postId }) {
  const post = get('SELECT * FROM posts WHERE id = ?', { id: postId });
  if (!post) throw notFound('post_not_found', 'Post nao encontrado');
  const existing = get('SELECT 1 AS ok FROM likes WHERE user_id = ? AND post_id = ?', { userId, postId });
  const liked = !existing;
  transaction(() => {
    if (liked) {
      run('INSERT OR IGNORE INTO likes (user_id, post_id, created_at) VALUES (?, ?, ?)', { userId, postId, ts: Date.now() });
    } else {
      run('DELETE FROM likes WHERE user_id = ? AND post_id = ?', { userId, postId });
    }
    syncCount(postId, 'likes');
  });
  return { liked, counts: countsFor(postId) };
}

export function toggleFavorite({ userId, postId }) {
  const post = get('SELECT * FROM posts WHERE id = ?', { id: postId });
  if (!post) throw notFound('post_not_found', 'Post nao encontrado');
  const existing = get('SELECT 1 AS ok FROM favorites WHERE user_id = ? AND post_id = ?', { userId, postId });
  const favorited = !existing;
  if (favorited) {
    run('INSERT OR IGNORE INTO favorites (user_id, post_id, created_at) VALUES (?, ?, ?)', { userId, postId, ts: Date.now() });
  } else {
    run('DELETE FROM favorites WHERE user_id = ? AND post_id = ?', { userId, postId });
  }
  return { favorited, counts: countsFor(postId) };
}

/**
 * Recalcula um contador a partir da FONTE DE VERDADE (nunca incremento
 * acumulado). Idempotente: chamar duas vezes da o mesmo resultado.
 *
 * A chave e o nome logico do contador; a coluna real e sempre a mesma
 * (<name>_count em posts). `column` nunca vem do usuario: o mapa e fechado.
 */
const COUNTER_SOURCES = {
  likes: { column: 'like_count', sql: 'SELECT COUNT(*) AS c FROM likes WHERE post_id = :postId' },
  comments: {
    column: 'comment_count',
    sql: "SELECT COUNT(*) AS c FROM comments WHERE post_id = :postId AND status = 'published'",
  },
  reposts: {
    column: 'repost_count',
    sql: "SELECT COUNT(*) AS c FROM posts WHERE repost_of_id = :postId AND status = 'published'",
  },
  shares: { column: 'share_count', sql: 'SELECT COUNT(*) AS c FROM watch_events WHERE post_id = :postId AND shared = 1' },
  views: { column: 'view_count', sql: 'SELECT COUNT(*) AS c FROM watch_events WHERE post_id = :postId' },
};

export function syncCount(postId, counter) {
  const source = COUNTER_SOURCES[counter];
  if (!source) throw badRequest('invalid_counter', `Contador invalido: ${counter}`);
  const count = scalar(source.sql, { postId }, 0);
  run(`UPDATE posts SET ${source.column} = :count WHERE id = :id`, { count, id: postId });
  return count;
}

export function countsFor(postId) {
  const post = get('SELECT * FROM posts WHERE id = ?', { id: postId });
  if (!post) throw notFound('post_not_found', 'Post nao encontrado');
  return {
    likes: post.like_count ?? 0,
    comments: post.comment_count ?? 0,
    reposts: post.repost_count ?? 0,
    shares: post.share_count ?? 0,
    views: post.view_count ?? 0,
  };
}

export function recordShare(postId) {
  run('UPDATE posts SET share_count = share_count + 1 WHERE id = ?', { id: postId });
}

export function hidePost({ userId, postId, reason = 'not_interested' }) {
  run(
    `INSERT INTO hidden_posts (user_id, post_id, reason, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, post_id) DO UPDATE SET reason = excluded.reason`,
    { userId, postId, reason, ts: Date.now() },
  );
}

export function hidePostsByAuthor({ userId, authorId }) {
  const rows = all('SELECT id FROM posts WHERE author_id = ?', { authorId });
  for (const row of rows) hidePost({ userId, postId: row.id, reason: 'hidden_creator' });
  return rows.length;
}
