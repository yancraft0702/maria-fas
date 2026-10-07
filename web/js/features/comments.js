/**
 * Comentarios: lista, criacao, resposta, like, exclusao e mencao.
 * Reais: tudo via API; realtime apenas atualiza contadores/likes/exclusoes.
 */
import { api } from '../core/api.js';
import { el, formatCount, formatTime, linkifyText } from '../core/dom.js';
import { openSheet, toastError, confirmDialog } from '../core/ui.js';
import { isLoggedIn } from '../core/store.js';
import { navigate } from '../core/router.js';
import { realtime } from '../core/realtime.js';
import { createComposer } from './messaging.js';
import { mediaBubble } from './audio-bubble.js';

export async function listComments(postId, { sort = 'top', limit = 30, offset = 0, parentId = null } = {}) {
  if (parentId) {
    const result = await api.get(`/api/comments/${parentId}/replies`, { query: { limit, offset } });
    return { comments: result.comments || [], counts: null };
  }
  const result = await api.get(`/api/posts/${postId}/comments`, { query: { sort, limit, offset } });
  return { comments: result.comments || [], counts: result.counts };
}


/**
 * Normaliza o payload de comentario para o formato da API.
 *
 * IMPORTANTE: esta funcao e IDEMPOTENTE de proposito (item 6). Ela roda DUAS
 * vezes no mesmo envio - uma no `onSend` do composer e outra dentro de
 * `createComment`. Na segunda passagem o `payload` ja vem normalizado
 * (`{ type: 'gif', metadata: {...} }`) e nao tem mais `payload.gif`; o `return
 * base` descartava o `metadata`, o backend gravava `type: 'gif'` com
 * `metadata_json = {}` e o comentario aparecia SEM imagem.
 *
 * Por isso um `metadata` ja pronto e preservado.
 */
export function normalizeCommentPayload(payload) {
  if (typeof payload === 'string') return { body: payload, type: 'text' };
  if (!payload) return { body: '', type: 'text' };

  const type = payload.type || 'text';
  const base = { body: (payload.body || '').trim(), type, mediaId: payload.mediaId || null };

  if (type === 'gif' && payload.gif) {
    // `createGifPanel` entrega o item ja normalizado pelo servidor
    // (`giphy.js/mapGif`): `id`, `kind` ('gif'|'sticker'), `url`, `previewUrl`,
    // `downsizedUrl` e `title`.
    const gif = payload.gif;
    return {
      ...base,
      type: gif.kind === 'sticker' ? 'sticker' : 'gif',
      metadata: {
        id: gif.id || null,
        url: gif.downsizedUrl || gif.url || gif.previewUrl || null,
        posterUrl: gif.previewUrl || null,
        title: gif.title || null,
      },
    };
  }

  if (payload.metadata && typeof payload.metadata === 'object') {
    return { ...base, metadata: { ...payload.metadata } };
  }
  return base;
}

/**
 * Cria um comentario.
 *
 * Aceita texto, anexo ou os dois. `payload` pode ser uma string (atalho para
 * texto puro) ou o objeto ja normalizado por `normalizeCommentPayload` - e a
 * funcao e idempotente, entao normalizar duas vezes nao perde o anexo.
 */
export const createComment = (postId, payload, parentId = null) =>
  api.post(`/api/posts/${postId}/comments`, { ...normalizeCommentPayload(payload), parentId });

export const likeComment = (commentId) => api.post(`/api/comments/${commentId}/like`, {});
export const deleteComment = (commentId) => api.delete(`/api/comments/${commentId}`);

/**
 * No do anexo de um comentario. Cada formato tem sua tag - um GIF e uma figurinha
 * sao `<img>` (a URL da GIPHY ja vem otimizada), audio e video usam os players
 * nativos para nao depender de script externo.
 */
function commentMediaNode(comment) {
  const media = comment.media;
  if (!media || !media.url) return null;
  const wrap = el('div', { class: 'comment-media', dataset: { kind: media.kind || 'image' } });

  if (media.kind === 'audio') {
    // Item 8: o audio do comentario mostra a DURACAO REAL, lida do proprio
    // elemento (metadata) e nao de um valor fixo. `--:--` enquanto carrega.
    wrap.append(mediaBubble({
      url: media.url,
      label: 'Audio do comentario',
      durationMs: media.durationMs,
      downloadUrl: media.downloadUrl || null,
    }));
    return wrap;
  }
  if (media.kind === 'video') {
    wrap.append(el('video', {
      src: media.url, controls: true, playsinline: true, preload: 'metadata', 'aria-label': 'Video do comentario',
    }));
    return wrap;
  }
  const img = el('img', {
    src: media.url,
    alt: media.title || (media.kind === 'gif' ? 'GIF' : media.kind === 'sticker' ? 'Figurinha' : 'Imagem'),
    loading: 'lazy',
  });
  // Se a URL externa cair, o comentario continua valido - mas o anexo NAO pode
  // sumir em silencio (item 6): some a imagem quebrada e entra um aviso
  // VISIVEL com o endereco que falhou. Antes o `wrap.remove()` apenas
  // apagava o anexo e o usuario ficava sem entender o que aconteceu.
  img.addEventListener('error', () => {
    img.remove();
    wrap.append(el('p', {
      class: 'media-broken small',
      text: `Nao foi possivel carregar este ${media.kind === 'sticker' ? 'figurinha' : media.kind === 'gif' ? 'GIF' : 'anexo'}.`,
      title: media.url,
    }));
  });
  wrap.append(img);
  return wrap;
}

/**
 * Painel de comentarios (folha). Abre SOMENTE pelo botao de comentarios.
 */
export function openComments(postId, { onCount = null, parentComment = null } = {}) {
  let count = 0;
  let sort = 'top';
  let offset = 0;
  let exhausted = false;
  let loading = false;
  const seen = new Set();
  const cleanups = [];

  const list = el('div', { role: 'list' });
  const summary = el('div', { class: 'center small faint', style: { padding: '8px 0' } });
  const sorter = el('div', { class: 'seg', style: { marginBottom: '10px' } });
  const loadMoreBtn = el('button', { type: 'button', class: 'btn btn-ghost btn-sm btn-block', text: 'Carregar mais', hidden: true });

  const setCount = (value) => {
    count = Number(value) || 0;
    summary.textContent = `${formatCount(count)} comentario${count === 1 ? '' : 's'}`;
    onCount?.(count);
  };

  const close = () => sheet.close();

  const composer = createComposer({
    placeholder: parentComment ? `Responder @${parentComment.author?.username || ''}` : 'Adicionar comentario...',
    onSend: async (payload) => {
      if (!isLoggedIn()) { navigate('/entrar'); return; }
      // O composer entrega `{ type, body }` para texto e `{ type, gif }`,
      // `{ type, mediaId }` ou `{ type, audio, mediaId }` para anexos. Os dois
      // caminhos sao validos: antes so o texto chegava ao backend, e escolher um
      // GIF respondia "Campo obrigatorio".
      const resultado = await createComment(postId, normalizeCommentPayload(payload), parentComment?.id || null);
      const result = resultado;
      setCount(result.counts.comments);
      if (parentComment) {
        // Resposta entra no grupo do comentario pai
        const group = list.querySelector(`[data-comment-id="${CSS.escape(parentComment.id)}"]`);
        if (group) {
          seen.add(result.comment.id);
          group.querySelector('.reply-group')?.append(renderNode(result.comment, 1));
        } else {
          seen.add(result.comment.id);
          list.append(renderNode(result.comment, 0));
        }
      } else {
        if (!seen.has(result.comment.id)) {
          seen.add(result.comment.id);
          list.prepend(renderNode(result.comment, 0));
        }
      }
      if (!parentComment) {
        sort = 'recent';
        renderSorter();
      }
    },
  });

  const renderNode = (comment, depth) => renderCommentNode(comment, {
    depth,
    postId,
    closeSheet: close,
  });

  const renderSorter = () => {
    sorter.replaceChildren();
    for (const [id, label] of [['top', 'Relevantes'], ['recent', 'Recentes'], ['oldest', 'Antigos']]) {
      sorter.append(el('button', {
        type: 'button',
        text: label,
        role: 'tab',
        'aria-selected': String(sort === id),
        onClick: () => {
          sort = id;
          offset = 0;
          exhausted = false;
          renderSorter();
          reload();
        },
      }));
    }
  };

  const openReplies = async (comment) => {
    try {
      const { comments } = await listComments(postId, { parentId: comment.id, limit: 50 });
      const group = list.querySelector(`[data-comment-id="${CSS.escape(comment.id)}"] .reply-group`);
      if (!group) return;
      group.replaceChildren();
      let added = 0;
      for (const reply of comments) {
        if (seen.has(reply.id)) continue;
        seen.add(reply.id);
        group.append(renderNode(reply, 1));
        added += 1;
      }
      if (!added) group.append(el('div', { class: 'tiny faint', text: 'Sem respostas.' }));
    } catch (err) {
      toastError(err);
    }
  };

  const appendWithReplies = (comment) => {
    const node = renderNode(comment, 0);
    const group = el('div', { class: 'col reply-group', style: { gap: '4px', marginTop: '6px', paddingLeft: '12px', borderLeft: '1px solid var(--line)' } });
    for (const reply of comment.replies || []) {
      seen.add(reply.id);
      group.append(renderNode(reply, 1));
    }
    if ((comment.counts?.replies ?? 0) > group.children.length) {
      group.append(el('button', {
        type: 'button', class: 'btn btn-sm btn-ghost', text: 'Ver mais respostas',
        onClick: () => openReplies(comment),
      }));
    }
    if (group.children.length) node.append(group);
    list.append(node);
  };

  const reload = async () => {
    loading = true;
    list.replaceChildren();
    seen.clear();
    loadMoreBtn.hidden = true;
    try {
      const result = await listComments(postId, { sort, limit: 30, offset });
      if (result.counts) setCount(result.counts.comments);
      if (!result.comments.length) {
        list.append(el('div', { class: 'page-empty small', text: 'Seja a primeira pessoa a comentar.' }));
      }
      for (const comment of result.comments) {
        seen.add(comment.id);
        appendWithReplies(comment);
      }
      offset += result.comments.length;
      exhausted = result.comments.length < 30;
      loadMoreBtn.hidden = exhausted;
    } catch (err) {
      list.append(el('div', { class: 'page-empty small', text: err.message }));
    } finally {
      loading = false;
    }
  };

  loadMoreBtn.addEventListener('click', async () => {
    if (loading || exhausted) return;
    loading = true;
    loadMoreBtn.disabled = true;
    try {
      const result = await listComments(postId, { sort, limit: 30, offset });
      for (const comment of result.comments) {
        if (seen.has(comment.id)) continue;
        seen.add(comment.id);
        appendWithReplies(comment);
      }
      offset += result.comments.length;
      exhausted = result.comments.length < 30;
      loadMoreBtn.hidden = exhausted;
    } catch (err) {
      toastError(err);
    } finally {
      loading = false;
      loadMoreBtn.disabled = false;
    }
  });

  // ---- realtime ----
  cleanups.push(realtime.addEventListener('COMMENT', (event) => {
    const detail = event.detail || {};
    if (detail.postId !== postId) return;
    if (detail.comment) {
      if (seen.has(detail.comment.id)) return;
      seen.add(detail.comment.id);
      if (detail.comment.parentId) {
        const group = list.querySelector(`[data-comment-id="${CSS.escape(detail.comment.parentId)}"] .reply-group`);
        if (group) group.append(renderNode(detail.comment, 1));
        else list.append(renderNode(detail.comment, 0));
      } else {
        list.prepend(renderNode(detail.comment, 0));
      }
    } else if (detail.commentId && typeof detail.likeCount === 'number') {
      const node = list.querySelector(`[data-comment-id="${CSS.escape(detail.commentId)}"]`);
      const likeNode = node?.querySelector('[data-comment-like]');
      if (likeNode) {
        likeNode.textContent = formatCount(detail.likeCount);
        const button = likeNode.closest('button');
        button?.setAttribute('aria-pressed', String(Boolean(detail.liked)));
        button?.classList.toggle('on', Boolean(detail.liked));
      }
    }
    if (typeof detail.counts?.comments === 'number') setCount(detail.counts.comments);
  }));

  cleanups.push(realtime.addEventListener('COMMENT_DELETE', (event) => {
    const detail = event.detail || {};
    if (detail.postId !== postId) return;
    const node = list.querySelector(`[data-comment-id="${CSS.escape(detail.commentId)}"]`);
    if (node) {
      const textNode = node.querySelector('.comment-text');
      textNode.textContent = 'Comentario removido';
      textNode.classList.add('comment-deleted');
      node.querySelectorAll('[data-comment-action]').forEach((button) => button.remove());
    }
    if (typeof detail.counts?.comments === 'number') setCount(detail.counts.comments);
  }));

  renderSorter();
  const body = el('div', {}, [sorter, summary, list, loadMoreBtn]);
  const sheet = openSheet({
    title: parentComment ? `Respostas de @${parentComment.author?.username || ''}` : 'Comentarios',
    body,
    footer: isLoggedIn() ? composer.element : el('div', { class: 'center small muted' }, [
      'Faca login para comentar. ',
      el('a', { href: '/entrar', 'data-link': true, text: 'Entrar' }),
    ]),
    onClose: () => {
      cleanups.forEach((fn) => fn());
      composer.destroy();
    },
  });

  reload();
  setTimeout(() => composer.focus(), 140);

  return sheet;
}

function renderCommentNode(comment, { depth = 0, postId, closeSheet }) {
  const likeLabel = el('span', { dataset: { commentLike: '1' }, text: formatCount(comment.counts?.likes ?? 0) });
  const likeBtn = el('button', {
    type: 'button',
    'aria-label': 'Curtir comentario',
    'aria-pressed': String(Boolean(comment.viewerState?.liked)),
    class: comment.viewerState?.liked ? 'on' : '',
    dataset: { commentAction: 'like' },
    onClick: async () => {
      try {
        const result = await likeComment(comment.id);
        likeLabel.textContent = formatCount(result.likeCount);
        likeBtn.setAttribute('aria-pressed', String(result.liked));
        likeBtn.classList.toggle('on', result.liked);
      } catch (err) { toastError(err); }
    },
  }, [likeLabel]);

  const replyBtn = el('button', {
    type: 'button',
    'aria-label': 'Responder',
    dataset: { commentAction: 'reply' },
    onClick: () => openComments(postId, { parentComment: comment }),
  }, [el('span', { text: 'Responder' })]);

  const actions = el('div', { class: 'comment-actions' }, [likeBtn, replyBtn]);

  if (comment.viewerState?.canDelete) {
    actions.append(el('button', {
      type: 'button',
      'aria-label': 'Apagar comentario',
      dataset: { commentAction: 'delete' },
      onClick: async () => {
        const ok = await confirmDialog({
          title: 'Apagar comentario',
          message: 'Esta acao nao pode ser desfeita.',
          confirmLabel: 'Apagar',
          danger: true,
        });
        if (!ok) return;
        try {
          await deleteComment(comment.id);
        } catch (err) { toastError(err); }
      },
    }, [el('span', { text: 'Apagar' })]));
  }

  const textNode = el('div', { class: 'comment-text' });
  if (comment.deleted) {
    textNode.classList.add('comment-deleted');
    textNode.textContent = 'Comentario removido';
  } else {
    if (comment.body) {
      textNode.append(linkifyText(comment.body, {
        onMention: (username) => { closeSheet(); navigate(`/@${username}`); },
        onHashtag: (tag) => { closeSheet(); navigate(`/tag/${tag}`); },
      }));
    }
    // Anexo (itens 15 e 16): GIF, figurinha, imagem, video ou audio. Um
    // comentario pode ser SO o anexo - nesse caso o texto fica vazio e o
    // anexo e o conteudo.
    const anexo = commentMediaNode(comment);
    if (anexo) textNode.append(anexo);
  }

  return el('div', { class: 'comment', dataset: { commentId: comment.id } }, [
    el('div', { class: 'avatar sm' }, [
      comment.author?.avatarUrl
        ? el('img', { src: comment.author.avatarUrl, alt: '', loading: 'lazy', onError: (e) => { e.currentTarget.replaceWith(el('div', { class: 'avatar sm' })); } })
        : el('div', { class: 'avatar sm' }),
    ]),
    el('div', { class: 'comment-body' }, [
      el('a', {
        href: `/@${comment.author?.username || ''}`,
        class: 'comment-name',
        'data-link': true,
        text: `@${comment.author?.username || 'anonimo'}`,
      }),
      textNode,
      el('div', { class: 'tiny faint', text: formatTime(comment.createdAt) }),
      actions,
    ]),
  ]);
}
