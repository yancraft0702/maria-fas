/**
 * Camadas de interface compartilhadas: toasts, modais, folhas (sheets),
 * confirmacao e menu de acoes. Um unico lugar, sem componentes duplicados.
 */
import { el, icon, mount, clearNode } from './dom.js';
import { on } from './store.js';

const toastHost = () => document.getElementById('toasts');
const modalHost = () => document.getElementById('modal-root');
export function toast(message, { type = 'info', duration = 3600, action = null } = {}) {
  const host = toastHost();
  if (!host) return () => {};
  const node = el('div', { class: `toast ${type}`, role: type === 'error' ? 'alert' : 'status' }, [
    el('span', { class: 'grow', text: message }),
  ]);
  if (action) {
    node.append(el('button', {
      type: 'button', class: 'btn btn-sm btn-ghost', text: action.label,
      onClick: () => { action.onClick?.(); dismiss(); },
    }));
  }
  const dismiss = () => {
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 180);
  };
  host.append(node);
  // Limite de 4 toasts simultaneos
  while (host.children.length > 4) host.firstChild.remove();
  const timer = setTimeout(dismiss, duration);
  node.addEventListener('click', (event) => {
    if (event.target.tagName === 'BUTTON') return;
    clearTimeout(timer);
    dismiss();
  });
  return dismiss;
}

export const toastError = (err) => {
  const message = err?.message || 'Erro inesperado';
  console.error('[erro]', err);
  return toast(message, { type: 'error', duration: 5200 });
};

export const toastSuccess = (message) => toast(message, { type: 'success' });

/** Modal acessivel com foco preso. */
export function openModal({ title, body, actions = [], onClose, size = null, dismissable = true }) {
  const host = modalHost();
  const previousFocus = document.activeElement;
  const panel = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title || 'Dialogo' });
  if (size) panel.style.maxWidth = size;

  const backdrop = el('div', { class: 'modal-backdrop' }, [panel]);

  const close = (result) => {
    document.removeEventListener('keydown', onKey);
    // Item 3: qualquer navegacao fecha o modal. Sem isso, clicar num link
    // dentro dele (abrir um perfil da lista de "Seguindo", por exemplo)
    // navegava mas deixava a janela aberta por cima, com o backdrop ativo
    // capturando cliques e o `no-scroll` preso no <body>.
    stopOnRoute?.();
    backdrop.remove();
    document.body.classList.remove('no-scroll');
    previousFocus?.focus?.();
    onClose?.(result);
  };

  // Declarado antes do primeiro uso possible de `close` acima.
  let stopOnRoute = null;

  const onKey = (event) => {
    if (event.key === 'Escape' && dismissable) { event.preventDefault(); close(null); return; }
    if (event.key !== 'Tab') return;
    const focusables = panel.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };

  const head = el('div', { class: 'modal-head' }, [
    el('h2', { text: title || '' }),
    dismissable ? el('button', {
      type: 'button', class: 'icon-btn', 'aria-label': 'Fechar',
      onClick: () => close(null),
    }, [icon('close')]) : null,
  ]);

  const bodyNode = el('div', { class: 'modal-body' });
  if (typeof body === 'string') bodyNode.append(body);
  else if (body) bodyNode.append(body);

  panel.append(head, bodyNode);

  if (actions.length) {
    panel.append(el('div', { class: 'modal-foot' }, actions.map((action) => el('button', {
      type: 'button',
      class: `btn ${action.class || 'btn-ghost'}`,
      text: action.label,
      onClick: async (event) => {
        const button = event.currentTarget;
        button.disabled = true;
        try {
          const result = await action.onClick?.({ close });
          if (result !== false) close(result ?? true);
        } finally {
          button.disabled = false;
        }
      },
    }))));
  }

  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop && dismissable) close(null);
  });
  document.addEventListener('keydown', onKey);
  // `route:end` e emitido depois que a tela nova ja foi montada; fechar aqui
  // garante que o usuario so veja o destino, nunca a lista por cima dele.
  stopOnRoute = on('route:end', () => close(null));

  host.append(backdrop);
  document.body.classList.add('no-scroll');
  setTimeout(() => {
    const focusTarget = panel.querySelector('input, textarea, button.btn-primary, button');
    focusTarget?.focus();
  }, 30);

  return { close, panel, body: bodyNode };
}

export function confirmDialog({ title, message, confirmLabel = 'Confirmar', cancelLabel = 'Cancelar', danger = false }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
    const modal = openModal({
      title,
      body: el('p', { text: message, style: { margin: '0', whiteSpace: 'pre-wrap' } }),
      actions: [
        { label: cancelLabel, class: 'btn-ghost', onClick: () => { finish(false); return true; } },
        { label: confirmLabel, class: danger ? 'btn-danger' : 'btn-primary', onClick: () => { finish(true); return true; } },
      ],
      onClose: () => finish(false),
    });
    return modal;
  });
}

/** Folha inferior (mobile) / dialogo centralizado (desktop). */
export function openSheet({ title, body, footer, onClose, headExtra = null }) {
  const host = modalHost();
  const previousFocus = document.activeElement;

  const bodyNode = el('div', { class: 'sheet-body' });
  if (typeof body === 'string') bodyNode.append(body);
  else if (body) bodyNode.append(body);

  const close = () => {
    document.removeEventListener('keydown', onKey);
    // Mesmo motivo do `openModal` (item 3): navegar tem que derrubar a folha,
    // senao ela fica por cima da tela nova com o `no-scroll` preso.
    stopOnRoute?.();
    backdrop.remove();
    document.body.classList.remove('no-scroll');
    previousFocus?.focus?.();
    onClose?.();
  };

  let stopOnRoute = null;

  const onKey = (event) => {
    if (event.key === 'Escape') { event.preventDefault(); close(); }
  };

  const head = el('div', { class: 'sheet-head' }, [
    headExtra,
    el('strong', { text: title || '' }),
    el('button', {
      type: 'button', class: 'icon-btn sheet-close', 'aria-label': 'Fechar',
      onClick: close,
    }, [icon('close')]),
  ]);

  const panel = el('div', {
    class: 'sheet-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': title || 'Painel',
  }, [head, bodyNode]);

  if (footer) {
    const footNode = el('div', { class: 'sheet-foot' });
    if (typeof footer === 'string') footNode.append(footer);
    else footNode.append(footer);
    panel.append(footNode);
  }

  const backdrop = el('div', { class: 'sheet', onClick: (event) => { if (event.target === backdrop) close(); } }, [panel]);
  document.addEventListener('keydown', onKey);
  stopOnRoute = on('route:end', () => close());
  host.append(backdrop);
  document.body.classList.add('no-scroll');

  return { close, panel, body: bodyNode };
}

/** Menu de acoes (usado pelo botao "..."). */
export function openMenu(items, { title = '' } = {}) {
  const list = el('div', { class: 'menu-list' }, items.filter(Boolean).map((item) => el('button', {
    type: 'button',
    class: `menu-item ${item.danger ? 'danger' : ''}`,
    onClick: async () => {
      modal.close(null);
      if (item.onClick) await item.onClick();
    },
  }, [
    item.icon ? icon(item.icon) : null,
    el('span', { class: 'grow', text: item.label }),
    item.hint ? el('span', { class: 'tiny faint', text: item.hint }) : null,
  ])));

  const modal = openModal({ title, body: list, onClose: () => {} });
  return modal;
}

/** Imagem em tela cheia (visualizador de midia). */
export function openImageViewer(url, { alt = '' } = {}) {
  const onKey = (event) => { if (event.key === 'Escape') close(); };
  const close = () => {
    document.removeEventListener('keydown', onKey);
    clearNode(modalHost());
    document.body.classList.remove('no-scroll');
  };
  const image = el('img', { src: url, alt, style: { maxWidth: '94vw', maxHeight: '86dvh', objectFit: 'contain' } });
  modalHost().append(el('div', {
    class: 'modal-backdrop', onClick: close, role: 'dialog', 'aria-modal': 'true', 'aria-label': alt || 'Imagem',
  }, [image]));
  document.addEventListener('keydown', onKey);
  document.body.classList.add('no-scroll');
}

export function loadingBlock(label = 'Carregando…') {
  return el('div', { class: 'page-empty', role: 'status' }, [
    el('div', { class: 'spinner', style: { margin: '0 auto 10px' } }),
    el('div', { class: 'small', text: label }),
  ]);
}

export function emptyState({ iconName = 'search', title, message, action = null }) {
  return el('div', { class: 'empty-state' }, [
    icon(iconName, { className: 'muted' }),
    el('h3', { text: title }),
    message ? el('p', { class: 'muted small', text: message }) : null,
    action,
  ]);
}

export { mount };
