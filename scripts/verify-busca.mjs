/**
 * Verificador dos itens 21 e 22 - busca.
 *
 * 21: ao pesquisar uma PESSOA, o resultado tem de ser
 *     [foto] Nome / @usuario, clicavel, e NAO a URL.
 * 22: ao pesquisar uma PALAVRA/EXPRESSAO, tem de aparecer publicacao real do
 *     banco (com legenda ou hashtag correspondente), e clicar abre o post.
 *
 * O teste digita no campo de verdade e le o DOM. Alem disso ele grava o
 * `outerHTML` da secao de pessoas: e assim que a regressao do item 21 (a URL
 * no lugar do nome) fica visivel, em vez de passar num cheque de "tem link".
 */
import {
  startServer, Client, Report, sleep, randomUsername, makeTestVideo,
} from '../tests/helpers.mjs';
import { launchChrome } from '../tests/cdp.mjs';

const report = new Report('Busca: pessoas (item 21) e palavras (item 22)');

async function run() {
  const server = await startServer();
  const host = new Client(server.baseUrl);
  const hostUser = await host.register({ username: randomUsername('alvo') });
  await host.post('/api/users/me/avatar', {}).catch(() => {});

  const cookies = await fetch(`${server.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: hostUser.username, password: 'Senha@Teste123' }),
  }).then((r) => r.headers.getSetCookie());

  const { makeTestImage } = await import('../tests/helpers.mjs');
  const avatar = await makeTestImage({ width: 120, height: 120 });
  await host.upload('/api/users/me/avatar', avatar.buffer, { filename: avatar.filename, mime: avatar.mime });

  // Publicacoes REAIS com palavras e hashtags.
  const palavras = ['maquiagem', 'musica', 'viagem'];
  const esperadoPorPalavra = {};
  for (const p of palavras) {
    const video = await makeTestVideo({ seconds: 1, width: 240, height: 320 });
    const up = await host.upload('/api/media/upload?purpose=video', video.buffer, {
      filename: video.filename, mime: video.mime,
    });
    const post = await host.post('/api/posts', {
      type: 'video',
      caption: `Um video sobre ${p} e detalhes do assunto #${p} #viagens`,
      mediaId: up.body.media.id,
    });
    esperadoPorPalavra[p] = post.body.post.id;
  }

  const browser = await launchChrome({ extraArgs: ['--autoplay-policy=no-user-gesture-required'] });
  const s = await browser.newBrowserContext();
  s.watch();

  const digitar = async (termo) => {
    await s.eval(`
      const campo = document.querySelector('input[type="search"]');
      if (!campo) return false;
      campo.focus();
      campo.value = ${JSON.stringify(termo)};
      campo.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    `);
    // Espera o resultado (debounce de 320ms + rede).
    for (let i = 0; i < 16; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(600);
      // eslint-disable-next-line no-await-in-loop
      const pronto = await s.eval("return !document.querySelector('.page-empty .spinner');");
      if (pronto) break;
    }
    await sleep(600);
    return s.eval(`
      const texto = document.body.innerText || '';
      const secPessoas = [...document.querySelectorAll('section')]
        .find((x) => /Pessoas/i.test(x.querySelector('h2')?.textContent || ''));
      const linkPessoa = secPessoas ? secPessoas.querySelector('a[href^="/@"]') : null;
      const cartoes = [...document.querySelectorAll('.grid a[href^="/video/"]')].map((a) => a.getAttribute('href'));
      const tags = [...document.querySelectorAll('a[href^="/tag/"]')].map((a) => (a.textContent || '').trim());
      return {
        urlVisivel: /https?:\\/\\/[a-z0-9.]+\\//i.test(texto),
        textoDaSecao: secPessoas ? secPessoas.textContent.trim().replace(/\\s+/g, ' ') : null,
        htmlDaSecao: secPessoas ? secPessoas.innerHTML.slice(0, 900) : null,
        hrefPessoa: linkPessoa ? linkPessoa.getAttribute('href') : null,
        nomeVisivel: linkPessoa ? (linkPessoa.querySelector('.strong')?.textContent || '').trim() : '',
        usernameVisivel: linkPessoa ? (linkPessoa.querySelector('.small')?.textContent || '') : '',
        temAvatar: Boolean(linkPessoa && linkPessoa.querySelector('.avatar')),
        cartoes,
        tags,
      };
    `);
  };

  try {
    await s.goto(`${server.baseUrl}/`, { waitMs: 300 });
    for (const ck of cookies) {
      const par = ck.split(';')[0];
      const nome = par.slice(0, par.indexOf('='));
      await s.send('Network.setCookie', {
        name: nome, value: decodeURIComponent(par.slice(nome.length + 1)), domain: '127.0.0.1', path: '/',
      });
    }
    await s.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await s.goto(`${server.baseUrl}/busca`, { waitMs: 2600 });

    // ------------------------------- ITEM 21: PESSOA ------------------------
    for (const termo of [hostUser.username, hostUser.displayName.toLowerCase()]) {
      const r = await digitar(termo);
      // A URL aparecendo como texto era exatamente o defeito.
      if (r.urlVisivel) {
        throw new Error(`busca por "${termo}" mostrou URL na tela: ${JSON.stringify(r.textoDaSecao)}`);
      }
      if (!r.hrefPessoa) {
        throw new Error(`busca por "${termo}" nao devolveu link de perfil; `
          + `secao=${JSON.stringify(r.textoDaSecao)}`);
      }
      if (r.hrefPessoa !== `/@${hostUser.username}`) {
        throw new Error(`busca por "${termo}" aponta para ${r.hrefPessoa} (esperado /@${hostUser.username})`);
      }
      if (r.nomeVisivel !== hostUser.displayName) {
        throw new Error(`busca por "${termo}" mostrou o nome "${r.nomeVisivel}" (esperado "${hostUser.displayName}")`);
      }
      if (!r.usernameVisivel.includes(`@${hostUser.username}`)) {
        throw new Error(`busca por "${termo}" nao mostrou o @username (veio "${r.usernameVisivel}")`);
      }
      if (!r.temAvatar) {
        throw new Error(`busca por "${termo}" mostrou o perfil sem espaco de foto`);
      }
      report.ok(`item 21 - "${termo}": [foto] ${r.nomeVisivel} / ${r.usernameVisivel} `
        + `-> ${r.hrefPessoa}, sem URL na tela`);
    }

    // Clicar no resultado abre o perfil CERTO.
    await digitar(hostUser.username);
    await s.eval(`
      const a = document.querySelector('section a[href^="/@"]');
      if (!a) return false;
      a.click();
      return true;
    `);
    await sleep(1600);
    const abriu = await s.eval(`
      const marcador = document.querySelector('[data-username]');
      return {
        url: location.pathname,
        perfil: marcador ? marcador.dataset.username : null,
        texto: (document.body.innerText || '').includes(${JSON.stringify(hostUser.displayName)}),
        temGrade: Boolean(document.querySelector('.profile-tabs')),
      };
    `);
    if (abriu.url !== `/@${hostUser.username}`) {
      throw new Error(`clicar no resultado abriu ${abriu.url} (esperado /@${hostUser.username})`);
    }
    if (abriu.perfil !== hostUser.username) {
      throw new Error(`a tela carregou o perfil "${abriu.perfil}" (esperado "${hostUser.username}")`);
    }
    if (!abriu.texto || !abriu.temGrade) {
      throw new Error(`o perfil nao renderizou apos clicar no resultado (${JSON.stringify(abriu)})`);
    }
    report.ok(`item 21 - clicar no resultado abre ${abriu.url} com data-username="${abriu.perfil}" e a grade de abas`);

    // ------------------------------- ITEM 22: PALAVRAS ----------------------
    for (const palavra of palavras) {
      await s.goto(`${server.baseUrl}/busca`, { waitMs: 2000 });
      const r = await digitar(palavra);
      const esperado = `/video/${esperadoPorPalavra[palavra]}`;
      if (!r.cartoes.length) {
        throw new Error(`busca por "${palavra}" nao devolveu nenhuma publicacao `
          + `(tags=${JSON.stringify(r.tags)})`);
      }
      if (!r.cartoes.includes(esperado)) {
        throw new Error(`busca por "${palavra}" nao trouxe a publicacao ${esperado}: ${JSON.stringify(r.cartoes)}`);
      }
      if (!r.tags.some((t) => t.toLowerCase().includes(palavra))) {
        throw new Error(`busca por "${palavra}" nao trouxe a hashtag correspondente: ${JSON.stringify(r.tags)}`);
      }
      // Clicar abre a publicacao certa.
      await s.eval(`
        const a = document.querySelector('a[href="${esperado}"]');
        if (!a) return false;
        a.click();
        return true;
      `);
      await sleep(1700);
      const abriuPost = await s.eval(`
        const v = document.querySelector('video, .slide-audio audio, img');
        return { url: location.pathname, temMidia: Boolean(v) };
      `);
      if (abriuPost.url !== esperado) {
        throw new Error(`clicar no resultado de "${palavra}" abriu ${abriuPost.url} (esperado ${esperado})`);
      }
      if (!abriuPost.temMidia) throw new Error(`a publicacao ${esperado} abriu sem midia`);
      report.ok(`item 22 - "${palavra}": ${r.cartoes.length} publicacao(oes) + ${r.tags.length} hashtag(s); `
        + `clique abriu ${esperado} com midia`);
    }

    report.ok('busca por pessoas e por palavras validada com conteudo real do banco');
  } catch (error) {
    report.fail('verificacao da busca interrompida', error);
  } finally {
    try { s.close?.(); } catch { /* ignore */ }
    await browser.close();
    await server.stop();
  }
  return report.summary();
}

run().then((r) => process.exit(r.failed > 0 ? 1 : 0)).catch((e) => { console.error(e); process.exit(1); });
