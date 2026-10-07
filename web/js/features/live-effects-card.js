/**
 * Card de um presente da LIVE. O catálogo usa SVG animado com transparência.
 */
import { el, icon } from '../core/dom.js';

/**
 * @param {object} effect item de /api/live/effects
 * @param {Function} onClick acao ao tocar no card
 */
export function effectCard(effect, onClick) {
  const media = el('div', { class: 'effect-card-media' });
  const url = effect.mediaUrl || '';

  if (url && effect.alphaReady && effect.format === 'svg') {
    const img = el('img', { src: url, alt: '', loading: 'lazy', decoding: 'async' });
    img.addEventListener('error', () => {
      img.remove();
      media.classList.add('is-broken');
    }, { once: true });
    media.append(img);
  } else {
    media.classList.add('is-broken');
  }

  return el('button', {
    type: 'button',
    class: 'effect-card',
    'aria-label': effect.name,
    title: effect.name,
    dataset: { effectId: effect.id, slug: effect.slug },
    onClick,
  }, [
    media,
    effect.hasAudio ? el('span', { class: 'effect-card-som', title: 'Som incluído' }, [icon('volume')]) : null,
    el('span', { class: 'effect-card-name', text: effect.name }),
  ]);
}

/**
 * ITEM 7 - painel compacto de efeitos.
 *
 * O painel antigo era uma grade de `minmax(96px, 1fr)` dentro de um modal de
 * 440px: com 15 efeitos a coluna ficava alta, o nome ocupava duas linhas e nao
 * havia nem busca. Aqui o painel e:
 *  - COMPACTO: largura de 320-400px e altura limitada pela viewport REAL
 *    (`--safe-t`, barra inferior e safe-area), com rolagem so na grade;
 *  - ORGANIZADO: cabecalho fixo com busca e contagem;
 *  - PREPARADO PARA MUITOS: a grade e uma grade (nao lista) e o `max-height`
 *    nao depende da quantidade de itens;
 *  - ACESSIVEL: busca com label e contador que anuncia o resultado.
 *
 * @param {object[]} efeitos itens de /api/live/effects
 * @param {Function} onPick callback do card escolhido
 * @param {object} [opcoes]
 * @returns {HTMLElement} painel pronto para o corpo do modal
 */
export function effectPicker(efeitos, onPick, opcoes = {}) {
  const lista = Array.isArray(efeitos) ? efeitos : [];
  let busca = '';

  const contador = el('span', { class: 'effect-picker-count' });
  const vazio = el('p', { class: 'effect-picker-vazio', hidden: true, text: 'Nenhum efeito com esse filtro.' });
  const grade = el('div', { class: 'effect-grid', role: 'list' });

  const casa = (effect, termo) => {
    if (!termo) return true;
    const alvo = `${effect.name || ''} ${effect.slug || ''}`.toLowerCase();
    return termo.split(/\s+/).filter(Boolean).every((p) => alvo.includes(p));
  };

  const render = () => {
    const visiveis = lista.filter((e) => {
      return casa(e, busca);
    });
    grade.replaceChildren();
    for (const effect of visiveis) {
      grade.append(effectCard(effect, () => onPick(effect)));
    }
    contador.textContent = busca ? `${visiveis.length} de ${lista.length}` : `${lista.length} presentes`;
    vazio.hidden = visiveis.length > 0;
  };

  const campo = el('input', {
    class: 'input effect-picker-busca',
    type: 'search',
    placeholder: 'Buscar efeito',
    'aria-label': 'Buscar efeito pelo nome',
    autocomplete: 'off',
    onInput: (event) => { busca = (event.currentTarget.value || '').trim().toLowerCase(); render(); },
  });

  render();

  const painel = el('div', { class: 'effect-picker' }, [
    el('div', { class: 'effect-picker-topo' }, [campo, contador]),
    grade,
    vazio,
    opcoes.rodape ? el('div', { class: 'effect-picker-rodape' }, [opcoes.rodape]) : null,
  ]);

  // Item 7: com o teclado virtual aberto a busca ocupa a metade de baixo da
  // tela, e o painel precisa encolher ou a grade fica escondida atras do
  // teclado. `com-teclado` e uma classe (nao um pixel medido) porque o painel
  // vive no `#modal-root`, fora da `.live-page` onde `--live-kb` e publicado -
  // medir aqui exigiria um segundo listener de `visualViewport` para o mesmo
  // teclado, o que seria duplicar o `core/viewport.js`.
  campo.addEventListener('focus', () => painel.classList.add('com-teclado'));
  campo.addEventListener('blur', () => painel.classList.remove('com-teclado'));

  return painel;
}
