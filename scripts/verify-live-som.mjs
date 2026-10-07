/**
 * Verificador do item 9 - SOM dos efeitos da LIVE.
 *
 * O que e exigido (e medido):
 *  A) o catalogo diz a verdade: `hasAudio: true` so para efeitos que tem
 *     arquivo de audio REAL, e o arquivo responde 200 com bytes de audio
 *     (nao HTML de erro nem JSON);
 *  B) o SOM toca para TODOS os participantes (host + espectadores) no mesmo
 *     instante da animacao, uma vez por evento - nem duplicado, nem perdido;
 *  C) efeito SEM som nao toca nada (nao se finge som);
 *  D) respeita o controle de mudo: com o som desligado, nada toca; religando,
 *     volta a tocar;
 *  E) cada efeito com som tem um arquivo DIFERENTE dos demais (o item pede
 *     "sons diferentes").
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  startServer, Client, Report, sleep, randomUsername,
} from '../tests/helpers.mjs';
import { ROOT } from '../server/config.js';
import { launchChrome } from '../tests/cdp.mjs';

const report = new Report('LIVE: som dos efeitos (item 9)');

async function run() {
  const server = await startServer();
  const api = new Client(server.baseUrl);
  const host = await api.register({ username: randomUsername('host') });
  const esp1 = await api.register({ username: randomUsername('esp1') });
  const esp2 = await api.register({ username: randomUsername('esp2') });

  const cookiesDe = async (u) => {
    const r = await fetch(`${server.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: u.username, password: 'Senha@Teste123' }),
    });
    return r.headers.getSetCookie();
  };
  const ckHost = await cookiesDe(host);
  const ckEsp1 = await cookiesDe(esp1);
  const ckEsp2 = await cookiesDe(esp2);

  // ============ A) o catalogo diz a verdade ================================
  const catalogo = await api.get('/api/live/effects');
  const efeitos = catalogo.body.effects || [];
  if (efeitos.length < 15) throw new Error(`catalogo com ${efeitos.length} efeitos (esperado 15)`);

  const comSom = efeitos.filter((e) => e.hasAudio && e.soundUrl);
  const semSom = efeitos.filter((e) => !e.hasAudio);
  if (!comSom.length) {
    throw new Error('nenhum efeito tem som - o item pede que alguns efeitos tenham audio real');
  }
  if (semSom.length && comSom.length + semSom.length !== efeitos.length) {
    throw new Error('ha efeitos com `hasAudio` mas sem `soundUrl` (contrato inconsistente)');
  }
  report.ok(`A) catalogo: ${efeitos.length} efeitos, ${comSom.length} com som real e `
    + `${semSom.length} sem som (${semSom.map((e) => e.slug).join(', ')})`);

  // Cada som e um arquivo de verdade: 200, bytes de audio e cabecalho RIFF.
  const chaves = new Set();
  for (const efeito of comSom) {
    const r = await fetch(`${server.baseUrl}${efeito.soundUrl}`, { headers: { Cookie: ckHost.join('; ') } });
    if (r.status !== 200) throw new Error(`${efeito.slug}: som respondeu ${r.status}`);
    const tipo = r.headers.get('content-type') || '';
    if (!/audio|wav|octet-stream/i.test(tipo)) {
      throw new Error(`${efeito.slug}: som servido como "${tipo}" (esperado audio)`);
    }
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 44) throw new Error(`${efeito.slug}: som com ${buf.length} bytes`);
    if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
      throw new Error(`${efeito.slug}: o arquivo nao e um WAV valido `
        + `("${buf.toString('ascii', 0, 4)}/${buf.toString('ascii', 8, 12)}")`);
    }
    // O audio tem energia de verdade: um WAV valido e silencioso nao serve.
    const amostras = new Int16Array(buf.buffer, buf.byteOffset + 44, Math.floor((buf.length - 44) / 2));
    let pico = 0;
    for (const v of amostras) pico = Math.max(pico, Math.abs(v));
    if (pico < 2000) throw new Error(`${efeito.slug}: som praticamente mudo (pico ${pico})`);
    const chave = efeito.soundUrl;
    chaves.add(chave);
    report.ok(`A) ${efeito.slug}: ${buf.length} bytes WAV, pico ${pico}, `
      + `duracao ${efeito.soundDurationMs ?? 'n/d'}ms`);
  }
  if (chaves.size !== comSom.length) {
    throw new Error(`${comSom.length} efeitos com som mas so ${chaves.size} arquivos distintos`);
  }
  report.ok(`E) ${chaves.size} arquivos de som DISTINTOS para ${comSom.length} efeitos com som`);

  // Efeitos sem som tambem nao tem arquivo apontado.
  for (const efeito of semSom) {
    if (efeito.soundUrl) throw new Error(`${efeito.slug}: sem som mas com soundUrl`);
  }

  // ============ LIVE com host + 2 espectadores ==============================
  const browser = await launchChrome({
    extraArgs: [
      '--autoplay-policy=no-user-gesture-required',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
    ],
  });
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

  // Instala um contador de `<audio>` criado/tocado, por cliente.
  const espiarAudio = (s) => s.eval(`
    window.__audios = [];
    if (!window.__espiaoAudio) {
      window.__espiaoAudio = true;
      const Real = window.Audio;
      window.Audio = function (src) {
        const a = new Real(src);
        window.__audios.push(a);
        const playOriginal = a.play.bind(a);
        a.play = function () {
          window.__tocados = (window.__tocados || 0) + 1;
          return playOriginal();
        };
        return a;
      };
      window.Audio.prototype = Real.prototype;
    }
    return true;
  `);

  const telas = [];
  try {
    const sHost = await sessao(ckHost, 1280, 900, false);
    telas.push(sHost);
    await sHost.goto(`${server.baseUrl}/iniciar-live`, { waitMs: 2600 });
    const clicou = await sHost.eval(`
      const b = [...document.querySelectorAll('button')].find((x) => /iniciar transmissao/i.test(x.textContent || ''));
      if (!b) return 'sem botao';
      b.click();
      return 'clicou';
    `);
    if (clicou !== 'clicou') throw new Error(`host nao iniciou: ${clicou}`);
    await sleep(5600);
    const sala = (await api.get(`/api/users/${host.id}/live`)).body.live;
    if (!sala?.id) throw new Error('a LIVE nao subiu');

    const sEsp1 = await sessao(ckEsp1, 390, 844, true);
    const sEsp2 = await sessao(ckEsp2, 414, 896, true);
    telas.push(sEsp1, sEsp2);
    await sEsp1.goto(`${server.baseUrl}/live/${sala.id}`, { waitMs: 3200 });
    await sEsp2.goto(`${server.baseUrl}/live/${sala.id}`, { waitMs: 3200 });

    for (const s of [sHost, sEsp1, sEsp2]) await espiarAudio(s);
    report.ok('contador de audio instalado nos tres clientes');

    // Aplica um efeito COM som a partir do navegador de cada um (rotativo, para
    // respeitar o limite diario de 10 por usuario).
    const comSomAte = comSom.slice(0, 3);
    let rot = 0;
    const telasRot = [sEsp1, sHost, sEsp2];
    const ativar = async (efeito) => {
      const tela = telasRot[rot % telasRot.length];
      rot += 1;
      const r = await tela.eval(`
        const csrf = (document.cookie.split(';').find((c) => c.trim().startsWith('pulse_csrf=')) || '').split('=')[1] || '';
        const resp = await fetch('/api/live/${sala.id}/effects', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': decodeURIComponent(csrf) },
          body: JSON.stringify({ effectId: ${JSON.stringify(efeito.id)}, clientEventId: 'som-${Date.now()}-${rot}' }),
        });
        return { status: resp.status, body: await resp.json() };
      `);
      if (r.status >= 400) throw new Error(`efeito recusado (${r.status}): ${JSON.stringify(r.body).slice(0, 200)}`);
      return r.body;
    };

    // ============ B) o som toca nos tres, uma vez por evento ================
    for (const efeito of comSomAte) {
      for (const s of [sHost, sEsp1, sEsp2]) {
        // eslint-disable-next-line no-await-in-loop
        await s.eval('window.__tocados = 0; window.__audios = []; return true;');
      }
      // eslint-disable-next-line no-await-in-loop
      const evento = await ativar(efeito);
      if (evento.payload?.effect?.hasAudio !== true || !evento.payload?.effect?.soundUrl) {
        throw new Error(`o evento de "${efeito.slug}" nao traz som real`);
      }
      await sleep(2600);
      for (const [nome, s] of [['host', sHost], ['esp1', sEsp1], ['esp2', sEsp2]]) {
        // eslint-disable-next-line no-await-in-loop
        const medido = await s.eval(`
          return {
            criados: (window.__audios || []).length,
            tocados: window.__tocados || 0,
            src: (window.__audios || [])[0] ? (window.__audios[0].src || '').split('?')[0] : null,
            tocando: (window.__audios || [])[0] ? !window.__audios[0].paused : null,
            volume: (window.__audios || [])[0] ? window.__audios[0].volume : null,
            instancias: document.querySelectorAll('.effect-instance').length,
          };
        `);
        if (medido.criados < 1) {
          throw new Error(`${nome} (${efeito.slug}): nenhum <audio> criado pelo efeito com som`);
        }
        if (medido.criados > 1) {
          throw new Error(`${nome} (${efeito.slug}): ${medido.criados} audios para UM evento `
            + '(som duplicado)');
        }
        if (medido.tocados < 1) {
          throw new Error(`${nome} (${efeito.slug}): o audio foi criado mas nunca tocado`);
        }
        if (medido.tocados > 1) {
          throw new Error(`${nome} (${efeito.slug}): o som tocou ${medido.tocados}x no mesmo evento`);
        }
        if (medido.volume !== null && (medido.volume <= 0 || medido.volume > 1)) {
          throw new Error(`${nome} (${efeito.slug}): volume invalido ${medido.volume}`);
        }
        report.ok(`B) ${nome} (${efeito.slug}): 1 audio criado, ${medido.tocados}x tocado, `
          + `volume ${medido.volume}, ${medido.instancias} instancia(s) na tela`);
      }
    }

    // ============ C) catalogo nao pode mais ter efeito mudo ================
    // Antes, alguns efeitos existiam sem audio (e o caso C provava que nada
    // toca). A solicitacao do item 1 pede que TODO efeito tenha audio real -
    // portanto um efeito com hasAudio=false e DEFEITO, nao caso-valido.
    if (semSom.length) {
      throw new Error(`${semSom.length} efeito(s) sem som: ${semSom.map((e) => e.slug).join(', ')}`);
    }
    report.ok(`C) todos os ${efeitos.length} efeitos tem audio real declarado`);

    // ============ D) respeita o mudo ======================================
    const comSomDepois = comSom[3] || comSom[0];
    // Desliga pelo botao real do menu de configuracoes da LIVE.
    for (const [nome, s, rotulo] of [['host', sHost, 'Encerrar LIVE'], ['esp1', sEsp1, 'Sair da LIVE']]) {
      // eslint-disable-next-line no-await-in-loop
      const abriu = await s.eval(`
        window.__erroMenu = null;
        addEventListener('error', (e) => { window.__erroMenu = String(e.message || e); }, { once: true });
        const b = document.querySelector('.live-settings-btn')
          || [...document.querySelectorAll('button')].find((x) => /Configuracoes/i.test(x.getAttribute('aria-label') || ''));
        if (!b) return 'sem botao de menu';
        b.click();
        await new Promise((r) => setTimeout(r, 400));
        const raiz = document.getElementById('modal-root');
        return {
          resultado: 'clicou',
          filhosDaRaiz: raiz ? raiz.children.length : -1,
          erro: window.__erroMenu,
          htmlRaiz: raiz ? raiz.innerHTML.slice(0, 260) : '(sem modal-root)',
        };
      `);
      if (abriu.resultado !== 'clicou') throw new Error(`${nome}: nao achou o menu da LIVE (${rotulo})`);
      if (abriu.filhosDaRaiz < 1) {
        throw new Error(`${nome}: o clique no menu nao abriu nada `
          + `(filhos=${abriu.filhosDaRaiz}, erro="${abriu.erro}", raiz=${JSON.stringify(abriu.htmlRaiz)})`);
      }
      // eslint-disable-next-line no-await-in-loop
      await sleep(700);
      // eslint-disable-next-line no-await-in-loop
      const estado = await s.eval(`
        const modal = document.querySelector('.modal, [role="dialog"]');
        const titulo = (document.querySelector('.modal-title, .modal h2, .modal h3, [role="dialog"] h2')?.textContent || '').trim();
        const itens = [...document.querySelectorAll('.live-config-item')].map((b) => (b.textContent || '').trim());
        const item = [...document.querySelectorAll('.live-config-item')]
          .find((b) => /Som dos efeitos/i.test(b.textContent || ''));
        if (!item) return 'sem item de som';
        const antes = item.getAttribute('aria-pressed');
        item.click();
        const depois = item.getAttribute('aria-pressed');
        return { antes, depois, texto: item.querySelector('.live-config-estado')?.textContent || '', titulo, itens, temModal: Boolean(modal) };
      `);
      if (estado === 'sem item de som') {
        const vis = await s.eval(`
          return {
            titulos: [...document.querySelectorAll('.modal-title, .modal h2, .modal h3, [role="dialog"] h2')].map((n) => (n.textContent || '').trim()),
            itens: [...document.querySelectorAll('.live-config-item, .modal button')].map((b) => (b.textContent || '').trim()).slice(0, 12),
            modais: document.querySelectorAll('.modal, [role="dialog"]').length,
          };
        `);
        throw new Error(`${nome}: o menu nao tem o item de som; o que abriu foi ${JSON.stringify(vis)}`);
      }
      if (estado.antes === estado.depois) {
        throw new Error(`${nome}: clicar no item de som nao mudou o estado (${estado.antes})`);
      }
      report.ok(`D) ${nome}: menu trocou o som para "${estado.texto}" (aria-pressed ${estado.antes} -> ${estado.depois})`);
    }
    // Com o som desligado nos dois, dispara outro efeito com som: nada toca.
    for (const s of [sHost, sEsp1]) {
      // eslint-disable-next-line no-await-in-loop
      await s.eval('window.__tocados = 0; window.__audios = []; return true;');
    }
    // eslint-disable-next-line no-await-in-loop
    await ativar(comSomDepois);
    await sleep(2400);
    for (const [nome, s] of [['host', sHost], ['esp1', sEsp1]]) {
      // eslint-disable-next-line no-await-in-loop
      const m = await s.eval(`
        return {
          criados: (window.__audios || []).length,
          tocados: window.__tocados || 0,
          inst: document.querySelectorAll('.effect-instance').length,
        };
      `);
      if (m.criados !== 0 || m.tocados !== 0) {
        throw new Error(`${nome}: com o som DESLIGADO o efeito ainda tocou `
          + `(${m.criados} criado(s), ${m.tocados} tocado(s))`);
      }
      if (m.inst < 1) {
        throw new Error(`${nome}: desligar o som nao pode sumir com a ANIMACAO do efeito`);
      }
    }
    report.ok('D) com o som desligado, nenhum audio e criado e a animacao continua aparecendo');

    // Religa: volta a tocar.
    for (const s of [sHost, sEsp1]) {
      // eslint-disable-next-line no-await-in-loop
      await s.eval(`
        const item = [...document.querySelectorAll('.live-config-item')]
          .find((b) => /Som dos efeitos/i.test(b.textContent || ''));
        if (item) item.click();
        window.__tocados = 0; window.__audios = [];
        return true;
      `);
      // eslint-disable-next-line no-await-in-loop
      await sleep(400);
    }
    // eslint-disable-next-line no-await-in-loop
    await ativar(comSom[4] || comSom[0]);
    await sleep(2400);
    for (const [nome, s] of [['host', sHost], ['esp1', sEsp1]]) {
      // eslint-disable-next-line no-await-in-loop
      const m = await s.eval(`
        return { criados: (window.__audios || []).length, tocados: window.__tocados || 0 };
      `);
      if (m.criados < 1 || m.tocados < 1) {
        throw new Error(`${nome}: religar o som nao fez o efeito tocar de novo`);
      }
    }
    report.ok('D) religar o som volta a tocar o efeito nos dois clientes');

    // O arquivo em disco existe (fonte real, nao gerado em tempo de execucao).
    const dir = path.resolve(ROOT, 'anima\u00e7\u00e3o', 'sons');
    const wavs = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.wav')) : [];
    if (wavs.length < 1) throw new Error(`nenhum WAV em ${dir}`);
    report.ok(`arquivos de origem em animacao/sons/: ${wavs.length} WAV(s), `
      + `gerados por scripts/generate-live-gifts.mjs`);

    report.ok('som dos efeitos: arquivo real, toca em todos uma vez, sem som nao finge, respeita mudo');
  } catch (error) {
    report.fail('verificacao do som dos efeitos interrompida', error);
  } finally {
    for (const s of telas) { try { s.close?.(); } catch { /* ignore */ } }
    await browser.close();
    await server.stop();
  }
  return report.summary();
}

run().then((r) => process.exit(r.failed > 0 ? 1 : 0)).catch((e) => { console.error(e); process.exit(1); });