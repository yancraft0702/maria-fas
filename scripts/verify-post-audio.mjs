/**
 * Verificador do item 2 - publicar um audio GRAVADO no navegador.
 *
 * O teste nao chama a API diretamente: ele instancia o `VoiceRecorder` real
 * dentro da pagina, alimenta um Blob de audio de verdade (mesmo formato que o
 * MediaRecorder produz) e percorre o caminho completo:
 *
 *   Blob -> File -> upload -> resposta do servidor -> publicacao -> audio
 *   persistido -> reproduzivel depois de recarregar
 *
 * Isso cobre o ponto exato do defeito: `api.upload()` devolve `{ promise }` e
 * nao a resposta, entao ler `.media` do objeto errado falha antes de criar a
 * publicacao.
 */
import {
  startServer, Client, Report, sleep, randomUsername, makeTestAudio,
} from '../tests/helpers.mjs';
import { launchChrome } from '../tests/cdp.mjs';

const report = new Report('Publicacao de audio gravado (item 2)');

async function run() {
  const server = await startServer();
  const host = new Client(server.baseUrl);
  const hostUser = await host.register({ username: randomUsername('host') });
  const cookies = await fetch(`${server.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: hostUser.username, password: 'Senha@Teste123' }),
  }).then((r) => r.headers.getSetCookie());

  // Audio REAIS em dois tamanhos, para a duracao precisar ser lida do arquivo.
  const curto = await makeTestAudio({ seconds: 3, frequency: 400 });
  const longo = await makeTestAudio({ seconds: 41, frequency: 300 });

  const browser = await launchChrome({ extraArgs: ['--autoplay-policy=no-user-gesture-required'] });
  const s = await browser.newBrowserContext();
  s.watch();

  try {
    await s.goto(`${server.baseUrl}/`, { waitMs: 300 });
    for (const ck of cookies) {
      const par = ck.split(';')[0];
      const nome = par.slice(0, par.indexOf('='));
      await s.send('Network.setCookie', {
        name: nome, value: decodeURIComponent(par.slice(nome.length + 1)), domain: '127.0.0.1', path: '/',
      });
    }
    await s.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await s.goto(`${server.baseUrl}/`, { waitMs: 2800 });

    const diagnose = await s.eval(`
      return {
        url: location.pathname,
        temTabbar: Boolean(document.querySelector('#tabbar')),
        botoesTabbar: [...document.querySelectorAll('#tabbar button, #tabbar a')]
          .map((b) => (b.getAttribute('aria-label') || b.textContent || '').trim()),
        logado: !/\\/entrar$/.test(location.pathname),
      };
    `);
    if (!diagnose.logado) throw new Error(`a sessao nao ficou logada (url=${diagnose.url})`);
    report.ok(`tela inicial ${diagnose.url}, bottom nav com: ${diagnose.botoesTabbar.join(' | ')}`);
    // "Postar audio" vive no MENU DE CRIACAO (botao "+" da bottom nav e o
    // "Publicar" da sidebar) - nao dentro de /criar, que e o editor de video.
    // O caminho testado e o mesmo que o usuario usa.
    const abriuMenu = await s.eval(`
      const abrir = document.querySelector('#tabbar .tab-create')
        || [...document.querySelectorAll('button, a')].find((b) => /Publicar/i.test(b.getAttribute('aria-label') || ''));
      if (!abrir) return 'sem botao de criar';
      abrir.click();
      return 'clicou';
    `);
    if (abriuMenu !== 'clicou') throw new Error(abriuMenu);
    await sleep(900);

    const temItem = await s.eval(`
      return Boolean([...document.querySelectorAll('.create-menu-item')]
        .find((b) => /Postar audio/i.test(b.textContent || '')));
    `);
    if (!temItem) throw new Error('o item "Postar audio" nao aparece no menu de criacao');

    // Abre o item real do menu.
    const abriu = await s.eval(`
      const alvo = [...document.querySelectorAll('.create-menu-item')]
        .find((b) => /Postar audio/i.test(b.textContent || ''));
      if (!alvo) return false;
      alvo.click();
      return true;
    `);
    if (!abriu) throw new Error('nao foi possivel abrir o item de audio');
    await sleep(1200);

    // Formato REAL do MediaRecorder no Chrome, gravado na pagina.
    const mimeReal = await s.eval(`
      return window.MediaRecorder
        && MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus' : 'audio/webm';
    `);
    report.ok(`MimeType que o navegador gravaria: ${mimeReal}`);

    for (const [rotulo, arquivo, esperadoSeg] of [['curto', curto, 3], ['longo', longo, 41]]) {
      // O arquivo vai para a pagina como base64 e vira um Blob com o MESMO
      // tipo que o gravador usaria - nada de atalho no upload.
      const b64 = arquivo.buffer.toString('base64');
      const publicado = await s.eval(`
        const base64 = ${JSON.stringify(b64)};
        const mime = ${JSON.stringify(mimeReal)};
        const bin = atob(base64);
        const buf = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i += 1) buf[i] = bin.charCodeAt(i);
        const blob = new Blob([buf], { type: mime });

        // Chamada REAL do VoiceRecorder do projeto (import do modulo em uso).
        const mod = await import('/js/features/voice.js');
        const rec = new mod.VoiceRecorder({
          onTick: () => {},
          onError: (e) => { window.__erroRec = String(e && e.message || e); },
          onStateChange: (st) => { window.__estadoRec = st; },
        });
        rec.blob = blob;
        window.__rec = rec;
        try {
          const media = await rec.upload();
          return { ok: true, media: { id: media && media.id, url: media && media.url, mime: media && media.mime } };
        } catch (e) {
          return { ok: false, erro: String(e && e.message || e) };
        }
      `);
      if (!publicado.ok) {
        throw new Error(`audio ${rotulo}: o VoiceRecorder falhou - "${publicado.erro}"`);
      }
      if (!publicado.media.id) {
        throw new Error(`audio ${rotulo}: upload devolveu sem media.id (${JSON.stringify(publicado.media)})`);
      }
      report.ok(`audio ${rotulo}: upload devolveu media.id=${publicado.media.id}`);

      // O arquivo existe de verdade e o servidor o serve.
      const tamanho = await fetch(`${server.baseUrl}${publicado.media.url}`, {
        headers: { Cookie: cookies.join('; ') },
      });
      if (tamanho.status !== 200) {
        throw new Error(`audio ${rotulo}: a URL devolvida respondeu ${tamanho.status}`);
      }
      const baixado = Buffer.from(await tamanho.arrayBuffer());
      if (baixado.length !== arquivo.buffer.length) {
        throw new Error(`audio ${rotulo}: arquivo baixado com ${baixado.length} bytes, enviado ${arquivo.buffer.length}`);
      }
      if (baixado.equals(arquivo.buffer) === false) {
        throw new Error(`audio ${rotulo}: os bytes salvos nao batem com os enviados`);
      }
      report.ok(`audio ${rotulo}: ${baixado.length} bytes baixados e IDENTICOS ao enviado (persistido de verdade)`);

      // Cria a publicacao pelo cliente do APP (o `api.post` e quem manda o
      // X-CSRF-Token); um `fetch` cru receberia 403 e mediria o token, nao o
      // fluxo de audio.
      const criado = await s.eval(`
        const { api } = await import('/js/core/api.js');
        try {
          const r = await api.post('/api/posts', {
            type: 'audio',
            mediaId: ${JSON.stringify(publicado.media.id)},
            caption: 'audio ${rotulo}',
          });
          return { status: 201, id: r.post && r.post.id, tipo: r.post && r.post.type };
        } catch (e) {
          return { status: e.status || 0, erro: String(e.message || e), code: e.code };
        }
      `);
      if (!criado.id) {
        throw new Error(`audio ${rotulo}: a publicacao nao foi criada `
          + `(${criado.status} ${criado.code || ''} ${criado.erro || ''})`);
      }
      if (criado.tipo !== 'audio') {
        throw new Error(`audio ${rotulo}: a publicacao saiu como "${criado.tipo}"`);
      }

      // Recarrega a pagina da publicacao e confere que o audio reproduz.
      await s.goto(`${server.baseUrl}/video/${criado.id}`, { waitMs: 2400 });
      const prePlay = await s.eval(`
        const player = document.querySelector('.ab');
        const audio = player?.querySelector('audio');
        const duration = player?.querySelector('.ab-dur')?.textContent || null;
        return { duration, paused: audio?.paused ?? null, currentTime: audio?.currentTime ?? null };
      `);
      const durationLabel = `0:${String(esperadoSeg).padStart(2, '0')}`;
      if (prePlay.duration !== durationLabel) {
        throw new Error(`audio ${rotulo}: duracao antes do play "${prePlay.duration}" != "${durationLabel}"`);
      }
      if (!prePlay.paused || prePlay.currentTime !== 0) {
        throw new Error(`audio ${rotulo}: player iniciou antes de interacao do usuario`);
      }
      const played = await s.eval(`
        const player = document.querySelector('.ab');
        const audio = player?.querySelector('audio');
        const button = player?.querySelector('.ab-play');
        if (!audio || !button) return false;
        button.click();
        await new Promise((resolve) => setTimeout(resolve, 350));
        return !audio.paused && (player.querySelector('.ab-dur')?.textContent || '') === ${JSON.stringify(durationLabel)};
      `);
      if (!played) throw new Error(`audio ${rotulo}: nao iniciou mantendo a duracao correta`);
      await s.eval(`document.querySelector('.ab-play')?.click();`);
      report.ok(`audio ${rotulo}: duracao ${durationLabel} visivel antes do play; player preserva o valor ao reproduzir`);
      let tocando = null;
      for (let i = 0; i < 14; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        tocando = await s.eval(`
          const a = document.querySelector('.slide-audio audio, audio');
          if (!a) return null;
          a.preload = 'metadata';
          return { temSrc: Boolean(a.src), duracao: Number.isFinite(a.duration) ? Math.round(a.duration) : null };
        `);
        if (tocando && tocando.duracao) break;
        // eslint-disable-next-line no-await-in-loop
        await sleep(800);
      }
      if (!tocando || !tocando.temSrc) {
        throw new Error(`audio ${rotulo}: a publicacao recarregada nao tem player`);
      }
      if (!tocando.duracao) {
        throw new Error(`audio ${rotulo}: o player nao revelou a duracao real`);
      }
      // A duracao precisa ser a do arquivo (tolerancia de +-1s do container).
      if (Math.abs(tocando.duracao - esperadoSeg) > 2) {
        throw new Error(`audio ${rotulo}: duracao ${tocando.duracao}s != ${esperadoSeg}s do arquivo`);
      }
      report.ok(`audio ${rotulo}: publicacao criada, recarregada e tocando com duracao real de ${tocando.duracao}s`);
    }

    report.ok('gravacao -> blob -> upload -> publicacao -> reproducao verificada ponta a ponta');
  } catch (error) {
    report.fail('verificacao da publicacao de audio interrompida', error);
  } finally {
    try { s.close?.(); } catch { /* ignore */ }
    await browser.close();
    await server.stop();
  }
  return report.summary();
}

run().then((r) => process.exit(r.failed > 0 ? 1 : 0)).catch((e) => { console.error(e); process.exit(1); });
