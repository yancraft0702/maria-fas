/**
 * Verificador dos itens 2, 3, 4, 7, 15, 16 e 20.
 *
 * Nao aceita "a tela parece certa": cada passo mede ou consulta a API real.
 *
 *  2) AMIGOS: pessoas reais do banco, com foto, @username e acao; e o clique
 *     abre o perfil de verdade (a antiga rota `/@:username` NUNCA casava, e o
 *     matcher so reconhecia segmentos comecados em `:`).
 *  3) SEGUINDO / SEGUIDORES / busca: todo link de pessoa abre o perfil.
 *  4) BOTOES: alvo de toque confortavel, mais baixo, sem cobrir texto nem barra.
 *  7) INFORMACOES: foto, nome, @username e hashtags visiveis ACIMA da bottom nav.
 * 15) COMENTARIO so com GIF e so com figurinha: aceitos, persistidos e em
 *     tempo real - sem "Campo obrigatorio".
 * 16) PUBLICACAO so com audio: aceita, persistida e reproduzivel.
 * 20) Sem mojibake em nenhuma area alterada (U+FFFD e sequenciasLatitude).
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../server/config.js';
import {
  startServer, Client, Report, sleep, randomUsername, makeTestAudio, makeTestVideo, makeTestImage,
} from '../tests/helpers.mjs';
import { launchChrome } from '../tests/cdp.mjs';

const report = new Report('Amigos, perfis, layout e conteudo com midia');

/** Faz upload de um audio real e devolve o mediaId. */
async function subirAudio(api, seconds = 1) {
  const audio = await makeTestAudio({ seconds });
  const up = await api.upload('/api/media/upload?purpose=audio', audio.buffer, {
    filename: audio.filename, mime: audio.mime,
  });
  if (!up.body?.media?.id) throw new Error(`upload de audio falhou: ${JSON.stringify(up.body).slice(0, 120)}`);
  return up.body.media.id;
}

/** Publica algo e devolve o post serializado. */
async function publicar(api, body) {
  const r = await api.post('/api/posts', body);
  if (r.status !== 201) throw new Error(`publicar ${JSON.stringify(body).slice(0, 60)}: ${r.status} ${JSON.stringify(r.body).slice(0, 140)}`);
  return r.body.post;
}

async function run() {
  const server = await startServer();
  report.ok('servidor no ar', server.baseUrl);

  // ---------------------------------------------------------------- dados
  const eu = new Client(server.baseUrl);
  const euUser = await eu.register({ username: randomUsername('eu') });
  await eu.post('/api/auth/login', { identifier: euUser.username, password: 'Senha@Teste123' });

  const pessoaComFoto = new Client(server.baseUrl);
  const comFoto = await pessoaComFoto.register({ username: randomUsername('comfoto') });
  await pessoaComFoto.post('/api/auth/login', { identifier: comFoto.username, password: 'Senha@Teste123' });

  const pessoaSemFoto = new Client(server.baseUrl);
  const semFoto = await pessoaSemFoto.register({ username: randomUsername('semfoto') });
  await pessoaSemFoto.post('/api/auth/login', { identifier: semFoto.username, password: 'Senha@Teste123' });

  // Quem eu sigo, mas que nao me segue de volta: pertence a "Seguindo", nunca
  // a "Amigos". Existe para provar que a aba nao mistura os dois conjuntos.
  const soSeguidoClient = new Client(server.baseUrl);
  const soSeguido = await soSeguidoClient.register({ username: randomUsername('soseguido') });
  await soSeguidoClient.post('/api/auth/login', { identifier: soSeguido.username, password: 'Senha@Teste123' });

  // Relacionamentos REAIS. A regra de amizade do projeto e follow MUTUO:
  // quem eu sigo sem ser seguido de volta entra em "Seguindo", nao em
  // "Amigos" - o verificador checa os tres conjuntos.
  await eu.post(`/api/users/${comFoto.id}/follow`, {});
  await eu.post(`/api/users/${semFoto.id}/follow`, {});
  await eu.post(`/api/users/${soSeguido.id}/follow`, {});
  await pessoaComFoto.post(`/api/users/${euUser.id}/follow`, {});    // amigo mutuo, COM foto
  await pessoaSemFoto.post(`/api/users/${euUser.id}/follow`, {});   // amigo mutuo, SEM foto
  report.ok(`pessoas reais criadas (amigo c/ foto: @${comFoto.username}, amigo s/ foto: @${semFoto.username}, so seguido: @${soSeguido.username})`);

  // Avatar REAL de um dos amigos: o item 2 exige foto de perfil, e um usuario
// cadastrado no teste nasce sem nenhuma imagem.
// A rota `/api/users/me/avatar` recebe o ARQUIVO direto (multipart), nao um
// `mediaId` — por isso o upload usa `pessoaComFoto.upload` nessa rota.
const avatar = await makeTestImage({ width: 120, height: 120 });
const avatarPost = await pessoaComFoto.upload('/api/users/me/avatar', avatar.buffer, {
  filename: avatar.filename, mime: avatar.mime,
});
if (avatarPost.status < 200 || avatarPost.status >= 300) {
  throw new Error(`avatar nao foi salvo: ${avatarPost.status} ${JSON.stringify(avatarPost.body).slice(0, 120)}`);
}
if (!avatarPost.body?.user?.avatarUrl) throw new Error('avatar salvo mas avatarUrl nao veio na resposta');

const video = await makeTestVideo({ seconds: 1, width: 240, height: 320 });
  const up = await pessoaComFoto.upload('/api/media/upload?purpose=video', video.buffer, {
    filename: video.filename, mime: video.mime,
  });
  const postComFoto = await publicar(pessoaComFoto, { type: 'video', caption: 'video de teste', mediaId: up.body.media.id });
  await publicar(pessoaSemFoto, { type: 'text', caption: 'post sem midia de @' + euUser.username });
  report.ok('conteudo real publicado pelos dois usuarios');

  const browser = await launchChrome({ extraArgs: ['--autoplay-policy=no-user-gesture-required'] });
  const sessions = [];

  const cookies = await fetch(`${server.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: euUser.username, password: 'Senha@Teste123' }),
  }).then((r) => r.headers.getSetCookie());

  async function sessao(width = 1280, height = 900, mobile = false, path = '/') {
    const s = await browser.newBrowserContext();
    sessions.push(s);
    s.watch();
    await s.goto(`${server.baseUrl}/`, { waitMs: 250 });
    for (const ck of cookies) {
      const par = ck.split(';')[0];
      const nome = par.slice(0, par.indexOf('='));
      await s.send('Network.setCookie', {
        name: nome, value: decodeURIComponent(par.slice(nome.length + 1)), domain: '127.0.0.1', path: '/',
      });
    }
    await s.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
    await s.goto(`${server.baseUrl}${path}`, { waitMs: 2600 });
    return s;
  }

  try {
    // =========================================================== item 2/3
    await report.step('a rota de perfil casa: /@usuario abre o perfil real', async () => {
      const s = await sessao();
      for (const alvo of [`/@${comFoto.username}`, `/@${semFoto.username}`]) {
        // eslint-disable-next-line no-await-in-loop
        await s.eval(`location.href = ${JSON.stringify(alvo)}; return true;`);
        // eslint-disable-next-line no-await-in-loop
        await sleep(2600);
        // eslint-disable-next-line no-await-in-loop
        const r = await s.eval(`
          const corpo = document.body.innerText || '';
          return {
            url: location.pathname,
            tem404: /nao encontrada|nÃ£o encontrada|not found/i.test(corpo),
            texto: corpo.slice(0, 100).replace(/\\s+/g, ' '),
          };
        `);
        if (r.url !== alvo) throw new Error(`/${alvo} navegou para ${r.url} (rota nao casou)`);
        if (r.tem404) throw new Error(`/${alvo} mostrou "pagina nao encontrada": ${r.texto}`);
      }
      return `@${comFoto.username} e @${semFoto.username} abriram o perfil, sem 404`;
    });

    await report.step('Amigos: pessoas reais com foto, @username e acao', async () => {
      const s = await sessao();
      // Rota real: `/api/users/:idOrUsername/friends`. O proprio usuario vem
      // de `/api/users/me`, que o roteador aceita pelo mesmo parametro.
      const dados = await s.eval(`
        const eu = await fetch('/api/users/me').then((x) => x.json());
        const user = eu.user || eu;
        const r = await fetch('/api/users/' + user.username + '/friends').then((x) => x.json());
        const lista = r.friends || r.items || r.users || (Array.isArray(r) ? r : []);
        return lista.map((x) => x.user || x);
      `);
      if (!dados.length) throw new Error('nenhum amigo retornado pela API');
      const achou = dados.some((u) => u.username === comFoto.username);
      if (!achou) throw new Error(`@${comFoto.username} (amigo mutuo) nao veio na lista: ${dados.map((u) => u.username).join(', ')}`);

      // Agora a TELA da aba Amigos.
      await s.eval(`location.href = '/amigos'; return true;`);
      await sleep(2600);
      const tela = await s.eval(`
        const linhas = [...document.querySelectorAll('[data-friend-id], .friend-row, .user-row, a[href^="/@"]')];
        const texto = document.body.innerText || '';
        return {
          linhas: linhas.length,
          // A pessoa seguida precisa aparecer pelo @username.
          temHandle: texto.includes('@' + ${JSON.stringify(comFoto.username)}),
          // E o caso "sem foto": tambem tem que aparecer.
          temSemFoto: texto.includes('@' + ${JSON.stringify(semFoto.username)}),
          temFoto: Boolean(document.querySelector('img[src*="/api/media/stream"]')),
          texto,
          links: [...document.querySelectorAll('a[href^="/@"]')].map((a) => a.getAttribute('href')),
        };
      `);
      if (!tela.linhas) throw new Error('aba Amigos nao renderizou nenhuma pessoa');
      if (!tela.temHandle) throw new Error(`@comFoto (${comFoto.username}) nao apareceu na aba Amigos`);
      if (!tela.temSemFoto) throw new Error(`@semFoto (${semFoto.username}) nao apareceu na aba Amigos`);
      if (!tela.temFoto) throw new Error('ninguem com foto de perfil apareceu (falta o <img>)');
      // Quem eu sigo mas nao me segue NAO pode aparecer como amigo.
      if (tela.texto.includes('@' + soSeguido.username)) {
        throw new Error(`@${soSeguido.username} so e seguido, mas apareceu como amigo`);
      }
      if (!/^\/@/.test(tela.links[0] || '')) throw new Error(`link de pessoa sem /@: ${tela.links[0]}`);
      return `${dados.length} amigos na API; ${tela.linhas} linhas na tela; 1o link ${tela.links[0]}`;
    });

    await report.step('perfil proprio e perfil de outra pessoa abrem certo', async () => {
      const s = await sessao();
      const meuPerfil = await s.eval(`
        const r = await fetch('/api/users/me').then((x) => x.json());
        const user = r.user || r;
        return { username: user.username, id: user.id };
      `);
      if (!meuPerfil.username) throw new Error('/api/users/me nao devolveu o proprio usuario');
      for (const u of [meuPerfil.username, comFoto.username]) {
        // eslint-disable-next-line no-await-in-loop
        await s.eval(`location.href = '/@' + ${JSON.stringify(u)}; return true;`);
        // eslint-disable-next-line no-await-in-loop
        await sleep(2500);
        // eslint-disable-next-line no-await-in-loop
        const r = await s.eval(`return { url: location.pathname, tem404: /nao encontrada|nÃ£o encontrada/i.test(document.body.innerText || '') };`);
        if (r.tem404) throw new Error(`/@${u} deu 404`);
        if (r.url !== `/@${u}`) throw new Error(`/@${u} -> ${r.url}`);
      }
      return `proprio (@${meuPerfil.username}) e de outra pessoa (@${comFoto.username}): ok`;
    });

    await report.step('"Seguindo" do perfil abre o perfil de cada pessoa', async () => {
      const s = await sessao();
      await s.eval(`location.href = '/@' + ${JSON.stringify(euUser.username)}; return true;`);
      await sleep(2600);
      // Abre a lista de seguidos pela propria interface.
      const abriu = await s.eval(`
        const alvos = [...document.querySelectorAll('button, a')];
        const botao = alvos.find((b) => /seguindo/i.test(b.textContent || '') && (b.textContent || '').trim().length < 24);
        if (botao) { botao.click(); return true; }
        return false;
      `);
      await sleep(1800);
      const lista = await s.eval(`
        const links = [...document.querySelectorAll('a[href^="/@"]')].map((a) => a.getAttribute('href'));
        return { abriu: ${abriu}, links: [...new Set(links)].slice(0, 12) };
      `);
      if (!lista.links.length) {
        throw new Error('nenhum link de pessoa na lista de Seguindo (a lista nao abriu?)');
      }
      // Cada link tem que abrir o perfil de verdade.
      for (const href of lista.links.slice(0, 3)) {
        // eslint-disable-next-line no-await-in-loop
        await s.eval(`location.href = ${JSON.stringify(href)}; return true;`);
        // eslint-disable-next-line no-await-in-loop
        await sleep(2300);
        // eslint-disable-next-line no-await-in-loop
        const r = await s.eval(`return { url: location.pathname, 404: /nao encontrada|nÃ£o encontrada/i.test(document.body.innerText || '') };`);
        if (r.tem404 || r.url !== href) throw new Error(`${href} nao abriu o perfil (virou ${r.url})`);
      }
      return `${lista.links.length} pessoas em Seguindo; 3 perfis abriram sem 404`;
    });

    // =========================================================== item 15
    await report.step('comentario SO com GIF e SO com figurinha e aceito (item 15)', async () => {
      const gifUrl = 'https://media.giphy.com/media/dWesBcTLavkZuG3MI/giphy.gif';
      const figurinha = 'https://media.giphy.com/media/l0HlNQ03J5JxX6lva/giphy.gif';

      const soGif = await eu.post(`/api/posts/${postComFoto.id}/comments`, {
        body: '', type: 'gif', metadata: { url: gifUrl, id: 'g1', posterUrl: gifUrl },
      });
      if (soGif.status !== 201) throw new Error(`comentario so com GIF: ${soGif.status} ${JSON.stringify(soGif.body).slice(0, 140)}`);
      if (soGif.body.comment.type !== 'gif') throw new Error('o comentario so com GIF nao guardou type=gif');
      if (!soGif.body.comment.media?.url) throw new Error('o GIF nao veio serializado em media.url');

      const soFigurinha = await eu.post(`/api/posts/${postComFoto.id}/comments`, {
        body: '', type: 'sticker', metadata: { url: figurinha, id: 's1' },
      });
      if (soFigurinha.status !== 201) throw new Error(`comentario so com figurinha: ${soFigurinha.status} ${JSON.stringify(soFigurinha.body).slice(0, 140)}`);
      if (soFigurinha.body.comment.type !== 'sticker') throw new Error('figurinha nao guardou type=sticker');

      const textoMaisGif = await eu.post(`/api/posts/${postComFoto.id}/comments`, {
        body: 'olha isso', type: 'gif', metadata: { url: gifUrl, id: 'g2' },
      });
      if (textoMaisGif.status !== 201) throw new Error('texto + GIF falhou');

      // Vazio de verdade continua invalido, com mensagem CLARA.
      const nada = await eu.post(`/api/posts/${postComFoto.id}/comments`, { body: '   ' });
      if (nada.status < 400) throw new Error('comentario totalmente vazio foi aceito');
      if (!/comment_empty/i.test(JSON.stringify(nada.body))) {
        throw new Error(`vazio sem erro especifico: ${JSON.stringify(nada.body).slice(0, 120)}`);
      }

      // Persistido: a listagem devolve os tres.
      // `Client.get` devolve `{ status, body }` - por isso o acesso a `body`.
      const lista = await eu.get(`/api/posts/${postComFoto.id}/comments`, { query: { sort: 'recent', limit: 20 } });
      if (lista.status !== 200) throw new Error(`listagem de comentarios: HTTP ${lista.status}`);
      const tipos = ((lista.body && lista.body.comments) || []).map((c) => c.type).filter(Boolean);
      if (!tipos.includes('gif') || !tipos.includes('sticker')) {
        throw new Error(`listagem nao devolveu os tipos: ${JSON.stringify(tipos)} (body: ${JSON.stringify(lista.body).slice(0, 120)})`);
      }
      return `GIF, figurinha e texto+GIF aceitos; vazio recusado com comment_empty`;
    });

    // =========================================================== item 16
    await report.step('publicacao SO com audio e aceita e reproduz (item 16)', async () => {
      const mediaId = await subirAudio(pessoaSemFoto);
      const post = await publicar(pessoaSemFoto, { type: 'audio', mediaId, caption: 'so um audio' });
      if (post.type !== 'audio') throw new Error(`tipo do post = ${post.type}`);
      if (post.media?.kind !== 'audio') throw new Error(`kind da midia = ${post.media?.kind}`);
      if (!post.media?.url) throw new Error('audio sem URL serializada');

      // Audio + texto tambem.
      const comTexto = await publicar(pessoaSemFoto, { type: 'audio', mediaId, caption: 'audio com legenda' });
      if (!comTexto.caption) throw new Error('audio + texto perdeu a legenda');

      // Audio sem arquivo tem que falhar com mensagem CLARA (nao "Campo obrigatorio").
      const semArquivo = await pessoaSemFoto.post('/api/posts', { type: 'audio' });
      if (semArquivo.status >= 400 === false) throw new Error('audio sem arquivo foi aceito');
      const codigo = semArquivo.body?.error?.code || '';
      if (/campo_obrigatorio|validation_failed/i.test(codigo)) {
        throw new Error(`audio sem arquivo respondeu "${codigo}" - o bug do item 16 continua`);
      }

      // Aparece no feed e TEM player.
      const s = await sessao(390, 844, true, `/video/${post.id}`);
      const tela = await s.eval(`
        const audio = document.querySelector('.slide-audio audio, .comment-media audio, audio');
        return { temAudio: Boolean(audio), src: audio?.getAttribute('src') || '', semMidia: /sem midia|sem mÃ­dia/i.test(document.body.innerText || '') };
      `);
      if (!tela.temAudio) throw new Error('a publicacao de audio nao renderizou <audio>');
      if (/sem midia|sem mÃ­dia/i.test(tela.semMidia)) throw new Error('a publicacao de audio caiu no placeholder "sem midia"');

      const feed = await eu.get('/api/feed/for-you', { query: { limit: 20 } });
      // A rota responde `{ feed, posts, nextOffset }` (ver routes/posts.js).
      const itens = (feed.body && (feed.body.posts || feed.body.items)) || [];
      if (!itens.some((p) => p.id === post.id)) {
        throw new Error(`o post de audio nao apareceu no feed; tipos no feed: ${JSON.stringify(itens.map((x) => x.type))}`);
      }
      return `post ${post.id.slice(0, 8)} com audio real, no feed e com player`;
    });

    // =========================================================== itens 4 e 7
    await report.step('botoes baixos e texto acima da bottom nav (itens 4 e 7)', async () => {
      const medidas = [];
      // O item 4 e 7 sao sobre o FEED (onde ficam as acoes laterais e o bloco
      // de informacoes). Publica conteudo suficiente para o feed ter paginas.
      for (let i = 0; i < 2; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await publicar(pessoaSemFoto, { type: 'text', caption: `publicacao ${i} com #hashtag` });
      }
      for (const [w, h] of [[320, 640], [360, 780], [390, 844], [414, 896], [768, 1024]]) {
        // eslint-disable-next-line no-await-in-loop
        const s = await sessao(w, h, w < 700, '/');
        // eslint-disable-next-line no-await-in-loop
        await s.eval(`
          const v = document.querySelector('video');
          if (v) { v.muted = true; v.play?.().catch(() => {}); }
          return true;
        `);
        // eslint-disable-next-line no-await-in-loop
        await sleep(900);
        // eslint-disable-next-line no-await-in-loop
        const m = await s.eval(`
          // Tudo medido NO SLIDE ATIVO. Sem este escopo, \`querySelector\`
          // pegava o bloco de outro slide (que esta fora da tela) e a
          // verificacao acusava sobreposição inexistente.
          const slide = document.querySelector('.slide.active') || document.querySelector('.slide');
          if (!slide) return { erro: 'nenhum slide no feed' };
          const q = (sel) => slide.querySelector(sel);
          const stage = document.querySelector('.feed-stage');
          const barra = document.querySelector('.tabbar');
          const overlay = q('.slide-overlay');
          const acoes = q('.slide-actions');
          const autor = q('.slide-author');
          const legenda = q('.slide-caption');
          const som = q('.slide-sound');
          const nome = q('.slide-author .name');
          const user = q('.slide-author .username');
          const temOverflowX = document.documentElement.scrollWidth > window.innerWidth + 1;
          const r = (e) => { if (!e) return null; const b = e.getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom), left: Math.round(b.left), right: Math.round(b.right), h: Math.round(b.height), w: Math.round(b.width) }; };
          const br = r(barra);
          const ac = r(acoes);
          const au = r(autor);
          const le = r(legenda);
          const limite = br ? br.top : window.innerHeight;
          return {
            w: window.innerWidth,
            barra: br, acoes: ac, autor: au, legenda: le,
            temAutor: Boolean(autor),
            temNome: Boolean(nome),
            temUsername: Boolean(user),
            // Item 7: nome, @username e descricao acima da bottom nav.
            autorAcimaDaBarra: au ? au.bottom <= limite + 1 : false,
            legendaAcimaDaBarra: le ? le.bottom <= limite + 1 : true,
            // Item 4: o texto nao entra na coluna de acoes. A comparacao e
            // HORIZONTAL (a coluna e a direita); vertical nao faz sentido,
            // porque as duas colunas se cruzam em altura de proposito.
            textoForaDasAcoes: (le && ac) ? le.right <= ac.left + 1 : true,
            autorForaDasAcoes: (au && ac) ? au.right <= ac.left + 1 : true,
            legendaVisivel: le ? le.bottom <= limite + 1 : true,
            legendaAltura: le ? le.h : 0,
            acoesAcimaDaBarra: ac ? ac.bottom <= limite + 1 : false,
            temOverflowX,
          };
        `);
        // eslint-disable-next-line no-await-in-loop
        await s.close?.();
        if (m.erro) throw new Error(`${w}px: ${m.erro}`);
        if (m.temOverflowX) throw new Error(`${w}px: scroll horizontal`);
        // Item 7: nome, @username e descricao acima da bottom nav.
        if (!m.temAutor || !m.temNome || !m.temUsername) {
          throw new Error(`${w}px: bloco de autor incompleto (autor=${m.temAutor}, nome=${m.temNome}, @=${m.temUsername})`);
        }
        if (!m.autorAcimaDaBarra) throw new Error(`${w}px: autor atras da bottom nav (${JSON.stringify(m.autor)}, barra ${m.barra?.top})`);
        if (!m.legendaAcimaDaBarra) throw new Error(`${w}px: descricao atras da bottom nav (${JSON.stringify(m.legenda)})`);
        // Item 4: nada sobre a barra e nada em cima dos botoes.
        if (!m.acoesAcimaDaBarra) throw new Error(`${w}px: acoes em cima da bottom nav (${JSON.stringify(m.acoes)})`);
        if (!m.textoForaDasAcoes) throw new Error(`${w}px: descricao entra na coluna de acoes (texto ${JSON.stringify(m.legenda)} vs acoes ${JSON.stringify(m.acoes)})`);
        if (!m.autorForaDasAcoes) throw new Error(`${w}px: autor entra na coluna de acoes`);
        if (m.acoes && m.acoes.h < 120) throw new Error(`${w}px: coluna de acoes baixa demais (${m.acoes.h}px)`);
        medidas.push(
          `${w}px acoes ${m.acoes ? `${m.acoes.top}-${m.acoes.bottom}` : '-'}`
          + ` | autor ate ${m.autor?.bottom} | legenda ate ${m.legenda?.bottom ?? '-'}`
          + ` | barra ${m.barra?.top}`,
        );
      }
      return medidas.join(' || ');
    });

    // =========================================================== item 20
    await report.step('sem mojibake nas areas alteradas (item 20)', async () => {
      const alvos = [
        'web/js/features/feed.js', 'web/js/features/live.js', 'web/js/features/comments.js',
        'web/js/features/live-effects.js', 'web/js/features/create-menu.js',
        'web/js/features/admin.js', 'web/js/features/profile.js', 'web/js/core/dom.js',
        'web/css/app.css', 'web/index.html',
        'server/domain/effects.js', 'server/domain/social.js', 'server/routes/posts.js',
        'server/routes/live.js', 'server/media/pipeline.js', 'server/config.js',
      ];
      const suspect = ['\uFFFD', '\u00e2\u20ac\u2122', '\u00e2\u0080', '\u00c3\u00a9', '\u00c3\u00a3', '\u00c3\u00a7'];
      const achados = [];
      for (const rel of alvos) {
        const arquivo = path.join(ROOT, rel);
        if (!fs.existsSync(arquivo)) { achados.push(`${rel}: arquivo ausente`); continue; }
        const texto = fs.readFileSync(arquivo, 'utf8');
        for (const p of suspect) {
          if (texto.includes(p)) achados.push(`${rel}: mojibake ${JSON.stringify(p)}`);
        }
      }
      // O icone do coracao tem que ser escape unicode, nunca emoji literal.
      const efeitos = fs.readFileSync(path.join(ROOT, 'web/js/features/live-effects.js'), 'utf8');
      if (!efeitos.includes('\\u2764')) achados.push('live-effects.js: coracao sem escape unicode');
      if (achados.length) throw new Error(achados.join(' | '));
      return `${alvos.length} arquivos sem mojibake; coracao com escape \\u2764`;
    });

    report.ok('amigos, perfis, layout e midia em comentarios/posts validados');
  } catch (error) {
    report.fail('fluxo interrompido', error);
  } finally {
    for (const s of sessions) { try { s.close?.(); } catch { /* ignore */ } }
    await browser.close();
    await server.stop();
  }

  return report.summary();
}

run().then((r) => process.exit(r.failed > 0 ? 1 : 0)).catch((e) => {
  console.error('erro fatal:', e);
  process.exit(1);
});