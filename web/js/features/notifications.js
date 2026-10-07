/** Notificacoes: lista, marcar como lida e configuracoes de push. */
import { api } from '../core/api.js';
import { el, icon, formatTime } from '../core/dom.js';
import { emptyState, toastError, toastSuccess, openModal } from '../core/ui.js';
import { store, refreshCounts, setCounts } from '../core/store.js';
import { realtime } from '../core/realtime.js';

const ICON_BY_TYPE = {
  like: 'heart',
  comment_like: 'heart',
  comment: 'comment',
  reply: 'comment',
  follow: 'users',
  follow_request: 'users',
  follow_accepted: 'users',
  mention: 'at',
  repost: 'replay',
  message: 'inbox',
  live_comment: 'live',
  live_start: 'live',
  story_reply: 'camera',
  warning: 'warning',
  system: 'bell',
  activity: 'bell',
};

const TEXT_BY_TYPE = {
  like: 'curtiu seu video',
  comment_like: 'curtiu seu comentario',
  comment: 'comentou no seu video',
  reply: 'respondeu seu comentario',
  follow: 'comecou a te seguir',
  follow_request: 'solicitou te seguir',
  follow_accepted: 'aceitou seu pedido de seguir',
  mention: 'mencionou voce',
  repost: 'repostou seu video',
  message: 'enviou uma mensagem',
  live_comment: 'comentou na sua LIVE',
  live_start: 'iniciou uma LIVE',
  story_reply: 'respondeu seu story',
  warning: 'recebeu um aviso da moderacao',
  system: 'aviso do sistema',
  activity: 'atividade na sua conta',
};

export function createNotificationsScreen() {
  const page = el('div', { class: 'page' });
  const host = el('div');
  page.append(host);
  const seen = new Set();

  const linkFor = (notification) => {
    if (notification.entityType === 'post') return `/video/${notification.entityId}`;
    if (notification.entityType === 'conversation') return `/inbox/${notification.entityId}`;
    if (notification.entityType === 'live') return `/live/${notification.entityId}`;
    if (notification.entityType === 'comment') return `/notificacoes`;
    return null;
  };

  const node = (notification) => {
    const link = linkFor(notification);
    const inner = [
      el('div', { class: 'avatar sm' }, [
        notification.actor?.avatarUrl
          ? el('img', { src: notification.actor.avatarUrl, alt: '', loading: 'lazy' })
          : el('div', { class: 'avatar sm' }, [icon(ICON_BY_TYPE[notification.type] || 'bell')]),
      ]),
      el('div', { class: 'grow' }, [
        el('div', { class: 'small' }, [
          notification.actor
            ? el('a', {
              href: `/@${notification.actor.username}`,
              class: 'strong',
              'data-link': true,
              style: { color: 'inherit', textDecoration: 'none' },
              text: `@${notification.actor.username}`,
            })
            : el('span', { class: 'strong', text: 'MARIA FÃS' }),
          el('span', { text: ` ${TEXT_BY_TYPE[notification.type] || 'interagiu com voce'}` }),
          notification.body ? el('span', { class: 'faint', text: `: ${notification.body.slice(0, 80)}` }) : null,
        ]),
        el('div', { class: 'tiny faint', text: formatTime(notification.createdAt) }),
      ]),
      notification.read ? null : el('span', { style: { width: '8px', height: '8px', borderRadius: '50%', background: 'var(--brand-2)' } }),
    ];

    const element = link
      ? el('a', {
        class: 'list-item',
        href: link,
        'data-link': true,
        style: notification.read ? {} : { background: 'color-mix(in srgb, var(--brand-2) 8%, var(--bg-elev))' },
        onClick: () => markRead(notification.id),
      }, inner)
      : el('div', { class: 'list-item', onClick: () => markRead(notification.id) }, inner);

    if (notification.type === 'warning') {
      element.style.borderColor = 'var(--danger)';
    }
    return element;
  };

  const markRead = async (id) => {
    try {
      const result = await api.post('/api/notifications/read', { id });
      setCounts({ notifications: result.unread });
      const target = host.querySelector(`[data-id="${CSS.escape(id)}"]`);
      if (target) target.style.background = 'var(--bg-elev)';
    } catch { /* silencioso */ }
  };

  const render = (notifications) => {
    host.replaceChildren();
    seen.clear();
    // Item 25: titulo e acoes em blocos proprios. Em tela estreita o titulo
    // ocupa a linha inteira e os botoes ficam abaixo, lado a lado - texto
    // nunca em cima de texto.
    host.append(
      el('div', { class: 'page-head mb' }, [
        el('h1', { class: 'page-title', style: { margin: '0' }, text: 'Notificacoes' }),
        el('div', { class: 'page-head-actions' }, [
          el('button', {
            type: 'button', class: 'btn btn-sm btn-ghost', text: 'Marcar todas como lidas',
            onClick: async () => {
              try {
                const result = await api.post('/api/notifications/read', { all: true });
                setCounts({ notifications: result.unread });
                load();
              } catch (err) { toastError(err); }
            },
          }),
          el('button', {
            type: 'button', class: 'btn btn-sm btn-ghost', text: 'Preferencias',
            onClick: () => openPreferences(),
          }),
        ]),
      ]),
    );

    if (!notifications.length) {
      host.append(emptyState({ iconName: 'bell', title: 'Sem notificacoes', message: 'Curtidas, comentarios, seguidores e mensagens aparecem aqui.' }));
      return;
    }

    const list = el('div', { class: 'list' });
    for (const notification of notifications) {
      const element = node(notification);
      if (seen.has(notification.id)) continue;
      seen.add(notification.id);
      element.dataset.id = notification.id;
      list.append(element);
    }
    host.append(list);
  };

  const openPreferences = async () => {
    const { settings } = await api.get('/api/me/settings');
    const n = settings.notifications;
    const list = el('div', { class: 'setting-group' });
    const toggles = [
      ['likes', 'Curtidas e comentarios curtidos'],
      ['comments', 'Comentarios'],
      ['replies', 'Respostas'],
      ['follows', 'Novos seguidores e pedidos'],
      ['mentions', 'Mencoes'],
      ['reposts', 'Reposts'],
      ['messages', 'Mensagens'],
      ['lives', 'Atividade em LIVE'],
      ['activity', 'Atividade geral'],
      ['pushEnabled', 'Notificacoes push no dispositivo'],
    ];
    for (const [key, label] of toggles) {
      const toggle = el('input', { type: 'checkbox', checked: n[key] });
      toggle.addEventListener('change', async () => {
        try {
          await api.patch('/api/me/notification-settings', { [key]: toggle.checked });
          toastSuccess('Preferencia salva');
        } catch (err) { toastError(err); }
      });
      list.append(el('div', { class: 'switch' }, [el('span', { text: label }), toggle]));
    }
    if (!store.appConfig.features?.push) {
      list.append(el('p', { class: 'tiny faint', text: 'Push ainda nao configurado no servidor (VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY).' }));
    }
    openModal({ title: 'Preferencias de notificacao', size: '460px', body: list });
  };

  const load = async () => {
    host.replaceChildren(el('div', { class: 'page-empty' }, [el('div', { class: 'spinner', style: { margin: '0 auto' } })]));
    try {
      const data = await api.get('/api/notifications', { query: { limit: 50 } });
      render(data.notifications || []);
      setCounts({ notifications: data.unread || 0 });
    } catch (err) {
      host.replaceChildren(emptyState({ iconName: 'warning', title: 'Falha ao carregar', message: err.message }));
    }
  };

  // Notificacoes que chegam enquanto a tela esta aberta
  const onNotification = (event) => {
    const notification = event.detail?.notification;
    if (!notification) return;
    const list = host.querySelector('.list');
    if (!list) return;
    const element = node(notification);
    element.dataset.id = notification.id;
    list.prepend(element);
    refreshCounts().catch(() => {});
  };
  realtime.addEventListener('NOTIFICATION', onNotification);

  return {
    element: page,
    async load() { await load(); },
    destroy() {
      realtime.removeEventListener('NOTIFICATION', onNotification);
      page.replaceChildren();
      page.remove();
    },
  };
}
