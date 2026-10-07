/** Descobrir LIVEs e iniciar uma LIVE. */
import { api } from '../core/api.js';
import { el, icon, formatCount } from '../core/dom.js';
import { emptyState, toastError } from '../core/ui.js';
import { store, isLoggedIn } from '../core/store.js';
import { realtime } from '../core/realtime.js';
import { checkSupport, turnWarning } from './webrtc.js';

export function createLiveDiscoverScreen() {
  const page = el('div', { class: 'page' });
  const host = el('div');
  const cleanups = [];
  let refreshTimer = null;
  let refreshTimerPending = null;
  let durationTimer = null;
  let configPromise = null;
  let loadPromise = null;

  const render = (data, config, loadError = null) => {
    host.replaceChildren();
    host.append(
      el('h1', { class: 'page-title', text: 'AO VIVO' }),
      el('p', { class: 'page-sub', text: 'Transmissões ao vivo acontecendo agora.' }),
    );

    // Mantém a ação existente de iniciar uma transmissão real.
    host.append(el('div', { class: 'card live-start mb' }, [
      el('div', { class: 'live-start-text' }, [
        el('div', { class: 'live-start-title' }, [icon('live'), el('span', { text: 'Sua transmissao' })]),
        el('div', {
          class: 'small faint',
          text: 'Use a camera e o microfone. Voce ve a previa e so transmite quando confirmar.',
        }),
      ]),
      isLoggedIn()
        ? el('a', { class: 'btn btn-primary live-start-btn', href: '/iniciar-live', 'data-link': true },
          [icon('live'), el('span', { text: 'INICIAR LIVE' })])
        : el('a', { class: 'btn btn-primary live-start-btn', href: '/entrar', 'data-link': true },
          [icon('user'), el('span', { text: 'Entrar para transmitir' })]),
    ]));

    const support = checkSupport();
    if (!support.secure) {
      host.append(el('div', { class: 'card mb' }, [
        el('div', { class: 'row', style: { gap: '8px' } }, [
          icon('lock'),
          el('div', { class: 'grow' }, [
            el('div', { class: 'strong', text: 'Contexto inseguro' }),
            el('div', { class: 'small faint', text: 'Camera e microfone exigem HTTPS. Voce pode assistir, mas nao transmitir.' }),
          ]),
        ]),
      ]));
    }
    const avisoTurn = config?.iceServers ? turnWarning(config.iceServers) : null;
    if (avisoTurn) {
      host.append(el('div', { class: 'card mb turn-note', style: { borderColor: '#eda800' } }, [
        el('div', { class: 'row', style: { gap: '8px', alignItems: 'flex-start' } }, [
          icon('warning'),
          el('div', { class: 'grow' }, [
            el('div', { class: 'strong', text: 'TURN nao configurado' }),
            el('div', { class: 'small faint', text: avisoTurn }),
          ]),
        ]),
      ]));
    }

    const received = Array.isArray(data) ? data : (data?.lives || data?.rooms || data?.activeLives || []);
    const live = received.filter((room) => (room?.id || room?.roomId)
      && (!room.status || room.status === 'live' || room.status === 'active'));
    host.append(el('h2', { style: { fontSize: '15px', margin: '8px 0' }, text: `Ao vivo agora (${live.length})` }));
    if (loadError) {
      host.append(emptyState({
        iconName: 'warning',
        title: 'Não foi possível carregar as transmissões',
        message: 'Tente novamente em instantes.',
        action: el('button', { type: 'button', class: 'btn btn-primary mt', text: 'Tentar novamente', onClick: () => load() }),
      }));
    } else if (live.length) {
      host.append(el('div', { class: 'list live-directory-list' }, live.map((room) => {
        const profile = room.host || room.user || room.profile || {};
        const username = room.username || room.hostUsername || profile.username || 'usuario';
        const avatarUrl = room.avatarUrl || room.hostAvatarUrl || profile.avatarUrl || null;
        const startedAt = room.startedAt ?? room.started_at ?? null;
        const id = room.id || room.roomId;
        const avatarChildren = [icon('user')];
        if (avatarUrl) {
          avatarChildren.push(el('img', {
            src: avatarUrl,
            alt: '',
            loading: 'lazy',
            onError: (event) => { event.currentTarget.hidden = true; },
          }));
        }
        return el('div', { class: 'list-item live-directory-item' }, [
          el('div', { class: 'avatar live-directory-avatar' }, avatarChildren),
          el('div', { class: 'grow live-directory-details' }, [
            el('div', { class: 'strong truncate live-directory-username', text: `@${username}` }),
            el('div', { class: 'row tiny faint live-directory-stats' }, [
              el('span', { class: 'row', style: { gap: '3px' } }, [
                icon('eye'),
                el('span', { text: `${formatCount(room.viewerCount)} ${Number(room.viewerCount) === 1 ? 'espectador' : 'espectadores'}` }),
              ]),
              el('span', {
                class: 'live-directory-duration',
                dataset: { startedAt: startedAt == null ? '' : String(startedAt) },
                text: `há ${formatLiveDuration(startedAt)}`,
              }),
            ]),
          ]),
          el('a', {
            class: 'btn btn-primary btn-sm live-directory-join',
            href: `/live/${encodeURIComponent(id)}`,
            'data-link': true,
            text: 'Entrar na live',
          }),
        ]);
      })));
    } else {
      host.append(emptyState({
        iconName: 'live',
        title: 'Nenhuma LIVE ativa',
        message: 'Assim que alguem iniciar uma transmissao, ela aparece aqui.',
      }));
    }
  };

  const load = async () => {
    if (loadPromise) return loadPromise;
    configPromise ||= api.get('/api/live/config').catch(() => null);
    loadPromise = (async () => {
      try {
        const [active, config] = await Promise.all([
          api.get('/api/lives/active'),
          configPromise,
        ]);
        render(active, config);
      } catch {
        render([], await configPromise, true);
      } finally {
        loadPromise = null;
      }
    })();
    return loadPromise;
  };

  page.append(host);
  host.append(el('div', { class: 'page-empty' }, [el('div', { class: 'spinner', style: { margin: '0 auto' } })]));

  const unsubscribeDirectory = realtime.subscribe('live:directory');
  cleanups.push(unsubscribeDirectory);
  cleanups.push(realtime.addEventListener('LIVE_DIRECTORY_CHANGE', () => {
    clearTimeout(refreshTimerPending);
    refreshTimerPending = setTimeout(() => load(), 250);
  }));

  refreshTimer = setInterval(() => {
    if (document.visibilityState === 'visible') load();
  }, 20000);
  durationTimer = setInterval(updateDurations, 1000);

  function updateDurations() {
    for (const node of host.querySelectorAll('.live-directory-duration')) {
      node.textContent = `há ${formatLiveDuration(node.dataset.startedAt)}`;
    }
  }

  return {
    element: page,
    async load() { await load(); },
    destroy() {
      clearInterval(refreshTimer);
      clearTimeout(refreshTimerPending);
      clearInterval(durationTimer);
      cleanups.forEach((fn) => fn());
      page.replaceChildren();
      page.remove();
    },
  };
}

function formatLiveDuration(startedAt, now = Date.now()) {
  if (startedAt === '' || startedAt == null) return 'duração indisponível';
  const numeric = Number(startedAt);
  const parsed = Number.isFinite(numeric)
    ? (numeric > 0 ? (numeric < 1_000_000_000_000 ? numeric * 1000 : numeric) : NaN)
    : Date.parse(startedAt);
  if (!Number.isFinite(parsed) || parsed <= 0) return 'duração indisponível';
  const seconds = Math.max(0, Math.floor((now - parsed) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  if (hours) return `${hours}h ${minutes}min`;
  if (minutes) return `${minutes}min ${remainder}s`;
  return `${remainder}s`;
}

/**
 * Tela de inicio de LIVE: titulo, categoria e verificacao de suporte.
 * A camera/microfone sao abertos na tela do anfitriao (createHostLiveScreen).
 */
export function createLiveStartScreen() {
  const page = el('div', { class: 'page page-narrow' });
  const support = checkSupport();
  const config = { turnConfigured: store.appConfig?.features?.turn };

  const title = el('input', { class: 'input', maxlength: '120', placeholder: 'Titulo da LIVE (opcional)' });
  const category = el('select', { class: 'select' }, [
    el('option', { value: 'geral', text: 'Geral' }),
    el('option', { value: 'jogo', text: 'Jogos' }),
    el('option', { value: 'musica', text: 'Musica' }),
    el('option', { value: 'talk', text: 'Conversa' }),
    el('option', { value: 'ensino', text: 'Ensino' }),
    el('option', { value: 'outros', text: 'Outros' }),
  ]);

  const startBtn = el('button', { type: 'button', class: 'btn btn-danger btn-block', text: 'Iniciar transmissao' });

  const issues = [];
  // Item 33: a causa real vem primeiro. `navigator.mediaDevices` simplesmente
  // NAO EXISTE fora de um contexto seguro, entao dizer "seu navegador nao
  // oferece camera" nesse caso seria errado - o problema e o endereco.
  if (!support.secure) {
    issues.push(`A camera e o microfone exigem HTTPS (ou localhost). Endereco atual: ${location.origin}.`);
  } else if (!support.getUserMedia) {
    issues.push('Este navegador nao oferece acesso a camera/microfone (versao antiga ou bloqueio do navegador).');
  } else if (!support.rtc) {
    issues.push('Este navegador nao suporta WebRTC.');
  }

  const start = async () => {
    if (issues.length) {
      toastError(new Error(issues[0]));
      return;
    }
    startBtn.disabled = true;
    startBtn.textContent = 'Abrindo camera…';
    const { createHostLiveScreen } = await import('./live.js');
    const screen = createHostLiveScreen({
      title: title.value.trim(),
      category: category.value,
    });
    page.replaceChildren(screen.element);
    // Substitui a rota atual para que "voltar" volte ao discover
    history.replaceState({}, '', '/live/nova');
    // A sala e criada em async (permite camera/microfone + create-room).
    // `ready` resolve quando o boot termina; qualquer falha ja aparece
    // dentro da tela do host, com a causa exata - aqui nao se inventa erro.
    await screen.ready;
  };

  startBtn.addEventListener('click', start);

  page.append(
    el('h1', { class: 'page-title', text: 'Iniciar LIVE' }),
    el('p', { class: 'page-sub', text: 'Sua transmissao usa camera e microfone reais via WebRTC.' }),
    ...(issues.length
      ? [el('div', { class: 'card mb', style: { borderColor: 'var(--danger)' } }, [
        el('div', { class: 'row', style: { gap: '8px' } }, [
          icon('warning'),
          el('div', { class: 'grow' }, issues.map((issue) => el('div', { class: 'small', text: `• ${issue}` }))),
        ]),
      ])]
      : []),
    // Item 9: aviso de TURN COMPACTO e honesto. "Configurado" so quer dizer
    // que as variaveis existem - relay funcionando se confirma na conexao.
    config.turnConfigured === false
      ? el('div', { class: 'card mb turn-note', style: { borderColor: '#eda800' } }, [
        el('div', { class: 'row', style: { gap: '8px', alignItems: 'flex-start' } }, [
          icon('warning'),
          el('div', { class: 'grow' }, [
            el('div', { class: 'strong', text: 'TURN nao configurado' }),
            el('div', {
              class: 'small faint',
              text: 'A transmissao usa apenas STUN. Em Wi-Fi restritivo, 4G/5G ou rede corporativa o P2P direto pode falhar e a LIVE nao chega ao espectador. O administrador precisa apontar o servidor para um TURN (coturn).',
            }),
          ]),
        ]),
      ])
      : null,
    el('div', { class: 'field' }, [el('label', { text: 'Titulo' }), title]),
    el('div', { class: 'field' }, [el('label', { text: 'Categoria' }), category]),
    startBtn,
    el('p', { class: 'tiny faint', style: { marginTop: '10px' } }, [
      'Ao iniciar, a LIVE aparece na lista "Ao vivo" e os espectadores recebem video e audio reais.',
    ]),
  );

  // Ajusta a categoria na criacao da sala
  return {
    element: page,
    destroy() {
      page.replaceChildren();
      page.remove();
    },
  };
}
