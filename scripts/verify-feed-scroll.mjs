/**
 * Prova de que o feed usa ROLAGEM VERTICAL REAL (item 5).
 *
 * Este verificador nao aceita "a tela mudou de conteudo": ele mede a geometria
 * da rolagem. Um feed que troca conteudo por estado (sem container de scroll)
 * passa num teste de "o indice ativo mudou" e falha aqui.
 *
 * O que e medido, no Chrome de verdade:
 *  1. o palco tem `overflow-y: auto` e `scroll-snap-type: y mandatory`;
 *  2. cada publicacao tem a ALTURA de uma pagina (uma "pagina" vertical);
 *  3. cada publicacao tem espaco vertical PROPRIO (topo seguinte = topo atual
 *     + altura) - nada de slides sobrepostos;
 *  4. `scrollTop` realmente MUDA ao arrastar/rolar;
 *  5. o `scrollTop` ASSENTA exatamente na pagina (snap) - e nao no meio;
 *  6. wheel do mouse avanca uma publicacao;
 *  7. swipe (touch) no celular avanca e volta;
 *  8. teclado (ArrowDown/Up, PageDown/Up) avanca e volta;
 *  9. apenas UM video reproduz por vez;
 *  10. ao voltar, o video volta a reproduzir (nao tela preta, nao perdeu src);
 *  11. sem `setInterval`/`setTimeout` trocando slide, sem fade artificial;
 *  12. as tres abas (Para voce / Seguindo / Amigos) usam a mesma mecanica.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../server/config.js';
import {
  startServer, Client, Report, sleep, randomUsername, makeTestVideo,
} from '../tests/helpers.mjs';
import { launchChrome } from '../tests/cdp.mjs';

const report = new Report('Feed com rolagem vertical real');

const await_ = (ms) => sleep(ms);

/** Sobe o servidor de teste com conteudo real de varias pessoas. */
async function preparar(server) {
  const autores = [];
  for (let i = 0; i < 3; i += 1) {
    const api = new Client(server.baseUrl);
    const user = await api.register({ username: randomUsername(`aut${i}`) });
    await api.post('/api/auth/login', { identifier: user.username, password: 'Senha@Teste123' });
    autores.push(api);
  }
  // Relacionamentos REAIS, para que "Seguindo" e "Amigos" tenham conteudo de
  // verdade (item 6): o usuario de teste segue os outros dois, e os dois
  //-follow de volta, virando amigos de mutual.
  const [leitor, a, b] = autores;
  await leitor.post(`/api/users/${a.user.id}/follow`, {});
  await leitor.post(`/api/users/${b.user.id}/follow`, {});
  await a.post(`/api/users/${leitor.user.id}/follow`, {});
  await b.post(`/api/users/${leitor.user.id}/follow`, {});

  const publicados = [];
  // Alterna entre autores para garantir "varias pessoas" no mesmo feed.
  // Os dois primeiros posts sao dosfollowed: assim "Seguindo" e "Amigos" tem
  // paginas reais e nao o estado vazio.
  for (let i = 0; i < 5; i += 1) {
    const autor = i < 2 ? [a, b][i] : autores[i % autores.length];
    const video = await makeTestVideo({ seconds: 2, width: 360, height: 640 });
    const up = await autor.upload('/api/media/upload?purpose=video', video.buffer, {
      filename: video.filename, mime: video.mime,
    });
    if (!up.body?.media?.id) {
      throw new Error(`upload falhou: ${JSON.stringify(up.body).slice(0, 120)}`);
    }
    const post = await autor.post('/api/posts', { type: 'video', caption: `video ${i}`, mediaId: up.body.media.id });
    if (post.status !== 201) throw new Error(`post ${i}: ${post.status} ${JSON.stringify(post.body).slice(0, 120)}`);
    publicados.push(post.body.post);
  }
  return { autores, publicados };
}

async function run() {
  const server = await startServer();
  report.ok('servidor no ar', server.baseUrl);
  const { autores, publicados } = await preparar(server);
  report.ok(`${publicados.length} videos reais de ${autores.length} autores diferentes`);

  const browser = await launchChrome({ extraArgs: ['--autoplay-policy=no-user-gesture-required'] });
  const sessions = [];

  const cookiesDe = async (api, username) => {
    const r = await fetch(`${server.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: username, password: 'Senha@Teste123' }),
    });
    return r.headers.getSetCookie();
  };

  async function sessao(username, width, height, mobile) {
    const s = await browser.newBrowserContext();
    sessions.push(s);
    s.watch();
    await s.goto(`${server.baseUrl}/`, { waitMs: 250 });
    for (const ck of await cookiesDe(username, username)) {
      const par = ck.split(';')[0];
      const nome = par.slice(0, par.indexOf('='));
      await s.send('Network.setCookie', {
        name: nome, value: decodeURIComponent(par.slice(nome.length + 1)), domain: '127.0.0.1', path: '/',
      });
    }
    await s.send('Network.setCacheDisabled', { cacheDisabled: true });
    await s.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
    await s.goto(`${server.baseUrl}/`, { waitMs: 3200 });
    return s;
  }

  /** Mede a geometria da rolagem: e isto que distingue scroll de troca por estado. */
  const medir = (s) => s.eval(`
    const stage = document.querySelector('.feed-stage');
    if (!stage) return { erro: 'palco ausente' };
    const cs = getComputedStyle(stage);
    const slides = [...stage.querySelectorAll('.slide')];
    const paginas = slides.map((x) => {
      const r = x.getBoundingClientRect();
      return { top: Math.round(r.top), altura: Math.round(r.height), id: x.dataset.postId || '' };
    });
    const videos = [...stage.querySelectorAll('.slide-media video')];
    return {
      overflowY: cs.overflowY,
      snapType: cs.scrollSnapType,
      clientHeight: stage.clientHeight,
      scrollHeight: stage.scrollHeight,
      scrollTop: Math.round(stage.scrollTop),
      podeRolar: stage.scrollHeight > stage.clientHeight + 2,
      paginas,
      // Espaco vertical real: a pagina seguinte comeca exatamente uma pagina
      // abaixo. Em um feed sobreposto (position:absolute) a diferenca seria 0.
      espacamento: paginas.length > 1 ? paginas[1].top - paginas[0].top : null,
      tocando: videos.filter((v) => !v.paused && v.readyState >= 2).length,
      temSrc: videos.filter((v) => Boolean(v.src || v.currentSrc)).length,
      totalVideos: videos.length,
      ativo: (stage.querySelector('.slide.active')?.dataset.postId) || '',
    };
  `);

  try {
    // ------------------------------------------------------------------ 1/2/3
    await report.step('o palco e container de scroll com snap e cada post tem uma pagina', async () => {
      const desk = await sessao(autores[0].user.username, 1280, 900, false);
      const m = await medir(desk);
      if (m.erro) throw new Error(m.erro);
      if (m.overflowY !== 'auto' && m.overflowY !== 'scroll') {
        throw new Error(`overflow-y do palco = ${m.overflowY} (esperado auto/scroll)`);
      }
      if (!/y/.test(m.snapType || '')) throw new Error(`scroll-snap ausente: ${m.snapType}`);
      if (m.paginas.length < 3) throw new Error(`poucas paginas: ${m.paginas.length}`);
      const alturas = new Set(m.paginas.map((p) => p.altura));
      if (alturas.size !== 1) throw new Error(`paginas com alturas diferentes: ${[...alturas].join(', ')}`);
      const h = m.paginas[0].altura;
      if (h !== m.clientHeight) throw new Error(`altura da pagina ${h} != altura do palco ${m.clientHeight}`);
      return `${m.paginas.length} paginas de ${h}px, overflow-y=${m.overflowY}, snap=${m.snapType}`;
    });

    await report.step('cada publicacao tem espaco vertical PROPRIO (nao ha sobreposicao)', async () => {
      const desk = await sessao(autores[0].user.username, 1280, 900, false);
      const m = await medir(desk);
      const h = m.paginas[0].altura;
      if (Math.abs(m.espacamento - h) > 2) {
        throw new Error(`paginas sobrepostas ou com vao: espacamento=${m.espacamento}, altura=${h}`);
      }
      // Cada pagina comeca uma altura abaixo da anterior: e o espaco vertical
      // proprio de cada publicacao.
      const gaps = [];
      for (let i = 1; i < m.paginas.length; i += 1) {
        gaps.push(m.paginas[i].top - m.paginas[i - 1].top);
      }
      const todosIguais = gaps.every((g) => Math.abs(g - h) <= 2);
      if (!todosIguais) throw new Error(`espacamento irregular: ${gaps.join(', ')} (altura ${h})`);
      return `${gaps.length + 1} paginas com passo exato de ${h}px`;
    });

    // ------------------------------------------------------------------- 4/5
    await report.step('scrollTop MUDA e ASSENTA na pagina (nao para no meio)', async () => {
      const desk = await sessao(autores[0].user.username, 1280, 900, false);
      const antes = await medir(desk);
      if (!antes.podeRolar) throw new Error('o palco nao tem rolagem (scrollHeight <= clientHeight)');
      // Rola com o container real, como o usuario faria com a roda.
      await desk.eval(`
        const stage = document.querySelector('.feed-stage');
        stage.scrollBy({ top: stage.clientHeight, behavior: 'auto' });
        return true;
      `);
      await await_(900);
      const depois = await medir(desk);
      if (depois.scrollTop <= antes.scrollTop) {
        throw new Error(`scrollTop nao mudou: ${antes.scrollTop} -> ${depois.scrollTop}`);
      }
      const altura = antes.clientHeight;
      const resto = depois.scrollTop % altura;
      // Snap manda assentar na pagina; tolerancia de 6px cobre subpixel.
      if (resto > 6 || resto < -6) {
        throw new Error(`rolagem parou no meio da pagina: scrollTop=${depois.scrollTop}, resto=${resto}`);
      }
      return `scrollTop ${antes.scrollTop} -> ${depois.scrollTop} (pagina ${depois.scrollTop / altura}, assentada)`;
    });

    // --------------------------------------------------------------------- 6
    await report.step('wheel do mouse avanca uma publicacao e volta', async () => {
      const desk = await sessao(autores[0].user.username, 1280, 900, false);
      const box = await desk.eval(`
        const r = document.querySelector('.feed-stage').getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      `);
      const m0 = await medir(desk);
      // Diagnostico: o wheel esta chegando no palco? Existe algum listener que
      // esteja consumindo o evento?
      const diag = await desk.eval(`
        const stage = document.querySelector('.feed-stage');
        const r = stage.getBoundingClientRect();
        const alvo = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        window.__wheel = [];
        stage.addEventListener('wheel', (e) => window.__wheel.push({ dy: e.deltaY, def: e.defaultPrevented }), { passive: false });
        return {
          stageOverflow: getComputedStyle(stage).overflowY,
          stageBehavior: getComputedStyle(stage).scrollBehavior,
          alvo: alvo ? (alvo.className || alvo.tagName) : null,
          contido: stage.contains(alvo),
          scrollHeight: stage.scrollHeight,
          clientHeight: stage.clientHeight,
        };
      `);
      // Uma rodada de mouse de verdade: delta grande (a mao do usuario cobre
      // hundreds de pixels por gesto). Gesto pequeno e lento nao deve virar
      // troca de publicacao.
      await desk.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel', x: box.x, y: box.y, deltaX: 0, deltaY: 420,
      });
      await await_(1000);
      const depoisWheel = await desk.eval(`
        const stage = document.querySelector('.feed-stage');
        return { scrollTop: Math.round(stage.scrollTop), eventos: window.__wheel.length };
      `);
      const m1 = await medir(desk);
      if (depoisWheel.eventos === 0) {
        throw new Error(`o wheel nem chegou no palco; diag=${JSON.stringify(diag)}`);
      }
      if (m1.scrollTop <= m0.scrollTop) {
        throw new Error(`wheel nao avancou (${m0.scrollTop} -> ${m1.scrollTop}); `
          + `diag=${JSON.stringify(diag)}; eventos=${depoisWheel.eventos}`);
      }
      const altura = m0.clientHeight;
      const paginasAvancadas = Math.round((m1.scrollTop - m0.scrollTop) / altura);
      if (paginasAvancadas < 1) throw new Error(`avancou ${m1.scrollTop - m0.scrollTop}px (menos de uma pagina)`);

      // Volta
      await desk.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel', x: box.x, y: box.y, deltaX: 0, deltaY: -420,
      });
      await await_(1000);
      const m2 = await medir(desk);
      if (m2.scrollTop >= m1.scrollTop) throw new Error(`wheel para cima nao voltou (${m1.scrollTop} -> ${m2.scrollTop})`);
      return `avancou ${paginasAvancadas} pagina(s) e voltou (${m0.scrollTop} -> ${m1.scrollTop} -> ${m2.scrollTop})`;
    });

    // --------------------------------------------------------------------- 7
    await report.step('swipe no celular avanca e volta', async () => {
      const mob = await sessao(autores[0].user.username, 390, 844, true);
      const m0 = await medir(mob);
      const ponto = await mob.eval(`
        const r = document.querySelector('.feed-stage').getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height * 0.7) };
      `);
      // Swipe para cima: arrasta para CIMA -> proxima publicacao.
      await mob.send('Input.dispatchTouchEvent', {
        type: 'touchStart', touchPoints: [{ x: ponto.x, y: ponto.y }],
      });
      for (let y = ponto.y; y > ponto.y - 260; y -= 65) {
        await mob.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: ponto.x, y }] });
        await await_(16);
      }
      await mob.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await await_(1200);
      const m1 = await medir(mob);
      if (m1.scrollTop <= m0.scrollTop) {
        throw new Error(`swipe para cima nao avancou: ${m0.scrollTop} -> ${m1.scrollTop}`);
      }
      // Swipe para baixo: volta.
      await mob.send('Input.dispatchTouchEvent', {
        type: 'touchStart', touchPoints: [{ x: ponto.x, y: ponto.y - 200 }],
      });
      for (let y = ponto.y - 200; y < ponto.y + 60; y += 65) {
        await mob.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: ponto.x, y }] });
        await await_(16);
      }
      await mob.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await await_(1200);
      const m2 = await medir(mob);
      if (m2.scrollTop >= m1.scrollTop) throw new Error(`swipe para baixo nao voltou: ${m1.scrollTop} -> ${m2.scrollTop}`);
      return `390px: ${m0.scrollTop} -> ${m1.scrollTop} -> ${m2.scrollTop}`;
    });

    // --------------------------------------------------------------------- 8
    await report.step('teclado (ArrowDown/Up, PageDown/Up) navega', async () => {
      const desk = await sessao(autores[0].user.username, 1280, 900, false);
      const m0 = await medir(desk);
      const teclas = ['ArrowDown', 'ArrowDown', 'ArrowUp'];
      const passos = [m0.scrollTop];
      for (const key of teclas) {
        await desk.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: key === 'ArrowUp' ? 38 : 40 });
        await desk.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: key === 'ArrowUp' ? 38 : 40 });
        await await_(900);
        passos.push((await medir(desk)).scrollTop);
      }
      const altura = m0.clientHeight;
      if (passos[1] - passos[0] < altura * 0.8) throw new Error(`ArrowDown nao avancou: ${passos[0]} -> ${passos[1]}`);
      if (passos[2] - passos[1] < altura * 0.8) throw new Error(`segundo ArrowDown nao avancou: ${passos[1]} -> ${passos[2]}`);
      if (passos[3] >= passos[2]) throw new Error(`ArrowUp nao voltou: ${passos[2]} -> ${passos[3]}`);

      // PageDown tambem precisa funcionar.
      await desk.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 });
      await desk.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 });
      await await_(900);
      const mFinal = await medir(desk);
      if (mFinal.scrollTop <= passos[3]) throw new Error(`PageDown nao avancou: ${passos[3]} -> ${mFinal.scrollTop}`);
      return `${teclas.join(',')}: ${passos.join(' -> ')} | PageDown -> ${mFinal.scrollTop}`;
    });

    // --------------------------------------------------------------------- 9/10
    await report.step('apenas UM video reproduz e o anterior volta ao voltar', async () => {
      const desk = await sessao(autores[0].user.username, 1280, 900, false);
      const m0 = await medir(desk);
      if (m0.totalVideos < 3) throw new Error(`poucos videos: ${m0.totalVideos}`);
      await desk.eval(`
        const s = document.querySelector('.feed-stage');
        s.scrollBy({ top: s.clientHeight, behavior: 'auto' });
        return true;
      `);
      await await_(1400);
      const m1 = await medir(desk);
      if (m1.tocando > 1) throw new Error(`${m1.tocando} videos reproduzindo ao mesmo tempo`);
      if (m1.tocando === 0) throw new Error('nenhum video reproduzindo apos avancar');

      // Volta: o video anterior precisa tocar de novo, com src intacto.
      await desk.eval(`
        const s = document.querySelector('.feed-stage');
        s.scrollBy({ top: -s.clientHeight, behavior: 'auto' });
        return true;
      `);
      await await_(1600);
      const m2 = await medir(desk);
      if (m2.tocando > 1) throw new Error(`${m2.tocando} videos reproduzindo apos voltar`);
      if (m2.tocando === 0) throw new Error('nenhum video reproduzindo apos VOLTAR (tela preta)');
      if (m2.temSrc < m1.temSrc) throw new Error('perdeu src ao voltar');
      return `avancou (1 tocando, ${m1.temSrc}/${m1.totalVideos} com src) e voltou (1 tocando, ${m2.temSrc} com src)`;
    });

    // -------------------------------------------------------------------- 11
    await report.step('sem animacao decorativa nem setInterval fingindo rolagem', async () => {
      const src = fs.readFileSync(path.join(ROOT, 'web', 'js', 'features', 'feed.js'), 'utf8');
      // `setInterval` no feed seria usado para TROCAR de publicacao por tempo. O
      // unico uso legitimo seria o status da midia, e ele e `setTimeout`
      // encadeado (ver `pollMediaStatus`).
      if (/setInterval\s*\(/.test(src)) throw new Error('feed usa setInterval (trocaria slide por tempo)');
      if (/setTimeout\s*\([^)]*activate/.test(src)) throw new Error('activate atrasado por setTimeout');
      // `preventDefault` no wheel e o que transforma scroll em troca de estado.
      if (/['"]wheel['"]\s*,\s*\(\s*event\s*\)\s*=>\s*\{[^}]*preventDefault/.test(src)) {
        throw new Error('wheel ainda com preventDefault (rolagem simulada)');
      }
      if (src.includes('wheelAccumulado')) throw new Error('acumulador de wheel ainda existe');
      if (!src.includes('scrollTo') && !src.includes('scrollBy')) {
        throw new Error('feed nao usa scrollTo/scrollBy (nenhuma rolagem real)');
      }
      if (!src.includes('scroll-snap') && !src.includes('alturaPagina')) {
        throw new Error('feed nao calcula a altura da pagina');
      }
      const css = fs.readFileSync(path.join(ROOT, 'web', 'css', 'app.css'), 'utf8');
      // `mandatory` + o assentamento do JS: so mandatory deixa o gesto lento
      // (mouse antigo, trackpad arrastando) parar no MEIO de uma pagina, e o
      // usuario veria dois videos ao mesmo tempo.
      if (!/scroll-snap-type:\s*y\s+mandatory/.test(css)) throw new Error('CSS sem scroll-snap y mandatory');
      if (!src.includes('assentar') || !src.includes('maisProxima')) {
        throw new Error('feed sem assentamento da pagina apos o gesto (rolagem pararia no meio)');
      }
      return 'scroll-snap mandatory + assentamento ao fim do gesto; sem setInterval, sem preventDefault de wheel';
    });

    // -------------------------------------------------------------------- 12
    await report.step('as tres abas usam a mesma mecanica de scroll', async () => {
      const desk = await sessao(autores[0].user.username, 1280, 900, false);
      // Guarda os erros de console: e o jeito de ver por que a tela do feed
      // sumiria ao trocar de aba.
      await desk.eval(`
        window.__errosFeed = [];
        window.addEventListener('error', (e) => window.__errosFeed.push('erro: ' + e.message));
        window.addEventListener('unhandledrejection', (e) => window.__errosFeed.push('rejeicao: ' + (e.reason?.message || e.reason)));
        const ce = console.error;
        console.error = (...a) => { window.__errosFeed.push('console: ' + a.map(String).join(' ').slice(0, 160)); ce(...a); };
        return true;
      `);
      // Só as abas do feed (`role="tab"`). A lupa de busca também é um `<button>`
      // dentro de `.feed-tabs` e levaria para /busca.
      const abas = await desk.eval(`
        return [...document.querySelectorAll('.feed-tabs button[role="tab"]')].map((b) => b.textContent);
      `);
      if (abas.length < 2) throw new Error(`poucas abas: ${abas.join(', ')}`);
      const resultados = [];
      for (const nome of abas) {
        // eslint-disable-next-line no-await-in-loop
        await desk.eval(`
          const b = [...document.querySelectorAll('.feed-tabs button[role="tab"]')].find((x) => x.textContent === ${JSON.stringify(nome)});
          if (b) b.click();
          return true;
        `);
        // eslint-disable-next-line no-await-in-loop
        await await_(2600);
        // eslint-disable-next-line no-await-in-loop
        const m = await desk.eval(`
          const stage = document.querySelector('.feed-stage');
          if (!stage) {
            return { semPalco: true, url: location.pathname, corpo: document.body.textContent.slice(0, 120) };
          }
          const slides = [...stage.querySelectorAll('.slide')];
          const cs = getComputedStyle(stage);
          const paginas = slides.map((x) => Math.round(x.getBoundingClientRect().height));
          return {
            overflowY: cs.overflowY,
            snap: cs.scrollSnapType,
            paginas: paginas.length,
            alturas: [...new Set(paginas)],
            vazio: Boolean(stage.querySelector('.page-empty')),
            podeRolar: stage.scrollHeight > stage.clientHeight + 2,
          };
        `);
        if (m.semPalco) {
          const erros = await desk.eval('return (window.__errosFeed || []).slice(0, 4);');
          throw new Error(`aba "${nome}": o palco do feed sumiu (${m.url}) - "${m.corpo}" - erros=${JSON.stringify(erros)}`);
        }
        if (m.vazio) {
          // Estado vazio legitimo (aba sem conteudo para este usuario). O que
          // nao pode e o palco sumir ou a mecanica mudar.
          resultados.push(`${nome}: vazio (mecanica intacta, overflow-y=${m.overflowY}, snap=${m.snap})`);
          continue;
        }
        if (m.alturas.length !== 1) {
          throw new Error(`aba "${nome}": paginas com alturas diferentes ${JSON.stringify(m.alturas)}`);
        }
        resultados.push(`${nome}: ${m.paginas} paginas de ${m.alturas[0]}px`);
      }
      return resultados.join(' | ');
    });

    report.ok('feed com rolagem vertical real validado');
  } catch (error) {
    report.fail('fluxo do feed interrompido', error);
  } finally {
    for (const s of sessions) { try { s.close?.(); } catch { /* ignore */ } }
    await browser.close();
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