import router from '../router.js';
import { endpoint } from '../middleware.js';
import { writeJson } from '../http.js';
import * as v from '../lib/validate.js';
import { get, run } from '../db/index.js';
import { notFound, unavailable } from '../lib/errors.js';
import {
  listNotifications, unreadCount, markRead, deleteNotification, updateNotificationSettings,
} from '../domain/notifications.js';
import { saveSubscription, removeSubscription, publicVapidKey, testPush } from '../push.js';
import { pushConfigured } from '../config.js';

// --------------------------------------------------------------------------
// Notificacoes
// --------------------------------------------------------------------------
router.get('/api/notifications', endpoint(async (ctx, res) => {
  const { limit, offset } = v.pagination(ctx.query, { defaultLimit: 40, maxLimit: 100 });
  writeJson(res, 200, {
    notifications: listNotifications({ userId: ctx.user.id, limit, offset }),
    unread: unreadCount(ctx.user.id),
  });
}), { auth: true });

router.get('/api/notifications/unread', endpoint(async (ctx, res) => {
  writeJson(res, 200, { unread: unreadCount(ctx.user.id) });
}), { auth: true });

router.post('/api/notifications/read', endpoint(async (ctx, res) => {
  if (ctx.body.id) {
    writeJson(res, 200, markRead({ userId: ctx.user.id, notificationId: v.id(ctx.body.id, { field: 'id' }) }));
  } else {
    writeJson(res, 200, markRead({ userId: ctx.user.id, all: v.bool(ctx.body.all, true) }));
  }
}), { auth: true, rate: 'write' });

router.delete('/api/notifications/:id', endpoint(async (ctx, res) => {
  writeJson(res, 200, deleteNotification({
    userId: ctx.user.id, notificationId: v.id(ctx.params.id, { field: 'id' }),
  }));
}), { auth: true, rate: 'write' });

router.patch('/api/me/notification-settings', endpoint(async (ctx, res) => {
  const changes = {};
  for (const key of ['likes', 'comments', 'replies', 'follows', 'mentions', 'reposts', 'messages', 'lives', 'activity', 'push_enabled', 'pushEnabled']) {
    if (ctx.body[key] !== undefined) {
      changes[key === 'pushEnabled' ? 'push_enabled' : key] = v.bool(ctx.body[key]);
    }
  }
  const settings = updateNotificationSettings(ctx.user.id, changes);
  writeJson(res, 200, {
    settings: {
      likes: Boolean(settings.likes),
      comments: Boolean(settings.comments),
      replies: Boolean(settings.replies),
      follows: Boolean(settings.follows),
      mentions: Boolean(settings.mentions),
      reposts: Boolean(settings.reposts),
      messages: Boolean(settings.messages),
      lives: Boolean(settings.lives),
      activity: Boolean(settings.activity),
      pushEnabled: Boolean(settings.push_enabled),
    },
  });
}), { auth: true, rate: 'write' });

// --------------------------------------------------------------------------
// Push (Web Push / VAPID)
// --------------------------------------------------------------------------
router.get('/api/push/key', endpoint(async (ctx, res) => {
  if (!pushConfigured()) {
    throw unavailable('push_not_configured', 'Push nao configurado. Defina VAPID_PUBLIC_KEY e VAPID_PRIVATE_KEY (npm run keys).');
  }
  writeJson(res, 200, { publicKey: publicVapidKey() });
}));

router.post('/api/push/subscribe', endpoint(async (ctx, res) => {
  if (!pushConfigured()) {
    throw unavailable('push_not_configured', 'Push nao configurado no servidor (VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY).');
  }
  const endpoint = v.str(ctx.body.endpoint, { field: 'endpoint', min: 10, max: 1000 });
  const keys = ctx.body.keys && typeof ctx.body.keys === 'object' ? ctx.body.keys : {};
  if (!keys.p256dh || !keys.auth) {
    throw notFound('push_keys_missing', 'Chaves da subscription ausentes');
  }
  const deviceId = ctx.headers['x-device-id'] ? String(ctx.headers['x-device-id']).slice(0, 64) : null;
  const id = saveSubscription({
    userId: ctx.user.id, endpoint, keys, deviceId,
  });
  if (deviceId) {
    run('UPDATE devices SET push_enabled = 1, last_used_at = ? WHERE id = ? AND user_id = ?', {
      ts: Date.now(), id: deviceId, userId: ctx.user.id,
    });
  }
  writeJson(res, 201, { id, subscribed: true });
}), { auth: true, rate: 'write' });

router.post('/api/push/unsubscribe', endpoint(async (ctx, res) => {
  const endpoint = v.str(ctx.body.endpoint, { field: 'endpoint', min: 10, max: 1000 });
  writeJson(res, 200, removeSubscription({ userId: ctx.user.id, endpoint }));
}), { auth: true, rate: 'write' });

router.post('/api/push/test', endpoint(async (ctx, res) => {
  if (!pushConfigured()) {
    throw unavailable('push_not_configured', 'Push nao configurado no servidor (VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY).');
  }
  const count = get('SELECT COUNT(*) AS c FROM push_subscriptions WHERE user_id = ?', { userId: ctx.user.id })?.c ?? 0;
  if (!count) {
    throw unavailable('push_no_subscription', 'Nenhum dispositivo subscribed para este usuario. Ative as notificacoes no navegador primeiro.');
  }
  writeJson(res, 202, { subscriptions: count, ...(await testPush(ctx.user.id)) });
}), { auth: true, rate: 'write' });
