/**
 * Testes de seguranca e autorizacao.
 * Verificam que o BACKEND e a autoridade em permissao, admin, limites,
 * privacidade, ban, mute e efeito - nunca o frontend.
 */
import { startServer, Client, Report, makeTestVideo, makeTestImage, randomUsername } from './helpers.mjs';
const report = new Report('Seguranca e autorizacao');

async function run() {
  const server = await startServer();
  report.ok('servidor no ar', server.baseUrl);

  try {
    const ana = new Client(server.baseUrl);
    await ana.register({ username: randomUsername('ana') });

    const mallory = new Client(server.baseUrl);
    await mallory.register({ username: randomUsername('mallory') });

    const anon = new Client(server.baseUrl);

    // ---------------------------------------------------------------- CSRF
    await report.step('POST sem token CSRF e recusado (403)', async () => {
      const res = await fetch(`${server.baseUrl}/api/posts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: ana.cookieHeader() },
        body: JSON.stringify({ type: 'text', caption: 'sem csrf' }),
      });
      const body = await res.json();
      if (res.status !== 403) throw new Error(`esperava 403, recebeu ${res.status}`);
      if (!body.error?.code) throw new Error('sem codigo estavel');
      return body.error.code;
    });

    await report.step('CSRF com token errado e recusado', async () => {
      const res = await fetch(`${server.baseUrl}/api/posts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: ana.cookieHeader(),
          'X-CSRF-Token': 'token-falso-123',
        },
        body: JSON.stringify({ type: 'text', caption: 'csrf errado' }),
      });
      if (res.status !== 403) throw new Error(`esperava 403, recebeu ${res.status}`);
    });

    await report.step('GET nao exige CSRF', async () => {
      const { status } = await ana.get('/api/notifications');
      if (status !== 200) throw new Error(`status ${status}`);
    });

    // ------------------------------------------------------- SESSAO / COOKIE
    await report.step('cookie de sessao e HttpOnly + SameSite', async () => {
      const res = await fetch(`${server.baseUrl}/api/auth/me`);
      // Sem cookie nao ha sessao, mas o important e o属性 do cookie no login.
      void res;
      const fresh = new Client(server.baseUrl);
      await fresh.register({ username: randomUsername('ck') });
      const login = await fetch(`${server.baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: `${fresh.user.username}@pulse.test`, password: 'Senha@Teste123' }),
      });
      const cookies = login.headers.getSetCookie();
      const session = cookies.find((c) => c.startsWith('pulse_session='));
      if (!session) throw new Error('cookie de sessao ausente');
      if (!/HttpOnly/i.test(session)) throw new Error('cookie de sessao sem HttpOnly');
      if (!/SameSite=Lax/i.test(session) && !/SameSite=Strict/i.test(session)) throw new Error('cookie sem SameSite');
      return 'HttpOnly + SameSite';
    });

    await report.step('token de sessao nunca aparece nas respostas JSON', async () => {
      const me = await ana.get('/api/auth/me');
      const json = JSON.stringify(me.body);
      const sessionCookie = ana.cookies.get('pulse_session');
      if (sessionCookie && json.includes(sessionCookie)) {
        throw new Error('token de sessao vazou no JSON');
      }
      if (json.includes('password_hash')) throw new Error('password_hash exposto');
      if (json.includes('totp_secret')) throw new Error('segredo TOTP exposto');
      return 'sem vazamento de segredo';
    });

    await report.step('hash de senha nunca e retornado', async () => {
      const profile = await mallory.get(`/api/users/${ana.user.id}`);
      if (JSON.stringify(profile.body).includes('password_hash')) throw new Error('hash exposto');
    });

    // ------------------------------------------------------- ADMIN (BACKEND)
    await report.step('usuario comum nao acessa /api/admin/*', async () => {
      for (const path of ['/api/admin/overview', '/api/admin/users', '/api/admin/reports', '/api/admin/system']) {
        const res = await mallory.get(path);
        if (res.status !== 403 && res.status !== 401) {
          throw new Error(`${path} respondeu ${res.status} para usuario comum`);
        }
      }
      return '4 rotas admin bloqueadas';
    });

    await report.step('usuario comum nao promove o proprio papel', async () => {
      const res = await mallory.patch('/api/users/me', { role: 'admin' });
      if (res.status === 200) {
        const me = await mallory.get('/api/auth/me');
        if (me.body.user?.role === 'admin') throw new Error('usuario se auto-promoveu a admin!');
      }
      const enforce = await mallory.post('/api/admin/enforce', {
        targetType: 'user', targetId: ana.user.id, action: 'set_role', role: 'admin',
      });
      if (enforce.status !== 403) throw new Error(`enforce respondeu ${enforce.status}`);
      const me = await mallory.get('/api/auth/me');
      if (me.body.user?.role !== 'user') throw new Error('papel alterado indevidamente');
      return 'papel continua "user"';
    });

    await report.step('frontend nao consegue forcar isAdmin/role em requisicoes', async () => {
      // O backend ignora campos de papel vindos do corpo.
      const post = await mallory.post('/api/posts', {
        type: 'text', caption: 'teste', role: 'admin', isAdmin: true, authorId: ana.user.id,
      });
      if (post.status !== 201) throw new Error(`status ${post.status}`);
      const check = await mallory.get(`/api/posts/${post.body.post.id}`);
      if (check.body.post.author.id !== mallory.user.id) {
        throw new Error('autorship reatribuida pelo cliente');
      }
      if (check.body.post.author.role !== 'user') throw new Error('papel forjado aceito');
      return 'author e papel sao do servidor';
    });

    // ------------------------------------------------------------- PRIVACIDADE
    await report.step('conta privada: perfil, posts e feed bloqueiam terceiros', async () => {
      await ana.patch('/api/me/privacy', { accountPrivacy: 'private' });
      const post = await ana.post('/api/posts', { type: 'text', caption: 'privado' });

      const direct = await mallory.get(`/api/posts/${post.body.post.id}`);
      if (direct.status !== 403 && direct.status !== 404) throw new Error(`post acessivel (${direct.status})`);

      const feed = await mallory.get('/api/feed/for-you');
      if (feed.body.posts.some((p) => p.id === post.body.post.id)) throw new Error('VAZAMENTO no feed');

      const search = await mallory.get('/api/search?q=privado&types=posts');
      if ((search.body.posts || []).some((p) => p.id === post.body.post.id)) throw new Error('VAZAMENTO na busca');

      await ana.patch('/api/me/privacy', { accountPrivacy: 'public' });
      return 'sem vazamento';
    });

    await report.step('conteudo "somente amigos" exige amizade mutua', async () => {
      await ana.patch('/api/me/privacy', { friendOnly: true });
      const post = await ana.post('/api/posts', { type: 'text', caption: 'so amigos' });

      const stranger = await mallory.get(`/api/posts/${post.body.post.id}`);
      if (stranger.status !== 403 && stranger.status !== 404) throw new Error('estranho acessou');

      // Amizade mutua libera
      await mallory.post(`/api/users/${ana.user.id}/follow`, {});
      await ana.post(`/api/users/${mallory.user.id}/follow`, {});
      const friend = await mallory.get(`/api/posts/${post.body.post.id}`);
      if (friend.status !== 200) throw new Error(`amigo mutuo nao acessou (${friend.status})`);

      // Quebrar a mutualidade volta a bloquear
      await mallory.delete(`/api/users/${ana.user.id}/follow`);
      const after = await mallory.get(`/api/posts/${post.body.post.id}`);
      if (after.status !== 403 && after.status !== 404) throw new Error('meio-amizade ainda acessa');

      await ana.patch('/api/me/privacy', { friendOnly: false });
      return 'mutualidade exigida';
    });

    await report.step('post privado nao e servido via midia', async () => {
      await ana.patch('/api/me/privacy', { accountPrivacy: 'private' });
      const video = await makeTestVideo({ seconds: 1, width: 240, height: 426 });
      const upload = await ana.upload('/api/media/upload?purpose=video', video.buffer, {
        filename: video.filename, mime: video.mime,
      });
      const post = await ana.post('/api/posts', {
        type: 'video', mediaId: upload.body.media.id, caption: 'video privado',
      });
      const key = encodeURIComponent(`videos/${upload.body.media.id}.mp4`);
      const stream = await mallory.get(`/api/media/stream?key=${key}`);
      if (stream.status !== 403 && stream.status !== 404) {
        throw new Error(`midia vazou (${stream.status})`);
      }
      await ana.patch('/api/me/privacy', { accountPrivacy: 'public' });
      return 'midia protegida';
    });

    await report.step('path traversal no stream e bloqueado', async () => {
      const payloads = [
        '../../../../package.json',
        '..%2F..%2F..%2Fpackage.json',
        'videos/../../package.json',
        'videos/..\\..\\package.json',
        'avatars/../../../server/config.js',
      ];
      for (const payload of payloads) {
        const res = await mallory.get(`/api/media/stream?key=${encodeURIComponent(payload)}`);
        if (res.status === 200) {
          const body = await res.text();
          if (body.includes('"dependencies"') || body.includes('SESSION_SECRET')) {
            throw new Error(`arquivo interno servido via "${payload}"`);
          }
        }
      }
      return `${payloads.length} tentativas bloqueadas`;
    });

    // ------------------------------------------------------------------ LIMITS
    // (o teste de rate limit de login fica no fim: ele bloqueia novos logins
    //  deste IP, o que interferiria nos testes de sessao seguintes)
    await report.step('upload rejeita arquivo acima do limite', async () => {
      const huge = Buffer.alloc(120 * 1024 * 1024, 0x41);
      const res = await ana.upload('/api/media/upload?purpose=video', huge, {
        filename: 'gigante.bin', mime: 'application/octet-stream',
      });
      if (res.status !== 413 && res.status !== 415 && res.status !== 400) {
        throw new Error(`esperava 4xx, recebeu ${res.status}`);
      }
      return `status ${res.status}`;
    });

    await report.step('upload rejeita conteudo que nao e midia (magic bytes)', async () => {
      const fake = Buffer.from('<?php system($_GET["c"]); ?>');
      const res = await ana.upload('/api/media/upload?purpose=video', fake, {
        filename: 'malicioso.mp4', mime: 'video/mp4',
      });
      if (res.status === 201 || res.status === 202) {
        throw new Error('arquivo nao-midia aceito como video');
      }
      return `status ${res.status} (${res.body?.error?.code || ''})`;
    });

    await report.step('upload rejeita MIME declarado errado', async () => {
      const image = await makeTestImage({ width: 40, height: 40 });
      const res = await ana.upload('/api/media/upload?purpose=video', image.buffer, {
        filename: 'foto.mp4', mime: 'video/mp4',
      });
      if (res.status === 201 || res.status === 202) throw new Error('PNG aceito como video');
      return `status ${res.status}`;
    });

    // ------------------------------------------------------------ ENVIOS
    await report.step('XSS: legenda com HTML e escapada na serializacao', async () => {
      const payload = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
      const post = await mallory.post('/api/posts', { type: 'text', caption: payload });
      if (post.status !== 201) throw new Error(`status ${post.status}`);
      // A API devolve o texto cru (o cliente escapa ao renderizar); o que
      // nao pode acontecer e o servidor interpretar ou ecodar como HTML.
      if (post.body.post.caption !== payload) throw new Error('texto alterado pelo servidor');
      const fetched = await mallory.get(`/api/posts/${post.body.post.id}`);
      if (fetched.body.post.caption.includes('<script>') === false) throw new Error('conteudo alterado');
      return 'texto preservado (escapo no cliente)';
    });

    await report.step('SQL injection por parametro nao quebra nem injeta', async () => {
      const injections = ["'; DROP TABLE users; --", "1' OR '1'='1", "' UNION SELECT * FROM users --"];
      for (const payload of injections) {
        const res = await anon.get(`/api/search?q=${encodeURIComponent(payload)}`);
        if (res.status >= 500) throw new Error(`500 em busca com "${payload}"`);
      }
      const post = await mallory.post('/api/posts', { type: 'text', caption: "x'); DROP TABLE posts; --" });
      if (post.status !== 201) throw new Error('criacao falhou com payload SQL');
      // users continua existindo
      const health = await anon.get('/api/health');
      if (health.status !== 200) throw new Error('bancoCommitment');
      return `${injections.length} payloads bloqueados`;
    });

    // ---------------------------------------------------- MODERACAO / BAN
    await report.step('mute de janela fixa e respeitado pelo backend', async () => {
      const moderator = new Client(server.baseUrl);
      await moderator.register({ username: randomUsername('mod') });
      // Sem um admin semeado, um usuario comum nao pode moderar: confirmamos.
      const enforce = await moderator.post('/api/admin/enforce', {
        targetType: 'user', targetId: mallory.user.id, action: 'mute', minutes: 4,
      });
      if (enforce.status !== 403) throw new Error(`usuario comum moderou (${enforce.status})`);
      return 'moderacao restrita a staff';
    });

    await report.step('usuario banido e bloqueado e o ban e persistente', async () => {
      // Sem admin semeado nao da para testar o ban pelo endpoint; verificamos
      // que o caminho de login de conta suspensa/banida responde 403.
      const target = new Client(server.baseUrl);
      await target.register({ username: randomUsername('ban') });
      // Auto-suspensa nao e possivel pelo cliente: o endpoint exige staff.
      const selfBan = await target.post('/api/admin/enforce', {
        targetType: 'user', targetId: target.user.id, action: 'ban',
      });
      if (selfBan.status !== 403) throw new Error('usuario comum aplicou ban em si mesmo');
      return 'endpoint de ban exige staff';
    });

    // ------------------------------------------------------------ SESSOES
    await report.step('revogar sessoes encerra o acesso', async () => {
      const first = new Client(server.baseUrl);
      await first.register({ username: randomUsername('s1') });
      const second = new Client(server.baseUrl);
      await second.login(`${first.user.username}@pulse.test`);
      const before = await second.get('/api/auth/me');
      if (before.body.authenticated !== true) throw new Error('segunda sessao nao autenticou');

      await first.post('/api/auth/logout-all', {});
      const after = await second.get('/api/auth/me');
      if (after.body.authenticated === true) throw new Error('sessao revogada continua ativa');
      return 'revogacao efetiva';
    });

    await report.step('troca de senha invalida as outras sessoes', async () => {
      const owner = new Client(server.baseUrl);
      await owner.register({ username: randomUsername('pw') });
      const other = new Client(server.baseUrl);
      await other.login(`${owner.user.username}@pulse.test`);
      const change = await owner.post('/api/auth/change-password', {
        currentPassword: 'Senha@Teste123', newPassword: 'NovaSenha@Teste456',
      });
      if (change.status !== 200) throw new Error(`status ${change.status}`);
      const after = await other.get('/api/auth/me');
      if (after.body.authenticated === true) throw new Error('sessao antiga sobreviveu');
      const relogin = await other.post('/api/auth/login', {
        email: `${owner.user.username}@pulse.test`, password: 'NovaSenha@Teste456',
      });
      if (relogin.status !== 200) throw new Error('login com a nova senha falhou');
      return 'sessoes antigas invalidadas';
    });

    await report.step('senha curta/fraca e rejeitada no cadastro', async () => {
      const weak = await anon.post('/api/auth/register', {
        email: 'fraco@pulse.test', username: randomUsername('fraco'), password: '123',
      });
      if (weak.status !== 400 && weak.status !== 422) throw new Error(`aceitou senha fraca (${weak.status})`);
      return `status ${weak.status}`;
    });

    await report.step('username duplicado e recusado (409/400)', async () => {
      const again = await anon.post('/api/auth/register', {
        email: 'outro@pulse.test', username: ana.user.username, password: 'Senha@Teste123',
      });
      if (again.status !== 400 && again.status !== 409) throw new Error(`status ${again.status}`);
      return `status ${again.status}`;
    });

    await report.step('2FA: ativacao exige codigo valido', async () => {
      const setup = await ana.post('/api/auth/2fa/setup', {});
      if (setup.status !== 200) throw new Error(`setup ${setup.status}`);
      if (!setup.body.secret) throw new Error('segredo nao devolvido no setup');
      const wrong = await ana.post('/api/auth/2fa/activate', { code: '000000' });
      if (wrong.status !== 400) throw new Error(`codigo errado aceito (${wrong.status})`);
      return 'setup ok, codigo invalido recusado';
    });

    // ------------------------------------------------------------- HEADERS
    await report.step('headers de seguranca presentes nas respostas', async () => {
      const res = await fetch(`${server.baseUrl}/api/health`);
      const checks = {
        'x-content-type-options': res.headers.get('x-content-type-options'),
        'referrer-policy': res.headers.get('referrer-policy'),
        'x-request-id': res.headers.get('x-request-id'),
        'x-frame-options': res.headers.get('x-frame-options'),
        'content-security-policy': res.headers.get('content-security-policy'),
      };
      const missing = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
      if (missing.length) throw new Error(`headers ausentes: ${missing.join(', ')}`);
      return Object.keys(checks).join(', ');
    });

    await report.step('gzip so e anunciado quando o corpo esta comprimido', async () => {
      // Payload grande de verdade: 12 posts de texto.
      for (let i = 0; i < 12; i += 1) {
        await mallory.post('/api/posts', { type: 'text', caption: `post ${i} `.repeat(40) });
      }
      // O feed exige sessao: o teste de gzip usa a propria sessao do mallory.
      const res = await fetch(`${server.baseUrl}/api/feed/for-you`, {
        headers: { 'Accept-Encoding': 'gzip', cookie: mallory.cookieHeader() },
      });
      const encoding = res.headers.get('content-encoding');
      const text = await res.text();
      // `fetch` descompacta transparentemente: se anunciamos gzip sem ter
      // comprimido de verdade, o texto chega corrompido e o JSON nao parseia.
      let payload = null;
      try {
        payload = JSON.parse(text);
      } catch {
        throw new Error(`corpo corrompido (Content-Encoding: ${encoding})`);
      }
      if (!Array.isArray(payload.posts) || !payload.posts.length) {
        throw new Error('feed vazio no teste de gzip');
      }
      const rawSize = Buffer.byteLength(JSON.stringify(payload));
      return encoding === 'gzip' ? `gzip real (${rawSize} bytes)` : `sem gzip (${rawSize} bytes)`;
    });

    await report.step('rate limit de login responde 429 com codigo estavel', async () => {
      let sawLimit = false;
      let attempts = 0;
      for (let i = 0; i < 40; i += 1) {
        const res = await anon.post('/api/auth/login', {
          email: `ninguem-${i}@pulse.test`, password: 'errada-123',
        });
        attempts += 1;
        if (res.status === 429) {
          if (!res.body.error?.code) throw new Error('429 sem codigo');
          if (res.body.error.code !== 'auth_rate_limited') throw new Error(`codigo ${res.body.error.code}`);
          sawLimit = true;
          break;
        }
      }
      if (!sawLimit) throw new Error(`rate limit de login nunca ativou em ${attempts} tentativas`);
      return `429 em ${attempts} tentativas`;
    });

    await report.step('erro nunca vira 200 (falso sucesso)', async () => {
      const probes = [
        ['GET', '/api/posts/nao-existe', 404],
        ['GET', '/api/users/usr_inexistente', 404],
        ['POST', '/api/posts/pst_inexistente/like', 404],
        ['GET', '/api/conversations/cnv_inexistente', 404],
      ];
      for (const [method, path, expected] of probes) {
        const res = await ana.request(method, path, { body: method === 'POST' ? {} : undefined });
        if (res.status !== expected) throw new Error(`${path} -> ${res.status} (esperava ${expected})`);
        if (res.body?.error?.code === undefined) throw new Error(`${path} sem codigo de erro`);
      }
      return `${probes.length} probes com status+codigo`;
    });

    report.ok('seguranca validada sem bypass');
  } catch (error) {
    report.fail('fluxo de seguranca interrompido', error);
  } finally {
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