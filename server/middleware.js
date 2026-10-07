import config from './config.js';
import { run, get } from './db/index.js';
import { newId } from './lib/ids.js';
import { unauthorized, forbidden, tooManyRequests } from './lib/errors.js';
import { SESSION_COOKIE, CSRF_COOKIE, CSRF_HEADER, assertActive } from './domain/auth.js';
import { resolveSession, touchSession } from './domain/sessions.js';
import { isUserMuted } from './domain/moderation.js';
import { getUserById } from './domain/users.js';

// --------------------------------------------------------------------------
// Rate limit em memoria (por janela deslizante simples).
// --------------------------------------------------------------------------
const buckets = new Map();
let lastSweep = Date.now();

function sweep(now) {
  if (now - lastSweep < 30_000) return;
  lastSweep = now;
  for (const [key, entry] of buckets) {
    if (entry.resetAt < now - 60_000) buckets.delete(key);
  }
}

export function rateLimit(name, max, windowMs) {
  return (ctx, res) => {
    const now = Date.now();
    sweep(now);
    const key = `${name}:${ctx.ip}:${ctx.user?.id ?? 'anon'}`;
    let entry = buckets.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      buckets.set(key, entry);
    }
    entry.count += 1;
    const remaining = Math.max(0, max - entry.count);
    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(remaining));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(entry.resetAt / 1000)));
    if (entry.count > max) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      throw tooManyRequests('rate_limited', `Limite de requisicoes excedido. Tente novamente em ${retryAfter}s.`, { retryAfter });
    }
  };
}

export const rateLimiters = {
  default: rateLimit('default', config.rateLimitMax, config.rateLimitWindowMs),
  auth: rateLimit('auth', 30, 60_000),
  write: rateLimit('write', 120, 60_000),
  upload: rateLimit('upload', 40, 60_000),
  chat: rateLimit('chat', 60, 60_000),
  live: rateLimit('live', 240, 60_000),
  search: rateLimit('search', 120, 60_000),
  report: rateLimit('report', 10, 300_000),
  media: rateLimit('media', 600, 60_000),
};

// --------------------------------------------------------------------------
// Autenticacao
// --------------------------------------------------------------------------
/** Popula ctx.user/ctx.session quando houver cookie valido (nao falha). */
export function loadSession(ctx) {
  const token = ctx.cookies?.[SESSION_COOKIE];
  if (!token) return;
  const session = resolveSession(token);
  if (!session) return;
  const user = getUserById(session.user_id);
  if (!user) return;
  ctx.session = session;
  ctx.user = user;
  ctx.sessionToken = token;
}

export function requireAuth(ctx) {
  if (!ctx.user) {
    throw unauthorized('login_required', 'Faca login para continuar');
  }
  assertActive(ctx.user);
  touchSession(ctx.session.id);
  run('UPDATE users SET last_seen_at = ? WHERE id = ?', { ts: Date.now(), id: ctx.user.id });
}

export function optionalAuth(ctx) {
  if (ctx.user) assertActive(ctx.user);
}

export function requireRole(...roles) {
  return (ctx) => {
    if (!ctx.user) throw unauthorized('login_required', 'Faca login para continuar');
    assertActive(ctx.user);
    if (!roles.includes(ctx.user.role)) {
      throw forbidden('insufficient_role', 'Voce nao tem permissao para esta acao');
    }
  };
}

/** Staff = admin + moderator. */
export const requireStaff = requireRole('admin', 'moderator');
export const requireAdmin = requireRole('admin');

// --------------------------------------------------------------------------
// CSRF (double submit + token de sessao)
// --------------------------------------------------------------------------
export function csrfGuard(ctx) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(ctx.method)) return;
  if (ctx.path.startsWith('/api/webhooks/')) return;
  if (!ctx.session) return; // rotas publicas nao tem risco de CSRF autenticado
  const header = ctx.headers[CSRF_HEADER] || ctx.headers['x-xsrf-token'];
  const cookieToken = ctx.cookies?.[CSRF_COOKIE];
  if (!header || !cookieToken || header !== cookieToken || header !== ctx.session.csrf_token) {
    throw forbidden('csrf_failed', 'Token CSRF invalido ou ausente. Recarregue a pagina.');
  }
}

// --------------------------------------------------------------------------
// CORS
// --------------------------------------------------------------------------
export function cors(req, res) {
  const origin = req.headers.origin;
  res.setHeader('Vary', 'Origin');
  if (!origin) return;
  const allowed = config.corsOrigins.length
    ? config.corsOrigins.includes(origin)
    : /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin);
  if (!allowed) return;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', `Content-Type, ${CSRF_HEADER}, X-Requested-With, X-Device-Id`);
  res.setHeader('Access-Control-Max-Age', '600');
}

// --------------------------------------------------------------------------
// Silenciamento (mute)
// --------------------------------------------------------------------------
/** Rotas de leitura nunca sao bloqueadas por silenciamento. */
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
/** Endpoints que continuam liberados durante o silencio. */
const MUTE_EXEMPT = [
  '/api/auth/logout',
  '/api/auth/me',
  '/api/notifications',
  '/api/push/',
  '/api/me/notification-settings',
  '/api/me/mutes',
];

export function muteGuard(ctx) {
  if (!ctx.user) return;
  if (READ_METHODS.has(ctx.method)) return;
  if (MUTE_EXEMPT.some((prefix) => ctx.path.startsWith(prefix))) return;
  if (!isUserMuted(ctx.user.id)) return;
  throw forbidden(
    'user_muted',
    'Voce esta silenciado pela moderacao e nao pode publicar agora.',
    { until: mutedUntilOf(ctx.user.id) },
  );
}

function mutedUntilOf(userId) {
  const row = get('SELECT muted_until FROM users WHERE id = ?', { id: userId });
  return row?.muted_until ?? null;
}

// --------------------------------------------------------------------------
// Audit log
// --------------------------------------------------------------------------
export function recordAudit(ctx, status, durationMs) {
  const path = ctx?.path || '';
  if (path.startsWith('/api/health') || path.startsWith('/api/ready')) return;
  run(
    `INSERT INTO audit_log (id, request_id, user_id, method, path, status, duration_ms, ip, error_code, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    {
      id: newId('aud'),
      requestId: ctx?.requestId ?? '',
      userId: ctx?.user?.id ?? null,
      method: ctx?.method ?? '',
      path: String(path).slice(0, 300),
      status,
      durationMs: Math.round(durationMs),
      ip: ctx?.ip ?? '',
      errorCode: ctx?.route?.meta?.errorCode ?? null,
      createdAt: Date.now(),
    },
  );
}

/** Resposta padrao de erro nao-2xx do handler (usa res.statusCode). */
export function wrapHandler(handler) {
  return async (ctx, res) => {
    const rate = ctx.route?.rate;
    if (rate && rateLimiters[rate]) rateLimiters[rate](ctx, res);
    if (ctx.route?.auth) requireAuth(ctx);
    else optionalAuth(ctx);
    if (ctx.route?.csrf !== false) csrfGuard(ctx);
    muteGuard(ctx);
    await handler(ctx, res);
  };
}

/** Envolve handlers de rota com rate limit + autenticacao + CSRF. */
export function endpoint(fn) {
  return wrapHandler(fn);
}

export function listRateBuckets() {
  return buckets.size;
}

export { CSRF_COOKIE, SESSION_COOKIE, CSRF_HEADER };
