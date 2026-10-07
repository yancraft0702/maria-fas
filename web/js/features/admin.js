/** Painel administrativo: usuarios, conteudo, denuncias, LIVE, chat, bans, mutes, logs e sistema. */
import { api } from '../core/api.js';
import { el, icon, formatCount, formatTime } from '../core/dom.js';
import { emptyState, toastError, toastSuccess, confirmDialog, openModal } from '../core/ui.js';
import { store } from '../core/store.js';
import { realtime } from '../core/realtime.js';
import { navigate } from '../core/router.js';

// Eventos administrativos (espelham ADMIN_EVENTS do servidor).
const ADMIN_EVENTS = [
  'ADMIN_USER_ONLINE',
  'ADMIN_USER_OFFLINE',
  'ADMIN_USER_CREATED',
  'ADMIN_VIDEO_CREATED',
  'ADMIN_LIVE_STARTED',
  'ADMIN_LIVE_ENDED',
  'ADMIN_REPORT_CREATED',
  'ADMIN_MODERATION_APPLIED',
  'ADMIN_STATS_CHANGED',
];

/** Icone por tipo de atividade - a cor tambem vem do tipo, nao do texto. */
const ACTIVITY_ICON = {
  user_online: 'user',
  user_offline: 'user',
  user_created: 'userPlus',
  video_created: 'film',
  live_started: 'live',
  live_ended: 'live',
  report_created: 'flag',
  moderation_applied: 'shield',
  stats_changed: 'activity',
};

const ACTIVITY_TONE = {
  user_online: 'ok',
  user_offline: 'idle',
  user_created: 'ok',
  video_created: 'brand',
  live_started: 'live',
  live_ended: 'idle',
  report_created: 'warn',
  moderation_applied: 'warn',
};

/**
 * Eventos sao agrupados nesta janela (ms). Com presenca de varias pessoas
 * conectando ao mesmo tempo, redesenhar a cada evento trava a interface; o
 * agrupamento mantem a fluidez sem perder nenhuma informacao.
 */
const ATIVIDADE_BATCH_MS = 400;
const ATIVIDADE_MAX = 40;

const TABS = [
  { id: 'painel', label: 'Painel' },
  { id: 'usuarios', label: 'Usuarios' },
  { id: 'conteudo', label: 'Conteudo' },
  { id: 'denuncias', label: 'Denuncias' },
  { id: 'live', label: 'LIVE' },
  { id: 'chat', label: 'Chat' },
  { id: 'moderacao', label: 'Acoes' },
  { id: 'sistema', label: 'Sistema' },
];

const MUTE_WINDOWS = [2, 4, 6, 10];

export function createAdminScreen() {
  const page = el('div', { class: 'page admin-page' });
  const nav = el('div', { class: 'settings-nav', role: 'tablist' });
  const body = el('div', { class: 'settings-body' });
  let current = 'painel';
  let overview = null;

  // --- Estado do realtime (itens 17 e 18) ---
  /** @type {Set<() => void>} */
  const cleanups = new Set();
  /** @type {Array<{kind: string, summary: string, at: number}>} */
  const activity = [];
  let liveRooms = [];
  let openReports = [];
  let unsubAdmin = null;
  let activityTimer = null;
  let onlineUsers = null;
  let connected = false;
  let destroyed = false;

  const isAdmin = store.user?.role === 'admin';

  /** Indicador de conexao no cabecalho: "Ao vivo" / "Reconectando...". */
  const connectionBadge = el('span', { class: 'admin-live', dataset: { state: 'idle' } }, [
    el('i'),
    el('span', { class: 'admin-live-text', text: 'conectando' }),
  ]);

  const setConnection = (state, text) => {
    connected = state === 'live';
    connectionBadge.dataset.state = state;
    connectionBadge.querySelector('.admin-live-text').textContent = text;
  };

  /**
   * Aplica um evento administrativo. Cada tipo mexe so no trecho que muda -
   * nao recarrega nem redesenha o painel inteiro (item 18).
   */
  const applyAdminEvent = (type, payload) => {
    if (destroyed) return;
    if (payload?.kind) {
      activity.unshift({ kind: payload.kind, summary: payload.summary, at: payload.at || Date.now() });
      if (activity.length > ATIVIDADE_MAX) activity.length = ATIVIDADE_MAX;
      scheduleActivity();
    }
    if (payload?.onlineCount != null) onlineUsers = payload.onlineCount;

    switch (type) {
      case 'ADMIN_USER_ONLINE':
      case 'ADMIN_USER_OFFLINE':
      case 'ADMIN_USER_CREATED':
      case 'ADMIN_STATS_CHANGED':
        patchOnlineCounter();
        break;
      case 'ADMIN_LIVE_STARTED':
        // A lista de LIVE da aba LIVE tem que refletir o ar sem F5.
        if (current === 'live') scheduleLiveRefresh();
        break;
      case 'ADMIN_LIVE_ENDED':
        if (current === 'live') scheduleLiveRefresh();
        break;
      case 'ADMIN_REPORT_CREATED':
        // Denuncia nova: contador + aviso quando a aba esta aberta.
        if (current === 'painel') patchOpenReports(payload?.category);
        if (current === 'denuncias') scheduleReportsRefresh();
        break;
      case 'ADMIN_MODERATION_APPLIED':
        if (current === 'painel' || current === 'moderacao') scheduleActivity();
        break;
      case 'ADMIN_VIDEO_CREATED':
        if (current === 'conteudo') scheduleContentRefresh();
        break;
      default:
        break;
    }
  };

  /**
   * Redesenhos sao adiados e agrupados: N eventos no mesmo tique viram um
   * unico render. Evita reconstrucao desnecessaria do DOM (item 21).
   */
  let pendingRender = 0;
  const schedule = (fn) => {
    if (destroyed || pendingRender) return;
    pendingRender = setTimeout(() => {
      pendingRender = 0;
      fn();
    }, ATIVIDADE_BATCH_MS);
  };

  const scheduleActivity = () => {
    if (activityTimer) return;
    activityTimer = setTimeout(() => {
      activityTimer = null;
      if (current === 'painel') renderPainel();
      else schedule(() => renderActivityOnly());
    }, ATIVIDADE_BATCH_MS);
  };

  const scheduleLiveRefresh = () => schedule(() => { if (current === 'live') renderLive(); });
  const scheduleReportsRefresh = () => schedule(() => { if (current === 'denuncias') renderReports(); });
  const scheduleContentRefresh = () => schedule(() => { if (current === 'conteudo') renderContent(); });

  /**
   * Atualiza SO o contador de online dentro do DOM ja renderizado. Sem novo
   * fetch e sem reconstruir a tela - e o que faz o painel parecer vivo.
   */
  const patchOnlineCounter = () => {
    if (onlineUsers == null) return;
    const node = body.querySelector('[data-admin-live-online]');
    if (node) node.textContent = formatCount(onlineUsers);
  };

  const patchOpenReports = () => {
    const node = body.querySelector('[data-admin-open-reports]');
    if (node) node.textContent = formatCount((Number(node.dataset.value) || 0) + 1);
  };

  const renderActivityOnly = () => {
    const host = body.querySelector('[data-admin-activity]');
    if (host) host.replaceChildren(...activityNodes());
  };

  const activityNodes = () => {
    if (!activity.length) {
      return [el('p', { class: 'small faint', text: 'Nenhuma atividade ainda nesta sessao.' })];
    }
    return activity.map((item) => el('div', { class: 'admin-activity-row', dataset: { tone: ACTIVITY_TONE[item.kind] || 'idle' } }, [
      el('span', { class: 'admin-activity-icon' }, [icon(ACTIVITY_ICON[item.kind] || 'activity')]),
      el('span', { class: 'grow', text: item.summary }),
      el('span', { class: 'tiny faint', text: formatTime(item.at) }),
    ]));
  };

  const renderNav = () => {
    nav.replaceChildren();
    for (const tab of TABS) {
      nav.append(el('button', {
        type: 'button', role: 'tab',
        text: tab.label,
        'aria-selected': String(current === tab.id),
        onClick: () => { current = tab.id; renderNav(); renderBody(); },
      }));
    }
  };

  const enforce = async (payload, description) => {
    try {
      await api.post('/api/admin/enforce', payload);
      toastSuccess(description);
      renderBody();
    } catch (err) { toastError(err); }
  };

  const renderBody = () => {
    body.replaceChildren(el('div', { class: 'page-empty' }, [el('div', { class: 'spinner', style: { margin: '0 auto' } })]));
    Promise.resolve({
      painel: renderPainel,
      usuarios: renderUsers,
      conteudo: renderContent,
      denuncias: renderReports,
      live: renderLive,
      chat: renderChat,
      moderacao: renderModerationLog,
      sistema: renderSystem,
    }[current]()).catch((err) => {
      body.replaceChildren(emptyState({ iconName: 'warning', title: 'Falha ao carregar', message: err.message }));
    });
  };

  // ---- Painel ----
  const renderPainel = async () => {
    // SNAPSHOT real: o backend e a fonte da verdade. Depois disso, o realtime
    // apenas ajusta o que muda (item 18).
    const data = await api.get('/api/admin/overview');
    if (destroyed) return;
    overview = data;
    openReports = data.reports || [];
    liveRooms = data.stats?.live?.active ?? 0;
    onlineUsers = data.stats?.users?.online ?? null;

    body.replaceChildren(
      el('section', { class: 'admin-hero' }, [
        el('div', { class: 'grow' }, [
          el('h2', { class: 'admin-hero-title', text: 'Resumo da plataforma' }),
          el('p', {
            class: 'small faint',
            text: 'Atualiza em tempo real. Nao precisa recarregar a pagina.',
          }),
        ]),
        connectionBadge,
      ]),

      el('div', { class: 'stat-grid admin-stats mb' }, [
        stat(formatCount(data.stats.users.total), 'usuarios', 'cadastrados'),
        stat(formatCount(data.stats.users.online), 'online agora', 'com socket aberto'),
        stat(formatCount(data.stats.users.new24h), 'novos (24h)', null),
        stat(formatCount(data.stats.content.posts), 'videos', `${data.stats.content.postsToday} hoje`),
        stat(formatCount(data.stats.live.active), 'LIVEs ativas', `${data.stats.live.viewers} espectadores`),
        stat(formatCount(openReports.length ? openReports.length : data.stats.content.reportsOpen), 'denuncias abertas', null, {
          value: data.stats.content.reportsOpen,
        }),
        stat(formatCount(data.stats.users.suspended), 'suspensos', null),
        stat(formatCount(data.stats.users.banned), 'banidos', null),
      ]),

      el('div', { class: 'admin-columns mb' }, [
        // ---- ATIVIDADE (realtime, sem F5) ----
        el('div', { class: 'card admin-card' }, [
          el('div', { class: 'admin-card-head' }, [
            el('h3', { class: 'admin-card-title', text: 'Atividade' }),
            el('span', { class: 'admin-card-hint', text: 'ao vivo' }),
          ]),
          el('div', { class: 'admin-activity', dataset: { adminActivity: '' } }, activityNodes()),
        ]),

        // ---- REALTIME / SISTEMA ----
        el('div', { class: 'card admin-card' }, [
          el('div', { class: 'admin-card-head' }, [
            el('h3', { class: 'admin-card-title', text: 'Realtime' }),
          ]),
          el('div', { class: 'admin-metric' }, [
            el('span', { class: 'grow', text: 'Sockets conectados' }),
            el('b', { text: String(data.realtime.sockets), dataset: { adminLiveSockets: '' } }),
          ]),
          el('div', { class: 'admin-metric' }, [
            el('span', { class: 'grow', text: 'Usuarios com socket' }),
            el('b', { text: String(data.realtime.users), dataset: { adminLiveOnline: '' } }),
          ]),
          el('div', { class: 'admin-metric' }, [
            el('span', { class: 'grow', text: 'Topicos ativos' }),
            el('b', { text: String(data.realtime.topics) }),
          ]),
          el('div', { class: 'admin-metric' }, [
            el('span', { class: 'grow', text: 'Mensagens no chat hoje' }),
            el('b', { text: String(data.stats.chat.globalToday) }),
          ]),
          el('div', { class: 'admin-metric' }, [
            el('span', { class: 'grow', text: 'Chat global (online)' }),
            el('b', { text: String(data.stats.chat.online) }),
          ]),
        ]),
      ]),

      el('div', { class: 'card admin-card mb' }, [
        el('div', { class: 'admin-card-head' }, [
          el('h3', { class: 'admin-card-title', text: 'Efeitos da LIVE' }),
          el('span', { class: 'admin-card-hint', text: 'alfa real medido em disco' }),
        ]),
        el('div', { class: 'list' }, (data.effects || []).map((effect) => el('div', { class: 'row small' }, [
          el('span', { class: 'grow', text: effect.slug }),
          effect.alphaReady
            ? el('span', { class: 'status-tag status-active', text: 'alfa em disco' })
            : el('span', { class: 'status-tag status-suspended', text: 'chroma-key na GPU' }),
        ]))),
      ]),

      // ---- MODERACAO ----
      el('div', { class: 'card admin-card' }, [
        el('div', { class: 'admin-card-head' }, [
          el('h3', { class: 'admin-card-title', text: 'Ultimas acoes de moderacao' }),
          el('button', {
            type: 'button', class: 'btn btn-sm btn-ghost', text: 'Ver tudo',
            onClick: () => { current = 'moderacao'; renderNav(); renderBody(); },
          }),
        ]),
        (data.moderationLog || []).length
          ? el('div', { class: 'list' }, data.moderationLog.map((entry) => el('div', { class: 'small' }, [
            el('span', { class: 'grow', text: `${entry.action} · ${entry.target_type} · por @${entry.moderator}` }),
            el('span', { class: 'tiny faint', text: formatTime(entry.created_at) }),
          ])))
          : el('p', { class: 'small faint', text: 'Nenhuma acao registrada.' }),
      ]),
    );
  };

  const stat = (value, label, hint, options = {}) => el('div', { class: 'stat admin-stat' }, [
    el('b', {
      text: value,
      ...(options.value != null ? { dataset: { adminOpenReports: '', value: String(options.value) } } : {}),
    }),
    el('span', { class: 'admin-stat-label', text: label }),
    hint ? el('span', { class: 'tiny faint', text: hint }) : null,
  ]);

  // ---- Usuarios ----
  const renderUsers = async () => {
    const query = body.querySelector('input[type="search"]')?.value || '';
    const status = body.querySelector('select[data-filter="status"]')?.value || '';
    const data = await api.get('/api/admin/users', { query: { limit: 60, q: query || undefined, status: status || undefined } });

    const search = el('input', { class: 'input', type: 'search', placeholder: 'Buscar por usuario ou email', value: query });
    search.addEventListener('keydown', (event) => { if (event.key === 'Enter') renderUsers(); });
    const statusSelect = el('select', { class: 'select', dataset: { filter: 'status' }, style: { maxWidth: '160px' } }, [
      el('option', { value: '', text: 'Todos os status' }),
      el('option', { value: 'active', text: 'Ativos' }),
      el('option', { value: 'suspended', text: 'Suspensos' }),
      el('option', { value: 'banned', text: 'Banidos' }),
    ]);
    statusSelect.value = status;
    statusSelect.addEventListener('change', () => renderUsers());

    const table = el('div', { class: 'table-wrap' }, [
      el('table', { class: 'data-table' }, [
        el('thead', {}, [el('tr', {}, [
          el('th', { text: 'Usuario' }),
          el('th', { text: 'Status' }),
          el('th', { text: 'Seguidores' }),
          el('th', { text: 'Videos' }),
          el('th', { text: 'Online' }),
          el('th', { text: 'Acoes' }),
        ])]),
        el('tbody', {}, data.users.map((user) => el('tr', {}, [
          el('td', {}, [
            el('div', { class: 'row' }, [
              el('div', { class: 'avatar xs' }, [user.avatarUrl ? el('img', { src: user.avatarUrl, alt: '', loading: 'lazy' }) : el('div', { class: 'avatar xs' })]),
              el('div', {}, [
                el('div', { text: `@${user.username}` }),
                el('div', { class: 'tiny faint', text: user.email || '' }),
              ]),
            ]),
          ]),
          el('td', {}, [el('span', { class: `status-tag status-${user.status}`, text: user.status })]),
          el('td', { text: formatCount(user.counts?.followerCount ?? 0) }),
          el('td', { text: formatCount(user.counts?.postCount ?? 0) }),
          el('td', { text: user.online ? 'sim' : 'nao' }),
          el('td', {}, [el('div', { class: 'row', style: { gap: '4px' } }, [
            el('button', { type: 'button', class: 'btn btn-sm btn-ghost', text: 'Detalhes', onClick: () => openUserDetail(user) }),
            user.status === 'active'
              ? el('button', { type: 'button', class: 'btn btn-sm btn-ghost', text: 'Silenciar', onClick: () => openMute(user) })
              : null,
            user.status === 'banned'
              ? el('button', { type: 'button', class: 'btn btn-sm btn-ghost', text: 'Desbanir', onClick: () => enforce({ targetType: 'user', targetId: user.id, action: 'unban' }, 'Ban removido') })
              : el('button', { type: 'button', class: 'btn btn-sm btn-danger', text: 'Banir', onClick: () => openBan(user) }),
          ])]),
        ]))),
      ]),
    ]);

    body.replaceChildren(
      el('h1', { class: 'page-title', text: 'Usuarios' }),
      el('div', { class: 'row mb' }, [search, statusSelect]),
      table,
    );
  };

  const openMute = (user) => {
    let minutes = MUTE_WINDOWS[0];
    const seg = el('div', { class: 'seg' });
    for (const value of MUTE_WINDOWS) {
      seg.append(el('button', {
        type: 'button', text: `${value} min`, 'aria-selected': String(minutes === value),
        onClick: (event) => {
          minutes = value;
          for (const other of seg.children) other.setAttribute('aria-selected', 'false');
          event.currentTarget.setAttribute('aria-selected', 'true');
        },
      }));
    }
    const reason = el('input', { class: 'input', placeholder: 'Motivo (opcional)', maxlength: '200' });
    openModal({
      title: `Silenciar @${user.username}`,
      size: '420px',
      body: el('div', {}, [
        el('p', { class: 'small muted', text: 'O usuario fica impedido de interagir por janela fixa. O fim e controlado pelo servidor.' }),
        el('div', { class: 'field' }, [el('label', { text: 'Janela' }), seg]),
        el('div', { class: 'field' }, [el('label', { text: 'Motivo' }), reason]),
      ]),
      actions: [
        { label: 'Cancelar', class: 'btn-ghost' },
        {
          label: 'Silenciar',
          class: 'btn-primary',
          onClick: async () => {
            await enforce({
              targetType: 'user', targetId: user.id, action: 'mute', minutes, reason: reason.value.trim(),
            }, `@${user.username} silenciado por ${minutes} minutos`);
            return true;
          },
        },
      ],
    });
  };

  const openBan = (user) => {
    const reason = el('input', { class: 'input', placeholder: 'Motivo do banimento', maxlength: '200' });
    openModal({
      title: `Banir @${user.username}`,
      size: '420px',
      body: el('div', {}, [
        el('p', { class: 'small muted', text: 'O ban encerra sessoes, desconecta o realtime, encerra LIVE em andamento e bloqueia novos logins. E persistente.' }),
        el('div', { class: 'field' }, [el('label', { text: 'Motivo' }), reason]),
      ]),
      actions: [
        { label: 'Cancelar', class: 'btn-ghost' },
        {
          label: 'Banir permanentemente',
          class: 'btn-danger',
          onClick: async () => {
            await enforce({
              targetType: 'user', targetId: user.id, action: 'ban', reason: reason.value.trim(),
            }, `@${user.username} banido`);
            return true;
          },
        },
      ],
    });
  };

  const openUserDetail = async (user) => {
    const detail = await api.get(`/api/admin/users/${user.id}`);
    openModal({
      title: `@${user.username}`,
      size: '520px',
      body: el('div', {}, [
        el('div', { class: 'row mb' }, [
          el('span', { class: `status-tag status-${detail.user.status}`, text: detail.user.status }),
          detail.user.role !== 'user' ? el('span', { class: 'status-tag status-active', text: detail.user.role }) : null,
          detail.user.online ? el('span', { class: 'tiny', style: { color: 'var(--ok)' }, text: 'online' }) : null,
        ]),
        detail.user.statusReason ? el('p', { class: 'small', text: `Motivo: ${detail.user.statusReason}` }) : null,
        detail.user.statusUntil ? el('p', { class: 'small faint', text: `Ate ${new Date(detail.user.statusUntil).toLocaleString('pt-BR')}` }) : null,
        el('h4', { style: { fontSize: '14px', marginTop: '12px' }, text: `Avisos (${detail.warnings.length})` }),
        detail.warnings.length
          ? el('div', { class: 'list' }, detail.warnings.map((warning) => el('div', { class: 'small' }, [
            el('span', { class: 'grow', text: `${warning.category}: ${warning.message}` }),
            el('span', { class: 'tiny faint', text: formatTime(warning.created_at) }),
          ])))
          : el('p', { class: 'small faint', text: 'Sem avisos.' }),
        el('h4', { style: { fontSize: '14px', marginTop: '12px' }, text: `Efeitos hoje (${detail.effectsToday.reduce((a, e) => a + e.count, 0)})` }),
        el('p', { class: 'small faint', text: detail.effectsToday.map((e) => `${e.day}: ${e.count}`).join(' · ') || 'Nenhum uso.' }),
        detail.live ? el('p', { class: 'small', style: { color: 'var(--danger)' }, text: `LIVE ativa com ${detail.live.viewerCount} espectadores` }) : null,
      ]),
    });
  };

  // ---- Conteudo ----
  const renderContent = async () => {
    let type = body.querySelector('select[data-filter="type"]')?.value || 'post';
    const q = body.querySelector('input[type="search"]')?.value || '';
    const data = await api.get('/api/admin/content', { query: { type, limit: 60, q: q || undefined } });

    const typeSelect = el('select', { class: 'select', dataset: { filter: 'type' }, style: { maxWidth: '140px' } }, [
      el('option', { value: 'post', text: 'Videos' }),
      el('option', { value: 'comment', text: 'Comentarios' }),
      el('option', { value: 'live', text: 'LIVE' }),
      el('option', { value: 'chat', text: 'Chat global' }),
    ]);
    typeSelect.value = type;
    typeSelect.addEventListener('change', () => renderContent());
    const search = el('input', { class: 'input', type: 'search', placeholder: 'Filtrar por texto', value: q });
    search.addEventListener('keydown', (event) => { if (event.key === 'Enter') renderContent(); });

    const rows = data.items.map((item) => {
      const id = item.id;
      const label = item.caption || item.body || item.title || id;
      return el('tr', {}, [
        el('td', {}, [el('div', { class: 'truncate', style: { maxWidth: '320px' }, text: String(label).slice(0, 120) })]),
        el('td', { text: `@${item.username}` }),
        el('td', { class: 'tiny faint', text: formatTime(item.created_at) }),
        el('td', {}, [
          el('div', { class: 'row', style: { gap: '4px' } }, [
            el('button', {
              type: 'button', class: 'btn btn-sm btn-ghost', text: 'Abrir',
              onClick: () => {
                if (type === 'post') navigate(`/video/${id}`);
                else if (type === 'live') navigate(`/live/${id}`);
              },
            }),
            el('button', {
              type: 'button', class: 'btn btn-sm btn-danger', text: 'Remover',
              onClick: async () => {
                const ok = await confirmDialog({
                  title: 'Remover conteudo',
                  message: 'O item sera removido permanentemente.',
                  confirmLabel: 'Remover',
                  danger: true,
                });
                if (!ok) return;
                try {
                  await api.delete(`/api/admin/content/${type}/${id}`);
                  toastSuccess('Removido');
                  renderContent();
                } catch (err) { toastError(err); }
              },
            }),
          ]),
        ]),
      ]);
    });

    body.replaceChildren(
      el('h1', { class: 'page-title', text: 'Conteudo' }),
      el('div', { class: 'row mb' }, [typeSelect, search]),
      el('div', { class: 'table-wrap' }, [
        el('table', { class: 'data-table' }, [
          el('thead', {}, [el('tr', {}, [el('th', { text: 'Conteudo' }), el('th', { text: 'Autor' }), el('th', { text: 'Data' }), el('th', { text: 'Acoes' })])]),
          el('tbody', {}, rows.length ? rows : [el('tr', {}, [el('td', { colspan: '4', text: 'Nada encontrado.' })])]),
        ]),
      ]),
    );
  };

  // ---- Denuncias ----
  const renderReports = async () => {
    const status = body.querySelector('select[data-filter="status"]')?.value || '';
    const data = await api.get('/api/admin/reports', { query: { limit: 60, status: status || undefined } });

    const statusSelect = el('select', { class: 'select', dataset: { filter: 'status' }, style: { maxWidth: '160px' } }, [
      el('option', { value: '', text: 'Todos' }),
      el('option', { value: 'open', text: 'Abertas' }),
      el('option', { value: 'reviewing', text: 'Em analise' }),
      el('option', { value: 'resolved', text: 'Resolvidas' }),
      el('option', { value: 'rejected', text: 'Rejeitadas' }),
    ]);
    statusSelect.value = status;
    statusSelect.addEventListener('change', () => renderReports());

    const rows = data.reports.map((report) => el('tr', {}, [
      el('td', {}, [
        el('div', { class: 'strong small', text: report.category }),
        el('div', { class: 'tiny faint', text: `${report.targetType} · por @${report.reporter?.username || '?'}` }),
      ]),
      el('td', {}, [el('div', { class: 'truncate', style: { maxWidth: '240px' }, text: report.details || '-' })]),
      el('td', {}, [el('span', { class: `status-tag status-${report.status}`, text: report.status })]),
      el('td', {}, [el('div', { class: 'row', style: { gap: '4px' } }, [
        el('button', { type: 'button', class: 'btn btn-sm btn-ghost', text: 'Analisar', onClick: () => openReport(report) }),
      ])]),
    ]));

    body.replaceChildren(
      el('h1', { class: 'page-title', text: 'Denuncias' }),
      el('p', { class: 'page-sub', text: `Categorias: ${data.categories.join(', ')}` }),
      el('div', { class: 'row mb' }, [statusSelect]),
      el('div', { class: 'table-wrap' }, [
        el('table', { class: 'data-table' }, [
          el('thead', {}, [el('tr', {}, [el('th', { text: 'Categoria' }), el('th', { text: 'Detalhes' }), el('th', { text: 'Status' }), el('th', { text: '' })])]),
          el('tbody', {}, rows.length ? rows : [el('tr', {}, [el('td', { colspan: '4', text: 'Nenhuma denuncia.' })])]),
        ]),
      ]),
    );
  };

  const openReport = async (report) => {
    const resolution = el('textarea', { class: 'textarea', placeholder: 'Descreva a acao tomada', maxlength: '500' });

    const modal = openModal({
      title: `Denuncia: ${report.category}`,
      size: '520px',
      body: el('div', {}, [
        el('p', { class: 'small muted', text: `Alvo: ${report.targetType} · ${report.targetId}` }),
        el('p', { class: 'small', text: report.details || 'Sem detalhes.' }),
        el('div', { class: 'field' }, [el('label', { text: 'Resolucao' }), resolution]),
        el('div', { class: 'row row-wrap' }, [
          el('button', { type: 'button', class: 'btn btn-sm btn-ghost', text: 'Marcar em analise', onClick: () => update('reviewing') }),
          el('button', { type: 'button', class: 'btn btn-sm btn-primary', text: 'Resolver', onClick: () => update('resolved') }),
          el('button', { type: 'button', class: 'btn btn-sm btn-ghost', text: 'Rejeitar', onClick: () => update('rejected') }),
        ]),
      ]),
    });

    const update = async (status) => {
      try {
        await api.post(`/api/admin/reports/${report.id}`, { status, resolution: resolution.value.trim() });
        toastSuccess('Denuncia atualizada');
        modal.close();
        renderReports();
      } catch (err) { toastError(err); }
    };
  };

  // ---- LIVE ----
  const renderLive = async () => {
    const data = await api.get('/api/admin/content', { query: { type: 'live', limit: 60 } });
    const rows = data.items.map((room) => el('tr', {}, [
      el('td', {}, [
        el('div', { class: 'strong small', text: room.title || '(sem titulo)' }),
        el('div', { class: 'tiny faint', text: `@${room.username}` }),
      ]),
      el('td', {}, [el('span', { class: `status-tag status-${room.status}`, text: room.status })]),
      el('td', { text: formatCount(room.peak || 0) }),
      el('td', { class: 'tiny faint', text: formatTime(room.started_at) }),
      el('td', {}, [el('div', { class: 'row', style: { gap: '4px' } }, [
        room.status === 'live'
          ? el('button', { type: 'button', class: 'btn btn-sm btn-ghost', text: 'Inspecionar', onClick: () => openLiveDetail(room.id) })
          : null,
        room.status === 'live'
          ? el('button', {
            type: 'button', class: 'btn btn-sm btn-danger', text: 'Encerrar',
            onClick: async () => {
              const ok = await confirmDialog({ title: 'Encerrar LIVE', message: 'Todos os espectadores serao avisados.', confirmLabel: 'Encerrar', danger: true });
              if (!ok) return;
              try {
                await api.post(`/api/admin/live/${room.id}/end`, {});
                toastSuccess('LIVE encerrada');
                renderLive();
              } catch (err) { toastError(err); }
            },
          })
          : null,
      ])]),
    ]));

    body.replaceChildren(
      el('h1', { class: 'page-title', text: 'LIVEs' }),
      el('div', { class: 'table-wrap' }, [
        el('table', { class: 'data-table' }, [
          el('thead', {}, [el('tr', {}, [el('th', { text: 'LIVE' }), el('th', { text: 'Status' }), el('th', { text: 'Pico' }), el('th', { text: 'Inicio' }), el('th', { text: '' })])]),
          el('tbody', {}, rows.length ? rows : [el('tr', {}, [el('td', { colspan: '5', text: 'Nenhuma LIVE registrada.' })])]),
        ]),
      ]),
    );
  };

  const openLiveDetail = async (roomId) => {
    const data = await api.get(`/api/admin/live/${roomId}`);
    openModal({
      title: data.room.title || 'LIVE',
      size: '560px',
      body: el('div', {}, [
        el('div', { class: 'row mb' }, [
          el('span', { class: `status-tag status-${data.room.status}`, text: data.room.status }),
          el('span', { class: 'small', text: `${data.room.viewerCount} espectadores · ${data.room.heartCount} coracoes · ${data.room.effectCount} efeitos` }),
        ]),
        el('h4', { style: { fontSize: '14px' }, text: `Espectadores (${data.viewers.length})` }),
        el('div', { class: 'list' }, data.viewers.length
          ? data.viewers.map((viewer) => el('div', { class: 'small row' }, [
            el('span', { class: 'grow', text: `@${viewer.username}` }),
            viewer.role === 'moderator' ? el('span', { class: 'tiny faint', text: 'moderador' }) : null,
            viewer.online ? el('span', { class: 'tiny', style: { color: 'var(--ok)' }, text: 'online' }) : null,
          ]))
          : [el('p', { class: 'small faint', text: 'Nenhum espectador.' })]),
        el('h4', { style: { fontSize: '14px', marginTop: '12px' }, text: `Chat (${data.messages.length})` }),
        el('div', { class: 'list' }, data.messages.slice(-20).map((message) => el('div', { class: 'small' }, [
          el('span', { class: 'grow', text: `@${message.author.username}: ${message.text}` }),
        ]))),
      ]),
    });
  };

  // ---- Chat ----
  const renderChat = async () => {
    const q = body.querySelector('input[type="search"]')?.value || '';
    const [chatData, online] = await Promise.all([
      api.get('/api/admin/content', { query: { type: 'chat', limit: 60, q: q || undefined } }),
      api.get('/api/chat/online'),
    ]);
    const search = el('input', { class: 'input', type: 'search', placeholder: 'Filtrar mensagens', value: q });
    search.addEventListener('keydown', (event) => { if (event.key === 'Enter') renderChat(); });

    const rows = chatData.items.map((message) => el('tr', {}, [
      el('td', {}, [el('div', { class: 'truncate', style: { maxWidth: '400px' }, text: message.body || `[${message.type}]` })]),
      el('td', { text: `@${message.username}` }),
      el('td', { class: 'tiny faint', text: formatTime(message.created_at) }),
      el('td', {}, [el('button', {
        type: 'button', class: 'btn btn-sm btn-danger', text: 'Remover',
        onClick: async () => {
          const ok = await confirmDialog({ title: 'Remover mensagem', message: 'A mensagem sai do chat e do banco.', confirmLabel: 'Remover', danger: true });
          if (!ok) return;
          try {
            await api.delete(`/api/admin/content/chat/${message.id}`);
            toastSuccess('Mensagem removida');
            renderChat();
          } catch (err) { toastError(err); }
        },
      })]),
    ]));

    body.replaceChildren(
      el('h1', { class: 'page-title', text: 'Chat global' }),
      el('div', { class: 'row mb' }, [
        el('span', { class: 'online-pill' }, [el('i'), el('span', { text: `${online.onlineCount} online` })]),
        search,
      ]),
      el('div', { class: 'table-wrap' }, [
        el('table', { class: 'data-table' }, [
          el('thead', {}, [el('tr', {}, [el('th', { text: 'Mensagem' }), el('th', { text: 'Autor' }), el('th', { text: 'Data' }), el('th', { text: '' })])]),
          el('tbody', {}, rows.length ? rows : [el('tr', {}, [el('td', { colspan: '4', text: 'Nenhuma mensagem.' })])]),
        ]),
      ]),
    );
  };

  // ---- Log de moderacao ----
  const renderModerationLog = async () => {
    const data = await api.get('/api/admin/moderation-log', { query: { limit: 120 } });
    const rows = data.log.map((entry) => el('tr', {}, [
      el('td', { class: 'strong small', text: entry.action }),
      el('td', { text: `${entry.target_type}` }),
      el('td', { text: `@${entry.moderator}` }),
      el('td', {}, [el('div', { class: 'truncate', style: { maxWidth: '260px' }, text: entry.reason || '-' })]),
      el('td', { class: 'tiny faint', text: formatTime(entry.created_at) }),
    ]));
    body.replaceChildren(
      el('h1', { class: 'page-title', text: 'Acoes de moderacao' }),
      el('div', { class: 'table-wrap' }, [
        el('table', { class: 'data-table' }, [
          el('thead', {}, [el('tr', {}, [el('th', { text: 'Acao' }), el('th', { text: 'Alvo' }), el('th', { text: 'Moderador' }), el('th', { text: 'Motivo' }), el('th', { text: 'Data' })])]),
          el('tbody', {}, rows.length ? rows : [el('tr', {}, [el('td', { colspan: '5', text: 'Nenhuma acao registrada.' })])]),
        ]),
      ]),
    );
  };

  // ---- Sistema ----
  const renderSystem = async () => {
    if (!isAdmin) {
      body.replaceChildren(emptyState({ iconName: 'lock', title: 'Restrito a administradores', message: 'Apenas administradores veem dados de sistema.' }));
      return;
    }
    const data = await api.get('/api/admin/system');
    body.replaceChildren(
      el('h1', { class: 'page-title', text: 'Sistema' }),
      el('div', { class: 'stat-grid mb' }, [
        stat(formatDuration(data.runtime.uptimeSeconds), 'uptime'),
        stat(`${data.runtime.memoryMb} MB`, 'memoria'),
        stat(data.runtime.node, 'node'),
        stat(data.runtime.env, 'ambiente'),
      ]),
      el('div', { class: 'card mb' }, [
        el('h3', { style: { fontSize: '14px', marginTop: '0' }, text: 'Banco de dados' }),
        el('div', { class: 'row small muted' }, [el('span', { class: 'grow', text: 'Usuarios' }), el('span', { text: String(data.database.users) })]),
        el('div', { class: 'row small muted' }, [el('span', { class: 'grow', text: 'Videos publicados' }), el('span', { text: String(data.database.posts) })]),
        el('div', { class: 'row small muted' }, [el('span', { class: 'grow', text: 'Midia' }), el('span', { text: String(data.database.media) })]),
      ]),
      el('div', { class: 'card mb' }, [
        el('h3', { style: { fontSize: '14px', marginTop: '0' }, text: 'Midia' }),
        el('div', { class: 'row small muted' }, [
          el('span', { class: 'grow', text: 'ffmpeg' }),
          el('span', { text: data.media.ffmpeg.available ? 'disponivel' : 'ausente (FFMPEG_PATH)' }),
        ]),
        el('div', { class: 'row small muted' }, [el('span', { class: 'grow', text: 'ffprobe' }), el('span', { text: data.media.ffmpeg.ffprobe ? 'disponivel' : 'ausente' })]),
        el('div', { class: 'row small muted' }, [el('span', { class: 'grow', text: 'Transcoding' }), el('span', { text: data.media.transcode ? 'ativo' : 'inativo' })]),
        el('div', { class: 'row small muted' }, [el('span', { class: 'grow', text: 'HLS adaptativo' }), el('span', { text: data.media.hls ? 'ativo' : 'inativo' })]),
      ]),
      el('div', { class: 'card mb' }, [
        el('h3', { style: { fontSize: '14px', marginTop: '0' }, text: 'Recursos externos' }),
        el('div', { class: 'row small muted' }, [el('span', { class: 'grow', text: 'TURN (WebRTC)' }), el('span', { text: data.features.turn ? 'configurado' : 'NAO configurado' })]),
        el('div', { class: 'row small muted' }, [el('span', { class: 'grow', text: 'GIPHY (GIF)' }), el('span', { text: data.features.giphy ? 'configurado' : 'NAO configurado' })]),
        el('div', { class: 'row small muted' }, [el('span', { class: 'grow', text: 'Push (VAPID)' }), el('span', { text: data.features.push ? 'configurado' : 'NAO configurado' })]),
      ]),
      el('div', { class: 'card' }, [
        el('h3', { style: { fontSize: '14px', marginTop: '0' }, text: 'Storage' }),
        el('div', { class: 'row small muted' }, [el('span', { class: 'grow', text: 'Arquivos' }), el('span', { text: String(data.storage.usage.files) })]),
        el('div', { class: 'row small muted' }, [el('span', { class: 'grow', text: 'Total' }), el('span', { text: `${(data.storage.usage.totalBytes / 1048576).toFixed(1)} MB` })]),
        el('button', {
          type: 'button', class: 'btn btn-ghost mt', text: 'Limpar arquivos orfaos (dry-run)',
          onClick: async () => {
            try {
              const result = await api.post('/api/admin/storage/cleanup', { dryRun: true });
              toastSuccess(`${result.removed} arquivo(s) orfao(s) encontrado(s)`);
              if (result.removed > 0 && confirm('Remover definitivamente esses arquivos?')) {
                const applied = await api.post('/api/admin/storage/cleanup', { dryRun: false });
                toastSuccess(`${applied.removed} arquivo(s) removido(s)`);
                renderSystem();
              }
            } catch (err) { toastError(err); }
          },
        }),
      ]),
    );
  };

  page.append(
    el('header', { class: 'admin-header' }, [
      el('div', { class: 'admin-brand' }, [
        el('span', { class: 'admin-brand-mark' }, [icon('shield')]),
        el('div', {}, [
          el('h1', { class: 'admin-title', text: 'Administracao' }),
          el('p', { class: 'tiny faint', text: 'Painel em tempo real' }),
        ]),
      ]),
      el('div', { class: 'row', style: { gap: '8px' } }, [
        connectionBadge,
        el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Fechar', onClick: () => navigate('/') }, [icon('close')]),
      ]),
    ]),
    nav,
    body,
  );

  renderNav();

  /**
   * Item 17: inscreve no topico administrativo. O servidor recusa a inscricao
   * para quem nao e staff (o papel vem do banco, nunca do cliente).
   */
  const connectAdminRealtime = () => {
    if (unsubAdmin) return;
    unsubAdmin = realtime.subscribe('admin:events');
    // `addEventListener` entrega o CustomEvent: o payload vem em `event.detail`
    // (e nao no evento direto). Sem isso o painel recebia os eventos com o
    // payload vazio e nada mudava na tela.
    for (const type of ADMIN_EVENTS) {
      cleanups.add(realtime.addEventListener(type, (event) => applyAdminEvent(type, event.detail || {})));
    }
    // Item 18: sem conexao, o painel AVISA em vez de ficar congelado em
    // numeros velhos fingindo que estao atuais.
    cleanups.add(realtime.addEventListener('auth', () => {
      setConnection('live', 'ao vivo');
      // Reconectou: novo snapshot, para nao perder o que aconteceu enquanto o
      // socket estava fora.
      if (current === 'painel') renderPainel().catch(() => {});
    }));
    cleanups.add(realtime.addEventListener('reconnecting', () => setConnection('reconnecting', 'reconectando...')));
    cleanups.add(realtime.addEventListener('disconnected', () => setConnection('reconnecting', 'reconectando...')));
    cleanups.add(realtime.addEventListener('state', (e) => {
      if (e.detail?.state === 'open') setConnection('live', 'ao vivo');
    }));
    const autenticado = realtime.isAuthenticated?.();
    if (autenticado === false) {
      setConnection('reconnecting', 'sem permissao');
    } else {
      setConnection(realtime.isOpen() ? 'live' : 'reconnecting', realtime.isOpen() ? 'ao vivo' : 'reconectando...');
    }
  };

  return {
    element: page,
    async load() {
      // Snapshot primeiro, realtime depois (item 18): o painel nunca mostra
      // estado vazio esperando resposta.
      renderBody();
      connectAdminRealtime();
    },
    destroy() {
      destroyed = true;
      clearTimeout(activityTimer);
      clearTimeout(pendingRender);
      activityTimer = null;
      pendingRender = 0;
      unsubAdmin?.();
      unsubAdmin = null;
      for (const fn of cleanups) fn();
      cleanups.clear();
      page.replaceChildren();
      page.remove();
    },
  };
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m ${total % 60}s`;
}
