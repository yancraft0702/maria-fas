import { all, get, run, scalar } from '../db/index.js';
import { newId } from '../lib/ids.js';
import { notFound, forbidden, badRequest } from '../lib/errors.js';
import { getUserById, publicUser, avatarUrlForKey, isMuted } from './users.js';
import { canViewStory } from './privacy.js';
import { createNotification } from './notifications.js';

const DEFAULT_DURATION = 5000;
const MAX_DURATION = 15000;
const STORY_TTL = 24 * 60 * 60 * 1000;

export function createStory({ authorId, type = 'image', mediaId = null, text = '', background = '#111111', durationMs = DEFAULT_DURATION, soundId = null }) {
  if (!['image', 'video', 'text'].includes(type)) throw badRequest('invalid_story_type', 'Tipo de story invalido');
  if (type !== 'text' && !mediaId) throw badRequest('media_required', 'Story exige midia');
  const duration = Math.max(2000, Math.min(MAX_DURATION, Number(durationMs) || DEFAULT_DURATION));
  const id = newId('sty');
  const now = Date.now();
  run(
    `INSERT INTO stories (id, author_id, media_id, type, text, background, duration_ms, sound_id, status, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'published', ?, ?)`,
    { id, authorId, mediaId, type, text, background, durationMs: duration, soundId, now, expiresAt: now + STORY_TTL },
  );
  return getStory(id, authorId);
}

export function getStory(storyId, viewerId = null) {
  const row = get('SELECT * FROM stories WHERE id = ?', { id: storyId });
  if (!row || row.status === 'deleted') return null;
  const media = row.media_id ? get('SELECT bucket, storage_key FROM media WHERE id = ?', { mediaId: row.media_id }) : null;
  const author = getUserById(row.author_id);
  const seen = viewerId
    ? Boolean(scalar('SELECT 1 FROM story_views WHERE story_id = ? AND viewer_id = ?', { storyId, viewerId }, 0))
    : false;
  return {
    id: row.id,
    type: row.type,
    text: row.text ?? '',
    background: row.background ?? '#111111',
    durationMs: row.duration_ms,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    expired: row.expires_at < Date.now() || row.status === 'expired',
    mediaUrl: media ? `/api/media/stream?key=${encodeURIComponent(`${media.bucket}/${media.storage_key}`)}` : null,
    author: publicUser(author),
    seen,
    viewCount: row.view_count ?? 0,
    replyCount: scalar('SELECT COUNT(*) AS c FROM story_replies WHERE story_id = ?', { storyId }, 0),
  };
}

export function deleteStory({ storyId, userId, actorRole = 'user' }) {
  const row = get('SELECT * FROM stories WHERE id = ?', { id: storyId });
  if (!row) throw notFound('story_not_found', 'Story nao encontrado');
  if (row.author_id !== userId && actorRole === 'user') throw forbidden('not_story_author', 'Somente o autor pode remover o story');
  run("UPDATE stories SET status = 'deleted', deleted_at = ? WHERE id = ?", { ts: Date.now(), id: storyId });
  return { deleted: true };
}

/** Stories visiveis para o usuario (respeita privacidade e bloqueios). */
export function storyTray({ viewer }) {
  expireOldStories();
  const viewerId = viewer?.id ?? null;
  const rows = all(
    `SELECT s.author_id, MAX(s.created_at) AS last_at,
            SUM(CASE WHEN s.id IN (SELECT story_id FROM story_views WHERE viewer_id = :viewerId) THEN 1 ELSE 0 END) AS seen_count,
            COUNT(*) AS total
       FROM stories s
      WHERE s.status = 'published' AND s.expires_at > :now
      GROUP BY s.author_id
      ORDER BY last_at DESC LIMIT 100`,
    { viewerId: viewerId ?? '', now: Date.now() },
  );
  const groups = [];
  for (const row of rows) {
    const author = getUserById(row.author_id);
    if (!author) continue;
    const stories = listAuthorStories({ authorId: row.author_id, viewer });
    if (!stories.length) continue;
    groups.push({
      author: publicUser(author, viewer),
      stories,
      allSeen: (row.seen_count ?? 0) >= stories.length,
      lastAt: row.last_at,
    });
  }
  const own = groups.filter((g) => viewerId && g.author.id === viewerId);
  const others = groups.filter((g) => !viewerId || g.author.id !== viewerId);
  return [...own, ...others];
}

export function listAuthorStories({ authorId, viewer }) {
  const rows = all(
    `SELECT * FROM stories WHERE author_id = ? AND status = 'published' AND expires_at > ?
      ORDER BY created_at ASC LIMIT 30`,
    { authorId, ts: Date.now() },
  );
  return rows.map((row) => getStory(row.id, viewer?.id ?? null));
}

export function markStoryViewed({ storyId, viewerId }) {
  const story = get('SELECT * FROM stories WHERE id = ?', { id: storyId });
  if (!story || story.status !== 'published') throw notFound('story_not_found', 'Story nao encontrado');
  if (!canViewStory(story, { id: viewerId })) throw forbidden('story_not_visible', 'Story indisponivel');
  if (story.author_id === viewerId) return { viewed: true };
  const existing = get('SELECT 1 FROM story_views WHERE story_id = ? AND viewer_id = ?', { storyId, viewerId });
  if (!existing) {
    run('INSERT OR IGNORE INTO story_views (story_id, viewer_id, seen_at) VALUES (?, ?, ?)', {
      storyId, viewerId, ts: Date.now(),
    });
    run('UPDATE stories SET view_count = view_count + 1 WHERE id = ?', { id: storyId });
  }
  return { viewed: true };
}

export function storyViewers({ storyId, viewerId }) {
  const story = get('SELECT * FROM stories WHERE id = ?', { id: storyId });
  if (!story) throw notFound('story_not_found', 'Story nao encontrado');
  if (story.author_id !== viewerId) throw forbidden('not_story_author', 'Somente o autor ve a lista');
  return all(
    `SELECT u.id, u.username, u.display_name, u.avatar_key, u.avatar_version, v.seen_at
       FROM story_views v JOIN users u ON u.id = v.viewer_id
      WHERE v.story_id = ? ORDER BY v.seen_at DESC LIMIT 200`,
    { storyId },
  ).map((r) => ({
    id: r.id,
    username: r.username,
    displayName: r.display_name,
    seenAt: r.seen_at,
    avatarUrl: avatarUrlForKey(r.avatar_key, r.avatar_version),
  }));
}

export function replyStory({ storyId, authorId, body = '', reaction = '' }) {
  const story = get('SELECT * FROM stories WHERE id = ?', { id: storyId });
  if (!story || story.status !== 'published') throw notFound('story_not_found', 'Story nao encontrado');
  const id = newId('sry');
  run(
    'INSERT INTO story_replies (id, story_id, author_id, body, reaction, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    { id, storyId, authorId, body, reaction, now: Date.now() },
  );
  if (story.author_id !== authorId && !isMuted(story.author_id, 'user', authorId)) {
    createNotification({
      userId: story.author_id, actorId: authorId, type: 'story_reply',
      entityType: 'story', entityId: storyId, body: body || reaction,
    });
  }
  return { id, storyId, createdAt: Date.now() };
}

export function storyReplies({ storyId, limit = 50 }) {
  return all(
    `SELECT r.*, u.username, u.display_name, u.avatar_key, u.avatar_version
       FROM story_replies r JOIN users u ON u.id = r.author_id
      WHERE r.story_id = ? ORDER BY r.created_at ASC LIMIT ?`,
    { storyId, limit },
  ).map((r) => ({
    id: r.id,
    body: r.body,
    reaction: r.reaction,
    createdAt: r.created_at,
    author: {
      id: r.author_id,
      username: r.username,
      displayName: r.display_name,
      avatarUrl: avatarUrlForKey(r.avatar_key, r.avatar_version),
    },
  }));
}

/** Expiracao real: o banco e atualizado, nao apenas escondido. */
export function expireOldStories() {
  return run(
    "UPDATE stories SET status = 'expired' WHERE status = 'published' AND expires_at < ?",
    { ts: Date.now() },
  ).changes;
}

export function purgeExpiredStories(olderThanMs = 7 * 86400000) {
  return run(
    "DELETE FROM stories WHERE (status = 'expired' OR status = 'deleted') AND COALESCE(deleted_at, created_at) < ?",
    { ts: Date.now() - olderThanMs },
  ).changes;
}
