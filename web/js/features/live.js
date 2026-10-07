/**
 * LIVE - tela do ANFITRIAO (streamer).
 *
 * Camera e microfone REAIS via getUserMedia(); o MediaStream vai direto para
 * as RTCPeerConnection (nao ha canvas nem captura falsa).
 *
 * Controles de camera/micrudio ficam em CONFIGURACOES (painel modal),
 * nunca espalhados sobre os comentarios.
 */
import { api } from '../core/api.js';
import { el, icon, formatCount } from '../core/dom.js';
import { effectPicker } from './live-effects-card.js';
import { openLiveProfileCard } from './live-profile-card.js';
import { openModal, toastError, toastSuccess, confirmDialog } from '../core/ui.js';
import { store } from '../core/store.js';
import { realtime } from '../core/realtime.js';
import { navigate } from '../core/router.js';
import { LiveMesh, buildIceServers, checkSupport, turnWarning } from './webrtc.js';
import { EffectOverlay, HeartLayer } from './live-effects.js';
import { observeLiveLayout, ajustarEnquadramento } from './live-layout.js';
import { montarDiagnosticoCamera } from './live-camera-diag.js';
import { MediaDevices, rotacaoNecessaria } from './live-media-devices.js';

const CHAVE_ROTACAO = 'mariafas.live.rotacao';

/**
 * Preferencia de rotacao da camera escolhida pelo anfitriao: 0 (nao girar),
 * 90 ou 270. Padrao 90, porque e a direcao com que a maioria dos aparelhos
 * entrega o buffer quando a camera frontal e landscape num aparelho em retrato.
 *
 * O valor e local do anfitriao (ele ve o proprio rosto na tela), mas e
 * PUBLICADO para os espectadores, que aplicam o mesmo numero - assim todo mundo
 * ve a pessoa de pe. Persistir localmente mantem a escolha entre sessoes.
 *
 * @returns {0|90|270}
 */
function lerPreferenciaRotacao() {
  try {
    const bruto = localStorage.getItem(CHAVE_ROTACAO);
    // `Number(null)` e `0`, entao "nada guardado" e "escolheu nao girar" seriam
    // a mesma coisa - e o primeiro clique faria 0 -> 90, uma mudanca invisivel
    // que parece que o botao nao funciona. Por isso o valor bruto e lido antes.
    if (bruto === null || bruto === '') return 270;
    const v = Number(bruto);
    if (v === 0) return 0;
    return v === 90 || v === 270 ? v : 270;
  } catch {
    return 270;
  }
}

function gravarPreferenciaRotacao(valor) {
  try {
    localStorage.setItem(CHAVE_ROTACAO, String(valor));
  } catch {
    // sem storage (modo privado): a preferencia vale so nesta sessao
  }
}

const MAX_LIVE_CHAT_VISIBLE = 10;

export async function createLiveRoom({ title = '', category = 'geral' } = {}) {
  const result = await api.post('/api/live', { title, category });
  return result;
}

export async function endLive(roomId) {
  return api.post(`/api/live/${roomId}/end`, {});
}

export async function liveConfig() {
  return api.get('/api/live/config');
}

export async function joinLive(roomId, { reconnect = false } = {}) {
  return api.post(`/api/live/${roomId}/join`, { reconnect });
}

export async function leaveLive(roomId) {
  return api.post(`/api/live/${roomId}/leave`, {});
}

export async function postLiveMessage(roomId, body) {
  return api.post(`/api/live/${roomId}/messages`, { body });
}

export async function sendHearts(roomId, quantity = 1) {
  return api.post(`/api/live/${roomId}/hearts`, { quantity });
}

export async function triggerEffect(roomId, effectId, clientEventId) {
  return api.post(`/api/live/${roomId}/effects`, { effectId, clientEventId });
}

// --------------------------------------------------------------------------
// Modulo de camera/microfone (reutilizado pelo editor e pela LIVE)
// --------------------------------------------------------------------------
// A classe vive em `live-media-devices.js` porque e a ORIGEM do enquadramento:
// ela decide constraints, zoom e portrait antes de o stream chegar a qualquer
// `<video>`. Isolar tambem permite testa-la em Node, sem camera.
export { MediaDevices } from './live-media-devices.js';

// --------------------------------------------------------------------------
// Tela do anfitriao
// --------------------------------------------------------------------------
export function createHostLiveScreen({ title = '', category = 'geral' } = {}) {
  const state = {
    room: null,
    config: null,
    stream: null,
    localVideo: null,
    viewers: new Map(),
    chatVisible: [],
    viewerCount: 0,
    startedAt: null,
  };

  const cleanups = [];
  // Itens 10 e 11: altura da barra medida + teclado (visualViewport).
  let stopLayout = null;
  // Item 5: cleanup do ajuste de enquadramento do video.
  let stopFit = null;
  const devices = new MediaDevices();
  let mesh = null;
  let effects = null;
  let hearts = null;
  let unsubTopic = null;
  let unsubHost = null;
  let heartBatchTimer = null;
  let pendingHearts = 0;

  const videoWrap = el('div', { class: 'live-video-wrap' });
  const localVideo = el('video', {
    class: 'local',
    autoplay: true,
    muted: true,
    playsinline: true,
    'aria-label': 'Sua camera',
  });
  localVideo.muted = true;
  state.localVideo = localVideo;

  const topBar = el('div', { class: 'live-top' });
  const chatLayer = el('div', { class: 'live-chat' });
  const inputBar = el('div', { class: 'live-input-bar' });
  const heartButton = el('button', { type: 'button', class: 'live-heart-btn', 'aria-label': 'Enviar coracao' }, [icon('heart')]);
  const placeholder = el('div', { class: 'live-placeholder' }, [
    el('div', { class: 'spinner', style: { margin: '0 auto 12px' } }),
    el('p', { text: 'Preparando camera e microfone…' }),
  ]);
  videoWrap.append(placeholder);

  // Item 9: aviso de TURN COMPACTO. Antes era uma faixa `right:12px` logo abaixo
// do topo, cobrindo a transmissao. Agora e um chip pequeno no canto superior
// esquerdo, recolhivel, e so host/admin veem o detalhe de ICE.
const turnNotice = el('div', { class: 'live-turn', dataset: { state: 'hidden' } }, [
    el('button', {
      type: 'button', class: 'live-turn-chip', 'aria-label': 'Diagnostico de conexao',
    }, [icon('info'), el('span', { class: 'live-turn-text' })]),
    el('div', { class: 'live-turn-panel' }),
  ]);

  const page = el('div', { class: 'live-page', dataset: { role: 'host' } }, [
    videoWrap, topBar, turnNotice, chatLayer, heartButton, inputBar,
  ]);

  // ---- Chat do host: ve os comentarios ----
  const chatInput = el('input', {
    class: 'live-input',
    type: 'text',
    placeholder: 'Digite...',
    maxlength: '300',
    enterkeyhint: 'send',
    'aria-label': 'Mensagem para a LIVE',
  });
  // (11) O botao de CONFIGURACOES nao vive mais aqui: ele sobe para o topo,
  // ao lado do contador de espectadores (ver `renderTop`).
  //
  // (13) O botao de efeitos SAI de dentro do campo de texto. Grudado no input
  // ele invadia a area de digitacao e, com o teclado aberto, empurrava o texto.
  // Aqui e um controle proprio, separado por um divisor.
  const sendBtn = el('button', {
    type: 'button',
    class: 'live-send',
    'aria-label': 'Confirmar envio da mensagem',
    hidden: true,
  }, [icon('send')]);
  const effectsBtn = el('button', { type: 'button', class: 'round-btn live-effects-btn', 'aria-label': 'Efeitos da LIVE' }, [icon('sparkle')]);
  const shareBtn = el('button', { type: 'button', class: 'round-btn', 'aria-label': 'Compartilhar LIVE' }, [icon('share')]);
  const repostBtn = el('button', { type: 'button', class: 'round-btn', 'aria-label': 'Republicar LIVE' }, [icon('repeat')]);

  const fieldWrap = el('div', { class: 'live-field' }, [chatInput]);
  // Divisor visual entre o campo e os controles: o pedido era "separar
  // visualmente os controles".
  const divider = el('span', { class: 'live-divider', 'aria-hidden': 'true' });
  const toolsGroup = el('div', { class: 'live-tools' }, [effectsBtn, divider, shareBtn, repostBtn]);
  inputBar.append(fieldWrap, sendBtn, toolsGroup);

  /**
   * (13) O botao de CONFIRMAR ENVIO so aparece quando ha mensagem pronta.
   *
   * Antes ficava sempre visivel e ocupava espaco na barra sem ter para que
   * servir. Agora aparece ao focar o campo, ao digitar e ao colar texto, e some
   * de novo depois do envio ou quando o campo esvazia.
   */
  const syncSendButton = () => {
    const temTexto = chatInput.value.trim().length > 0;
    sendBtn.hidden = !temTexto;
    fieldWrap.classList.toggle('is-active', temTexto);
  };
  chatInput.addEventListener('input', syncSendButton);
  chatInput.addEventListener('focus', syncSendButton);
  chatInput.addEventListener('blur', () => { if (!chatInput.value.trim()) syncSendButton(); });

  const enviarComentario = () => {
    const body = chatInput.value.trim();
    if (!body) return;
    chatInput.value = '';
    // Limpa o campo ANTES de publicar e esconde o botao: o usuario ve o
    // retorno imediato da acao.
    syncSendButton();
    realtime.publish('LIVE_COMMENT', { roomId: state.room.id, body });
  };

  chatInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    enviarComentario();
  });
  sendBtn.addEventListener('click', enviarComentario);

  effectsBtn.addEventListener('click', () => openEffectsPicker(true));
  shareBtn.addEventListener('click', () => shareRoom());
  repostBtn.addEventListener('click', () => republicarLive());
  heartButton.addEventListener('click', () => {
    hearts.spawn({ x: window.innerWidth - 90, y: window.innerHeight - 220 });
    queueHearts(1);
  });

  const queueHearts = (quantity) => {
    pendingHearts += quantity;
    if (heartBatchTimer) return;
    // Agrupa toques rapidos, mas CADA toque vira 1 like no backend
    heartBatchTimer = setTimeout(async () => {
      const total = pendingHearts;
      pendingHearts = 0;
      heartBatchTimer = null;
      if (!state.room || total <= 0) return;
      try {
        await sendHearts(state.room.id, total);
      } catch { /* coracao e recreativo: falha nao interrompe */ }
    }, 320);
  };

  // ---- Topo ----
  const renderTop = () => {
    const host = state.room?.host;
    topBar.replaceChildren(
      el('div', { class: 'live-host' }, [
        el('div', { class: 'avatar sm', style: { width: '38px', height: '38px' } }, [
          host?.avatarUrl ? el('img', { src: host.avatarUrl, alt: '' }) : el('div', { class: 'avatar sm' }),
        ]),
        el('div', { class: 'grow' }, [
          el('div', { class: 'live-host-name', text: host?.displayName || 'Voce' }),
          el('div', { class: 'live-host-user', text: `@${host?.username || store.user?.username || ''}` }),
        ]),
      ]),
      el('div', { class: 'live-top-actions' }, [
        el('span', { class: 'live-pill live-dot-item' }, [el('i'), el('span', { text: 'AO VIVO' })]),
        // (12) O contador de espectadores vira BOTAO: abre o painel com quem
        // esta na LIVE, sem sair da transmissao e sem recarregar a pagina.
        el('button', {
          type: 'button',
          class: 'live-pill live-viewers-btn',
          'aria-label': 'Ver quem esta na LIVE',
          onClick: () => abrirEspectadores(),
        }, [icon('eye'), el('span', { text: formatCount(state.viewerCount) })]),
        // (11) O botao de CONFIGURACOES fica aqui, no topo, ao lado do
        // indicador de espectadores - e nao mais na barra inferior.
        el('button', {
          type: 'button',
          class: 'round-btn live-settings-btn',
          'aria-label': 'Configuracoes da transmissao',
          onClick: () => abrirConfiguracoes(),
        }, [icon('settings')]),
      ]),
    );
  };

  // ---- Chat (ultimos ~10 visiveis, banco intacto) ----
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
          ? el('img', {
            src: message.author.avatarUrl, alt: '', loading: 'lazy',
            onError: (event) => { event.currentTarget.replaceWith(el('div', { class: 'avatar xs' })); },
          })
          : el('div', { class: 'avatar xs' }),
      ]),
      el('span', { class: 'name', text: `@${message.author?.username || ''}` }),
      el('span', { class: 'text', text: message.text }),
    ]);
    chatLayer.append(node);
    state.chatVisible.push(node);
    // Mantem apenas os ultimos 10 visiveis (historico permanece no banco)
    while (state.chatVisible.length > MAX_LIVE_CHAT_VISIBLE) {
      const old = state.chatVisible.shift();
      old.remove();
    }
    // Efeito do proprio anfitriao: nao cria animacao de chat
  };

  const clearChat = () => {
    chatLayer.replaceChildren();
    state.chatVisible = [];
  };

  // ---- Configuracoes (camera/microfone ficam AQUI, nao sobre o chat) ----
  async function openDeviceSettings() {
    const micToggle = el('input', { type: 'checkbox', checked: devices.micEnabled });
    const camToggle = el('input', { type: 'checkbox', checked: devices.cameraEnabled });
    const cameraSelect = el('select', { class: 'select' });
    const micSelect = el('select', { class: 'select' });
    const statsLine = el('div', { class: 'tiny faint' });

    let cameras = [];
    let mics = [];
    try {
      cameras = await devices.listCameras();
      mics = await devices.listMics();
    } catch {
      statsLine.textContent = 'Nao foi possivel listar dispositivos (permite acesso a camera para ver os nomes).';
    }

    const fill = (select, list, activeKind) => {
      select.replaceChildren();
      for (const device of list) {
        select.append(el('option', { value: device.deviceId, text: device.label || `${activeKind} ${select.children.length + 1}` }));
      }
      if (!list.length) select.append(el('option', { value: '', text: 'Nenhum dispositivo encontrado' }));
    };
    fill(cameraSelect, cameras, 'Camera');
    fill(micSelect, mics, 'Microfone');

    const applyTracks = () => {
      devices.setMicEnabled(micToggle.checked);
      devices.setCameraEnabled(camToggle.checked);
      updateLocalPreview();
    };
    micToggle.addEventListener('change', applyTracks);
    camToggle.addEventListener('change', applyTracks);
    cameraSelect.addEventListener('change', async () => {
      try {
        await devices.switchCamera(cameraSelect.value);
        updateLocalPreview();
      } catch (err) { toastError(err); }
    });

    if (state.config?.iceServers) {
      statsLine.textContent = `Conexoes: ${state.viewers.size} | RTT medio: ${averageRtt()} ms | STUN/TURN: ${state.config.iceServers.turnConfigured ? 'STUN + TURN' : 'apenas STUN'}`;
    }

    const modal = openModal({
      title: 'Configuracoes da LIVE',
      size: '440px',
      body: el('div', {}, [
        el('div', { class: 'switch' }, [el('span', { text: 'Microfone' }), micToggle]),
        el('div', { class: 'field' }, [el('label', { text: 'Dispositivo de audio' }), micSelect]),
        el('div', { class: 'switch' }, [el('span', { text: 'Camera' }), camToggle]),
        el('div', { class: 'field' }, [el('label', { text: 'Dispositivo de video' }), cameraSelect]),
        el('button', {
          type: 'button', class: 'btn btn-ghost btn-block', text: 'Virar camera (frontal/traseira)',
          onClick: async () => {
            try {
              await devices.toggleFacing();
              updateLocalPreview();
            } catch (err) { toastError(err); }
          },
        }),
        el('hr', { class: 'divider' }),
        statsLine,
        el('p', { class: 'tiny faint', style: { marginBottom: '0' } }, [
          'Os controles ficam aqui de proposito: sobre o video aparecem apenas chat, coracao e efeitos.',
        ]),
      ]),
      actions: [{ label: 'Fechar', class: 'btn-primary' }],
    });
    return modal;
  }

  const averageRtt = () => {
    const values = [];
    for (const connection of mesh?.peers.values() || []) {
      if (connection.stats?.rtt != null) values.push(connection.stats.rtt);
    }
    if (!values.length) return 0;
    return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
  };

  const updateLocalPreview = () => {
    if (!state.stream || !localVideo) return;
    if (localVideo.srcObject !== state.stream) localVideo.srcObject = state.stream;
    localVideo.muted = true;
    // O espelho e MOVIDO para o `ajustarEnquadramento`: com rotacao, o
    // `transform` precisa de `scaleX(-1) rotate(90deg)`, e o espelho no lugar
    // errado inverteria a ordem e viraria a imagem de cabeca para baixo.
    // Aqui so ficamos com a opacidade da camera desligada.
    localVideo.style.opacity = devices.cameraEnabled ? '1' : '0';
    // O quadro REAL que a camera entregou, publicado no elemento. E o que o
    // enquadramento usa - nada de supor 16:9 ou 9:16. Fica visivel no DOM
    // (`data-quadro`) para diagnostico e para os verificadores.
    const q = MediaDevices.settingsDoQuadro(state.stream);
    if (q) {
      localVideo.dataset.quadro = `${q.width}x${q.height}`;
      localVideo.dataset.quadroProporcao = q.aspectRatio.toFixed(4);
    }
    // A rotacao que este aparelho precisa, com a preferencia do anfitriao. E
    // publicada para os espectadores logo abaixo.
    devices.rotacao = rotacaoNecessaria(q, lerPreferenciaRotacao());
    localVideo.dataset.rotacaoNecessaria = String(devices.rotacao);
    // As decisoes de CAPTURA ficam publicadas para diagnostico no proprio
    // aparelho, sem expor identificadores do dispositivo.
    const zoom = devices.zoom || null;
    localVideo.dataset.zoomSuportado = zoom ? String(zoom.suportado) : '(n/d)';
    localVideo.dataset.zoomAplicado = zoom
      ? String(Boolean(zoom.aplicado)) : '(n/d)';
    localVideo.dataset.portraitAplicado = 'false';
    // Sinaliza a orientacao para os espectadores. E a unica informacao que
    // atravessa a LIVE alem do video: onde cada um gira o elemento e uma funcao
    // pura do proprio quadro, entao nao ha nada mais a sincronizar.
    publicarRotacao(lerPreferenciaRotacao());
    if (state.stream.getVideoTracks().length === 0) {
      videoWrap.querySelector('.local')?.style.setProperty('display', 'none');
    }
  };

  /**
   * Publica a PREFERENCIA de rotacao do anfitriao na topica da LIVE.
   *
   * E um PUBLISH do cliente na propria topica em que ele ja esta inscrito, com
   * um unico campo numerico. Nao toca no WebRTC (o `LIVE_SIGNAL` continua
   * exatamente como era), nao cria conexao, nao entra no banco: e estado de
   * exibicao, e o ultimo valor substitui o anterior.
   *
   * Publica a PREFERENCIA (0, 90 ou 270) e nao a rotacao ja calculada, porque
   * depender da tela e de cada um: quem decide se precisa girar e o
   * `escolherEnquadramento`, rodando em cada aparelho com o quadro real que
   * ele recebeu. O que atravessa a LIVE e so a DIRECAO escolhida pelo
   * anfitriao, que nenhum numero deduz.
   *
   * @param {number} preferencia 0, 90 ou 270
   */
  function publicarRotacao(preferencia) {
    if (!state.room?.id) return;
    if (publicarRotacao.ultimo === preferencia) return;
    publicarRotacao.ultimo = preferencia;
    realtime.publish('LIVE_VIDEO_ROTATION', {
      roomId: state.room.id,
      rotacao: Number(preferencia) || 0,
    });
  }

  // ---- Efeitos (host tambem pode usar; sem limite para staff) ----
  // Item 7: painel compacto com busca, filtro e rolagem interna propria.
  // O `effectPicker` monta tudo (cabecalho, filtros, grade); aqui fica apenas
  // a acao de escolher um efeito.
  async function openEffectsPicker() {
    const info = await api.get('/api/live/effects').catch(() => null);
    if (!info) { toastError(new Error('Nao foi possivel carregar os efeitos')); return null; }

    const escolher = async (effect) => {
      if (!state.room?.id || !effect.id) {
        toastError(new Error('A LIVE nao esta ativa para enviar efeitos.'));
        return;
      }
      const clientEventId = `eff_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      try {
        const result = await triggerEffect(state.room.id, effect.id, clientEventId);
        if (result.payload) effects.play(result.payload);
        modal.close();
      } catch (err) { toastError(err); }
    };

    const painel = effectPicker(info.effects || [], escolher, {
      rodape: info.unlimited
        ? 'Administradores e moderadores nao tem limite de efeitos.'
        : `Voce usou ${info.used ?? 0} de ${info.limit ?? 10} efeitos hoje. O limite renova a meia-noite.`,
    });

    // 400px no desktop (nao domina a tela) e a largura da tela no celular, com o
    // painel internamente limitado pela altura util.
    const modal = openModal({
      title: 'Efeitos',
      size: '400px',
      body: painel,
    });
    return modal;
  }

  function shareRoom() {
    const url = `${location.origin}/live/${state.room.id}`;
    if (navigator.share) {
      navigator.share({ title: 'Assista minha LIVE no MARIA FÃS', url }).catch(() => {});
      return;
    }
    navigator.clipboard?.writeText(url).then(
      () => toastSuccess('Link da LIVE copiado'),
      () => toastError(new Error(`Copie o link: ${url}`)),
    );
  }

  /**
   * (12) Painel de espectadores SOBRE a LIVE.
   *
   * Nao navega, nao recarrega e nao sai da transmissao: e um modal apoiado na
   * propria tela. A lista se atualiza por `renderEspectadores()`, que roda de
   * novo a cada entrada e saida em tempo real (eventos LIVE_JOIN/LIVE_LEAVE),
   * entao alguem que aparece ou sai e visto sem F5.
   *
   * Cada linha mostra foto, @username e nome quando existe - os mesmos dados
   * que o projeto ja usa em perfis e lista de amigos.
   */
  function abrirEspectadores() {
    const lista = el('div', { class: 'live-viewers-list' });
    const resumo = el('p', { class: 'small faint center' });

    const renderEspectadores = async () => {
      // Fonte da verdade: a rota que o backend ja expoe. Traz foto,
      // @username e nome reais - e quem decide quem esta na sala.
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
          // Sem permissao ou LIVE encerrada: mostra o que o realtime ja
          // sabe, em vez de uma lista vazia sem explicacao.
          pessoas = [...state.viewers.values()];
        }
      }
      resumo.textContent = pessoas.length === 1
        ? '1 pessoa na LIVE'
        : `${pessoas.length} pessoas na LIVE`;
      if (!pessoas.length) {
        lista.replaceChildren(el('p', { class: 'small faint center', text: 'Ninguem alem de voce, por enquanto.' }));
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
    // A lista e re-buscada a cada entrada/saida: e o que mantem o painel em
    // tempo real enquanto ele estiver aberto, sem recarregar a pagina e sem
    // sair da transmissao.
    const parar = [
      realtime.addEventListener('LIVE_JOIN', renderEspectadores),
      realtime.addEventListener('LIVE_LEAVE', renderEspectadores),
    ];
    const aoFechar = () => {
      parar.forEach((fn) => fn());
      cleanups.push(() => parar.forEach((fn) => fn()));
    };
    modal.onClose?.(aoFechar);
    aoFechar();
    return modal;
  }

  /**
   * (11) Menu de configuracoes da transmissao, no TOPO da tela.
   *
   * E aqui que a acao de sair/encerrar passou a morar (o botao saiu da barra
   * inferior). O texto depende do papel: host ve "Encerrar LIVE", espectador
   * ve "Sair da LIVE". Ambos pedem confirmacao, para nao bastar um toque
   * acidental no celular.
   *
   * As opcoes de midia (camera, microfone, dispositivo) continuam as que ja
   * existiam: apenas mudam de lugar, nada foi recriado.
   */
  function abrirConfiguracoes() {
    // Item 9: controle de SOM dos efeitos. Fica no mesmo menu de configuracoes
    // porque e uma preferencia de audio da LIVE - e o rotulo mostra o estado
    // real, sem depender so do icone.
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

    // Rotacao do quadro: so aparece quando a camera NAO tem portrait nativo, que
    // e o unico caso em que o quadro precisa ser girado. E a unica preferencia
    // que o anfitriao precisa ver - a direcao do buffer da camera nao da para
    // deduzir de nenhum numero, so olhando o proprio rosto na tela.
    //
    // O no de estado e criado ANTES do botao: referenciar `rotacaoItem` de
    // dentro do proprio inicializador cairia na zona morta temporal (TDZ) e
    // quebraria a abertura do menu inteiro.
    const rotulosRotacao = { 0: 'Nao girar', 90: 'Girar 90 graus', 270: 'Girar 270 graus' };
    const rotacaoEstado = el('span', {
      class: 'live-config-estado',
      text: rotulosRotacao[lerPreferenciaRotacao()],
    });
    const rotacaoItem = el('button', {
      type: 'button',
      class: 'live-config-item',
      onClick: () => {
        const atual = lerPreferenciaRotacao();
        const proximo = atual === 0 ? 90 : (atual === 90 ? 270 : 0);
        gravarPreferenciaRotacao(proximo);
        rotacaoEstado.textContent = rotulosRotacao[proximo];
        // Reaplica na hora e republica para os espectadores.
        devices.rotacao = rotacaoNecessaria(
          MediaDevices.settingsDoQuadro(state.stream),
          proximo,
        );
        localVideo.dispatchEvent(new Event('resize'));
        publicarRotacao(proximo);
        toastSuccess(`Camera: ${rotulosRotacao[proximo].toLowerCase()}`);
      },
    }, [
      icon('refresh'),
      el('span', { text: 'Girar camera' }),
      rotacaoEstado,
    ]);

    // Diagnostico da camera: existe para distinguir, NO PROPRIO CELULAR, se o
    // zoom esta na captura (driver/sensor) ou na exibicao. Fica no menu de
    // configuracoes, fora do fluxo normal da LIVE.
    const diagItem = el('button', {
      type: 'button',
      class: 'live-config-item',
      onClick: () => {
        modal.close();
        const diag = montarDiagnosticoCamera(page, {
          stream: state.stream, video: localVideo, devices,
        });
        state.diagnosticoCamera = diag;
        diag.abrir();
      },
    }, [icon('info'), el('span', { text: 'Diagnostico da camera' })]);

    const lista = el('div', { class: 'live-config-list' }, [
      el('button', {
        type: 'button',
        class: 'live-config-item',
        onClick: () => { modal.close(); openDeviceSettings(); },
      }, [icon('settings'), el('span', { text: 'Camera e microfone' })]),
      somItem,
      rotacaoItem,
      diagItem,
      el('button', {
        type: 'button',
        class: 'live-config-item',
        onClick: () => { modal.close(); abrirEspectadores(); },
      }, [icon('eye'), el('span', { text: `Pessoas na LIVE (${formatCount(state.viewerCount)})` })]),
      el('div', { class: 'live-divider', 'aria-hidden': 'true' }),
      el('button', {
        type: 'button',
        class: 'live-config-item is-danger',
        onClick: async () => {
          modal.close();
          await confirmSair();
        },
      }, [icon('logout2'), el('span', { text: state.isHost ? 'Encerrar LIVE' : 'Sair da LIVE' })]),
    ]);

    const modal = openModal({ title: 'Configuracoes da LIVE', body: lista, size: 'sm' });
    return modal;
  }

  /** Confirmacao unica para sair/encerrar, com o texto do papel (item 11). */
  async function confirmSair() {
    const isHost = Boolean(state.isHost);
    const ok = await confirmDialog({
      title: isHost ? 'Encerrar a LIVE' : 'Sair da LIVE',
      message: isHost
        ? 'Todos os espectadores serao avisados e a transmissao sera finalizada.'
        : 'Voce sai da transmissao. Pode entrar de novo a qualquer momento.',
      confirmLabel: isHost ? 'Encerrar LIVE' : 'Sair da LIVE',
      danger: isHost,
    });
    if (!ok) return;
    if (isHost) {
      await teardown('host_ended');
      try { await endLive(state.room.id); } catch { /* ja encerrada no servidor */ }
      toastSuccess('LIVE encerrada');
      navigate('/');
      return;
    }
    await teardown('viewer_left');
    navigate('/');
  }

  /**
   * (13) Republicar a LIVE.
   *
   * Republicar uma LIVE significa publicar um post do tipo `live` que aponta
   * para a sala (`roomId`). E a rota que o projeto ja tem
   * (`POST /api/posts`), com a referencia gravada em `posts.live_room_id`
   * (migracao 0004) - nenhum endpoint ou sistema novo foi criado.
   */
  async function republicarLive() {
    const room = state.room;
    if (!room?.id) return;
    try {
      await api.post('/api/posts', {
        type: 'live',
        roomId: room.id,
        caption: room.title ? `Assista: ${room.title}` : 'Assista a LIVE agora',
      });
      toastSuccess('LIVE republicada no seu perfil');
    } catch (err) {
      // A mensagem do backend e repassada como esta: nao escondo erro.
      toastError(err);
    }
  }

  /**
   * Estado das conexoes WebRTC, exposto em `window.__pulseConexoes()`.
   *
   * Serve ao diagnostico em tela e ao verificador multiusuario: quando o
   * espectador nao recebe video, a unica informacao util e o estado da
   * RTCPeerConnection (ICE, conexao, sinalizacao, candidatos). Sem isso o
   * teste so consegue dizer "1/3 tocando", o que nao distingue falha de
   * sinalizacao de ICE bloqueado.
   *
   * Somente leitura: nao altera o comportamento da transmissao.
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
        // So conta relay quando o par SELETADO sai por relay - e nao quando a
        // lista de ICE apenas tem um servidor TURN configurado.
        relayEmUso: Boolean(c?.ice && (c.ice.selectedViaRelay || c.ice.relay)),
      }));
    };
  }

  async function confirmEnd() {
    const ok = await confirmDialog({
      title: 'Encerrar a LIVE',
      message: 'Todos os espectadores serao avisados e a transmissao sera finalizada.',
      confirmLabel: 'Encerrar LIVE',
      danger: true,
    });
    if (!ok) return;
    await teardown('host_ended');
    try { await endLive(state.room.id); } catch { /* ja encerrada no servidor */ }
    toastSuccess('LIVE encerrada');
    navigate('/');
  }

  // ---- WebRTC: host envia midia real ----
  async function startMesh() {
    state.config = await liveConfig();
    const ice = buildIceServers(state.config.iceServers);
    mesh = new LiveMesh({
      role: 'host',
      iceServers: ice.iceServers,
      onSignal: (peerId, signal) => {
        realtime.signal(state.room.id, peerId, { ...signal, roomId: state.room.id });
      },
      onPeerStream: (peerId, stream) => {
        // O host nao precisa exibir o stream do espectador; apenas monitora
        console.debug('[live] espectador conectou', peerId, stream.getTracks().map((t) => t.kind));
      },
      onPeerState: (peerId, info) => {
        console.debug('[live] peer', peerId, info.state);
      },
    });
    mesh.setLocalStream(state.stream);
    exposeConexoes();
    updateTurnNotice();
  }

  // ---- Item 9: painel compacto de conexao (host/admin) ----
  // Regra: o texto curto aparece sempre; o detalhe (tipos de candidato ICE,
  // caminho usado, viewer count) so no painel expansivel. Nada de nome de
  // variavel de ambiente nem credencial em tela.
  function updateTurnNotice() {
    const config = state.config?.iceServers;
    if (!config) return;
    const linha = turnWarning(config);
    const textoNode = turnNotice.querySelector('.live-turn-text');
    if (!linha) {
      turnNotice.dataset.state = 'hidden';
      return;
    }
    turnNotice.dataset.state = 'open';
    textoNode.textContent = linha;
    renderTurnPanel();
  }

  function renderTurnPanel() {
    const painel = turnNotice.querySelector('.live-turn-panel');
    if (turnNotice.dataset.state !== 'open' || turnNotice.dataset.expanded !== '1') return;
    const config = state.config?.iceServers;
    const relatorio = mesh?.iceReport?.() || { candidates: {}, paths: [] };
    const c = relatorio.candidates || {};
    const linhas = [
      el('div', { class: 'strong tiny', text: 'Conexao da transmissao' }),
      el('div', { class: 'tiny', text: `Candidatos: ${c.host || 0} host / ${c.srflx || 0} publicos / ${c.relay || 0} relay` }),
      el('div', { class: 'tiny', text: `TURN: ${config?.turnConfigured ? 'configurado' : 'nao configurado'}` }),
      el('div', {
        class: 'tiny',
        text: relatorio.relayGathered
          ? 'Relay TURN obtido pelo navegador.'
          : 'Sem relay: trafego direto possivel nesta rede.',
      }),
      el('div', { class: 'tiny', text: `Espectadores: ${state.viewers.size}` }),
    ];
    painel.replaceChildren(...linhas);
  }

  function initTurnNotice() {
    const chip = turnNotice.querySelector('.live-turn-chip');
    chip.addEventListener('click', () => {
      turnNotice.dataset.expanded = turnNotice.dataset.expanded === '1' ? '0' : '1';
      renderTurnPanel();
    });
  }
  initTurnNotice();

  const onViewerJoin = async (event) => {
    const payload = event.detail || {};
    if (payload.userId === store.user?.id) return;
    state.viewers.set(payload.userId, { joinedAt: Date.now(), user: payload.user || null });
    state.viewerCount = payload.viewerCount ?? state.viewers.size;
    renderTop();
    if (mesh) {
      const connection = mesh.ensure(payload.userId);
      await connection.makeOffer();
    }
  };

  const onViewerLeave = (event) => {
    const payload = event.detail || {};
    mesh?.remove(payload.userId);
    state.viewers.delete(payload.userId);
    state.viewerCount = payload.viewerCount ?? state.viewers.size;
    renderTop();
  };

  const onSignal = async (event) => {
    const payload = event.detail || {};
    if (!payload.roomId || payload.roomId !== state.room?.id) return;
    if (!payload.from) return;
    if (payload.from === store.user?.id) return;
    if (!mesh) return;
    const connection = mesh.ensure(payload.from);
    await connection.handleSignal(payload.signal);
  };

  const onLiveComment = (event) => {
    const payload = event.detail || {};
    if (payload.roomId !== state.room?.id) return;
    if (payload.message) appendChat(payload.message);
    else if (payload.deleted) clearChat();
  };

  const onHeart = (event) => {
    const payload = event.detail || {};
    if (payload.roomId !== state.room?.id) return;
    const amount = Number(payload.quantity) || 1;
    for (let i = 0; i < Math.min(amount, 4); i += 1) {
      setTimeout(() => hearts.spawn(), i * 90);
    }
  };

  const onEffect = (event) => {
    const payload = event.detail || {};
    if (payload.roomId !== state.room?.id) return;
    effects.play(payload);
  };

  const onModeration = (event) => {
    const payload = event.detail || {};
    if (payload.action === 'live_ended') {
      toastError(new Error('A moderacao encerrou esta LIVE'));
      teardown('moderation');
      navigate('/');
    }
    if (payload.action === 'muted') {
      toastError(new Error(`Voce foi silenciado por ${payload.minutes} minutos`));
    }
  };

  async function teardown(reason = 'left') {
    clearTimeout(heartBatchTimer);
    heartBatchTimer = null;
    effects?.clear();
    hearts?.clear();
    // Devolve as camadas ao `body`: sem isso a proxima LIVE comeca com a
    // camada presa dentro da page anterior.
    effects?.unmount();
    hearts?.unmount();
    mesh?.destroy();
    mesh = null;
    unsubTopic?.(); unsubTopic = null;
    unsubHost?.(); unsubHost = null;
    // Item 11: o observador da barra inferior tambem precisa ser solto, senao
    // ele continua medindo uma tela que nao existe mais.
    stopLayout?.();
    stopFit?.();
    stopLayout = null;
    for (const fn of cleanups) fn();
    cleanups.length = 0;
    // Para camera e microfone de verdade
    devices.close();
    try { localVideo.pause(); } catch { /* ignore */ }
    localVideo.srcObject = null;
    if (state.room && reason === 'left') {
      await leaveLive(state.room.id).catch(() => {});
    }
    page.replaceChildren();
    page.remove();
  }

  // ---- Inicio ----
  const boot = async () => {
    const support = checkSupport();
    // Item 33: a causa real vem primeiro. Fora de HTTPS o
    // `navigator.mediaDevices` nem existe, entao dizer "seu navegador nao
    // suporta" seria mentira - o problema e o endereco, nao o navegador.
    if (!support.secure) {
      videoWrap.replaceChildren(el('div', { class: 'live-placeholder' }, [
        icon('lock'),
        el('p', { text: 'A camera e o microfone exigem HTTPS (ou localhost).' }),
        el('p', { class: 'tiny faint', text: `Endereco atual: ${location.origin}.` }),
      ]));
      return;
    }
    if (!support.getUserMedia || !support.rtc) {
      videoWrap.replaceChildren(el('div', { class: 'live-placeholder' }, [
        icon('cameraOff'),
        el('p', { text: 'Este navegador nao suporta transmissao ao vivo.' }),
        el('p', { class: 'tiny faint', text: 'Use Chrome, Edge ou Safari atualizado, em HTTPS (ou em localhost).' }),
      ]));
      return;
    }

    try {
      state.stream = await devices.open({ video: true, audio: true });
    } catch (err) {
      videoWrap.replaceChildren(el('div', { class: 'live-placeholder' }, [
        icon('cameraOff'),
        el('p', { text: err.name === 'NotAllowedError' ? 'Permissao de camera/microfone negada.' : `Falha ao abrir dispositivos: ${err.message}` }),
        el('p', { class: 'tiny faint', text: 'Autorize o acesso nas configuracoes do navegador e tente novamente.' }),
      ]));
      return;
    }

    videoWrap.append(localVideo);
    updateLocalPreview();

    try {
      const active = await api.get(`/api/users/${store.user.id}/live`);
      state.room = active.live?.status === 'live'
        ? active.live
        : (await createLiveRoom({ title, category })).room;
      // (11) O papel decide o texto e a acao do menu: host ve "Encerrar LIVE",
      // espectador ve "Sair da LIVE". Antes `isHost` nunca era preenchido e o
      // streamer via "Sair" com confirmacao errada.
      state.isHost = state.room?.host?.id === store.user?.id
        || state.room?.hostId === store.user?.id;
      state.startedAt = Date.now();
    } catch (err) {
      devices.close();
      videoWrap.replaceChildren(el('div', { class: 'live-placeholder' }, [
        icon('warning'),
        el('p', { text: err.message }),
      ]));
      return;
    }

    effects = new EffectOverlay();
    hearts = new HeartLayer();
    // Item 6: as duas camadas entram na `.live-page` para ficarem ACIMA do
    // video e ABAIXO do chat/controles. Fora dela (no `body`) ficavam atras
    // da transmissao por causa do `z-index` da page.
    effects.mountIn(page);
    hearts.mountIn(page);
    // Itens 10 e 11: mede a barra inferior de verdade e acompanha o teclado, em
    // vez de usar um `calc()` fixo que colidia com os controles em 320px.
    stopLayout = observeLiveLayout(page, inputBar);
    // A captura e a rotacao existentes sao preservadas; o enquadramento final
    // sempre cobre a tela, aceitando o corte necessario.
    stopFit = ajustarEnquadramento(localVideo, () => document.querySelector('.live-video-wrap'), {
      // A rotacao so entra quando o quadro e landscape e a tela e portrait, e
      // a DIRECAO vem da preferencia do anfitriao (que ve o proprio rosto).
      rotacao: () => devices.rotacao || 0,
      // O espelho da camera frontal e aplicado DEPOIS da rotacao, no espaco ja
      // orientado - e o que mantem a selfie como espelho em vez de virada.
      mirror: () => (devices.camera === 'user' ? -1 : 1),
    });
    renderTop();
    for (const message of state.room.messages || []) appendChat(message);

    await startMesh();

    unsubHost = realtime.subscribe(`live:host:${store.user.id}`);
    unsubTopic = realtime.subscribe(`live:${state.room.id}`);
    realtime.publish('LIVE_JOIN', { roomId: state.room.id });

    cleanups.push(realtime.addEventListener('LIVE_JOIN', onViewerJoin));
    cleanups.push(realtime.addEventListener('LIVE_LEAVE', onViewerLeave));
    cleanups.push(realtime.addEventListener('LIVE_SIGNAL', onSignal));
    cleanups.push(realtime.addEventListener('LIVE_COMMENT', onLiveComment));
    cleanups.push(realtime.addEventListener('LIVE_HEART', onHeart));
    cleanups.push(realtime.addEventListener('EFFECT_TRIGGER', onEffect));
    cleanups.push(realtime.addEventListener('MODERATION', onModeration));

    // Sincroniza o contador inicial pelo backend
    const viewers = await api.get(`/api/live/${state.room.id}/viewers`).catch(() => null);
    if (viewers) {
      state.viewerCount = viewers.viewerCount;
      renderTop();
    }
  };

  // Limpeza ao sair da tela (rotas, botoes do navegador)
  const onBeforeUnload = () => { teardown('unload'); };
  window.addEventListener('beforeunload', onBeforeUnload);
  cleanups.push(() => window.removeEventListener('beforeunload', onBeforeUnload));

  // `ready` resolve quando o boot termina (com sucesso ou com a mensagem de
  // erro ja exibida na tela). Sem isso a checagem do `room` logo apos a
  // criacao do host era sempre falsa, porque a sala e criada em async.
  const ready = boot();

  // Heartbeat de presenca do host: enquanto o anfitriao esta na tela da LIVE,
  // envia um sinal periodico ao servidor. Se o host sair da tela (navegar para
  // outra pagina, fechar a aba, perder conexao), o heartbeat para e o
  // servidor encerra a LIVE apos 60s. Se voltar antes, o heartbeat renovado
  // cancela o encerramento pendente.
  const HEARTBEAT_INTERVAL_MS = 10_000; // 10s << 60s de timeout
  let heartbeatTimer = null;

  function startHeartbeat() {
    if (heartbeatTimer) return; // nao duplicar
    const roomId = state.room?.id;
    if (!roomId) return;
    heartbeatTimer = setInterval(() => {
      if (!realtime.isAuthenticated()) return;
      realtime.publish('LIVE_HOST_HEARTBEAT', { roomId });
    }, HEARTBEAT_INTERVAL_MS);
    heartbeatTimer.unref?.();
  }

  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  // Inicia o heartbeat quando a sala esta pronta.
  ready.then(startHeartbeat).catch(() => {});
  // Para o heartbeat ao sair da tela (destroy e cleanup).
  cleanups.push(stopHeartbeat);

  return {
    element: page,
    ready,
    async destroy() {
      stopHeartbeat();
      await teardown('left');
    },
    get room() { return state.room; },
  };
}
