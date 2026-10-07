import { all, get } from '../db/index.js';
import { normalizeHashtag, normalizeUsername } from '../lib/ids.js';
import { getUserById, publicUser } from './users.js';
import { canViewPost } from './privacy.js';
import { serializePost } from './posts.js';

/**
 * Busca unificada: pessoas, @username, videos, hashtags e sons.
 * Cada tipo tem um score proprio e todos respeitam a privacidade.
 */
export function search({ query, viewer, limit = 20, types = ['all'] }) {
  const term = String(query || '').trim();
  if (!term) {
    return { query: term, people: [], posts: [], hashtags: [], sounds: [], total: 0 };
  }
  const like = `%${term.replace(/[%_]/g, (m) => `\\${m}`)}%`;
  const want = (type) => types.includes('all') || types.includes(type);
  const result = { query: term, people: [], posts: [], hashtags: [], sounds: [] };

  if (want('people')) {
    const rows = all(
      `SELECT u.id FROM users u
        WHERE u.status = 'active'
          AND (u.username_norm LIKE :like ESCAPE '\\' OR LOWER(u.display_name) LIKE :like ESCAPE '\\')
        ORDER BY
          (CASE WHEN u.username_norm = :exact THEN 0 ELSE 1 END),
          (SELECT COUNT(*) FROM follows f WHERE f.followee_id = u.id AND f.status = 'accepted') DESC
        LIMIT :limit`,
      { like, exact: normalizeUsername(term), limit },
    );
    result.people = rows.map((r) => publicUser(getUserById(r.id), viewer, { withCounts: true }));
  }

  if (want('posts')) {
    const rows = all(
      `SELECT p.id FROM posts p
        WHERE p.status = 'published' AND p.caption LIKE :like ESCAPE '\\' AND p.type <> 'repost'
        ORDER BY (p.like_count + p.comment_count * 2 + p.repost_count * 3) DESC
        LIMIT :limit`,
      { like, limit: limit * 2 },
    );
    for (const row of rows) {
      const post = get('SELECT * FROM posts WHERE id = ?', { id: row.id });
      if (post && canViewPost(post, viewer)) result.posts.push(serializePost(post, viewer));
      if (result.posts.length >= limit) break;
    }
  }

  if (want('hashtags')) {
    result.hashtags = all(
      `SELECT id, tag, use_count, view_count FROM hashtags
        WHERE tag LIKE :like ESCAPE '\\'
        ORDER BY (CASE WHEN tag = :exact THEN 0 ELSE 1 END), use_count DESC
        LIMIT :limit`,
      { like, exact: normalizeHashtag(term), limit: 10 },
    ).map((r) => ({ id: r.id, tag: `#${r.tag}`, useCount: r.use_count, viewCount: r.view_count }));
  }

  if (want('sounds')) {
    result.sounds = all(
      `SELECT id, title, artist, use_count FROM sounds
        WHERE LOWER(title) LIKE :like ESCAPE '\\' OR LOWER(artist) LIKE :like ESCAPE '\\'
        ORDER BY use_count DESC LIMIT :limit`,
      { like, limit: 10 },
    ).map((r) => ({
      id: r.id, title: r.title, artist: r.artist, useCount: r.use_count,
      url: soundUrl(r.id),
    }));
  }

  result.total = result.people.length + result.posts.length + result.hashtags.length + result.sounds.length;
  return result;
}

export function soundUrl(soundId) {
  const sound = get('SELECT media_id FROM sounds WHERE id = ?', { soundId });
  if (!sound?.media_id) return null;
  const media = get('SELECT bucket, storage_key FROM media WHERE id = ?', { mediaId: sound.media_id });
  return media ? `/api/media/stream?key=${encodeURIComponent(`${media.bucket}/${media.storage_key}`)}` : null;
}

/** Busca rapida (typeahead) para o cabecalho. */
export function quickSearch({ query, viewer, limit = 8 }) {
  const term = String(query || '').trim();
  if (!term) return [];
  const like = `%${term.replace(/[%_]/g, (m) => `\\${m}`)}%`;
  const out = [];
  const people = all(
    `SELECT id FROM users WHERE status = 'active' AND (username_norm LIKE :like ESCAPE '\\' OR LOWER(display_name) LIKE :like ESCAPE '\\')
      ORDER BY CASE WHEN username_norm = :exact THEN 0 ELSE 1 END, created_at DESC LIMIT :limit`,
    { like, exact: normalizeUsername(term), limit },
  );
  for (const p of people) {
    out.push({ type: 'user', id: p.id, label: `@${getUserById(p.id).username}`, sublabel: getUserById(p.id).display_name, url: `/@${getUserById(p.id).username}` });
  }
  const tags = all(
    `SELECT id, tag FROM hashtags WHERE tag LIKE :like ESCAPE '\\' ORDER BY use_count DESC LIMIT 5`,
    { like },
  );
  for (const t of tags) {
    out.push({ type: 'hashtag', id: t.id, label: `#${t.tag}`, sublabel: 'hashtag', url: `/tag/${t.tag}` });
  }
  const sounds = all(
    `SELECT id, title, artist FROM sounds WHERE LOWER(title) LIKE :like ESCAPE '\\' ORDER BY use_count DESC LIMIT 5`,
    { like },
  );
  for (const s of sounds) {
    out.push({ type: 'sound', id: s.id, label: s.title, sublabel: s.artist || 'som', url: `/sound/${s.id}` });
  }
  return out.slice(0, limit);
}

export function trendingHashtags({ limit = 20 }) {
  return all(
    `SELECT id, tag, use_count, view_count FROM hashtags
      ORDER BY use_count DESC, view_count DESC LIMIT ?`,
    { limit },
  ).map((r) => ({ id: r.id, tag: `#${r.tag}`, useCount: r.use_count, viewCount: r.view_count }));
}

export function popularSounds({ limit = 20 }) {
  return all(
    `SELECT s.id, s.title, s.artist, s.use_count, s.duration_ms, s.is_original, s.media_id
       FROM sounds s ORDER BY s.use_count DESC LIMIT ?`,
    { limit },
  ).map((r) => ({
    id: r.id,
    title: r.title,
    artist: r.artist ?? '',
    useCount: r.use_count ?? 0,
    durationMs: r.duration_ms ?? 0,
    isOriginal: Boolean(r.is_original),
    url: soundUrl(r.id),
  }));
}

export function explore({ viewer, limit = 24 }) {
  return {
    hashtags: trendingHashtags({ limit: 12 }),
    sounds: popularSounds({ limit: 12 }),
    posts: all(
      `SELECT p.id FROM posts p WHERE p.status = 'published' AND p.visibility = 'public'
        ORDER BY (p.like_count + p.comment_count * 2 + p.repost_count * 3) DESC LIMIT ?`,
      { limit },
    ).map((r) => serializePost(get('SELECT * FROM posts WHERE id = ?', { id: r.id }), viewer)).filter(Boolean),
  };
}
