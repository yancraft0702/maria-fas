/** Tela de amigos: requisicoes de seguir, lista de amigos e suggestions. */
import { api } from '../core/api.js';
import { el } from '../core/dom.js';
import { toastError, toastSuccess } from '../core/ui.js';
import { realtime } from '../core/realtime.js';

export function createFriendsScreen() {
  const page = el('div', { class: 'page' });
  const cleanups = [];
  const state = { requests: [], friends: [], suggestions: [] };

  const section = (title, children, action = null) => el('section', { class: 'mb' }, [
    el('div', { class: 'row', style: { marginBottom: '8px' } }, [
      el('h2', { class: 'grow', style: { fontSize: '16px', margin: '0' }, text: title }),
      action,
    ]),
    ...(Array.isArray(children) ? children : [children]),
  ]);

  const userRow = (user, actions = []) => el('div', { class: 'list-item' }, [
    el('a', { href: `/@${user.username}`, 'data-link': true, class: 'avatar' }, [
      user.avatarUrl ? el('img', { src: user.avatarUrl, alt: '', loading: 'lazy' }) : el('div', { class: 'avatar' }),
    ]),
    el('a', { href: `/@${user.username}`, 'data-link': true, class: 'grow', style: { color: 'inherit', textDecoration: 'none' } }, [
      el('div', { class: 'strong truncate', text: user.displayName }),
      el('div', { class: 'small faint truncate', text: `@${user.username}` }),
    ]),
    ...actions,
  ]);

  /**
   * Botao seguir/deixar de seguir.
   *
   * CAUSA RAIZ do erro "Cannot ..." (item 10): o handler acessava
   * `event.currentTarget` DEPOIS do `await`. Como o evento ja terminou de ser
   * despachado nesse ponto, `currentTarget` e `null` e o acesso lancava
   * "Cannot read properties of null (reading 'textContent')" - o erro que
   * aparecia na aba Amigos ao seguir alguem.
   *
   * Aqui o botao e capturado ANTES do await, o estado e atualizado na hora
   * (otimista) e revertido se a API recusar.
   */
  const followButton = (user) => {
    const button = el('button', { type: 'button', class: 'btn btn-sm btn-primary' });
    // O backend responde `{ status: 'accepted' | 'pending', changed, counts }`.
    // `pending` = conta privada, o pedido foi enviado (ainda nao "Seguindo").
    const relate = (status) => {
      if (status === 'pending') return 'pending';
      if (status === 'accepted') return 'accepted';
      return user.isFollowing ? 'accepted' : 'none';
    };
    user.followStatus = relate(user.followStatus || (user.isFollowing ? 'accepted' : 'none'));

    const pintar = () => {
      const st = user.followStatus;
      const seguindo = st === 'accepted';
      const pendente = st === 'pending';
      button.textContent = seguindo ? 'Seguindo' : pendente ? 'Solicitado' : 'Seguir';
      button.classList.toggle('btn-primary', !seguindo && !pendente);
      button.classList.toggle('btn-ghost', seguindo || pendente);
      button.setAttribute('aria-pressed', String(seguindo || pendente));
      button.setAttribute(
        'aria-label',
        `${seguindo ? 'Deixar de seguir' : pendente ? 'Cancelar solicitacao' : 'Seguir'} ${user.displayName || user.username}`,
      );
    };

    button.addEventListener('click', async () => {
      const stAntes = user.followStatus;
      const retirar = stAntes !== 'none';
      // Atualizacao imediata: o botao e o contador nao podem esperar a rede.
      user.followStatus = retirar ? 'none' : 'accepted';
      pintar();
      button.disabled = true;
      try {
        const resposta = retirar
          ? await api.delete(`/api/users/${user.id}/follow`)
          : await api.post(`/api/users/${user.id}/follow`, {});
        // O backend e a autoridade sobre a relacao.
        if (resposta && resposta.status) user.followStatus = relate(resposta.status);
        pintar();
        toastSuccess(retirar
          ? `Voce deixou de seguir @${user.username}`
          : (user.followStatus === 'pending'
            ? `Solicitacao enviada para @${user.username}`
            : `Voce agora segue @${user.username}`));
        // Recarrega para lista e contadores refletirem o servidor.
        await load();
      } catch (err) {
        // Reverte: nada de "deixou seguindo" quando a API recusou.
        user.followStatus = stAntes;
        pintar();
        toastError(err);
      } finally {
        button.disabled = false;
      }
    });
    pintar();
    return button;
  };

  const render = () => {
    page.replaceChildren(
      el('h1', { class: 'page-title', text: 'Amigos' }),
      el('p', { class: 'page-sub', text: 'Amizade no MARIA FÃS e mutua: os dois lados precisam aceitar seguir.' }),
    );

    if (state.requests.length) {
      page.append(section(
        `Pedidos de seguir (${state.requests.length})`,
        state.requests.map((request) => userRow(request.user, [
          el('button', {
            type: 'button', class: 'btn btn-sm btn-primary', text: 'Aceitar',
            onClick: async () => {
              try {
                await api.post(`/api/users/${request.userId}/follow-requests/accept`, {});
                toastSuccess(`Voce e @${request.user.username} agora sao amigos`);
                state.requests = state.requests.filter((r) => r.userId !== request.userId);
                render();
              } catch (err) { toastError(err); }
            },
          }),
          el('button', {
            type: 'button', class: 'btn btn-sm btn-ghost', text: 'Recusar',
            onClick: async () => {
              try {
                await api.post(`/api/users/${request.userId}/follow-requests/reject`, {});
                state.requests = state.requests.filter((r) => r.userId !== request.userId);
                render();
              } catch (err) { toastError(err); }
            },
          }),
        ])),
      ));
    }

    page.append(section(
      `Meus amigos (${state.friends.length})`,
      state.friends.length
        ? state.friends.map((user) => userRow(user, [
          followButton(user),
          el('a', { class: 'btn btn-sm btn-ghost', href: `/@${user.username}`, 'data-link': true, text: 'Ver perfil' }),
        ]))
        : el('p', { class: 'small muted', text: 'Voce ainda nao tem amigos. Aceite um pedido ou siga pessoas de forma mutua.' }),
    ));

    page.append(section(
      'Sugestoes para voce',
      state.suggestions.length
        ? state.suggestions.map((user) => userRow(user, [followButton(user)]))
        : el('p', { class: 'small muted', text: 'Sem sugestoes no momento.' }),
      el('button', {
        type: 'button', class: 'btn btn-sm btn-ghost', text: 'Atualizar',
        onClick: () => load(),
      }),
    ));
  };

  const load = async () => {
    const results = await Promise.allSettled([
      api.get('/api/me/follow-requests'),
      api.get('/api/users/me/friends', { query: { limit: 100 } }),
      api.get('/api/suggestions/users', { query: { limit: 12 } }),
    ]);
    state.requests = results[0].status === 'fulfilled' ? results[0].value.requests || [] : [];
    state.friends = results[1].status === 'fulfilled' ? results[1].value.users || [] : [];
    state.suggestions = results[2].status === 'fulfilled' ? results[2].value.users || [] : [];
    render();
  };

  cleanups.push(realtime.addEventListener('FOLLOW', debouncedReload));
  cleanups.push(realtime.addEventListener('UNFOLLOW', debouncedReload));

  let reloadTimer = null;
  function debouncedReload() {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => load().catch(() => {}), 1200);
  }

  return {
    element: page,
    async load() { await load(); },
    destroy() {
      clearTimeout(reloadTimer);
      cleanups.forEach((fn) => fn());
      page.replaceChildren();
      page.remove();
    },
  };
}
