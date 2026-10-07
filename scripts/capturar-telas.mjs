/**
 * Capturas de tela finais da rodada (itens 1 a 16).
 *
 * Existe porque os testes medem numeros e o item 15 pede verificacao VISUAL no
 * navegador. As telas sao exatamente as 13 pedidas no item 15, mais as que
 * mudaram nesta rodada:
 *   1. feed desktop (1440) e 2. feed mobile (320/390)
 *   3. perfil mobile + 4. lista de Seguindo + 5. perfil aberto a partir da lista
 *   6. conversa privada desktop e 7. conversa privada mobile
 *   8. picker GIF/figurinha desktop e 9. no mobile
 *  10. comentario com GIF, 11. com figurinha, 12. com audio
 *  13. mensagem privada com audio
 * alem de: aba Amigos, publicacao so com audio e LIVE (host + espectador).
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  startServer, Client, Report, sleep, randomUsername, makeTestVideo, makeTestImage,
} from '../tests/helpers.mjs';
import { launchChrome } from '../tests/cdp.mjs';

const report = new Report('Capturas de tela da rodada');
const SAIDA = path.resolve('tests', 'artifacts', 'telas-rodada');

async function run() {
  const server = await startServer();
  fs.mkdirSync(SAIDA, { recursive: true });

  const host = new Client(server.baseUrl);
  const hostUser = await host.register({ username: randomUsername('host') });
  await host.post('/api/auth/login', { identifier: hostUser.username, password: 'Senha@Teste123' });

  // Foto de perfil real (item 2: pessoa COM foto).
  const avatar = await makeTestImage({ width: 140, height: 140 });
  await host.upload('/api/users/me/avatar', avatar.buffer, { filename: avatar.filename, mime: avatar.mime });

  const esp = new Client(server.baseUrl);
  const espUser = await esp.register({ username: randomUsername('esp') });
  await esp.post('/api/auth/login', { identifier: espUser.username, password: 'Senha@Teste123' });
  await esp.post(`/api/users/${hostUser.id}/follow`, {});
  await host.post(`/api/users/${espUser.id}/follow`, {});

  // Publicacoes reais com hashtags (item 7: hashtags visiveis).
  const video = await makeTestVideo({ seconds: 2, width: 360, height: 640 });
  const up = await host.upload('/api/media/upload?purpose=video', video.buffer, {
    filename: video.filename, mime: video.mime,
  });
  const post = await host.post('/api/posts', {
    type: 'video',
    caption: 'Rolagem vertical de verdade, com rolagem nativa do navegador #feed #rolagem #teste',
    mediaId: up.body.media.id,
  });
  const postId = post.body.post.id;

  // Comentario com GIF e com figurinha (item 15).
  //
  // As URLs sao buscadas na API do projeto (GIPHY via backend) em vez de
  // hardcoded: uma URL antiga devolve 200 com a imagem "conteudo
  // indisponivel" do GIPHY, e a captura mostrava um retangulo preto no lugar
  // do GIF sem nenhuma falha aparente.
  const gifTrends = await host.get('/api/giphy/trending', { query: { limit: 3, kind: 'gifs' } });
  const gifItens = gifTrends.body.items || [];
  const stickerTrends = await host.get('/api/giphy/trending', { query: { limit: 3, kind: 'stickers' } });
  const stickerItens = stickerTrends.body.items || [];
  const urlDe = (item) => item?.downsizedUrl || item?.url || item?.previewUrl || null;
  const gifUrl = urlDe(gifItens[0]);
  const stickerUrl = urlDe(stickerItens[0]);
  if (!gifUrl || !stickerUrl) {
    throw new Error(`GIPHY nao devolveu itens para a captura (gifs=${gifItens.length}, stickers=${stickerItens.length})`);
  }
  await esp.post(`/api/posts/${postId}/comments`, {
    body: '', type: 'gif', metadata: { url: gifUrl, id: gifItens[0].id, posterUrl: urlDe(gifItens[0]) },
  });
  await esp.post(`/api/posts/${postId}/comments`, {
    body: '', type: 'sticker', metadata: { url: stickerUrl, id: stickerItens[0].id, posterUrl: urlDe(stickerItens[0]) },
  });

  const browser = await launchChrome({ extraArgs: ['--autoplay-policy=no-user-gesture-required'] });
  const sessoes = [];
  const cookies = await fetch(`${server.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: hostUser.username, password: 'Senha@Teste123' }),
  }).then((r) => r.headers.getSetCookie());

  async function sessao(w, h, mobile, rota) {
    const s = await browser.newBrowserContext();
    sessoes.push(s);
    await s.goto(`${server.baseUrl}/`, { waitMs: 250 });
    for (const ck of cookies) {
      const par = ck.split(';')[0];
      const nome = par.slice(0, par.indexOf('='));
      await s.send('Network.setCookie', {
        name: nome, value: decodeURIComponent(par.slice(nome.length + 1)), domain: '127.0.0.1', path: '/',
      });
    }
    await s.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile });
    await s.goto(`${server.baseUrl}${rota}`, { waitMs: 3200 });
    return s;
  }

  const feito = [];
  const capturar = async (nome, s) => {
    const { data } = await s.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SAIDA, `${nome}.png`), Buffer.from(data, 'base64'));
    feito.push(nome);
  };

  try {
    // ---- Feed em varias larguras (itens 4 e 7) ----
    for (const [w, h, m] of [[320, 640, true], [390, 844, true], [768, 1024, false], [1440, 900, false]]) {
      // eslint-disable-next-line no-await-in-loop
      const s = await sessao(w, h, m, '/');
      // eslint-disable-next-line no-await-in-loop
      await s.eval("const v=document.querySelector('video'); if(v){v.muted=true;v.play?.().catch(()=>{});} return true;");
      // eslint-disable-next-line no-await-in-loop
      await sleep(1200);
      // eslint-disable-next-line no-await-in-loop
      await capturar(`feed-${w}`, s);
      // eslint-disable-next-line no-await-in-loop
      await s.close?.();
    }
    report.ok(`feed capturado em 4 larguras (itens 4 e 7)`);

    // ---- Perfil + Seguindo (item 3) ----
    const perfil = await sessao(390, 844, true, `/@${hostUser.username}`);
    await capturar('perfil-seguindo-390', perfil);
    await perfil.eval(`
      const b = [...document.querySelectorAll('button, a')].find((x) => /seguindo/i.test(x.textContent || '') && (x.textContent || '').trim().length < 24);
      if (b) b.click();
      return true;
    `);
    await sleep(1800);
    await capturar('perfil-lista-seguindo', perfil);

    // Item 3: clicar num usuario da lista tem que TROCAR a janela pelo perfil -
    // sem modal por cima, sem backdrop e sem scroll-lock. A captura e feita
    // DEPOIS do clique, que e exatamente onde o defeito aparecia.
    const estadoLista = await perfil.eval(`
      const m = document.querySelector('.modal-backdrop');
      const link = m ? m.querySelector('a[href^="/@"]') : null;
      if (!link) return 'sem link na lista';
      link.click();
      return 'clicou';
    `);
    if (estadoLista === 'sem link na lista') throw new Error(estadoLista);
    await sleep(1600);
    const depoisDaLista = await perfil.eval(`
      return {
        modais: document.querySelectorAll('.modal-backdrop, .sheet').length,
        noScroll: document.body.classList.contains('no-scroll'),
        url: location.pathname,
      };
    `);
    if (depoisDaLista.modais > 0) {
      throw new Error(`a lista de Seguindo ficou aberta por cima do perfil (${depoisDaLista.modais})`);
    }
    if (depoisDaLista.noScroll) throw new Error('scroll-lock preso apos abrir o perfil da lista');
    await capturar('perfil-aberto-da-lista', perfil);
    await perfil.close?.();
    report.ok('perfil, lista de Seguindo e perfil aberto a partir da lista capturados (item 3)');

    // ---- Amigos (item 2) ----
    const amigos = await sessao(390, 844, true, '/amigos');
    await capturar('amigos', amigos);
    await amigos.close?.();
    report.ok('aba Amigos capturada (item 2)');

    // ---- Comentario com GIF e figurinha (item 15) ----
    const coments = await sessao(390, 844, true, `/video/${postId}`);
    await coments.eval(`
      const b = [...document.querySelectorAll('button')].find((x) => /coment/i.test(x.getAttribute('aria-label') || ''));
      if (b) b.click();
      return true;
    `);
    // Espera as duas imagensarem de verdade: sem isto a captura pode sair com
    // o retangulo "conteudo indisponivel" do GIPHY e nao prova nada.
    let midias = null;
    for (let i = 0; i < 18; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(900);
      // eslint-disable-next-line no-await-in-loop
      midias = await coments.eval(`
        const imgs = [...document.querySelectorAll('.comment-media img')];
        return {
          total: imgs.length,
          comPixel: imgs.filter((i) => i.naturalWidth > 8).length,
          quebradas: document.querySelectorAll('.comment-media .media-broken').length,
        };
      `);
      if (midias.total >= 2 && midias.comPixel >= 2) break;
    }
    if (!midias || midias.comPixel < 2) {
      throw new Error(`os GIF/figurinha do comentario nao carregaram de verdade: ${JSON.stringify(midias)}`);
    }
    await capturar('comentarios-gif-figurinha', coments);
    await coments.close?.();
    report.ok(`painel de comentarios com GIF e figurinha carregados de verdade (${JSON.stringify(midias)})`);

    // ---- Publicacao de audio (item 16) ----
    const { makeTestAudio } = await import('../tests/helpers.mjs');
    const audio = await makeTestAudio({ seconds: 1 });
    const upA = await host.upload('/api/media/upload?purpose=audio', audio.buffer, {
      filename: audio.filename, mime: audio.mime,
    });
    const postAudio = await host.post('/api/posts', {
      type: 'audio', mediaId: upA.body.media.id, caption: 'publicacao so com audio #audio',
    });
    const telaAudio = await sessao(390, 844, true, `/video/${postAudio.body.post.id}`);
    await capturar('post-audio', telaAudio);
    await telaAudio.close?.();
    report.ok('publicacao de audio capturada (item 16)');

    // ---- CONVERSA PRIVADA (itens 4 e 7) -----------------------------------
    // Conversa real com mensagens dos DOIS lados e um audio de cada, para a
    // captura mostrar a bolha rosa/roxo (minha), a azul (da outra) e a duracao
    // real do audio - nao um esqueleto.
    const conversa = await host.post('/api/conversations', { userId: espUser.id });
    const conversationId = conversa.body.conversationId;
    await host.post(`/api/conversations/${conversationId}/messages`, { type: 'text', body: 'Oi! Esse e o meu canal novo.' });
    await esp.post(`/api/conversations/${conversationId}/messages`, { type: 'text', body: 'Oi! Vim pelo_video. Ficou otimo.' });
    const audioDm = await makeTestAudio({ seconds: 8, frequency: 330 });
    const upDm = await esp.upload('/api/media/upload?purpose=audio', audioDm.buffer, {
      filename: audioDm.filename, mime: audioDm.mime,
    });
    await esp.post(`/api/conversations/${conversationId}/messages`, { type: 'audio', body: '', mediaId: upDm.body.media.id });
    await host.post(`/api/conversations/${conversationId}/messages`, { type: 'text', body: 'Ouve esse audio 👇' });
    const audioDm2 = await makeTestAudio({ seconds: 37, frequency: 440 });
    const upDm2 = await host.upload('/api/media/upload?purpose=audio', audioDm2.buffer, {
      filename: audioDm2.filename, mime: audioDm2.mime,
    });
    await host.post(`/api/conversations/${conversationId}/messages`, { type: 'audio', body: '', mediaId: upDm2.body.media.id });

    // Telas 6 e 7: conversa no desktop e no celular.
    for (const [w, h, m, nome] of [[1280, 900, false, 'conversa-desktop'], [390, 844, true, 'conversa-mobile']]) {
      // eslint-disable-next-line no-await-in-loop
      const s = await sessao(w, h, m, `/inbox/${conversationId}`);
      // Espera os players revelarem a duracao (vem do arquivo, nao do HTML).
      for (let i = 0; i < 16; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        const pronto = await s.eval("return [...document.querySelectorAll('.ab .ab-dur')].every((d) => d.textContent !== '--:--');");
        if (pronto) break;
        // eslint-disable-next-line no-await-in-loop
        await sleep(800);
      }
      const lados = await s.eval(`
        const linhas = [...document.querySelectorAll('.msg')];
        const cont = linhas[0]?.parentElement;
        const meio = cont ? cont.getBoundingClientRect().left + cont.getBoundingClientRect().width / 2 : innerWidth / 2;
        return {
          total: linhas.length,
          minhas: linhas.filter((n) => n.classList.contains('mine')).length,
          foraDoLado: linhas.filter((n) => {
            const b = n.getBoundingClientRect();
            const direita = n.classList.contains('mine');
            return (direita && b.right < meio) || (!direita && b.left > meio);
          }).length,
        };
      `);
      if (lados.minhas < 2 || lados.foraDoLado > 0) {
        throw new Error(`${nome}: lados errados (${JSON.stringify(lados)})`);
      }
      // eslint-disable-next-line no-await-in-loop
      await capturar(nome, s);
      // eslint-disable-next-line no-await-in-loop
      await s.close?.();
    }
    report.ok('conversa privada capturada no desktop e no celular (itens 4 e 7)');

    // Telas 8 e 9: o seletor de GIF/figurinha nos dois tamanhos.
    for (const [w, h, m, nome] of [[1280, 900, false, 'picker-gif-desktop'], [390, 844, true, 'picker-gif-mobile']]) {
      // eslint-disable-next-line no-await-in-loop
      const s = await sessao(w, h, m, `/inbox/${conversationId}`);
      // eslint-disable-next-line no-await-in-loop
      const abriu = await s.eval(`
        const b = [...document.querySelectorAll('.composer button')].find((x) => /gif/i.test(x.getAttribute('aria-label') || ''));
        if (!b) return false;
        b.click();
        return true;
      `);
      if (!abriu) throw new Error(`${nome}: sem botao de GIF no composer`);
      // Espera a grade encher (GIPHY e rede real, sem mock).
      for (let i = 0; i < 16; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        const cheio = await s.eval("const g=document.querySelector('.picker-panel .picker-grid'); return g ? g.querySelectorAll('button').length : 0;");
        if (cheio > 0) break;
        // eslint-disable-next-line no-await-in-loop
        await sleep(900);
      }
      const painel = await s.eval(`
        const p = document.querySelector('.picker-panel');
        if (!p) return null;
        const b = p.getBoundingClientRect();
        return { w: Math.round(b.width), h: Math.round(b.height), pct: Math.round((b.height / innerHeight) * 100), dentro: b.left >= -1 && b.right <= innerWidth + 1 };
      `);
      if (!painel || !painel.dentro) throw new Error(`${nome}: painel fora da tela (${JSON.stringify(painel)})`);
      // eslint-disable-next-line no-await-in-loop
      await capturar(nome, s);
      // eslint-disable-next-line no-await-in-loop
      await s.close?.();
      report.ok(`${nome}: picker ${painel.w}x${painel.h} (${painel.pct}% da tela)`);
    }

    // Tela 12: comentario com audio mostrando a duracao real (item 8).
    const audioComentario = await makeTestAudio({ seconds: 12, frequency: 220 });
    const upComentario = await esp.upload('/api/media/upload?purpose=audio', audioComentario.buffer, {
      filename: audioComentario.filename, mime: audioComentario.mime,
    });
    const respComentario = await esp.post(`/api/posts/${postId}/comments`, {
      type: 'audio', body: '', mediaId: upComentario.body.media.id,
    });
    if (respComentario.status >= 400) {
      throw new Error(`comentario de audio recusado (${respComentario.status}): ${JSON.stringify(respComentario.body)}`);
    }
    const telaAudioComentario = await sessao(390, 844, true, `/video/${postId}`);
    await telaAudioComentario.eval(`
      const b = [...document.querySelectorAll('button')].find((x) => /coment/i.test(x.getAttribute('aria-label') || ''));
      if (b) b.click();
      return true;
    `);
    for (let i = 0; i < 16; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const pronto = await telaAudioComentario.eval("return document.querySelector('.comment-media .ab .ab-dur')?.textContent || null;");
      if (pronto && pronto !== '--:--') break;
      // eslint-disable-next-line no-await-in-loop
      await sleep(800);
    }
    const durComentario = await telaAudioComentario.eval("return document.querySelector('.comment-media .ab .ab-dur')?.textContent || null;");
    if (!durComentario || durComentario === '--:--') {
      throw new Error(`o comentario de audio nao mostrou a duracao (veio "${durComentario}")`);
    }
    await capturar('comentario-audio', telaAudioComentario);
    await telaAudioComentario.close?.();
    report.ok(`comentario com audio capturado, duracao real ${durComentario} (item 8)`);

    // ---- LIVE: host com a barra na ordem do item 13 ----
    const telaHost = await sessao(390, 844, true, '/iniciar-live');
    await telaHost.eval(`
      const b = [...document.querySelectorAll('button')].find((x) => /iniciar transmissao/i.test(x.textContent || ''));
      if (b) b.click();
      return true;
    `);
    await sleep(6500);
    await telaHost.eval("const v=document.querySelector('video'); if(v){v.muted=true;v.play?.().catch(()=>{});} return true;");
    await sleep(1200);
    await capturar('live-host-barra', telaHost);
    // Configuracoes no topo, com "Encerrar LIVE" dentro (item 11).
    await telaHost.eval(`
      const b = [...document.querySelectorAll('.live-top-actions button')].find((x) => /configuracoes/i.test(x.getAttribute('aria-label') || ''));
      if (b) b.click();
      return true;
    `);
    await sleep(1200);
    await capturar('live-host-configuracoes', telaHost);
    // NAO fecha a sessao do host aqui: o espectador precisa de um host vivo
    // para negociar o WebRTC. Fechar antes quebrava a transmissao e a captura
    // do espectador saia em "Conectando" para sempre.
    report.ok('LIVE do host capturada: barra na ordem e menu com Encerrar LIVE (itens 11 e 13)');

    // ---- LIVE: espectador + painel de espectadores (item 12) ----
    const minha = await host.get(`/api/users/${hostUser.id}/live`);
    const room = minha.body.live;
    const cookiesEsp = await fetch(`${server.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: espUser.username, password: 'Senha@Teste123' }),
    }).then((r) => r.headers.getSetCookie());
    const telaEsp = await browser.newBrowserContext();
    sessoes.push(telaEsp);
    await telaEsp.goto(`${server.baseUrl}/`, { waitMs: 250 });
    for (const ck of cookiesEsp) {
      const par = ck.split(';')[0];
      const nome = par.slice(0, par.indexOf('='));
      await telaEsp.send('Network.setCookie', {
        name: nome, value: decodeURIComponent(par.slice(nome.length + 1)), domain: '127.0.0.1', path: '/',
      });
    }
    await telaEsp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await telaEsp.goto(`${server.baseUrl}/live/${room.id}`, { waitMs: 5200 });
    // A midia chega por WebRTC de verdade (offer/answer + ICE), o que leva
    // alguns segundos. A captura anterior saiu em "Conectando" e nao provava
    // nada; aqui o script ESPERA a pista chegar antes de fotografar.
    let midia = await telaEsp.eval(`
      const v = document.querySelector('video');
      return v && v.srcObject ? v.srcObject.getTracks().map((t) => t.kind) : null;
    `);
    for (let i = 0; i < 20 && !(midia && midia.length); i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(1200);
      // eslint-disable-next-line no-await-in-loop
      midia = await telaEsp.eval(`
        const v = document.querySelector('video');
        return v && v.srcObject ? v.srcObject.getTracks().map((t) => t.kind) : null;
      `);
    }
    if (!midia || !midia.length) throw new Error('a midia do host nao chegou ao espectador em ~24s');
    report.ok(`espectador recebeu midia real: ${midia.join('+')}`);
    await capturar('live-espectador', telaEsp);
    await telaEsp.eval(`
      const b = document.querySelector('.live-viewers-btn');
      if (b) b.click();
      return true;
    `);
    await sleep(1800);
    await capturar('live-espectadores-painel', telaEsp);
    await telaEsp.close?.();
    report.ok('LIVE do espectador capturada: midia e painel de espectadores (item 12)');
    // So agora o host pode sair.
    await telaHost.close?.();

    report.ok(`${feito.length} telas salvas em tests/artifacts/telas-rodada`);
  } catch (error) {
    report.fail('captura interrompida', error);
  } finally {
    for (const s of sessoes) { try { s.close?.(); } catch { /* ignore */ } }
    await browser.close();
    await server.stop();
  }

  console.log(`\nArquivos: ${feito.map((n) => `${n}.png`).join(', ')}`);
  return report.summary();
}

run().then((r) => process.exit(r.failed > 0 ? 1 : 0)).catch((e) => {
  console.error('erro fatal:', e);
  process.exit(1);
});