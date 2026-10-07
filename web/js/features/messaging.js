/**
 * Mensagens: conversas 1:1 e chat global.
 * Realtime (fonte primaria) + REST (paginacao). Sem duplicidade: as mensagens
 * recebidas por WS sao cacheadas por id.
 */
import { api } from '../core/api.js';
import { el, icon, formatTime } from '../core/dom.js';
import { toastError } from '../core/ui.js';
import { realtime } from '../core/realtime.js';
import { store } from '../core/store.js';
import { createEmojiPanel, anchorToViewport } from './emoji.js';
import { createGifPanel } from './gifs.js';
import { VoiceRecorder, formatMs } from './voice.js';
import { mediaBubble } from './audio-bubble.js';
import { observarViewport } from '../core/viewport.js';

const messageCache = new Map();
const pendingByClientEvent = new Map();

export async function unreadMessages() {
  const result = await api.get('/api/conversations');
  return (result.conversations || []).reduce((acc, c) => acc + (c.unread || 0), 0);
}

export async function listConversations() {
  const result = await api.get('/api/conversations');
  return result.conversations || [];
}

export async function openConversationWith(userId) {
  const result = await api.post('/api/conversations', { userId });
  return result.conversationId;
}

export async function getConversation(conversationId, { before = null, limit = 50 } = {}) {
  const result = await api.get(`/api/conversations/${conversationId}`, { query: { limit, before: before || undefined } });
  for (const message of result.messages || []) messageCache.set(message.id, message);
  return result;
}

export async function sendMessage(conversationId, payload) {
  const clientEventId = payload.clientEventId || `c_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const optimistic = {
    id: `pending_${clientEventId}`,
    conversationId,
    type: payload.type || 'text',
    text: payload.body || '',
    senderId: store.user?.id,
    isMine: true,
    author: store.user,
    createdAt: Date.now(),
    status: 'sending',
    media: payload.media || null,
    repost: payload.repost || null,
    clientEventId,
  };
  messageCache.set(optimistic.id, optimistic);
  pendingByClientEvent.set(clientEventId, optimistic.id);

  try {
    if (realtime.isOpen()) {
      // Via realtime: o backend valida, persiste e devolve o evento.
      realtime.publish('DM_MESSAGE', {
        conversationId,
        messageType: payload.type || 'text',
        body: payload.body || '',
        mediaId: payload.mediaId || null,
        repostPostId: payload.repostPostId || null,
        replyToId: payload.replyToId || null,
        clientEventId,
      });
      return optimistic;
    }
    const result = await api.post(`/api/conversations/${conversationId}/messages`, {
      ...payload,
      clientEventId,
    });
    messageCache.delete(optimistic.id);
    messageCache.set(result.message.id, result.message);
    return result.message;
  } catch (err) {
    messageCache.delete(optimistic.id);
    optimistic.status = 'failed';
    throw err;
  }
}

export function cacheMessage(message) {
  if (!message?.id) return;
  // Substitui a mensagem otimista correspondente
  if (message.clientEventId && pendingByClientEvent.has(message.clientEventId)) {
    const pendingId = pendingByClientEvent.get(message.clientEventId);
    messageCache.delete(pendingId);
    pendingByClientEvent.delete(message.clientEventId);
  }
  messageCache.set(message.id, message);
}

export function getCachedMessage(id) {
  return messageCache.get(id);
}

export async function markRead(conversationId) {
  if (realtime.isOpen()) {
    realtime.publish('DM_READ', { conversationId });
    return;
  }
  await api.post(`/api/conversations/${conversationId}/read`, {});
}

export async function uploadChatFile(file, purpose, onProgress) {
  const { promise } = api.upload(`/api/chat/upload?purpose=${purpose}`, { file, onProgress });
  const result = await promise;
  return result.media;
}

export function messageTypeForFile(file) {
  if (file.type.startsWith('image/')) return 'image';
  if (file.type.startsWith('video/')) return 'video';
  if (file.type.startsWith('audio/')) return 'audio';
  return 'file';
}

// --------------------------------------------------------------------------
// Compositor reutilizavel (mensagem + gravador + emoji + gif)
// --------------------------------------------------------------------------
export function createComposer({
  placeholder = 'Digite...',
  onSend,
  onTyping = null,
  disabled = false,
  enableVoice = true,
  enableAttachments = true,
  enableGif = true,
  enableEmoji = true,
} = {}) {
  const wrap = el('div', { class: 'row', style: { alignItems: 'flex-end', gap: '6px', width: '100%' } });
  const field = el('textarea', {
    class: 'grow',
    rows: '1',
    placeholder,
    'aria-label': placeholder,
    maxlength: '4000',
    style: { maxHeight: '110px', minHeight: '40px' },
  });
  const sendBtn = el('button', { type: 'button', class: 'btn btn-primary', 'aria-label': 'Enviar mensagem', disabled: true }, [icon('send')]);
  const emojiBtn = el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Emojis' }, [icon('smile')]);
  const gifBtn = el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'GIFs e stickers' }, [icon('gif')]);
  const attachBtn = el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Anexar arquivo' }, [icon('plus')]);
  const micBtn = el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Gravar audio' }, [icon('mic')]);

  let picker = null;
  let fileInput = null;
  let recording = null;
  let recorderState = null;
  const cleanups = [];

  const autoGrow = () => {
    field.style.height = 'auto';
    field.style.height = `${Math.min(110, field.scrollHeight)}px`;
  };

  const updateSend = () => {
    const hasText = field.value.trim().length > 0;
    sendBtn.disabled = disabled || !hasText;
  };

  const closePicker = () => {
    if (picker) {
      picker.destroy();
      picker = null;
    }
  };

  const submit = async () => {
    const body = field.value.trim();
    if (!body) return;
    field.value = '';
    autoGrow();
    updateSend();
    try {
      await onSend?.({ type: 'text', body });
    } catch (err) {
      field.value = body;
      autoGrow();
      updateSend();
      throw err;
    }
  };

  sendBtn.addEventListener('click', () => submit().catch(toastError));

  field.addEventListener('input', () => {
    autoGrow();
    updateSend();
    if (onTyping) onTyping(field.value);
  });
  field.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      submit().catch(toastError);
    }
  });

  if (enableEmoji) {
    emojiBtn.addEventListener('click', () => {
      if (picker) { closePicker(); return; }
      const panel = createEmojiPanel(field);
      // Guarda o destroy ORIGINAL antes de sobrescrever: `picker === panel`,
      // entao chamar `panel.destroy()` de dentro do novo destroy chamava a si
      // mesmo em recursao infinita ("Maximum call stack size exceeded") e o
      // painel nunca saia da tela.
      const destroyPanel = panel.destroy;
      picker = panel;
      const host = el('div', { style: { position: 'static' } }, [panel.element]);
      wrap.parentElement?.append(host);
      // Ancora dentro da viewport: em containers baixos a folha de comentarios
      // empurrava o painel para fora da tela.
      const unanchor = anchorToViewport(panel.element, emojiBtn);
      picker.destroy = () => {
        unanchor();
        destroyPanel.call(panel);
        host.remove();
        picker = null;
      };
      setTimeout(() => field.focus(), 20);
    });
  }

  if (enableGif) {
    gifBtn.addEventListener('click', () => {
      if (picker) { closePicker(); return; }
      const panel = createGifPanel({
        onPick: (item) => {
          closePicker();
          onSend?.({ type: 'gif', gif: item }).catch(toastError);
          field.focus();
        },
      });
      // Mesma armadilha do painel de emojis: sem guardar o destroy original,
      // escolher um GIF estourava a pilha e a mensagem nunca era enviada.
      const destroyPanel = panel.destroy;
      picker = panel;
      const host = el('div', { style: { position: 'static' } }, [panel.element]);
      wrap.parentElement?.append(host);
      const unanchor = anchorToViewport(panel.element, gifBtn);
      picker.destroy = () => {
        unanchor();
        destroyPanel.call(panel);
        host.remove();
        picker = null;
      };
    });
  }

  if (enableAttachments) {
    attachBtn.addEventListener('click', () => {
      if (picker) { closePicker(); return; }

      // O `<input type="file">` e do CONVERSOR (criado uma vez), nao de cada
      // abertura: assim o seletor de arquivos do sistema e reaproveitado e o
      // mesmo input serve o chat privado e o global.
      if (!fileInput) {
        fileInput = el('input', {
          type: 'file',
          style: { display: 'none' },
          'aria-hidden': 'true',
        });
        wrap.append(fileInput);
      }
      fileInput.value = '';

      const lista = el('div', { class: 'picker-panel picker-panel-menu', role: 'menu' });
      // `accept` reflete o que o item realmente envia: e o que decide o
      // filtro do seletor de arquivos do sistema.
      for (const [label, purpose, accept] of [
        ['Imagem', 'image', 'image/*'],
        ['Video', 'video', 'video/*'],
        ['Audio', 'audio', 'audio/*'],
        ['Arquivo', 'file', '.pdf,.txt,.zip,.csv,.json,.doc,.docx'],
      ]) {
        lista.append(el('button', {
          type: 'button',
          class: 'menu-item',
          role: 'menuitem',
          onClick: () => {
            fileInput.accept = accept;
            // Fecha o menu ANTES de abrir o seletor do sistema: deixar o painel
            // aberto escondia o dialogo e, em alguns navegadores, o clique
            // sintetico era engolido.
            closePicker();
            fileInput.click();
          },
        }, [el('span', { text: label })]));
      }

      // CAUSA RAIZ do item 1/2: o painel era posicionado com
      // `position: absolute; bottom: 100%` dentro de um host pendurado no PAI do
      // composer. O pai nao e o composer, entao `100%` media a altura do
      // container inteiro e o painel abria ACIMA da tela (medido em 320/390:
      // `top = -221px`), invisivel e inutil - por isso "os botoes de anexar nao
      // funcionam". Agora o painel usa o MESMO `anchorToViewport` do seletor de
      // emoji/GIF, que conhece a viewport visivel, o teclado e o espaco acima e
      // abaixo do botao.
      const painel = el('div', { class: 'picker-panel-wrap' }, [lista]);
      document.body.append(painel);
      const unanchor = anchorToViewport(painel, attachBtn);
      const fechar = () => {
        unanchor();
        painel.remove();
      };
      // Clique fora / Esc fecham, como nos outros seletores.
      const noClique = (event) => {
        if (!painel.isConnected) return;
        if (painel.contains(event.target) || attachBtn.contains(event.target)) return;
        fechar();
      };
      const naTecla = (event) => {
        if (event.key === 'Escape') fechar();
      };
      setTimeout(() => {
        document.addEventListener('pointerdown', noClique);
        document.addEventListener('keydown', naTecla);
      }, 0);
      picker = {
        destroy: () => {
          document.removeEventListener('pointerdown', noClique);
          document.removeEventListener('keydown', naTecla);
          fechar();
          picker = null;
        },
      };

      fileInput.addEventListener('change', async () => {
        const file = fileInput.files?.[0];
        closePicker();
        if (!file) return;
        try {
          const purpose = messageTypeForFile(file);
          const media = await uploadChatFile(file, purpose, () => {});
          await onSend?.({ type: purpose, mediaId: media.id, body: '' });
        } catch (err) {
          toastError(err);
        }
      }, { once: true });
    });
  }

  if (enableVoice) {
    micBtn.addEventListener('click', async () => {
      if (recording) return;
      if (!VoiceRecorder.isSupported()) {
        toastError(new Error('Gravacao de audio nao suportada neste navegador'));
        return;
      }
      const previewHost = el('div', { class: 'row', style: { width: '100%', gap: '8px' } });
      const timerLabel = el('span', { class: 'rec-indicator', text: '0:00' });
      const stopBtn = el('button', { type: 'button', class: 'btn btn-sm btn-solid', text: 'Enviar' });
      const cancelBtn = el('button', { type: 'button', class: 'btn btn-sm btn-ghost', text: 'Cancelar' });

      recording = new VoiceRecorder({
        onTick: (ms) => { timerLabel.textContent = formatMs(ms); },
        onError: (err) => {
          cleanupRecording();
          toastError(err);
        },
      });

      const cleanupRecording = () => {
        recording?.dispose();
        recording = null;
        recorderState?.remove();
        recorderState = null;
        micBtn.replaceChildren(icon('mic'));
        cleanups.splice(0).forEach((fn) => fn());
      };

      recorderState = previewHost;
      previewHost.append(
        el('span', { class: 'small faint', text: 'Gravando' }),
        timerLabel,
        stopBtn,
        cancelBtn,
      );
      const composerHost = field.closest('.composer') || field.parentElement;
      composerHost?.parentElement?.insertBefore(previewHost, composerHost);

      cancelBtn.addEventListener('click', () => cleanupRecording());
      stopBtn.addEventListener('click', async () => {
        stopBtn.disabled = true;
        try {
          recording.stop();
          await new Promise((resolve) => setTimeout(resolve, 350));
          const blob = recording.blob;
          if (!blob) throw new Error('Nada foi gravado');
          const file = new File([blob], `audio-${Date.now()}.webm`, { type: blob.type });
          const media = await uploadChatFile(file, 'audio', () => {});
          cleanupRecording();
          await onSend?.({ type: 'audio', mediaId: media.id, body: '' });
        } catch (err) {
          cleanupRecording();
          toastError(err);
        }
      });

      try {
        await recording.start();
        micBtn.replaceChildren(icon('pause'));
      } catch {
        cleanupRecording();
      }
    });
  }

  const composer = el('div', { class: 'composer' }, [
    enableAttachments ? attachBtn : null,
    field,
    enableEmoji ? emojiBtn : null,
    enableGif ? gifBtn : null,
    enableVoice ? micBtn : null,
    sendBtn,
  ]);
  wrap.append(composer);

  updateSend();

  return {
    element: wrap,
    textarea: field,
    focus: () => field.focus(),
    setDisabled(value) {
      disabled = value;
      field.disabled = value;
      updateSend();
    },
    setValue(text) { field.value = text; autoGrow(); updateSend(); },
    reset() {
      field.value = '';
      autoGrow();
      updateSend();
      closePicker();
    },
    destroy() {
      closePicker();
      // O `<input type="file">` mora dentro de `wrap`, que sai da tela aqui.
      fileInput = null;
      recording?.dispose();
      cleanups.splice(0).forEach((fn) => fn());
      wrap.replaceChildren();
      wrap.remove();
    },
  };
}

/** Renderiza uma bolha de mensagem. */
/**
 * Marca o agrupamento visual de mensagens consecutivas do MESMO remetente.
 *
 * A comparacao e feita pelo ID do autor em `dataset.autorId` - nunca pelo
 * texto, pela posicao ou por "a ultima que eu desenhei". Isso garante que a
 * mensagem seguinte de outra pessoa sempre quebre o grupo, mesmo depois de
 * recarregar o historico ou receber por realtime.
 */
export function aplicarGrupos(container) {
  const nodes = [...container.querySelectorAll(':scope > .msg')];
  nodes.forEach((node, i) => {
    const anterior = nodes[i - 1];
    const mesmoAutor = Boolean(anterior)
      && anterior.dataset.autorId === node.dataset.autorId
      && anterior.dataset.autorId;
    node.classList.toggle('msg-agrupo', Boolean(mesmoAutor));
    // A hora so aparece na ultima mensagem do grupo: repetir a mesma hora em
    // cada linha polui a leitura sem acrescentar informacao. O estado de
    // entrega continua visivel - so a HORA some.
    const hora = node.querySelector('.msg-hora');
    if (hora) hora.hidden = Boolean(mesmoAutor);
  });
  return nodes.length;
}

export function renderMessage(message, { onDelete = null, onReply = null, onRetry = null } = {}) {
  if (!message) return null;

  const bubble = el('div', { class: 'msg-bubble' });
  // Item 4: o LADO e decidido pelo ID do remetente logado, nunca pelo texto,
  // pela posicao na lista ou pela ordem. O servidor ja manda `isMine`
  // (comparando `sender_id` com o id da sessao), mas a comparacao local e
  // repetida aqui para que nenhuma queda de `isMine` (mensagem otimista ainda
  // nao confirmada, por exemplo) coloque a mensagem no lado errado.
  const meuId = store.user?.id || null;
  const mine = message.isMine === true
    || (message.isMine === undefined && Boolean(meuId) && message.senderId === meuId);

  if (message.replyTo) {
    bubble.append(el('div', { class: 'msg-reply' }, [
      el('div', { class: 'strong', text: `@${message.replyTo.author?.username || ''}` }),
      el('div', { text: message.replyTo.text?.slice(0, 120) || `[${message.replyTo.type}]` }),
    ]));
  }

  if (message.deleted) {
    bubble.append(el('span', { class: 'msg-deleted', text: 'Mensagem apagada' }));
  } else {
    if (message.media) {
      const { url, kind, mime } = message.media;
      if (kind === 'image' || message.type === 'gif') {
        bubble.append(el('div', { class: 'msg-media' }, [
          el('img', { src: url, alt: message.media.originalName || 'Imagem', loading: 'lazy' }),
        ]));
      } else if (kind === 'video') {
        bubble.append(el('div', { class: 'msg-media' }, [
          el('video', { src: url, controls: true, playsinline: true, preload: 'metadata', 'aria-label': 'Video' }),
        ]));
      } else if (kind === 'audio') {
        // Item 7: a duracao real do audio aparece na propria bolha.
        bubble.append(mediaBubble({
          url,
          label: 'Audio da mensagem',
          durationMs: message.media.durationMs,
          downloadUrl: message.media.downloadUrl || null,
        }));
      } else {
        bubble.append(el('a', { href: url, download: message.media.originalName || 'arquivo', class: 'row small' }, [
          icon('download'),
          el('span', { text: message.media.originalName || 'Arquivo' }),
        ]));
      }
    }

    if (message.repost) {
      bubble.append(el('div', { class: 'card', style: { padding: '8px', marginBottom: '6px' } }, [
        el('div', { class: 'row small', style: { gap: '6px' } }, [
          el('img', {
            src: message.repost.author?.avatarUrl || '',
            alt: '',
            width: '20', height: '20',
            style: { borderRadius: '50%', background: 'var(--bg-elev-2)' },
            onError: (e) => { e.currentTarget.style.visibility = 'hidden'; },
          }),
          el('span', { class: 'strong', text: `@${message.repost.author?.username || ''}` }),
        ]),
        message.repost.caption ? el('div', { class: 'small clamp-2', text: message.repost.caption }) : null,
      ]));
    }

    if (message.effect) {
      bubble.append(el('div', { class: 'small', text: `${message.effect.emoji} ${message.effect.name}` }));
    }

    if (message.text) bubble.append(el('span', { text: message.text }));

    // A hora vai em um no proprio (`.msg-hora`) porque o agrupamento esconde
    // SO a hora das mensagens que nao fecham um grupo. O estado de entrega
    // ("enviado"/"lido") fica sempre visivel - e informacao que o usuario
    // precisa, nao decoracao.
    const meta = el('div', { class: 'msg-time' }, [
      el('span', { class: 'msg-hora', text: formatTime(message.createdAt) }),
    ]);
    if (mine) {
      const stateLabel = {
        sending: 'enviando',
        sent: 'enviado',
        delivered: 'entregue',
        read: 'lido',
        failed: 'falhou',
      }[message.status] || message.status;
      meta.append(el('span', { class: 'msg-state', text: stateLabel }));
    }
    bubble.append(meta);
  }

  const node = el('div', {
    class: `msg ${mine ? 'mine' : ''}`,
    // O agrupamento e decidido pelo ID do AUTOR (nao pelo texto nem pela ordem):
    // `msg-agrupo` = "esta mensagem continua a anterior do mesmo remetente".
    dataset: { messageId: message.id, autorId: message.senderId || (mine ? 'eu' : '') },
  }, [
    !mine && el('div', { class: 'avatar sm' }, [
      message.author?.avatarUrl
        ? el('img', { src: message.author.avatarUrl, alt: '', loading: 'lazy', onError: (e) => { e.currentTarget.replaceWith(el('div', { class: 'avatar sm' })); } })
        : el('div', { class: 'avatar sm' }),
    ]),
    bubble,
  ]);

  if (onDelete || onReply) {
    node.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      buildMessageMenu(message, { onDelete, onReply, onRetry });
    });
  }

  return node;
}

function buildMessageMenu(message, { onDelete, onReply, onRetry }) {
  import('../core/ui.js').then(({ openMenu }) => {
    openMenu([
      onReply ? { label: 'Responder', icon: 'comment', onClick: () => onReply(message) } : null,
      onDelete && message.isMine ? {
        label: 'Apagar mensagem',
        icon: 'trash',
        danger: true,
        onClick: () => onDelete(message),
      } : null,
      onRetry && message.status === 'failed' ? {
        label: 'Reenviar',
        icon: 'refresh',
        onClick: () => onRetry(message),
      } : null,
    ]);
  });
}

/** Thread de conversa (1:1). */
export function createConversationThread({ conversationId, participant, onBack = null }) {
  const body = el('div', { class: 'chat-thread-body', role: 'log', 'aria-live': 'polite' });
  const head = el('div', { class: 'chat-thread-head' }, [
    onBack ? el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Voltar', onClick: onBack }, [icon('chevronLeft')]) : null,
    el('div', { class: 'avatar sm' }, [
      participant?.avatarUrl
        ? el('img', { src: participant.avatarUrl, alt: '', onError: (e) => { e.currentTarget.replaceWith(el('div', { class: 'avatar sm' })); } })
        : el('div', { class: 'avatar sm' }),
    ]),
    el('div', { class: 'grow' }, [
      el('div', { class: 'strong small', text: participant?.displayName || '' }),
      el('div', { class: 'tiny faint', text: `@${participant?.username || ''}` }),
    ]),
  ]);

  const composer = createComposer({
    // Placeholder curto de proposito: o campo comeca com UMA linha, e um texto
// longo era cortado no meio da palavra em 320/360px. Quem e o destinatario ja
// esta no cabecalho da conversa, logo o nome aqui e redundante.
placeholder: 'Mensagem',
    onSend: async (payload) => {
      if (payload.gif) {
        const media = await uploadGif(payload.gif);
        return sendMessage(conversationId, { type: 'gif', mediaId: media.id, body: '' });
      }
      return sendMessage(conversationId, payload);
    },
  });

  const foot = el('div', { class: 'chat-foot' }, [composer.element]);
  const thread = el('div', { class: 'chat-thread open' }, [head, body, foot]);

  const seen = new Set();
  let loadingOlder = false;

  const appendMessage = (message, { scroll = true } = {}) => {
    if (!message || seen.has(message.id)) return;
    seen.add(message.id);
    const nearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 140;
    body.append(renderMessage(message, {
      onDelete: async (target) => {
        try {
          await api.delete(`/api/messages/${target.id}`);
          const node = body.querySelector(`[data-message-id="${CSS.escape(target.id)}"]`);
          if (node) {
            node.querySelector('.msg-bubble').replaceChildren(
              el('span', { class: 'msg-deleted', text: 'Mensagem apagada' }),
            );
          }
        } catch (err) { toastError(err); }
      },
      onReply: (target) => {
        composer.setValue(`@${target.author?.username || ''} `);
        composer.focus();
      },
    }));
    aplicarGrupos(body);
    if (scroll || nearBottom) scrollToBottom();
  };

  const scrollToBottom = () => {
    requestAnimationFrame(() => { body.scrollTop = body.scrollHeight; });
  };

  const onScroll = async () => {
    if (loadingOlder || body.scrollTop > 60) return;
    loadingOlder = true;
    const firstId = [...seen][0];
    if (!firstId) { loadingOlder = false; return; }
    try {
      const oldest = getCachedMessage(firstId);
      const data = await api.get(`/api/conversations/${conversationId}/messages`, {
        query: { before: oldest?.createdAt, limit: 40 },
      });
      const nodes = [];
      for (const message of data.messages || []) {
        if (seen.has(message.id)) continue;
        seen.add(message.id);
        nodes.push(renderMessage(message));
      }
      if (nodes.length) {
        const previousHeight = body.scrollHeight;
        body.prepend(...nodes);
        aplicarGrupos(body);
        body.scrollTop = body.scrollHeight - previousHeight;
      }
    } catch { /* silencioso: paginacao antiga */ } finally {
      loadingOlder = false;
    }
  };
  body.addEventListener('scroll', onScroll);

  const onMessage = (event) => {
    const { message } = event.detail || {};
    if (!message) return;
    if (message.conversationId && message.conversationId !== conversationId) return;
    appendMessage(message);
  };
  const onDelete = (event) => {
    const detail = event.detail || {};
    if (detail.deleted && detail.conversationId === conversationId) {
      const node = body.querySelector(`[data-message-id="${CSS.escape(detail.id)}"]`);
      if (node) node.querySelector('.msg-bubble').replaceChildren(el('span', { class: 'msg-deleted', text: 'Mensagem apagada' }));
    }
  };

  const cleanup = [];
  cleanup.push(realtime.addEventListener('MESSAGE', onMessage));
  cleanup.push(realtime.addEventListener('MESSAGE', onDelete));
  cleanup.push(markRead(conversationId).catch(() => {}));
  const readTimer = setInterval(() => markRead(conversationId).catch(() => {}), 25_000);

  scrollToBottom();

  return {
    element: thread,
    async load() {
      const data = await getConversation(conversationId);
      body.replaceChildren();
      seen.clear();
      for (const message of data.messages) appendMessage(message, { scroll: false });
      scrollToBottom();
      return data;
    },
    appendMessage,
    destroy() {
      clearInterval(readTimer);
      cleanup.forEach((fn) => fn());
      composer.destroy();
      body.removeEventListener('scroll', onScroll);
      thread.replaceChildren();
      thread.remove();
    },
  };
}

async function uploadGif(gif) {
  // O GIF do GIPHY e baixado pelo servidor? Nao: o cliente envia a URL.
  // Para manter tudo dentro da plataforma, o servidor cria a midia a partir
  // da URL oficial do GIPHY (proxy + persistencia).
  const result = await api.post('/api/chat/gif', {
    url: gif.downsizedUrl || gif.url,
    previewUrl: gif.previewUrl,
    title: gif.title,
  });
  return result.media;
}

/** Chat global com contador de online (contagem, nunca lista de nomes). */
export function createGlobalChat({ onYouTube = null } = {}) {
  const feed = el('div', { class: 'global-feed', role: 'log', 'aria-live': 'polite' });
  const onlinePill = el('div', { class: 'online-pill' }, [el('i'), el('span', { text: '—' })]);
  const seen = new Set();
  let onlineCount = 0;

  const head = el('div', { class: 'row', style: { padding: '10px 14px', borderBottom: '1px solid var(--line)', gap: '8px' } }, [
    el('div', { class: 'grow' }, [
      el('div', { class: 'strong', text: 'Chat global' }),
      el('div', { class: 'tiny faint', text: 'Todos os usuarios conectados' }),
    ]),
    onlinePill,
  ]);

  const composer = createComposer({
    // Item 7: o texto do placeholder precisa CABER em uma linha. Com "Mensagem
    // para todos" ele quebrava em duas em 360/390px e a segunda linha ficava
    // cortada dentro do campo (medido na tela). "Para todos" ja diz o bastante
    // - o titulo da tela e "Chat global".
    placeholder: 'Para todos',
    onSend: async (payload) => {
      if (payload.gif) {
        const media = await uploadGif(payload.gif);
        if (realtime.isOpen()) {
          realtime.publish('GLOBAL_CHAT_MESSAGE', { messageType: 'gif', mediaId: media.id, body: '' });
        } else {
          await api.post('/api/chat/global', { type: 'gif', mediaId: media.id, body: '' });
        }
        return null;
      }
      if (realtime.isOpen()) {
        realtime.publish('GLOBAL_CHAT_MESSAGE', {
          messageType: payload.type || 'text',
          body: payload.body || '',
          mediaId: payload.mediaId || null,
          repostPostId: payload.repostPostId || null,
        });
        return null;
      }
      return api.post('/api/chat/global', payload);
    },
  });

  const foot = el('div', { class: 'chat-foot' }, [composer.element]);
  // `chat-page` da altura real (topo + tabbar + safe-area) para o composer
  // ficar visivel e alinhado, sem area vazia sobrando (item 29).
  const container = el('div', { class: 'global-chat chat-page' }, [head, feed, foot]);

  const setOnline = (count) => {
    onlineCount = Number(count) || 0;
    onlinePill.lastChild.textContent = `${onlineCount} online`;
  };

  const appendMessage = (message) => {
    if (!message || seen.has(message.id)) return;
    seen.add(message.id);
    const node = el('div', { class: 'gc-msg' }, [
      el('div', { class: 'avatar xs' }, [
        message.author?.avatarUrl
          ? el('img', { src: message.author.avatarUrl, alt: '', loading: 'lazy', onError: (e) => { e.currentTarget.replaceWith(el('div', { class: 'avatar xs' })); } })
          : el('div', { class: 'avatar xs' }),
      ]),
      el('div', { class: 'grow' }, [
        el('div', { class: 'gc-head' }, [
          el('span', { class: 'gc-name', text: `@${message.author?.username || 'anonimo'}` }),
          el('span', { class: 'gc-time', text: formatTime(message.createdAt) }),
        ]),
        message.deleted
          ? el('div', { class: 'gc-text faint', text: 'Mensagem apagada' })
          : message.text ? el('div', { class: 'gc-text', text: message.text }) : null,
        message.media?.kind === 'image' || message.type === 'gif'
          ? el('div', { class: 'msg-media', style: { marginTop: '6px', maxWidth: '220px' } }, [
            el('img', { src: message.media.url, alt: '', loading: 'lazy' }),
          ])
          : message.media?.kind === 'video'
            ? el('div', { class: 'msg-media', style: { marginTop: '6px', maxWidth: '220px' } }, [
              el('video', { src: message.media.url, controls: true, playsinline: true, preload: 'metadata' }),
            ])
            : message.media?.kind === 'audio'
              ? el('div', { class: 'msg-audio', style: { marginTop: '6px' } }, [
                mediaBubble({
                  url: message.media.url,
                  label: 'Audio da mensagem',
                  durationMs: message.media.durationMs,
                  downloadUrl: message.media.downloadUrl || null,
                }),
              ])
              : message.media
                ? el('a', { href: message.media.url, download: message.media.originalName || 'arquivo', class: 'row small' }, [
                  icon('download'), el('span', { text: message.media.originalName || 'Arquivo' }),
                ])
                : null,
      ]),
    ]);
    const nearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 160;
    feed.append(node);
    aplicarGrupos(feed);
    // Historico limitado na tela (memoria); o banco guarda tudo
    while (feed.children.length > 120) feed.firstChild.remove();
    if (nearBottom) requestAnimationFrame(() => { feed.scrollTop = feed.scrollHeight; });
  };

  const onMessage = (event) => {
    const { message } = event.detail || {};
    appendMessage(message);
  };
  const onPresence = (event) => {
    const { onlineCount: count } = event.detail || {};
    if (typeof count === 'number') setOnline(count);
  };

  const cleanups = [];
  cleanups.push(realtime.addEventListener('GLOBAL_CHAT_MESSAGE', onMessage));
  cleanups.push(realtime.addEventListener('PRESENCE', onPresence));

  return {
    element: container,
    async load() {
      // Item 30: mesma leitura de viewport do inbox (modulo unico), para o
      // teclado encolher a area de mensagens em vez de empurrar o documento.
      cleanups.push(observarViewport(container, { prefix: 'chat', comTeclado: true }));
      const data = await api.get('/api/chat/global', { query: { limit: 50 } });
      feed.replaceChildren();
      seen.clear();
      for (const message of data.messages) appendMessage(message);
      feed.scrollTop = feed.scrollHeight;
      setOnline(data.onlineCount);
    },
    appendMessage,
    destroy() {
      cleanups.forEach((fn) => fn());
      composer.destroy();
      container.replaceChildren();
      container.remove();
    },
  };
}
