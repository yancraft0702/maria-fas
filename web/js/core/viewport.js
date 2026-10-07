/**
 * Leitura da viewport VISIVEL (um unico lugar, item 30).
 *
 * Por que isto existe: `100dvh` responde a barra de endereco do navegador,
 * mas NAO ao TECLADO VIRTUAL. No celular, abrir o teclado encolhe o
 * `visualViewport` sem mudar `100dvh`; um container com altura fixa em `dvh`
 * fica maior que a tela, o documento passa a rolar e o gesto de arrastar
 * revela o fundo da pagina - a "faixa preta" abaixo da barra de mensagens.
 *
 * A solucao e publicar a altura REAL em uma variavel de CSS
 * (`--<prefix>-vh`) e deixar o layout consumir isso. O mesmo modulo serve a
 * LIVE e aos chats: antes cada tela tinha seu proprio palpite, e foi
 * exatamente essa duplicacao que deixou o chat com folga morta.
 */

/** Altura util, em px, ja descontando o que o teclado cobre. */
export function alturaVisivel() {
  const vv = window.visualViewport;
  if (!vv) return window.innerHeight;
  // `offsetTop` > 0 quando a pagina esta rolada; a area util e o que sobra
  // abaixo do topo visivel.
  return Math.max(1, Math.round(vv.height - Math.min(vv.offsetTop, vv.height)));
}

/**
 * Publica a altura visivel e o quanto o teclado cobre.
 *
 * @param {HTMLElement} elemento elemento que recebe as variaveis
 * @param {object} opts
 * @param {string} opts.prefix  prefixo das variaveis (`chat` -> `--chat-vh`)
 * @param {boolean} [opts.comTeclado] publica tambem `--<prefix>-kb`
 * @returns {() => void} cleanup
 */
export function observarViewport(elemento, { prefix, comTeclado = false } = {}) {
  if (!elemento || !prefix) return () => {};
  const vv = window.visualViewport || null;

  const publicar = () => {
    const visivel = alturaVisivel();
    // `setProperty` com o mesmo valor nao dispara recalculo: evita loop com o
    // ResizeObserver do consumidor.
    const varVisivel = `${prefix}-vh`;
    const valorVisivel = `${visivel}px`;
    if (elemento.style.getPropertyValue(`--${varVisivel}`) !== valorVisivel) {
      elemento.style.setProperty(`--${varVisivel}`, valorVisivel);
    }
    if (comTeclado && vv) {
      const coberto = Math.max(0, Math.round(window.innerHeight - vv.height));
      const valorKb = `${coberto}px`;
      if (elemento.style.getPropertyValue(`--${prefix}-kb`) !== valorKb) {
        elemento.style.setProperty(`--${prefix}-kb`, valorKb);
      }
    }
  };

  const aoAbrirFoco = () => {
    // `focusin` chega antes do `resize` do `visualViewport` em alguns
    // navegadores mobile; um rAF aqui garante a medicao depois que o teclado
    // ja subiu, sem listener duplicado.
    requestAnimationFrame(publicar);
  };

  publicar();
  window.addEventListener('resize', publicar, { passive: true });
  window.addEventListener('orientationchange', publicar, { passive: true });
  document.addEventListener('focusin', aoAbrirFoco, true);
  document.addEventListener('focusout', () => requestAnimationFrame(publicar), true);
  vv?.addEventListener('resize', publicar, { passive: true });
  vv?.addEventListener('scroll', publicar, { passive: true });

  return () => {
    window.removeEventListener('resize', publicar);
    window.removeEventListener('orientationchange', publicar);
    document.removeEventListener('focusin', aoAbrirFoco, true);
    vv?.removeEventListener('resize', publicar);
    vv?.removeEventListener('scroll', publicar);
  };
}

/**
 * ITEM 7 - publica quanto da parte de baixo da tela JA ESTA OCUPADA.
 *
 * O defeito medido: `#push-prompt` (o aviso de notificacoes) e `.toasts` sao
 * `position: fixed` com `bottom: 66px + safe-area` - um palpite. No celular,
 * onde o rodape tem 66px de tabbar E mais ~56px de composer do chat, esse
 * palpite cai exatamente em cima dos seis controles do chat: medido em
 * 390x844, o aviso ocupava y=629..778 e o composer y=734..776. Nos seis
 * botoes, `elementFromPoint` devolvia o botao do aviso, nao o controle.
 *
 * Aqui a faixa e MEDIDA, nao estimada: soma a altura do bloco de rodape que
 * existir (tabbar, composer do chat, barra inferior da LIVE) e publica
 * `--rodape-h`. Quem ancora no rodape (aviso de push, toasts) consome essa
 * variavel, e o fim do CSS e ficar "acima do composer" em qualquer tamanho de
 * tela, com ou sem safe-area, com ou sem teclado aberto.
 *
 * Nenhum elemento e escondido e nenhuma altura e fixa: quando nao ha rodape
 * extra, `--rodape-h` vale a altura da tabbar, e o aviso volta a aparecer
 * onde nascia antes.
 *
 * @param {object} [opts]
 * @param {string[]} [opts.blocos] seletores, do mais alto ao mais baixo
 * @returns {() => void} cleanup
 */
export function publicarFaixaRodape({ blocos = ['#tabbar', '.chat-foot', '.live-input-bar'] } = {}) {
  const alvo = document.documentElement;

  /** Altura que o rodape realmente ocupa agora, em px. */
  const medir = () => {
    let maior = 0;
    for (const seletor of blocos) {
      for (const no of document.querySelectorAll(seletor)) {
        // `hidden` e `display:none` nao ocupam nada; `offsetParent === null`
        // tambem nao, mas so quando o no nao esta posicionado - por isso o
        // teste e o retangulo, que e o que o usuario ve.
        const r = no.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) continue;
        const estilo = getComputedStyle(no);
        if (estilo.visibility === 'hidden' || estilo.display === 'none') continue;
        // Distancia do fundo da TELA util ate o topo do bloco. Com o teclado
        // aberto, o fundo da tela util e o fim do `visualViewport`.
        const fundoTela = alturaVisivel() + Math.min(
          window.visualViewport?.offsetTop || 0,
          window.visualViewport?.height || 0,
        );
        const acima = fundoTela - r.top;
        if (acima > maior) maior = acima;
      }
    }
    return Math.round(maior);
  };

  const publicar = () => {
    const valor = `${Math.max(0, medir())}px`;
    if (alvo.style.getPropertyValue('--rodape-h') !== valor) {
      alvo.style.setProperty('--rodape-h', valor);
    }
  };

  /**
   * Agenda a medicao para DEPOIS do layout.
   *
   * Duas razoes, e as duas ja custaram um defeito real:
   *
   *  1. `ResizeObserver` so avisa mudanca de TAMANHO. Com o teclado virtual
   *     aberto o composer nao muda de tamanho - ele SOBE. Sem isto, a faixa
   *     continuava valendo a posicao antiga.
   *  2. Os listeners vivem no mesmo alvo (`visualViewport`) de quem publica
   *     `--chat-vh`, e o registro do rodape e o primeiro a rodar. Medindo na
   *     hora do evento, o layout ainda era o antigo: a leitura vinha antes da
   *     pagina encolher. Um `requestAnimationFrame` joga a medicao para depois
   *     da tarefa corrente, com o layout ja recalculado (ler o retangulo
   *     forcaria o recalculo).
   */
  const agendar = () => { requestAnimationFrame(publicar); };

  // O composer cresce quando a mensagem fica longa: um ResizeObserver nele
  // mantem a faixa correta sem depender de resize de janela.
  const ro = typeof ResizeObserver === 'function'
    ? new ResizeObserver(agendar)
    : null;

  // Re-registrar os ResizeObserver a CADA mutacao do DOM e caro: num feed ao
  // vivo, cada mensagem que entra dispara o observador. Aqui so se re-observa
  // quando o CONJUNTO de blocos realmente mudou - o que acontece na troca de
  // tela, e nao a cada card novo.
  let observados = [];
  const observar = () => {
    const agora = [];
    for (const seletor of blocos) {
      for (const no of document.querySelectorAll(seletor)) agora.push(no);
    }
    const mudou = agora.length !== observados.length
      || agora.some((no, i) => no !== observados[i]);
    if (!mudou) return;
    ro?.disconnect();
    observados = agora;
    for (const no of agora) ro?.observe(no);
  };

  const MutationObserverReal = window.MutationObserver;
  const mo = new MutationObserverReal(() => { observar(); agendar(); });
  mo.observe(document.body, { childList: true, subtree: true });

  publicar();
  observar();
  window.addEventListener('resize', agendar, { passive: true });
  window.addEventListener('orientationchange', agendar, { passive: true });
  window.visualViewport?.addEventListener('resize', agendar, { passive: true });
  window.visualViewport?.addEventListener('scroll', agendar, { passive: true });
  document.addEventListener('focusin', agendar, true);
  document.addEventListener('focusout', agendar, true);
  // A rolagem tambem move o rodape (uma lista que sai da tela); e barata.
  window.addEventListener('scroll', agendar, { passive: true, capture: true });

  return () => {
    ro?.disconnect();
    observados = [];
    mo.disconnect();
    window.removeEventListener('resize', agendar);
    window.removeEventListener('orientationchange', agendar);
    window.visualViewport?.removeEventListener('resize', agendar);
    window.visualViewport?.removeEventListener('scroll', agendar);
    window.removeEventListener('scroll', agendar, true);
    alvo.style.removeProperty('--rodape-h');
  };
}
