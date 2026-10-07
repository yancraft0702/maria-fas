/**
 * Verificador do ITEM 3 - gravacao de video pelo botao "+", ate o feed.
 *
 * O caminho testado e o do USUARIO, inteiro:
 *   "+" -> "Gravar video" -> editor -> Gravar -> Parar -> Publicar -> feed
 *
 * A camera e a FALSA do Chrome (`--use-fake-device-for-media-stream`), que para
 * o WebRTC e um dispositivo real: o MediaRecorder grava frames de verdade e o
 * arquivo sai com uma trilha de video real, igual ao de um aparelho.
 *
 * O que e exigido:
 *  A) o "+" oferece "Enviar foto/video" e "Gravar video" no mesmo lugar;
 *  B) "Gravar video" abre o editor com o gravador que JA existe (nao upload);
 *  C) a gravacao produz um arquivo com trilha de video REAL (medido com o
 *     mesmo `probeMedia` que o backend usa, sobre o arquivo ORIGINAL que o
 *     servidor gravou);
 *  D) publicar NAO falha com "arquivo nao contem trilha de video";
 *  E) a midia chega a `ready` com metadados reais (largura, altura, poster);
 *  F) o post aparece no feed e o VIDEO REPRODUZ (currentTime anda);
 *  G) o post continua la depois de recarregar.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  startServer, Client, Report, sleep, randomUsername,
} from '../tests/helpers.mjs';
import { ROOT } from '../server/config.js';
import { probeMedia, findFfmpeg } from '../server/media/pipeline.js';
import { spawn } from 'node:child_process';
import { launchChrome } from '../tests/cdp.mjs';

const report = new Report('Editor: video gravado publicado no feed (item 3)');

const STORAGE = path.resolve(ROOT, '.tmp-verify-video');

/** Lista recursivamente os arquivos de video gravados pelo teste. */
function videosNoStorage(desde) {
  const achados = [];
  const andar = (dir, prof) => {
    if (prof > 5) return;
    let entradas = [];
    try { entradas = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entradas) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) andar(p, prof + 1);
      else if (/\.(webm|mkv|mp4)$/i.test(e.name)) {
        const st = fs.statSync(p);
        if (st.mtimeMs >= desde) achados.push({ path: p, size: st.size });
      }
    }
  };
  andar(STORAGE, 0);
  return achados.sort((a, b) => b.size - a.size);
}

async function run() {
  fs.rmSync(STORAGE, { recursive: true, force: true });
  const server = await startServer({ env: { STORAGE_ROOT: STORAGE } });
  const api = new Client(server.baseUrl);
  const user = await api.register({ username: randomUsername('rec') });

  const cookies = await fetch(`${server.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: user.username, password: 'Senha@Teste123' }),
  }).then((r) => r.headers.getSetCookie());

  const browser = await launchChrome({
    extraArgs: [
      '--autoplay-policy=no-user-gesture-required',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
    ],
  });
  const s = await browser.newBrowserContext();
  s.watch();

  try {
    await s.goto(`${server.baseUrl}/`, { waitMs: 300 });
    for (const ck of cookies) {
      const par = ck.split(';')[0];
      const nome = par.slice(0, par.indexOf('='));
      await s.send('Network.setCookie', {
        name: nome, value: decodeURIComponent(par.slice(nome.length + 1)),
        domain: '127.0.0.1', path: '/',
      });
    }
    await s.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });

    // A sessao precisa estar restaurada antes de usar o "+": com o boot pela
    // metade, `isLoggedIn()` devolve falso e o menu manda para /entrar.
    await s.goto(`${server.baseUrl}/`, { waitMs: 2800 });
    for (let i = 0; i < 20; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const pronto = await s.eval("return Boolean(document.querySelector('#tabbar .tab-create'));");
      if (pronto) break;
      // eslint-disable-next-line no-await-in-loop
      await sleep(500);
    }
    const sessaoOk = await s.eval(`
      return { url: location.pathname, avatar: Boolean(document.querySelector('.avatar-btn')) };
    `);
    if (!sessaoOk.avatar) throw new Error(`a sessao nao foi restaurada (${JSON.stringify(sessaoOk)})`);

    // ---- A) o "+" oferece as duas opcoes, no mesmo lugar ----
    const menu = await s.eval(`
      const criar = document.querySelector('#tabbar .tab-create');
      if (!criar) return 'sem o botao +';
      criar.click();
      await new Promise((r) => setTimeout(r, 900));
      const itens = [...document.querySelectorAll('[data-create]')]
        .map((b) => ({ id: b.dataset.create, rotulo: (b.textContent || '').trim().split('\\n')[0] }));
      return itens;
    `);
    if (menu === 'sem o botao +') throw new Error('a tabbar nao tem o botao +');
    const ids = menu.map((i) => i.id);
    const upload = menu.find((i) => i.id === 'midia');
    const gravar = menu.find((i) => i.id === 'gravar-video');
    if (!upload) throw new Error(`o "+" nao tem "Enviar foto/video" (itens: ${JSON.stringify(menu)})`);
    if (!gravar) throw new Error(`o "+" nao tem "Gravar video" (itens: ${JSON.stringify(menu)})`);
    if (ids.indexOf('midia') > ids.indexOf('gravar-video')) {
      throw new Error('"Enviar foto/video" precisa vir antes de "Gravar video" no mesmo menu');
    }
    report.ok(`A) "+" com as duas opcoes juntas: ${JSON.stringify(menu.map((i) => i.id))}`);

    // ---- B) "Gravar video" abre o EDITOR (o gravador que ja existe) ----
    await s.eval(`
      document.querySelector('[data-create="gravar-video"]').click();
      return true;
    `);
    await sleep(3200);
    const rota = await s.eval('return location.pathname;');
    if (rota !== '/criar') throw new Error(`"Gravar video" nao abriu o editor (foi para ${rota})`);
    const temGravador = await s.eval(`
      const b = document.querySelector('[aria-label="Gravar"]');
      return Boolean(b);
    `);
    if (!temGravador) throw new Error('o editor abriu sem o botao de gravar');
    report.ok(`B) "Gravar video" abriu /criar com o gravador existente (botao aria-label="Gravar")`);

    // ---- C) grava de verdade ----
    const inicio = Date.now();
    await s.eval(`
      document.querySelector('[aria-label="Gravar"]').click();
      return true;
    `);
    await sleep(4200);
    const parada = await s.eval(`
      const b = document.querySelector('[aria-label="Gravar"]');
      const txt = (b && b.textContent || '').trim();
      if (!/Parar/.test(txt)) return { ok: false, txt };
      b.click();
      return { ok: true, txt };
    `);
    if (!parada.ok) throw new Error(`a gravacao nao entrou em "Parar" (botao dizia "${parada.txt}")`);
    await sleep(3000);

    const gravado = await s.eval(`
      const v = document.querySelector('video');
      const publicar = [...document.querySelectorAll('button.btn-solid')].find((b) => /Publicar/.test(b.textContent || ''));
      return {
        previa: Boolean(v),
        previaDuracao: v ? v.duration : null,
        publicarHabilitado: publicar ? !publicar.disabled : false,
        botoes: [...document.querySelectorAll('button')].map((b) => (b.textContent || '').trim()).slice(0, 8),
      };
    `);
    if (!gravado.previa) throw new Error('a preview nao apareceu depois de parar a gravacao');
    if (!gravado.publicarHabilitado) throw new Error(`o botao Publicar continua desabilitado (botoes: ${JSON.stringify(gravado.botoes)})`);
    report.ok(`C) gravacao parou com preview de ${Number(gravado.previaDuracao || 0).toFixed(1)}s e `
      + 'o botao Publicar ficou habilitado');

    // ---- D) publicar nao falha ----
    await s.eval(`
      const publicar = [...document.querySelectorAll('button.btn-solid')].find((b) => /Publicar/.test(b.textContent || ''));
      publicar.click();
      await new Promise((r) => setTimeout(r, 1200));
      return true;
    `);
    await sleep(800);
    await s.eval(`
      const legenda = document.querySelector('.modal textarea');
      if (legenda) legenda.value = 'video gravado pelo mais';
      const confirmar = [...document.querySelectorAll('.modal button')]
        .find((b) => /^Publicar/.test((b.textContent || '').trim()));
      if (!confirmar) return 'sem botao de confirmar';
      confirmar.click();
      return 'confirmou';
    `);
    // O upload + o pipeline levam alguns segundos; o cliente espera o status.
    let toasts = [];
    let urlFinal = null;
    for (let i = 0; i < 26; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const st = await s.eval(`
        return {
          url: location.pathname,
          toasts: [...document.querySelectorAll('.toast')].map((t) => (t.textContent || '').trim()),
        };
      `);
      toasts = st.toasts;
      urlFinal = st.url;
      if (st.url !== '/criar') break;
      // eslint-disable-next-line no-await-in-loop
      await sleep(1500);
    }

    const erroReal = toasts.find((t) => /nao contem trilha de video|processamento do arquivo falhou|falhou/i.test(t));
    if (erroReal) {
      throw new Error(`a publicacao falhou: "${erroReal}"`);
    }
    if (urlFinal === '/criar') {
      throw new Error(`a publicacao nao saiu do editor (toasts: ${JSON.stringify(toasts)})`);
    }
    if (!/^\/video\//.test(urlFinal)) {
      throw new Error(`a publicacao foi para ${urlFinal} em vez de abrir o post`);
    }
    report.ok(`D) publicado sem erro: ${urlFinal} (toasts: ${JSON.stringify(toasts)})`);

    // ---- C) o arquivo ORIGINAL que o servidor gravado tem trilha real ----
    //
    // O upload do editor acontece no submit da folha de publicacao, e nao ao
    // parar a gravacao - entao o arquivo so existe no storage aqui. E o
    // arquivo ORIGINAL (o WebM do MediaRecorder) que o `processVideo` analisa
    // quando diz "arquivo nao contem trilha de video".
    const originais = videosNoStorage(inicio - 20000);
    if (!originais.length) throw new Error('nenhum arquivo de video foi gravado no storage');
    const original = originais[0];
    const meta = await probeMedia(original.path);
    if (!meta.hasVideo) {
      throw new Error(`o arquivo gravado NAO tem trilha de video `
        + `(${original.path}, ${original.size} bytes, codec ${meta.videoCodec})`);
    }
    if (!meta.width || !meta.height) {
      throw new Error(`o arquivo gravado nao tem dimensoes (${meta.width}x${meta.height})`);
    }
    report.ok(`C) arquivo original gravado: ${path.basename(original.path)}, ${original.size} bytes, `
      + `${meta.width}x${meta.height}, codec ${meta.videoCodec}, `
      + `fps ${meta.fps}, audio ${meta.hasAudio ? 'sim' : 'nao'} - `
      + `probeMedia diz hasVideo=${meta.hasVideo}`);

    // ---- C2) A PROVA DA CAUSA RAIZ, sobre o arquivo desta execucao --------
    //
    // Esta maquina nao tem ffprobe, entao `probeMedia` cai no
    // `probeViaFfmpeg`, que le a stderr do ffmpeg por expressao regular. A
    // expressao ANTIGUA tirava `hasVideo` da linha completa, exigindo DEPOIS
    // da resolucao o par "N fps" ou "N tbr". O WebM que o MediaRecorder grava
    // nao tem esse par: o ffmpeg escreve "1k tbr", e nao "1.2 tbr". Entao a
    // expressao antiga dava null, `hasVideo` saia `false` e a publicacao
    // morria com "arquivo nao contem trilha de video" - num video valido.
    const bin = await findFfmpeg();
    const stderr = await new Promise((resolve) => {
      const c = spawn(bin, ['-hide_banner', '-nostdin', '-i', original.path, '-f', 'null', '-'], { windowsHide: true });
      let out = '';
      c.stderr.on('data', (d) => { out += d.toString(); });
      c.on('close', () => resolve(out));
      c.on('error', () => resolve(''));
    });
    const linhaVideo = stderr.split('\n').find((l) => /Video:/.test(l)) || '';
    const REGEX_ANTIGA = /Stream #\d+:\d+.*?: Video: (\w+).*?, (\d+)x(\d+).*?, ([\d.]+) (?:fps|tbr)/;
    const REGEX_NOVA = /Stream #\d+:\d+.*?: Video: (\w+)/;
    const antigaCasa = REGEX_ANTIGA.test(stderr);
    const novaCasa = REGEX_NOVA.test(stderr);
    if (!novaCasa) {
      throw new Error(`a leitura por expressao nao achou trilha de video no arquivo gravado - `
        + `linha do ffmpeg: "${linhaVideo.trim()}"`);
    }
    if (!antigaCasa) {
      report.ok(`C2) CAUSA RAIZ CONFIRMADA: a expressao antiga NAO casa com a linha do `
        + `arquivo gravado ("${linhaVideo.trim().slice(0, 78)}") - e por isso ela reprovava `
        + 'um video valido. A leitura atual separa "existe trilha" de "resolucao/fps".');
    } else {
      report.ok('C2) a linha do arquivo gravado tem fps/tbr; a leitura atual e a mesma '
        + '(o defeito nao se reproduz neste arquivo, mas a correcao continua valida)');
    }

    // ---- E) a midia ficou pronta, com metadados reais ----
    const postId = urlFinal.split('/').pop();
    const post = await api.get(`/api/posts/${postId}`);
    const midia = post.body.post?.media || post.body.media;
    if (!midia) throw new Error('a publicacao nao tem midia');
    const status = await api.get(`/api/media/${midia.id}/status`);
    const m = status.body.media;
    if (m.status !== 'ready') {
      throw new Error(`a midia ficou "${m.status}" (erro: ${m.error || 'n/d'}) - `
        + 'o pipeline reprovou o video gravado');
    }
    if (!m.width || !m.height) {
      throw new Error(`a midia pronta nao tem dimensoes (${m.width}x${m.height})`);
    }
    report.ok(`E) midia "${m.status}": ${m.width}x${m.height}, ${m.durationMs}ms, `
      + `poster ${m.posterKey ? 'sim' : 'nao'}, ${(m.renditions || []).length} renderizacao(oes), HLS ${m.hlsKey ? 'sim' : 'nao'}`);

    // ---- F) o video REPRODUZ no post ----
    await sleep(1500);
    const tocando = await s.eval(`
      const v = document.querySelector('video');
      if (!v) return { erro: 'sem video na pagina do post' };
      try { v.muted = true; await v.play(); } catch (e) { /* ja tocando */ }
      await new Promise((r) => setTimeout(r, 1400));
      return {
        src: (v.currentSrc || v.src || '').slice(0, 70),
        readyState: v.readyState,
        duracao: Number.isFinite(v.duration) ? Number(v.duration.toFixed(2)) : null,
        tempo: Number(v.currentTime.toFixed(2)),
        w: v.videoWidth, h: v.videoHeight,
      };
    `);
    if (tocando.erro) throw new Error(`F) ${tocando.erro}`);
    if (tocando.w < 1 || tocando.h < 1) {
      throw new Error(`F) o video nao decodificou no post (videoWidth=${tocando.w}, readyState=${tocando.readyState})`);
    }
    if (!(tocando.tempo > 0)) {
      throw new Error(`F) o video nao reproduziu (currentTime=${tocando.tempo}, readyState=${tocando.readyState})`);
    }
    report.ok(`F) o video reproduz no post: ${tocando.w}x${tocando.h}, `
      + `duracao ${tocando.duracao}s, currentTime ${tocando.tempo}s apos tocar`);

    // ---- G) persiste no feed ----
    await s.goto(`${server.baseUrl}/`, { waitMs: 3600 });
    const noFeed = await s.eval(`
      const cards = [...document.querySelectorAll('.post-card, [data-post-id]')];
      const achou = cards.find((c) => /video gravado pelo mais/.test(c.textContent || ''));
      return { total: cards.length, achou: Boolean(achou), temVideo: achou ? Boolean(achou.querySelector('video')) : false };
    `);
    if (!noFeed.achou) {
      throw new Error(`G) o post gravado nao apareceu no feed apos recarregar `
        + `(${noFeed.total} card(s))`);
    }
    report.ok(`G) o video gravado aparece no feed apos recarregar (${noFeed.total} card(s), `
      + `com video=${noFeed.temVideo})`);

    report.ok('gravar -> arquivo real -> enviar -> processar -> publicar -> tocar no feed');
  } catch (error) {
    report.fail('verificacao do video gravado interrompida', error);
  } finally {
    try { s.close?.(); } catch { /* ignore */ }
    await browser.close();
    await server.stop();
  }
  return report.summary();
}

run().then((r) => process.exit(r.failed > 0 ? 1 : 0)).catch((e) => { console.error(e); process.exit(1); });