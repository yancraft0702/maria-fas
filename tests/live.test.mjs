/**
 * Testes de LIVE: ciclo completo da sala, sinalizacao WebRTC (SDP/ICE reais
 * entre dois sockets), limites, moderacao com janelas fixas e integridade dos
 * efeitos (arquivo real + parametro de remocao de fundo).
 */
import {
  startServer, Client, RealtimeClient, Report, sleep, randomUsername, makeTestImage,
} from './helpers.mjs';
import { createHash } from 'node:crypto';

const report = new Report('LIVE');

async function run() {
  await report.step('TURN configurado por ambiente chega a ICE e remove o aviso', async () => {
    const turnServer = await startServer({
      env: {
        TURN_URLS: 'turn:turn.example.test:3478?transport=udp,turns:turn.example.test:5349?transport=tcp',
        TURN_USERNAME: 'turn-test-user',
        TURN_CREDENTIAL: 'turn-test-credential',
      },
    });
    try {
      const client = new Client(turnServer.baseUrl);
      await client.register({ username: randomUsername('turn') });
      const { status, body } = await client.get('/api/live/config');
      if (status !== 200) throw new Error(`config retornou HTTP ${status}`);
      if (body.turn.configured !== true) throw new Error('TURN nao foi reconhecido como configurado');
      if (body.turn.warning !== null) throw new Error('aviso continua visivel com TURN configurado');
      if (body.turn.credentialMode !== 'estatica') {
        throw new Error(`modo de credencial inesperado: ${body.turn.credentialMode}`);
      }
      const turn = body.iceServers.turnServers;
      if (!Array.isArray(turn) || turn.length !== 2) throw new Error('URLs TURN nao chegaram ao cliente');
      if (turn.some((entry) => entry.username !== 'turn-test-user'
        || entry.credential !== 'turn-test-credential')) {
        throw new Error('credenciais TURN ausentes ou incorretas na configuracao autenticada');
      }
      return `${turn.length} URLs TURN; aviso oculto; credenciais entregues pelo endpoint autenticado`;
    } finally {
      await turnServer.stop();
    }
  });

  const server = await startServer();
  report.ok('servidor no ar', server.baseUrl);
  const sockets = [];
  const track = (s) => { sockets.push(s); return s; };

  try {
    const host = new Client(server.baseUrl);
    await host.register({ username: randomUsername('host') });
    const viewer = new Client(server.baseUrl);
    await viewer.register({ username: randomUsername('viewer') });
    const viewer2 = new Client(server.baseUrl);
    await viewer2.register({ username: randomUsername('viewer2') });
    const avatars = {};
    await report.step('upload de duas fotos de perfil distintas para teste da LIVE', async () => {
      const [hostImage, viewerImage] = await Promise.all([
        makeTestImage({ width: 96, height: 96, color: 'red' }),
        makeTestImage({ width: 96, height: 96, color: 'green' }),
      ]);
      for (const [client, image, key] of [[host, hostImage, 'host'], [viewer, viewerImage, 'viewer']]) {
        const uploaded = await client.upload('/api/users/me/avatar', image.buffer, {
          filename: image.filename, mime: image.mime, field: 'image',
        });
        if (uploaded.status !== 200 || !uploaded.body.user.avatarUrl) {
          throw new Error(`${key}: falha no upload do avatar (${uploaded.status})`);
        }
        avatars[key] = uploaded.body.user.avatarUrl;
      }
      return 'host e espectador têm avatares reais diferentes';
    });

    // ------------------------------------------------------------ CATALOGO
    await report.step('config da LIVE expoe ICE real e o aviso de TURN', async () => {
      const { body } = await viewer.get('/api/live/config');
      if (!Array.isArray(body.iceServers.iceServers)) throw new Error('sem ICE servers');
      if (!body.iceServers.iceServers.length) throw new Error('lista de ICE vazia (precisa de STUN)');
      const stun = body.iceServers.iceServers.some((s) => JSON.stringify(s.urls).includes('stun'));
      if (!stun) throw new Error('STUN ausente');
      if (body.turn.warning && !/TURN/.test(body.turn.warning)) throw new Error('aviso de TURN incoerente');
      if (body.turn.configured && body.turn.warning) throw new Error('aviso de TURN com TURN configurado');
      return `${body.iceServers.iceServers.length} servidores ICE, turn=${body.turn.configured}`;
    });

    let effectsPayload = null;
    await report.step('catalogo contem exatamente 15 presentes animados com audio proprio', async () => {
      const { body } = await viewer.get('/api/live/effects');
      if (body.effects.length !== 15) throw new Error(`catalogo com ${body.effects.length} presentes`);
      const soundHashes = new Set();
      for (const effect of body.effects) {
        if (!effect.mediaUrl) throw new Error(`efeito ${effect.slug} sem arquivo`);
        if (!effect.alphaReady || effect.format !== 'svg') {
          throw new Error(`efeito ${effect.slug} sem SVG transparente (${effect.format}, alpha=${effect.alphaReady})`);
        }
        if (!effect.hasAudio || !effect.soundUrl) throw new Error(`efeito ${effect.slug} sem som proprio`);
        const visual = await fetch(`${server.baseUrl}${effect.mediaUrl}`);
        const markup = await visual.text();
        if (visual.status !== 200 || visual.headers.get('content-type') !== 'image/svg+xml') {
          throw new Error(`SVG ${effect.slug}: HTTP ${visual.status}, ${visual.headers.get('content-type')}`);
        }
        if (visual.headers.has('content-disposition')) throw new Error(`SVG ${effect.slug} foi servido como anexo`);
        if (!visual.headers.has('content-security-policy') || !/<animate/.test(markup) || /<rect\b/i.test(markup)) {
          throw new Error(`SVG ${effect.slug} sem animação transparente isolada`);
        }
        const sound = await fetch(`${server.baseUrl}${effect.soundUrl}`);
        const wav = Buffer.from(await sound.arrayBuffer());
        if (sound.status !== 200 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
          throw new Error(`áudio WAV inválido para ${effect.slug}`);
        }
        const duration = Math.round((wav.readUInt32LE(40) / wav.readUInt32LE(28)) * 1000);
        if (Math.abs(duration - effect.durationMs) > 2) throw new Error(`áudio ${effect.slug} dura ${duration}ms`);
        if (Math.abs(effect.soundDurationMs - duration) > 2) {
          throw new Error(`duração publicada do áudio ${effect.slug}: ${effect.soundDurationMs}ms`);
        }
        soundHashes.add(createHash('sha256').update(wav).digest('hex'));
      }
      if (soundHashes.size !== 15) throw new Error(`apenas ${soundHashes.size} áudios distintos`);
      effectsPayload = body.effects;
      return '15 SVGs animados transparentes e 15 WAVs únicos com duração de 3,8s';
    });

    await report.step('SVG animado entrega transparência e política segura no navegador', async () => {
      const effect = effectsPayload[0];
      if (!effect.mediaUrl) throw new Error('efeito sem midia');
      const res = await fetch(`${server.baseUrl}${effect.mediaUrl}`);
      if (res.status !== 200) throw new Error(`status ${res.status}`);
      const svg = await res.text();
      if (!svg.startsWith('<svg') || !svg.includes('<animate')) throw new Error('SVG não tem animação');
      if (/<rect\b/i.test(svg) || /background\s*:/i.test(svg)) throw new Error('asset SVG contém fundo opaco');
      if (!effect.alphaReady) throw new Error('API nao sinaliza alphaReady');
      if (effect.chromaKey) throw new Error('API ainda expoe chromaKey na GPU');
      if (!res.headers.has('content-security-policy')) throw new Error('SVG sem CSP restritiva');
      return 'image/svg+xml animado, sem fundo, CSP restritiva e alphaReady=true';
    });

    // ---------------------------------------------------------- CICLO DA LIVE
    let roomId = null;
    await report.step('ciclo da sala: criar, entrar, sair, encerrar', async () => {
      const created = await host.post('/api/live', { title: 'LIVE de teste', category: 'geral' });
      if (created.status !== 201) throw new Error(`criacao ${created.status}`);
      roomId = created.body.room.id;
      if (created.body.room.status !== 'live') throw new Error('sala nao nasceu ativa');

      const join = await viewer.post(`/api/live/${roomId}/join`, {});
      if (join.body.viewerCount !== 1) throw new Error(`contagem ${join.body.viewerCount}`);
      if (!join.body.iceServers) throw new Error('ICE ausente no join');

      // Reconectar nao duplica participacao
      const again = await viewer.post(`/api/live/${roomId}/join`, { reconnect: true });
      if (again.body.viewerCount !== 1) throw new Error(`reconexao duplicou: ${again.body.viewerCount}`);

      await viewer2.post(`/api/live/${roomId}/join`, {});
      const list = await host.get(`/api/live/${roomId}/viewers`);
      if (list.body.viewers.length !== 2) throw new Error(`espectadores ${list.body.viewers.length}`);
      if (list.body.viewers.some((v) => v.id === host.user.id)) throw new Error('host na lista');
      const viewerEntry = list.body.viewers.find((v) => v.id === viewer.user.id);
      if (viewerEntry?.avatarUrl !== avatars.viewer) throw new Error('avatar do espectador nao veio na lista');
      if (list.body.host?.avatarUrl !== avatars.host) throw new Error('avatar do host nao veio na lista');
      for (const url of [viewerEntry.avatarUrl, list.body.host.avatarUrl]) {
        const response = await host.get(url, { raw: true });
        if (response.status !== 200) throw new Error(`avatar da lista nao abre: HTTP ${response.status}`);
      }

      const leave = await viewer2.post(`/api/live/${roomId}/leave`, {});
      if (leave.body.viewerCount !== 1) throw new Error(`apos saida ${leave.body.viewerCount}`);

      return `contagem e lista consistentes (${list.body.viewerCount})`;
    });

    await report.step('avatars corretos em comentarios da LIVE via realtime nos dois sentidos', async () => {
      const hostWs = track(await new RealtimeClient(server.wsUrl, host).connect());
      const viewerWs = track(await new RealtimeClient(server.wsUrl, viewer).connect());
      hostWs.subscribe(`live:${roomId}`);
      viewerWs.subscribe(`live:${roomId}`);
      await sleep(250);
      hostWs.clear();
      viewerWs.clear();

      await viewer.post(`/api/live/${roomId}/messages`, { body: 'comentario do espectador' });
      const fromViewer = await hostWs.waitFor((event) => event.type === 'LIVE_COMMENT');
      if (fromViewer.payload?.message?.author?.avatarUrl !== avatars.viewer) {
        throw new Error('host recebeu comentario realtime sem avatar correto do espectador');
      }
      await host.post(`/api/live/${roomId}/messages`, { body: 'comentario do host' });
      const fromHost = await viewerWs.waitFor((event) => event.type === 'LIVE_COMMENT'
        && event.payload?.message?.text === 'comentario do host');
      if (fromHost.payload?.message?.author?.avatarUrl !== avatars.host) {
        throw new Error('espectador recebeu comentario realtime sem avatar correto do host');
      }
      return 'avatar do autor preservado na mensagem realtime A→B e B→A';
    });

    // --------------------------------------------------------- CHAT VISIVEL
    await report.step('chat da LIVE mantem ~10 mensagens visiveis, banco intacto', async () => {
      for (let i = 0; i < 16; i += 1) {
        await viewer.post(`/api/live/${roomId}/messages`, { body: `mensagem ${i}` });
      }
      const persisted = await viewer.get(`/api/live/${roomId}/messages`, { query: { limit: 50 } });
      if (persisted.body.messages.length < 16) {
        throw new Error(`historico apagado: ${persisted.body.messages.length}/16`);
      }
      const room = await host.get(`/api/live/${roomId}`);
      if (room.body.room.commentCount < 16) throw new Error(`contador ${room.body.room.commentCount}`);
      return `${persisted.body.messages.length} no banco (UI limita a 10 na tela)`;
    });

    await report.step('comentario da LIVE notifica o anfitriao', async () => {
      const notifs = await host.get('/api/notifications');
      const liveNotif = notifs.body.notifications.find((n) => n.type === 'live_comment');
      if (!liveNotif) throw new Error('sem notificacao de comentario na LIVE');
      return 'notificacao criada';
    });

    // ------------------------------------------------------------- CORACOES
    await report.step('coracoes ilimitados e independentes da cota de efeitos', async () => {
      const before = await host.get(`/api/live/${roomId}`);
      const start = before.body.room.heartCount;
      // 1 toque = 1 like
      await viewer.post(`/api/live/${roomId}/hearts`, { quantity: 1 });
      // 8 toques = 8 likes
      await viewer.post(`/api/live/${roomId}/hearts`, { quantity: 8 });
      const after = await host.get(`/api/live/${roomId}`);
      if (after.body.room.heartCount !== start + 9) {
        throw new Error(`heartCount ${after.body.room.heartCount} (esperava ${start + 9})`);
      }
      // Nao consume cota: 9 coracoes, cota de efeitos intacta
      const effects = await viewer.get('/api/live/effects');
      if (effects.body.used > 0) throw new Error(`coracao consumiu cota de efeitos (${effects.body.used})`);
      return '1 + 8 = 9 likes, cota intacta';
    });

    await report.step('coracao exige estar na LIVE', async () => {
      const outsider = new Client(server.baseUrl);
      await outsider.register({ username: randomUsername('out') });
      const res = await outsider.post(`/api/live/${roomId}/hearts`, { quantity: 1 });
      if (res.status !== 403) throw new Error(`esperava 403, recebeu ${res.status}`);
    });

    // --------------------------------------------------------------- EFEITOS
    await report.step('efeito: idempotencia, sequence e payload real', async () => {
      const effects = await viewer.get('/api/live/effects');
      const effect = effects.body.effects[0];
      const first = await viewer.post(`/api/live/${roomId}/effects`, {
        effectId: effect.id, clientEventId: 'live-idem-1',
      });
      if (first.status !== 201) throw new Error(`status ${first.status}`);
      if (!first.body.payload?.eventId) throw new Error('payload sem eventId');
      if (!Number.isFinite(first.body.payload.sequence)) throw new Error('payload sem sequence');
      if (first.body.payload.effect.slug !== effect.slug) throw new Error('slug divergente');

      const dup = await viewer.post(`/api/live/${roomId}/effects`, {
        effectId: effect.id, clientEventId: 'live-idem-1',
      });
      if (dup.status !== 200 || dup.body.duplicate !== true) throw new Error('idempotencia quebrada');

      // Sequence crescente entre eventos distintos
      const other = effects.body.effects[1];
      const second = await viewer.post(`/api/live/${roomId}/effects`, {
        effectId: other.id, clientEventId: 'live-idem-2',
      });
      if (second.body.payload.sequence <= first.body.payload.sequence) {
        throw new Error('sequence nao crescente');
      }
      return `sequence ${first.body.payload.sequence} -> ${second.body.payload.sequence}`;
    });

    await report.step('limite diario de efeitos: 10 por usuario normal', async () => {
      const effects = await viewer.get('/api/live/effects');
      const effect = effects.body.effects[0];
      const used = effects.body.used;
      const remaining = (effects.body.limit ?? 10) - used;
      for (let i = 0; i < remaining; i += 1) {
        await viewer.post(`/api/live/${roomId}/effects`, {
          effectId: effect.id, clientEventId: `fill-${i}`,
        });
      }
      const blocked = await viewer.post(`/api/live/${roomId}/effects`, {
        effectId: effect.id, clientEventId: 'over-limit',
      });
      if (blocked.status !== 429) throw new Error(`esperava 429, recebeu ${blocked.status}`);
      if (blocked.body.error.code !== 'effect_limit_reached') throw new Error(`codigo ${blocked.body.error.code}`);

      // Coracao continua funcionando (cota separada)
      const heart = await viewer.post(`/api/live/${roomId}/hearts`, { quantity: 2 });
      if (heart.status !== 201) throw new Error('coracao parou apos limite');

      const catalogAtLimit = await viewer.get('/api/live/effects');
      if (catalogAtLimit.status !== 200 || catalogAtLimit.body.effects.length !== 15
          || catalogAtLimit.body.used !== 10) {
        throw new Error(`catálogo indisponível após limite diário: HTTP ${catalogAtLimit.status}, used=${catalogAtLimit.body.used}`);
      }

      // Usuario novo tem cota zerada
      const fresh = new Client(server.baseUrl);
      await fresh.register({ username: randomUsername('fresh') });
      await fresh.post(`/api/live/${roomId}/join`, {});
      const freshEffects = await fresh.get('/api/live/effects');
      if (freshEffects.body.used !== 0) throw new Error(`cota nova ${freshEffects.body.used}`);
      return '10/dia respeitado, cota por usuario';
    });

    await report.step('efeito exige estar na LIVE', async () => {
      const outsider = new Client(server.baseUrl);
      await outsider.register({ username: randomUsername('out2') });
      const effects = await outsider.get('/api/live/effects');
      const res = await outsider.post(`/api/live/${roomId}/effects`, {
        effectId: effects.body.effects[0].id, clientEventId: 'fora',
      });
      if (res.status !== 403) throw new Error(`esperava 403, recebeu ${res.status}`);
    });

    // ------------------------------------------------------- MODERACAO LIVE
    await report.step('host silencia espectador na janela fixa', async () => {
      const mute = await host.post(`/api/live/${roomId}/moderate`, {
        userId: viewer.user.id, action: 'mute', minutes: 4,
      });
      if (mute.status !== 200) throw new Error(`status ${mute.status}`);
      if (!mute.body.until) throw new Error('mute sem data de expiracao');
      const minutes = Math.round((mute.body.until - Date.now()) / 60000);
      if (Math.abs(minutes - 4) > 0.2) throw new Error(`janela de ${minutes} min (esperava 4)`);

      // Silenciado nao comenta
      const comment = await viewer.post(`/api/live/${roomId}/messages`, { body: 'ainda ai?' });
      if (comment.status !== 403) throw new Error(`comentario permitido (${comment.status})`);
      return `silenciado por ${minutes} min, backend bloqueou a mensagem`;
    });

    await report.step('janela de mute fora da lista e recusada', async () => {
      for (const minutes of [1, 3, 5, 60]) {
        const res = await host.post(`/api/live/${roomId}/moderate`, {
          userId: viewer2.user.id, action: 'mute', minutes,
        });
        if (res.status !== 400) throw new Error(`janela ${minutes} min aceita (${res.status})`);
      }
      const ok = await host.post(`/api/live/${roomId}/moderate`, {
        userId: viewer2.user.id, action: 'mute', minutes: 10,
      });
      if (ok.status !== 200) throw new Error('janela de 10 min recusada');
      return 'apenas 2/4/6/10 min aceitos';
    });

    await report.step('host remove espectador da LIVE', async () => {
      const remove = await host.post(`/api/live/${roomId}/moderate`, {
        userId: viewer2.user.id, action: 'remove',
      });
      if (remove.status !== 200) throw new Error(`status ${remove.status}`);
      const list = await host.get(`/api/live/${roomId}/viewers`);
      if (list.body.viewers.some((v) => v.id === viewer2.user.id)) {
        throw new Error('removido continua na lista');
      }
      return 'removido da lista';
    });

    await report.step('espectador nao pode moderar', async () => {
      const res = await viewer.post(`/api/live/${roomId}/moderate`, {
        userId: host.user.id, action: 'ban',
      });
      if (res.status !== 403) throw new Error(`espectador moderou (${res.status})`);
    });

    // ------------------------------------------------- SINALIZACAO WEBRTC
    await report.step('sinalizacao WebRTC: oferta/resposta/ICE roteada host<->espectador', async () => {
      const hostWs = track(await new RealtimeClient(server.wsUrl, host).connect());
      const viewerWs = track(await new RealtimeClient(server.wsUrl, viewer).connect());
      hostWs.subscribe(`live:${roomId}`);
      viewerWs.subscribe(`live:${roomId}`);
      await sleep(400);
      hostWs.clear();
      viewerWs.clear();

      // O host oferece; o receptor responde; ambos enviam ICE.
      hostWs.send({
        type: 'LIVE_SIGNAL',
        data: {
          roomId,
          to: viewer.user.id,
          signal: {
            kind: 'description',
            description: { type: 'offer', sdp: 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n' },
          },
        },
      });
      const offer = await viewerWs.waitFor(
        (e) => e.type === 'LIVE_SIGNAL' && e.payload?.signal?.kind === 'description',
        { label: 'oferta recebida pelo espectador' },
      );
      if (offer.payload.from !== host.user.id) throw new Error('`from` incorreto');
      if (offer.payload.signal.description.type !== 'offer') throw new Error('tipo de offer errado');
      if (!offer.payload.signal.description.sdp.includes('v=0')) throw new Error('SDP invalido');

      viewerWs.send({
        type: 'LIVE_SIGNAL',
        data: {
          roomId,
          to: host.user.id,
          signal: {
            kind: 'description',
            description: { type: 'answer', sdp: 'v=0\r\no=- 2 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n' },
          },
        },
      });
      const answer = await hostWs.waitFor(
        (e) => e.type === 'LIVE_SIGNAL' && e.payload?.signal?.description?.type === 'answer',
        { label: 'resposta recebida pelo host' },
      );
      if (answer.payload.from !== viewer.user.id) throw new Error('`from` da resposta incorreto');

      viewerWs.send({
        type: 'LIVE_SIGNAL',
        data: {
          roomId,
          to: host.user.id,
          signal: { kind: 'ice', candidate: { candidate: 'candidate:1 1 UDP 2130706431 10.0.0.1 54321 typ host' } },
        },
      });
      const ice = await hostWs.waitFor(
        (e) => e.type === 'LIVE_SIGNAL' && e.payload?.signal?.kind === 'ice',
        { label: 'ICE candidate' },
      );
      if (!ice.payload.signal.candidate.candidate.startsWith('candidate:')) {
        throw new Error('candidate ICE malformado');
      }
      return 'SDP offer/answer + ICE roteados';
    });

    await report.step('sinalizacao e endereçada: terceiros nao recebem', async () => {
      // Um terceiro usuario, presente na sala, nao pode receber o sinal
      // destinado ao par host<->espectador.
      const third = new Client(server.baseUrl);
      await third.register({ username: randomUsername('third') });
      const thirdWs = track(await new RealtimeClient(server.wsUrl, third).connect());
      thirdWs.subscribe(`live:${roomId}`);
      await sleep(300);
      thirdWs.clear();

      const hostWs = track(await new RealtimeClient(server.wsUrl, host).connect());
      const viewerWs = track(await new RealtimeClient(server.wsUrl, viewer).connect());
      await sleep(200);
      hostWs.send({
        type: 'LIVE_SIGNAL',
        data: {
          roomId,
          to: viewer.user.id,
          signal: { kind: 'description', description: { type: 'offer', sdp: 'v=0\r\n' } },
        },
      });
      const got = await viewerWs.waitFor((e) => e.type === 'LIVE_SIGNAL', { label: 'sinal para o par' });
      if (!got.payload.to) throw new Error('sinal sem destinatario');
      await sleep(700);

      const leaked = thirdWs.eventsOfType('LIVE_SIGNAL');
      if (leaked.length) throw new Error(`terceiro recebeu ${leaked.length} sinal(is) nao destinado a ele`);
      return 'somente o destinatario recebe';
    });

    await report.step('sinal para Room inexistente nao derruba a conexao', async () => {
      const ws = track(await new RealtimeClient(server.wsUrl, viewer).connect());
      ws.send({ type: 'LIVE_SIGNAL', data: { roomId: 'liv_inexistente', to: host.user.id, signal: { kind: 'ice' } } });
      await sleep(600);
      if (ws.ws.readyState !== 1) throw new Error('socket foi fechado indevidamente');
      ws.send({ type: 'PING', data: { t: Date.now() } });
      await sleep(300);
      if (ws.ws.readyState !== 1) throw new Error('socket morreu apos sinal invalido');
      return 'socket estavel';
    });

    // --------------------------------------------------------- ENCERRAMENTO
    await report.step('encerrar LIVE notifica, zera contagem e libera recriacao', async () => {
      const hostWs = sockets.find((s) => s.events);
      void hostWs;
      const end = await host.post(`/api/live/${roomId}/end`, {});
      if (end.status !== 200) throw new Error(`status ${end.status}`);

      const room = await host.get(`/api/live/${roomId}`);
      if (room.body.room.status !== 'ended') throw new Error(`status ${room.body.room.status}`);
      if (room.body.viewerCount !== 0) throw new Error('espectadores nao zerados');

      const joinAfter = await viewer.post(`/api/live/${roomId}/join`, {});
      if (joinAfter.status !== 410) throw new Error(`esperava 410 (gone), recebeu ${joinAfter.status}`);

      // Recriar e permitido
      const again = await host.post('/api/live', { title: 'segunda LIVE' });
      if (again.status !== 201) throw new Error('nao recriou a LIVE');
      await host.post(`/api/live/${again.body.room.id}/end`, {});
      return 'encerramento completo';
    });

    await report.step('um host so pode ter uma LIVE ativa (409 na segunda)', async () => {
      const solo = new Client(server.baseUrl);
      await solo.register({ username: randomUsername('solo') });
      const first = await solo.post('/api/live', { title: 'A' });
      if (first.status !== 201) throw new Error(`primeira ${first.status}`);
      const second = await solo.post('/api/live', { title: 'B' });
      if (second.status !== 409) throw new Error(`segunda ${second.status} (esperava 409)`);
      if (second.body.error.code !== 'already_live') throw new Error(`codigo ${second.body.error.code}`);

      // Depois de encerrar, pode criar de novo.
      await solo.post(`/api/live/${first.body.room.id}/end`, {});
      const third = await solo.post('/api/live', { title: 'C' });
      if (third.status !== 201) throw new Error(`apos encerrar: ${third.status}`);
      await solo.post(`/api/live/${third.body.room.id}/end`, {});
      return 'uma LIVE por host, liberada ao encerrar';
    });

    await report.step('dois hosts diferentes tem LIVEs simultaneas independentes', async () => {
      const hostX = new Client(server.baseUrl);
      await hostX.register({ username: randomUsername('hostX') });
      const hostY = new Client(server.baseUrl);
      await hostY.register({ username: randomUsername('hostY') });
      const a = await hostX.post('/api/live', { title: 'X' });
      const b = await hostY.post('/api/live', { title: 'Y' });
      if (a.status !== 201 || b.status !== 201) throw new Error(`falha ao criar (${a.status}/${b.status})`);
      if (a.body.room.id === b.body.room.id) throw new Error('mesma sala retornada');

      await viewer.post(`/api/live/${a.body.room.id}/join`, {});
      const va = await hostX.get(`/api/live/${a.body.room.id}/viewers`);
      const vb = await hostY.get(`/api/live/${b.body.room.id}/viewers`);
      if (va.body.viewerCount !== 1) throw new Error(`sala X com ${va.body.viewerCount}`);
      if (vb.body.viewerCount !== 0) throw new Error(`sala Y com ${vb.body.viewerCount} (contagem vazada)`);

      await hostX.post(`/api/live/${a.body.room.id}/end`, {});
      await hostY.post(`/api/live/${b.body.room.id}/end`, {});
      return 'contadores isolados por sala';
    });

    await report.step('descobrir LIVE lista apenas as ativas', async () => {
      const room = await host.post('/api/live', { title: 'visivel' });
      const discover = await viewer.get('/api/live/discover');
      if (!discover.body.live.some((r) => r.id === room.body.room.id)) {
        throw new Error('LIVE ativa ausente em /api/live/discover');
      }
      await host.post(`/api/live/${room.body.room.id}/end`, {});
      const after = await viewer.get('/api/live/discover');
      if (after.body.live.some((r) => r.id === room.body.room.id)) {
        throw new Error('LIVE encerrada continua listada');
      }
      return 'somente ativas';
    });

    await report.step('diretorio AO VIVO retorna somente salas ativas e contagem conectada', async () => {
      const room = await host.post('/api/live', { title: 'diretorio ativo' });
      const roomId = room.body.room.id;
      const initial = await viewer.get('/api/lives/active');
      const card = initial.body.lives.find((item) => item.id === roomId);
      if (!card) throw new Error('LIVE ativa ausente do endpoint do diretorio');
      if (card.status !== 'live' || !card.startedAt || card.viewerCount !== 0) {
        throw new Error(`metadados ativos incorretos: ${JSON.stringify(card)}`);
      }
      if (card.host?.id !== host.user.id || card.host?.username !== host.user.username
          || !Object.hasOwn(card.host, 'avatarUrl')) {
        throw new Error(`dados publicos do host incompletos: ${JSON.stringify(card.host)}`);
      }

      await viewer.post(`/api/live/${roomId}/join`, {});
      const withViewer = await viewer.get('/api/lives/active');
      if (withViewer.body.lives.find((item) => item.id === roomId)?.viewerCount !== 1) {
        throw new Error('contador nao refletiu o espectador conectado');
      }
      await viewer.post(`/api/live/${roomId}/leave`, {});
      const withoutViewer = await viewer.get('/api/lives/active');
      if (withoutViewer.body.lives.find((item) => item.id === roomId)?.viewerCount !== 0) {
        throw new Error('contador nao diminuiu apos a saida do espectador');
      }

      const parallelRoom = await viewer2.post('/api/live', { title: 'diretorio paralelo' });
      const parallel = await viewer.get('/api/lives/active');
      if (!parallel.body.lives.some((item) => item.id === roomId)
          || !parallel.body.lives.some((item) => item.id === parallelRoom.body.room.id)) {
        throw new Error('diretorio omitiu uma LIVE ativa simultanea');
      }
      await viewer2.post(`/api/live/${parallelRoom.body.room.id}/end`, {});

      await host.post(`/api/live/${roomId}/end`, {});
      const ended = await viewer.get('/api/lives/active');
      if (ended.body.lives.some((item) => item.id === roomId)) {
        throw new Error('LIVE encerrada ainda aparece no diretorio');
      }
      const feed = await viewer.get('/api/feed/for-you');
      if (feed.body.posts.some((post) => post.type === 'live')) {
        throw new Error('anuncio/historico LIVE ainda aparece no Para voce');
      }
      return 'DTO minimo, avatar publico, contagem 0->1->0, encerrada removida e For You sem LIVE';
    });

    report.ok('LIVE sem duplicidade, sem vazamento e com limites reais');
  } catch (error) {
    report.fail('fluxo LIVE interrompido', error);
  } finally {
    for (const socket of sockets) {
      try { socket.close(); } catch { /* ignore */ }
    }
    await server.stop();
  }

  return report.summary();
}

run().then((result) => {
  process.exit(result.failed > 0 ? 1 : 0);
}).catch((error) => {
  console.error('erro fatal:', error);
  process.exit(1);
});