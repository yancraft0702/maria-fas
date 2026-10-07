import { all, get, run, transaction, scalar } from '../db/index.js';
import { newId } from '../lib/ids.js';
import { notFound, forbidden, badRequest, conflict, ValidationError } from '../lib/errors.js';
import { getUserById, publicUser, setUserStatus, getUserCounts } from './users.js';
import { revokeSessionsForUser } from './sessions.js';
import hub from '../realtime/hub.js';
import { EVENTS } from '../realtime/protocol.js';
import { deletePost } from './posts.js';
import { deleteComment } from './social.js';
import { endRoom, viewerCount } from './live.js';
import { createNotification } from './notifications.js';
import { deleteMessage } from './messaging.js';

export const REPORT_CATEGORIES = [
  'spam',
  'fraude',
  'assedio',
  'odio',
  'violencia',
  'exploracao',
  'sexual_proibido',
  'seguranca_infantil',
  'impersonacao',
  'malware',
  'direitos_autoriais',
  'ilegal',
  'outro',
];

export const REPORT_TARGETS = ['user', 'post', 'comment', 'message', 'live', 'sound', 'story'];

export const ENFORCEMENT_ACTIONS = ['warn', 'remove', 'restrict', 'mute', 'unmute', 'suspend', 'ban', 'unban', 'dismiss'];

export const MUTE_WINDOWS_MINUTES = [2, 4, 6, 10];

// --------------------------------------------------------------------------
// Denuncias
// --------------------------------------------------------------------------
export function createReport({ reporterId, targetType, targetId, category, details = '' }) {
  if (!REPORT_TARGETS.includes(targetType)) throw badRequest('invalid_report_target', 'Alvo de denuncia invalido');
  if (!REPORT_CATEGORIES.includes(category)) throw badRequest('invalid_report_category', 'Categoria de denuncia invalida');
  assertTargetExists(targetType, targetId);
  const existing = get('SELECT id FROM reports WHERE reporter_id = ? AND target_type = ? AND target_id = ?', {
    reporterId, targetType, targetId,
  });
  if (existing) throw conflict('already_reported', 'Voce ja denunciou este conteudo');
  const id = newId('rep');
  const now = Date.now();
  run(
    `INSERT INTO reports (id, reporter_id, target_type, target_id, category, details, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
    { id, reporterId, targetType, targetId, category, details, now, ts: now },
  );
  return getReport(id);
}

function assertTargetExists(targetType, targetId) {
  const table = {
    user: 'users', post: 'posts', comment: 'comments', message: 'messages',
    live: 'live_rooms', sound: 'sounds', story: 'stories',
  }[targetType];
  const row = get(`SELECT 1 AS ok FROM ${table} WHERE id = ?`, { id: targetId });
  if (!row) throw notFound('report_target_not_found', 'O conteudo denunciado nao existe mais');
}

export function getReport(reportId) {
  const row = get('SELECT * FROM reports WHERE id = ?', { id: reportId });
  if (!row) return null;
  return {
    id: row.id,
    targetType: row.target_type,
    targetId: row.target_id,
    category: row.category,
    details: row.details,
    status: row.status,
    resolution: row.resolution,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at ?? null,
    reporter: publicUser(getUserById(row.reporter_id)),
    assignedTo: row.assigned_to ? publicUser(getUserById(row.assigned_to)) : null,
  };
}

export function listReports({ status = null, limit = 50, offset = 0 }) {
  const params = { limit, offset };
  let filter = '';
  if (status) {
    filter = 'WHERE status = :status';
    params.status = status;
  }
  const rows = all(`SELECT id FROM reports ${filter} ORDER BY created_at DESC LIMIT :limit OFFSET :offset`, params);
  return rows.map((r) => getReport(r.id));
}

export function updateReportStatus({ reportId, moderatorId, status, resolution = '' }) {
  if (!['open', 'reviewing', 'resolved', 'rejected'].includes(status)) {
    throw badRequest('invalid_report_status', 'Status de denuncia invalido');
  }
  const report = get('SELECT * FROM reports WHERE id = ?', { id: reportId });
  if (!report) throw notFound('report_not_found', 'Denuncia nao encontrada');
  const now = Date.now();
  run(
    `UPDATE reports SET status = ?, resolution = ?, assigned_to = ?, updated_at = ?, resolved_at = ? WHERE id = ?`,
    { status, resolution, moderatorId, ts: now, resolvedAt: ['resolved', 'rejected'].includes(status) ? now : null, id: reportId },
  );
  logAction({ moderatorId, action: `report_${status}`, targetType: 'report', targetId: reportId, reason: resolution });
  if (status === 'resolved') {
    createNotification({
      userId: report.reporter_id, actorId: moderatorId, type: 'activity',
      body: `Sua denuncia foi analisada: ${report.category}`,
    });
  }
  return getReport(reportId);
}

// --------------------------------------------------------------------------
// Acoes de enforcement
// --------------------------------------------------------------------------
export function logAction({ moderatorId, action, targetType, targetId, reason = '', details = {} }) {
  const id = newId('mod');
  run(
    `INSERT INTO moderation_actions (id, moderator_id, action, target_type, target_id, reason, details_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    { id, moderatorId, action, targetType, targetId, reason, detailsJson: JSON.stringify(details), now: Date.now() },
  );
  return id;
}

export function warnUser({ moderatorId, userId, category, message }) {
  if (!REPORT_CATEGORIES.includes(category)) throw badRequest('invalid_warning_category', 'Categoria invalida');
  const id = newId('wrn');
  run(
    'INSERT INTO user_warnings (id, user_id, moderator_id, category, message, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    { id, userId, moderatorId, category, message, now: Date.now() },
  );
  logAction({ moderatorId, action: 'warn', targetType: 'user', targetId: userId, reason: message });
  createNotification({ userId, actorId: moderatorId, type: 'warning', body: `Voce recebeu um aviso: ${message || category}` });
  hub.publishToUser(userId, EVENTS.MODERATION, { action: 'warn', category, message });
  return { warned: true, id };
}

/**
 * Mute por janela fixa (2/4/6/10 minutos). `muted_until` no usuario e a
 * autoridade; o frontend so le.
 */
/**
 * Silencia um usuario por uma JANELA FIXA (2/4/6/10 minutos).
 *
 * Nao altera `users.status`: silenciar bloqueia ESCRITA, nao o login nem a
 * leitura. A sessao continua valida e o usuario recebe o evento MODERATION em
 * tempo real (a UI pode avisar).
 */
export function muteUser({ moderatorId, userId, minutes }) {
  const value = MUTE_WINDOWS_MINUTES.includes(Number(minutes))
    ? Number(minutes)
    : MUTE_WINDOWS_MINUTES[0];
  const until = Date.now() + value * 60 * 1000;
  const user = getUserById(userId, { includeDeleted: true });
  if (!user) throw notFound('user_not_found', 'Usuario nao encontrado');
  run('UPDATE users SET muted_until = ?, updated_at = ? WHERE id = ?', {
    until, ts: Date.now(), id: userId,
  });
  logAction({
    moderatorId,
    action: 'mute',
    targetType: 'user',
    targetId: userId,
    reason: `${value} minutos`,
    details: { until, minutes: value },
  });
  hub.publishToUser(userId, EVENTS.MODERATION, { action: 'muted', until, minutes: value });
  return { mutedUntil: until, minutes: value, until };
}

/** Silenciamento ainda ativo do usuario (usado pelo guarda de escrita). */
export function isUserMuted(userId) {
  const row = get('SELECT muted_until FROM users WHERE id = ?', { id: userId });
  if (!row?.muted_until) return false;
  if (row.muted_until <= Date.now()) {
    // Janela vencida: limpa para o proximo login nao ver resíduo.
    run('UPDATE users SET muted_until = NULL WHERE id = ?', { id: userId });
    return false;
  }
  return true;
}

/** Levanta o silenciamento antes do fim da janela. */
export function unmuteUser({ moderatorId, userId, reason = '' }) {
  run('UPDATE users SET muted_until = NULL, updated_at = ? WHERE id = ?', { ts: Date.now(), id: userId });
  logAction({
    moderatorId, action: 'unmute', targetType: 'user', targetId: userId, reason: reason || 'Silenciamento removido',
  });
  hub.publishToUser(userId, EVENTS.MODERATION, { action: 'unmuted' });
  return { unmuted: true };
}

export function suspendUser({ moderatorId, userId, reason = '', days = 7 }) {
  const until = Date.now() + Math.min(365, Math.max(1, Number(days) || 7)) * 24 * 60 * 60 * 1000;
  run("UPDATE users SET status = 'suspended', status_reason = ?, status_until = ?, updated_at = ? WHERE id = ?", {
    reason: reason || 'Suspenso pela moderacao', until, ts: Date.now(), id: userId,
  });
  logAction({ moderatorId, action: 'suspend', targetType: 'user', targetId: userId, reason, details: { until } });
  hub.disconnectUser(userId, 4403, 'suspended');
  hub.publishToUser(userId, EVENTS.MODERATION, { action: 'suspended', until });
  return { suspendedUntil: until };
}

/** Ban: invalida sessoes, desconecta realtime, encerra LIVE, bloqueia login. */
export function banUser({ moderatorId, userId, reason = '' }) {
  const user = getUserById(userId, { includeDeleted: true });
  if (!user) throw notFound('user_not_found', 'Usuario nao encontrado');
  if (user.role === 'admin') throw forbidden('cannot_ban_admin', 'Administradores nao podem ser banidos por este fluxo');
  transaction(() => {
    setUserStatus({ userId, status: 'banned', reason: reason || 'Banido pela moderacao' });
    revokeSessionsForUser(userId, 'banned');
    run('DELETE FROM push_subscriptions WHERE user_id = ?', { userId });
  });
  const liveRoom = get("SELECT id FROM live_rooms WHERE host_id = ? AND status = 'live'", { userId });
  if (liveRoom) {
    try { endRoom({ roomId: liveRoom.id, actorId: moderatorId, actorRole: 'admin', reason: 'host_banned' }); } catch { /* ja encerrada */ }
  }
  const closed = hub.disconnectUser(userId, 4403, 'banned');
  logAction({ moderatorId, action: 'ban', targetType: 'user', targetId: userId, reason, details: { socketsClosed: closed } });
  return { banned: true, socketsClosed: closed };
}

export function unbanUser({ moderatorId, userId, reason = '' }) {
  const user = getUserById(userId, { includeDeleted: true });
  if (!user) throw notFound('user_not_found', 'Usuario nao encontrado');
  setUserStatus({ userId, status: 'active', reason: null, until: null });
  logAction({ moderatorId, action: 'unban', targetType: 'user', targetId: userId, reason });
  return { unbanned: true };
}

export function restoreUser({ moderatorId, userId }) {
  run("UPDATE users SET status = 'active', status_reason = NULL, status_until = NULL, updated_at = ? WHERE id = ?", {
    ts: Date.now(), id: userId,
  });
  logAction({ moderatorId, action: 'restore', targetType: 'user', targetId: userId });
  return { restored: true };
}

/**
 * Enforcement unico para alvo + acao.
 */
export function enforce({ moderatorId, targetType, targetId, action, reason = '', minutes = 2, days = 7 }) {
  if (!ENFORCEMENT_ACTIONS.includes(action)) {
    throw ValidationError([{ field: 'action', message: `Acao invalida. Permitidas: ${ENFORCEMENT_ACTIONS.join(', ')}` }]);
  }
  switch (action) {
    case 'warn':
      return warnUser({ moderatorId, userId: targetId, category: 'outro', message: reason });
    case 'remove':
      if (targetType === 'post') return { removed: deletePost(targetId, { actorId: moderatorId, actorRole: 'moderator' }) };
      if (targetType === 'comment') return { removed: deleteComment({ commentId: targetId, userId: moderatorId, actorRole: 'moderator' }) };
      if (targetType === 'message') return { removed: deleteMessage({ messageId: targetId, userId: moderatorId, actorRole: 'moderator' }) };
      if (targetType === 'live') return endRoom({ roomId: targetId, actorId: moderatorId, actorRole: 'moderator', reason: 'moderation' });
      if (targetType === 'user') return suspendUser({ moderatorId, userId: targetId, reason, days: 1 });
      throw badRequest('unsupported_enforcement_target', `Nao e possivel remover ${targetType}`);
    case 'restrict':
      return restrictUser({ moderatorId, userId: targetId, reason });
    case 'mute':
      return muteUser({ moderatorId, userId: targetId, minutes });
    case 'unmute':
      return unmuteUser({ moderatorId, userId: targetId, reason });
    case 'suspend':
      return suspendUser({ moderatorId, userId: targetId, reason, days });
    case 'ban':
      return banUser({ moderatorId, userId: targetId, reason });
    case 'unban':
      return unbanUser({ moderatorId, userId: targetId, reason });
    case 'dismiss':
      return { dismissed: true };
    default:
      throw badRequest('unsupported_action', `Acao nao suportada: ${action}`);
  }
}

/** Restricao: conta vira privada e bloqueia novos seguidores. */
export function restrictUser({ moderatorId, userId, reason = '' }) {
  run(
    `UPDATE profiles SET account_privacy = 'private', who_can_follow = 'followers', updated_at = ?
      WHERE user_id = ?`,
    { ts: Date.now(), userId },
  );
  logAction({ moderatorId, action: 'restrict', targetType: 'user', targetId: userId, reason });
  createNotification({ userId, actorId: moderatorId, type: 'warning', body: 'Sua conta foi limitada pela moderacao' });
  return { restricted: true };
}

export function setUserRole({ actorId, userId, role, reason = '' }) {
  if (!['user', 'moderator', 'admin'].includes(role)) throw badRequest('invalid_role', 'Papel invalido');
  run('UPDATE users SET role = ?, updated_at = ? WHERE id = ?', { role, ts: Date.now(), id: userId });
  logAction({ moderatorId: actorId, action: 'set_role', targetType: 'user', targetId: userId, reason, details: { role } });
  return { role };
}

// --------------------------------------------------------------------------
// Consultas administrativas
// --------------------------------------------------------------------------
export function adminStats() {
  const now = Date.now();
  return {
    users: {
      total: scalar("SELECT COUNT(*) AS c FROM users WHERE status <> 'deleted'", {}, 0),
      active: scalar("SELECT COUNT(*) AS c FROM users WHERE status = 'active'", {}, 0),
      suspended: scalar("SELECT COUNT(*) AS c FROM users WHERE status = 'suspended'", {}, 0),
      banned: scalar("SELECT COUNT(*) AS c FROM users WHERE status = 'banned'", {}, 0),
      new24h: scalar('SELECT COUNT(*) AS c FROM users WHERE created_at > ?', { ts: now - 86400000 }, 0),
      online: hub.onlineUserCount(),
    },
    content: {
      posts: scalar("SELECT COUNT(*) AS c FROM posts WHERE status = 'published'", {}, 0),
      postsToday: scalar("SELECT COUNT(*) AS c FROM posts WHERE status = 'published' AND created_at > ?", { ts: now - 86400000 }, 0),
      comments: scalar("SELECT COUNT(*) AS c FROM comments WHERE status = 'published'", {}, 0),
      reportsOpen: scalar("SELECT COUNT(*) AS c FROM reports WHERE status IN ('open','reviewing')", {}, 0),
      drafts: scalar('SELECT COUNT(*) AS c FROM drafts', {}, 0),
    },
    live: {
      active: scalar("SELECT COUNT(*) AS c FROM live_rooms WHERE status = 'live'", {}, 0),
      totalToday: scalar('SELECT COUNT(*) AS c FROM live_rooms WHERE started_at > ?', { ts: now - 86400000 }, 0),
      viewers: all("SELECT id FROM live_rooms WHERE status = 'live'").reduce((acc, r) => acc + viewerCount(r.id), 0),
    },
    chat: {
      globalMessages: scalar('SELECT COUNT(*) AS c FROM global_chat', {}, 0),
      globalToday: scalar('SELECT COUNT(*) AS c FROM global_chat WHERE created_at > ?', { ts: now - 86400000 }, 0),
      dmToday: scalar('SELECT COUNT(*) AS c FROM messages WHERE created_at > ?', { ts: now - 86400000 }, 0),
      online: hub.onlineUserCount(),
    },
    effects: all('SELECT * FROM effect_usage_daily ORDER BY day DESC, count DESC LIMIT 10'),
  };
}

export function adminListUsers({ query = '', status = null, role = null, limit = 50, offset = 0 }) {
  const where = ["u.status <> 'deleted'"];
  const params = { limit, offset };
  if (query) {
    where.push('(u.username_norm LIKE :q OR u.email_normalized LIKE :q)');
    params.q = `%${query.toLowerCase()}%`;
  }
  if (status) { where.push('u.status = :status'); params.status = status; }
  if (role) { where.push('u.role = :role'); params.role = role; }
  const rows = all(
    `SELECT u.id FROM users u WHERE ${where.join(' AND ')} ORDER BY u.created_at DESC LIMIT :limit OFFSET :offset`,
    params,
  );
  return rows.map((r) => {
    const user = getUserById(r.id, { includeDeleted: true });
    return {
      ...publicUser(user, { id: 'admin' }),
      status: user.status,
      statusReason: user.status_reason,
      statusUntil: user.status_until,
      online: hub.isUserOnline(user.id),
      lastSeenAt: user.last_seen_at,
      counts: getUserCounts(user.id),
    };
  });
}

export function adminListContent({ type = 'post', query = '', limit = 50, offset = 0 }) {
  const like = `%${query}%`;
  if (type === 'post') {
    return all(
      `SELECT p.id, p.type, p.caption, p.status, p.visibility, p.like_count, p.comment_count, p.created_at,
              u.username, u.id AS author_id
         FROM posts p JOIN users u ON u.id = p.author_id
        WHERE p.status <> 'deleted' AND (:q = '%%' OR p.caption LIKE :q)
        ORDER BY p.created_at DESC LIMIT :limit OFFSET :offset`,
      { q: like, limit, offset },
    );
  }
  if (type === 'comment') {
    return all(
      `SELECT c.id, c.body, c.status, c.created_at, u.username, c.post_id
         FROM comments c JOIN users u ON u.id = c.author_id
        WHERE c.status <> 'deleted' AND (:q = '%%' OR c.body LIKE :q)
        ORDER BY c.created_at DESC LIMIT :limit OFFSET :offset`,
      { q: like, limit, offset },
    );
  }
  if (type === 'live') {
    return all(
      `SELECT l.id, l.title, l.status, l.started_at, l.ended_at, l.peak_viewers AS peak, l.comment_count, u.username
         FROM live_rooms l JOIN users u ON u.id = l.host_id
        ORDER BY l.started_at DESC LIMIT :limit OFFSET :offset`,
      { limit, offset },
    );
  }
  if (type === 'chat') {
    return all(
      `SELECT g.id, g.body, g.type, g.created_at, u.username FROM global_chat g
        JOIN users u ON u.id = g.user_id
       WHERE g.status = 'sent' AND (:q = '%%' OR g.body LIKE :q)
       ORDER BY g.created_at DESC LIMIT :limit OFFSET :offset`,
      { q: like, limit, offset },
    );
  }
  return [];
}

export function moderationLog({ limit = 100, offset = 0 }) {
  return all(
    `SELECT m.id, m.action, m.target_type, m.target_id, m.reason, m.created_at,
            u.username AS moderator, u.role AS moderator_role
       FROM moderation_actions m JOIN users u ON u.id = m.moderator_id
      ORDER BY m.created_at DESC LIMIT :limit OFFSET :offset`,
    { limit, offset },
  );
}

export function userWarnings(userId) {
  return all('SELECT * FROM user_warnings WHERE user_id = ? ORDER BY created_at DESC', { userId });
}
