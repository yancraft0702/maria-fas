import { all, get, run, transaction } from '../db/index.js';
import { newId } from '../lib/ids.js';
import { hidePostsByAuthor, syncCount } from './posts.js';
/**
 * Registro de sinais de consumo. Cada evento e' gravado com os sinais reais
 * observados; a recomendacao usa apenas estes dados + conteudo publico.
 */
export function recordWatchEvent({
  userId, postId, watchMs = 0, completed = false, replayed = false, skipped = false,
  liked = false, commented = false, shared = false, favorited = false, reposted = false,
  followedAuthor = false, profileVisited = false,
}) {
  if (!userId || !postId) return null;
  const id = newId('wch');
  run(
    `INSERT INTO watch_events (id, user_id, post_id, watch_ms, completed, replays, skipped,
       liked, commented, shared, favorited, reposted, followed_author, profile_visited, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    {
      id, userId, postId, watchMs: Math.max(0, Math.min(24 * 60 * 60 * 1000, Number(watchMs) || 0)),
      completed: completed ? 1 : 0, replays: replayed ? 1 : 0, skipped: skipped ? 1 : 0,
      liked: liked ? 1 : 0, commented: commented ? 1 : 0, shared: shared ? 1 : 0,
      favorited: favorited ? 1 : 0, reposted: reposted ? 1 : 0,
      followedAuthor: followedAuthor ? 1 : 0, profileVisited: profileVisited ? 1 : 0,
      now: Date.now(),
    },
  );
  if (completed || skipped) {
    run('UPDATE posts SET view_count = view_count + 1 WHERE id = ?', { id: postId });
    syncCount(postId, 'views');
  }
  // Interesse por hashtag: ponderado por sinais de engajamento.
  if (userId) updateInterestsFromPost(userId, postId, {
    completed, skipped, liked, commented, shared, favorited, reposted, followedAuthor,
  });
  return id;
}

const WEIGHTS = {
  followedAuthor: 6, reposted: 5, commented: 4, shared: 3.5, favorited: 3,
  liked: 2.5, completed: 1.5, replayed: 1.2, profileVisited: 0.6, skipped: -4,
};

function updateInterestsFromPost(userId, postId, signals) {
  let weight = 0;
  for (const [key, value] of Object.entries(WEIGHTS)) {
    if (signals[key]) weight += value;
  }
  if (!weight) return;
  const tags = all('SELECT hashtag_id FROM post_hashtags WHERE post_id = ?', { postId });
  if (!tags.length) return;
  const now = Date.now();
  transaction(() => {
    for (const tag of tags) {
      run(
        `INSERT INTO user_interests (user_id, kind, value, weight, updated_at) VALUES (?, 'hashtag', ?, ?, ?)
         ON CONFLICT(user_id, kind, value) DO UPDATE SET weight = MIN(50, MAX(-10, user_interests.weight + ?)), updated_at = ?`,
        { userId, hashtagId: tag.hashtag_id, weight, now, delta: weight * 0.25, ts: now },
      );
    }
  });
}

export function bumpInterest({ userId, kind, value, delta = 1 }) {
  run(
    `INSERT INTO user_interests (user_id, kind, value, weight, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, kind, value) DO UPDATE SET weight = MIN(50, MAX(-10, user_interests.weight + ?)), updated_at = ?`,
    { userId, kind, value, weight: delta, now: Date.now(), delta, ts: Date.now() },
  );
}

export function interests(userId, limit = 30) {
  return all(
    `SELECT ui.kind, ui.value, ui.weight, h.tag FROM user_interests ui
       LEFT JOIN hashtags h ON h.id = ui.value AND ui.kind = 'hashtag'
      WHERE ui.user_id = :userId AND ui.weight > 0
      ORDER BY ui.weight DESC LIMIT :limit`,
    { userId, limit },
  ).map((r) => ({ kind: r.kind, value: r.value, label: r.tag ? `#${r.tag}` : r.value, weight: Math.round(r.weight * 100) / 100 }));
}

export function recommendationSettings(userId) {
  let row = get('SELECT * FROM recommendation_settings WHERE user_id = ?', { userId });
  if (!row) {
    run('INSERT INTO recommendation_settings (user_id) VALUES (?)', { userId });
    row = get('SELECT * FROM recommendation_settings WHERE user_id = ?', { userId });
  }
  return {
    optOut: Boolean(row.opt_out),
    reducedMode: Boolean(row.reduced_mode),
    preferredLanguage: row.preferred_language,
    blockedCategories: safeJson(row.blocked_categories),
    resetAt: row.reset_at ?? null,
  };
}

function safeJson(json) {
  try { return JSON.parse(json || '[]'); } catch { return []; }
}

export function updateRecommendationSettings(userId, changes) {
  recommendationSettings(userId);
  const sets = [];
  const params = { userId, ts: Date.now() };
  if (changes.optOut !== undefined) { sets.push('opt_out = ?'); params.optOut = changes.optOut ? 1 : 0; }
  if (changes.reducedMode !== undefined) { sets.push('reduced_mode = ?'); params.reducedMode = changes.reducedMode ? 1 : 0; }
  if (changes.preferredLanguage !== undefined) { sets.push('preferred_language = ?'); params.preferredLanguage = changes.preferredLanguage; }
  if (changes.blockedCategories !== undefined) {
    sets.push('blocked_categories = ?');
    params.blockedCategories = JSON.stringify(changes.blockedCategories || []);
  }
  if (sets.length) run(`UPDATE recommendation_settings SET ${sets.join(', ')} WHERE user_id = ?`, params);
  return recommendationSettings(userId);
}

/** Reset completo: limpa sinais, interesses e ocultos. */
export function resetRecommendations(userId) {
  transaction(() => {
    run('DELETE FROM watch_events WHERE user_id = ?', { userId });
    run('DELETE FROM user_interests WHERE user_id = ?', { userId });
    run('DELETE FROM hidden_posts WHERE user_id = ?', { userId });
    run('UPDATE recommendation_settings SET opt_out = 0, reset_at = ?, blocked_categories = ? WHERE user_id = ?', {
      ts: Date.now(), blocked: '[]', userId,
    });
  });
  return { reset: true, at: Date.now() };
}

/** Bloqueia um criador em todo o feed deste usuario. */
export function blockCreator({ userId, creatorId }) {
  run('INSERT OR IGNORE INTO blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)', {
    blockerId: userId, blockedId: creatorId, ts: Date.now(),
  });
  run('DELETE FROM follows WHERE follower_id = ? AND followee_id = ?', { userId, creatorId });
  run('DELETE FROM friendships WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)', {
    a1: userId, b1: creatorId, a2: creatorId, b2: userId,
  });
  return { blocked: true, hiddenPosts: hidePostsByAuthor({ userId, authorId: creatorId }) };
}

export function watchStats(userId, days = 7) {
  const since = Date.now() - days * 86400000;
  const totals = get(
    `SELECT COUNT(*) AS events,
            COALESCE(SUM(watch_ms), 0) AS total_ms,
            COALESCE(SUM(completed), 0) AS completed,
            COALESCE(SUM(skipped), 0) AS skipped,
            COALESCE(SUM(liked), 0) AS liked,
            COALESCE(SUM(commented), 0) AS commented
       FROM watch_events WHERE user_id = :userId AND created_at > :since`,
    { userId, since },
  );
  return {
    days,
    events: totals?.events ?? 0,
    totalWatchMs: totals?.total_ms ?? 0,
    completed: totals?.completed ?? 0,
    skipped: totals?.skipped ?? 0,
    liked: totals?.liked ?? 0,
    commented: totals?.commented ?? 0,
    topHashtags: interests(userId, 10),
    creators: all(
      `SELECT u.id, u.username, COUNT(*) AS events, COALESCE(SUM(we.watch_ms), 0) AS watch_ms
         FROM watch_events we
         JOIN posts p ON p.id = we.post_id
         JOIN users u ON u.id = p.author_id
        WHERE we.user_id = :userId
        GROUP BY u.id
        ORDER BY watch_ms DESC
        LIMIT 10`,
      { userId },
    ),
  };
}
