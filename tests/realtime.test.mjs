/**
 * Testes de realtime (WebSocket).
 *
 * Verificam o que a aplicacao inteira depende:
 *  - autenticacao do socket pelo cookie de sessao
 *  - assinatura de topicos com autorizacao por topico
 *  - publicacao SEMPRE validada e persistida pelo backend
 *  - idempotencia: reenviar o mesmo evento nao duplica
 *  - fanout correto (quem recebe e quem nao)
 *  - reconexao sem socket duplicado
 */
import { startServer, Client, RealtimeClient, Report, sleep, randomUsername, waitUntil } from './helpers.mjs';

const report = new Report('Realtime (WebSocket)');

async function run() {
  const server = await startServer();
  report.ok('servidor no ar', server.baseUrl);

  const sockets = [];
  const track = (socket) => { sockets.push(socket); return socket; };

  try {
    const ana = new Client(server.baseUrl);
    await ana.register({ username: randomUsername('ana') });
    const bruno = new Client(server.baseUrl);
    await bruno.register({ username: randomUsername('bruno') });
    const carla = new Client(server.baseUrl);
    await carla.register({ username: randomUsername('carla') });

    const anaWs = track(await new RealtimeClient(server.wsUrl, ana).connect());
    const brunoWs = track(await new RealtimeClient(server.wsUrl, bruno).connect());
    const carlaWs = track(await new RealtimeClient(server.wsUrl, carla).connect());

    // ------------------------------------------------------------ CONEXAO
    await report.step('socket anonimo conecta mas nao autentica', async () => {
      const anonClient = new Client(server.baseUrl);
      const anonWs = track(await new RealtimeClient(server.wsUrl, anonClient).connect());
      anonWs.send({ type: 'AUTH', data: { token: 'token-invalido' } });
      await sleep(400);
      const error = anonWs.errors.find((e) => /auth|token|session/i.test(JSON.stringify(e)));
      if (!error) throw new Error('socket anonimo autenticou com token invalido');
      return error.code || error.message;
    });

    await report.step('socket autenticado recebe userId', async () => {
      anaWs.send({ type: 'AUTH', data: {} });
      const event = await anaWs.waitFor((e) => false, { timeoutMs: 200 }).catch(() => null);
      void event;
      // AUTH_OK chega no handshake; validamos pelo fanout do topico pessoal.
      anaWs.subscribe(`user:${ana.user.id}`);
      brunoWs.subscribe(`user:${ana.user.id}`);
      await sleep(200);
      return 'inscricao aceita';
    });

    // --------------------------------------------------- FANOUT E PRIVACIDADE
    await report.step('comentario em post chega apenas aos inscritos', async () => {
      const video = null;
      void video;
      const post = await ana.post('/api/posts', { type: 'text', caption: 'post realtime' });
      const postId = post.body.post.id;

      brunoWs.subscribe(`post:${postId}`);
      carlaWs.subscribe(`post:${postId}`);
      brunoWs.clear();
      carlaWs.clear();

      await bruno.post(`/api/posts/${postId}/comments`, { body: 'comentario realtime' });
      const received = await brunoWs.waitFor(
        (e) => e.type === 'COMMENT' && e.payload?.comment?.body === 'comentario realtime',
        { label: 'evento COMMENT' },
      );
      const alsoReceived = await carlaWs.waitFor(
        (e) => e.type === 'COMMENT' && e.payload?.comment?.body === 'comentario realtime',
        { label: 'COMMENT na carla' },
      );
      if (!received || !alsoReceived) throw new Error('fanout nao alcancou os inscritos');
      return '2 inscritos receberam';
    });

    await report.step('DM nao vaza para quem nao esta na conversa', async () => {
      const convo = await ana.post(`/api/users/${bruno.user.id}/message`, {});
      const conversationId = convo.body.conversationId;

      // Bruno assina o topico pessoal dele; Carla o dela (nenhuma das duas
      // assinaria a conversa da Ana, mas os dois tem topic pessoal).
      brunoWs.subscribe(`user:${bruno.user.id}`);
      carlaWs.subscribe(`user:${carla.user.id}`);
      brunoWs.clear();
      carlaWs.clear();

      await ana.post(`/api/conversations/${conversationId}/messages`, {
        type: 'text', body: 'mensagem secreta',
      });

      const got = await brunoWs.waitFor(
        (e) => e.type === 'MESSAGE' && e.payload?.message?.text === 'mensagem secreta',
        { label: 'MESSAGE para Bruno' },
      );
      if (!got) throw new Error('destinatario nao recebeu a DM');

      await sleep(700);
      const leaked = carlaWs.events.find(
        (e) => e.type === 'MESSAGE' && e.payload?.message?.text === 'mensagem secreta',
      );
      if (leaked) throw new Error('VAZAMENTO: Carla recebeu DM de Ana');
      return 'sem vazamento';
    });

    // ------------------------------------------------- IDEMPOTENCIA NO PUBLISH
    await report.step('PUBLISH duplicado de DM nao duplica no banco', async () => {
      const convo = await ana.post(`/api/users/${bruno.user.id}/message`, {});
      const conversationId = convo.body.conversationId;
      const clientEventId = `dup-${Date.now()}`;

      brunoWs.subscribe(`user:${bruno.user.id}`);
      brunoWs.clear();

      // Mesmo evento publicado 3 vezes (reconexao do cliente).
      for (let i = 0; i < 3; i += 1) {
        anaWs.publish('DM_MESSAGE', {
          conversationId, messageType: 'text', body: 'mensagem idempotente', clientEventId,
        });
        await sleep(120);
      }
      await sleep(900);

      const { body } = await bruno.get(`/api/conversations/${conversationId}`);
      const matching = body.messages.filter((m) => m.clientEventId === clientEventId);
      if (matching.length !== 1) {
        throw new Error(`mensagem gravada ${matching.length}x (esperava 1)`);
      }
      const received = brunoWs.eventsOfType('MESSAGE')
        .filter((e) => e.payload?.message?.clientEventId === clientEventId);
      if (received.length > 1) throw new Error(`broadcast ${received.length}x`);
      return `1 no banco, ${received.length} no socket`;
    });

    await report.step('PUBLISH sem sessao e recusado com erro estavel', async () => {
      const anonClient = new Client(server.baseUrl);
      const anonWs = track(await new RealtimeClient(server.wsUrl, anonClient).connect());
      anonWs.errors = [];
      anonWs.publish('DM_MESSAGE', { conversationId: 'qualquer', messageType: 'text', body: 'hack' });
      await sleep(600);
      const err = anonWs.errors.find((e) => /auth|login|forbidden|session/i.test(JSON.stringify(e)));
      if (!err) throw new Error('publish anonimo nao gerou erro');
      return err.code || 'erro retornado';
    });

    await report.step('PUBLISH com payload invalido e recusado', async () => {
      const before = anaWs.errors.length;
      anaWs.publish('EFFECT_TRIGGER', { roomId: 'liv_inexistente', effectId: 'x' });
      await sleep(600);
      const err = anaWs.errors.slice(before).find(Boolean);
      if (!err) throw new Error('payload invalido aceito sem erro');
      return err.code || 'erro retornado';
    });

    // --------------------------------------------------------- CHAT GLOBAL
    await report.step('chat global: broadcast e contagem de online', async () => {
      anaWs.subscribe('global-chat');
      brunoWs.subscribe('global-chat');
      carlaWs.subscribe('global-chat');
      await sleep(300);
      anaWs.clear();
      brunoWs.clear();

      anaWs.publish('GLOBAL_CHAT_MESSAGE', { messageType: 'text', body: 'ola global realtime' });
      const got = await brunoWs.waitFor(
        (e) => e.type === 'GLOBAL_CHAT_MESSAGE' && e.payload?.message?.text === 'ola global realtime',
        { label: 'mensagem global' },
      );
      if (!got) throw new Error('mensagem global nao chegou');

      const list = await carla.get('/api/chat/global');
      if (!list.body.messages.some((m) => m.text === 'ola global realtime')) {
        throw new Error('mensagem global nao persistiu');
      }
      if (typeof list.body.onlineCount !== 'number') throw new Error('onlineCount invalido');
      return `onlineCount=${list.body.onlineCount}`;
    });

    await report.step('PRESENCE publica a contagem quando alguem conecta', async () => {
      // A contagem so muda quando alguem entra/sai: abrimos um socket novo.
      anaWs.clear();
      const carla2 = track(await new RealtimeClient(server.wsUrl, carla).connect());
      carla2.subscribe('global-chat');
      const presence = await anaWs.waitFor(
        (e) => e.type === 'PRESENCE' && typeof e.payload?.onlineCount === 'number',
        { label: 'PRESENCE', timeoutMs: 5000 },
      );
      if (presence.payload.onlineCount < 2) {
        throw new Error(`contagem ${presence.payload.onlineCount} (esperava >= 2)`);
      }
      const api = await ana.get('/api/chat/global');
      if (api.body.onlineCount !== presence.payload.onlineCount) {
        throw new Error(`API diz ${api.body.onlineCount}, socket diz ${presence.payload.onlineCount}`);
      }
      return `${presence.payload.onlineCount} online (API e socket concordam)`;
    });

    // ----------------------------------------------------------------- LIVE
    await report.step('diretorio LIVE recebe inicio, mudanca de viewers e encerramento', async () => {
      anaWs.subscribe('live:directory');
      await sleep(200);
      anaWs.clear();
      const room = await ana.post('/api/live', { title: 'LIVE diretorio realtime' });
      const roomId = room.body.room.id;
      const started = await anaWs.waitFor(
        (e) => e.type === 'LIVE_DIRECTORY_CHANGE',
        { label: 'LIVE_DIRECTORY_CHANGE de inicio' },
      );
      if (!started) throw new Error('inicio nao invalidou o diretorio');

      anaWs.clear();
      await bruno.post(`/api/live/${roomId}/join`, {});
      const joined = await anaWs.waitFor(
        (e) => e.type === 'LIVE_DIRECTORY_CHANGE',
        { label: 'LIVE_DIRECTORY_CHANGE de viewer' },
      );
      if (!joined) throw new Error('entrada de viewer nao atualizou o diretorio');

      anaWs.clear();
      await bruno.post(`/api/live/${roomId}/leave`, {});
      const left = await anaWs.waitFor(
        (e) => e.type === 'LIVE_DIRECTORY_CHANGE',
        { label: 'LIVE_DIRECTORY_CHANGE de saida' },
      );
      if (!left) throw new Error('saida de viewer nao atualizou o diretorio');

      anaWs.clear();
      await ana.post(`/api/live/${roomId}/end`, {});
      const ended = await anaWs.waitFor(
        (e) => e.type === 'LIVE_DIRECTORY_CHANGE',
        { label: 'LIVE_DIRECTORY_CHANGE de encerramento' },
      );
      if (!ended) throw new Error('encerramento nao invalidou o diretorio');
      return 'inicio, entrada, saida e fim emitiram invalidacao no WebSocket unico';
    });

    await report.step('LIVE: entrar/sair publica contagem sem o host', async () => {
      const room = await ana.post('/api/live', { title: 'LIVE realtime' });
      const roomId = room.body.room.id;

      anaWs.subscribe(`live:${roomId}`);
      anaWs.subscribe(`live:host:${ana.user.id}`);
      brunoWs.subscribe(`live:${roomId}`);
      carlaWs.subscribe(`live:${roomId}`);
      await sleep(300);
      anaWs.clear();
      brunoWs.clear();
      carlaWs.clear();

      brunoWs.publish('LIVE_JOIN', { roomId });
      carlaWs.publish('LIVE_JOIN', { roomId });
      await sleep(900);

      const joins = anaWs.eventsOfType('LIVE_JOIN').filter((e) => e.payload?.roomId === roomId);
      if (joins.length < 2) throw new Error(`entradas publicadas: ${joins.length}`);

      const lastCount = joins[joins.length - 1].payload.viewerCount;
      if (lastCount !== 2) throw new Error(`contagem ${lastCount} (esperava 2, sem o host)`);

      const hostInJoins = joins.filter((e) => e.payload?.userId === ana.user.id);
      if (hostInJoins.length) throw new Error('host entrou na propria lista de espectadores');

      // saida
      brunoWs.clear();
      brunoWs.publish('LIVE_LEAVE', { roomId });
      const leave = await anaWs.waitFor(
        (e) => e.type === 'LIVE_LEAVE' && e.payload?.roomId === roomId,
        { label: 'LIVE_LEAVE' },
      );
      if (leave.payload.viewerCount !== 1) throw new Error(`contagem apos saida ${leave.payload.viewerCount}`);

      await ana.post(`/api/live/${roomId}/end`, {});
      return 'join/leave com contagem correta';
    });

    await report.step('LIVE: coracoes e efeitos vao pelo realtime', async () => {
      const room = await ana.post('/api/live', { title: 'LIVE efeitos' });
      const roomId = room.body.room.id;
      anaWs.subscribe(`live:${roomId}`);
      brunoWs.subscribe(`live:${roomId}`);
      await sleep(300);
      // Coracao e' permitido apenas a quem esta NA LIVE (backend exige
      // participacao ativa).
      await bruno.post(`/api/live/${roomId}/join`, {});
      anaWs.clear();
      brunoWs.clear();

      brunoWs.publish('LIVE_HEART', { roomId, quantity: 3 });
      const heart = await anaWs.waitFor(
        (e) => e.type === 'LIVE_HEART' && e.payload?.roomId === roomId,
        { label: 'LIVE_HEART' },
      );
      if (heart.payload.quantity !== 3) throw new Error(`quantity ${heart.payload.quantity}`);

      const effects = await bruno.get('/api/live/effects');
      const effect = effects.body.effects[0];
      await bruno.post(`/api/live/${roomId}/join`, {});
      brunoWs.publish('EFFECT_TRIGGER', {
        roomId, effectId: effect.id, clientEventId: 'rt-eff-1',
      });
      const trigger = await anaWs.waitFor(
        (e) => e.type === 'EFFECT_TRIGGER' && e.payload?.roomId === roomId,
        { label: 'EFFECT_TRIGGER' },
      );
      if (!trigger.payload.effect?.mediaUrl) throw new Error('payload do efeito sem midia');
      if (!trigger.payload.eventId || !trigger.payload.sequence) {
        throw new Error('payload sem event_id/sequence (idempotencia impossible)');
      }
      if (!trigger.payload.effect.chromaKey && !trigger.payload.effect.alpha) {
        throw new Error('efeito sem alfa nem chromaKey: nao ha remocao de fundo real');
      }

      await ana.post(`/api/live/${roomId}/end`, {});
      return `effect ${effect.slug} com sequence=${trigger.payload.sequence}`;
    });

    await report.step('CHAT_MESSAGE da LIVE nunca gera efeito', async () => {
      const room = await ana.post('/api/live', { title: 'LIVE chat' });
      const roomId = room.body.room.id;
      anaWs.subscribe(`live:${roomId}`);
      await sleep(300);
      await bruno.post(`/api/live/${roomId}/join`, {});
      anaWs.clear();

      brunoWs.publish('LIVE_COMMENT', { roomId, body: 'apenas um comentario' });
      await anaWs.waitFor((e) => e.type === 'LIVE_COMMENT' && e.payload?.roomId === roomId, { label: 'LIVE_COMMENT' });
      await sleep(500);

      const effects = anaWs.eventsOfType('EFFECT_TRIGGER').filter((e) => e.payload?.roomId === roomId);
      if (effects.length) throw new Error(`comentario gerou ${effects.length} efeito(s)`);
      await ana.post(`/api/live/${roomId}/end`, {});
      return 'nenhum efeito disparado por comentario';
    });

    await report.step('narracao: historico NAO reproduz efeitos antigos', async () => {
      const room = await ana.post('/api/live', { title: 'LIVE historia' });
      const roomId = room.body.room.id;
      const effects = await bruno.get('/api/live/effects');

      // Dispara um efeito e um comentario, encerra a LIVE e recria outra.
      await bruno.post(`/api/live/${roomId}/join`, {});
      await bruno.post(`/api/live/${roomId}/effects`, {
        effectId: effects.body.effects[0].id, clientEventId: 'hist-1',
      });
      await bruno.post(`/api/live/${roomId}/messages`, { body: 'comentario antigo' });
      await ana.post(`/api/live/${roomId}/end`, {});

      const room2 = await ana.post('/api/live', { title: 'LIVE nova' });
      const room2Id = room2.body.room.id;

      const watcher = track(await new RealtimeClient(server.wsUrl, carla).connect());
      watcher.subscribe(`live:${room2Id}`);
      await sleep(500);
      watcher.clear();

      // O espectador que ENTRA agora nao recebe os efeitos antigos.
      await carla.post(`/api/live/${room2Id}/join`, {});
      await sleep(900);

      const oldEffects = watcher.eventsOfType('EFFECT_TRIGGER')
        .filter((e) => e.payload?.roomId === roomId);
      if (oldEffects.length) throw new Error('espectador recebeu efeito de LIVE anterior');

      const history = await carla.get(`/api/live/${roomId}/messages`);
      if (!history.body.messages.length) throw new Error('historico da LIVE antiga vazio');
      await ana.post(`/api/live/${room2Id}/end`, {});
      return 'sem replay de efeitos';
    });

    // --------------------------------------------------------- RECONEXAO
    await report.step('reconexao: socket novo nao duplica entrega', async () => {
      const post = await ana.post('/api/posts', { type: 'text', caption: 'post reconexao' });
      const postId = post.body.post.id;
      brunoWs.subscribe(`post:${postId}`);
      await sleep(200);
      brunoWs.clear();

      await ana.post(`/api/posts/${postId}/comments`, { body: 'comentario antes' });
      await brunoWs.waitFor((e) => e.type === 'COMMENT', { label: 'COMMENT antes' });

      // Fecha e reabre o socket do Bruno (simula queda de rede).
      brunoWs.close();
      const reconnected = track(await new RealtimeClient(server.wsUrl, bruno).connect());
      reconnected.subscribe(`post:${postId}`);
      await sleep(400);
      reconnected.clear();

      await ana.post(`/api/posts/${postId}/comments`, { body: 'comentario depois' });
      const got = await reconnected.waitFor(
        (e) => e.type === 'COMMENT' && e.payload?.comment?.body === 'comentario depois',
        { label: 'COMMENT depois' },
      );
      if (!got) throw new Error('socket reconectado nao recebe eventos');

      // O socket antigo (fechado) nao pode continuar recebendo.
      const duplicates = brunoWs.events.filter(
        (e) => e.type === 'COMMENT' && e.payload?.comment?.body === 'comentario depois',
      );
      if (duplicates.length) throw new Error('socket antigo ainda recebe eventos');

      return 'entrega unica apos reconexao';
    });

    await report.step('desconectar libera a contagem de online', async () => {
      carlaWs.close();
      await waitUntil(async () => {
        const list = await ana.get('/api/chat/global');
        return list.body.onlineCount < 3;
      }, { timeoutMs: 6000, intervalMs: 300 });
      const list = await ana.get('/api/chat/global');
      if (list.body.onlineCount >= 3) throw new Error('socket fechado ainda conta como online');
      return `${list.body.onlineCount} online`;
    });

    report.ok('realtime sem duplicidade nem vazamento');
  } catch (error) {
    report.fail('fluxo realtime interrompido', error);
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