/**
 * LIVE - tela do ESPECTADOR.
 *
 * Interface vertical fullscreen, com o video real do anfitriao ocupando a
 * topo. Topo: foto da streamer, @username, nome e contador de espectadores
 * (o host NUNCA entra na contagem). Comentarios na parte inferior (ultimos 10
 * visiveis), campo "Digite..." e acoes: coracao, efeitos, compartilhar.
 */
import { api } from '../core/api.js';
import { el, icon, formatCount } from '../core/dom.js';
import { effectPicker } from './live-effects-card.js';
import { openLiveProfileCard } from './live-profile-card.js';
import { openModal, toastError, toastSuccess, confirmDialog } from '../core/ui.js';
import { isLoggedIn } from '../core/store.js';
import { realtime } from '../core/realtime.js';
import { navigate } from '../core/router.js';
import { LiveMesh, buildIceServers, checkSupport, turnWarning } from './webrtc.js';
import { EffectOverlay, HeartLayer } from './live-effects.js';
import { observeLiveLayout, ajustarEnquadramento } from './live-layout.js';
import { joinLive, leaveLive, sendHearts, triggerEffect, liveConfig } from './live.js';
const MAX_CHAT_VISIBLE = 10;
// Janela de recuperacao do sinal: 5 anuncios espacados de 1,5s (7,5s).
const ANNOUNCE_ATTEMPTS = 5;
const ANNOUNCE_INTERVAL = 1500;

export async function getLive(roomId) {
  return api.get(`/api/live/${roomId}`);
}

export async function liveViewers(roomId) {
  return api.get(`/api/live/${roomId}/viewers`);
}

export function createViewerLiveScreen({ roomId }) {
  const state = {
    room: null,
    viewerCount: 0,
    hostId: null,
    chatVisible: [],
    connected: false,
    reconnecting: false,
    // PREFERENCIA de rotacao do anfitriao (0, 90 ou 270) e a rotacao que o
    // espectador aplicou de fato (0 quando a tela dele nao pede, ou quando
    // girar nao ajudaria).
    //
    // O valor comecoa em 270 - o mesmo padrao do anfitriao. Assim um
    // espectador que entra DEPOIS da publicacao ja sai correto: ele calcula
    // sozinho a partir do quadro real, e so precisa do valor do anfitriao para
    // corrigir a DIRECAO (90 ou 270), que nenhum numero deduz.
    rotacaoPreferida: 270,
    rotacaoAplicada: 0,
  };

  const cleanups = [];
  // Itens 10 e 11: altura da barra medida + teclado (visualViewport).
  let stopLayout = null;
  // Item 5: cleanup do ajuste de enquadramento do video.
  let stopFit = null;
  let mesh = null;
  let effects = null;
  let hearts = null;
  let unsubTopic = null;
  let pendingHearts = 0;
  let heartTimer = null;
  let hostStream = null;
  // Estado da area de video (itens 6 e 7) e trava do botao "Tentar novamente".
  let mediaStateNode = null;
  let retrying = false;
  // Tempo maximo sem midia antes de oferecer "Tentar novamente". Nao e um
  // timeout que vira "sem midia": e um convite a reconectar de verdade.
  let mediaWatchdog = null;
  // Anuncio de presenca com repeticao: cobre a janela em que o sinal do
  // anfitriao e descartado pelo servidor (espectador ainda sem inscricao).
  let announceTimer = null;
  let announceAttempts = 0;
  let leaving = false;
  // Sinais que chegaram antes de a malha existir.
  const pendingSignals = [];

  const videoHost = el('div', { class: 'live-video-wrap' });
  const remoteVideo = el('video', {
    class: 'remote',
    autoplay: true,
    playsinline: true,
    'aria-label': 'Video da transmissao ao vivo',
  });
  remoteVideo.muted = false;
  remoteVideo.volume = 1;

  const topBar = el('div', { class: 'live-top' });
  const chatLayer = el('div', { class: 'live-chat' });
  const inputBar = el('div', { class: 'live-input-bar' });
  const heartButton = el('button', { type: 'button', class: 'live-heart-btn', 'aria-label': 'Enviar coracao' }, [icon('heart')]);
  const statusLine = el('div', {
    class: 'tiny',
    style: {
      position: 'absolute', left: '12px', right: '12px', top: 'calc(70px + env(safe-area-inset-top, 0px))',
      padding: '6px 10px', borderRadius: '10px', display: 'none', zIndex: '13',
    },
  });

  const page = el('div', { class: 'live-page', dataset: { role: 'viewer' } }, [
    videoHost, topBar, statusLine, chatLayer, heartButton, inputBar,
  ]);

  /**
   * Estado da AREA DE VIDEO (itens 6 e 7).
   *
   * Antes havia um placeholder fixo "Conectando a transmissao\u2026" e, quando a
   * conexao morria, nenhuma acao: o espectador ficava olhando uma area preta
   * ou um texto generico sem poder fazer nada. Agora o estado e explicito:
   *   connecting -> aguardando midia real (com spinner)
   *   playing    -> video real em reproducao (o placeholder sai)
   *   reconnect  -> reconexao em andamento
   *   error      -> falha com "Tentar novamente", que reinicia o WebRTC
   *   ended      -> LIVE encerrada
   * `blocked` cobre o autoplay com audio negado pelo navegador.
   */
  function renderMediaState(kind, options = {}) {
    state.mediaState = kind;
    if (kind === 'playing') {
      clearMediaWatchdog();
      if (mediaStateNode?.isConnected) mediaStateNode.remove();
      mediaStateNode = null;
      return;
    }

    const textos = {
      connecting: ['Conectando a transmissao\u2026', 'Abrindo a conexao com quem esta transmitindo.'],
      reconnect: ['Reconectando\u2026', 'A conexao caiu. Tentando restabelecer.'],
      ended: ['LIVE encerrada', 'Esta transmissao foi finalizada.'],
      blocked: ['Toque no video', 'Seu navegador bloqueou o audio automatico.'],
    };
    const par = textos[kind] || ['Conectando a transmissao\u2026', ''];
    const detalhe = options.detail || par[1];

    const node = el('div', { class: 'live-media-state', dataset: { state: kind } }, [
      kind === 'connecting' || kind === 'reconnect'
        ? el('div', { class: 'spinner', style: { margin: '0 auto 12px' } })
        : el('div', { class: 'live-media-icon' }, [icon(kind === 'ended' ? 'live' : 'warning')]),
      el('p', { class: 'strong', text: options.title || par[0] }),
      detalhe ? el('p', { class: 'tiny faint', text: detalhe }) : null,
      kind === 'error'
        ? el('div', { class: 'live-media-actions' }, [
          el('button', {
            type: 'button',
            class: 'btn btn-primary',
            text: 'Tentar novamente',
            onClick: () => retryConnection(options.reason || 'manual'),
          }),
          el('button', { type: 'button', class: 'btn', text: 'Sair', onClick: () => confirmExit() }),
        ])
        : null,
    ]);

    if (mediaStateNode?.isConnected) mediaStateNode.replaceWith(node);
    else videoHost.append(node);
    mediaStateNode = node;
  }

  /**
   * Se a midia nao chegar, isto e um convite a reconectar de verdade - nunca uma
   * troca de texto que finge que a LIVE acabou (item 6).
   */
  function armMediaWatchdog(seconds = 12) {
    clearMediaWatchdog();
    mediaWatchdog = setTimeout(() => {
      if (state.connected || leaving) return;
      renderMediaState('error', {
        title: 'Nao foi possivel conectar a transmissao.',
        reason: 'no_media',
      });
    }, seconds * 1000);
  }

  function clearMediaWatchdog() {
    clearTimeout(mediaWatchdog);
    mediaWatchdog = null;
  }

  /**
   * Item 6/7: "Tentar novamente" reinicia o WebRTC DE VERDADE. Descarta a
   * PeerConnection morta (sem deixar duas vivas), zera o estado de midia,
   * reinscreve no topico, rejoins no backend e reanuncia para o host reenviar
   * a oferta.
   */
  async function retryConnection(reason = 'manual') {
    if (retrying || leaving) return;
    retrying = true;
    renderMediaState('reconnect');
    setStatus('');
    try {
      if (hostStream) {
        remoteVideo.srcObject = null;
        hostStream = null;
      }
      state.connected = false;
      mesh?.hardResetAll(reason);
      if (state.room) {
        unsubTopic?.();
        unsubTopic = realtime.subscribe(`live:${state.room.id}`);
        await joinLive(state.room.id, { reconnect: true });
      }
      announce();
      armMediaWatchdog();
    } catch (err) {
      renderMediaState('error', {
        title: 'Nao foi possivel conectar a transmissao.',
        detail: err.message,
        reason,
      });
    } finally {
      retrying = false;
    }
  }

  renderMediaState('connecting');

  // ---- Topo: foto, @username, nome, espectadores ----
  const renderTop = () => {
    const host = state.room?.host;
    topBar.replaceChildren(
      el('div', { class: 'live-host' }, [
        el('div', {
          class: 'avatar sm',
          style: { width: '40px', height: '40px', border: '2px solid var(--like)' },
        }, [
          host?.avatarUrl
            ? el('img', { src: host.avatarUrl, alt: '', onError: (e) => { e.currentTarget.replaceWith(el('div', { class: 'avatar sm' })); } })
            : el('div', { class: 'avatar sm' }),
        ]),
        el('div', { class: 'grow' }, [
          el('div', { class: 'live-host-name', text: host?.displayName || '' }),
          el('div', { class: 'live-host-user', text: `@${host?.username || ''}` }),
        ]),
      ]),
      el('div', { class: 'live-top-actions' }, [
        el('span', { class: 'live-pill live-dot-item' }, [el('i'), el('span', { text: 'AO VIVO' })]),
        // Contador: EXCLUI o host (fonte unica = viewers do backend)
        // (12) O contador virou BOTAO: abre o painel com quem esta na LIVE,
        // sem sair da transmissao e sem recarregar a pagina.
        el('button', {
          type: 'button',
          class: 'live-pill live-viewers-btn',
          title: 'Espectadores (o anfitriao nao e contado)',
          'aria-label': 'Ver quem esta na LIVE',
          onClick: () => abrirEspectadores(),
        }, [icon('eye'), el('span', { text: formatCount(state.viewerCount) })]),
        // (11) O botao "Sair da LIVE" saiu da barra inferior e virou item do
        // menu de configuracoes, que fica no topo ao lado do contador.
        el('button', {
          type: 'button',
          // Mesma classe do host: o menu de configuracoes precisa ser
          // reconhecivel pelos dois lados (CSS, verificadores e leitor de
          // tela). Sem isso, o espectador tinha um botao sem identificacao.
          class: 'round-btn live-settings-btn',
          'aria-label': 'Configuracoes da LIVE',
          style: { width: '32px', height: '32px' },
          onClick: () => abrirConfiguracoes(),
        }, [icon('settings')]),
      ]),
    );
  };

  const setStatus = (message, tone = 'info') => {
    if (!message) { statusLine.style.display = 'none'; return; }
    statusLine.style.display = 'block';
    statusLine.style.background = tone === 'error'
      ? 'rgba(239,68,68,.22)'
      : tone === 'warn' ? 'rgba(237,168,0,.2)' : 'rgba(0,0,0,.55)';
    statusLine.style.border = tone === 'error' ? '1px solid #ef4444' : tone === 'warn' ? '1px solid #eda800' : '1px solid rgba(255,255,255,.2)';
    statusLine.style.color = tone === 'error' ? '#ffb4b4' : '#fff';
    statusLine.textContent = message;
  };

  // ---- Chat: ~10 ultimos visiveis; historico fica no banco ----
  const appendChat = (message) => {
    if (!message || message.deleted) return;
    const openAuthorProfile = () => openLiveProfileCard(message.author);
    const node = el('div', {
      class: 'live-msg',
      role: message.author?.id ? 'button' : null,
      tabindex: message.author?.id ? '0' : null,
      'aria-label': message.author?.id ? `Ver perfil de @${message.author.username || ''}` : null,
      onClick: message.author?.id ? openAuthorProfile : null,
      onKeydown: message.author?.id ? (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          openAuthorProfile();
        }
      } : null,
    }, [
      el('div', { class: 'avatar xs' }, [
        message.author?.avatarUrl
          ? el('img', { src: message.author.avatarUrl, alt: '', loading: 'lazy', onError: (e) => { e.currentTarget.replaceWith(el('div', { class: 'avatar xs' })); } })
          : el('div', { class: 'avatar xs' }),
      ]),
      el('span', { class: 'name', text: `@${message.author?.username || ''}` }),
      el('span', { class: 'text', text: message.text }),
    ]);
    chatLayer.append(node);
    state.chatVisible.push(node);
    while (state.chatVisible.length > MAX_CHAT_VISIBLE) state.chatVisible.shift().remove();
  };

  const clearChat = () => {
    chatLayer.replaceChildren();
    state.chatVisible = [];
  };

  // ---- Entrada ----
  const chatInput = el('input', {
    class: 'live-input',
    type: 'text',
    placeholder: 'Digite...',
    maxlength: '300',
    enterkeyhint: 'send',
    'aria-label': 'Mensagem para a LIVE',
  });
  // (13) O botao de efeitos SAI de dentro do campo de texto: grudado no input
  // ele invadia a area de digitacao e, com o teclado aberto, empurrava o texto.
  const sendBtn = el('button', {
    type: 'button', class: 'live-send', 'aria-label': 'Confirmar envio da mensagem', hidden: true,
  }, [icon('send')]);
  const effectsBtn = el('button', { type: 'button', class: 'round-btn live-effects-btn', 'aria-label': 'Efeitos da LIVE' }, [icon('sparkle')]);
  const shareBtn = el('button', { type: 'button', class: 'round-btn', 'aria-label': 'Compartilhar LIVE' }, [icon('share')]);
  const repostBtn = el('button', { type: 'button', class: 'round-btn', 'aria-label': 'Republicar LIVE' }, [icon('repeat')]);

  const fieldWrap = el('div', { class: 'live-field' }, [chatInput]);
  // Divisor visual: o pedido era "separar visualmente os controles".
  const divider = el('span', { class: 'live-divider', 'aria-hidden': 'true' });
  const toolsGroup = el('div', { class: 'live-tools' }, [effectsBtn, divider, shareBtn, repostBtn]);
  inputBar.append(fieldWrap, sendBtn, toolsGroup);

  // (13) CONFIRMAR ENVIO so aparece com mensagem pronta. Antes o envio era so
  // pelo Enter: invisivel na tela e ruim com teclado virtual.
  const syncSendButton = () => {
    const temTexto = chatInput.value.trim().length > 0;
    sendBtn.hidden = !temTexto;
    fieldWrap.classList.toggle('is-active', temTexto);
  };
  chatInput.addEventListener('input', syncSendButton);
  chatInput.addEventListener('focus', syncSendButton);
  chatInput.addEventListener('blur', () => { if (!chatInput.value.trim()) syncSendButton(); });

  chatInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    if (chatInput.value.trim()) sendChat(chatInput.value.trim());
  });
  sendBtn.addEventListener('click', () => {
    if (chatInput.value.trim()) sendChat(chatInput.value.trim());
  });

  const sendChat = (body) => {
    chatInput.value = '';
    // Esconde o botao logo apos o envio: o campo volta ao estado inicial.
    syncSendButton();
    realtime.publish('LIVE_COMMENT', { roomId: state.room.id, body });
  };

  // (13) Republicar pela rota que ja existe: post do tipo 'live' apontando
  // para a sala (roomId). Nenhum endpoint novo foi criado.
  repostBtn.addEventListener('click', async () => {
    if (!state.room?.id) return;
    try {
      await api.post('/api/posts', {
        type: 'live',
        roomId: state.room.id,
        caption: state.room.title ? `Assista: ${state.room.title}` : 'Assista a LIVE agora',
      });
      toastSuccess('LIVE republicada no seu perfil');
    } catch (err) {
      toastError(err);
    }
  });
  // ---- Coracoes: 1 toque = 1 like, ilimitado ----
  heartButton.addEventListener('click', () => {
    hearts.spawn({ x: window.innerWidth - 90, y: window.innerHeight - 220 });
    queueHearts(1);
  });

  const queueHearts = (quantity) => {
    if (!isLoggedIn()) { navigate('/entrar'); return; }
    pendingHearts += quantity;
    if (heartTimer) return;
    heartTimer = setTimeout(async () => {
      const total = pendingHearts;
      pendingHearts = 0;
      heartTimer = null;
      if (!state.room || total <= 0) return;
      try {
        await sendHearts(state.room.id, total);
      } catch { /* recreativo */ }
    }, 300);
  };

  effectsBtn.addEventListener('click', () => openEffects());
  shareBtn.addEventListener('click', () => {
    const url = `${location.origin}/live/${state.room?.id || roomId}`;
    if (navigator.share) navigator.share({ title: 'Assista esta LIVE no MARIA FÃS', url }).catch(() => {});
    else navigator.clipboard?.writeText(url).then(
      () => toastSuccess('Link copiado'),
      () => toastError(new Error(`Copie o link: ${url}`)),
    );
  });

  async function openEffects() {
    if (!isLoggedIn()) { navigate('/entrar'); return; }
    const info = await api.get('/api/live/effects').catch(() => null);
    if (!info) { toastError(new Error('Nao foi possivel carregar os efeitos')); return; }

    // Item 7: mesmo painel compacto do host (mesmo componente, mesma fonte).
    const painel = effectPicker(info.effects || [], async (effect) => {
      // Item 22: sem sala ativa (ou efeito sem id) a causa e tratada aqui,
      // em vez de estourar um "null.id" na tela.
      if (!state.room?.id || !effect.id) {
        toastError(new Error('A LIVE nao esta ativa para enviar efeitos.'));
        return;
      }
      const clientEventId = `eff_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      try {
        const result = await triggerEffect(state.room.id, effect.id, clientEventId);
        // Toca localmente de imediato; o broadcast chega pelo realtime
        if (result.payload) effects.play(result.payload);
        modal.close();
      } catch (err) { toastError(err); }
    }, {
      rodape: info.unlimited
        ? 'Sem limite de efeitos (moderacao).'
        : `${info.used ?? 0} de ${info.limit ?? 10} efeitos hoje. O coracao nao consome cota.`,
    });

    const modal = openModal({
      title: 'Efeitos',
      size: '400px',
      body: painel,
    });
    return modal;
  }

  /**
   * (Item 12) Painel de espectadores SOBRE a LIVE.
   *
   * Nao navega, nao recarrega e nao sai da transmissao. A lista vem de
   * `GET /api/live/:id/viewers` - a rota que o backend ja expoe, com foto,
   * @username e nome reais - e e re-buscada a cada entrada e saida.
   */
  function abrirEspectadores() {
    const lista = el('div', { class: 'live-viewers-list' });
    const resumo = el('p', { class: 'small faint center' });

    const renderEspectadores = async () => {
      let pessoas = [];
      if (state.room?.id) {
        try {
          const dados = await api.get(`/api/live/${state.room.id}/viewers`);
          const online = Array.isArray(dados.viewers) ? dados.viewers : [];
          pessoas = [
            ...(dados.host ? [{ user: dados.host, isHost: true }] : []),
            ...online.map((u) => ({ user: u, isHost: false })),
          ];
        } catch {
          // Sem permissao ou LIVE encerrada: mostra o que o realtime ja sabe
          // em vez de uma lista vazia sem explicacao.
          pessoas = [...state.viewers.values()];
        }
      }
      resumo.textContent = pessoas.length === 1
        ? '1 pessoa na LIVE'
        : `${pessoas.length} pessoas na LIVE`;
      if (!pessoas.length) {
        lista.replaceChildren(el('p', { class: 'small faint center', text: 'Ninguem além de voce, por enquanto.' }));
        return;
      }
      lista.replaceChildren(...pessoas.map((pessoa) => {
        const u = pessoa.user || {};
        return el('a', {
          class: 'live-viewer-row',
          href: `/@${u.username || ''}`,
          'data-link': true,
          onClick: () => modal.close(),
        }, [
          // Foto real; sem foto, a inicial (mesmo padrao do resto do app).
          u.avatarUrl
            ? el('img', { class: 'avatar sm', src: u.avatarUrl, alt: '' })
            : el('div', { class: 'avatar sm' }, [el('span', { text: (u.displayName || u.username || '?').slice(0, 1).toUpperCase() })]),
          el('div', { class: 'grow' }, [
            el('div', { class: 'live-viewer-name', text: u.displayName || u.username || 'Participante' }),
            el('div', { class: 'live-viewer-user', text: `@${u.username || ''}` }),
          ]),
          pessoa.isHost ? el('span', { class: 'live-pill', text: 'HOST' }) : null,
        ].filter(Boolean));
      }));
    };
    renderEspectadores();

    const modal = openModal({
      title: 'Pessoas na LIVE',
      body: el('div', { class: 'stack-sm' }, [resumo, lista]),
      size: 'sm',
    });
    // Re-busca a cada entrada/saida: e o que mantem o painel em tempo real
    // enquanto ele estiver aberto.
    const parar = [
      realtime.addEventListener('LIVE_JOIN', renderEspectadores),
      realtime.addEventListener('LIVE_LEAVE', renderEspectadores),
    ];
    modal.onClose?.(() => parar.forEach((fn) => fn()));
    return modal;
  }

  /**
   * (Item 11) Menu de configuracoes da LIVE, no TOPO.
   *
   * E aqui que a acao de sair passou a morar (o botao saiu da barra
   * inferior). As reacoes rapidas tambem: com a barra enxuta, elas
   * entraram no menu em vez de competir por espaco.
   */
  function abrirConfiguracoes() {
    // Item 9: o espectador tambem controla o som dos efeitos, no mesmo menu.
    const somItem = el('button', {
      type: 'button',
      class: 'live-config-item',
      'aria-pressed': String(effects.somLigado),
      onClick: (event) => {
        const ligado = effects.definirSom(!effects.somLigado);
        event.currentTarget.setAttribute('aria-pressed', String(ligado));
        event.currentTarget.querySelector('.live-config-estado').textContent
          = ligado ? 'Ligado' : 'Desligado';
        toastSuccess(ligado ? 'Som dos efeitos ligado' : 'Som dos efeitos desligado');
      },
    }, [
      icon('volume'),
      el('span', { text: 'Som dos efeitos' }),
      el('span', {
        class: 'live-config-estado',
        text: effects.somLigado ? 'Ligado' : 'Desligado',
      }),
    ]);

    const lista = el('div', { class: 'live-config-list' }, [
      el('button', {
        type: 'button',
        class: 'live-config-item',
        onClick: () => { modal.close(); abrirReacoes(); },
      }, [icon('smile'), el('span', { text: 'Reacoes rapidas' })]),
      somItem,
      el('button', {
        type: 'button',
        class: 'live-config-item',
        onClick: () => { modal.close(); abrirEspectadores(); },
      }, [icon('eye'), el('span', { text: `Pessoas na LIVE (${formatCount(state.viewerCount)})` })]),
      el('div', { class: 'live-divider', 'aria-hidden': 'true' }),
      el('button', {
        type: 'button',
        class: 'live-config-item is-danger',
        onClick: async () => { modal.close(); await confirmarSaida(); },
      }, [icon('logout2'), el('span', { text: 'Sair da LIVE' })]),
    ]);

    const modal = openModal({ title: 'Configuracoes da LIVE', body: lista, size: 'sm' });
    return modal;
  }

  /** Reacoes rapidas: era o botao de emojis na barra, agora e um item do menu. */
  async function abrirReacoes() {
    const { QUICK_REACTIONS } = await import('./emoji.js');
    const grid = el('div', { class: 'picker-grid', style: { maxHeight: '320px' } });
    for (const emoji of QUICK_REACTIONS) {
      grid.append(el('button', {
        type: 'button', text: emoji,
        onClick: () => { sendChat(emoji); modal.close(); },
      }));
    }
    const modal = openModal({ title: 'Reacoes rapidas', size: '340px', body: grid });
    return modal;
  }

  /**
   * Estado das conexoes WebRTC, exposto em `window.__pulseConexoes()`.
   *
   * Mesma finalidade que no host: diagnostico em tela e verificador
   * multiusuario. Sem ver o estado da RTCPeerConnection nao da para dizer se a
   * falta de video e falha de sinalizacao, de ICE bloqueado ou de midia.
   * Somente leitura.
   */
  function exposeConexoes() {
    if (typeof window === 'undefined') return;
    window.__pulseConexoes = () => {
      if (!mesh || !(mesh.peers instanceof Map)) return [];
      return [...mesh.peers.entries()].map(([id, c]) => ({
        peer: String(id).slice(0, 8),
        papel: c?.role || null,
        ice: c?.pc?.iceConnectionState || null,
        conexao: c?.pc?.connectionState || null,
        sinalizacao: c?.pc?.signalingState || null,
        candidatos: c?.ice && c.ice.candidates ? c.ice.candidates.length : null,
        relayEmUso: Boolean(c?.ice && (c.ice.selectedViaRelay || c.ice.relay)),
      }));
    };
  }

  /**
   * (Item 11) "Sair da LIVE" pede confirmacao, para nao bastar um toque
   * acidental no celular.
   */
  async function confirmarSaida() {
    const ok = await confirmDialog({
      title: 'Sair da LIVE',
      message: 'Voce sai da transmissao. Pode entrar de novo a qualquer momento.',
      confirmLabel: 'Sair da LIVE',
    });
    if (!ok) return;
    await confirmExit();
  }
  async function confirmExit() {
    await teardown();
    navigate('/');
  }

  // ---- WebRTC ----
  async function connect() {
    const support = checkSupport();
    if (!support.rtc) {
      setStatus('Este navegador nao suporta transmissao ao vivo.', 'error');
      return;
    }

    const config = state.config || await liveConfig().catch(() => null);
    const ice = buildIceServers(config?.iceServers);
    if (turnWarning(config?.iceServers)) setStatus(turnWarning(config?.iceServers, { viewer: true }), 'warn');

    if (!mesh) {
      mesh = new LiveMesh({
        role: 'viewer',
        iceServers: ice.iceServers,
        onSignal: (peerId, signal) => {
          realtime.signal(state.room.id, peerId, { ...signal, roomId: state.room.id });
        },
        onPeerStream: (peerId, stream) => {
          if (peerId !== state.hostId) return;
          // Midia REAL chegou via ontrack (item 5): para o anuncio e mostra o
          // video. Antes, um erro de play() deixava o espectador sem nenhuma
          // acao possivel.
          stopAnnounce();
          hostStream = stream;
          if (remoteVideo.srcObject !== stream) remoteVideo.srcObject = stream;
          remoteVideo.play().then(
            () => {
              state.connected = true;
              clearMediaWatchdog();
              renderMediaState('playing');
              setStatus('');
            },
            (err) => {
              state.connected = true;
              clearMediaWatchdog();
              if (err?.name === 'NotAllowedError') {
                // Autoplay com AUDIO negado: a midia chegou e segue no
                // srcObject. So falta um toque do usuario - nao e falha.
                renderMediaState('blocked');
                setStatus('Toque no video para ativar o audio.', 'warn');
              } else {
                // Reproducao falhou com midia presente: mostra o estado real
                // e a acao, sem voltar para "sem midia".
                renderMediaState('error', {
                  title: 'Nao foi possivel reproduzir a transmissao.',
                  detail: err?.message || '',
                  reason: 'play_failed',
                });
              }
            },
          );
        },
        onPeerState: (peerId, info) => {
          if (peerId !== state.hostId) return;
          if (String(info.state).startsWith('ice:connected') || info.state === 'pc:connected') {
            state.connected = true;
            setStatus('');
            // ICE conectado mas midia ainda a caminho: continua em
            // "conectando", nunca em "sem midia".
            if (!remoteVideo.srcObject) renderMediaState('connecting');
          }
          if (info.state === 'reconnecting') {
            setStatus('Reconectando a transmissao\u2026', 'warn');
            renderMediaState('reconnect');
            armMediaWatchdog(10);
          }
          if (info.state === 'reconnect_failed') {
            // Backoff acabou: oferecer o botao que REINICIA a conexao.
            setStatus('');
            renderMediaState('error', {
              title: 'Nao foi possivel conectar a transmissao.',
              detail: 'A conexao com quem transmite foi perdida.',
              reason: 'reconnect_failed',
            });
          }
        },
      });
    }

    // Uma unica conexao com o host; reconexao reaproveita a mesma
    const connection = mesh.ensure(state.hostId);
    // Diagnostico de conexao disponivel em tela e no verificador.
    exposeConexoes();
    if (!connection.remoteDescriptionSet && connection.pc?.signalingState === 'stable' && connection.pc?.localDescription == null) {
      // O host iniciara a oferta quando receber nosso join; nada a fazer aqui.
    }
  }

  const onSignal = async (event) => {
    const payload = event.detail || {};
    if (!payload.from || payload.roomId !== state.room?.id) return;
    // A oferta do anfitriao encerra o anuncio com repeticao.
    if (payload.signal?.kind === 'description') stopAnnounce();
    if (!mesh) {
      // Sinal chegou antes da malha: guarda em vez de descartar (era esta a
      // causa da tela presa em "Conectando").
      pendingSignals.push(payload);
      return;
    }
    const connection = mesh.ensure(payload.from);
    await connection.handleSignal(payload.signal);
  };

  /**
   * Anuncia a presenca e REANUNCIA enquanto o anfitriao nao responder com
   * oferta. Um sinal perdido deixava a LIVE muda para sempre; agora o
   * espectador se anuncia de novo e o anfitriao reenvia a mesma oferta.
   */
  function announce() {
    if (state.connected || leaving || announceTimer) return;
    announceAttempts = 0;
    // Enquanto a midia nao chega, mantemos o estado "conectando" e armamos o
    // watchdog: se nada chegar, o espectador ganha "Tentar novamente".
    if (state.mediaState !== 'playing') renderMediaState('connecting');
    armMediaWatchdog();
    const send = () => {
      if (state.connected || leaving) { stopAnnounce(); return; }
      realtime.publish('LIVE_JOIN', { roomId });
      announceAttempts += 1;
      if (announceAttempts >= ANNOUNCE_ATTEMPTS) { stopAnnounce(); return; }
      announceTimer = setTimeout(send, ANNOUNCE_INTERVAL);
    };
    send();
  }

  function stopAnnounce() {
    clearTimeout(announceTimer);
    announceTimer = null;
  }

  const onJoin = (event) => {
    const payload = event.detail || {};
    if (payload.roomId !== state.room?.id) return;
    state.viewerCount = Number(payload.viewerCount) || 0;
    renderTop();
  };

  const onLeave = (event) => {
    const payload = event.detail || {};
    if (payload.roomId !== state.room?.id) return;
    if (payload.reason === 'ended') {
      // Item 6: LIVE encerrada tem estado PROPRIO, nunca "sem midia".
      state.connected = false;
      stopAnnounce();
      clearMediaWatchdog();
      setStatus('');
      renderMediaState('ended');
      try { remoteVideo.pause(); } catch { /* ignore */ }
      clearTimeout(exitTimer);
      exitTimer = setTimeout(() => { teardown().finally(() => navigate('/')); }, 4000);
      return;
    }
    state.viewerCount = Number(payload.viewerCount) || Math.max(0, state.viewerCount - 1);
    renderTop();
  };

  let exitTimer = null;

  const onComment = (event) => {
    const payload = event.detail || {};
    if (payload.roomId !== state.room?.id) return;
    // CHAT_MESSAGE nunca dispara efeito: apenas EFFECT_TRIGGER toca animacao
    if (payload.message) appendChat(payload.message);
    else if (payload.deleted) clearChat();
  };

  const onHeart = (event) => {
    const payload = event.detail || {};
    if (payload.roomId !== state.room?.id) return;
    const amount = Number(payload.quantity) || 1;
    for (let i = 0; i < Math.min(amount, 4); i += 1) setTimeout(() => hearts.spawn(), i * 80);
  };

  /**
 * ORIENTACAO do quadro, enviada pelo anfitriao.
 *
 * Chega um unico inteiro (0, 90 ou 270) com a PREFERENCIA dele. Guardar o valor
 * e deixar o `ajustarEnquadramento` recalcular e o suficiente: ele decide sozinho
 * se a rotacao ajuda NA TELA DESTE ESPECTADOR (num desktop ela atrapalha, e ai
 * nao gira).
 *
 * Chegar antes do primeiro frame nao e problema - o valor fica guardado e o
 * proximo `aplicar()` (no `loadedmetadata`, no `resize` ou no intervalo inicial)
 * ja usa a direcao certa. E quem chega depois do anuncio tambem sai correto,
 * porque o padrao ja e 90 dos dois lados.
 */
const onRotation = (event) => {
    const payload = event.detail || {};
    if (payload.roomId && state.room && payload.roomId !== state.room.id) return;
    const bruto = Number(payload.rotacao);
    const preferencia = bruto === 90 || bruto === 270 || bruto === 0 ? bruto : 90;
    remoteVideo.dataset.rotacaoPreferida = String(preferencia);
    if (preferencia === state.rotacaoPreferida) return;
    state.rotacaoPreferida = preferencia;
    // Reaplica agora: `ajustarEnquadramento` escuta `resize` no proprio elemento,
    // entao disparar o evento reexecuta o ajuste com a nova direcao.
    remoteVideo.dispatchEvent(new Event('resize'));
  };

  const onEffect = (event) => {
    const payload = event.detail || {};
    if (payload.roomId !== state.room?.id) return;
    // Somente eventos AO VIVO tocam animacao (nada de historico)
    effects.play(payload);
  };

  const onReconnecting = () => {
    if (!state.connected) return;
    setStatus('Conexao instavel. Tentando reconectar\u2026', 'warn');
    renderMediaState('reconnect');
  };

  const onModeration = (event) => {
    const payload = event.detail || {};
    if (payload.action === 'muted') setStatus(`Silenciado por ${payload.minutes} minutos.`, 'error');
    if (payload.action === 'removed' || payload.action === 'banned') {
      setStatus('Voce foi removido desta LIVE.', 'error');
      setTimeout(() => { teardown().finally(() => navigate('/')); }, 2500);
    }
  };

  // Reconexao: nao cria PeerConnection duplicada, nao duplica audio/video
  const onOffline = () => {
    if (!state.connected) return;
    setStatus('Sem internet. Reconectando\u2026', 'error');
    renderMediaState('reconnect');
  };
  const onOnline = async () => {
    if (!state.room || state.connected || leaving) return;
    setStatus('Rede restabelecida. Reconectando\u2026', 'warn');
    renderMediaState('reconnect');
    try {
      // Item 8: a interface de rede mudou, entao o ICE antigo nao vale mais.
      // hardResetAll recria a PeerConnection (sem deixar duas vivas) e o
      // anfitriao reenvia a oferta quando reanunciamos.
      mesh?.hardResetAll('network_back');
      await joinLive(state.room.id, { reconnect: true });
      await connect();
      announce();
      armMediaWatchdog(15);
    } catch (err) {
      renderMediaState('error', {
        title: 'Nao foi possivel conectar a transmissao.',
        detail: err.message,
        reason: 'network_back',
      });
    }
  };

  async function teardown() {
    leaving = true;
    stopAnnounce();
    clearTimeout(exitTimer);
    clearTimeout(heartTimer);
    heartTimer = null;
    effects?.clear();
    hearts?.clear();
    // Devolve as camadas ao `body`: sem isso a proxima LIVE comeca com a
    // camada presa dentro da page anterior.
    effects?.unmount();
    hearts?.unmount();
    clearMediaWatchdog();
    mediaStateNode = null;
    mesh?.destroy();
    mesh = null;
    unsubTopic?.(); unsubTopic = null;
    stopLayout?.();
    stopFit?.();
    stopLayout = null;
    for (const fn of cleanups) fn();
    cleanups.length = 0;
    window.removeEventListener('offline', onOffline);
    window.removeEventListener('online', onOnline);
    try { remoteVideo.pause(); } catch { /* ignore */ }
    remoteVideo.srcObject = null;
    if (state.room) await leaveLive(state.room.id).catch(() => {});
    page.replaceChildren();
    page.remove();
  }

  async function boot() {
    effects = new EffectOverlay();
    hearts = new HeartLayer();
    // Item 6: as duas camadas entram na `.live-page` para ficarem ACIMA do
    // video e ABAIXO do chat/controles. Fora dela (no `body`) ficavam atras
    // da transmissao por causa do `z-index` da page.
    effects.mountIn(page);
    hearts.mountIn(page);
    // Mede a barra inferior de verdade: o chat e os controles passam a
    // usar --live-bar-h em vez de um valor fixo.
    stopLayout = observeLiveLayout(page, inputBar);
    // A preferencia de rotacao existente permanece; o quadro sempre cobre a
    // tela inteira, aceitando o corte necessario.
    //
    // A ROTACAO e o unico dado do anfitriao que o espectador usa: quando a
    // camera dele so entrega landscape, o quadro e girado 90 graus para caber
    // em tela cheia vertical sem zoom nem crop. A geometria e a decisao de
    // ajuste sao recalculadas aqui, no aparelho do espectador, a partir do
    // quadro que ele recebeu; a DIRECAO (90 ou 270) vem do anfitriao, porque
    // e uma propriedade do buffer da camera e nao da tela.
    stopFit = ajustarEnquadramento(remoteVideo, () => document.querySelector('.live-video-wrap'), {
      rotacao: () => state.rotacaoPreferida,
      aoMudar: (decisao) => { state.rotacaoAplicada = decisao.rotacao; },
    });

    try {
      const info = await getLive(roomId);
      state.room = info.room;
      state.hostId = info.room?.host?.id;
      // A preferencia de rotacao vem na sala, e nao so pelo anuncio do realtime:
      // quem abre a LIVE no meio nao estava na topica quando o anfitriao
      // publicou, e sem isso entraria com a direcao padrao errada.
      //
      // `90` e `270` sao as direcoes que o anfitriao escolheu. O `0` na sala
      // significa "o anfitriao pediu para nao girar" - e tambem seria o valor
      // inicial de uma sala ainda sem publicacao. Nos dois casos o app cai no
      // proprio padrao (90), que e o que o anfitriao ja estava usando; quem
      // estava assistindo quando a escolha mudou recebe o valor pelo fanout.
      const preferida = Number(info.room?.videoRotation);
      if (preferida === 90 || preferida === 270 || preferida === 0) state.rotacaoPreferida = preferida;
      remoteVideo.dataset.rotacaoPreferida = String(state.rotacaoPreferida);
      state.viewerCount = info.viewerCount ?? info.room?.viewerCount ?? 0;
      state.config = await liveConfig().catch(() => null);
    } catch (err) {
      videoHost.replaceChildren(el('div', { class: 'live-placeholder' }, [
        icon('warning'),
        el('p', { text: err.message }),
        el('button', { type: 'button', class: 'btn btn-primary', text: 'Voltar', onClick: () => navigate('/') }),
      ]));
      return;
    }

    if (!state.room || state.room.status !== 'live') {
      videoHost.replaceChildren(el('div', { class: 'live-placeholder' }, [
        icon('live'),
        el('p', { text: 'Esta LIVE ja foi encerrada.' }),
        el('button', { type: 'button', class: 'btn btn-primary', text: 'Voltar', onClick: () => navigate('/') }),
      ]));
      return;
    }

    videoHost.append(remoteVideo);
    renderTop();
    for (const message of state.room.messages || []) appendChat(message);

    if (!isLoggedIn()) {
      setStatus('Faca login para comentar e enviar coracoes.', 'warn');
    }

    if (!state.hostId) {
      setStatus('Nao foi possivel identificar o anfitriao.', 'error');
      return;
    }

    // Entrada como espectador (backend registra presenca e conta)
    try {
      const joined = await joinLive(roomId);
      state.viewerCount = joined.viewerCount ?? state.viewerCount;
      state.config = await liveConfig().catch(() => state.config);
      renderTop();
      for (const message of joined.room?.messages || []) {
        if (!state.chatVisible.length) appendChat(message);
      }
    } catch (err) {
      if (err.code === 'live_ended') {
        setStatus('Esta LIVE ja foi encerrada.', 'warn');
      } else {
        setStatus(err.message, 'error');
      }
      return;
    }

    unsubTopic = realtime.subscribe(`live:${roomId}`);

    // Ouvintes e malha ANTES do anuncio: um sinal do anfitriao que chegue
    // cedo agora tem quem trate, em vez de ser descartado.
    cleanups.push(realtime.addEventListener('LIVE_SIGNAL', onSignal));
    cleanups.push(realtime.addEventListener('LIVE_JOIN', onJoin));
    cleanups.push(realtime.addEventListener('LIVE_LEAVE', onLeave));
    cleanups.push(realtime.addEventListener('LIVE_COMMENT', onComment));
    cleanups.push(realtime.addEventListener('LIVE_HEART', onHeart));
    cleanups.push(realtime.addEventListener('LIVE_VIDEO_ROTATION', onRotation));
    cleanups.push(realtime.addEventListener('EFFECT_TRIGGER', onEffect));
    cleanups.push(realtime.addEventListener('reconnecting', onReconnecting));
    cleanups.push(realtime.addEventListener('MODERATION', onModeration));
    window.addEventListener('offline', onOffline);
    window.addEventListener('online', onOnline);

    await connect();

    // Reposiciona o que chegou durante a criacao da malha.
    while (pendingSignals.length) {
      const payload = pendingSignals.shift();
      await mesh?.ensure(payload.from).handleSignal(payload.signal);
    }

    announce();
  }

  // Clique no video do espectador tambem religa o audio (politica do navegador)
  remoteVideo.addEventListener('click', () => {
    remoteVideo.play().catch(() => {});
  });

  boot();

  return {
    element: page,
    async destroy() {
      await teardown();
    },
    get room() { return state.room; },
    get connected() { return state.connected; },
  };
}

/** Descobre LIVEs ativas. */
export async function discoverLive() {
  return api.get('/api/live/discover');
}
