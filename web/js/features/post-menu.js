/**
 * Menu de acoes do post: copiar link, download, remix, nao tenho interesse,
 * ocultar criador, bloquear, silenciar e denunciar.
 */
import { api } from '../core/api.js';
import { openMenu, toastSuccess, toastError, confirmDialog } from '../core/ui.js';
import { isLoggedIn, store } from '../core/store.js';
import { navigate } from '../core/router.js';
import { openReportDialog, REPORT_CATEGORIES } from './report.js';

export function postShareUrl(post) {
  return `${location.origin}/video/${post.id}`;
}

export async function sharePost(post) {
  try {
    await api.post(`/api/posts/${post.id}/share`, {});
  } catch { /* contagem de compartilhamento e best-effort */ }
}

export async function copyLink(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return true;
  }
  // Fallback (navegadores sem clipboard API / contexto inseguro)
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.append(area);
  area.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  area.remove();
  return ok;
}

export function openShareMenu(post) {
  const url = postShareUrl(post);
  sharePost(post);

  const items = [
    {
      label: 'Copiar link',
      icon: 'copy',
      onClick: async () => {
        const ok = await copyLink(url);
        if (ok) toastSuccess('Link copiado');
        else toastError(new Error('Nao foi possivel copiar. Copie manualmente: ' + url));
      },
    },
    {
      label: 'Compartilhar no sistema',
      icon: 'share',
      onClick: async () => {
        if (!navigator.share) {
          const ok = await copyLink(url);
          toastSuccess(ok ? 'Link copiado para colar' : url);
          return;
        }
        try {
          await navigator.share({ title: 'MARIA FÃS', text: post.caption?.slice(0, 120) || 'Assista no MARIA FÃS', url });
        } catch { /* cancelado */ }
      },
    },
  ];

  if (post.sound) {
    items.push({
      label: `Abrir som "${post.sound.title}"`,
      icon: 'music',
      onClick: () => navigate(`/som/${post.sound.id}`),
    });
  }

  if (post.downloadAllowed) {
    items.push({
      label: 'Baixar video',
      icon: 'download',
      onClick: () => {
        window.location.href = `/api/media/download?postId=${encodeURIComponent(post.id)}`;
        toastSuccess('Download iniciado');
      },
    });
  }

  if (post.remixAllowed && post.media?.kind === 'video') {
    items.push({
      label: 'Remixar',
      icon: 'copy',
      onClick: () => navigate(`/criar?remix=${post.id}`),
    });
  }

  if (post.location) {
    items.push({
      label: `Ver "${post.location}"`,
      icon: 'location',
      onClick: () => navigate(`/busca?q=${encodeURIComponent(post.location)}`),
    });
  }

  return openMenu(items, { title: 'Compartilhar' });
}

export function openPostMenu(post, { onChanged = null } = {}) {
  const items = [
    {
      label: 'Nao tenho interesse',
      icon: 'eyeOff',
      onClick: async () => {
        if (!isLoggedIn()) { navigate('/entrar'); return; }
        try {
          await api.post(`/api/posts/${post.id}/not-interested`, {});
          toastSuccess('Vamos mostrar menos conteudos assim');
          onChanged?.({ hidden: true });
        } catch (err) { toastError(err); }
      },
    },
    {
      label: `Ocultar @${post.author.username}`,
      icon: 'user',
      onClick: async () => {
        if (!isLoggedIn()) { navigate('/entrar'); return; }
        const ok = await confirmDialog({
          title: `Ocultar @${post.author.username}?`,
          message: 'Os videos desta conta nao aparecerao mais no seu feed. Voce deixara de seguir.',
          confirmLabel: 'Ocultar',
        });
        if (!ok) return;
        try {
          const result = await api.post(`/api/posts/${post.id}/hide-author`, {});
          toastSuccess(`Conteudo de @${post.author.username} oculto (${result.hiddenPosts} videos)`);
          onChanged?.({ hidden: true });
        } catch (err) { toastError(err); }
      },
    },
    {
      label: 'Silenciar @' + post.author.username,
      icon: 'mute',
      onClick: async () => {
        if (!isLoggedIn()) { navigate('/entrar'); return; }
        try {
          await api.post(`/api/users/${post.author.id}/mute`, {});
          toastSuccess(`Voce silenciou @${post.author.username}`);
          onChanged?.({ muted: true });
        } catch (err) { toastError(err); }
      },
    },
    {
      label: `Bloquear @${post.author.username}`,
      icon: 'block',
      danger: true,
      onClick: async () => {
        if (!isLoggedIn()) { navigate('/entrar'); return; }
        const ok = await confirmDialog({
          title: `Bloquear @${post.author.username}?`,
          message: 'A conta nao podera te seguir, comentar, enviar mensagens nem ver seus conteudos privados.',
          confirmLabel: 'Bloquear',
          danger: true,
        });
        if (!ok) return;
        try {
          await api.post(`/api/users/${post.author.id}/block`, {});
          toastSuccess('Conta bloqueada');
          onChanged?.({ blocked: true });
          if (post.author.username === store.user?.username) navigate('/');
        } catch (err) { toastError(err); }
      },
    },
    {
      label: 'Denunciar',
      icon: 'flag',
      danger: true,
      onClick: async () => {
        const result = await openReportDialog({ targetType: 'post', targetId: post.id });
        if (result) onChanged?.({ reported: true });
      },
    },
  ];

  if (post.viewerState?.canDelete || post.author.id === store.user?.id) {
    items.unshift({
      label: 'Editar',
      icon: 'edit',
      onClick: () => navigate(`/editar/${post.id}`),
    });
    items.unshift({
      label: 'Apagar video',
      icon: 'trash',
      danger: true,
      onClick: async () => {
        const ok = await confirmDialog({
          title: 'Apagar video',
          message: 'O conteudo e as configuracoes de commentarios serao removidos.',
          confirmLabel: 'Apagar',
          danger: true,
        });
        if (!ok) return;
        try {
          await api.delete(`/api/posts/${post.id}`);
          toastSuccess('Video removido');
          onChanged?.({ deleted: true });
          navigate('/');
        } catch (err) { toastError(err); }
      },
    });
  }

  return openMenu(items, { title: 'Opcoes do video' });
}

export { REPORT_CATEGORIES };
