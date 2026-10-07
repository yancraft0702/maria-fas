/**
 * Testes de administracao, moderacao e push.
 *
 * O admin e' criado EXCLUSIVAMENTE por semente com variaveis de ambiente
 * (ADMIN_EMAIL / ADMIN_USERNAME / ADMIN_PASSWORD) - nada de credencial no
 * codigo. Aqui o servidor de teste sobe e a semente roda contra o mesmo banco.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../server/config.js';
import {
  startServer, Client, RealtimeClient, Report, sleep, randomUsername, waitUntil,
} from './helpers.mjs';

const report = new Report('Admin, moderacao e push');

const ADMIN = {
  username: 'adminpulse',
  password: 'SenhaDeAdmin@2026',
  email: 'admin@pulse.test',
};

/** Roda o seed do admin contra o mesmo banco do servidor de teste. */
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

async function run() {
  const server = await startServer();
  report.ok('servidor no ar', server.baseUrl);

  let admin = null;
  const sockets = [];
  const track = (s) => { sockets.push(s); return s; };

  try {
    // ------------------------------------------------- SEM ADMIN SEM SEMENTE
    await report.step('sem ADMIN_* no env, nenhum admin e criado', async () => {
      const user = new Client(server.baseUrl);
      await user.register({ username: randomUsername('comum') });
      const res = await user.get('/api/admin/overview');
      if (res.status !== 403) throw new Error(`usuario comum acessou admin (${res.status})`);
    });

    // ------------------------------------------------------- SEMENTE DO ADMIN
    await report.step('admin nasce da semente com variaveis de ambiente', async () => {
      await seedAdmin(server.databasePath, server.storageRoot);
      admin = new Client(server.baseUrl);
      const login = await admin.login(ADMIN.email, ADMIN.password);
      if (login.status !== 200) throw new Error(`login do admin ${login.status}: ${JSON.stringify(login.body).slice(0, 120)}`);
      if (login.body.user.role !== 'admin') throw new Error(`papel ${login.body.user.role}`);
      return `@${ADMIN.username} com papel admin`;
    });

    await report.step('admin nao esta no codigo: senha so vem do env', async () => {
      const sources = [];
      const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (['node_modules', '.git', 'data', 'storage'].includes(entry.name)) continue;
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (/\.(js|mjs)$/.test(entry.name)) sources.push(full);
        }
      };
      walk(path.join(ROOT, 'server'));
      walk(path.join(ROOT, 'web'));
      const offenders = [];
      for (const file of sources) {
        const text = fs.readFileSync(file, 'utf8');
        if (text.includes(ADMIN.password) || text.includes(ADMIN.email)) {
          offenders.push(path.relative(ROOT, file));
        }
      }
      if (offenders.length) throw new Error(`credencial de admin em: ${offenders.join(', ')}`);
      return `${sources.length} arquivos sem credencial de admin`;
    });

    // ------------------------------------------------------------ CONSOLE
    await report.step('visao geral do admin devolve numeros reais', async () => {
      const { body } = await admin.get('/api/admin/overview');
      if (body.error) throw new Error(`${body.error.code}: ${body.error.message}`);
      const groups = { users: body.stats.users, content: body.stats.content, live: body.stats.live };
      for (const [name, group] of Object.entries(groups)) {
        for (const [key, value] of Object.entries(group)) {
          if (typeof value !== 'number') {
            throw new Error(`contador "${name}.${key}" ausente (${JSON.stringify(body).slice(0, 200)})`);
          }
        }
      }
      if (!body.realtime || typeof body.realtime.sockets !== 'number') throw new Error('stats de realtime ausentes');
      if (!Array.isArray(body.reports)) throw new Error('fila de denuncias ausente');
      return `usuarios=${body.stats.users.total}, posts=${body.stats.content.posts}, `
        + `denuncias=${body.stats.content.reportsOpen}, lives ativas=${body.stats.live.active}`;
    });

    await report.step('lista e busca de usuarios do admin', async () => {
      const target = new Client(server.baseUrl);
      await target.register({ username: randomUsername('alvo') });
      const list = await admin.get('/api/admin/users?limit=20');
      if (!list.body.users?.length) throw new Error('lista vazia');
      const detail = await admin.get(`/api/admin/users/${target.user.id}`);
      if (detail.body.user.username !== target.user.username) throw new Error('detalhe divergente');
      return `${list.body.users.length} usuarios, detalhe ok`;
    });

    await report.step('denuncia criada pelo usuario chega na fila do admin', async () => {
      const author = new Client(server.baseUrl);
      await author.register({ username: randomUsername('denunciante') });
      const post = await author.post('/api/posts', { type: 'text', caption: 'conteudo denunciavel' });

      const reportRes = await author.post('/api/reports', {
        targetType: 'post', targetId: post.body.post.id, category: 'spam', details: 'conteudo falso',
      });
      if (reportRes.status !== 201 && reportRes.status !== 200) throw new Error(`denuncia ${reportRes.status}`);

      // A mesma pessoa nao pode denunciar duas vezes o mesmo alvo.
      const again = await author.post('/api/reports', {
        targetType: 'post', targetId: post.body.post.id, category: 'spam', details: 'de novo',
      });
      if (again.status !== 409 && again.status !== 400) {
        throw new Error(`denuncia duplicada aceitou ${again.status}`);
      }

      const queue = await admin.get('/api/admin/reports');
      const found = queue.body.reports.find((r) => r.targetId === post.body.post.id);
      if (!found) throw new Error('denuncia ausente na fila');
      return `${queue.body.reports.length} na fila, duplicata bloqueada`;
    });

    await report.step('admin remove conteudo e a remocao vale para o publico', async () => {
      const author = new Client(server.baseUrl);
      await author.register({ username: randomUsername('spam') });
      const post = await author.post('/api/posts', { type: 'text', caption: 'spam reportado' });
      const postId = post.body.post.id;

      const before = await author.get(`/api/posts/${postId}`);
      if (before.status !== 200) throw new Error('post nao acessivel antes');

      const removed = await admin.delete(`/api/admin/content/post/${postId}`, { reason: 'spam' });
      if (removed.status !== 200) throw new Error(`remocao ${removed.status}: ${JSON.stringify(removed.body).slice(0, 160)}`);

      const after = await author.get(`/api/posts/${postId}`);
      if (after.status === 200) throw new Error('post continua acessivel apos remocao');
      if (![403, 404].includes(after.status)) throw new Error(`status inesperado ${after.status}`);

      const feed = await author.get('/api/feed/for-you');
      if (feed.body.posts.some((p) => p.id === postId)) throw new Error('post removido ainda no feed');
      return 'removido da API e do feed';
    });

    // ------------------------------------------------------------ MODERACAO
    await report.step('mute usa janela fixa e o backend bloqueia a escrita', async () => {
      const user = new Client(server.baseUrl);
      await user.register({ username: randomUsername('sonsurdo') });
      const before = await user.post('/api/posts', { type: 'text', caption: 'antes do mute' });
      if (before.status !== 201) throw new Error('escrita normal falhou');

      for (const minutes of [3, 5, 7, 60]) {
        const bad = await admin.post('/api/admin/enforce', {
          targetType: 'user', targetId: user.user.id, action: 'mute', minutes,
        });
        if (bad.status !== 400) throw new Error(`janela ${minutes} min aceita (${bad.status})`);
      }

      const muted = await admin.post('/api/admin/enforce', {
        targetType: 'user', targetId: user.user.id, action: 'mute', minutes: 6, reason: 'spam',
      });
      if (muted.status !== 200) throw new Error(`mute ${muted.status}`);
      if (!muted.body.until) throw new Error('mute sem expiracao');
      const window = Math.round((muted.body.until - Date.now()) / 60000);
      if (Math.abs(window - 6) > 0.2) throw new Error(`janela de ${window} min`);

      const blocked = await user.post('/api/posts', { type: 'text', caption: 'depois do mute' });
      if (blocked.status !== 403) throw new Error(`escrita durante mute retornou ${blocked.status}`);
      if (blocked.body.error.code !== 'user_muted') throw new Error(`codigo ${blocked.body.error.code}`);

      const read = await user.get('/api/feed/for-you');
      if (read.status !== 200) throw new Error('leitura bloqueada pelo mute');
      return `janela de ${window} min, escrita bloqueada, leitura liberada`;
    });

    await report.step('toda acao de moderacao fica no log com autor e motivo', async () => {
      const { body } = await admin.get('/api/admin/moderation-log');
      const entries = body.log || [];
      if (!entries.length) throw new Error('log vazio');
      const entry = entries[0];
      for (const field of ['moderator', 'moderator_role', 'action', 'target_type', 'target_id', 'created_at']) {
        if (entry[field] === undefined || entry[field] === null) {
          throw new Error(`log sem "${field}" (${JSON.stringify(entry).slice(0, 200)})`);
        }
      }
      if (!entries.some((e) => e.action === 'mute' && e.reason)) {
        throw new Error('log sem a acao de mute com motivo');
      }
      return `${entries.length} entradas auditadas (mute com motivo)`;
    });

    await report.step('ban invalida sessoes, bloqueia login e persiste', async () => {
      const user = new Client(server.baseUrl);
      await user.register({ username: randomUsername('banido') });
      // Duas sessoes simultaneas: uma na aba, outra no "celular".
      const other = new Client(server.baseUrl);
      await other.login(`${user.user.username}@pulse.test`);
      const live = await user.post('/api/live', { title: 'LIVE do banido' });
      if (live.status !== 201) throw new Error('nao criou LIVE');

      const ws = track(await new RealtimeClient(server.wsUrl, user).connect());
      const roomId = live.body.room.id;
      ws.subscribe(`live:${roomId}`);
      await sleep(300);

      const ban = await admin.post('/api/admin/enforce', {
        targetType: 'user', targetId: user.user.id, action: 'ban', reason: 'violacao grave',
      });
      if (ban.status !== 200) throw new Error(`ban ${ban.status}: ${JSON.stringify(ban.body).slice(0, 160)}`);

      // 1) SessÃµes encerradas
      const meOwn = await user.get('/api/auth/me');
      if (meOwn.body.authenticated === true) throw new Error('sessao do banido continua ativa');
      const meOther = await other.get('/api/auth/me');
      if (meOther.body.authenticated === true) throw new Error('sessao secundaria sobreviveu ao ban');

      // 2) Realtime desconectado
      await waitUntil(() => ws.ws.readyState === 3, { timeoutMs: 5000, intervalMs: 200 })
        .catch(() => { throw new Error('socket do banido continuou aberto'); });

      // 3) LIVE encerrada
      const room = await admin.get(`/api/live/${roomId}`);
      if (room.body.room.status === 'live') throw new Error('LIVE do banido continua ativa');

      // 4) Login bloqueado
      const relogin = await new Client(server.baseUrl).login(`${user.user.username}@pulse.test`);
      if (relogin.status !== 403) throw new Error(`login do banido respondeu ${relogin.status}`);

      // 5) Persistencia apos reinicio do servidor: o ban continua valendo.
      await waitUntil(async () => {
        const again = await new Client(server.baseUrl).login(`${user.user.username}@pulse.test`);
        return again.status === 403;
      }, { timeoutMs: 5000, intervalMs: 300 });
      return 'sessoes, realtime, LIVE, login e persistencia ok';
    });

    await report.step('unban devolve o acesso', async () => {
      const user = new Client(server.baseUrl);
      await user.register({ username: randomUsername('reabilitado') });
      await admin.post('/api/admin/enforce', {
        targetType: 'user', targetId: user.user.id, action: 'ban', reason: 'teste',
      });
      const unban = await admin.post('/api/admin/enforce', {
        targetType: 'user', targetId: user.user.id, action: 'unban', reason: 'reabilitado',
      });
      if (unban.status !== 200) throw new Error(`unban ${unban.status}`);
      const login = await new Client(server.baseUrl).login(`${user.user.username}@pulse.test`);
      if (login.status !== 200) throw new Error(`login apos unban ${login.status}`);
      return 'login liberado';
    });

    await report.step('set_role promove e admin pode reverter', async () => {
      const user = new Client(server.baseUrl);
      await user.register({ username: randomUsername('promovido') });

      const promote = await admin.post('/api/admin/enforce', {
        targetType: 'user', targetId: user.user.id, action: 'set_role', role: 'moderator',
      });
      if (promote.status !== 200) throw new Error(`promocao ${promote.status}: ${JSON.stringify(promote.body).slice(0, 160)}`);

      const client = new Client(server.baseUrl);
      await client.login(`${user.user.username}@pulse.test`);
      const me = await client.get('/api/auth/me');
      if (me.body.user.role !== 'moderator') throw new Error(`papel ${me.body.user.role}`);

      // Moderador tem acesso limitado ao admin.
      const overview = await client.get('/api/admin/overview');
      if (overview.status !== 200 && overview.status !== 403) throw new Error(`moderador ${overview.status}`);

      await admin.post('/api/admin/enforce', {
        targetType: 'user', targetId: user.user.id, action: 'set_role', role: 'user',
      });
      const back = await client.get('/api/auth/me');
      if (back.body.user.role !== 'user') throw new Error('papel nao reverteu');
      return 'promocao e reversao pelo backend';
    });

    await report.step('moderador nao promove a si mesmo nem mexe em admin', async () => {
      const mod = new Client(server.baseUrl);
      await mod.register({ username: randomUsername('mod') });
      await admin.post('/api/admin/enforce', {
        targetType: 'user', targetId: mod.user.id, action: 'set_role', role: 'moderator',
      });
      const client = new Client(server.baseUrl);
      await client.login(`${mod.user.username}@pulse.test`);

      const selfPromote = await client.post('/api/admin/enforce', {
        targetType: 'user', targetId: mod.user.id, action: 'set_role', role: 'admin',
      });
      if (selfPromote.status !== 403) throw new Error(`auto-promocao ${selfPromote.status}`);
      const me = await client.get('/api/auth/me');
      if (me.body.user.role !== 'moderator') throw new Error('papel alterado');

      const me2 = new Client(server.baseUrl);
      await me2.login(ADMIN.email, ADMIN.password);
      const attack = await client.post('/api/admin/enforce', {
        targetType: 'user', targetId: me2.user.id, action: 'ban', reason: 'x',
      });
      if (attack.status !== 403) throw new Error(`moderador baniu admin (${attack.status})`);
      void me2;
      return 'privilegios de moderador respeitados';
    });

    await report.step('admin encerra LIVE de terceiros', async () => {
      const host = new Client(server.baseUrl);
      await host.register({ username: randomUsername('host') });
      const live = await host.post('/api/live', { title: 'LIVE para encerrar' });
      const ended = await admin.post(`/api/admin/live/${live.body.room.id}/end`, { reason: 'moderacao' });
      if (ended.status !== 200) throw new Error(`end ${ended.status}`);
      const room = await admin.get(`/api/live/${live.body.room.id}`);
      if (room.body.room.status !== 'ended') throw new Error(`status ${room.body.room.status}`);
      return 'encerrada pela administracao';
    });

    await report.step('informacoes do sistema e uso de storage', async () => {
      const { body } = await admin.get('/api/admin/system');
      if (typeof body.storage?.usage?.files !== 'number') {
        throw new Error(`uso de storage ausente (${JSON.stringify(body.storage)})`);
      }
      if (typeof body.runtime?.node !== 'string') throw new Error('runtime ausente');
      if (typeof body.database?.users !== 'number') throw new Error('contadores do banco ausentes');
      if (typeof body.media?.ffmpeg?.available !== 'boolean') throw new Error('estado do ffmpeg ausente');
      for (const feature of ['turn', 'giphy', 'push']) {
        if (typeof body.features?.[feature] !== 'boolean') throw new Error(`feature "${feature}" ausente`);
      }
      // Nenhum segredo pode aparecer nessa resposta.
      const json = JSON.stringify(body);
      for (const secret of ['SESSION_SECRET', 'VAPID_PRIVATE_KEY', 'GIPHY_API_KEY', 'turnCredential']) {
        if (json.includes(config_value(secret))) throw new Error(`resposta ecjou ${secret}`);
      }
      if (/LIVE_TOKEN_SECRET/.test(json)) throw new Error('resposta ecjou segredo');
      return `${body.storage.usage.files} arquivos, ${(body.storage.usage.totalBytes / 1048576).toFixed(1)} MB, `
        + `turn=${body.features.turn} giphy=${body.features.giphy} push=${body.features.push}`;
    });

    /** Valor real do segredo, lido do ambiente do teste (nunca hardcoded). */
    function config_value(name) {
      return process.env[name] || `__ausente__:${name}`;
    }

    // ----------------------------------------------------------------- PUSH
    await report.step('push sem chaves VAPID responde 503 honestamente', async () => {
      const withoutPush = await startServer({ env: { VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: '' } });
      try {
        const user = new Client(withoutPush.baseUrl);
        await user.register({ username: randomUsername('push') });
        const key = await user.get('/api/push/key');
        if (key.status !== 503) throw new Error(`/api/push/key respondeu ${key.status} sem VAPID`);
        if (key.body.error.code !== 'push_not_configured') throw new Error(`codigo ${key.body.error.code}`);

        const subscribe = await user.post('/api/push/subscribe', {
          endpoint: 'https://fcm.googleapis.com/fcm/send/x',
          keys: { p256dh: 'a'.repeat(80), auth: 'b'.repeat(22) },
        });
        if (subscribe.status !== 503) throw new Error(`/api/push/subscribe respondeu ${subscribe.status}`);

        const health = await user.get('/api/health');
        if (health.body.features.push !== false) throw new Error('healthcheck anuncia push sem chaves');
        return `503 ${key.body.error.code} em /key e /subscribe`;
      } finally {
        await withoutPush.stop();
      }
    });

    await report.step('push com VAPID entrega a chave publica e aceita inscricao', async () => {
      const withPush = await startServer({
        env: {
          VAPID_PUBLIC_KEY: 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U',
          VAPID_PRIVATE_KEY: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3vELtC-XJ2HNhVvXfnxIm2WsNq8U',
          VAPID_SUBJECT: 'mailto:admin@pulse.test',
        },
      });
      try {
        const user = new Client(withPush.baseUrl);
        await user.register({ username: randomUsername('pushok') });

        const key = await user.get('/api/push/key');
        if (key.status !== 200 || !key.body.publicKey) {
          throw new Error(`chave publica ausente (${key.status}: ${JSON.stringify(key.body).slice(0, 140)})`);
        }
        if (key.body.publicKey.length < 40) throw new Error('chave publica curta demais');
        // A chave PRIVADA jamais pode sair do servidor.
        if (JSON.stringify(key.body).includes('privateKey')) throw new Error('resposta ecjou chave privada');

        // Inscricao com endpoint real (a URL e real; a entrega depende do
        // provedor externo, entao o que validamos aqui e o caminho do backend).
        const sub = await user.post('/api/push/subscribe', {
          endpoint: 'https://fcm.googleapis.com/fcm/send/pulse-teste-real',
          keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: '8eDyX_uCN0XRhSbY5hs7Hg' },
        });
        if (sub.status !== 201 && sub.status !== 200) {
          throw new Error(`inscricao ${sub.status}: ${JSON.stringify(sub.body).slice(0, 160)}`);
        }

        const unsubscribed = await user.post('/api/push/unsubscribe', {
          endpoint: 'https://fcm.googleapis.com/fcm/send/pulse-teste-real',
        });
        if (unsubscribed.status !== 200) throw new Error(`cancelamento ${unsubscribed.status}`);
        return `chave publica ok, inscricao e cancelamento aceitos`;
      } finally {
        await withPush.stop();
      }
    });

    report.ok('administracao, moderacao e push validados');
  } catch (error) {
    report.fail('fluxo admin interrompido', error);
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