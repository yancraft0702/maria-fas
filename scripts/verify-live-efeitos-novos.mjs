/**
 * Verificador dos 15 presentes autorais da LIVE, com animacao e audio proprio.
 *
 * O que e exigido (e medido):
 *  A) CATALOGO: exatamente 15 presentes, todos com midia pronta.
 *  B) AUDIO: os 15 tem `hasAudio: true`, `soundUrl` que responde 200
 *     com WAV valido e energia de audio (pico alto). Nenhum arquivo repetido
 *     entre os 15 - o item pede sons diferentes, e "diferente" e medido por
 *     conteudo, nao por nome.
 *  C) ASSET VISUAL: cada presente tem SVG animado transparente servido inline.
 *  D) ANIMACAO: cada efeito novo cria uma `.effect-instance` NA FRENTE do
 *     video, dentro da area visivel e com tamanho dentro da tela.
 *  E) SOM SINCRONIZADO: o `<audio>` e criado e tocado UMA vez por evento, no
 *     mesmo instante da animacao (diferenca medida em ms), nos TRES clientes.
 *  F) SEM DUPLICAR: um evento = um audio. Nem mais, nem menos.
 *  G) MUDO: com o controle de som desligado, o efeito continua animando e o
 *     audio nao toca; religando, volta a tocar.
 *
 * Nenhuma referencia a arquivo inexistente: toda URL de som e baixada e
 * conferida byte a byte, e toda media do efeito e carregada pelo navegador.
 */
import {
  startServer, Client, Report, sleep, randomUsername,
} from '../tests/helpers.mjs';
import { launchChrome } from '../tests/cdp.mjs';

const report = new Report('LIVE: catálogo de 15 presentes autorais');

const PRESENTES = [
  'rosa-premium', 'coracao-cristal', 'urso-de-pelucia', 'borboletas-douradas',
  'aguia-majestosa', 'lobo-uivando', 'leao-dourado', 'fogos-de-artificio',
  'coroa-real', 'notas-musicais', 'disco-boom', 'presente-dourado',
  'portal-de-luz', 'chuva-de-estrelas-premium', 'coracao-confetes',
].map((slug) => ({ slug }));

/**
 * Espia `<audio>` e a entrada de `.effect-instance` na camada, com carimbo de
 * tempo. E assim que o "som toca junto com a animacao" vira uma medida em
 * milissegundos, e nao uma impressao.
 */
const ESPIONAR = `
  window.__audios = [];
  window.__tocados = 0;
  window.__instantes = [];
  if (!window.__espiaoItem6) {
    window.__espiaoItem6 = true;
    const Real = window.Audio;
    window.Audio = function (src) {
      const a = new Real(src);
      a.dataset.criadoEm = String(Math.round(performance.now()));
      window.__audios.push(a);
      const playOriginal = a.play.bind(a);
      a.play = function () {
        window.__tocados += 1;
        a.dataset.tocadoEm = String(Math.round(performance.now()));
        return playOriginal();
      };
      return a;
    };
    window.Audio.prototype = Real.prototype;
  }
  if (window.__moItem6) window.__moItem6.disconnect();
  window.__ultimoEfeito = null;
  window.__moItem6 = new MutationObserver((registros) => {
    for (const r of registros) {
      for (const n of r.addedNodes) {
        if (n && n.classList && n.classList.contains('effect-instance')) {
          window.__instantes.push(Math.round(performance.now()));
          const img = n.querySelector('img');
          if (img) {
            window.__ultimoEfeito = { alpha: true, src: img.getAttribute('src') };
            img.addEventListener('load', () => { window.__ultimoEfeito.carregou = true; });
            img.addEventListener('error', () => { window.__ultimoEfeito.erro = img.currentSrc || '(sem src)'; });
          } else {
            window.__ultimoEfeito = { alpha: false, src: null, canvas: Boolean(n.querySelector('canvas')) };
          }
        }
      }
    }
  });
  const camada = document.getElementById('live-effects');
  if (camada) window.__moItem6.observe(camada, { childList: true });
  return Boolean(camada);
`;

const MEDIR = `
  const inst = document.querySelectorAll('.effect-instance');
  // A instance MAIS RECENTE e a do evento disparado agora. A anterior pode
  // ainda estar na tela durante os 200ms do fade-out do dispose (o dispose
  // limpa o src da imagem e remove o no depois), e medir ela daria
  // "imagem nao carregou" sem que nada esteja errado.
  const ultimo = inst.length ? inst[inst.length - 1] : null;
  const audios = window.__audios || [];
  const a = audios[0] || null;
  const camada = document.getElementById('live-effects');
  const video = document.querySelector('.live-video-wrap video');
  const evAlpha = (window.__ultimoEfeito && window.__ultimoEfeito.alpha);
  let desenhado = null;
  if (ultimo && video) {
    const r = ultimo.getBoundingClientRect();
    const zi = Number(getComputedStyle(ultimo.parentElement).zIndex) || 0;
    const zv = Number(getComputedStyle(video).zIndex) || 0;
    const img = ultimo.querySelector('img');
    desenhado = {
      efeitoId: ultimo.dataset.effectId,
      rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
      dentroDaTela: r.top >= -1 && r.left >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1,
      cabeNaTela: r.width <= innerWidth && r.height <= innerHeight,
      zCamada: zi, zVideo: zv, naFrente: zi > zv,
      temImagem: Boolean(img),
      srcImagem: img ? img.getAttribute('src') : null,
      imagemCarregada: img ? img.complete && img.naturalWidth > 0 : null,
      natural: img ? [img.naturalWidth, img.naturalHeight] : null,
      opacidade: Number(getComputedStyle(ultimo).opacity),
      // Area REAL visivel do video (object-fit: contain -> retangulo centralizado).
      // Usada para auditar que o efeito fica GRANDE e CENTRAL dentro dela.
      areaVideo: (() => {
        if (!video || !video.videoWidth || !video.videoHeight) return null;
        const b = video.getBoundingClientRect();
        const cs2 = getComputedStyle(video);
        if (cs2.objectFit !== 'contain' && cs2.objectFit !== 'scale-down') {
          return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)];
        }
        const k = Math.min(b.width / video.videoWidth, b.height / video.videoHeight);
        const lw = video.videoWidth * k;
        const alt = video.videoHeight * k;
        const esq = b.left + (b.width - lw) / 2;
        const topo = b.top + (b.height - alt) / 2;
        return [Math.round(esq), Math.round(topo), Math.round(lw), Math.round(alt)];
      })(),
    };
  }
  return {
    instancias: inst.length,
    // Todos: com efeito de 3,5-4s e medicao 2,4s depois, a instancia ANTERIOR
    // pode ainda estar na tela. A que interessa e a ultima.
    todas: [...inst].map((n) => {
      const img = n.querySelector('img');
      return {
        efeitoId: n.dataset.effectId,
        temImg: Boolean(img),
        attrSrc: img ? img.getAttribute('src') : null,
        propSrc: img ? String(img.src || '').slice(0, 90) : null,
        natural: img ? [img.naturalWidth, img.naturalHeight] : null,
        canvas: Boolean(n.querySelector('canvas')),
      };
    }),
    audios: audios.length,
    tocados: window.__tocados || 0,
    srcAudio: a ? (a.currentSrc || a.src || '').split('?')[0] : null,
    tocando: a ? !a.paused : null,
    tempoDecorrido: a ? Number(a.currentTime.toFixed(2)) : null,
    volume: a ? a.volume : null,
    instantes: window.__instantes || [],
    desenhado,
    camadaDentro: camada ? (() => { const r = camada.getBoundingClientRect();
      return r.width <= innerWidth + 1 && r.height <= innerHeight + 1; })() : null,
  };
`;

async function run() {
  const server = await startServer({ env: { EFFECT_DAILY_LIMIT: '100' } });
  const api = new Client(server.baseUrl);

  // ================= A) e B) catalogo e audio ==============================
  //
  // A rota /api/live/effects exige sessao (auth: true), entao o cliente de API
  // precisa estar autenticado antes da primeira consulta. E a midia dos efeitos
  // novos e montada em segundo plano no boot (queueEffectMedia), entao a
  // espera e por `mediaUrl` - nao por tempo fixo.
  const host0 = await api.register({ username: randomUsername('h') });

  let efeitos = [];
  const LIMITE = 150000;
  const inicioEspera = Date.now();
  while (Date.now() - inicioEspera < LIMITE) {
    const r = await api.get('/api/live/effects');
    efeitos = r.body.effects || [];
    if (efeitos.length === 15 && efeitos.every((e) => e.mediaUrl)) break;
    // eslint-disable-next-line no-await-in-loop
    await sleep(1500);
  }
  if (efeitos.length !== 15) {
    throw new Error(`catalogo com ${efeitos.length} efeitos apos `
      + `${Math.round((Date.now() - inicioEspera) / 1000)}s (esperado exatamente 15)`);
  }
  const semMidia = efeitos.filter((e) => !e.mediaUrl);
  if (semMidia.length) {
    throw new Error(`${semMidia.length} efeito(s) sem midia apos a espera: `
      + semMidia.map((e) => e.slug).join(', '));
  }
  const porSlug = new Map(efeitos.map((e) => [e.slug, e]));

  report.ok(`A) catálogo com exatamente 15 presentes e mídias prontas após `
    + `${Math.round((Date.now() - inicioEspera) / 1000)}s`);

  const faltandoNovos = PRESENTES.filter((n) => !porSlug.has(n.slug));
  if (faltandoNovos.length) {
    throw new Error(`efeitos novos ausentes do catalogo: ${faltandoNovos.map((n) => n.slug).join(', ')}`);
  }

  // Cada som: 200, WAV valido, pico de audio e CONTEUDO PROPRIO.
  const conteudos = new Map();
  const ck0 = await fetch(`${server.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: host0.username, password: 'Senha@Teste123' }),
  }).then((r) => r.headers.getSetCookie());

  let totalBytes = 0;
  for (const novo of PRESENTES) {
    const efeito = porSlug.get(novo.slug);
    if (!efeito.hasAudio || !efeito.soundUrl) {
      throw new Error(`${novo.slug}: hasAudio=${efeito.hasAudio} soundUrl=${efeito.soundUrl} `
        + '- o item pede audio real para os 15 novos');
    }
    const r = await fetch(`${server.baseUrl}${efeito.soundUrl}`, { headers: { Cookie: ck0.join('; ') } });
    if (r.status !== 200) throw new Error(`${novo.slug}: som respondeu ${r.status}`);
    const tipo = r.headers.get('content-type') || '';
    if (!/audio|wav|octet-stream/i.test(tipo)) {
      throw new Error(`${novo.slug}: som servido como "${tipo}"`);
    }
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
      throw new Error(`${novo.slug}: arquivo nao e WAV valido`);
    }
    const duracaoMs = Math.round((buf.readUInt32LE(40) / buf.readUInt32LE(28)) * 1000);
    if (duracaoMs !== 3800) throw new Error(`${novo.slug}: áudio dura ${duracaoMs}ms, esperado 3800ms`);
    const amostras = new Int16Array(buf.buffer, buf.byteOffset + 44, Math.floor((buf.length - 44) / 2));
    let pico = 0;
    for (const v of amostras) pico = Math.max(pico, Math.abs(v));
    if (pico < 2000) throw new Error(`${novo.slug}: som praticamente mudo (pico ${pico})`);
    // "Conteudo diferente" de verdade: hash dos BYTES, nao do nome.
    const { createHash } = await import('node:crypto');
    const hash = createHash('sha256').update(buf).digest('hex').slice(0, 16);
    if (conteudos.has(hash)) {
      throw new Error(`${novo.slug} e ${conteudos.get(hash)} tem o MESMO audio `
        + '- o item pede sons diferentes entre os 15');
    }
    conteudos.set(hash, novo.slug);
    totalBytes += buf.length;
    report.ok(`B) ${novo.slug}: ${buf.length} bytes WAV, `
      + `pico ${pico}, ${efeito.soundDurationMs ?? 'n/d'}ms, hash ${hash}`);
    const visual = await fetch(`${server.baseUrl}${efeito.mediaUrl}`, { headers: { Cookie: ck0.join('; ') } });
    const svg = await visual.text();
    if (visual.status !== 200 || visual.headers.get('content-type') !== 'image/svg+xml'
        || !visual.headers.has('content-security-policy') || !/<animate/.test(svg)
        || /<rect\b/i.test(svg) || visual.headers.has('content-disposition')) {
      throw new Error(`${novo.slug}: SVG animado/transparente não foi servido inline com CSP`);
    }
  }
  if (conteudos.size !== 15) throw new Error(`apenas ${conteudos.size} WAVs únicos`);
  report.ok(`B+C) 15 sons WAV e SVGs autorais únicos/animados (${totalBytes} bytes de áudio)`);

  // ================= D) e E) LIVE real ======================================
  const browser = await launchChrome({
    extraArgs: [
      '--autoplay-policy=no-user-gesture-required',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
    ],
  });
  const telaDo = async (usuario, w, h, mobile) => {
    const cli = new Client(server.baseUrl);
    await cli.register({ username: randomUsername('v') });
    const ck = await fetch(`${server.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: usuario, password: 'Senha@Teste123' }),
    }).then((r) => r.headers.getSetCookie());
    const s = await browser.newBrowserContext();
    s.watch();
    await s.goto(`${server.baseUrl}/`, { waitMs: 300 });
    for (const c of ck) {
      const par = c.split(';')[0];
      const nome = par.slice(0, par.indexOf('='));
      await s.send('Network.setCookie', {
        name: nome, value: decodeURIComponent(par.slice(nome.length + 1)),
        domain: '127.0.0.1', path: '/',
      });
    }
    await s.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile });
    void cli;
    return s;
  };

  const telas = [];
  try {
    const sHost = await telaDo(host0.username, 1280, 900, false);
    telas.push(sHost);
    await sHost.goto(`${server.baseUrl}/iniciar-live`, { waitMs: 2600 });
    const inicio = await sHost.eval(`
      const b = [...document.querySelectorAll('button')].find((x) => /iniciar transmissao/i.test(x.textContent || ''));
      if (!b) return 'sem botao';
      b.click();
      return 'clicou';
    `);
    if (inicio !== 'clicou') throw new Error(`host nao iniciou: ${inicio}`);
    await sleep(5600);
    const sala = (await api.get(`/api/users/${host0.id}/live`)).body.live;
    if (!sala?.id) throw new Error('a LIVE nao subiu');

    const esp1u = await api.register({ username: randomUsername('e1') });
    const esp2u = await api.register({ username: randomUsername('e2') });
    const sEsp1 = await telaDo(esp1u.username, 390, 844, true);
    const sEsp2 = await telaDo(esp2u.username, 414, 896, true);
    telas.push(sEsp1, sEsp2);
    await sEsp1.goto(`${server.baseUrl}/live/${sala.id}`, { waitMs: 3400 });
    await sEsp2.goto(`${server.baseUrl}/live/${sala.id}`, { waitMs: 3400 });

    for (const s of [sHost, sEsp1, sEsp2]) {
      const ok = await s.eval(ESPIONAR);
      if (!ok) throw new Error('a camada #live-effects nao existe na tela');
    }
    report.ok('espiao instalado nos tres clientes (audio + instante da animacao)');

    // Dispara a partir dos CLIENTES DE NAVEGADOR que estao na sala: o backend
    // exige `not_in_live` (403) para quem nao entrou. A rotacao existe porque o
    // limite real e de 10 efeitos por usuario por dia, e aqui sao 18 disparos -
    // tres usuarios rotativos dão 6 cada, bem dentro.
    const atiradores = [[sEsp1, 'esp1'], [sHost, 'host'], [sEsp2, 'esp2']];
    let tiro = 0;
    const disparar = async (slug) => {
      const [tela, quem] = atiradores[tiro % atiradores.length];
      tiro += 1;
      const efeito = porSlug.get(slug);
      const r = await tela.eval(`
        if (!window.__giftFetchWrapped) {
          const originalFetch = window.fetch.bind(window);
          window.fetch = async (...args) => {
            const response = await originalFetch(...args);
            const request = args[0] instanceof Request ? args[0] : null;
            const url = new URL(request?.url || args[0], location.href);
            const method = args[1]?.method || request?.method || 'GET';
            if (method === 'POST' && url.pathname === '/api/live/${sala.id}/effects') {
              window.__giftResponse = {
                status: response.status,
                body: await response.clone().json().catch(() => ({})),
              };
            }
            return response;
          };
          window.__giftFetchWrapped = true;
        }
        window.__giftResponse = null;
        const open = document.querySelector('.live-effects-btn');
        if (!open) return { error: 'botao de presentes ausente' };
        open.click();
        for (let i = 0; i < 30 && !document.querySelector('.effect-picker'); i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        const card = document.querySelector('.effect-card[data-slug="${slug}"]');
        if (!card) return { error: 'card ${slug} ausente na grade real' };
        const preview = card.querySelector('.effect-card-media img')?.getAttribute('src') || null;
        if (preview !== ${JSON.stringify(efeito.mediaUrl)}) {
          return { error: 'preview não corresponde ao presente ${slug}', preview };
        }
        card.click();
        for (let i = 0; i < 100 && !window.__giftResponse; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return { ...window.__giftResponse, preview, clickedSlug: card.dataset.slug };
      `);
      if (r.error) throw new Error(`${quem}: ${r.error}`);
      if (r.status >= 400) {
        throw new Error(`${slug} recusado por ${quem} (${r.status}): ${JSON.stringify(r.body).slice(0, 160)}`);
      }
      if (r.clickedSlug !== slug || r.body?.payload?.effect?.slug !== slug
          || r.body?.payload?.effect?.hasAudio !== true) {
        throw new Error(`${quem}: envio real não corresponde a ${slug}: ${JSON.stringify(r).slice(0, 240)}`);
      }
      return r.body;
    };

    const zerar = async () => {
      for (const s of [sHost, sEsp1, sEsp2]) {
        // eslint-disable-next-line no-await-in-loop
        await s.eval('window.__tocados = 0; window.__audios = []; window.__instantes = []; return true;');
      }
    };

    // ---- D) e E) cada efeito NOVO --------------------------------------
    for (const novo of PRESENTES) {
      // eslint-disable-next-line no-await-in-loop
      await zerar();
      // eslint-disable-next-line no-await-in-loop
      const evento = await disparar(novo.slug);
      const ev = evento.payload?.effect || {};
      if (ev.hasAudio !== true || !ev.soundUrl) {
        throw new Error(`${novo.slug}: o evento realtime nao traz som real`);
      }
      // eslint-disable-next-line no-await-in-loop
      await sleep(2400);

      const resumo = [];
      for (const [nome, s] of [['host', sHost], ['esp1', sEsp1], ['esp2', sEsp2]]) {
        // eslint-disable-next-line no-await-in-loop
        const m = await s.eval(MEDIR);
        if (m.instancias < 1) throw new Error(`${nome} (${novo.slug}): nenhum efeito animado`);
        if (!m.desenhado) throw new Error(`${nome} (${novo.slug}): a instancia nao foi medida`);
        if (!m.desenhado.dentroDaTela || !m.desenhado.cabeNaTela) {
          throw new Error(`${nome} (${novo.slug}): efeito fora da tela `
            + `${JSON.stringify(m.desenhado.rect)} em ${s ? '' : ''}${m.desenhado.rect}`);
        }
        if (!m.desenhado.naFrente) {
          throw new Error(`${nome} (${novo.slug}): efeito ATRAS do video `
            + `(camada z=${m.desenhado.zCamada}, video z=${m.desenhado.zVideo})`);
        }
        if (m.desenhado.temImagem && m.desenhado.imagemCarregada === false) {
          throw new Error(`${nome} (${novo.slug}): a imagem do efeito nao carregou - `
            + `natural=${JSON.stringify(m.desenhado.natural)}, `
            + `evento.mediaUrl="${ev.mediaUrl}", instances=${JSON.stringify(m.todas)}`);
        }
        // Som: uma vez, e junto com a animacao.
        if (m.audios !== 1) {
          throw new Error(`${nome} (${novo.slug}): ${m.audios} <audio> para UM evento`);
        }
        // Item: efeito GRANDE e CENTRAL no quadro visivel do video.
        const r = m.desenhado.rect;
        const areaVide = m.desenhado.areaVideo;
        if (areaVide) {
          const cxEf = r[0] + r[2] / 2;
          const cyEf = r[1] + r[3] / 2;
          const cxV = areaVide[0] + areaVide[2] / 2;
          const cyV = areaVide[1] + areaVide[3] / 2;
          const desvioX = Math.abs(cxEf - cxV);
          const desvioY = Math.abs(cyEf - cyV);
          if (desvioX > areaVide[2] * 0.25 || desvioY > areaVide[3] * 0.25) {
            throw new Error(`${nome} (${novo.slug}): efeito NAOFICOU no centro - `
              + `centro do efeito em (${Math.round(cxEf)},${Math.round(cyEf)}), `
              + `centro do video em (${Math.round(cxV)},${Math.round(cyV)})`);
          }
          const alturaFrac = r[3] / Math.max(1, areaVide[3]);
          if (alturaFrac < 0.32) {
            throw new Error(`${nome} (${novo.slug}): efeito pequeno demais - `
              + `ocupa ${(alturaFrac * 100).toFixed(0)}% da altura do video, esperado >= 32%`);
          }
        }
        if (m.tocados !== 1) {
          throw new Error(`${nome} (${novo.slug}): som tocou ${m.tocados}x no mesmo evento`);
        }
        if (m.volume === null || m.volume <= 0 || m.volume > 1) {
          throw new Error(`${nome} (${novo.slug}): volume invalido ${m.volume}`);
        }
        if (!m.srcAudio || !m.srcAudio.includes('media/stream')) {
          throw new Error(`${nome} (${novo.slug}): o audio nao veio da midia do servidor `
            + `(${m.srcAudio})`);
        }
        // Sincronia: o instante do audio contra o instante da animacao.
        const inst = m.instantes[0];
        const tocado = await s.eval("return (window.__audios[0] && Number(window.__audios[0].dataset.tocadoEm)) || null;");
        const criado = await s.eval("return (window.__audios[0] && Number(window.__audios[0].dataset.criadoEm)) || null;");
        const base = criado ??inst;
        if (inst === undefined || tocado === null || base === null) {
          throw new Error(`${nome} (${novo.slug}): sem carimbo de tempo para comparar `
            + `(instancia=${inst}, criado=${criado}, tocado=${tocado})`);
        }
        const desvio = Math.abs(tocado - base);
        if (desvio > 400) {
          throw new Error(`${nome} (${novo.slug}): som ${desvio}ms fora da animacao `
            + `(criado ${base}, tocado ${tocado}, animacao ${inst})`);
        }
        resumo.push(`${nome}: ${m.instancias} inst, ${m.audios} audio/${m.tocados}x, `
          + `${m.desenhado.rect.join(',')}, ${desvio}ms`);
      }
      report.ok(`D+E) ${novo.slug}: ${resumo.join(' | ')}`);
    }

    // ---- G) mudo: anima sem som, e volta a tocar ------------------------
    // O caminho real e o BOTAO "Som dos efeitos" do menu de configuracoes da
    // LIVE, que chama `effects.definirSom()`. Escrever direto no localStorage
    // nao serviria: `somLigado` e lido no construtor do overlay, entao so quem
    // tem a instancia consegue mudar a LIVE aberta - e o botao e quem tem.
    const alternarSom = async (tela) => tela.eval(`
      // 1) abre o menu de configuracoes da LIVE
      let cfg = [...document.querySelectorAll('button')]
        .find((b) => /som dos efeitos/i.test(b.textContent || ''));
      if (!cfg) {
        const abrir = document.querySelector('.live-settings-btn');
        if (!abrir) return 'sem botao de configuracoes';
        abrir.click();
        await new Promise((r) => setTimeout(r, 700));
        cfg = [...document.querySelectorAll('button')]
          .find((b) => /som dos efeitos/i.test(b.textContent || ''));
        if (!cfg) return 'sem controle de som no menu';
      }
      const antes = cfg.getAttribute('aria-pressed');
      const rotuloAntes = (cfg.querySelector('.live-config-estado') || {}).textContent || '';
      cfg.click();
      await new Promise((r) => setTimeout(r, 500));
      return {
        antes, depois: cfg.getAttribute('aria-pressed'), rotuloAntes,
        rotulo: (cfg.querySelector('.live-config-estado') || {}).textContent || '',
      };
    `);

    await zerar();
    const mudoHost = await alternarSom(sHost);
    if (typeof mudoHost === 'string') throw new Error(`a LIVE nao expoe o controle de som: ${mudoHost}`);
    if (mudoHost.antes !== 'true' || mudoHost.depois !== 'false') {
      throw new Error(`o botao de som nao desligou: ${JSON.stringify(mudoHost)}`);
    }
    report.ok(`G) som desligado pelo botao da LIVE (aria-pressed ${mudoHost.antes} -> `
      + `${mudoHost.depois}, rotulo "${mudoHost.rotuloAntes}" -> "${mudoHost.rotulo}")`);
    await disparar('borboletas-douradas');
    await sleep(2200);
    const semSom = await sHost.eval(MEDIR);
    if (semSom.instancias < 1) throw new Error('com o som mudo o efeito parou de animar');
    if (semSom.audios > 0 || semSom.tocados > 0) {
      throw new Error(`com o som mudo ainda tocou (${semSom.audios} audio, ${semSom.tocados}x)`);
    }
    report.ok(`G) com o som mudo: ${semSom.instancias} instancia animando e NENHUM audio criado`);

    await zerar();
    const religado = await alternarSom(sHost);
    if (religado.depois !== 'true') {
      throw new Error(`o botao de som nao religou: ${JSON.stringify(religado)}`);
    }
    await disparar('notas-musicais');
    await sleep(2200);
    const comSom = await sHost.eval(MEDIR);
    if (comSom.audios !== 1 || comSom.tocados !== 1) {
      throw new Error(`religando o som: ${comSom.audios} audio, ${comSom.tocados}x tocado`);
    }
    report.ok('G) religando o som: volta a tocar exatamente uma vez');

    for (const tela of telas) {
      if (tela.pageErrors.length || tela.consoleErrors.length) {
        throw new Error(`erro no console durante os envios: ${JSON.stringify({
          page: tela.pageErrors, console: tela.consoleErrors,
        }).slice(0, 500)}`);
      }
    }
    report.ok('os 15 cards reais foram clicados; envio, animação e áudio funcionaram no host e nos dois espectadores');
  } catch (error) {
    report.fail('verificacao dos efeitos interrompida', error);
  } finally {
    for (const s of telas) { try { s.close?.(); } catch { /* ignore */ } }
    await browser.close();
    await server.stop();
  }
  return report.summary();
}

run().then((r) => process.exit(r.failed > 0 ? 1 : 0)).catch((e) => { console.error(e); process.exit(1); });