import config from './config.js';
import logger from './lib/logger.js';
import { createServer } from './http.js';
import { serveStatic } from './static.js';
import router from './router.js';
import { recordAudit, loadSession } from './middleware.js';
import { getDb, migrate, closeDb } from './db/index.js';
import { ensureBuckets } from './storage/index.js';
import hub from './realtime/hub.js';
import { registerPublishHandlers, wirePresence, startHostPresenceSweeper } from './realtime/handlers.js';
import { wireAdminActivity } from './domain/admin-activity.js';
import { purgeExpiredSessions } from './domain/sessions.js';
import { expireOldStories, purgeExpiredStories } from './domain/stories.js';
import { purgeEndedRooms } from './domain/live.js';
import { syncEffectCatalog, prepareEffectCatalog } from './domain/effects.js';
import { backfillAudioDurations } from './media/upload.js';

// Registra TODAS as rotas exatamente uma vez (o router falha se houver duplicata).
import './routes/auth.js';
import './routes/users.js';
import './routes/social.js';
import './routes/posts.js';
import './routes/media.js';
import './routes/chat.js';
import './routes/live.js';
import './routes/notifications.js';
import './routes/discovery.js';
import './routes/admin.js';
import './static.js';
import * as network from './lib/network.js';

async function main() {
  const bootStart = Date.now();

  // ---- Banco ----
  getDb();
  const migrations = migrate();
  logger.info('banco pronto', { path: config.databasePath, ...migrations });

  // ---- Storage ----
  await ensureBuckets();

  // ---- Efeitos oficiais ----
  // O catálogo e os assets são sincronizados antes de aceitar tráfego, para
  // que os quinze cards sempre tenham animação transparente e áudio válidos.
  const created = syncEffectCatalog();
  if (created.length) logger.info('catalogo de efeitos sincronizado', { created: created.length });
  await prepareEffectCatalog();

  // ---- HTTP ----
  const server = createServer({
    router,
    onRequestEnd: recordAudit,
    getSocketForUser: (userId) => hub.byUser.get(userId),
    serveStatic,
    loadSession,
  });

  hub.attach(server, '/ws');
  registerPublishHandlers();
  wirePresence();
  // Itens 17 e 18: presenca (online/offline) passa a alimentar o painel.
  wireAdminActivity();
  // Encerramento automatico da LIVE apos 60s sem heartbeat do host.
  startHostPresenceSweeper();

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, resolve);
  }).catch((err) => {
    if (err.code === 'EADDRINUSE') {
      logger.error(`porta ${config.port} ja esta em uso`, { host: config.host, port: config.port });
    } else {
      logger.error('falha ao iniciar o servidor HTTP', { error: err.message });
    }
    process.exit(1);
  });

  const routes = router.list();
  // Item 9/10: em HTTPS de desenvolvimento o endereco util e o IP da maquina
  // na rede local (o celular acessa por ele e a origem passa a ser um contexto
  // seguro: camera, microfone, WebRTC e LIVE).
  const scheme = config.useTls ? 'https' : 'http';
  const enderecos = [`${scheme}://localhost:${config.port}`];
  for (const ip of network.lanAddresses()) enderecos.push(`${scheme}://${ip}:${config.port}`);
  logger.info('MARIA FÃS no ar', {
    url: `${scheme}://${config.host}:${config.port}`,
    enderecos,
    tls: config.useTls,
    env: config.nodeEnv,
    routes: routes.length,
    bootMs: Date.now() - bootStart,
  });
  setImmediate(() => {
    backfillAudioDurations().catch((err) => {
      logger.error('falha ao normalizar duracoes de audios antigos', { error: err.message });
    });
  });
  if (!config.useTls) {
    logger.warn('rodando em HTTP: camera/microfone/WebRTC so funcionam em localhost ou via HTTPS (rode: node scripts/dev-cert.mjs)');
  }

  // ---- Tarefas periodicas ----
  const housekeeping = setInterval(() => {
    try {
      purgeExpiredSessions();
      expireOldStories();
      purgeEndedRooms();
    } catch (err) {
      logger.error('falha no housekeeping', { error: err.message });
    }
  }, 15 * 60 * 1000);
  housekeeping.unref?.();

  const storyPurge = setInterval(() => {
    try {
      purgeExpiredStories();
    } catch (err) {
      logger.error('falha na limpeza de stories', { error: err.message });
    }
  }, 60 * 60 * 1000);
  storyPurge.unref?.();

  // ---- Encerramento gracioso ----
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('encerrando', { signal });
    clearInterval(housekeeping);
    clearInterval(storyPurge);
    const forceExit = setTimeout(() => {
      logger.warn('forcando encerramento apos 8s');
      process.exit(1);
    }, 8000);
    forceExit.unref?.();
    try {
      server.close();
      await hub.close();
      closeDb();
      logger.info('encerramento concluido');
      process.exit(0);
    } catch (err) {
      logger.error('falha no encerramento', { error: err.message });
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('uncaughtException', (err) => {
    logger.error('uncaughtException', { error: err.message, stack: err.stack });
  });
  process.on('unhandledRejection', (reason) => {
    logger.error('unhandledRejection', { reason: String(reason?.message || reason) });
  });

  return server;
}

main().catch((err) => {
  logger.error('falha fatal no boot', { error: err.message, stack: err.stack });
  process.exit(1);
});
