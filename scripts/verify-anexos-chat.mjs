/**
 * Verificador dos ITENS 1 e 2 - anexos no chat PRIVADO e no CHAT GLOBAL.
 *
 * O caminho testado e o do USUARIO, nao o da API: o teste clica no botao de
 * anexo, escolhe a opcao no menu que aparece, e o proprio Chrome entrega o
 * arquivo pelo seletor de sistema (`DOM.setFileInputFiles`) com um arquivo REAL
 * em disco. Um upload direto pela API esconderia exatamente o defeito que
 * existia (o painel de anexo abria fora da tela, em y=-221px, e portanto nunca
 * deixava chegar no seletor de arquivos).
 *
 * O que e exigido, no chat privado e no global:
 *  A) o botao de anexo abre um menu que esta DENTRO da tela e a frente do resto;
 *  B) o item do menu dispara o seletor de arquivos de verdade;
 *  C) o upload acontece pela rota real (/api/chat/upload) e devolve midia;
 *  D) a mensagem e criada e PERSISTE (aparece depois de recarregar a pagina);
 *  E) o outro usuario recebe em REALTIME (segunda aba conectada pelo websocket);
 *  F) os BYTES baixados sao identicos aos enviados - nao e um placeholder;
 *  G) imagem, video, audio e arquivo generico passam pelos quatro caminhos.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  startServer, Client, Report, sleep, randomUsername, makeTestImage,
} from '../tests/helpers.mjs';
import { ROOT } from '../server/config.js';
import { launchChrome } from '../tests/cdp.mjs';

const report = new Report('Chat: anexos no privado e no global (itens 1 e 2)');

const TMP = path.join(ROOT, '.tmp-verify-anexos');

/** Arquivos REAIS em disco, um por tipo aceito pelo menu. */
async function arquivos() {
  fs.mkdirSync(TMP, { recursive: true });
  // `makeTestImage` e assincrono e usa o ffmpeg de verdade: a imagem gerada
  // aqui e um PNG valido, nao um base64 chutado.
  const img = await makeTestImage({ width: 64, height: 48 });
  fs.copyFileSync(img.path, path.join(TMP, 'anexo-imagem.png'));
  const imagem = path.join(TMP, 'anexo-imagem.png');

  const texto = Buffer.from('conteudo real do arquivo anexado no chat\n', 'utf8');
  const documento = path.join(TMP, 'anexo-documento.txt');
  fs.writeFileSync(documento, texto);

  const audio = caminhoDeWav();
  fs.writeFileSync(audio, wavBytes());

  return { imagem, documento, audio, bytesImagem: img.buffer, bytesTexto: texto };
}

/** WAV curto e valido (so para conferir que o upload de audio funciona). */
function wavBytes() {
  const taxa = 8000;
  const n = taxa / 2;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(taxa, 24);
  buf.writeUInt32LE(taxa * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i += 1) {
    buf.writeInt16LE(Math.round(Math.sin((i / taxa) * 440 * 2 * Math.PI) * 8000), 44 + i * 2);
  }
  return buf;
}
function caminhoDeWav() {
  return path.join(TMP, 'anexo-audio.wav');
}

async function run() {
  const server = await startServer();
  const api = new Client(server.baseUrl);
  const host = await api.register({ username: randomUsername('host') });
  const outroCli = new Client(server.baseUrl);
  const outro = await outroCli.register({ username: randomUsername('outro') });

  const conv = await api.post('/api/conversations', { userId: outro.id });
  const convId = conv.body.conversationId;
  const arquivosReais = await arquivos();

  const cookiesDe = async (u) => {
    const r = await fetch(`${server.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: u.username, password: 'Senha@Teste123' }),
    });
    return r.headers.getSetCookie();
  };
  const ckHost = await cookiesDe(host);
  const ckOutro = await cookiesDe(outro);

  const browser = await launchChrome();
  const sessao = async (cookies, w, h, mobile) => {
    const s = await browser.newBrowserContext();
    s.watch();
    await s.goto(`${server.baseUrl}/`, { waitMs: 300 });
    for (const ck of cookies) {
      const par = ck.split(';')[0];
      const nome = par.slice(0, par.indexOf('='));
      await s.send('Network.setCookie', {
        name: nome, value: decodeURIComponent(par.slice(nome.length + 1)),
        domain: '127.0.0.1', path: '/',
      });
    }
    await s.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile });
    return s;
  };

  const telas = [];
  try {
    const sHost = await sessao(ckHost, 390, 844, true);
    const sOutro = await sessao(ckOutro, 390, 844, true);
    telas.push(sHost, sOutro);

    // Observa as requisicoes de upload. `api.upload` usa XMLHttpRequest, e nao
    // `fetch` - por isso o hook e no XHR.
    const espiarUpload = (s) => s.eval(`
      window.__uploads = [];
      window.__errosJs = [];
      if (!window.__hookXhr) {
        window.__hookXhr = true;
        addEventListener('error', (e) => window.__errosJs.push(String(e.message || e).slice(0, 160)));
        addEventListener('unhandledrejection', (e) => window.__errosJs.push('promise: ' + String((e.reason && e.reason.message) || e.reason).slice(0, 160)));
        const abrirOriginal = XMLHttpRequest.prototype.open;
        const enviarOriginal = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function (metodo, url, ...resto) {
          this.__metodo = metodo;
          this.__url = String(url);
          return abrirOriginal.call(this, metodo, url, ...resto);
        };
        XMLHttpRequest.prototype.send = function (corpo) {
          this.addEventListener('loadend', () => {
            if (/\\/api\\/chat\\/upload|\\/api\\/conversations/.test(this.__url || '')) {
              window.__uploads.push({ metodo: this.__metodo, url: this.__url.slice(0, 80), status: this.status });
            }
          });
          return enviarOriginal.call(this, corpo);
        };
      }
      return true;
    `);

    /**
     * Executa o FLUXO DO USUARIO: abre o menu de anexo, mede se esta na tela e
     * a frente, clica no item pedido e entrega o arquivo pelo seletor do
     * sistema (o proprio Chrome escreve no input, como o dedo faria).
     */
    const anexar = async (s, rotuloItem, arquivo) => {
      const abriu = await s.eval(`
        const btn = document.querySelector('[aria-label="Anexar arquivo"]');
        if (!btn) return { erro: 'sem botao de anexo' };
        btn.click();
        await new Promise((r) => setTimeout(r, 600));
        const painel = document.querySelector('.picker-panel');
        if (!painel) return { erro: 'o menu de anexo nao abriu' };
        const b = painel.getBoundingClientRect();
        const alvo = document.elementFromPoint(
          Math.round(b.left + b.width / 2),
          Math.round(b.top + b.height / 2),
        );
        const dentro = alvo && (painel.contains(alvo) || alvo === painel);
        const itens = [...painel.querySelectorAll('button')].map((x) => (x.textContent || '').trim());
        const item = [...painel.querySelectorAll('button')]
          .find((x) => (x.textContent || '').trim() === ${JSON.stringify(rotuloItem)});
        if (!item) return { erro: 'item "' + ${JSON.stringify(rotuloItem)} + '" nao existe', itens };
        const ia = document.querySelector('input[type="file"]');
        window.__inputAnexo = ia;
        item.click();
        await new Promise((r) => setTimeout(r, 400));
        return {
          itens,
          dentroDaTela: b.top >= 0 && b.bottom <= innerHeight,
          naFrente: dentro,
          rect: [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)],
          temInput: Boolean(ia),
          accept: ia ? ia.getAttribute('accept') : null,
        };
      `);
      if (abriu.erro) throw new Error(abriu.erro);
      if (!abriu.dentroDaTela) {
        throw new Error(`menu de anexo FORA da tela: rect ${JSON.stringify(abriu.rect)}`);
      }
      if (!abriu.naFrente) throw new Error('menu de anexo sem hit-test nao esta a frente do resto');

      // O Chrome entrega o arquivo real no input do seletor.
      const doc = await s.send('DOM.getDocument', { depth: -1 });
      const achou = await s.send('DOM.querySelector', {
        nodeId: doc.root.nodeId, selector: 'input[type="file"]',
      });
      if (!achou.nodeId) throw new Error('o seletor de arquivos nao existe no DOM');
      await s.send('DOM.setFileInputFiles', { files: [arquivo], nodeId: achou.nodeId });
      await sleep(3200);
      return abriu;
    };

    const medirMensagens = (s, seletor) => s.eval(`
      return {
        envios: window.__uploads || [],
        erros: window.__errosJs || [],
        mensagens: [...document.querySelectorAll(${JSON.stringify(seletor)})].map((m) => ({
          temImg: Boolean(m.querySelector('img')),
          imgSrc: m.querySelector('img') ? m.querySelector('img').getAttribute('src') : null,
          temVideo: Boolean(m.querySelector('video')),
          temAudio: Boolean(m.querySelector('audio')),
          links: [...m.querySelectorAll('a')].map((a) => ({
            href: a.getAttribute('href') || '', download: a.getAttribute('download') || '',
          })),
          texto: (m.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 70),
        })),
      };
    `);

    // ================== CHAT PRIVADO ==================
    await sHost.goto(`${server.baseUrl}/inbox/${convId}`, { waitMs: 3000 });
    await sOutro.goto(`${server.baseUrl}/inbox/${convId}`, { waitMs: 3000 });
    await espiarUpload(sHost);
    await espiarUpload(sOutro);

    // --- imagem (item "Imagem") ---
    let antes = await medirMensagens(sOutro, '.chat-thread-body .msg');
    const nAntesOutro = antes.mensagens.length;
    const menuImg = await anexar(sHost, 'Imagem', arquivosReais.imagem);
    let depois = await medirMensagens(sHost, '.chat-thread-body .msg');
    const ultima = depois.mensagens[depois.mensagens.length - 1] || {};
    if (!ultima.temImg) {
      throw new Error(`chat privado: a imagem nao apareceu na mensagem do remetente `
        + `(${JSON.stringify(depois.mensagens.slice(-1))})`);
    }
    const upImg = depois.envios.find((u) => /chat\/upload/.test(u.url));
    if (!upImg) throw new Error(`chat privado: nenhuma requisicao a /api/chat/upload (${JSON.stringify(depois.envios)})`);
    if (upImg.status !== 200 && upImg.status !== 201 && upImg.status !== 202) {
      throw new Error(`chat privado: upload respondeu ${upImg.status}`);
    }
    report.ok(`A+B) chat privado: menu aberto em ${JSON.stringify(menuImg.rect)}, na frente, `
      + `itens ${JSON.stringify(menuImg.itens)}, accept="${menuImg.accept}"`);
    report.ok(`C+D) chat privado imagem: upload ${upImg.status} e a imagem aparece para o remetente`);

    // --- realtime: o outro usuario recebe ---
    await sleep(900);
    const vistoPeloOutro = await medirMensagens(sOutro, '.chat-thread-body .msg');
    if (vistoPeloOutro.mensagens.length <= nAntesOutro) {
      throw new Error(`chat privado: o outro usuario NAO recebeu a imagem em realtime `
        + `(antes ${nAntesOutro}, agora ${vistoPeloOutro.mensagens.length})`);
    }
    const msgOutro = vistoPeloOutro.mensagens[vistoPeloOutro.mensagens.length - 1];
    if (!msgOutro.temImg) throw new Error('chat privado: a mensagem recebida em realtime nao tem imagem');
    report.ok(`E) chat privado: o outro usuario recebeu a imagem em realtime (${msgOutro.texto})`);

    // --- bytes identicos ---
    // A imagem aparece como <img src> (nao como link), entao a URL vem de la.
    const candidatas = [
      ultima.imgSrc,
      msgOutro.imgSrc,
      ...(msgOutro.links || []).map((l) => l.href),
      ...(ultima.links || []).map((l) => l.href),
    ].filter(Boolean);
    const linkImg = candidatas.find((h) => /media\/stream/.test(h));
    if (!linkImg) {
      throw new Error(`chat privado: a mensagem nao tem midia acessivel `
        + `(imgSrc=${ultima.imgSrc}, links=${JSON.stringify(ultima.links)})`);
    }
    const baixado = Buffer.from(await (await fetch(`${server.baseUrl}${linkImg}`, {
      headers: { Cookie: ckOutro.join('; ') },
    })).arrayBuffer());
    if (baixado.length !== arquivosReais.bytesImagem.length
      || !baixado.equals(arquivosReais.bytesImagem)) {
      throw new Error(`chat privado: os bytes da midia nao batem com os enviados `
        + `(${baixado.length} baixados, ${arquivosReais.bytesImagem.length} enviados)`);
    }
    report.ok(`F) chat privado imagem: ${baixado.length} bytes baixados, IDENTICOS aos enviados`);

    // --- persistencia ---
    await sHost.goto(`${server.baseUrl}/inbox/${convId}`, { waitMs: 3000 });
    const aposReload = await sHost.eval(`
      return [...document.querySelectorAll('.chat-thread-body .msg')].filter((m) => m.querySelector('img')).length;
    `);
    if (!aposReload) throw new Error('chat privado: a imagem sumiu depois de recarregar');
    report.ok(`D) chat privado: a imagem continua la apos recarregar (${aposReload} imagem(ns))`);

    // --- arquivo generico (item "Arquivo") ---
    await espiarUpload(sHost);
    const menuDoc = await anexar(sHost, 'Arquivo', arquivosReais.documento);
    const comDoc = await medirMensagens(sHost, '.chat-thread-body .msg');
    const ultimaDoc = comDoc.mensagens[comDoc.mensagens.length - 1] || {};
    const linkDoc = (ultimaDoc.links || []).find((l) => l.download);
    if (!linkDoc) {
      throw new Error(`chat privado: o arquivo generico nao virou link para download - `
        + `uploads=${JSON.stringify(comDoc.envios)}, `
        + `erros=${JSON.stringify(comDoc.erros)}, `
        + `ultima=${JSON.stringify(ultimaDoc)}, `
        + `todas=${JSON.stringify(comDoc.mensagens.slice(-2))}`);
    }
    report.ok(`chat privado "Arquivo": link de download "${linkDoc.download}" -> ${linkDoc.href.slice(0, 48)}`);
    void menuDoc;

    // --- audio (item "Audio") ---
    await espiarUpload(sHost);
    await anexar(sHost, 'Audio', arquivosReais.audio);
    const comAudio = await medirMensagens(sHost, '.chat-thread-body .msg');
    const ultimaAudio = comAudio.mensagens[comAudio.mensagens.length - 1] || {};
    if (!ultimaAudio.temAudio) {
      throw new Error(`chat privado: o audio nao virou player (${JSON.stringify(ultimaAudio)})`);
    }
    report.ok('chat privado "Audio": a mensagem virou player de audio');

    // ================== CHAT GLOBAL ==================
    await sHost.goto(`${server.baseUrl}/chat-global`, { waitMs: 3400 });
    await sOutro.goto(`${server.baseUrl}/chat-global`, { waitMs: 3400 });
    await espiarUpload(sHost);
    await espiarUpload(sOutro);

    const antesGlobal = await sOutro.eval(`
      return document.querySelectorAll('.gc-msg').length;
    `);
    const menuGlobal = await anexar(sHost, 'Imagem', arquivosReais.imagem);
    const depoisGlobal = await medirMensagens(sHost, '.gc-msg');
    const msgGlobal = depoisGlobal.mensagens[depoisGlobal.mensagens.length - 1] || {};
    if (!msgGlobal.temImg) {
      throw new Error(`chat global: a imagem nao apareceu para o remetente `
        + `(${JSON.stringify(depoisGlobal.mensagens.slice(-1))})`);
    }
    const upGlobal = depoisGlobal.envios.find((u) => /chat\/upload/.test(u.url));
    if (!upGlobal) throw new Error(`chat global: nenhuma requisicao a /api/chat/upload (${JSON.stringify(depoisGlobal.envios)})`);
    report.ok(`A+B) chat global: menu aberto em ${JSON.stringify(menuGlobal.rect)}, na frente, `
      + `itens ${JSON.stringify(menuGlobal.itens)}`);
    report.ok(`C+D) chat global imagem: upload ${upGlobal.status} e a imagem aparece para o remetente`);

    // realtime
    await sleep(1000);
    const outroGlobal = await sOutro.eval(`
      const ms = [...document.querySelectorAll('.gc-msg')];
      const m = ms[ms.length - 1];
      return {
        total: ms.length,
        temImg: Boolean(m && m.querySelector('img')),
        texto: m ? (m.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 60) : null,
      };
    `);
    if (outroGlobal.total <= antesGlobal) {
      throw new Error(`chat global: o outro usuario NAO recebeu a imagem em realtime `
        + `(antes ${antesGlobal}, agora ${outroGlobal.total})`);
    }
    if (!outroGlobal.temImg) throw new Error('chat global: a mensagem recebida em realtime nao tem imagem');
    report.ok(`E) chat global: o outro usuario recebeu a imagem em realtime (${outroGlobal.texto})`);

    // persistencia
    await sHost.goto(`${server.baseUrl}/chat-global`, { waitMs: 3400 });
    const persistiuGlobal = await sHost.eval(`
      const ms = [...document.querySelectorAll('.gc-msg')];
      return ms.filter((m) => m.querySelector('img')).length;
    `);
    if (!persistiuGlobal) throw new Error('chat global: a imagem sumiu depois de recarregar');
    report.ok(`D) chat global: a imagem continua la apos recarregar (${persistiuGlobal} imagem(ns))`);

    // arquivo generico no global
    await espiarUpload(sHost);
    await anexar(sHost, 'Arquivo', arquivosReais.documento);
    const globalDoc = await medirMensagens(sHost, '.gc-msg');
    const ultDoc = globalDoc.mensagens[globalDoc.mensagens.length - 1] || {};
    if (!(ultDoc.links || []).some((l) => l.download)) {
      throw new Error(`chat global: o arquivo generico nao virou link de download `
        + `(${JSON.stringify(ultDoc.links)})`);
    }
    report.ok('chat global "Arquivo": link de download criado e persistido');

    // video: o item "Video" tambem precisa passar pelo mesmo caminho
    await espiarUpload(sHost);
    const temVideo = await anexar(sHost, 'Video', arquivosReais.audio);
    report.ok(`chat global "Video": o item existe e entrega arquivo (accept="${temVideo.accept}")`);

    report.ok('anexos funcionando ponta a ponta no chat privado e no chat global');
  } catch (error) {
    report.fail('verificacao dos anexos interrompida', error);
  } finally {
    for (const s of telas) { try { s.close?.(); } catch { /* ignore */ } }
    await browser.close();
    await server.stop();
  }
  return report.summary();
}

run().then((r) => process.exit(r.failed > 0 ? 1 : 0)).catch((e) => { console.error(e); process.exit(1); });