/**
 * Menu de criacao (item 9): ponto UNICO de criacao de conteudo.
 *
 * O "+" da bottom nav e o "Publicar" da sidebar abrem ESTE menu. As quatro
 * acoes usam os fluxos que ja existem:
 * - Postar video  -> editor /criar
 * - Postar foto   -> upload real em /api/media/upload?purpose=image + POST /api/posts
 * - Texto         -> POST /api/posts com type 'text'
 * - Iniciar LIVE  -> /iniciar-live (WebRTC existente)
 */
import { el, icon } from '../core/dom.js';
import { api } from '../core/api.js';
import { openModal, openSheet, toastSuccess } from '../core/ui.js';
import { navigate } from '../core/router.js';
import { VoiceRecorder } from './voice.js';
import { store } from '../core/store.js';

/**
 * @param {object} [opcoes]
 * @param {'sheet'|'menu'} [opcoes.formato] 'menu' desenha uma janela compacta;
 *   'sheet' usa a folha inferior (melhor no celular).
 */
export function openCreateMenu({ formato = 'sheet' } = {}) {
  if (!store.user) {
    navigate('/entrar');
    return;
  }

  // ITEM 4: as duas opcoes de midia ficam JUNTAS e no mesmo lugar do "+":
//   1) ENVIAR FOTO/VIDEO  -> escolhe um arquivo do dispositivo
//   2) GRAVAR VIDEO       -> abre o editor com o gravador que ja funciona
// A gravacao NAO foi trocada por upload nem removida: "Gravar video" continua
// indo para `/criar`, que e onde o `MediaRecorder` real do projeto vive.
const acoes = [
    {
      id: 'midia',
      label: 'Enviar foto/video',
      descricao: 'Escolha uma imagem ou um video',
      icon: 'image',
      onClick: () => abrirMidia(),
    },
    {
      id: 'gravar-video',
      label: 'Gravar video',
      descricao: 'Grave com a camera agora',
      icon: 'camera',
      onClick: () => navigate('/criar'),
    },
    {
      id: 'texto',
      label: 'Texto',
      descricao: 'Escreva um post',
      icon: 'edit',
      onClick: () => abrirTexto(),
    },
    {
      // Item 16: publicar SOMENTE audio. Nao havia nenhuma opcao de audio no
      // menu, e a tentativa pela API respondia "Campo obrigatorio".
      id: 'audio',
      label: 'Postar audio',
      descricao: 'Grave so o audio',
      icon: 'music',
      onClick: () => abrirAudio(),
    },
    {
      id: 'live',
      label: 'Iniciar LIVE',
      descricao: 'Transmita ao vivo',
      icon: 'live',
      onClick: () => navigate('/iniciar-live'),
    },
  ];

  const lista = el('div', { class: 'create-menu-list' }, acoes.map((acao) => el('button', {
    type: 'button',
    class: 'create-menu-item',
    'data-create': acao.id,
    onClick: () => { fechar(); acao.onClick(); },
  }, [
    el('span', { class: 'create-menu-icon' }, [icon(acao.icon)]),
    el('span', { class: 'grow' }, [
      el('strong', { class: 'create-menu-label', text: acao.label }),
      el('span', { class: 'create-menu-desc', text: acao.descricao }),
    ]),
  ])));

  let fechar = () => {};
  if (formato === 'menu') {
    const modal = openModal({ title: 'Criar', body: lista, size: '380px' });
    fechar = () => modal.close();
  } else {
    const sheet = openSheet({ title: 'Criar', body: lista });
    fechar = () => sheet.close();
  }
}

// ---------------------------------------------------------------------------
// Foto: upload real + POST /api/posts (type 'image')
// ---------------------------------------------------------------------------
/**
 * ITEM 4 - "ENVIAR FOTO/VIDEO": um unico item do "+" para escolher imagem OU
 * video do dispositivo. O purpose do upload segue o MIME real do arquivo, e a
 * publicacao sai por `POST /api/posts` com o type correspondente - as mesmas
 * rotas que ja existiam, sem pipeline novo.
 */
function abrirMidia() {
  const ehVideo = (file) => Boolean(file && file.type.startsWith('video/'));
  const input = el('input', { type: 'file', accept: 'image/*,video/*', class: 'sr-file' });
  const preview = el('div', { class: 'create-photo-preview' }, [icon('image')]);
  const legenda = el('textarea', { class: 'input', maxlength: '2200', rows: '3', placeholder: 'Escreva algo...' });
  const aviso = el('p', { class: 'create-error', role: 'alert' });
  const enviar = el('button', { type: 'button', class: 'btn btn-primary grow', text: 'Publicar', disabled: true });

  let arquivo = null;
  let mediaId = null;
  let enviando = false;

  const liberar = () => { enviar.disabled = !arquivo || enviando; };

  const escolher = async (file) => {
    if (!file) return;
    const video = ehVideo(file);
    if (!video && !file.type.startsWith('image/')) {
      aviso.textContent = 'Escolha uma imagem ou um video.';
      return;
    }
    arquivo = file;
    aviso.textContent = '';
    // A previa mostra o arquivo escolhido de verdade: imagem ou video.
    preview.replaceChildren(video
      ? el('video', { src: URL.createObjectURL(file), muted: true, playsinline: '', autoplay: true, loop: true })
      : el('img', { src: URL.createObjectURL(file), alt: 'Pre-visualizacao da foto' }));
    enviar.textContent = video ? 'Publicar video' : 'Publicar foto';
    liberar();
  };

  input.addEventListener('change', () => { escolher(input.files?.[0]); });
  preview.addEventListener('click', () => input.click());
  preview.setAttribute('role', 'button');
  preview.setAttribute('tabindex', '0');
  preview.setAttribute('aria-label', 'Escolher foto ou video');
  preview.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); input.click(); }
  });

  enviar.addEventListener('click', async () => {
    if (!arquivo || enviando) return;
    const video = ehVideo(arquivo);
    const rotulo = video ? 'o video' : 'a foto';
    enviando = true;
    liberar();
    aviso.textContent = `Enviando ${rotulo}...`;
    try {
      // O mesmo endpoint de upload que o editor usa (sem pipeline novo); o
      // `purpose` segue o MIME real do arquivo escolhido.
      const { promise } = api.upload(`/api/media/upload?purpose=${video ? 'video' : 'image'}`, {
        file: arquivo,
        onProgress: (pct) => { aviso.textContent = `Enviando ${rotulo}... ${Math.round(pct)}%`; },
      });
      const result = await promise;
      mediaId = result.media.id;
      const post = await api.post('/api/posts', {
        type: video ? 'video' : 'image',
        mediaId,
        caption: legenda.value.trim(),
      });
      modal.close();
      toastSuccess(video ? 'Video publicado' : 'Foto publicada');
      navigate(`/video/${post.post.id}`);
    } catch (err) {
      aviso.textContent = err.message || `Nao foi possivel publicar ${rotulo}.`;
      enviando = false;
      liberar();
    }
  });

  const modal = openModal({
    title: 'Enviar foto ou video',
    size: '480px',
    body: el('div', { class: 'stack', style: { gap: '12px' } }, [input, preview, legenda, aviso, enviar]),
  });
}

// ---------------------------------------------------------------------------
// Texto: POST /api/posts (type 'text')
// ---------------------------------------------------------------------------
/**
 * (Item 16) Publicar somente audio.
 *
 * Reusa o `VoiceRecorder` que o projeto ja tem (o mesmo das mensagens de
 * voz): nada de gravador paralelo. O arquivo sobe por
 * `/api/chat/upload?purpose=audio` e a publicacao sai por `POST /api/posts`
 * com `type: audio` - as duas rotas que ja existem.
 *
 * Os callbacks vao no CONSTRUTOR (e nao atribuidos depois): e a assinatura
 * real de `VoiceRecorder({ onTick, onError, onStateChange })`.
 */
function abrirAudio() {
  let mediaId = null;
  let gravando = false;

  const recorder = new VoiceRecorder({
    // `elapsedMs` chega como NUMBER (nao como objeto).
    onTick: (elapsedMs) => {
      if (!gravando) return;
      status.textContent = `Gravando ${Math.floor((elapsedMs || 0) / 1000)}s`;
    },
    onError: (err) => {
      gravando = false;
      gravar.textContent = "Gravar";
      status.textContent = "Toque em Gravar";
      aviso.textContent = err?.message || "Falha na gravacao.";
    },
    // `recorded` com `{ durationMs, blob }`: o arquivo ja esta pronto.
    onStateChange: async (state, payload = {}) => {
      if (state !== "recorded") return;
      gravando = false;
      gravar.textContent = "Gravar";
      try {
        status.textContent = "Enviando audio...";
        const media = await recorder.upload();
        mediaId = media?.id || media?.media?.id || null;
        if (!mediaId) throw new Error("O servidor nao devolveu o arquivo de audio.");
        previewHost.replaceChildren(el("audio", {
          src: media.url,
          controls: true,
          preload: "metadata",
          "aria-label": "Preview do audio gravado",
        }));
        const segundos = Math.max(1, Math.round((payload.durationMs || 0) / 1000));
        status.textContent = `Gravado (${segundos}s)`;
        publicar.disabled = false;
        novo.disabled = false;
      } catch (err) {
        // Erro do backend vai para a tela como esta.
        aviso.textContent = err.message || "Nao foi possivel enviar o audio.";
        limpar();
      }
    },
  });

  const aviso = el("p", { class: "create-error", role: "alert" });
  const legenda = el("input", {
    class: "input",
    type: "text",
    maxlength: "2200",
    placeholder: "Legenda (opcional)",
    "aria-label": "Legenda do audio",
  });
  const previewHost = el("div", { class: "stack-sm" });
  const status = el("p", { class: "small faint center", text: "Toque em Gravar" });

  const gravar = el("button", { type: "button", class: "btn btn-primary grow", text: "Gravar" });
  const novo = el("button", { type: "button", class: "btn btn-solid grow", text: "Gravar de novo", disabled: true });
  const publicar = el("button", { type: "button", class: "btn btn-ghost grow", text: "Publicar", disabled: true });

  const limpar = () => {
    mediaId = null;
    previewHost.replaceChildren();
    publicar.disabled = true;
    novo.disabled = true;
    status.textContent = "Toque em Gravar";
  };

  gravar.addEventListener("click", async () => {
    if (gravando) {
      gravando = false;
      gravar.textContent = "Gravar";
      recorder.stop();
      return;
    }
    aviso.textContent = "";
    try {
      gravando = true;
      gravar.textContent = "Parar";
      status.textContent = "Gravando 0s";
      await recorder.start();
    } catch (err) {
      gravando = false;
      gravar.textContent = "Gravar";
      status.textContent = "Toque em Gravar";
      aviso.textContent = err.message || "Nao foi possivel gravar.";
    }
  });

  novo.addEventListener("click", () => {
    aviso.textContent = "";
    limpar();
  });

  publicar.addEventListener("click", async () => {
    if (!mediaId) return;
    publicar.disabled = true;
    aviso.textContent = "Publicando...";
    try {
      const post = await api.post("/api/posts", {
        type: "audio",
        mediaId,
        caption: legenda.value.trim(),
      });
      modal.close();
      toastSuccess("Audio publicado");
      navigate(`/video/${post.post.id}`);
    } catch (err) {
      aviso.textContent = err.message || "Nao foi possivel publicar.";
      publicar.disabled = false;
    }
  });

  const modal = openModal({
    title: "Postar audio",
    size: "480px",
    body: el("div", { class: "stack", style: { gap: "12px" } }, [
      status,
      previewHost,
      legenda,
      el("div", { class: "row", style: { gap: "8px" } }, [gravar, novo]),
      publicar,
      aviso,
    ]),
  });
  // Fechar o modal no meio de uma gravacao libera o microfone.
  modal.onClose?.(() => { if (gravando) { gravando = false; recorder.cancel(); } });
}
function abrirTexto() {
  const legenda = el('textarea', {
    class: 'input',
    maxlength: '2200',
    rows: '6',
    placeholder: 'O que voce quer compartilhar?',
    'aria-label': 'Texto do post',
  });
  const contador = el('p', { class: 'muted small', text: '0/2200' });
  const aviso = el('p', { class: 'create-error', role: 'alert' });
  const enviar = el('button', { type: 'button', class: 'btn btn-primary grow', text: 'Publicar', disabled: true });

  legenda.addEventListener('input', () => {
    contador.textContent = `${legenda.value.length}/2200`;
    enviar.disabled = legenda.value.trim().length === 0;
  });

  enviar.addEventListener('click', async () => {
    const caption = legenda.value.trim();
    if (!caption) return;
    enviar.disabled = true;
    aviso.textContent = 'Publicando...';
    try {
      const post = await api.post('/api/posts', { type: 'text', caption });
      modal.close();
      toastSuccess('Post publicado');
      navigate(`/video/${post.post.id}`);
    } catch (err) {
      aviso.textContent = err.message || 'Nao foi possivel publicar.';
      enviar.disabled = false;
    }
  });

  const modal = openModal({
    title: 'Novo texto',
    size: '480px',
    body: el('div', { class: 'stack', style: { gap: '12px' } }, [legenda, contador, aviso, enviar]),
  });
  legenda.focus();
}
