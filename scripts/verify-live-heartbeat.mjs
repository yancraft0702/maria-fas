/**
 * Verificador do mecanismo de encerramento automatico por ausencia do host.
 *
 * Testa:
 * 1. host ativo (heartbeat) -> LIVE permanece ativa
 * 2. host para de enviar heartbeat -> sweeper encerra apos timeout
 * 3. host retorna antes do timeout -> heartbeat renovado cancela encerramento
 * 4. espectadores presentes NAO impedem encerramento
 * 5. LIVE encerrada nao aparece mais como "AO VIVO"
 * 6. historico da LIVE permanece intacto
 */

import { migrate } from '../server/db/index.js';
import * as live from '../server/domain/live.js';
import { all, get, run } from '../server/db/index.js';
import { sweepHostPresence } from '../server/realtime/handlers.js';

// Inicializa o banco (aplica migrations pendentes)
migrate({ silent: true });

let ok = 0;
let falhas = [];

function report(msg) {
  console.log(`  OK   ${msg}`);
  ok++;
}

function fail(msg) {
  console.log(`  FALHA ${msg}`);
  falhas.push(msg);
}

// ---------------------------------------------------------------------------
// 1) Host ativo: heartbeat mantem LIVE ativa
// ---------------------------------------------------------------------------
{
  const host = get("SELECT id FROM users WHERE username = 'maria'") || get('SELECT id FROM users LIMIT 1');
  const room = live.createRoom({ hostId: host.id, title: 'Teste heartbeat 1' });

  // Heartbeat inicial ja foi setado pelo createRoom
  const antes = live.getRoom(room.id);
  if (antes.status !== 'live') {
    fail(`LIVE nao iniciou como live: ${antes.status}`);
  } else {
    report('LIVE iniciada com status "live"');
  }

  // Simula heartbeat do host
  live.touchHostHeartbeat({ roomId: room.id, userId: host.id });
  const depois = live.getRoom(room.id);
  if (depois.last_host_heartbeat && depois.last_host_heartbeat > antes.started_at) {
    report('heartbeat do host registrado em last_host_heartbeat');
  } else {
    fail('heartbeat do host NAO foi registrado');
  }

  // Limpa
  live.endRoom({ roomId: room.id, actorId: host.id, actorRole: 'host', reason: 'test_cleanup' });
}

// ---------------------------------------------------------------------------
// 2) Host sai: heartbeat envelhece -> sweeper encerra
// ---------------------------------------------------------------------------
{
  const host = get("SELECT id FROM users WHERE username = 'maria'") || get('SELECT id FROM users LIMIT 1');
  const room = live.createRoom({ hostId: host.id, title: 'Teste heartbeat 2' });
  const hostViewer = { id: host.id };
  if (!live.activeLiveDirectory({ viewer: hostViewer }).some((entry) => entry.id === room.id)) {
    fail('LIVE ativa nao aparece no diretorio durante heartbeat valido');
  }

  // Simula que o heartbeat esta velho (host saiu ha 61s)
  const velho = Date.now() - 61_000;
  run('UPDATE live_rooms SET last_host_heartbeat = ? WHERE id = ?', { velho, id: room.id });

  if (live.activeLiveDirectory({ viewer: hostViewer }).some((entry) => entry.id === room.id)) {
    fail('LIVE stale continua no diretorio antes do sweeper');
  } else {
    report('diretorio ja exclui LIVE sem heartbeat recente');
  }

  sweepHostPresence();

  const depois = live.getRoom(room.id);
  if (depois.status === 'ended' && depois.ended_reason === 'host_timeout' && depois.ended_at) {
    report('sweeper encerrou a LIVE stale, gravou horario e marcou host_timeout');
  } else {
    fail(`LIVE NAO foi encerrada: ${depois.status}`);
  }
  try {
    const nova = live.createRoom({ hostId: host.id, title: 'Teste heartbeat apos timeout' });
    report('host iniciou outra LIVE depois do encerramento automatico');
    live.endRoom({ roomId: nova.id, actorId: host.id, actorRole: 'host', reason: 'test_cleanup' });
  } catch (error) {
    fail(`host nao conseguiu iniciar outra LIVE: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// 3) Host retorna antes do timeout: heartbeat renovado cancela encerramento
// ---------------------------------------------------------------------------
{
  const host = get("SELECT id FROM users WHERE username = 'maria'") || get('SELECT id FROM users LIMIT 1');
  const room = live.createRoom({ hostId: host.id, title: 'Teste heartbeat 3' });

  // Heartbeat velho (host saiu)
  const velho = Date.now() - 50_000; // 50s < 60s
  run('UPDATE live_rooms SET last_host_heartbeat = ? WHERE id = ?', { velho, id: room.id });

  // Host retorna e envia heartbeat
  live.touchHostHeartbeat({ roomId: room.id, userId: host.id });

  sweepHostPresence();
  if (live.getRoom(room.id).status === 'live') {
    report('heartbeat renovado cancelou o encerramento pendente');
  } else {
    fail('heartbeat renovado NAO cancelou o encerramento');
  }

  // Limpa
  live.endRoom({ roomId: room.id, actorId: host.id, actorRole: 'host', reason: 'test_cleanup' });
}

// ---------------------------------------------------------------------------
// 4) Espectadores presentes NAO impedem encerramento
// ---------------------------------------------------------------------------
{
  const host = get("SELECT id FROM users WHERE username = 'maria'") || get('SELECT id FROM users LIMIT 1');
  const viewer = get("SELECT id FROM users WHERE username = 'marcos'") || get('SELECT id FROM users LIMIT 1');
  const room = live.createRoom({ hostId: host.id, title: 'Teste heartbeat 4' });

  // Espectador entra
  live.joinRoom({ roomId: room.id, userId: viewer.id });

  // Host sai (heartbeat velho)
  const velho = Date.now() - 61_000;
  run('UPDATE live_rooms SET last_host_heartbeat = ? WHERE id = ?', { velho, id: room.id });

  sweepHostPresence();

  const depois = live.getRoom(room.id);
  if (depois.status === 'ended') {
    report('LIVE encerrada mesmo com espectador presente');
  } else {
    fail(`LIVE NAO foi encerrada com espectador: ${depois.status}`);
  }
}

// ---------------------------------------------------------------------------
// 5) Timestamp ausente: LIVE presa antiga nao bloqueia uma nova
// ---------------------------------------------------------------------------
{
  const host = get("SELECT id FROM users WHERE username = 'maria'") || get('SELECT id FROM users LIMIT 1');
  const room = live.createRoom({ hostId: host.id, title: 'Teste LIVE sem heartbeat' });
  run('UPDATE live_rooms SET last_host_heartbeat = NULL WHERE id = ?', { id: room.id });

  const nova = live.createRoom({ hostId: host.id, title: 'Teste recuperacao LIVE presa' });
  const anterior = live.getRoom(room.id);
  if (anterior.status === 'ended' && anterior.ended_reason === 'host_timeout' && nova.status === 'live') {
    report('LIVE presa sem heartbeat foi encerrada e liberou uma nova sala');
  } else {
    fail('LIVE presa sem heartbeat bloqueou a nova transmissao');
  }
  live.endRoom({ roomId: nova.id, actorId: host.id, actorRole: 'host', reason: 'test_cleanup' });
}

// ---------------------------------------------------------------------------
// 6) LIVE encerrada nao aparece como "AO VIVO"
// ---------------------------------------------------------------------------
{
  const host = get("SELECT id FROM users WHERE username = 'maria'") || get('SELECT id FROM users LIMIT 1');
  const room = live.createRoom({ hostId: host.id, title: 'Teste heartbeat 5' });
  live.endRoom({ roomId: room.id, actorId: host.id, actorRole: 'host', reason: 'test_cleanup' });

  const ativas = all("SELECT id FROM live_rooms WHERE status = 'live' AND id = ?", { id: room.id });
  if (ativas.length === 0) {
    report('LIVE encerrada nao aparece mais como "AO VIVO"');
  } else {
    fail('LIVE encerrada ainda aparece como ativa');
  }
  if (live.activeLiveDirectory({ viewer: { id: host.id } }).some((entry) => entry.id === room.id)) {
    fail('LIVE encerrada permanece no diretorio');
  } else {
    report('LIVE encerrada ausente do diretorio ativo');
  }
}

// ---------------------------------------------------------------------------
// 7) Historico da LIVE permanece intacto
// ---------------------------------------------------------------------------
{
  const host = get("SELECT id FROM users WHERE username = 'maria'") || get('SELECT id FROM users LIMIT 1');
  const room = live.createRoom({ hostId: host.id, title: 'Teste historico' });

  // Adiciona comentario e coracao
  const viewer = get("SELECT id FROM users WHERE username = 'marcos'") || get('SELECT id FROM users LIMIT 1');
  live.joinRoom({ roomId: room.id, userId: viewer.id });
  live.postLiveMessage({ roomId: room.id, userId: viewer.id, body: 'Comentario de teste' });
  live.sendHearts({ roomId: room.id, userId: viewer.id, quantity: 5 });

  // Encerra
  live.endRoom({ roomId: room.id, actorId: host.id, actorRole: 'host', reason: 'test_cleanup' });

  // Verifica historico
  const comentarios = all("SELECT id FROM live_messages WHERE room_id = ?", { roomId: room.id });
  const coracoes = get("SELECT COALESCE(SUM(quantity),0) as total FROM live_likes WHERE room_id = ?", { roomId: room.id });

  if (comentarios.length > 0 && coracoes.total === 5) {
    report('historico da LIVE (comentarios e coracoes) permanece intacto');
  } else {
    fail(`historico perdido: ${comentarios.length} comentarios, ${coracoes.total} coracoes`);
  }
}

// ---------------------------------------------------------------------------
// Resumo
// ---------------------------------------------------------------------------
console.log(`\n[LIVE: encerramento automatico por ausencia do host] ${ok} ok, ${falhas.length} falha(s)`);
if (falhas.length > 0) {
  console.log('\nFalhas:');
  for (const f of falhas) console.log(`  - ${f}`);
  process.exit(1);
}
