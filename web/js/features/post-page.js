/** Pagina de um video (detalhe): player, acoes, comentarios e relacionados. */
import { api } from '../core/api.js';
import { el, icon, formatCount, linkifyText, formatDuration } from '../core/dom.js';
import { createVideo, safePlay, pauseOwnedBy, destroyOwnedBy } from '../core/media.js';
import { store, isLoggedIn } from '../core/store.js';
import { navigate } from '../core/router.js';
import { toastError, toastSuccess, emptyState } from '../core/ui.js';
import { openComments } from './comments.js';
import { mediaBubble } from './audio-bubble.js';
import { openShareMenu, openPostMenu } from './post-menu.js';

export function createPostPage({ postId }) {
  const page = el('div', { class: 'page', style: { maxWidth: '760px' } });
  const host = el('div');
  page.append(host);

  let post = null;
  let video = null;
  let cleanups = [];

  const render = () => {
    host.replaceChildren();
    if (!post) {
      host.append(el('div', { class: 'page-empty' }, [el('div', { class: 'spinner', style: { margin: '0 auto' } })]));
      return;
    }

    // ---- Player ----
    const mediaHost = el('div', {
      style: {
        position: 'relative', background: '#000', borderRadius: '16px',
        overflow: 'hidden', aspectRatio: post.media ? '9 / 16' : '16 / 9',
        maxHeight: '72dvh', margin: '0 auto',
      },
    });

    if (post.type === 'text') {
      mediaHost.append(el('div', {
        style: {
          position: 'absolute', inset: '0', display: 'grid', placeItems: 'center',
          padding: '24px', textAlign: 'center', fontSize: '18px', whiteSpace: 'pre-wrap',
          background: 'linear-gradient(160deg,#1a1a2e,#2d1b3d)',
        },
        text: post.caption || '',
      }));
    } else if (post.media?.kind === 'image') {
      mediaHost.append(el('img', {
        src: post.media.url, alt: post.caption?.slice(0, 80) || 'Foto',
        style: { width: '100%', height: '100%', objectFit: 'contain' },
      }));
    } else if (post.media?.kind === 'audio') {
      // (Item 16) Publicacao so com audio usa o player comum e a duracao real.
      mediaHost.append(el('div', { class: 'slide-audio' }, [
        el('div', { class: 'slide-audio-badge' }, [icon('music'), el('span', { text: 'Audio' })]),
        mediaBubble({
          url: post.media.url,
          label: 'Audio da publicacao',
          durationMs: post.media.durationMs,
        }),
      ]));
    } else if (post.media) {
      if (post.media.status === 'failed') {
        mediaHost.append(el('div', { class: 'live-placeholder' }, [
          icon('warning'),
          el('p', { text: 'Video indisponivel' }),
          el('p', { class: 'tiny faint', text: post.media.error || '' }),
        ]));
      } else {
        video = createVideo({
          src: post.media.normalizedUrl || post.media.url,
          poster: post.media.posterUrl || null,
          loop: true,
          controls: true,
          muted: store.preferences.autoplayMuted !== false,
          ownerId: 'post-page',
        });
        mediaHost.append(video);
        if (post.media.status === 'processing') {
          mediaHost.append(el('div', { class: 'slide-badge-processing' }, [
            el('div', { class: 'spinner' }),
            el('span', { text: 'Processando video…' }),
          ]));
        }
        safePlay(video, { muted: store.preferences.autoplayMuted !== false });
      }
    }

    const authorBlock = el('div', { class: 'row mt' }, [
      el('a', { href: `/@${post.author.username}`, 'data-link': true, class: 'avatar' }, [
        post.author.avatarUrl ? el('img', { src: post.author.avatarUrl, alt: '', loading: 'lazy' }) : el('div', { class: 'avatar' }),
      ]),
      el('div', { class: 'grow' }, [
        el('a', { href: `/@${post.author.username}`, 'data-link': true, class: 'strong', style: { color: 'inherit', textDecoration: 'none' }, text: `@${post.author.username}` }),
        el('div', { class: 'tiny faint', text: post.sound ? `${post.sound.title}` : post.type }),
      ]),
      el('button', {
        type: 'button', class: 'btn btn-sm btn-ghost', 'aria-label': 'Mais opcoes',
        onClick: () => openPostMenu(post, { onChanged: () => navigate('/') }),
      }, [icon('more')]),
    ]);

    const captionNode = el('div', { class: 'mt', style: { whiteSpace: 'pre-wrap', wordBreak: 'break-word' } });
    if (post.caption) {
      captionNode.append(linkifyText(post.caption, {
        onMention: (username) => navigate(`/@${username}`),
        onHashtag: (tag) => navigate(`/tag/${tag}`),
      }));
    }

    const likeLabel = el('span', { text: formatCount(post.counts.likes) });
    const commentLabel = el('span', { text: formatCount(post.counts.comments) });
    const repostLabel = el('span', { text: formatCount(post.counts.reposts) });
    const favoriteLabel = el('span', { text: post.viewerState.favorited ? 'Salvo' : 'Salvar' });

    const actionRow = el('div', { class: 'row row-wrap', style: { marginTop: '12px', gap: '8px' } }, [
      el('button', {
        type: 'button',
        class: `btn ${post.viewerState.liked ? 'btn-solid' : 'btn-ghost'}`,
        // Rotulo acessivel: o conteudo do botao e so um contador, que nao diz
        // qual acao e.
        'aria-label': 'Curtir publicacao',
        'aria-pressed': String(Boolean(post.viewerState.liked)),
        // `botao` e capturado ANTES do await: depois do await,
        // `event.currentTarget` ja e null e o acesso lancava
        // "Cannot read properties of null".
        onClick: async (event) => {
          const botao = event.currentTarget;
          if (!isLoggedIn()) { navigate('/entrar'); return; }
          try {
            const result = await api.post(`/api/posts/${post.id}/like`, {});
            post.viewerState.liked = result.liked;
            post.counts.likes = result.counts.likes;
            likeLabel.textContent = formatCount(result.counts.likes);
            botao.classList.toggle('btn-solid', result.liked);
            botao.classList.toggle('btn-ghost', !result.liked);
            botao.setAttribute('aria-pressed', String(result.liked));
          } catch (err) { toastError(err); }
        },
      }, [icon('heart'), likeLabel]),
      el('button', {
        type: 'button', class: 'btn btn-ghost',
        'aria-label': 'Abrir comentarios',
        onClick: () => openComments(post.id, { onCount: (count) => { commentLabel.textContent = formatCount(count); post.counts.comments = count; } }),
      }, [icon('comment'), commentLabel]),
      el('button', {
        type: 'button', class: `btn ${post.viewerState.reposted ? 'btn-solid' : 'btn-ghost'}`,
        'aria-label': 'Republicar publicacao',
        onClick: async (event) => {
          const botao = event.currentTarget;
          if (!isLoggedIn()) { navigate('/entrar'); return; }
          try {
            const result = post.viewerState.reposted
              ? await api.delete(`/api/posts/${post.id}/repost`)
              : await api.post(`/api/posts/${post.id}/repost`, {});
            post.viewerState.reposted = !post.viewerState.reposted;
            repostLabel.textContent = formatCount(result.counts?.reposts ?? post.counts.reposts);
            botao.classList.toggle('btn-solid', post.viewerState.reposted);
            botao.classList.toggle('btn-ghost', !post.viewerState.reposted);
          } catch (err) { toastError(err); }
        },
      }, [icon('replay'), repostLabel]),
      el('button', {
        type: 'button', class: 'btn btn-ghost',
        onClick: async (event) => {
          if (!isLoggedIn()) { navigate('/entrar'); return; }
          try {
            const result = await api.post(`/api/posts/${post.id}/favorite`, {});
            post.viewerState.favorited = result.favorited;
            favoriteLabel.textContent = result.favorited ? 'Salvo' : 'Salvar';
            event.currentTarget.classList.toggle('btn-solid', result.favorited);
            event.currentTarget.classList.toggle('btn-ghost', !result.favorited);
          } catch (err) { toastError(err); }
        },
      }, [icon('bookmark'), favoriteLabel]),
      el('button', {
        type: 'button', class: 'btn btn-ghost', text: 'Compartilhar',
        onClick: () => openShareMenu(post),
      }),
      post.media && post.media.kind === 'video' ? el('button', {
        type: 'button', class: 'btn btn-ghost', text: 'Abrir no YouTube',
        onClick: async () => {
          const { openMiniPlayer } = await import('./youtube.js');
          const url = prompt('Cole aqui o link do YouTube deste video:');
          if (!url) return;
          try {
            await openMiniPlayer(url, { title: post.caption?.slice(0, 80) || 'Video' });
            toastSuccess('Mini-player aberto (controles oficiais do YouTube)');
          } catch (err) { toastError(err); }
        },
      }) : null,
    ]);

    host.append(
      mediaHost,
      authorBlock,
      post.media?.durationMs ? el('div', { class: 'tiny faint center', text: formatDuration(post.media.durationMs) }) : null,
      captionNode,
      post.hashtags?.length
        ? el('div', { class: 'row row-wrap', style: { marginTop: '10px', gap: '6px' } }, post.hashtags.map((tag) => el('a', {
          class: 'btn btn-sm btn-ghost', href: `/tag/${encodeURIComponent(tag.replace('#', ''))}`, 'data-link': true, text: tag,
        })))
        : null,
      actionRow,
      el('hr', { class: 'divider' }),
    );

    // ---- Comentarios inline ----
    const commentsHost = el('div');
    host.append(commentsHost);
    loadComments(commentsHost);

    // ---- Relacionados ----
    const relatedHost = el('div');
    host.append(el('h2', { style: { fontSize: '15px', margin: '16px 0 8px' }, text: 'Relacionados' }), relatedHost);
    loadRelated(relatedHost);
  };

  const loadComments = async (host) => {
    host.replaceChildren(el('div', { class: 'row small faint', style: { gap: '8px' } }, [
      el('div', { class: 'spinner' }), el('span', { text: 'Carregando comentarios…' }),
    ]));
    try {
      const data = await api.get(`/api/posts/${postId}/comments`, { query: { sort: 'top', limit: 10 } });
      host.replaceChildren();
      host.append(el('div', { class: 'row', style: { marginBottom: '8px' } }, [
        el('h2', { class: 'grow', style: { fontSize: '15px', margin: '0' }, text: `${formatCount(data.counts.comments)} comentarios` }),
        el('button', {
          type: 'button', class: 'btn btn-sm btn-ghost', text: 'Ver todos',
          onClick: () => openComments(postId, { onCount: (count) => { data.counts.comments = count; } }),
        }),
      ]));
      if (!data.comments.length) {
        host.append(el('p', { class: 'small faint', text: 'Seja a primeira pessoa a comentar.' }));
        return;
      }
      const list = el('div');
      for (const comment of data.comments.slice(0, 10)) {
        list.append(el('div', { class: 'comment' }, [
          el('div', { class: 'avatar sm' }, [
            comment.author?.avatarUrl ? el('img', { src: comment.author.avatarUrl, alt: '', loading: 'lazy' }) : el('div', { class: 'avatar sm' }),
          ]),
          el('div', { class: 'comment-body' }, [
            el('a', { href: `/@${comment.author?.username || ''}`, class: 'comment-name', 'data-link': true, text: `@${comment.author?.username || ''}` }),
            el('div', { class: 'comment-text', text: comment.body }),
            el('div', { class: 'comment-actions' }, [
              el('span', { class: 'row', style: { gap: '3px' } }, [icon('heart'), el('span', { text: formatCount(comment.counts.likes) })]),
            ]),
          ]),
        ]));
      }
      host.append(list);
    } catch (err) {
      host.replaceChildren(el('p', { class: 'small faint', text: err.message }));
    }
  };

  const loadRelated = async (host) => {
    host.replaceChildren(el('div', { class: 'skeleton', style: { height: '120px' } }));
    try {
      const data = await api.get(`/api/posts/${postId}`);
      const related = data.related || [];
      host.replaceChildren();
      if (!related.length) {
        host.append(el('p', { class: 'small faint', text: 'Nada relacionado por enquanto.' }));
        return;
      }
      host.append(el('div', { class: 'grid' }, related.map((item) => {
        const { postTile } = require_profile();
        return postTile(item);
      })));
    } catch {
      host.replaceChildren(el('p', { class: 'small faint', text: 'Sem relacionados.' }));
    }
  };

  let profileModule = null;
  function require_profile() {
    return profileModule || (profileModule = { postTile: fallbackTile });
  }
  function fallbackTile(item) {
    return el('a', { class: 'tile', href: `/video/${item.id}`, 'data-link': true }, [
      item.media?.posterUrl
        ? el('img', { src: item.media.posterUrl, alt: '', loading: 'lazy' })
        : el('div', { class: 'tile-fallback', text: item.type === 'text' ? 'Texto' : '—' }),
      el('div', { class: 'tile-meta' }, [el('span', { class: 'truncate', text: `@${item.author?.username || ''}` })]),
    ]);
  }

  return {
    element: page,
    async load() {
      try {
        const data = await api.get(`/api/posts/${postId}`);
        post = data.post;
        // registra visualizacao real
        api.post(`/api/posts/${postId}/view`, {}).catch(() => {});
        render();
      } catch (err) {
        host.replaceChildren(emptyState({
          iconName: err.status === 404 ? 'search' : 'lock',
          title: err.status === 404 ? 'Video nao encontrado' : err.status === 403 ? 'Conteudo indisponivel' : 'Erro ao carregar',
          message: err.message,
        }));
      }
    },
    destroy() {
      cleanups.forEach((fn) => fn());
      cleanups.length = 0;
      pauseOwnedBy('post-page');
      destroyOwnedBy('post-page');
      host.replaceChildren();
      page.replaceChildren();
      page.remove();
    },
  };
}
