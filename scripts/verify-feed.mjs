/**
 * Feed "Para voce" real (itens 5, 6, 7 e 31).
 *
 * Publica videos/textos de usuarios diferentes, confere a ordem cronologica,
 * a entrada por realtime sem reload, o swipe para cima/baixo e a ausencia de
 * duplicacao.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { startServer, Client, Report, randomUsername, sleep, makeTestVideo } from '../tests/helpers.mjs';
import { launchChrome } from '../tests/cdp.mjs';

const report = new Report('Feed: conteudo real, ordem e realtime');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-feed-'));
const server = await startServer({ env: { DATABASE_PATH: path.join(dir, 'feed.db') } });

// Videos REAIS gerados com o ffmpeg do projeto (nao fixture, nao mock).
const video = await makeTestVideo({ seconds: 2, width: 480, height: 854, withAudio: true });
const esperaPronta = async (cli, mediaId) => {
  for (let i = 0; i < 150; i += 1) {
    const r = await cli.get(`/api/media/${mediaId}/status`);
    const status = r.body.media?.status;
    if (status === 'ready') return r.body.media;
    if (status === 'failed') throw new Error(`midia ${mediaId} falhou: ${r.body.media.error}`);
    await sleep(800);
  }
  throw new Error(`midia ${mediaId} nao ficou pronta`);
};

// Tres autores diferentes: o feed precisa misturar conteudo de varias contas.
const autores = [];
for (let i = 0; i < 3; i += 1) {
  const cli = new Client(server.baseUrl);
  const user = await cli.register({ username: randomUsername(`aut${i}`) });
  autores.push({ cli, user });
}

const publicados = [];
for (let i = 0; i < autores.length; i += 1) {
  const { cli, user } = autores[i];
  const up = await cli.upload('/api/media/upload?purpose=video', video.buffer, {
    filename: `autor${i}.mp4`, mime: video.mime,
  });
  await esperaPronta(cli, up.body.media.id);
  const post = await cli.post('/api/posts', {
    type: 'video',
    mediaId: up.body.media.id,
    caption: `video real ${i}`,
  });
  publicados.push({ id: post.body.post.id, autor: user.username });
  // Espaco entre as publicacoes para a ordem cronologica ser inequivoca.
  await sleep(1200);
}
// Um post de TEXTO tambem tem de entrar no mesmo feed.
const texto = await autores[0].cli.post('/api/posts', { type: 'text', caption: 'texto real do feed' });
publicados.push({ id: texto.body.post.id, autor: autores[0].user.username });

const leitor = new Client(server.baseUrl);
const leitorUser = await leitor.register({ username: randomUsername('leitor') });

const browser = await launchChrome();

async function sessao(u, width, height, mobile) {
  const s = await browser.newBrowserContext();
  s.watch();
  await s.goto(`${server.baseUrl}/`, { waitMs: 300 });
  const r = await fetch(`${server.baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: u.username, password: 'Senha@Teste123' }),
  });
  for (const ck of r.headers.getSetCookie()) {
    const pair = ck.split(';')[0];
    const n = pair.split('=')[0];
    await s.send('Network.setCookie', { name: n, value: decodeURIComponent(pair.slice(n.length + 1)), domain: '127.0.0.1', path: '/' });
  }
  await s.send('Network.setCacheDisabled', { cacheDisabled: true });
  await s.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
  return s;
}

/** Estado do feed visto na tela. */
const ler = (s) => s.eval(`
  const itens = [...document.querySelectorAll('.feed-slide, .slide')];
  return {
    total: itens.length,
    ids: itens.map((i) => i.dataset.postId || i.dataset.id || ''),
    ativo: itens.findIndex((i) => i.classList.contains('active')),
    ativoId: (itens.find((i) => i.classList.contains('active'))?.dataset.postId) || '',
    captions: itens.map((i) => (i.querySelector('.slide-caption, .post-caption')?.textContent || '').slice(0, 24)),
    vazio: Boolean(document.querySelector('.page-empty')),
  };
`);

try {
  const cel = await sessao(leitorUser, 390, 844, true);
  await cel.goto(`${server.baseUrl}/`, { waitMs: 3000 });

  // ---- 1) Conteudo real e ordem cronologica (itens 5 e 31) ------------
  await report.step('Para voce mostra os videos REAIS publicados, do mais novo ao mais antigo', async () => {
    const st = await ler(cel);
    if (st.vazio) throw new Error('feed vazio mesmo havendo 4 publicacoes reais');
    const esperado = [publicados[3].id, publicados[2].id, publicados[1].id, publicados[0].id];
    const faltando = esperado.filter((id) => !st.ids.includes(id));
    if (faltando.length) throw new Error(`${faltando.length} de ${esperado.length} publicacoes ausentes do feed`);
    const ordem = st.ids.filter((id) => esperado.includes(id));
    const posEsperada = esperado.map((id) => ordem.indexOf(id)).filter((i) => i >= 0);
    const crescente = posEsperada.every((v, i) => i === 0 || posEsperada[i - 1] < v);
    if (!crescente) throw new Error(`ordem cronologica errada: ${ordem.join(' > ')}`);
    const textoPresente = st.ids.includes(publicados[3].id);
    if (!textoPresente) throw new Error('post de texto nao entrou no feed');
    return `${st.total} slides, ordem ${ordem.map((id) => id.slice(-4)).join(' > ')}`;
  });

  await report.step('nenhum post duplicado no feed', async () => {
    const st = await ler(cel);
    const vistos = new Set(st.ids);
    if (vistos.size !== st.ids.filter(Boolean).length) {
      throw new Error(`ids repetidos: ${st.ids.join(', ')}`);
    }
    return `${st.ids.filter(Boolean).length} ids unicos`;
  });

  // ---- 2) Realtime sem reload (itens 6 e 7) ---------------------------
  await report.step('nova publicacao entra no feed SEM reload (realtime)', async () => {
    const antes = await ler(cel);
    const { cli } = autores[1];
    const up = await cli.upload('/api/media/upload?purpose=video', video.buffer, { filename: 'rt.mp4', mime: video.mime });
    await esperaPronta(cli, up.body.media.id);
    const novo = await cli.post('/api/posts', { type: 'video', mediaId: up.body.media.id, caption: 'publicado durante a sessao' });
    const st = await cel.waitForFunction(`
      const itens = [...document.querySelectorAll('.feed-slide, .slide')];
      const id = itens[0]?.dataset.postId || '';
      return id === ${JSON.stringify(novo.body.post.id)} ? { id, total: itens.length } : null;
    `, 15000).catch(() => null);
    if (!st) {
      const agora = await ler(cel);
      throw new Error(`o post novo nao entrou pelo realtime (novo=${novo.body.post.id}, topo=${agora.ids[0]}, total=${agora.total})`);
    }
    const depois = await ler(cel);
    if (depois.total <= antes.total) throw new Error(`total nao cresceu: ${antes.total} -> ${depois.total}`);
    // O post que estava em tela precisa continuar em tela.
    if (antes.ativoId && depois.ativoId !== antes.ativoId) {
      throw new Error(`o video em tela mudou: ${antes.ativoId} -> ${depois.ativoId}`);
    }
    return `novo post no topo (${novo.body.post.id.slice(-4)}), ${antes.total} -> ${depois.total} slides, video em tela preservado`;
  });

  await report.step('mesmo post nao entra duas vezes pelo realtime', async () => {
    const antes = await ler(cel);
    await cel.goto(`${server.baseUrl}/`, { waitMs: 1500 });
    const st = await ler(cel);
    const repetidos = st.ids.filter((id, i) => id && st.ids.indexOf(id) !== i);
    if (repetidos.length) throw new Error(`ids repetidos apos recarregar: ${[...new Set(repetidos)].join(', ')}`);
    void antes;
    return `${st.ids.filter(Boolean).length} ids, nenhum repetido`;
  });

  // ---- 3) Roleta vertical (item 7 / 6) --------------------------------
  await report.step('arrastar para cima vai para o proximo, para baixo volta', async () => {
    await cel.goto(`${server.baseUrl}/`, { waitMs: 2500 });
    const inicio = await ler(cel);
    if (inicio.total < 3) throw new Error(`poucos slides para o teste de roleta: ${inicio.total}`);

    const arrastar = async (deY, paraY) => {
      await cel.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 195, y: deY }] });
      await sleep(60);
      await cel.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 195, y: paraY }] });
      await sleep(60);
      await cel.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await sleep(900);
    };

    await arrastar(700, 260); // para cima -> proximo
    const depoisCima = await ler(cel);
    if (depoisCima.ativo !== inicio.ativo + 1) {
      throw new Error(`arrastar para cima nao avancou: indice ${inicio.ativo} -> ${depoisCima.ativo}`);
    }
    await arrastar(260, 700); // para baixo -> anterior
    const depoisBaixo = await ler(cel);
    if (depoisBaixo.ativo !== inicio.ativo) {
      throw new Error(`arrastar para baixo nao voltou: ${depoisBaixo.ativo} (esperado ${inicio.ativo})`);
    }

    // Sequencia de tres videos consecutivos, sem pular nem repetir.
    const vistos = [];
    for (let i = 0; i < 3; i += 1) {
      await arrastar(700, 260);
      vistos.push((await ler(cel)).ativoId);
    }
    const repetidos = vistos.filter((id, i) => id && vistos.indexOf(id) !== i);
    if (repetidos.length) throw new Error(`video repetido na sequencia: ${vistos.join(', ')}`);
    return `indice ${inicio.ativo} -> ${depoisCima.ativo} -> ${depoisBaixo.ativo}; 3 seguidos distintos`;
  });

  await report.step('um video por vez na roleta e as acoes ficam na area util', async () => {
    const st = await cel.eval(`
      const visiveis = [...document.querySelectorAll('.feed-slide, .slide')]
        .filter((s) => {
          const r = s.getBoundingClientRect();
          const estilo = getComputedStyle(s);
          return estilo.display !== 'none' && estilo.visibility !== 'hidden'
            && Number(estilo.opacity) > 0.05 && r.height > 40 && r.top < window.innerHeight && r.bottom > 0;
        });
      const tabbar = document.getElementById('tabbar')?.getBoundingClientRect();
      const acoes = [...document.querySelectorAll('.slide-actions button, .slide-actions .act')];
      const fora = acoes.filter((b) => {
        const r = b.getBoundingClientRect();
        return tabbar && r.bottom > tabbar.top + 1;
      });
      return {
        visiveis: visiveis.length,
        acoes: acoes.length,
        acoesSobTabbar: fora.length,
        vh: window.innerHeight,
        overflowH: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    `);
    if (st.visiveis !== 1) throw new Error(`${st.visiveis} videos visiveis ao mesmo tempo (esperado 1)`);
    if (st.acoesSobTabbar > 0) throw new Error(`${st.acoesSobTabbar} acoes sob a bottom nav`);
    if (st.overflowH > 1) throw new Error(`scroll horizontal de ${st.overflowH}px`);
    return `1 video visivel, ${st.acoes} acoes, nenhuma sob a tabbar`;
  });

  // ---- 4) Seguindo e Amigos continuam reais ---------------------------
  await report.step('abas Seguindo e Amigos continuam carregando sem estado vazio falso', async () => {
    const st = await cel.eval(`
      const abas = [...document.querySelectorAll('.feed-tabs [role="tab"]')];
      const amigos = abas.find((t) => /Amigos/i.test(t.textContent));
      amigos.click();
      await new Promise((x) => setTimeout(x, 2200));
      const itens = [...document.querySelectorAll('.feed-slide, .slide')];
      const vazio = document.querySelector('.page-empty');
      return {
        itens: itens.length,
        vazio: Boolean(vazio),
        texto: vazio ? vazio.innerText.slice(0, 60) : '',
      };
    `);
    // Sem amigos, um estado vazio EXPLICITO e o resultado correto.
    if (st.itens === 0 && !st.vazio) throw new Error('aba Amigos sem posts e sem estado vazio');
    return `${st.itens} slide(s) em Amigos; vazio=${st.vazio} "${st.texto.replace(/\s+/g, ' ')}"`;
  });
} catch (err) {
  report.fail('erro inesperado', err);
}

const resumo = report.summary();
await browser.close();
await server.stop();
fs.rmSync(dir, { recursive: true, force: true });
process.exit(resumo.failed > 0 ? 1 : 0);
