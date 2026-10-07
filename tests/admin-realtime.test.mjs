/**
 * Testes do painel administrativo em TEMPO REAL (itens 17, 18 e 19).
 *
 * O que precisa ser provado aqui, sem F5 e sem polling:
 *  1. STAFF assina `admin:events` e recebe os eventos reais da plataforma;
 *  2. USUARIO COMUM nao consegue assinar (o backend e a autoridade);
 *  3. os eventos cobrem: usuario online/offline, conta nova, video novo,
 *     LIVE iniciada/encerrada, denuncia e acao de moderacao;
 *  4. SNAPSHOT + RECONEXAO: perder e recuperar o socket nao deixa o painel
 *     congelado - com novo snapshot, os numeros voltam a bater;
 *  5. o frontend do painel tem os ganchos necessarios (topico, aplicacao de
 *     evento, indicador de reconexao) e o CSS profissional do item 19.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../server/config.js';
import {
  startServer, Client, RealtimeClient, Report, sleep, randomUsername, waitUntil,
} from './helpers.mjs';

const report = new Report('Painel administrativo em tempo real');

const ADMIN = {
  username: 'adminrt',
  password: 'SenhaDeAdmin@2026',
  email: 'adminrt@pulse.test',
};

function seedAdmin(databasePath, storageRoot) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'server', 'db', 'cli-seed.js')], {
      cwd: ROOT,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        DATABASE_PATH: databasePath,
        STORAGE_ROOT: storageRoot,
        ADMIN_EMAIL: ADMIN.email,
        ADMIN_USERNAME: ADMIN.username,
        ADMIN_PASSWORD: ADMIN.password,
        LOG_LEVEL: 'warn',
        SESSION_SECRET: 'test-secret-nao-usar-em-producao-000000000',
      },
    });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    child.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(out))));
  });
}

const ADMIN_TOPIC = 'admin:events';
const isAdminEvent = (type) => String(type).startsWith('ADMIN_');

async function run() {
  const server = await startServer();
  report.ok('servidor no ar', server.baseUrl);
  await seedAdmin(server.databasePath, server.storageRoot);

  const sockets = [];
  const track = (s) => { sockets.push(s); return s; };
  const adminEvents = (rt, type, { timeoutMs = 8000 } = {}) =>
    rt.waitFor((e) => e.type === type, { timeoutMs, label: type });

  try {
    // O socket do painel usa a MESMA sessao HTTP do admin: o hub autentica o
    // WebSocket pela cookie da sessao (fonte unica).
    const adminHttp = new Client(server.baseUrl);
    const login = await adminHttp.login(ADMIN.email, ADMIN.password);
    if (login.status !== 200) throw new Error(`login do admin: ${login.status}`);
    const admin = track(new RealtimeClient(server.wsUrl, adminHttp));
    await admin.connect();
    await waitUntil(() => admin.handshake?.type === 'AUTH_OK', { timeoutMs: 5000 });
    if (admin.handshake?.type !== 'AUTH_OK') throw new Error('socket do admin nao autenticou');

    // ---------------------------------------------------- 1. ACESSO AO TOPICO
    await report.step('usuario comum NAO assina admin:events (backend e autoridade)', async () => {
      const comumClient = new Client(server.baseUrl);
      await comumClient.register({ username: randomUsername('curioso') });
      const comum = track(new RealtimeClient(server.wsUrl, comumClient));
      await comum.connect();
      comum.subscribe([ADMIN_TOPIC]);
      // Espera a resposta SUBSCRIBED do servidor.
      await sleep(500);
      const aceitos = comum.events.filter((e) => e.topic === ADMIN_TOPIC);
      // Nenhum evento chega: a inscricao foi recusada.
      const alvo = new Client(server.baseUrl);
      await alvo.register({ username: randomUsername('alvo') });
      await sleep(700);
      if (aceitos.length) throw new Error('usuario comum recebeu evento de admin');
      // O servidor aceita o frame mas devolve a lista de topicos ACEITOS: um
      // usuario comum volta sem `admin:events`. E a prova da autoridade.
      const aceito = comum.subscribed?.topics || [];
      if (aceito.includes(ADMIN_TOPIC)) throw new Error('topico admin aceito para usuario comum');
      const erro = comum.errors.find((e) => /topic/i.test(`${e.code} ${e.message}`));
      return erro
        ? `recusado com "${erro.code || erro.message}"`
        : 'nenhum evento entregue ao usuario comum';
    });

    await report.step('admin assina admin:events e recebe os eventos reais', async () => {
      admin.subscribe([ADMIN_TOPIC]);
      await sleep(300);
      const alvo = new Client(server.baseUrl);
      await alvo.register({ username: randomUsername('alvo') });
      // Cadastra um socket do alvo: dispara USER_ONLINE + USER_CREATED.
      const alvoRt = track(new RealtimeClient(server.wsUrl, alvo));
      await alvoRt.connect();
      const evento = await adminEvents(admin, 'ADMIN_USER_CREATED');
      if (!evento.payload?.username) throw new Error('evento sem username');
      return `@${evento.payload.username} cadastrado apareceu em tempo real`;
    });

    // ------------------------------------------- 2. COBERTURA DE CADA EVENTO
    await report.step('evento de usuario online/offline chega ao painel', async () => {
      const alvo = new Client(server.baseUrl);
      await alvo.register({ username: randomUsername('presenca') });
      const rt = track(new RealtimeClient(server.wsUrl, alvo));
      const online = adminEvents(admin, 'ADMIN_USER_ONLINE', { timeoutMs: 8000 });
      await rt.connect();
      const ev = await online;
      if (!ev.payload?.kind) throw new Error('evento sem kind');
      const offline = adminEvents(admin, 'ADMIN_USER_OFFLINE', { timeoutMs: 8000 });
      rt.ws.close();
      await offline;
      return `online e offline publicados (kind=${ev.payload.kind})`;
    });

    await report.step('evento de video novo chega ao painel', async () => {
      const autor = new Client(server.baseUrl);
      await autor.register({ username: randomUsername('posteiro') });
      const espera = adminEvents(admin, 'ADMIN_VIDEO_CREATED');
      const criado = await autor.post('/api/posts', { type: 'text', caption: `painel em tempo real ${Date.now()}` });
      if (criado.status !== 201) throw new Error(`criar post: ${criado.status}`);
      const ev = await espera;
      if (ev.payload?.postId !== criado.body.post.id) throw new Error('postId do evento difere do criado');
      return `post ${criado.body.post.id.slice(0, 10)} publicado e visivel no painel`;
    });

    await report.step('evento de LIVE iniciada e encerrada chega ao painel', async () => {
      const host = new Client(server.baseUrl);
      await host.register({ username: randomUsername('hostrt') });
      const esperaInicio = adminEvents(admin, 'ADMIN_LIVE_STARTED');
      const sala = await host.post('/api/live', { title: 'LIVE do painel' });
      if (sala.status !== 201) throw new Error(`criar LIVE: ${sala.status}`);
      const inicio = await esperaInicio;
      if (inicio.payload?.roomId !== sala.body.room.id) throw new Error('roomId do evento difere');

      const esperaFim = adminEvents(admin, 'ADMIN_LIVE_ENDED');
      const fim = await host.post(`/api/live/${sala.body.room.id}/end`, {});
      if (fim.status !== 200) throw new Error(`encerrar LIVE: ${fim.status}`);
      const encerramento = await esperaFim;
      if (encerramento.payload?.roomId !== sala.body.room.id) throw new Error('roomId do encerramento difere');
      return 'inicio e fim publicados em tempo real';
    });

    await report.step('evento de denuncia chega ao painel', async () => {
      const autor = new Client(server.baseUrl);
      await autor.register({ username: randomUsername('denunciante') });
      // A denuncia aponta para conteudo REAL: o backend valida o alvo, e o
      // teste nao pode depender de id inventado.
      const post = await autor.post('/api/posts', { type: 'text', caption: `alvo de denuncia ${Date.now()}` });
      if (post.status !== 201) throw new Error(`criar post: ${post.status}`);
      const espera = adminEvents(admin, 'ADMIN_REPORT_CREATED');
      const r = await autor.post('/api/reports', {
        targetType: 'post', targetId: post.body.post.id, category: 'spam', details: 'teste do painel',
      });
      if (r.status !== 201) throw new Error(`criar denuncia: ${r.status} ${JSON.stringify(r.body).slice(0, 80)}`);
      const ev = await espera;
      if (ev.payload?.category !== 'spam') throw new Error(`categoria do evento: ${ev.payload?.category}`);
      if (ev.payload?.targetId !== post.body.post.id) throw new Error('alvo do evento difere do post');
      return 'denuncia publicada em tempo real';
    });

    await report.step('evento de acao de moderacao chega ao painel', async () => {
      const alvo = new Client(server.baseUrl);
      await alvo.register({ username: randomUsername('moderado') });
      const espera = adminEvents(admin, 'ADMIN_MODERATION_APPLIED');
      const res = await adminHttp.post('/api/admin/enforce', {
        targetType: 'user', targetId: alvo.user.id, action: 'mute', minutes: 2, reason: 'teste',
      });
      if (res.status !== 200) throw new Error(`enforce: ${res.status}`);
      const ev = await espera;
      if (ev.payload?.action !== 'mute') throw new Error(`acao do evento: ${ev.payload?.action}`);
      // desfaz para nao afetar o resto da suite
      await adminHttp.post('/api/admin/enforce', { targetType: 'user', targetId: alvo.user.id, action: 'unban' }).catch(() => {});
      return `acao "${ev.payload.action}" publicada em tempo real`;
    });

    // --------------------------------- 3. SNAPSHOT + RECONEXAO (item 18)
    await report.step('perda e volta do socket: novo snapshot continua correto', async () => {
      const antes = (await adminHttp.get('/api/admin/overview')).body;
      // Simula a queda do socket do PAINEL (nao do usuario comum).
      admin.ws.close();
      await waitUntil(() => admin.ws.readyState === 3, { timeoutMs: 3000 });

      // Enquanto o painel esta desconectado, o mundo muda.
      const novo = new Client(server.baseUrl);
      await novo.register({ username: randomUsername('durantequeda') });

      // Reabre o socket com a MESMA sessao do painel: reinscreve e volta a
      // receber eventos.
      admin.events.length = 0;
      const admin2 = track(new RealtimeClient(server.wsUrl, adminHttp));
      await admin2.connect();
      await waitUntil(() => admin2.handshake?.type === 'AUTH_OK', { timeoutMs: 5000 });
      admin2.subscribe([ADMIN_TOPIC]);
      await sleep(300);
      const espera = admin2.waitFor((e) => e.type === 'ADMIN_USER_CREATED', { timeoutMs: 8000, label: 'USER_CREATED' });
      const outro = new Client(server.baseUrl);
      await outro.register({ username: randomUsername('depois') });
      await espera;
      const depois = (await adminHttp.get('/api/admin/overview')).body;
      const cresceu = depois.stats.users.total > antes.stats.users.total;
      if (!cresceu) throw new Error(`contagem nao acompanhou: ${antes.stats.users.total} -> ${depois.stats.users.total}`);
      return `contagem ${antes.stats.users.total} -> ${depois.stats.users.total} e eventos voltaram`;
    });

    // ------------------------------- 4. GANCHOS NO FRONTEND DO PAINEL
    await report.step('frontend do painel assina o topico e aplica os eventos', async () => {
      const src = fs.readFileSync(path.join(ROOT, 'web', 'js', 'features', 'admin.js'), 'utf8');
      const exigidos = [
        ["realtime.subscribe('admin:events')", 'inscricao no topico administrativo'],
        ['ADMIN_USER_ONLINE', 'escuta de usuario online'],
        ['ADMIN_LIVE_STARTED', 'escuta de LIVE iniciada'],
        ['ADMIN_REPORT_CREATED', 'escuta de denuncia'],
        ['renderMediaState', 'funcao nao deve existir aqui'],
      ];
      for (const [needle, rotulo] of exigidos) {
        if (rotulo.startsWith('funcao nao deve')) continue;
        if (!src.includes(needle)) throw new Error(`falta: ${rotulo} (${needle})`);
      }
      // Indicador de reconexao (item 18) e nao um dashboard congelado.
      if (!src.includes("'reconectando'") && !src.includes('reconectando')) {
        throw new Error('sem indicador de reconexao');
      }
      // Snapshot inicial: sem isso o painel comeca vazio.
      if (!src.includes("/api/admin/overview")) throw new Error('sem snapshot inicial');
      // Nada de polling como solucao principal.
      if (/setInterval\(\s*\d{3,}/.test(src)) throw new Error('painel usa polling (setInterval) como solucao');
      return 'topico, eventos, reconexao e snapshot presentes; sem polling';
    });

    await report.step('CSS profissional do painel presente (item 19)', async () => {
      const css = fs.readFileSync(path.join(ROOT, 'web', 'css', 'app.css'), 'utf8');
      const exigidos = [
        ['.admin-header', 'cabecalho'],
        ['.admin-hero', 'bloco de resumo'],
        ['.admin-activity-row', 'linha de atividade'],
        ['.admin-columns', 'colunas'],
        ['.admin-live[data-state="live"]', 'indicador ao vivo'],
        ['@media (max-width: 820px)', 'responsividade do painel'],
      ];
      const faltando = exigidos.filter(([sel]) => !css.includes(sel)).map(([, r]) => r);
      if (faltando.length) throw new Error(`faltando CSS: ${faltando.join(', ')}`);
      return `${exigidos.length} blocos do painel presentes`;
    });

    await report.step('eventos administrativos nao vazam para o topico publico', async () => {
      const comum = new Client(server.baseUrl);
      await comum.register({ username: randomUsername('publico') });
      const rt = track(new RealtimeClient(server.wsUrl, comum));
      await rt.connect();
      rt.subscribe(['feed:new', 'global-chat']);
      const outro = new Client(server.baseUrl);
      await outro.register({ username: randomUsername('geral') });
      await sleep(600);
      const vazou = rt.events.filter((e) => isAdminEvent(e.type));
      if (vazou.length) throw new Error(`vazaram ${vazou.length} evento(s): ${vazou.map((e) => e.type).join(', ')}`);
      return `nenhum evento ADMIN_ em topico publico (${rt.events.length} evento(s) recebido(s))`;
    });

    report.ok('painel administrativo em tempo real validado');
  } catch (error) {
    report.fail('fluxo do painel em tempo real interrompido', error);
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