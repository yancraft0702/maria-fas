import router from '../router.js';
import { endpoint } from '../middleware.js';
import { writeJson } from '../http.js';
import { get } from '../db/index.js';
import * as v from '../lib/validate.js';
import { notFound, forbidden, badRequest, unauthorized } from '../lib/errors.js';
import {
  getUserById, getUserByUsername, publicUser, getUserCounts, getProfile,
  isFollowing, isFriend, blockedEitherWay, blockList, muteList, assertSettingsExist,
} from '../domain/users.js';
import { assertCanViewAccount, canSeeLikeList, canSeeRepostList } from '../domain/privacy.js';
import {
  userPosts, userLikedPosts, userReposts, favoritesFeed, historyFeed, collectionsFor,
} from '../domain/posts.js';
import { followers, following, friends, suggestions, followRequests } from '../domain/social.js';
import { hub } from '../realtime/hub.js';
import { recommendationSettings } from '../domain/recommend.js';
import { totalUnread } from '../domain/messaging.js';
import { listDrafts } from '../domain/content.js';

function resolveUserId(ctx, idOrUsername) {
  const raw = String(idOrUsername || '').trim();
  if (!raw) throw badRequest('user_not_found', 'Usuario nao informado');
  // `me` e `eu` resolvem para o proprio usuario da sessao (nunca para um id
  // literal chamado "me"). Exige login.
  if (raw === 'me' || raw === 'eu') {
    if (!ctx.user) throw unauthorized('login_required', 'Faca login para usar este recurso');
    return ctx.user;
  }
  if (raw.startsWith('@')) {
    const user = getUserByUsername(raw);
    if (!user) throw notFound('user_not_found', 'Usuario nao encontrado');
    return user;
  }
  const user = getUserById(raw) || getUserByUsername(raw);
  if (!user) throw notFound('user_not_found', 'Usuario nao encontrado');
  return user;
}

// --------------------------------------------------------------------------
// Perfil publico
// --------------------------------------------------------------------------
router.get('/api/users/:idOrUsername', endpoint(async (ctx, res) => {
  const user = resolveUserId(ctx, ctx.params.idOrUsername);
  const viewer = ctx.user;
  const self = Boolean(viewer && viewer.id === user.id);
  if (!self) assertCanViewAccount(viewer?.id ?? null, user.id);
  const profile = getProfile(user.id);
  const posts = userPosts({ userId: user.id, viewer, limit: 12 });
  const followState = viewer
    ? get('SELECT status FROM follows WHERE follower_id = ? AND followee_id = ?', { followerId: viewer.id, followeeId: user.id })
    : null;

  writeJson(res, 200, {
    user: publicUser(user, viewer, { withCounts: true }),
    bio: user.bio ?? '',
    website: user.website ?? '',
    location: user.location ?? '',
    coverUrl: user.cover_key ? `/api/media/stream?key=${encodeURIComponent(user.cover_key)}` : null,
    privacy: {
      accountPrivacy: profile?.account_privacy ?? 'public',
      friendOnly: Boolean(profile?.friend_only),
      whoCanFollow: profile?.who_can_follow ?? 'everyone',
      whoCanComment: profile?.who_can_comment ?? 'everyone',
      whoCanMessage: profile?.who_can_message ?? 'everyone',
      whoCanSeeLikes: profile?.who_can_see_likes ?? 'everyone',
      whoCanSeeReposts: profile?.who_can_see_reposts ?? 'everyone',
      downloadAllowed: profile?.download_allowed ?? 'everyone',
    },
    counts: getUserCounts(user.id),
    relation: viewer
      ? {
        isSelf: viewer.id === user.id,
        isFollowing: isFollowing(viewer.id, user.id),
        isFriend: isFriend(viewer.id, user.id),
        isBlocked: blockedEitherWay(viewer.id, user.id),
        followStatus: followState?.status ?? 'none',
      }
      : null,
    posts,
  });
}));

// --------------------------------------------------------------------------
// Listas do perfil
// --------------------------------------------------------------------------
router.get('/api/users/:idOrUsername/posts', endpoint(async (ctx, res) => {
  const user = resolveUserId(ctx, ctx.params.idOrUsername);
  assertCanViewAccount(ctx.user?.id ?? null, user.id);
  const { limit, offset } = v.pagination(ctx.query, { defaultLimit: 18, maxLimit: 36 });
  const type = ctx.query.type ? v.oneOf(ctx.query.type, ['video', 'image', 'text', 'live', 'repost'], { field: 'type', required: false }) : null;
  writeJson(res, 200, {
    posts: userPosts({ userId: user.id, viewer: ctx.user, limit, offset, type }),
    nextOffset: offset + limit,
  });
}));

router.get('/api/users/:idOrUsername/liked', endpoint(async (ctx, res) => {
  const user = resolveUserId(ctx, ctx.params.idOrUsername);
  canSeeLikeList(ctx.user?.id ?? null, user.id);
  const { limit, offset } = v.pagination(ctx.query, { defaultLimit: 24, maxLimit: 50 });
  writeJson(res, 200, { posts: userLikedPosts({ userId: user.id, viewer: ctx.user, limit, offset }) });
}));

router.get('/api/users/:idOrUsername/reposts', endpoint(async (ctx, res) => {
  const user = resolveUserId(ctx, ctx.params.idOrUsername);
  canSeeRepostList(ctx.user?.id ?? null, user.id);
  const { limit, offset } = v.pagination(ctx.query, { defaultLimit: 24, maxLimit: 50 });
  writeJson(res, 200, { posts: userReposts({ userId: user.id, viewer: ctx.user, limit, offset }) });
}));

router.get('/api/users/:idOrUsername/favorites', endpoint(async (ctx, res) => {
  const user = resolveUserId(ctx, ctx.params.idOrUsername);
  if (!ctx.user || ctx.user.id !== user.id) {
    throw forbidden('favorites_private', 'Favoritos sao privados');
  }
  const { limit, offset } = v.pagination(ctx.query, { defaultLimit: 24, maxLimit: 50 });
  writeJson(res, 200, { posts: favoritesFeed({ viewer: ctx.user, limit, offset }) });
}));

router.get('/api/users/:idOrUsername/history', endpoint(async (ctx, res) => {
  const user = resolveUserId(ctx, ctx.params.idOrUsername);
  if (!ctx.user || ctx.user.id !== user.id) throw forbidden('history_private', 'Historico e privado');
  const { limit, offset } = v.pagination(ctx.query, { defaultLimit: 24, maxLimit: 50 });
  writeJson(res, 200, { posts: historyFeed({ viewer: ctx.user, limit, offset }) });
}));

router.get('/api/users/:idOrUsername/followers', endpoint(async (ctx, res) => {
  const user = resolveUserId(ctx, ctx.params.idOrUsername);
  assertCanViewAccount(ctx.user?.id ?? null, user.id);
  const { limit, offset } = v.pagination(ctx.query, { defaultLimit: 50, maxLimit: 100 });
  writeJson(res, 200, { users: followers({ userId: user.id, viewer: ctx.user, limit, offset }) });
}));

router.get('/api/users/:idOrUsername/following', endpoint(async (ctx, res) => {
  const user = resolveUserId(ctx, ctx.params.idOrUsername);
  assertCanViewAccount(ctx.user?.id ?? null, user.id);
  const { limit, offset } = v.pagination(ctx.query, { defaultLimit: 50, maxLimit: 100 });
  writeJson(res, 200, { users: following({ userId: user.id, viewer: ctx.user, limit, offset }) });
}));

router.get('/api/users/:idOrUsername/friends', endpoint(async (ctx, res) => {
  const user = resolveUserId(ctx, ctx.params.idOrUsername);
  const self = Boolean(ctx.user && ctx.user.id === user.id);
  if (!self) {
    const profile = getProfile(user.id);
    if (profile?.friend_only || profile?.account_privacy === 'private') {
      assertCanViewAccount(ctx.user?.id ?? null, user.id);
    }
  }
  const { limit, offset } = v.pagination(ctx.query, { defaultLimit: 100, maxLimit: 200 });
  writeJson(res, 200, { users: friends({ userId: user.id, viewer: ctx.user, limit, offset }) });
}));

router.get('/api/users/:idOrUsername/collections', endpoint(async (ctx, res) => {
  const user = resolveUserId(ctx, ctx.params.idOrUsername);
  const self = Boolean(ctx.user && ctx.user.id === user.id);
  if (!self) throw forbidden('collections_private', 'Colecoes sao privadas');
  writeJson(res, 200, { collections: collectionsFor(user.id, ctx.user) });
}));

router.get('/api/me/collections', endpoint(async (ctx, res) => {
  writeJson(res, 200, { collections: collectionsFor(ctx.user.id, ctx.user) });
}), { auth: true });

// --------------------------------------------------------------------------
// Conta propria
// --------------------------------------------------------------------------
router.get('/api/me/overview', endpoint(async (ctx, res) => {
  assertSettingsExist(ctx.user.id);
  writeJson(res, 200, {
    user: publicUser(ctx.user, ctx.user, { withCounts: true }),
    counts: getUserCounts(ctx.user.id),
    drafts: listDrafts(ctx.user.id),
    recommendations: recommendationSettings(ctx.user.id),
    unreadMessages: totalUnread(ctx.user.id),
    realtime: hub.stats(),
  });
}), { auth: true });

// --------------------------------------------------------------------------
// Sugestoes / requisicoes
// --------------------------------------------------------------------------
router.get('/api/suggestions/users', endpoint(async (ctx, res) => {
  const limit = v.int(ctx.query.limit, { field: 'limit', min: 1, max: 50, required: false, fallback: 20 });
  writeJson(res, 200, { users: suggestions({ viewerId: ctx.user.id, limit }) });
}), { auth: true });

router.get('/api/me/follow-requests', endpoint(async (ctx, res) => {
  writeJson(res, 200, { requests: followRequests({ userId: ctx.user.id }) });
}), { auth: true });

// --------------------------------------------------------------------------
// Bloqueios / silenciamentos
// --------------------------------------------------------------------------
router.get('/api/me/blocks', endpoint(async (ctx, res) => {
  const users = blockList(ctx.user.id).map((row) => {
    const user = getUserById(row.userId);
    return user ? { ...publicUser(user, ctx.user), blockedAt: row.createdAt } : null;
  }).filter(Boolean);
  writeJson(res, 200, { users });
}), { auth: true });

router.get('/api/me/mutes', endpoint(async (ctx, res) => {
  const rows = muteList(ctx.user.id).map((m) => ({
    ...m,
    user: m.targetType === 'user' ? publicUser(getUserById(m.targetId), ctx.user) : null,
  }));
  writeJson(res, 200, { mutes: rows });
}), { auth: true });

// --------------------------------------------------------------------------
// Conversa direta a partir de um perfil
// --------------------------------------------------------------------------
router.post('/api/users/:idOrUsername/message', endpoint(async (ctx, res) => {
  const user = resolveUserId(ctx, ctx.params.idOrUsername);
  const { findOrCreateConversation } = await import('../domain/messaging.js');
  const conversationId = findOrCreateConversation({ userA: ctx.user.id, userB: user.id });
  writeJson(res, 200, { conversationId, participant: publicUser(user, ctx.user) });
}), { auth: true, rate: 'write' });

// --------------------------------------------------------------------------
// Mencao direta: resolve @username -> perfil
// --------------------------------------------------------------------------
router.get('/api/mention/:username', endpoint(async (ctx, res) => {
  const user = getUserByUsername(v.str(ctx.params.username, { field: 'username', max: 24 }));
  if (!user) throw notFound('user_not_found', 'Usuario nao encontrado');
  writeJson(res, 200, { user: publicUser(user, ctx.user) });
}));

export { resolveUserId };
