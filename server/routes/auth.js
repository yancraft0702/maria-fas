import crypto from 'node:crypto';
import config from '../config.js';
import router from '../router.js';
import { endpoint } from '../middleware.js';
import { writeJson, registerMultipartParser } from '../http.js';
import { get, run } from '../db/index.js';
import * as v from '../lib/validate.js';
import { badRequest, unauthorized, notFound } from '../lib/errors.js';
import { createUser, authenticate, findUserByIdentifier, createPasswordReset, consumePasswordReset, disableTotp, setRecoveryCodes, listSessions } from '../domain/auth.js';
import { generateTotpSecret, generateRecoveryCodes, otpauthUrl, verifyTotp, hashPassword, totpAt } from '../lib/crypto.js';
import { createSession, sessionCookie, csrfCookie, clearCookies, revokeSession, revokeOtherSessions, devices, deviceType } from '../domain/sessions.js';
import { publicUser, assertUsernameAvailable, updateUserProfile, changeUsername, softDeleteAccount, isInternalEmail } from '../domain/users.js';
import { ADMIN_EVENTS, publishAdminEvent, adminActivity } from '../domain/admin-activity.js';
import { sendMail, mailStatus } from '../mailer.js';
import logger from '../lib/logger.js';

// --------------------------------------------------------------------------
// Cadastro
// --------------------------------------------------------------------------
/**
 * A interface pede SOMENTE usuario e senha (item do produto): o email nao e
 * digitado pelo usuario. Internamente a conta continua com um email proprio,
 * porque e a chave de recuperacao de senha e de bloqueio de dominio - sem ele
 * nao ha como evitar cadastro duplicado nem recuperar acesso.
 *
 * O email gerado e derivado do @usuario, com um sufixo aleatorio para nunca
 * colidir com um endereco real.
 */
function internalEmailFor(username) {
  const suffix = crypto.randomBytes(6).toString('hex');
  return `${username.toLowerCase()}+${suffix}@conta.mariafas.app`;
}

router.post('/api/auth/register', endpoint(async (ctx, res) => {
  const username = v.username(ctx.body.username);
  const password = v.password(ctx.body.password);
  const displayName = v.str(ctx.body.displayName, { field: 'displayName', max: 60, required: false }) || username;
  // Email continua aceito (integracoes antigas / admin), mas e opcional.
  const email = ctx.body.email
    ? v.email(ctx.body.email)
    : internalEmailFor(username);

  const user = await createUser({ email, username, password, displayName });
  const { session, csrfToken, expiresAt } = startSession(ctx, user.id);

  // Item 17: conta nova aparece no painel administrativo em tempo real.
  publishAdminEvent(ADMIN_EVENTS.USER_CREATED, {
    ...adminActivity('user_created', `Novo usuario: @${user.username}`),
    userId: user.id,
    username: user.username,
  });

  sendMail({
    to: user.email,
    subject: 'Bem-vindo ao MARIA FANS',
    text: `Ola ${user.display_name}! Sua conta no MARIA FANS foi criada com sucesso.`,
  });

  writeJson(res, 201, {
    user: publicUser(user, user),
    csrfToken,
    expiresAt,
  }, { 'Set-Cookie': [sessionCookie(session.token, expiresAt), csrfCookie(csrfToken, expiresAt)] });
}));

// --------------------------------------------------------------------------
// Login
// --------------------------------------------------------------------------
/**
 * Aceita USUARIO (campo `identifier`, e tambem `username` ou `email`) + senha.
 * Com email, o comportamento e o de sempre; com @usuario, resolve pelo
 * username. A busca e sempre por uma unica coluna indexada.
 */
router.post('/api/auth/login', endpoint(async (ctx, res) => {
  const identifier = v.str(ctx.body.identifier ?? ctx.body.username ?? ctx.body.email, {
    field: 'identifier', min: 3, max: 254,
  });
  const password = v.str(ctx.body.password, { field: 'password', min: 1, max: 200 });
  const user = await authenticate({
    identifier,
    password,
    totpCode: ctx.body.totpCode ?? null,
    backupCode: ctx.body.backupCode ?? null,
    ip: ctx.ip,
    userAgent: ctx.headers['user-agent'] || '',
  });
  const { session, csrfToken, expiresAt } = startSession(ctx, user.id);
  writeJson(res, 200, {
    user: publicUser(user, user),
    csrfToken,
    expiresAt,
  }, { 'Set-Cookie': [sessionCookie(session.token, expiresAt), csrfCookie(csrfToken, expiresAt)] });
}), { rate: 'auth' });

// --------------------------------------------------------------------------
// Sessao atual
// --------------------------------------------------------------------------
router.get('/api/auth/me', endpoint(async (ctx, res) => {
  if (!ctx.user) {
    writeJson(res, 200, { user: null, authenticated: false });
    return;
  }
  const settings = get('SELECT * FROM settings WHERE user_id = ?', { userId: ctx.user.id });
  writeJson(res, 200, {
    authenticated: true,
    user: publicUser(ctx.user, ctx.user, { withCounts: true }),
    csrfToken: ctx.session.csrf_token,
    preferences: settings
      ? {
        language: settings.language,
        autoplay: Boolean(settings.autoplay),
        autoplayMuted: Boolean(settings.autoplay_muted),
        reduceMotion: Boolean(settings.reduce_motion),
        fontScale: settings.font_scale,
        highContrast: Boolean(settings.high_contrast),
        captionsDefault: Boolean(settings.captions_default),
        dataSaver: Boolean(settings.data_saver),
        defaultPostVisibility: settings.default_post_visibility,
      }
      : null,
    session: {
      id: ctx.session.id,
      createdAt: ctx.session.created_at,
      lastUsedAt: ctx.session.last_used_at,
      expiresAt: ctx.session.expires_at,
      device: deviceType(ctx.headers['user-agent'] || ''),
    },
  });
}));

// --------------------------------------------------------------------------
// Logout
// --------------------------------------------------------------------------
router.post('/api/auth/logout', endpoint(async (ctx, res) => {
  if (ctx.session) revokeSession(ctx.session.id, 'logout');
  writeJson(res, 200, { ok: true }, { 'Set-Cookie': clearCookies() });
}));

router.post('/api/auth/logout-all', endpoint(async (ctx, res) => {
  revokeOtherSessions(ctx.user.id, ctx.session.id);
  writeJson(res, 200, { ok: true });
}), { auth: true });

// --------------------------------------------------------------------------
// Recuperacao de senha
// --------------------------------------------------------------------------
router.post('/api/auth/forgot-password', endpoint(async (ctx, res) => {
  // Aceita USUARIO ou email (a tela de entrada nao pede email).
  const identifier = v.str(ctx.body.identifier ?? ctx.body.email, { field: 'identifier', min: 3, max: 254 });
  const user = findUserByIdentifier(identifier);

  // Item 6: o token de recuperacao NUNCA volta na resposta - nem em
  // desenvolvimento. Sem canal de entrega configurado, a resposta diz
  // exatamente isso em vez de fingir que enviou algo.
  const mailPronto = mailStatus().configured;
  const usuarioTemEmailReal = Boolean(user) && !isInternalEmail(user.email);

  if (user && mailPronto && usuarioTemEmailReal) {
    const token = createPasswordReset(user.id);
    const envio = await sendMail({
      to: user.email,
      subject: 'Recuperacao de senha no MARIA FÃS',
      text: `Use este codigo para redefinir sua senha (valido por 30 minutos):\n\n${token}\n\nSe voce nao pediu, ignore este e-mail.`,
    });
    if (!envio.delivered) logger.warn('recuperacao: envio nao concluido', { reason: envio.reason });
  } else {
    logger.info('recuperacao solicitada sem entrega', {
      contaEncontrada: Boolean(user),
      smtpConfigurado: mailPronto,
      emailReal: usuarioTemEmailReal,
    });
  }

  writeJson(res, 202, {
    ok: true,
    delivery: mailPronto ? 'email' : 'unavailable',
    // Mesma resposta exista ou nao a conta: nao enumera usuarios.
    message: mailPronto
      ? 'Se a conta existir, enviaremos as instrucoes de recuperacao.'
      : 'A recuperacao por mensagem ainda nao esta disponivel nesta instalacao. Fale com o administrador para redefinir sua senha.',
  });
}), { rate: 'auth' });

router.post('/api/auth/reset-password', endpoint(async (ctx, res) => {
  const token = v.str(ctx.body.token, { field: 'token', min: 10, max: 200 });
  const password = v.password(ctx.body.password);
  const row = consumePasswordReset(token);
  await resetPasswordWithToken(token, await hashPassword(password, config.scryptCost));
  writeJson(res, 200, { ok: true, message: 'Senha alterada. Faca login novamente.' }, { 'Set-Cookie': clearCookies() });
}), { rate: 'auth' });

router.post('/api/auth/change-password', endpoint(async (ctx, res) => {
  const current = v.str(ctx.body.currentPassword, { field: 'currentPassword', min: 1, max: 200 });
  const next = v.password(ctx.body.newPassword);
  const { verifyPassword } = await import('../lib/crypto.js');
  const ok = await verifyPassword(current, ctx.user.password_hash);
  if (!ok) throw unauthorized('invalid_credentials', 'Senha atual incorreta');
  run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', {
    hash: await hashPassword(next, config.scryptCost), ts: Date.now(), id: ctx.user.id,
  });
  // Troca de senha encerra todas as outras sessoes.
  revokeOtherSessions(ctx.user.id, ctx.session.id);
  writeJson(res, 200, { ok: true, message: 'Senha alterada. Outras sessoes foram encerradas.' });
}), { auth: true, rate: 'auth' });

// --------------------------------------------------------------------------
// 2FA (TOTP)
// --------------------------------------------------------------------------
router.post('/api/auth/2fa/setup', endpoint(async (ctx, res) => {
  const secret = generateTotpSecret();
  const codes = generateRecoveryCodes(10);
  run('UPDATE users SET totp_secret = ?, recovery_codes = ?, totp_enabled = 0, updated_at = ? WHERE id = ?', {
    secret, codes: JSON.stringify(codes), ts: Date.now(), id: ctx.user.id,
  });
  writeJson(res, 200, {
    secret,
    otpauthUrl: otpauthUrl({ secret, label: ctx.user.email, issuer: 'MARIA FÃS' }),
    recoveryCodes: codes,
    currentCode: totpAt(secret),
    message: 'Confirme o codigo no aplicativo autenticador para ativar.',
  });
}), { auth: true });

router.post('/api/auth/2fa/activate', endpoint(async (ctx, res) => {
  const code = v.str(ctx.body.code, { field: 'code', min: 6, max: 6 });
  if (!ctx.user.totp_secret) throw badRequest('totp_not_setup', 'Configure o 2FA antes de ativar');
  if (!verifyTotp(ctx.user.totp_secret, code)) {
    // 400 e nao 401: a sessao continua valida, o CODIGO esta errado.
    throw badRequest('invalid_2fa_code', 'Codigo de verificacao invalido');
  }
  run('UPDATE users SET totp_enabled = 1, updated_at = ? WHERE id = ?', { updatedAt: Date.now(), id: ctx.user.id });
  writeJson(res, 200, { ok: true, totpEnabled: true });
}), { auth: true, rate: 'auth' });

router.post('/api/auth/2fa/disable', endpoint(async (ctx, res) => {
  const code = v.str(ctx.body.code, { field: 'code', min: 6, max: 6 });
  if (ctx.user.totp_enabled && !verifyTotp(ctx.user.totp_secret, code)) {
    throw badRequest('invalid_2fa_code', 'Codigo de verificacao invalido');
  }
  disableTotp(ctx.user.id);
  writeJson(res, 200, { ok: true, totpEnabled: false });
}), { auth: true, rate: 'auth' });

router.post('/api/auth/2fa/regenerate-codes', endpoint(async (ctx, res) => {
  if (!ctx.user.totp_enabled) throw badRequest('totp_disabled', '2FA nao esta ativo');
  const code = v.str(ctx.body.code, { field: 'code', min: 6, max: 6 });
  if (!verifyTotp(ctx.user.totp_secret, code)) throw unauthorized('invalid_2fa_code', 'Codigo invalido');
  const codes = generateRecoveryCodes(10);
  setRecoveryCodes(ctx.user.id, codes);
  writeJson(res, 200, { recoveryCodes: codes });
}), { auth: true, rate: 'auth' });

// --------------------------------------------------------------------------
// Dispositivos / sessoes
// --------------------------------------------------------------------------
router.get('/api/auth/sessions', endpoint(async (ctx, res) => {
  const now = Date.now();
  const all_ = listSessions(ctx.user.id).map((s) => ({
    id: s.id,
    deviceId: s.device_id,
    device: deviceType(s.user_agent),
    userAgent: s.user_agent,
    ip: s.ip,
    createdAt: s.created_at,
    lastUsedAt: s.last_used_at,
    expiresAt: s.expires_at,
    current: s.id === ctx.session.id,
  }));
  const list = await devices(ctx.user.id);
  writeJson(res, 200, {
    sessions: all_,
    devices: list.map((d) => ({ id: d.id, label: d.label, type: d.type, pushEnabled: Boolean(d.pushEnabled), lastUsedAt: d.lastUsedAt, createdAt: d.createdAt, activeSessions: d.activeSessions })),
    expiresIn: ctx.session.expires_at - now,
  });
}), { auth: true });

router.post('/api/auth/sessions/revoke-others', endpoint(async (ctx, res) => {
  revokeOtherSessions(ctx.user.id, ctx.session.id);
  writeJson(res, 200, { ok: true });
}), { auth: true });

router.post('/api/auth/sessions/:id/revoke', endpoint(async (ctx, res) => {
  const sessionId = v.id(ctx.params.id, { field: 'id' });
  const target = get('SELECT * FROM sessions WHERE id = ? AND user_id = ?', { id: sessionId, userId: ctx.user.id });
  if (!target) throw notFound('session_not_found', 'Sessao nao encontrada');
  if (sessionId === ctx.session.id) throw badRequest('cannot_revoke_current', 'Use logout para encerrar a sessao atual');
  revokeSession(sessionId, 'revoked_by_user');
  writeJson(res, 200, { ok: true });
}), { auth: true });

// --------------------------------------------------------------------------
// Username / perfil / exclusao
// --------------------------------------------------------------------------
router.post('/api/auth/username', endpoint(async (ctx, res) => {
  const username = v.username(ctx.body.username);
  assertUsernameAvailable(username, ctx.user.id);
  const user = changeUsername(ctx.user.id, username);
  writeJson(res, 200, { user: publicUser(user, user) });
}), { auth: true, rate: 'write' });

router.patch('/api/users/me', endpoint(async (ctx, res) => {
  const changes = {};
  if (ctx.body.displayName !== undefined) changes.displayName = v.str(ctx.body.displayName, { field: 'displayName', min: 1, max: 60 });
  if (ctx.body.bio !== undefined) changes.bio = v.plainText(ctx.body.bio, { field: 'bio', max: 300, required: false });
  if (ctx.body.website !== undefined) {
    const site = v.str(ctx.body.website, { field: 'website', max: 200, required: false });
    if (site && !/^https?:\/\/.+/i.test(site)) {
      throw badRequest('invalid_website', 'O link precisa comecar com http:// ou https://');
    }
    changes.website = site;
  }
  if (ctx.body.location !== undefined) changes.location = v.str(ctx.body.location, { field: 'location', max: 80, required: false });
  const user = updateUserProfile(ctx.user.id, changes);
  writeJson(res, 200, { user: publicUser(user, user) });
}), { auth: true, rate: 'write' });

router.post('/api/users/me/avatar', endpoint(async (ctx, res) => {
  const { buffer, contentType, filename } = await readSingleFile(ctx, ['image']);
  const { saveUpload } = await import('../media/upload.js');
  const saved = await saveUpload({
    ownerId: ctx.user.id, category: 'image', buffer, declaredMime: contentType,
    originalName: filename, bucket: 'avatars', purpose: 'avatars',
  });
  const user = updateUserProfile(ctx.user.id, { avatarKey: `${saved.bucket}/${saved.key}` });
  writeJson(res, 200, { user: publicUser(user, user) });
}), { auth: true, rate: 'upload' });

router.post('/api/users/me/cover', endpoint(async (ctx, res) => {
  const { buffer, contentType, filename } = await readSingleFile(ctx, ['image']);
  const { saveUpload } = await import('../media/upload.js');
  const saved = await saveUpload({
    ownerId: ctx.user.id, category: 'image', buffer, declaredMime: contentType,
    originalName: filename, bucket: 'covers', purpose: 'covers',
  });
  const user = updateUserProfile(ctx.user.id, { coverKey: `${saved.bucket}/${saved.key}` });
  writeJson(res, 200, { user: publicUser(user, user) });
}), { auth: true, rate: 'upload' });

router.post('/api/users/me/delete', endpoint(async (ctx, res) => {
  const { verifyPassword } = await import('../lib/crypto.js');
  const password = v.str(ctx.body.password, { field: 'password', min: 1, max: 200 });
  const ok = await verifyPassword(password, ctx.user.password_hash);
  if (!ok) throw unauthorized('invalid_credentials', 'Senha incorreta');
  softDeleteAccount(ctx.user.id);
  writeJson(res, 200, { ok: true, message: 'Conta removida.' }, { 'Set-Cookie': clearCookies() });
}), { auth: true, rate: 'auth' });

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------
function startSession(ctx, userId) {
  const deviceId = ctx.headers['x-device-id'] ? String(ctx.headers['x-device-id']).slice(0, 64) : crypto.randomUUID();
  const session = createSession({
    userId,
    userAgent: ctx.headers['user-agent'] || '',
    ip: ctx.ip,
    deviceId,
  });
  return { session, csrfToken: session.csrfToken, expiresAt: session.expiresAt };
}

/**
 * Le um arquivo do corpo. Aceita:
 *  - multipart/form-data (campo `file` ou o primeiro arquivo enviado)
 *  - corpo binario puro com ?filename=
 */
async function readSingleFile(ctx, categories) {
  const contentType = ctx.headers['content-type'] || '';
  const raw = ctx.rawBody;

  // Upload ja parseado pelo servidor (multipart)
  if (contentType.startsWith('multipart/form-data')) {
    const files = ctx.files || {};
    const file = files.file || files[Object.keys(files)[0]];
    if (!file) throw badRequest('file_missing', 'Campo "file" ausente no formulario');
    const { validateUpload } = await import('../media/upload.js');
    validateUpload({
      category: categories[0],
      buffer: file.data,
      declaredMime: file.contentType,
      originalName: file.filename,
    });
    return { buffer: file.data, contentType: file.contentType, filename: file.filename };
  }

  if (!raw?.length) throw badRequest('empty_body', 'Nenhum arquivo enviado');
  const { validateUpload } = await import('../media/upload.js');
  validateUpload({
    category: categories[0],
    buffer: raw,
    declaredMime: contentType,
    originalName: ctx.query.filename || 'arquivo',
  });
  return { buffer: raw, contentType, filename: ctx.query.filename || 'arquivo' };
}

// Registra o parser multipart no nucleo HTTP (evita ciclo de import)
registerMultipartParser({ parseMultipart });

export function parseMultipart(buffer, contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!match) throw badRequest('invalid_multipart', 'Boundary do multipart ausente');
  const boundary = Buffer.from(`--${match[1] || match[2]}`);
  const parts = [];
  let index = buffer.indexOf(boundary);
  while (index !== -1) {
    const start = index + boundary.length;
    if (buffer.slice(start, start + 2).toString() === '--') break;
    const next = buffer.indexOf(boundary, start);
    if (next === -1) break;
    parts.push(buffer.slice(start, next));
    index = next;
  }
  const fields = {};
  const files = {};
  for (const part of parts) {
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;
    const headerText = part.slice(0, headerEnd).toString('utf8');
    let data = part.slice(headerEnd + 4);
    if (data.slice(-2).toString() === '\r\n') data = data.slice(0, -2);
    const disposition = /content-disposition: form-data; name="([^"]+)"(?:; filename="([^"]*)")?/i.exec(headerText);
    if (!disposition) continue;
    const name = disposition[1];
    const filename = disposition[2];
    const partType = /content-type:\s*([^\r\n]+)/i.exec(headerText)?.[1]?.trim() || null;
    if (filename !== undefined && filename !== null && filename !== '') {
      files[name] = { filename, contentType: partType, data };
    } else {
      fields[name] = data.toString('utf8');
    }
  }
  return { fields, files };
}

export { readSingleFile };
