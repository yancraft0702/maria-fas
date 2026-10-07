import { forbidden, notFound } from '../lib/errors.js';
import { getUserById, isFollowing, isFriend, blockedEitherWay, isBlocked, getProfile } from './users.js';

/**
 * Audience levels (do mais restritivo ao mais aberto).
 * A resolucao e feita SEMPRE no backend.
 */
export const AUDIENCE = {
  EVERYONE: 'everyone',
  FOLLOWERS: 'followers',
  FRIENDS: 'friends',
  NOBODY: 'nobody',
};

export const AUDIENCE_VALUES = Object.values(AUDIENCE);

/** Quem pode ver a conta inteira (perfis, listas). */
export function canViewAccount(viewerId, targetUserId) {
  if (!targetUserId) return false;
  if (viewerId && viewerId === targetUserId) return true;
  const target = getUserById(targetUserId);
  if (!target) return false;
  if (viewerId && blockedEitherWay(viewerId, targetUserId)) return false;
  const profile = getProfile(targetUserId);
  if (!profile) return true;
  if (!viewerId) {
    return profile.account_privacy === 'public' && !profile.friend_only;
  }
  if (profile.account_privacy === 'public' && !profile.friend_only) return true;
  if (profile.account_privacy === 'private' && !profile.friend_only) return false;
  // friend_only ativo
  if (isFriend(viewerId, targetUserId)) return true;
  return false;
}

/** Resolve um nivel de audiencia contra um par (viewer, dono). */
export function audienceAllows(audience, viewerId, ownerId) {
  if (!ownerId) return audience !== AUDIENCE.NOBODY;
  if (viewerId && viewerId === ownerId) return true;
  switch (audience) {
    case AUDIENCE.EVERYONE:
      return true;
    case AUDIENCE.FOLLOWERS:
      return Boolean(viewerId && isFollowing(viewerId, ownerId));
    case AUDIENCE.FRIENDS:
      return Boolean(viewerId && isFriend(viewerId, ownerId));
    case AUDIENCE.NOBODY:
      return false;
    default:
      return false;
  }
}

export function isStaffViewer(viewer) {
  return Boolean(viewer && (viewer.role === 'admin' || viewer.role === 'moderator'));
}

/**
 * Pode ver o post? Combina: conta do autor, visibilidade do post,
 * bloqueios bilaterais e lista de ocultos.
 */
export function canViewPost(post, viewer = null) {
  if (!post || post.status === 'deleted') return false;
  const viewerId = viewer?.id ?? null;
  if (viewerId && post.author_id === viewerId) return true;
  if (blockedEitherWay(viewerId, post.author_id)) return false;

  if (post.visibility === 'private') return false;
  if (post.visibility === 'friends') {
    return Boolean(viewerId && isFriend(viewerId, post.author_id));
  }
  if (post.visibility === 'followers') {
    return Boolean(viewerId && isFollowing(viewerId, post.author_id));
  }
  // public: respeita conta privada / somente amigos
  return canViewAccount(viewerId, post.author_id);
}

export function assertCanViewPost(post, viewer = null) {
  if (!post) throw notFound('post_not_found', 'Video nao encontrado');
  if (post.status === 'deleted') throw notFound('post_deleted', 'Este conteudo foi removido');
  if (!canViewPost(post, viewer)) {
    throw forbidden('post_not_visible', 'Este conteudo nao esta disponivel para sua conta');
  }
  return post;
}

export function assertCanViewAccount(viewerId, targetUserId) {
  if (!canViewAccount(viewerId, targetUserId)) {
    // resposta ambigua de proposito: nao revela existencia de conta privada
    throw forbidden('account_not_visible', 'Esta conta nao esta disponivel');
  }
}

export function canFollow(viewerId, targetUserId) {
  if (!viewerId || viewerId === targetUserId) return false;
  const target = getUserById(targetUserId);
  if (!target || target.status !== 'active') return false;
  if (blockedEitherWay(viewerId, targetUserId)) return false;
  const profile = getProfile(targetUserId);
  if (!profile) return false;
  return audienceAllows(profile.who_can_follow, viewerId, targetUserId);
}

export function canComment(viewerId, post, authorId) {
  if (!viewerId) return false;
  if (!post?.comments_enabled) return false;
  if (blockedEitherWay(viewerId, authorId)) return false;
  const profile = getProfile(authorId);
  if (!profile) return true;
  return audienceAllows(profile.who_can_comment, viewerId, authorId);
}

export function canMessage(viewerId, targetUserId) {
  if (!viewerId || viewerId === targetUserId) return false;
  const target = getUserById(targetUserId);
  if (!target || target.status !== 'active') return false;
  if (blockedEitherWay(viewerId, targetUserId)) return false;
  const profile = getProfile(targetUserId);
  if (!profile) return true;
  return audienceAllows(profile.who_can_message, viewerId, targetUserId);
}

export function canMention(viewerId, targetUserId) {
  if (!viewerId || viewerId === targetUserId) return true;
  if (blockedEitherWay(viewerId, targetUserId)) return false;
  const profile = getProfile(targetUserId);
  if (!profile) return true;
  return audienceAllows(profile.who_can_mention, viewerId, targetUserId);
}

export function canTag(viewerId, targetUserId) {
  if (!viewerId || viewerId === targetUserId) return true;
  if (blockedEitherWay(viewerId, targetUserId)) return false;
  const profile = getProfile(targetUserId);
  if (!profile) return true;
  return audienceAllows(profile.who_can_tag, viewerId, targetUserId);
}

export function canSeeLikeList(viewerId, ownerId) {
  if (viewerId && viewerId === ownerId) return true;
  const profile = getProfile(ownerId);
  if (!profile) return true;
  return audienceAllows(profile.who_can_see_likes, viewerId, ownerId);
}

export function canSeeRepostList(viewerId, ownerId) {
  if (viewerId && viewerId === ownerId) return true;
  const profile = getProfile(ownerId);
  if (!profile) return true;
  return audienceAllows(profile.who_can_see_reposts, viewerId, ownerId);
}

export function canDownloadPost(viewerId, post) {
  if (!post) return false;
  if (viewerId && viewerId === post.author_id) return true;
  const profile = getProfile(post.author_id);
  if (!profile) return true;
  if (post.download_allowed && post.download_allowed !== AUDIENCE.EVERYONE) {
    return audienceAllows(post.download_allowed, viewerId, post.author_id);
  }
  return audienceAllows(profile.download_allowed, viewerId, post.author_id);
}

export function canRemixPost(viewerId, post) {
  if (!post) return false;
  if (viewerId && viewerId === post.author_id) return true;
  const profile = getProfile(post.author_id);
  if (!profile) return true;
  if (post.remix_allowed && post.remix_allowed !== AUDIENCE.EVERYONE) {
    return audienceAllows(post.remix_allowed, viewerId, post.author_id);
  }
  return audienceAllows(profile.remix_allowed, viewerId, post.author_id);
}

/** Quem pode ver comentarios de um post (mesma regra do post). */
export function canViewComments(viewer, post) {
  return canViewPost(post, viewer);
}

export function canInteract(viewerId, authorId) {
  if (!viewerId) return false;
  if (viewerId === authorId) return false;
  if (isBlocked(authorId, viewerId)) return false; // bloqueado nao interage
  return true;
}

export function canViewStory(story, viewer = null) {
  const viewerId = viewer?.id ?? null;
  if (viewerId && story.author_id === viewerId) return true;
  if (blockedEitherWay(viewerId, story.author_id)) return false;
  return canViewAccount(viewerId, story.author_id);
}

export function canJoinLive(room, user = null) {
  if (!room || room.status !== 'live') return false;
  const userId = user?.id ?? null;
  if (userId && room.host_id === userId) return true;
  const host = getUserById(room.host_id);
  if (!host || host.status !== 'active') return false;
  return canViewAccount(userId, room.host_id);
}
