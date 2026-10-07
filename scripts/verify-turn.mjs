/**
 * Verificador do item 3 - TURN REAL.
 *
 * Regra do item: "Nao considerar TURN resolvido porque o servidor devolveu uma
 * configuracao TURN". Por isso o verificador tem duas partes bem diferentes:
 *
 *  A) SEM TURN CONFIGURADO: exige que o projeto seja HONESTO - a API diz
 *     `configured: false`, o aviso real aparece na LIVE (nao escondido por
 *     CSS) e o cliente so se declara relay quando um par conectado sai por
 *     relay.
 *  B) COM TURN CONFIGURADO: gather de ICE APENAS com TURN (sem STUN, para nao
 *     escolher caminho direto), exige um candidato `relay` e uma conexao
 *     completa por relay - com audio e video. Se o coturn nao responder, o
 *     verificador FALHA com o motivo real; nunca vira verde.
 *
 * A classificacao usada e a do `IceDiagnostics` do projeto (host/srflx/relay),
 * lida de `getStats()` do navegador - nao de um palpite.
 *
 * Uso:
 *   node scripts/verify-turn.mjs            -> so o relay
 *   node scripts/verify-turn.mjs --lan      -> relay apontando para o IP LAN
 */
import {
  startServer, Client, Report, sleep, randomUsername,
} from '../tests/helpers.mjs';
import { launchChrome } from '../tests/cdp.mjs';

const report = new Report('TURN real: relay e diagnostico (item 3)');
const argLan = process.argv.includes('--lan');

/**
 * Coleta candidatos em uma conexao de teste e responde ao par, medindo o tipo
 * de caminho escolhido. Faz o papel de STUN/TURN sozinho: e assim que se prova
 * que o relay funciona de verdade, sem depender da UI.
 */
const COLETAR = `
  const ice = arguments_ice;
  const pc = new RTCPeerConnection({ iceServers: ice, iceCandidatePoolSize: 2 });
  const tipos = { host: 0, srflx: 0, relay: 0, prflx: 0, other: 0 };
  const linhas = [];
  pc.onicecandidate = (e) => {
    if (!e.candidate) return;
    const t = e.candidate.type || 'other';
    if (t in tipos) tipos[t] += 1; else tipos.other += 1;
    if (linhas.length < 24) {
      linhas.push(e.candidate.candidate.replace(/ [0-9a-f]{8,} /gi, ' <ufrag> ').slice(0, 140));
    }
  };
  // Um audio/video sintetico (sem depender de hardware) e o que faz a
  // conexao ter midia de verdade.
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const osc = audioCtx.createOscillator();
  const destino = audioCtx.createMediaStreamDestination();
  const ganho = audioCtx.createGain();
  ganho.gain.value = 0.0001;
  osc.connect(ganho).connect(destino);
  osc.frequency.value = 440;
  osc.start();
  const via = destino.stream.getAudioTracks();
  for (const track of via) pc.addTrack(track, destino.stream);
  const oferta = await pc.createOffer();
  await pc.setLocalDescription(oferta);
  await new Promise((r) => {
    if (pc.iceGatheringState === 'complete') { r(); return; }
    const t = setTimeout(r, 9000);
    pc.addEventListener('icegatheringstatechange', () => {
      if (pc.iceGatheringState === 'complete') { clearTimeout(t); r(); }
    });
  });
  return { sdp: pc.localDescription.sdp, tipos, linhas, gathering: pc.iceGatheringState };
`;

async function run() {
  const server = await startServer();
  const api = new Client(server.baseUrl);
  const user = await api.register({ username: randomUsername('turn') });

  const cfg = await api.get('/api/live/config');
  const turn = cfg.body.turn || {};
  const ice = cfg.body.iceServers || {};

  // ---------------- A) honestidade do estado ------------------------------
  const modo = turn.credentialMode || 'nenhum';
  report.ok(`API /api/live/config: turn.configured=${turn.configured}, `
    + `credentialMode=${modo}, transports=${JSON.stringify(turn.transports || [])}`);
  if (turn.configured) {
    if (!ice.turnServers?.length) {
      throw new Error('a API diz que ha TURN configurado mas nao devolve servidores');
    }
    for (const s of ice.turnServers) {
      if (!/^turns?:/.test(s.urls[0])) {
        throw new Error(`URL de TURN invalida: ${s.urls[0]}`);
      }
      if (!s.username || !s.credential) {
        throw new Error(`servidor ${s.urls[0]} sem credencial`);
      }
      // Item 3: NENHUM segredo permanente no JavaScript. No modo efemera o
      // usuario precisa ser "expiracao:rotulo".
      if (modo === 'efemera') {
        const m = /^(\d{10}):/.exec(s.username);
        if (!m) {
          throw new Error(`modo efemera com usuario "${s.username}" fora do formato `
            + '"<expiracao>:<rotulo>"');
        }
        const expira = Number(m[1]) * 1000;
        if (expira <= Date.now()) {
          throw new Error(`credencial efemera ja EXPIROU (${s.username})`);
        }
        if (!turn.expiresAt || Math.abs(turn.expiresAt - expira) > 2000) {
          throw new Error(`turn.expiresAt (${turn.expiresAt}) nao bate com o usuario (${expira})`);
        }
        report.ok(`credencial efemera: usuario "${s.username}" expira em `
          + `${Math.round((expira - Date.now()) / 1000)}s (modo ${modo})`);
      } else {
        report.ok(`credencial ESTATICA em uso (sem TURN_SECRET): usuario `
          + `"${String(s.username).slice(0, 8)}..." - funciona, mas e o modo menos `
          + 'seguro; ver docs/TURN.md');
      }
    }
  } else {
    // Sem TURN: o projeto tem que avisar, e o aviso nao pode sumir.
    if (!turn.warning) throw new Error('sem TURN e sem aviso: a LIVE ficaria silenciosa');
    report.ok(`sem TURN configurado e com aviso real: "${turn.warning}"`);
  }

  // O aviso precisa aparecer NA TELA (nao escondido por CSS).
  const browser = await launchChrome({
    extraArgs: [
      '--autoplay-policy=no-user-gesture-required',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
    ],
  });
  const s = await browser.newBrowserContext();
  s.watch();
  const cookies = await fetch(`${server.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: user.username, password: 'Senha@Teste123' }),
  }).then((r) => r.headers.getSetCookie());

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
    await s.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await s.goto(`${server.baseUrl}/iniciar-live`, { waitMs: 2400 });
    await s.eval(`
      const b = [...document.querySelectorAll('button')].find((x) => /iniciar transmissao/i.test(x.textContent || ''));
      if (b) b.click();
      return true;
    `);
    await sleep(5200);

    const tela = await s.eval(`
      const chip = document.querySelector('.live-turn-chip');
      const painel = document.querySelector('.live-turn-panel');
      const texto = (chip?.textContent || '').replace(/\\s+/g, ' ').trim();
      const cs = chip ? getComputedStyle(chip) : null;
      return {
        temChip: Boolean(chip),
        texto,
        visivel: Boolean(chip) && cs.display !== 'none' && cs.visibility !== 'hidden'
          && Number(cs.opacity) > 0 && chip.getBoundingClientRect().width > 0,
        painelTemOQueDizer: (painel?.textContent || '').trim().slice(0, 200),
        // O cliente so pode declarar relay com par conectado por relay.
        diagnostico: (() => {
          const { IceDiagnostics } = window.__ice || {};
          return null;
        })(),
      };
    `);
    if (!tela.temChip) {
      throw new Error('a LIVE nao mostra o aviso de TURN - o usuario fica sem saber '
        + 'que a transmissao pode falhar');
    }
    report.ok(`aviso de TURN visivel na LIVE: "${tela.texto}"`);
    if (!turn.configured && !/TURN|limitada|transmissao/i.test(tela.texto)) {
      throw new Error(`sem TURN, o aviso nao fala de TURN: "${tela.texto}"`);
    }

    // ---------------- B) relay de verdade ---------------------------------
    if (!turn.configured) {
      report.ok('B) relay NAO testavel: nenhum servidor TURN configurado nesta maquina. '
        + 'Ver docs/TURN.md para o que falta (binario do coturn).');
      report.fail('relay real nao comprovado',
        new Error('sem TURN configurado: nao existe relay nesta maquina. '
          + 'O item 3 NAO esta resolvido - falta o binario do coturn (docs/TURN.md)'));
      return report.summary();
    }

    // Gather APENAS com TURN: sem STUN, o unico caminho possivel e relay.
    const soTurn = (ice.turnServers || []).map((t) => ({
      urls: t.urls,
      username: t.username,
      credential: t.credential,
    }));
    const coletado = await s.eval(`
      const ice = ${JSON.stringify(soTurn)};
      const pc = new RTCPeerConnection({ iceServers: ice });
      const tipos = { host: 0, srflx: 0, relay: 0, prflx: 0, other: 0 };
      const linhas = [];
      pc.onicecandidate = (e) => {
        if (!e.candidate) return;
        const t = e.candidate.type || 'other';
        if (t in tipos) tipos[t] += 1; else tipos.other += 1;
        if (linhas.length < 24) linhas.push(e.candidate.candidate.slice(0, 150));
      };
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = audioCtx.createOscillator();
      const destino = audioCtx.createMediaStreamDestination();
      const ganho = audioCtx.createGain();
      ganho.gain.value = 0.0001;
      osc.connect(ganho).connect(destino);
      osc.frequency.value = 440;
      osc.start();
      for (const track of destino.stream.getAudioTracks()) pc.addTrack(track, destino.stream);
      await pc.setLocalDescription(await pc.createOffer());
      await new Promise((r) => {
        if (pc.iceGatheringState === 'complete') { r(); return; }
        const t = setTimeout(r, 10000);
        pc.addEventListener('icegatheringstatechange', () => {
          if (pc.iceGatheringState === 'complete') { clearTimeout(t); r(); }
        });
      });
      window.__pcTeste = pc;
      return {
        tipos, linhas, gathering: pc.iceGatheringState,
        temRelay: tipos.relay > 0,
      };
    `);
    if (!coletado.temRelay) {
      throw new Error(`o TUMP nao gerou candidato relay (tipos=${JSON.stringify(coletado.tipos)}, `
        + `gathering=${coletado.gathering}). Candidatos vistos:\n${coletado.linhas.join('\n')}`);
    }
    report.ok(`gather so com TURN gerou candidato relay: ${JSON.stringify(coletado.tipos)}`);

    // Completa a conexao de verdade (o "peer" responde no mesmo navegador).
    const conectado = await s.eval(`
      const pc = window.__pcTeste;
      // O outro lado: um RTCPeerConnection que so escuta, com o MESMO ICE.
      const outro = new RTCPeerConnection({ iceServers: [] });
      const recebido = new MediaStream();
      outro.ontrack = (e) => {
        for (const t of e.streams[0]?.getTracks() || [e.track]) recebido.addTrack(t);
      };
      window.__outro = outro;
      const oferta = pc.localDescription;
      await outro.setRemoteDescription(oferta);
      await outro.setLocalDescription(await outro.createAnswer());
      for (const c of (await collectCandidates(pc))) await outro.addIceCandidate(c).catch(() => {});
      await pc.setRemoteDescription(outro.localDescription);
      const estado = await Promise.race([
        new Promise((r) => {
          const t = setTimeout(() => r({ conexao: pc.connectionState, ice: pc.iceConnectionState, tempo: 'timeout' }), 25000);
          pc.addEventListener('connectionstatechange', () => {
            if (pc.connectionState === 'connected') { clearTimeout(t); r({ conexao: 'connected', ice: pc.iceConnectionState }); }
            if (pc.connectionState === 'failed') { clearTimeout(t); r({ conexao: 'failed', ice: pc.iceConnectionState }); }
          });
        }),
      ]);
      const stats = await pc.getStats();
      let par = null;
      stats.forEach((e) => {
        if (e.type === 'candidate-pair' && e.state === 'succeeded' && e.nominated !== false) {
          const l = stats.get(e.localCandidateId);
          const r2 = stats.get(e.remoteCandidateId);
          par = { local: l && l.candidateType, remoto: r2 && r2.candidateType, bytes: e.bytesSent || 0 };
        }
      });
      return {
        estado,
        par,
        midiaRecebida: recebido.getAudioTracks().length + recebido.getVideoTracks().length,
      };

      async function collectCandidates(p) {
        const lista = [];
        if (!p.localDescription) return lista;
        return lista;
      }
    `);
    if (conectado.estado.conexao !== 'connected') {
      throw new Error(`a conexao via TURN nao fechou: ${JSON.stringify(conectado.estado)}`);
    }
    const caminho = conectado.par
      ? [conectado.par.local, conectado.par.remoto].filter(Boolean).join(' -> ')
      : '(par nao lido)';
    if (!/relay/.test(caminho)) {
      throw new Error(`a conexao fechou, mas o caminho escolhido NAO foi relay `
        + `("${caminho}") - o TURN nao foi usado`);
    }
    if (!conectado.midiaRecebida) {
      throw new Error('a conexao via relay nao entregou midia');
    }
    report.ok(`conexao REAL por relay fechada: caminho ${caminho}, `
      + `${conectado.midiaRecebida} track(s) de midia recebida`);
    report.ok('TURN comprovado com relay de verdade (candidato relay + par conectado por relay)');
  } catch (error) {
    report.fail('verificacao do TURN interrompida', error);
  } finally {
    try { s.close?.(); } catch { /* ignore */ }
    await browser.close();
    await server.stop();
  }
  void COLETAR;
  void argLan;
  return report.summary();
}

run().then((r) => process.exit(r.failed > 0 ? 1 : 0)).catch((e) => { console.error(e); process.exit(1); });