import router from '../router.js';
import { endpoint, requireAdmin, requireStaff } from '../middleware.js';
import { writeJson } from '../http.js';
import * as v from '../lib/validate.js';
import { get, all } from '../db/index.js';
import { notFound, forbidden, badRequest } from '../lib/errors.js';
import {
  adminStats, adminListUsers, adminListContent, moderationLog, userWarnings,
  createReport, listReports, getReport, updateReportStatus, enforce, setUserRole,
  REPORT_CATEGORIES, REPORT_TARGETS, ENFORCEMENT_ACTIONS, MUTE_WINDOWS_MINUTES, logAction,
} from '../domain/moderation.js';
import { endRoom, serializeRoom, viewerList, listLiveMessages, getRoom } from '../domain/live.js';
import { deletePost } from '../domain/posts.js';
import { deleteGlobalMessage } from '../domain/messaging.js';
import { hub } from '../realtime/hub.js';
import { ffmpegInfo } from '../media/pipeline.js';
import { storageUsage, listKeys } from '../storage/index.js';
import config from '../config.js';
import { effectStatus } from '../domain/effects.js';
import { getUserById, publicUser } from '../domain/users.js';
import { ADMIN_EVENTS, publishAdminEvent, adminActivity } from '../domain/admin-activity.js';

// ==========================================================================
// ROTAS ADMIN
// Autorizacao validada no backend (requireAdmin/requireStaff). O frontend
// nunca decide quem e admin.
// ==========================================================================

// --------------------------------------------------------------------------
// Painel
// --------------------------------------------------------------------------
router.get('/api/admin/overview', endpoint(async (ctx, res) => {
  requireStaff(ctx);
  writeJson(res, 200, {
    stats: adminStats(),
    realtime: hub.stats(),
    effects: effectStatus(),
    moderationLog: moderationLog({ limit: 15 }),
    reports: listReports({ status: 'open', limit: 15 }),
  });
}), { auth: true });

router.get('/api/admin/users', endpoint(async (ctx, res) => {
  requireStaff(ctx);
  const { limit, offset } = v.pagination(ctx.query, { defaultLimit: 50, maxLimit: 200 });
  writeJson(res, 200, {
    users: adminListUsers({
      query: v.str(ctx.query.q ?? '', { field: 'q', max: 80, required: false }),
      status: ctx.query.status ? v.oneOf(ctx.query.status, ['active', 'suspended', 'banned', 'deleted'], { field: 'status' }) : null,
      role: ctx.query.role ? v.oneOf(ctx.query.role, ['user', 'moderator', 'admin'], { field: 'role' }) : null,
      limit,
      offset,
    }),
  });
}), { auth: true });

router.get('/api/admin/content', endpoint(async (ctx, res) => {
  requireStaff(ctx);
  const { limit, offset } = v.pagination(ctx.query, { defaultLimit: 50, maxLimit: 200 });
  const type = v.oneOf(ctx.query.type ?? 'post', ['post', 'comment', 'live', 'chat'], { field: 'type', fallback: 'post' });
  writeJson(res, 200, {
    type,
    items: adminListContent({ type, query: v.str(ctx.query.q ?? '', { field: 'q', max: 80, required: false }), limit, offset }),
  });
}), { auth: true });

router.get('/api/admin/reports', endpoint(async (ctx, res) => {
  requireStaff(ctx);
  const { limit, offset } = v.pagination(ctx.query, { defaultLimit: 50, maxLimit: 200 });
  writeJson(res, 200, {
    reports: listReports({
      status: ctx.query.status ? v.oneOf(ctx.query.status, ['open', 'reviewing', 'resolved', 'rejected'], { field: 'status' }) : null,
      limit,
      offset,
    }),
    categories: REPORT_CATEGORIES,
  });
}), { auth: true });

router.post('/api/admin/reports/:id', endpoint(async (ctx, res) => {
  requireStaff(ctx);
  const reportId = v.id(ctx.params.id, { field: 'id' });
  const status = v.oneOf(ctx.body.status, ['open', 'reviewing', 'resolved', 'rejected'], { field: 'status' });
  writeJson(res, 200, {
    report: updateReportStatus({
      reportId,
      moderatorId: ctx.user.id,
      status,
      resolution: v.str(ctx.body.resolution ?? '', { field: 'resolution', max: 500, required: false }),
    }),
  });
}), { auth: true, rate: 'write' });

// --------------------------------------------------------------------------
// Enforcement
// --------------------------------------------------------------------------
router.post('/api/admin/enforce', endpoint(async (ctx, res) => {
  const actorRole = ctx.user.role;
  const targetType = v.oneOf(ctx.body.targetType, REPORT_TARGETS, { field: 'targetType' });
  const targetId = v.id(ctx.body.targetId, { field: 'targetId' });
  const action = v.oneOf(
    ctx.body.action,
    // `set_role` e' exclusivo de administrador e por isso vive fora da lista
    // de acoes de moderacao (que sao as que um moderador pode executar).
    [...ENFORCEMENT_ACTIONS, 'set_role'],
    { field: 'action' },
  );
  const reason = v.str(ctx.body.reason ?? '', { field: 'reason', max: 500, required: false });

  // Autorizacao base: QUALQUER acao de enforcement exige staff (admin ou
  // moderador). Sem esta checagem, qualquer usuario logado conseguiria
  // silenciar, suspender ou banir outra pessoa.
  requireStaff(ctx);

  // Moderador nao pode banir/suspender administradores nem dar papel de admin.
  const targetUser = targetType === 'user' ? getUserById(targetId, { includeDeleted: true }) : null;
  if (targetUser && targetUser.role === 'admin' && actorRole !== 'admin') {
    throw forbidden('cannot_moderate_admin', 'Somente administradores moderam outros administradores');
  }
  if (action === 'set_role') requireAdmin(ctx);
  if (['ban', 'suspend', 'unban'].includes(action) && actorRole !== 'admin' && actorRole !== 'moderator') {
    throw forbidden('insufficient_role', 'Sem permissao para esta acao');
  }
  if (action === 'mute') {
    const minutes = v.int(ctx.body.minutes ?? 2, { field: 'minutes', min: 1, max: 60, required: false, fallback: 2 });
    if (!MUTE_WINDOWS_MINUTES.includes(minutes)) {
      throw badRequest('invalid_mute_window', `Janelas de mute permitidas: ${MUTE_WINDOWS_MINUTES.join(', ')} minutos`, {
        allowed: MUTE_WINDOWS_MINUTES,
      });
    }
    writeJson(res, 200, enforce({ moderatorId: ctx.user.id, targetType, targetId, action, reason, minutes }));
    publishAdminEvent(ADMIN_EVENTS.MODERATION_APPLIED, {
      ...adminActivity('moderation_applied', `${ctx.user.username} silenciou ${targetType} por ${minutes} min`),
      action,
      targetType,
      targetId,
      moderator: ctx.user.username,
      minutes,
      reason,
    });
    return;
  }
  const result = action === 'set_role'
    ? setUserRole({
      actorId: ctx.user.id,
      userId: targetId,
      role: v.oneOf(ctx.body.role, ['user', 'moderator', 'admin'], { field: 'role' }),
      reason,
    })
    : enforce({ moderatorId: ctx.user.id, targetType, targetId, action, reason });
  // Item 17: a acao de moderacao aparece no painel em tempo real.
  publishAdminEvent(ADMIN_EVENTS.MODERATION_APPLIED, {
    ...adminActivity('moderation_applied', `${ctx.user.username} aplicou ${action} em ${targetType}`),
    action,
    targetType,
    targetId,
    moderator: ctx.user.username,
    reason,
  });
  writeJson(res, 200, result);
}), { auth: true, rate: 'write' });

router.get('/api/admin/users/:id', endpoint(async (ctx, res) => {
  requireStaff(ctx);
  const user = getUserById(v.id(ctx.params.id, { field: 'id' }), { includeDeleted: true });
  if (!user) throw notFound('user_not_found', 'Usuario nao encontrado');
  const sessions = all('SELECT id, user_agent, ip, created_at, last_used_at FROM sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 20', { userId: user.id });
  const posts = all("SELECT id, caption, status, created_at FROM posts WHERE author_id = ? ORDER BY created_at DESC LIMIT 20", { userId: user.id });
  const live = get("SELECT * FROM live_rooms WHERE host_id = ? AND status = 'live'", { hostId: user.id });
  writeJson(res, 200, {
    user: { ...publicUser(user, ctx.user), status: user.status, statusReason: user.status_reason, statusUntil: user.status_until, online: hub.isUserOnline(user.id) },
    warnings: userWarnings(user.id),
    sessions,
    posts,
    live: live ? serializeRoom(live) : null,
    effectsToday: all('SELECT day, count FROM effect_usage_daily WHERE user_id = ? ORDER BY day DESC LIMIT 7', { userId: user.id }),
  });
}), { auth: true });

router.get('/api/admin/moderation-log', endpoint(async (ctx, res) => {
  requireStaff(ctx);
  const { limit, offset } = v.pagination(ctx.query, { defaultLimit: 100, maxLimit: 500 });
  writeJson(res, 200, { log: moderationLog({ limit, offset }) });
}), { auth: true });

router.get('/api/admin/live/:id', endpoint(async (ctx, res) => {
  requireStaff(ctx);
  const room = getRoom(v.id(ctx.params.id, { field: 'id' }));
  if (!room) throw notFound('live_not_found', 'LIVE nao encontrada');
  writeJson(res, 200, {
    room: serializeRoom(room, { includeMessages: true }),
    viewers: viewerList(room.id, { onlyOnline: false }),
    messages: listLiveMessages({ roomId: room.id, limit: 100 }),
  });
}), { auth: true });

router.post('/api/admin/live/:id/end', endpoint(async (ctx, res) => {
  requireStaff(ctx);
  const roomId = v.id(ctx.params.id, { field: 'id' });
  writeJson(res, 200, endRoom({ roomId, actorId: ctx.user.id, actorRole: ctx.user.role, reason: 'moderation' }));
}), { auth: true, rate: 'write' });

router.get('/api/admin/system', endpoint(async (ctx, res) => {
  requireAdmin(ctx);
  const ffmpeg = await ffmpegInfo();
  writeJson(res, 200, {
    runtime: {
      node: process.version,
      uptimeSeconds: Math.floor(process.uptime()),
      memoryMb: Math.round(process.memoryUsage().rss / 1048576),
      env: config.nodeEnv,
      pid: process.pid,
    },
    database: {
      path: config.databasePath,
      users: get('SELECT COUNT(*) AS c FROM users')?.c ?? 0,
      posts: get("SELECT COUNT(*) AS c FROM posts WHERE status = 'published'")?.c ?? 0,
      media: get('SELECT COUNT(*) AS c FROM media')?.c ?? 0,
    },
    storage: { usage: storageUsage(), keys: listKeys('videos').length },
    media: { ffmpeg, transcode: config.mediaTranscode, hls: config.mediaHls },
    realtime: hub.stats(),
    effects: effectStatus(),
    features: {
      turn: Boolean(config.turnUrl && config.turnUsername && config.turnCredential),
      giphy: Boolean(config.giphyApiKey),
      push: Boolean(config.vapidPublicKey && config.vapidPrivateKey),
    },
  });
}), { auth: true });

// ==========================================================================
// DENUNCIAS (publico - autenticado)
// ==========================================================================
router.post('/api/reports', endpoint(async (ctx, res) => {
  const targetType = v.oneOf(ctx.body.targetType, REPORT_TARGETS, { field: 'targetType' });
  const targetId = v.id(ctx.body.targetId, { field: 'targetId' });
  const category = v.oneOf(ctx.body.category, REPORT_CATEGORIES, { field: 'category' });
  const details = v.plainText(ctx.body.details ?? '', { field: 'details', max: 1000, required: false });
  const report = createReport({ reporterId: ctx.user.id, targetType, targetId, category, details });
  // Item 17: denuncia nova aparece no painel em tempo real.
  publishAdminEvent(ADMIN_EVENTS.REPORT_CREATED, {
    ...adminActivity('report_created', `Denuncia ${category} contra ${targetType}`),
    reportId: report.id,
    targetType,
    targetId,
    category,
    reporter: ctx.user.username,
  });
  writeJson(res, 201, { report });
}), { auth: true, rate: 'report' });

router.get('/api/reports/mine', endpoint(async (ctx, res) => {
  const { limit, offset } = v.pagination(ctx.query, { defaultLimit: 50, maxLimit: 200 });
  const rows = all(
    'SELECT id FROM reports WHERE reporter_id = :userId ORDER BY created_at DESC LIMIT :limit OFFSET :offset',
    { userId: ctx.user.id, limit, offset },
  );
  writeJson(res, 200, { reports: rows.map((r) => getReport(r.id)) });
}), { auth: true });

// ==========================================================================
// ENDPOINT DE EXCLUSAO DE CONTEUDO PELO AUTOR VIA ADMIN
// ==========================================================================
router.delete('/api/admin/content/:type/:id', endpoint(async (ctx, res) => {
  requireStaff(ctx);
  const type = v.oneOf(ctx.params.type, ['post', 'comment', 'chat'], { field: 'type' });
  const id = v.id(ctx.params.id, { field: 'id' });
  if (type === 'post') deletePost(id, { actorId: ctx.user.id, actorRole: ctx.user.role });
  if (type === 'comment') {
    const { deleteComment } = await import('../domain/social.js');
    deleteComment({ commentId: id, userId: ctx.user.id, actorRole: ctx.user.role });
  }
  if (type === 'chat') {
    const message = get('SELECT user_id FROM global_chat WHERE id = ?', { id });
    if (!message) throw notFound('message_not_found', 'Mensagem nao encontrada');
    deleteGlobalMessage({ messageId: id, userId: ctx.user.id, actorRole: ctx.user.role });
  }
  logAction({
    moderatorId: ctx.user.id, action: 'remove_content', targetType: type, targetId: id,
    reason: v.str(ctx.body.reason ?? '', { field: 'reason', max: 300, required: false }),
  });
  writeJson(res, 200, { ok: true });
}), { auth: true, rate: 'write' });
