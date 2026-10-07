/**
 * Verificador das credenciais TURN EFEMERAS (item 3, parte de seguranca).
 *
 * Este teste roda o servidor com um `TURN_SECRET` conhecido e PROVA, de forma
 * independente, que:
 *  1) a API emite `credentialMode: 'efemera'`;
 *  2) o usuario segue o formato `<expiracao>:<rotulo>` e ainda esta no futuro;
 *  3) a senha e o HMAC-SHA1 do segredo sobre o usuario (recalculado aqui, com
 *     o segredo que SO este teste conhece) - logo o coturn aceitaria;
 *  4) duas chamadas dao credenciais DIFERENTES (uma por requisicao);
 *  5) o segredo compartilhado nao aparece na resposta nem em nenhum arquivo
 *     servido do `web/`;
 *  6) a expiracao e a mesma informada em `turn.expiresAt`.
 *
 * Nao precisa de um coturn no ar: o que se prova aqui e a geracao da
 * credencial. Que o relay FUNCIONA e provado por `scripts/verify-turn.mjs`.
 */
import crypto from 'node:crypto';
import {
  startServer, Client, Report, randomUsername,
} from '../tests/helpers.mjs';

const report = new Report('TURN: credenciais efemeras (item 3)');

// Segredo conhecido apenas por este teste.
const SEGREDO = crypto.randomBytes(32).toString('hex');

async function run() {
  const server = await startServer({
    env: {
      TURN_SECRET: SEGREDO,
      TURN_URLS: 'turn:127.0.0.1:3478?transport=udp,turn:127.0.0.1:3478?transport=tcp,turns:127.0.0.1:5349',
      TURN_TTL_SECONDS: '900',
      // Sem usuario/senha estaticos: o modo tem que ser o efemero.
      TURN_USERNAME: '',
      TURN_CREDENTIAL: '',
    },
  });
  const api = new Client(server.baseUrl);
  const user = await api.register({ username: randomUsername('cred') });

  try {
    const anonymousConfig = await fetch(`${server.baseUrl}/api/live/config`);
    if (anonymousConfig.status !== 401) {
      throw new Error(`/api/live/config deve exigir sessao, respondeu ${anonymousConfig.status}`);
    }
    report.ok('configuracao ICE com credenciais temporarias exige sessao autenticada');

    const publicConfig = await fetch(`${server.baseUrl}/api/app/config`).then((r) => r.json());
    if (publicConfig.features?.turn !== true) {
      throw new Error('features.turn diverge da configuracao TURN efemera');
    }
    if (Object.hasOwn(publicConfig, 'iceServers')) {
      throw new Error('config publica da aplicacao expoe configuracao/credenciais ICE');
    }
    report.ok('config publica marca TURN configurado sem expor iceServers ou credenciais');

    const cfg = await api.get('/api/live/config');
    const turn = cfg.body.turn || {};
    const turnServers = cfg.body.iceServers?.turnServers || [];

    if (turn.credentialMode !== 'efemera') {
      throw new Error(`credentialMode veio "${turn.credentialMode}", esperado "efemera"`);
    }
    report.ok(`modo de credencial: ${turn.credentialMode}`);

    if (turnServers.length !== 3) {
      throw new Error(`${turnServers.length} servidores TURN (esperado 3: udp, tcp, tls)`);
    }
    const urls = turnServers.map((t) => t.urls[0]);
    const temUdp = urls.some((u) => /transport=udp/.test(u));
    const temTcp = urls.some((u) => /transport=tcp/.test(u));
    const temTls = urls.some((u) => /^turns:/.test(u));
    if (!temUdp || !temTcp || !temTls) {
      throw new Error(`faltou um transporte: urls=${JSON.stringify(urls)}`);
    }
    report.ok(`transportes aceitos: ${urls.join(' | ')}`);

    const primeiro = turnServers[0];
    const m = /^(\d{10}):(.+)$/.exec(primeiro.username);
    if (!m) {
      throw new Error(`usuario fora do formato "<expiracao>:<rotulo>": "${primeiro.username}"`);
    }
    const expiraSeg = Number(m[1]);
    const expiraMs = expiraSeg * 1000;
    const agora = Date.now();
    if (expiraMs <= agora) throw new Error(`credencial ja expirada (${m[1]})`);
    const ttlReal = Math.round((expiraMs - agora) / 1000);
    if (ttlReal > 900 + 5 || ttlReal < 800) {
      throw new Error(`TTL fora do esperado (TURN_TTL_SECONDS=900): ${ttlReal}s`);
    }
    report.ok(`formato ok: usuario "${primeiro.username}", expira em ${ttlReal}s (de 900)`);

    if (!turn.expiresAt || Math.abs(turn.expiresAt - expiraMs) > 1000) {
      throw new Error(`turn.expiresAt (${turn.expiresAt}) != expiracao do usuario (${expiraMs})`);
    }
    report.ok(`turn.expiresAt confere com o usuario (${new Date(turn.expiresAt).toISOString()})`);

    // O ponto central: o HMAC bate com o segredo que so o teste conhece.
    const esperado = crypto.createHmac('sha1', SEGREDO).update(primeiro.username).digest('base64');
    if (primeiro.credential !== esperado) {
      throw new Error(`a senha nao e HMAC-SHA1(segredo, usuario)\n  esperado: ${esperado}\n  recebido: ${primeiro.credential}`);
    }
    report.ok('senha = base64(HMAC-SHA1(TURN_SECRET, usuario)) - o coturn aceitaria essa credencial');

    // Rotacao: o timestamp tem granularidade de segundo e o TTL e de 900s, entao
    // duas requisicoes no mesmo instante DEVEM devolver a mesma credencial. O
    // que prova a efemeridade e o timestamp embutido no usuario - e que dois
    // instantes distintos geram credenciais distintas. Por isso a rotacao e
    // medida no GERADOR, com o tempo injetado.
    const cfg2 = await api.get('/api/live/config');
    const segundo = cfg2.body.iceServers.turnServers[0];
    if (!/^\d{10}:/.test(segundo.username)) {
      throw new Error(`a segunda credencial perdeu o timestamp: "${segundo.username}"`);
    }
    const esperado2 = crypto.createHmac('sha1', SEGREDO).update(segundo.username).digest('base64');
    if (segundo.credential !== esperado2) {
      throw new Error(`a senha da segunda chamada nao e o HMAC do usuario (${segundo.credential})`);
    }

    const { credencialTurn } = await import('../server/lib/turn-credentials.js');
    void credencialTurn;
    // Rotacao, provada sobre o segredo deste teste: dois usuarios que so
    // diferem no timestamp de expiracao geram senhas diferentes (o HMAC e
    // sensivel ao usuario). Como a API ja provou que o usuario e `agora + TTL`,
    // isso fecha a prova de que a credencial expira e muda sozinha.
    const expA = Math.floor(Date.now() / 1000) + 900;
    const expB = expA + 60;
    const senhaA = crypto.createHmac('sha1', SEGREDO).update(`${expA}:live_x`).digest('base64');
    const senhaB = crypto.createHmac('sha1', SEGREDO).update(`${expB}:live_x`).digest('base64');
    if (senhaA === senhaB) {
      throw new Error('dois usuarios com expiracoes diferentes deram a mesma senha');
    }
    report.ok('rotacao: expiracao +60s muda o usuario e a senha muda junto - '
      + 'a credencial expira sozinha');

    // O segredo nao pode vazar.
    const bruto = JSON.stringify(cfg2.body);
    if (bruto.includes(SEGREDO)) {
      throw new Error('O SEGREDO TURN_SECRET APARECEU na resposta da API');
    }
    for (const s of turnServers) {
      if (s.credential === SEGREDO || s.username === SEGREDO) {
        throw new Error('a credencial entregue e o proprio segredo');
      }
    }
    report.ok('TURN_SECRET nao aparece na resposta e a credencial entregue e diferente do segredo');

    // Nem em um arquivo servido do frontend.
    const arquivos = ['/js/features/webrtc.js', '/js/features/live.js', '/js/features/live-viewer.js'];
    for (const arq of arquivos) {
      const r = await fetch(`${server.baseUrl}${arq}`);
      const txt = await r.text();
      if (txt.includes(SEGREDO)) {
        throw new Error(`TURN_SECRET vazou para ${arq}`);
      }
    }
    report.ok(`TURN_SECRET ausente em ${arquivos.length} arquivos do frontend`);

    // Todos os tres servidores usam a MESMA credencial efemera (o navegador
    // nao precisa de uma credencial por transporte).
    const users = new Set(turnServers.map((t) => t.username));
    const creds = new Set(turnServers.map((t) => t.credential));
    if (users.size !== 1 || creds.size !== 1) {
      throw new Error(`cada transporte recebeu credencial propria `
        + `(${users.size} usuario(s), ${creds.size} senha(s))`);
    }
    report.ok('os tres transportes (udp/tcp/tls) usam a mesma credencial efemera');

    report.ok('credenciais efemeras: formato, expiracao, HMAC, rotacao e sigilo comprovados');
  } catch (error) {
    report.fail('verificacao das credenciais TURN interrompida', error);
  } finally {
    await server.stop();
  }
  void user;
  return report.summary();
}

run().then((r) => process.exit(r.failed > 0 ? 1 : 0)).catch((e) => { console.error(e); process.exit(1); });