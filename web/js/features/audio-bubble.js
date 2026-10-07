/**
 * Player de audio com DURACAO REAL (itens 7 e 8).
 *
 * Antes o audio aparecia como `<audio controls>` cru: o navegador mostrava
 * controles genericos e a duracao ficava escondida (ou era preciso clicar para
 * o elemento carregar os metadados). Aqui a duracao e lida do proprio
 * elemento (`loadedmetadata`), comecando em `--:--` enquanto carrega.
 *
 * Um unico componente serve a conversa privada (item 7) e o comentario
 * (item 8) - nao ha duas implementacoes para divergirem.
 */
import { el, icon } from '../core/dom.js';

/** `m:ss` (ou `h:mm:ss` acima de 1h). `null`/infinito vira `--:--`. */
export function formatarDuracao(segundos) {
  if (!Number.isFinite(segundos) || segundos < 0) return '--:--';
  const total = Math.round(segundos);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const dois = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${dois(m)}:${dois(s)}` : `${m}:${dois(s)}`;
}

export function normalizarDuracaoMs(value) {
  const durationMs = Number(value);
  return Number.isFinite(durationMs) && durationMs > 0 ? Math.round(durationMs) : null;
}

/**
 * Cria o player.
 *
 * @param {object} opts
 * @param {string} opts.url          endereco do arquivo de audio
 * @param {string} [opts.label]      rotulo acessível
 * @param {number|null} [opts.durationMs] duracao real fornecida pelo backend
 * @param {string|null} [opts.downloadUrl]  se houver, mostra botao de baixar
 * @returns {HTMLElement}
 */
export function mediaBubble({ url, label = 'Audio', durationMs = null, downloadUrl = null } = {}) {
  let duracaoRealMs = normalizarDuracaoMs(durationMs);
  const duracao = el('span', {
    class: 'ab-dur',
    text: duracaoRealMs ? formatarDuracao(duracaoRealMs / 1000) : '--:--',
    'aria-hidden': 'true',
  });
  const tempo = el('span', { class: 'ab-tempo', text: '0:00', 'aria-hidden': 'true' });

  const audio = el('audio', {
    src: url,
    preload: 'metadata',
    'aria-label': label,
  });
  // O elemento fica fora da tela (sem os controles nativos): o play/pause e o
  // progresso sao desenhados aqui, mas o audio continua sendo o elemento de
  // verdade - quem quiser baixar ou usar o menu nativo do navegador ainda tem.
  audio.classList.add('ab-native');

  const barra = el('div', {
    class: 'ab-track',
    role: 'slider',
    tabindex: '0',
    'aria-label': 'Posicao do audio',
    'aria-valuemin': '0',
    'aria-valuemax': '100',
    'aria-valuenow': '0',
  }, [el('div', { class: 'ab-fill' })]);

  const playBtn = el('button', {
    type: 'button', class: 'ab-play', 'aria-label': 'Reproduzir audio',
  }, [icon('play')]);

  const meter = el('span', { class: 'ab-ondras', 'aria-hidden': 'true' });

  // --- DURACAO REAL ------------------------------------------------------
  const marcarDuracao = () => {
    if (!duracaoRealMs && Number.isFinite(audio.duration) && audio.duration > 0) {
      duracaoRealMs = normalizarDuracaoMs(audio.duration * 1000);
      duracao.textContent = formatarDuracao(duracaoRealMs / 1000);
      barra.setAttribute('aria-valuetext', `0:00 de ${duracao.textContent}`);
    }
  };
  audio.addEventListener('loadedmetadata', marcarDuracao);
  // Alguns navegadores emitem `durationchange` em vez de `loadedmetadata`
  // quando o arquivo ja estava em cache.
  audio.addEventListener('durationchange', marcarDuracao);

  // --- PROGRESSO ---------------------------------------------------------
  const sincronizar = () => {
    const total = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
    const pct = total ? Math.min(100, (audio.currentTime / total) * 100) : 0;
    barra.style.setProperty('--ab-pct', `${pct}%`);
    barra.setAttribute('aria-valuenow', String(Math.round(pct)));
    tempo.textContent = formatarDuracao(audio.currentTime);
    barra.setAttribute('aria-valuetext', `${tempo.textContent} de ${duracao.textContent}`);
  };
  audio.addEventListener('timeupdate', sincronizar);
  audio.addEventListener('loadeddata', sincronizar);
  audio.addEventListener('play', () => {
    playBtn.replaceChildren(icon('pause'));
    playBtn.setAttribute('aria-label', 'Pausar audio');
    meter.classList.add('ab-ativo');
  });
  audio.addEventListener('pause', () => {
    playBtn.replaceChildren(icon('play'));
    playBtn.setAttribute('aria-label', 'Reproduzir audio');
    meter.classList.remove('ab-ativo');
  });
  audio.addEventListener('ended', () => {
    audio.currentTime = 0;
    sincronizar();
  });
  audio.addEventListener('error', () => {
    // Nao engolir: se o arquivo nao carrega, diz.
    if (!duracaoRealMs) duracao.textContent = '--:--';
    playBtn.disabled = true;
    playBtn.setAttribute('aria-label', 'Audio indisponivel');
    meter.classList.add('ab-erro');
  });

  playBtn.addEventListener('click', () => {
    if (audio.paused) {
      // Uma conversa nao toca dois audios ao mesmo tempo: para os outros.
      for (const outro of document.querySelectorAll('audio.ab-native')) {
        if (outro !== audio) outro.pause();
      }
      audio.play().catch(() => { /* o proprio navegador mostra o bloqueio */ });
    } else {
      audio.pause();
    }
  });

  const buscar = (fracao) => {
    const total = audio.duration;
    if (Number.isFinite(total) && total > 0) {
      audio.currentTime = Math.min(total, Math.max(0, fracao * total));
      sincronizar();
    }
  };
  barra.addEventListener('click', (event) => {
    const r = barra.getBoundingClientRect();
    if (r.width > 0) buscar((event.clientX - r.left) / r.width);
  });
  barra.addEventListener('keydown', (event) => {
    const total = audio.duration;
    if (!Number.isFinite(total)) return;
    if (event.key === 'ArrowRight') { audio.currentTime = Math.min(total, audio.currentTime + 5); sincronizar(); }
    else if (event.key === 'ArrowLeft') { audio.currentTime = Math.max(0, audio.currentTime - 5); sincronizar(); }
    else if (event.key === ' ' || event.key === 'Enter') { playBtn.click(); event.preventDefault(); }
  });

  const partes = [playBtn, meter, el('div', { class: 'ab-corpo' }, [barra, el('div', { class: 'ab-tempos' }, [tempo, duracao])])];

  if (downloadUrl) {
    partes.push(el('a', {
      class: 'ab-download', href: downloadUrl, download: '',
      'aria-label': 'Baixar audio', title: 'Baixar audio',
    }, [icon('download')]));
  }

  const root = el('div', { class: 'ab', dataset: { kind: 'audio' } }, partes);
  root.append(audio);
  // Sincroniza assim que possivel, mesmo com o elemento ja em cache.
  sincronizar();
  return root;
}
