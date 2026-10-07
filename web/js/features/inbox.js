/** Inbox: lista de conversas 1:1, chat global e historico. */
import { el, formatTime } from '../core/dom.js';
import { toastError, emptyState } from '../core/ui.js';
import { store } from '../core/store.js';
import { navigate } from '../core/router.js';
import { observarViewport } from '../core/viewport.js';
import { listConversations, createConversationThread, getConversation } from './messaging.js';
import { refreshCounts } from '../core/store.js';

export function createInboxScreen({ conversationId = null } = {}) {
  const page = el('div', { class: 'page inbox-page', style: { padding: '0', maxWidth: 'none' } });
  let thread = null;
  let chat = null;
  let conversationList = null;
  let pararViewport = null;

  const listHost = el('div', { class: 'chat-list' });
  const threadHost = el('div', { class: 'grow', style: { display: 'flex', minWidth: '0' } });
  const layout = el('div', { class: 'chat-layout' }, [listHost, threadHost]);

  const header = el('div', { class: 'row', style: { padding: '10px 14px', borderBottom: '1px solid var(--line)' } }, [
    el('h1', { class: 'grow', style: { fontSize: '17px', margin: '0' }, text: 'Inbox' }),
    el('a', { class: 'btn btn-sm btn-ghost', href: '/chat-global', 'data-link': true, text: 'Chat global' }),
  ]);

  page.append(header, layout);

  const renderList = async () => {
    const conversations = await listConversations().catch(() => []);
    listHost.replaceChildren();
    if (!conversations.length) {
      listHost.append(emptyState({
        iconName: 'inbox',
        title: 'Nenhuma conversa',
        message: 'Abra um perfil e toque em "Mensagem" para comecar.',
        action: el('a', { class: 'btn btn-primary mt', href: '/busca', 'data-link': true, text: 'Buscar pessoas' }),
      }));
      return;
    }
    const list = el('div', { role: 'list' });
    for (const conversation of conversations) {
      const participant = conversation.participant;
      list.append(el('button', {
        type: 'button',
        class: 'list-item',
        role: 'listitem',
        style: {
          width: '100%', textAlign: 'left', cursor: 'pointer',
          background: conversation.id === conversationId ? 'var(--bg-elev-2)' : 'var(--bg-elev)',
        },
        onClick: () => navigate(`/inbox/${conversation.id}`),
      }, [
        el('div', { class: 'avatar' }, [
          participant?.avatarUrl
            ? el('img', { src: participant.avatarUrl, alt: '', loading: 'lazy' })
            : el('div', { class: 'avatar' }),
        ]),
        el('div', { class: 'grow' }, [
          el('div', { class: 'row' }, [
            el('span', { class: 'strong truncate grow', text: participant?.displayName || '' }),
            conversation.lastMessage
              ? el('span', { class: 'tiny faint', text: formatTime(conversation.lastMessage.createdAt) })
              : null,
          ]),
          el('div', { class: 'small truncate faint', text: previewOf(conversation.lastMessage) }),
        ]),
        conversation.unread > 0 ? el('span', { class: 'badge', text: String(conversation.unread) }) : null,
      ]));
    }
    listHost.append(list);
  };

  const previewOf = (message) => {
    if (!message) return 'Sem mensagens ainda';
    const prefix = message.senderId === store.user?.id ? 'Voce: ' : '';
    if (message.body) return `${prefix}${message.body}`;
    return `${prefix}[${message.type}]`;
  };

  const openThread = async (id) => {
    thread?.destroy();
    threadHost.replaceChildren();
    try {
      const data = await getConversation(id, { limit: 50 });
      thread = createConversationThread({
        conversationId: id,
        participant: data.conversation.participant,
        onBack: () => navigate('/inbox'),
      });
      threadHost.append(thread.element);
      await thread.load();
      refreshCounts().catch(() => {});
      renderList().catch(() => {});
    } catch (err) {
      toastError(err);
      navigate('/inbox');
    }
  };

  return {
    element: page,
    async load() {
      // Item 30: a altura passa a ser a da viewport VISIVEL (teclado incluso),
      // publicada em `--chat-vh`. Sem isso o campo de mensagem ficava abaixo
      // do teclado e o documento rolava, revelando o fundo preto.
      pararViewport = observarViewport(page, { prefix: 'chat', comTeclado: true });
      await renderList();
      if (conversationId) await openThread(conversationId);
    },
    destroy() {
      pararViewport();
      pararViewport = null;
      thread?.destroy();
      chat?.destroy();
      page.replaceChildren();
      page.remove();
    },
  };
}
