import router from '../router.js';
import { endpoint } from '../middleware.js';
import { writeJson } from '../http.js';
import * as v from '../lib/validate.js';
import { get } from '../db/index.js';
import { notFound } from '../lib/errors.js';
import hub from '../realtime/hub.js';
import { getUserById, getUserCounts, isFollowing, isFriend, isBlocked } from '../domain/users.js';
import {
  follow, unfollow, removeFriend, acceptFollowRequest, rejectFollowRequest, removeFollower,
  block, unblock, mute, unmute,
} from '../domain/social.js';
import { canFollow } from '../domain/privacy.js';
import { EVENTS as E } from '../realtime/protocol.js';

// --------------------------------------------------------------------------
// Follow / unfollow
// --------------------------------------------------------------------------
router.post('/api/users/:id/follow', endpoint(async (ctx, res) => {
  const target = resolveUser(ctx.params.id);
  const result = follow({ followerId: ctx.user.id, followeeId: target.id });
  if (result.changed) {
    // A ve imediatamente "Seguindo +1"; B ve imediatamente "Seguidores +1".
    hub.publishToUser(ctx.user.id, E.COUNTS, { following: getUserCounts(ctx.user.id).followingCount });
    hub.publishToUser(target.id, E.COUNTS, { followers: result.counts.followerCount });
    hub.publishToUser(target.id, E.FOLLOW, {
      followerId: ctx.user.id, username: ctx.user.username, status: result.status,
    });
    hub.publishToUser(ctx.user.id, E.FOLLOW, {
      followeeId: target.id, username: target.username, status: result.status,
    });
  }
  writeJson(res, 200, result);
}), { auth: true, rate: 'write' });

router.delete('/api/users/:id/follow', endpoint(async (ctx, res) => {
  const target = resolveUser(ctx.params.id);
  const result = unfollow({ followerId: ctx.user.id, followeeId: target.id });
  if (result.changed) {
    hub.publishToUser(ctx.user.id, E.COUNTS, { following: getUserCounts(ctx.user.id).followingCount });
    hub.publishToUser(target.id, E.COUNTS, { followers: result.counts.followerCount });
    hub.publishToUser(target.id, E.UNFOLLOW, { followerId: ctx.user.id });
    hub.publishToUser(ctx.user.id, E.UNFOLLOW, { followeeId: target.id });
  }
  writeJson(res, 200, result);
}), { auth: true, rate: 'write' });

router.delete('/api/users/:id/followers', endpoint(async (ctx, res) => {
  const target = resolveUser(ctx.params.id);
  const result = removeFollower({ userId: target.id, followerId: ctx.user.id });
  hub.publishToUser(target.id, E.COUNTS, { followers: result.counts.followerCount });
  hub.publishToUser(ctx.user.id, E.UNFOLLOW, { followerId: ctx.user.id });
  writeJson(res, 200, result);
}), { auth: true, rate: 'write' });

router.post('/api/users/:id/follow-requests/:action', endpoint(async (ctx, res) => {
  const target = resolveUser(ctx.params.id);
  const action = v.oneOf(ctx.params.action, ['accept', 'reject'], { field: 'action' });
  const result = action === 'accept'
    ? acceptFollowRequest({ userId: target.id, followerId: ctx.user.id })
    : rejectFollowRequest({ userId: target.id, followerId: ctx.user.id });
  hub.publishToUser(ctx.user.id, E.FOLLOW, {
    followerId: ctx.user.id, status: result.status, counts: getUserCounts(target.id),
  });
  writeJson(res, 200, result);
}), { auth: true, rate: 'write' });

// --------------------------------------------------------------------------
// Amizades
// --------------------------------------------------------------------------
router.delete('/api/users/:id/friend', endpoint(async (ctx, res) => {
  const target = resolveUser(ctx.params.id);
  const result = removeFriend({ userId: ctx.user.id, friendId: target.id });
  hub.publishToUser(target.id, E.UNFOLLOW, { friendId: ctx.user.id });
  writeJson(res, 200, result);
}), { auth: true, rate: 'write' });

// --------------------------------------------------------------------------
// Bloqueio / silenciamento
// --------------------------------------------------------------------------
router.post('/api/users/:id/block', endpoint(async (ctx, res) => {
  const target = resolveUser(ctx.params.id);
  const result = block({ blockerId: ctx.user.id, blockedId: target.id });
  hub.publishToUser(target.id, E.SESSION_REVOKED, { reason: 'blocked' });
  writeJson(res, 200, result);
}), { auth: true, rate: 'write' });

router.delete('/api/users/:id/block', endpoint(async (ctx, res) => {
  const target = resolveUser(ctx.params.id);
  writeJson(res, 200, unblock({ blockerId: ctx.user.id, blockedId: target.id }));
}), { auth: true, rate: 'write' });

router.post('/api/users/:id/mute', endpoint(async (ctx, res) => {
  const target = resolveUser(ctx.params.id);
  writeJson(res, 200, mute({ userId: ctx.user.id, targetType: 'user', targetId: target.id }));
}), { auth: true, rate: 'write' });

router.delete('/api/users/:id/mute', endpoint(async (ctx, res) => {
  const target = resolveUser(ctx.params.id);
  writeJson(res, 200, unmute({ userId: ctx.user.id, targetType: 'user', targetId: target.id }));
}), { auth: true, rate: 'write' });

router.post('/api/mutes', endpoint(async (ctx, res) => {
  const targetType = v.oneOf(ctx.body.targetType, ['user', 'post', 'sound', 'hashtag', 'chat'], { field: 'targetType' });
  const targetId = v.str(ctx.body.targetId, { field: 'targetId', min: 1, max: 64 });
  writeJson(res, 200, mute({ userId: ctx.user.id, targetType, targetId }));
}), { auth: true, rate: 'write' });

router.delete('/api/mutes', endpoint(async (ctx, res) => {
  const targetType = v.oneOf(ctx.body.targetType, ['user', 'post', 'sound', 'hashtag', 'chat'], { field: 'targetType' });
  const targetId = v.str(ctx.body.targetId, { field: 'targetId', min: 1, max: 64 });
  writeJson(res, 200, unmute({ userId: ctx.user.id, targetType, targetId }));
}), { auth: true, rate: 'write' });

// --------------------------------------------------------------------------
// Estado de relacao (usado pelo perfil)
// --------------------------------------------------------------------------
router.get('/api/users/:id/relation', endpoint(async (ctx, res) => {
  const target = resolveUser(ctx.params.id);
  const followState = ctx.user
    ? get('SELECT status FROM follows WHERE follower_id = ? AND followee_id = ?', { followerId: ctx.user.id, followeeId: target.id })
    : null;
  writeJson(res, 200, {
    isFollowing: ctx.user ? isFollowing(ctx.user.id, target.id) : false,
    isFriend: ctx.user ? isFriend(ctx.user.id, target.id) : false,
    isBlocked: ctx.user ? isBlocked(ctx.user.id, target.id) : false,
    followStatus: followState?.status ?? 'none',
    canFollow: ctx.user ? canFollow(ctx.user.id, target.id) : false,
    counts: getUserCounts(target.id),
  });
}));

function resolveUser(id) {
  const user = getUserById(id);
  if (!user) throw notFound('user_not_found', 'Usuario nao encontrado');
  return user;
}
