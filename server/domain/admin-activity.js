/**
 * Eventos administrativos em TEMPO REAL (itens 17, 18 e 19).
 *
 * O painel administrativo nao pode depender de F5 nem de polling. Este
 * modulo e o ponto unico que publica os eventos de atividade para o topico
 * `admin:events`, que so aceita staff (ver `hub.canSubscribe`, que le o papel
 * do usuario no banco).
 *
 * Nao e um sistema paralelo: usa o hub realtime que ja existe e o mesmo
 * snapshot (`/api/admin/overview`). O backend continua sendo a fonte da
 * verdade; o frontend so re-renderiza o componente afetado.
 */
import hub from '../realtime/hub.js';
import { topics } from '../realtime/protocol.js';

export const ADMIN_EVENTS = {
  /** Usuario entrou (socket autenticado). */
  USER_ONLINE: 'ADMIN_USER_ONLINE',
  /** Usuario saiu (fechou o ultimo socket). */
  USER_OFFLINE: 'ADMIN_USER_OFFLINE',
  /** Conta nova criada. */
  USER_CREATED: 'ADMIN_USER_CREATED',
  /** Nova publicacao no feed. */
  VIDEO_CREATED: 'ADMIN_VIDEO_CREATED',
  /** LIVE iniciada. */
  LIVE_STARTED: 'ADMIN_LIVE_STARTED',
  /** LIVE encerrada. */
  LIVE_ENDED: 'ADMIN_LIVE_ENDED',
  /** Denuncia criada. */
  REPORT_CREATED: 'ADMIN_REPORT_CREATED',
  /** Acao de moderacao aplicada (mute/suspend/ban/unban/remove). */
  MODERATION_APPLIED: 'ADMIN_MODERATION_APPLIED',
  /** Contagens mudaram (para atualizar o snapshot sem recarregar tudo). */
  STATS_CHANGED: 'ADMIN_STATS_CHANGED',
};

/**
 * Publica um evento administrativo.
 *
 * @param {string} type um de ADMIN_EVENTS
 * @param {object} payload dados ja prontos para exibicao (sem segredo)
 * @returns {object|null} evento publicado, ou null se ninguem assinando
 */
export function publishAdminEvent(type, payload = {}) {
  const topic = topics.adminEvents();
  // Sem assinantes, `publish` ainda gera event_id/seq (barato) mas nao entrega.
  // Checamos antes para nao poluir o log de sequencia a cada like.
  const set = hub.topics.get(topic);
  if (!set?.size) return null;
  return hub.publish(topic, type, payload);
}

/** Atalho: ha alguem olhando o painel agora? */
export function adminWatching() {
  return Boolean(hub.topics.get(topics.adminEvents())?.size);
}

/**
 * Monta o payload de uma atividade recente para o painel.
 * `kind` e usado pelo frontend para escolher o icone/cor sem interpretar texto.
 */
export function adminActivity(kind, summary, extra = {}) {
  return { kind, summary, at: Date.now(), ...extra };
}

// --------------------------------------------------------------------------
// Ganchos automaticos
// --------------------------------------------------------------------------

/**
 * Liga presenca (online/offline) ao fluxo administrativo. Os hooks sao os
 * mesmos que o hub ja usa para outras finalidades - nada de timer ou polling.
 */
export function wireAdminActivity() {
  const anteriorOnline = hub.onUserOnline;
  const anteriorOffline = hub.onUserOffline;

  hub.onUserOnline = async (user) => {
    if (anteriorOnline) await anteriorOnline(user);
    publishAdminEvent(ADMIN_EVENTS.USER_ONLINE, {
      ...adminActivity('user_online', `@${user.username} entrou online`),
      userId: user.id,
      username: user.username,
      onlineCount: hub.onlineUserCount(),
    });
    publishAdminEvent(ADMIN_EVENTS.STATS_CHANGED, { online: hub.onlineUserCount(), sockets: hub.sockets.size });
  };

  hub.onUserOffline = async (userId) => {
    if (anteriorOffline) await anteriorOffline(userId);
    // O usuario pode ja ter sauido; so emitimos se ainda existir.
    const user = (await import('./users.js')).getUserById(userId);
    publishAdminEvent(ADMIN_EVENTS.USER_OFFLINE, {
      ...adminActivity('user_offline', user ? `@${user.username} saiu` : 'Um usuario saiu'),
      userId,
      username: user?.username || null,
      onlineCount: hub.onlineUserCount(),
    });
    publishAdminEvent(ADMIN_EVENTS.STATS_CHANGED, { online: hub.onlineUserCount(), sockets: hub.sockets.size });
  };
}