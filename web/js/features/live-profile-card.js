import { api } from '../core/api.js';
import { el, formatCount } from '../core/dom.js';
import { store } from '../core/store.js';
import { navigate } from '../core/router.js';
import { openModal, toastError, toastSuccess } from '../core/ui.js';

export function openLiveProfileCard(author) {
  if (!author?.id && !author?.username) return;

  const modal = openModal({
    title: `Perfil de @${author.username || ''}`,
    body: el('p', { class: 'small faint center', text: 'Carregando perfil...' }),
    size: '360px',
  });

  const render = (profile) => {
    const user = profile.user;
    const relation = profile.relation || {};
    const counts = profile.counts || {};
    const isSelf = Boolean(relation.isSelf || store.user?.id === user.id);
    const displayName = user.displayName || user.username;
    const initials = (displayName || '?').slice(0, 1).toUpperCase();

    const avatar = el('div', { class: 'avatar lg live-profile-avatar' }, [
      user.avatarUrl
        ? el('img', {
          src: user.avatarUrl,
          alt: `Foto de @${user.username}`,
          onError: (event) => {
            event.currentTarget.replaceWith(el('span', { text: initials }));
          },
        })
        : el('span', { text: initials }),
    ]);

    const details = el('div', { class: 'live-profile-card' }, [
      avatar,
      el('strong', { class: 'live-profile-name', text: displayName }),
      el('span', { class: 'small faint', text: `@${user.username}` }),
      profile.bio ? el('p', { class: 'live-profile-bio', text: profile.bio }) : null,
      el('span', {
        class: 'small faint',
        text: `${formatCount(counts.followerCount ?? user.followerCount ?? 0)} seguidores`,
      }),
    ].filter(Boolean));

    const actions = el('div', { class: 'live-profile-actions' });
    if (!isSelf && store.user) {
      let followStatus = relation.followStatus || (relation.isFollowing ? 'accepted' : 'none');
      const followButton = el('button', {
        type: 'button',
        class: `btn ${followStatus === 'accepted' ? 'btn-ghost' : 'btn-primary'}`,
      });
      const paintFollowButton = () => {
        followButton.textContent = followStatus === 'accepted'
          ? 'Seguindo'
          : followStatus === 'pending' ? 'Solicitado' : 'Seguir';
        followButton.classList.toggle('btn-primary', followStatus === 'none');
        followButton.classList.toggle('btn-ghost', followStatus !== 'none');
        followButton.setAttribute('aria-pressed', String(followStatus !== 'none'));
      };
      followButton.addEventListener('click', async () => {
        const previousStatus = followStatus;
        followButton.disabled = true;
        try {
          const result = previousStatus === 'none'
            ? await api.post(`/api/users/${user.id}/follow`, {})
            : await api.delete(`/api/users/${user.id}/follow`);
          followStatus = result.status;
          paintFollowButton();
          if (result.counts?.followerCount !== undefined) {
            const count = details.querySelector('.small.faint:last-child');
            if (count) count.textContent = `${formatCount(result.counts.followerCount)} seguidores`;
          }
          toastSuccess(followStatus === 'pending'
            ? `Solicitacao enviada para @${user.username}`
            : followStatus === 'accepted'
              ? `Voce agora segue @${user.username}`
              : `Voce deixou de seguir @${user.username}`);
        } catch (error) {
          toastError(error);
        } finally {
          followButton.disabled = false;
        }
      });
      paintFollowButton();
      actions.append(followButton);
    } else if (!isSelf && !store.user) {
      actions.append(el('button', {
        type: 'button', class: 'btn btn-primary', text: 'Entrar para seguir',
        onClick: () => { modal.close(); navigate('/entrar'); },
      }));
    }

    actions.append(el('button', {
      type: 'button', class: 'btn btn-ghost', text: 'Ver perfil',
      onClick: () => {
        modal.close();
        navigate(`/@${encodeURIComponent(user.username)}`);
      },
    }));
    modal.body.replaceChildren(details, actions);
  };

  const identifier = author.id || author.username;
  api.get(`/api/users/${encodeURIComponent(identifier)}`)
    .then((profile) => {
      if (modal.panel.isConnected) render(profile);
    })
    .catch((error) => {
      if (modal.panel.isConnected) {
        modal.body.replaceChildren(el('p', {
          class: 'small center',
          role: 'alert',
          text: error.message || 'Nao foi possivel carregar este perfil.',
        }));
        toastError(error);
      }
    });
}
