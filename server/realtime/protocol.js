/**
 * Eventos realtime padronizados da plataforma.
 * Cada evento carrega: event_id, type, topic, timestamp, seq e payload.
 */
export const EVENTS = {
  LIKE: 'LIKE',
  UNLIKE: 'UNLIKE',
  COMMENT: 'COMMENT',
  COMMENT_DELETE: 'COMMENT_DELETE',
  FOLLOW: 'FOLLOW',
  UNFOLLOW: 'UNFOLLOW',
  MESSAGE: 'MESSAGE',
  MESSAGE_READ: 'MESSAGE_READ',
  NOTIFICATION: 'NOTIFICATION',
  LIVE_JOIN: 'LIVE_JOIN',
  LIVE_LEAVE: 'LIVE_LEAVE',
  LIVE_DIRECTORY_CHANGE: 'LIVE_DIRECTORY_CHANGE',
  LIVE_COMMENT: 'LIVE_COMMENT',
  LIVE_HEART: 'LIVE_HEART',
  // Orientacao do quadro do anfitriao: quando a camera so entrega landscape
  // numa tela portrait, o quadro e girado 90 graus para caber em tela cheia sem
  // zoom. O valor e um unico numero (0, 90 ou 270) e NAO e persistido: e estado
  // de exibicao, valido enquanto a LIVE estiver no ar.
  LIVE_VIDEO_ROTATION: 'LIVE_VIDEO_ROTATION',
  // Presenca do host: heartbeat periodico para encerramento automatico
  LIVE_HOST_HEARTBEAT: 'LIVE_HOST_HEARTBEAT',
  EFFECT_TRIGGER: 'EFFECT_TRIGGER',
  // Complementares do mesmo sistema (sem sistema duplicado):
  POST_CREATED: 'POST_CREATED',
  POST_UPDATED: 'POST_UPDATED',
  POST_DELETED: 'POST_DELETED',
  REPOST: 'REPOST',
  UNREPOST: 'UNREPOST',
  FAVORITE: 'FAVORITE',
  UNFAVORITE: 'UNFAVORITE',
  STORY_NEW: 'STORY_NEW',
  GLOBAL_CHAT_MESSAGE: 'GLOBAL_CHAT_MESSAGE',
  GLOBAL_CHAT_DELETE: 'GLOBAL_CHAT_DELETE',
  PRESENCE: 'PRESENCE',
  MODERATION: 'MODERATION',
  SESSION_REVOKED: 'SESSION_REVOKED',
  COUNTS: 'COUNTS',
};

export const CLIENT_FRAMES = {
  AUTH: 'AUTH',
  SUBSCRIBE: 'SUBSCRIBE',
  UNSUBSCRIBE: 'UNSUBSCRIBE',
  PUBLISH: 'PUBLISH',
  PING: 'PING',
  LIVE_SIGNAL: 'LIVE_SIGNAL',
};

// --------------------------------------------------------------------------
// Topicos. Format: user:<id> | live:<roomId> | live:host:<userId> |
// post:<id> | global-chat
// --------------------------------------------------------------------------
export const topics = {
  user: (userId) => `user:${userId}`,
  live: (roomId) => `live:${roomId}`,
  liveDirectory: () => 'live:directory',
  liveHost: (userId) => `live:host:${userId}`,
  post: (postId) => `post:${postId}`,
  globalChat: () => 'global-chat',
  /** Item 7: entrada de novas publicacoes no feed, para qualquer cliente. */
  feedNew: () => 'feed:new',
  /**
   * Itens 17 e 18: fluxo de atividade do painel administrativo. Restrito a
   * staff (moderador/admin) - ver `canSubscribe` no hub, que consulta o papel
   * do usuario no banco, nunca no cliente.
   */
  adminEvents: () => 'admin:events',
};

export function isValidTopic(topic) {
  return (
    typeof topic === 'string' &&
    topic.length <= 80 &&
    (/^user:[A-Za-z0-9_-]{1,64}$/.test(topic) ||
      /^live:[A-Za-z0-9_-]{1,64}$/.test(topic) ||
      /^live:host:[A-Za-z0-9_-]{1,64}$/.test(topic) ||
      topic === 'live:directory' ||
      /^post:[A-Za-z0-9_-]{1,64}$/.test(topic) ||
      topic === 'global-chat' ||
      topic === 'feed:new' ||
      topic === 'admin:events')
  );
}
