import { all, get, run, transaction, scalar } from '../db/index.js';
import { newId, normalizeUsername, normalizeHashtag } from '../lib/ids.js';
import { badRequest, notFound, conflict, ValidationError } from '../lib/errors.js';
import { staffRoles } from './auth.js';

export function createProfile(userId) {
  run(
    `INSERT INTO profiles (user_id, updated_at) VALUES (?, ?)`,
    { userId, ts: Date.now() },
  );
}

export function createSettings(userId) {
  run('INSERT INTO settings (user_id, updated_at) VALUES (?, ?)', { userId, ts: Date.now() });
  run('INSERT INTO recommendation_settings (user_id) VALUES (?)', { userId });
}

export function createNotificationSettings(userId) {
  run('INSERT INTO notification_settings (user_id, updated_at) VALUES (?, ?)', { userId, ts: Date.now() });
}

export function getUserById(id, { includeDeleted = false } = {}) {
  if (!id) return null;
  const user = get('SELECT * FROM users WHERE id = ?', { id });
  if (!user) return null;
  if (user.status === 'deleted' && !includeDeleted) return null;
  return user;
}

export function getUserByUsername(username) {
  return get('SELECT * FROM users WHERE username_norm = ?', { usernameNorm: normalizeUsername(username) });
}

export function getUserByEmail(email) {
  return get('SELECT * FROM users WHERE email_normalized = ?', { emailNormalized: String(email || '').trim().toLowerCase() });
}

export function isUsernameAvailable(username, exceptUserId = null) {
  const norm = normalizeUsername(username);
  const row = exceptUserId
    ? get('SELECT id FROM users WHERE username_norm = ? AND id <> ?', { norm, id: exceptUserId })
    : get('SELECT id FROM users WHERE username_norm = ?', { norm });
  return !row;
}

export function assertUsernameAvailable(username, exceptUserId = null) {
  if (!isUsernameAvailable(username, exceptUserId)) {
    throw conflict('username_taken', 'Este nome de usuario ja esta em uso');
  }
}

export function getProfile(userId) {
  return get('SELECT * FROM profiles WHERE user_id = ?', { userId });
}

export function getSettings(userId) {
  return get('SELECT * FROM settings WHERE user_id = ?', { userId });
}

export function getNotificationSettings(userId) {
  return get('SELECT * FROM notification_settings WHERE user_id = ?', { userId });
}

export function assertSettingsExist(userId) {
  if (!getSettings(userId)) createSettings(userId);
  if (!getNotificationSettings(userId)) createNotificationSettings(userId);
}

/**
 * Serializacao publica de usuario. `viewer` e a linha do usuario que pediu
 * (com `role`) - decide exposicao de email/status/2FA.
 */
/** Dominio dos emails internos gerados no cadastro (nao digitados pelo usuario). */
const INTERNAL_EMAIL_DOMAIN = '@conta.mariafas.app';

export function isInternalEmail(email) {
  return String(email || '').toLowerCase().endsWith(INTERNAL_EMAIL_DOMAIN);
}

export function avatarUrlForKey(avatarKey, version = 0) {
  if (!avatarKey) return null;
  const key = String(avatarKey).replace(/^\/+/, '');
  const storageKey = key.startsWith('avatars/') ? key : `avatars/${key}`;
  return `/api/media/stream?key=${encodeURIComponent(storageKey)}&v=${encodeURIComponent(String(version ?? 0))}`;
}

export function publicUser(user, viewer = null, { withCounts = false } = {}) {
  if (!user) return null;
  const viewerId = viewer?.id ?? null;
  const isSelf = Boolean(viewerId && viewerId === user.id);
  const viewerIsStaff = Boolean(viewer && staffRoles().includes(viewer.role));
  const base = {
    id: user.id,
    username: user.username,
    // Nome de exibicao NUNCA e null: quando a conta nao preencheu, usamos o
    // proprio @usuario. Sem isto o frontend renderizava a string "null" na tela
    // (visivel no feed, perfil, busca e LIVE).
    displayName: user.display_name || user.username,
    bio: user.bio ?? '',
    website: user.website ?? '',
    location: user.location ?? '',
    avatarUrl: avatarUrlForKey(user.avatar_key, user.avatar_version),
    avatarVersion: user.avatar_version ?? 0,
    coverUrl: user.cover_key ? `/api/media/stream?key=${encodeURIComponent(user.cover_key)}` : null,
    role: user.role,
    isVerified: user.role === 'admin',
    createdAt: user.created_at,
  };
  if (isSelf || viewerIsStaff) {
    // Email sintetico (gerado no cadastro quando o usuario nao informa um) e
    // interno: nao e mostrado, senao a propria conta exibiria um endereco falso.
    if (!isInternalEmail(user.email)) base.email = user.email;
    base.emailVerified = Boolean(user.email_verified);
    base.status = user.status;
    base.statusReason = user.status_reason ?? null;
    base.statusUntil = user.status_until ?? null;
    base.totpEnabled = Boolean(user.totp_enabled);
  }
  if (withCounts) {
    Object.assign(base, getUserCounts(user.id));
  }
  return base;
}

export function getUserCounts(userId) {
  const followers = scalar('SELECT COUNT(*) AS c FROM follows WHERE followee_id = ? AND status = ?', { userId, status: 'accepted' }, 0);
  const following = scalar('SELECT COUNT(*) AS c FROM follows WHERE follower_id = ? AND status = ?', { userId, status: 'accepted' }, 0);
  const likes = scalar('SELECT COALESCE(SUM(like_count),0) AS c FROM posts WHERE author_id = ? AND status = ?', { userId, status: 'published' }, 0);
  const posts = scalar('SELECT COUNT(*) AS c FROM posts WHERE author_id = ? AND status = ?', { userId, status: 'published' }, 0);
  const reposts = scalar('SELECT COUNT(*) AS c FROM posts WHERE author_id = ? AND status = ? AND type = ?', { userId, status: 'published', type: 'repost' }, 0);
  const likesReceived = scalar('SELECT COUNT(*) AS c FROM likes l JOIN posts p ON p.id = l.post_id WHERE p.author_id = ?', { userId }, 0);
  const friends = scalar('SELECT COUNT(*) AS c FROM friendships WHERE user_id = ?', { userId }, 0);
  return {
    followerCount: followers,
    followingCount: following,
    likeCount: likesReceived,
    postCount: posts,
    repostCount: reposts,
    friendCount: friends,
  };
}

// --------------------------------------------------------------------------
// Seguindo / amigos / bloqueios
// --------------------------------------------------------------------------
export function getFollowState(followerId, followeeId) {
  if (!followerId || !followeeId) return null;
  return get('SELECT status FROM follows WHERE follower_id = ? AND followee_id = ?', { followerId, followeeId });
}

export function isFollowing(followerId, followeeId) {
  return getFollowState(followerId, followeeId)?.status === 'accepted';
}

/**
 * Amizade no MARIA FÃS e MUTUA: exige as duas direcoes na tabela.
 * (Uma unica linha nao pode satisfazer as duas condicoes; por isso sao dois
 * EXISTS independentes.)
 */
export function isFriend(aId, bId) {
  if (!aId || !bId || aId === bId) return false;
  const row = get(
    `SELECT 1 AS ok
       FROM friendships f1
      WHERE f1.user_id = :a1 AND f1.friend_id = :b1
        AND EXISTS (SELECT 1 FROM friendships f2 WHERE f2.user_id = :b2 AND f2.friend_id = :a2)`,
    { a1: aId, b1: bId, b2: bId, a2: aId },
  );
  return Boolean(row);
}

export function areFriendsMutual(aId, bId) {
  return isFriend(aId, bId);
}

export function isBlocked(blockerId, blockedId) {
  if (!blockerId || !blockedId) return false;
  return Boolean(get('SELECT 1 AS ok FROM blocks WHERE blocker_id = ? AND blocked_id = ?', { blockerId, blockedId }));
}

export function blockedEitherWay(aId, bId) {
  if (!aId || !bId || aId === bId) return false;
  const row = get(
    `SELECT 1 AS ok FROM blocks
      WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)`,
    { a1: aId, b1: bId, a2: bId, b2: aId },
  );
  return Boolean(row);
}

export function blockList(userId) {
  return all('SELECT blocked_id AS userId, created_at AS createdAt FROM blocks WHERE blocker_id = ? ORDER BY created_at DESC', { userId });
}

export function muteList(userId) {
  return all(
    'SELECT target_type AS targetType, target_id AS targetId, created_at AS createdAt FROM mutes WHERE user_id = ? ORDER BY created_at DESC',
    { userId },
  );
}

export function isMuted(userId, targetType, targetId) {
  return Boolean(
    get('SELECT 1 AS ok FROM mutes WHERE user_id = ? AND target_type = ? AND target_id = ?', { userId, targetType, targetId }),
  );
}

// --------------------------------------------------------------------------
// Mencoes e hashtags
// --------------------------------------------------------------------------
export function extractMentions(text) {
  const out = new Set();
  const re = /(^|[\s.,!?;:()\[\]"'`])(@([a-z0-9._]{3,24}))/gi;
  let m;
  while ((m = re.exec(String(text || ''))) !== null) {
    out.add(normalizeUsername(m[3]));
  }
  return [...out];
}

export function extractHashtags(text) {
  const out = [];
  const seen = new Set();
  const re = /(^|[\s.,!?;:()\[\]"'`])#([\p{L}\p{N}_]{1,40})/gu;
  let m;
  while ((m = re.exec(String(text || ''))) !== null) {
    const tag = normalizeHashtag(m[2]);
    if (seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out;
}

export function upsertHashtag(tag) {
  const norm = normalizeHashtag(tag);
  const existing = get('SELECT id FROM hashtags WHERE tag = ?', { norm });
  if (existing) return existing.id;
  const id = newId('hst');
  run('INSERT INTO hashtags (id, tag, created_at) VALUES (?, ?, ?)', { id, norm, ts: Date.now() });
  return id;
}

export function resolveMentionedUsers(text) {
  const users = [];
  for (const username of extractMentions(text)) {
    const user = getUserByUsername(username);
    if (user && user.status !== 'deleted') users.push(user);
  }
  return users;
}

export function assertValidUsernameFormat(username) {
  if (!/^[a-z0-9._]{3,24}$/i.test(String(username || ''))) {
    throw new ValidationError([{ field: 'username', message: 'Nome de usuario invalido' }]);
  }
}

export function touchLastSeen(userId) {
  run('UPDATE users SET last_seen_at = ? WHERE id = ?', { ts: Date.now(), id: userId });
}

export function updateUserProfile(userId, fields) {
  // A ordem das chaves do objeto DEVE seguir a ordem dos `?` da SQL.
  const sets = [];
  const params = {};

  const map = {
    displayName: 'display_name',
    bio: 'bio',
    website: 'website',
    location: 'location',
  };
  for (const [key, column] of Object.entries(map)) {
    if (fields[key] !== undefined) {
      sets.push(`${column} = ?`);
      params[column] = fields[key];
    }
  }
  if (fields.avatarKey !== undefined) {
    sets.push('avatar_key = ?', 'avatar_version = avatar_version + 1');
    params.avatar_key = fields.avatarKey;
  }
  if (fields.coverKey !== undefined) {
    sets.push('cover_key = ?');
    params.cover_key = fields.coverKey;
  }
  if (!sets.length) return getUserById(userId);

  // placeholders finais: updated_at e id
  params.updatedAt = Date.now();
  params.id = userId;
  run(`UPDATE users SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, params);
  return getUserById(userId);
}

export function changeUsername(userId, newUsername) {
  const user = getUserById(userId);
  if (!user) throw notFound('user_not_found', 'Usuario nao encontrado');
  if (user.username_norm === normalizeUsername(newUsername)) return user;
  assertUsernameAvailable(newUsername, userId);
  const norm = normalizeUsername(newUsername);
  transaction(() => {
    run('UPDATE users SET username = ?, username_norm = ?, updated_at = ? WHERE id = ?', {
      username: norm, norm, ts: Date.now(), id: userId,
    });
    // Preserva unicidade em posts/sons referenciados por @username em textos livres.
    run('UPDATE posts SET caption = REPLACE(caption, ?, ?) WHERE caption LIKE ?', {
      oldAt: `@${user.username}`, newAt: `@${norm}`, pattern: `%@${user.username}%`,
    });
  });
  return getUserById(userId);
}

export function setUserStatus({ userId, status, reason = null, until = null, expectedRole = null }) {
  const user = getUserById(userId, { includeDeleted: true });
  if (!user) throw notFound('user_not_found', 'Usuario nao encontrado');
  if (expectedRole && user.role !== expectedRole) {
    throw badRequest('role_immutable', 'O papel do usuario nao pode ser alterado por esta operacao');
  }
  run(
    `UPDATE users SET status = ?, status_reason = ?, status_until = ?, updated_at = ?, deleted_at = ? WHERE id = ?`,
    {
      status, reason, until, ts: Date.now(),
      deletedAt: status === 'deleted' ? Date.now() : null,
      id: userId,
    },
  );
  return getUserById(userId, { includeDeleted: true });
}

export function softDeleteAccount(userId) {
  const user = getUserById(userId);
  if (!user) throw notFound('user_not_found', 'Usuario nao encontrado');
  transaction(() => {
    run(
      `UPDATE users SET status = 'deleted', deleted_at = ?, updated_at = ? WHERE id = ?`,
      { deletedAt: Date.now(), updatedAt: Date.now(), id: userId },
    );
    run(`UPDATE posts SET status = 'deleted', deleted_at = ? WHERE author_id = ?`, { ts: Date.now(), id: userId });
    run('DELETE FROM push_subscriptions WHERE user_id = ?', { userId });
  });
}
