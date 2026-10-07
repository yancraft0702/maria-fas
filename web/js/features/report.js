/** Dialogo de denuncia (categorias da plataforma + texto opcional). */
import { api } from '../core/api.js';
import { el } from '../core/dom.js';
import { openModal, toastSuccess, toastError } from '../core/ui.js';

export const REPORT_CATEGORIES = [
  { id: 'spam', label: 'Spam ou propaganda' },
  { id: 'fraude', label: 'Fraude ou golpe' },
  { id: 'assedio', label: 'Assedio ou bullying' },
  { id: 'odio', label: 'Discurso de odio' },
  { id: 'violencia', label: 'Violencia ou ameaca' },
  { id: 'exploracao', label: 'Exploracao' },
  { id: 'sexual_proibido', label: 'Conteudo sexual nao permitido' },
  { id: 'seguranca_infantil', label: 'Seguranca infantil' },
  { id: 'impersonacao', label: 'Falsa identidade' },
  { id: 'malware', label: 'Malware ou virus' },
  { id: 'direitos_autoriais', label: 'Direitos autorais' },
  { id: 'ilegal', label: 'Conteudo ilegal' },
  { id: 'outro', label: 'Outro' },
];

export async function submitReport({ targetType, targetId, category, details = '' }) {
  return api.post('/api/reports', { targetType, targetId, category, details });
}

export function openReportDialog({ targetType, targetId, title = 'Denunciar' }) {
  let selected = null;
  const details = el('textarea', { class: 'textarea', placeholder: 'Descreva o problema (opcional)', maxlength: '1000' });

  const list = el('div', { class: 'menu-list' });
  for (const category of REPORT_CATEGORIES) {
    const button = el('button', {
      type: 'button', class: 'menu-item', role: 'radio', 'aria-checked': 'false',
      onClick: () => {
        selected = category.id;
        for (const other of list.children) other.setAttribute('aria-checked', 'false');
        button.setAttribute('aria-checked', 'true');
        submit.disabled = false;
      },
    }, [el('span', { class: 'grow', text: category.label })]);
    list.append(button);
  }

  const submit = el('button', { type: 'button', class: 'btn btn-danger', text: 'Enviar denuncia', disabled: true });

  const modal = openModal({
    title,
    size: '460px',
    body: el('div', {}, [
      el('p', { class: 'small muted', text: 'Selecione a categoria que melhor descreve o problema. Denuncias sao confidenciais.' }),
      list,
      el('div', { class: 'field mt' }, [el('label', { text: 'Detalhes' }), details]),
    ]),
    actions: [
      { label: 'Cancelar', class: 'btn-ghost' },
      {
        label: 'Enviar',
        class: 'btn-danger',
        onClick: async () => {
          if (!selected) return false;
          submit.disabled = true;
          try {
            await submitReport({ targetType, targetId, category: selected, details: details.value.trim() });
            toastSuccess('Denuncia enviada. Nossa equipe vai analisar.');
            return true;
          } catch (err) {
            toastError(err);
            submit.disabled = false;
            return false;
          }
        },
      },
    ],
  });

  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      if (!document.body.contains(modal.panel)) {
        observer.disconnect();
        resolve(Boolean(selected));
      }
    });
    observer.observe(document.getElementById('modal-root'), { childList: true });
  });
}
