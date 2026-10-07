/**
 * Verificador da CONVERSA PRIVADA (itens 4, 7 e 8).
 *
 *   4. MINHAS mensagens a direita com bolha rosa/roxo; da OUTRA PESSOA a
 *      esquerda com bolha azul. O lado vem do ID do remetente - o teste
 *      confere isso trocando as sessoes, nao pelo texto.
 *   7. Audio em conversa privada com DURACAO REAL (0:07, nao um numero fixo).
 *   8. Audio em comentario de publicacao com a mesma duracao real.
 *
 * A duracao e conferida contra o `duration` do proprio elemento <audio> no
 * navegador: se o texto da tela nao bater com o arquivo, ha bug.
 */
import {
  startServer, Client, Report, sleep, randomUsername, makeTestVideo, makeTestAudio,
} from '../tests/helpers.mjs';
import { launchChrome } from '../tests/cdp.mjs';

const report = new Report('Conversa privada: lados, cores e duracao real do audio');

/** Empacota `m:ss` como o app faz, para comparar com o texto na tela. */
function mmss(segundos) {
  const total = Math.round(segundos);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

async function run() {
  const server = await startServer();
  const alice = new Client(server.baseUrl);
  const aliceUser = await alice.register({ username: randomUsername('alice') });
  const bob = new Client(server.baseUrl);
  const bobUser = await bob.register({ username: randomUsername('bob') });

  const loginDe = async (username) => fetch(`${server.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: username, password: 'Senha@Teste123' }),
  }).then((r) => r.headers.getSetCookie());

  const cookiesAlice = await loginDe(aliceUser.username);
  const cookiesBob = await loginDe(bobUser.username);

  // Conversa com mensagens de texto dos dois lados (para os lados/cores) e
  // um audio de CADA lado com duracoes bem diferentes.
  // A rota devolve `{ conversationId }` (a conversa e reutilizada se ja
  // existir entre os dois).
  const conversa = await alice.post('/api/conversations', { userId: bobUser.id });
  const conversationId = conversa.body.conversationId;
  if (!conversationId) throw new Error(`a rota de conversa nao devolveu conversationId: ${JSON.stringify(conversa.body).slice(0, 200)}`);

  // Cada envio e conferido: `Client.post` NAO lanca em 4xx (ele devolve
  // `{status, body}`), entao sem esta checagem uma recusa passaria batido e o
  // teste acusaria a interface por um erro de API.
  const enviados = [];
  const enviar = async (client, quem, payload) => {
    const r = await client.post(`/api/conversations/${conversationId}/messages`, payload);
    enviados.push({ quem, tipo: payload.type, status: r.status, erro: r.status >= 400 ? JSON.stringify(r.body).slice(0, 160) : null });
    return r;
  };

  // Sequencia montada de proposito: ha TREMOS de mensagens do mesmo autor
  // (a1+a2, b1+b2 e b3+audio), para o agrupamento ter o que agrupar, e
  // alternancias, para o grupo quebrar quando o autor muda.
  await enviar(alice, 'alice', { type: 'text', body: 'a1' });
  await enviar(alice, 'alice', { type: 'text', body: 'a2' });
  await enviar(bob, 'bob', { type: 'text', body: 'b1' });
  await enviar(bob, 'bob', { type: 'text', body: 'b2' });

  // Audios: 7s da alice e 12s do bob, para nao coincidirem com nenhum valor
  // redondo e "pegar" uma duracao fixa.
  const audioAlice = await makeTestAudio({ seconds: 7, frequency: 320 });
  const upAlice = await alice.upload('/api/media/upload?purpose=audio', audioAlice.buffer, {
    filename: audioAlice.filename, mime: audioAlice.mime,
  });
  await enviar(alice, 'alice', { type: 'audio', body: '', mediaId: upAlice.body.media.id });

  const audioBob = await makeTestAudio({ seconds: 12, frequency: 480 });
  const upBob = await bob.upload('/api/media/upload?purpose=audio', audioBob.buffer, {
    filename: audioBob.filename, mime: audioBob.mime,
  });
  await enviar(bob, 'bob', { type: 'text', body: 'b3' });
  await enviar(bob, 'bob', { type: 'audio', body: '', mediaId: upBob.body.media.id });

  const recusados = enviados.filter((e) => e.status >= 400);
  if (recusados.length) {
    throw new Error(`a API recusou ${recusados.length} envio(s): ${JSON.stringify(recusados)}`);
  }

  // Publicacao para o teste do comentario com audio (item 8).
  const video = await makeTestVideo({ seconds: 1, width: 240, height: 320 });
  const upVideo = await alice.upload('/api/media/upload?purpose=video', video.buffer, {
    filename: video.filename, mime: video.mime,
  });
  const post = await alice.post('/api/posts', {
    type: 'video', caption: 'post', mediaId: upVideo.body.media.id,
  });
  const postId = post.body.post.id;
  const audioComentario = await makeTestAudio({ seconds: 9, frequency: 220 });
  const upComentario = await alice.upload('/api/media/upload?purpose=audio', audioComentario.buffer, {
    filename: audioComentario.filename, mime: audioComentario.mime,
  });
  await alice.post(`/api/posts/${postId}/comments`, {
    type: 'audio', body: '', mediaId: upComentario.body.media.id,
  });

  const browser = await launchChrome({ extraArgs: ['--autoplay-policy=no-user-gesture-required'] });
  const s = await browser.newBrowserContext();
  s.watch();

  const autenticar = async (cookies) => {
    await s.goto(`${server.baseUrl}/`, { waitMs: 250 });
    for (const ck of cookies) {
      const par = ck.split(';')[0];
      const nome = par.slice(0, par.indexOf('='));
      await s.send('Network.setCookie', {
        name: nome, value: decodeURIComponent(par.slice(nome.length + 1)), domain: '127.0.0.1', path: '/',
      });
    }
  };

  const verBolhas = () => s.eval(`
    const linhas = [...document.querySelectorAll('.chat-thread-body .msg, .gc-feed .msg')];
    const cont = linhas[0]?.parentElement;
    const cr = cont?.getBoundingClientRect();
    const meio = cr ? cr.left + cr.width / 2 : innerWidth / 2;
    return {
      cont: cont ? cont.className : null,
      contDisplay: cont ? getComputedStyle(cont).display : null,
      contDir: cont ? getComputedStyle(cont).flexDirection : null,
      contBox: cr ? { left: Math.round(cr.left), right: Math.round(cr.right), w: Math.round(cr.width) } : null,
      linhas: linhas.map((n) => {
        const b = n.getBoundingClientRect();
        const bolha = n.querySelector('.msg-bubble');
        const cs = bolha ? getComputedStyle(bolha) : null;
        const cn = getComputedStyle(n);
        return {
          texto: (n.querySelector('.msg-bubble')?.textContent || '').trim().slice(0, 28),
          autorId: n.dataset.autorId || null,
          classe: n.className,
          minha: n.classList.contains('mine'),
          alignSelf: cn.alignSelf,
          marginLeft: cn.marginLeft,
          marginRight: cn.marginRight,
          w: Math.round(b.width),
          left: Math.round(b.left),
          right: Math.round(b.right),
          lado: b.right >= meio - 8 ? 'direita' : 'esquerda',
          cor: cs ? (cs.backgroundImage !== 'none' ? cs.backgroundImage.slice(0, 70) : cs.backgroundColor) : null,
          corTexto: cs ? cs.color : null,
        };
      }),
    };
  `);

  const verAudios = () => s.eval(`
    return [...document.querySelectorAll('.ab')].map((ab) => {
      const audio = ab.querySelector('audio');
      const dur = ab.querySelector('.ab-dur');
      const tempo = ab.querySelector('.ab-tempo');
      return {
        rotulo: audio?.getAttribute('aria-label') || '',
        duracaoReal: audio && Number.isFinite(audio.duration) ? Math.round(audio.duration) : null,
        textoDuracao: dur ? dur.textContent : null,
        textoTempo: tempo ? tempo.textContent : null,
        temBotaoPlay: Boolean(ab.querySelector('.ab-play')),
        temTrilha: Boolean(ab.querySelector('.ab-track')),
      };
    });
  `);

  try {
    // ------------------------------ LADO DA ALICE (o "eu" da sessao) ---
    await s.send('Emulation.setDeviceMetricsOverride', {
      width: 1280, height: 900, deviceScaleFactor: 1, mobile: false,
    });
    await autenticar(cookiesAlice);
    await s.goto(`${server.baseUrl}/inbox/${conversationId}`, { waitMs: 2600 });

    for (let i = 0; i < 14; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(700);
      // eslint-disable-next-line no-await-in-loop
      const pronto = await s.eval("return document.querySelectorAll('.msg').length >= 6;");
      if (pronto) break;
    }

    const verAlice = await verBolhas();
    const bolhasAlice = verAlice.linhas;
    if (bolhasAlice.length < 6) {
      const res = await alice.get(`/api/conversations/${conversationId}`, { query: { limit: 50 } });
      const ms = (res.body.messages || []);
      const dom = await s.eval(`
        return {
          msgs: document.querySelectorAll('.msg').length,
          linhas: document.querySelectorAll('.chat-thread-body > *').length,
          url: location.pathname,
        };
      `);
      throw new Error(`so ${bolhasAlice.length} mensagem(ns) renderizada(s); `
        + `api=${ms.length} (${JSON.stringify(ms.map((m) => m.type))}) status=${res.status} dom=${JSON.stringify(dom)}`);
    }

    const minhas = bolhasAlice.filter((b) => b.minha);
    const dela = bolhasAlice.filter((b) => !b.minha);
    // Alice enviou 2 textos + 1 audio (3); Bob, 3 textos + 1 audio (4).
    if (minhas.length !== 3 || dela.length !== 4) {
      throw new Error(`a sessao da Alice marcou ${minhas.length} como suas e ${dela.length} como da outra (esperado 3 e 4)`);
    }
    // Item 4: lado correto.
    const erradas = [...minhas.filter((b) => b.lado !== 'direita'), ...dela.filter((b) => b.lado !== 'esquerda')];
    if (erradas.length) {
      throw new Error(`mensagem no lado errado: ${JSON.stringify(erradas.map((b) => ({ t: b.texto, lado: b.lado, minha: b.minha })))}`);
    }
    // Item 4: cores distintas. As duas bolhas nao podem ser a mesma cor.
    const corMinha = minhas[0].cor;
    const corDela = dela[0].cor;
    if (corMinha === corDela) {
      throw new Error(`as duas bolhas tem a mesma cor (${corMinha})`);
    }
    // As cores sao comparadas parada a parada do gradiente:
    //   - "minha" tem de ter uma parada ROSA (dominio vermelho) e uma
    //     PARDA/ROXA (azul dominante) - e a assinatura da marca;
    //   - "da outra" tem de ser AZUL em todas as paradas (azul dominante),
    //     sem nenhuma parada rosa.
    const paradas = (v) => [...(v || '').matchAll(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/g)]
      .map((m) => ({ r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) }));
    const minhasParadas = paradas(corMinha);
    const delaParadas = paradas(corDela);
    const temRosa = minhasParadas.some((c) => c.r >= c.b && c.r >= c.g);
    const temRoxo = minhasParadas.some((c) => c.b > c.g && c.r >= c.g);
    if (!temRosa || !temRoxo) {
      throw new Error(`a bolha "minha" nao tem as duas paradas da marca (rosa=${temRosa}, roxo=${temRoxo}): ${corMinha}`);
    }
    if (!delaParadas.length || !delaParadas.every((c) => c.b > c.r)) {
      throw new Error(`a bolha da outra pessoa nao esta em azul em todas as paradas: ${corDela}`);
    }
    report.ok(`cores: minhas=${corMinha} | outra=${corDela}`);

    // Agrupamento visual de mensagens consecutivas do mesmo autor.
    const grupos = await s.eval(`
      const linhas = [...document.querySelectorAll('.msg')];
      return {
        agrupadas: linhas.filter((n) => n.classList.contains('msg-agrupo')).length,
        comHora: linhas.filter((n) => { const h = n.querySelector('.msg-hora'); return h && !h.hidden; }).length,
        estados: linhas.filter((n) => n.querySelector('.msg-state')).length,
        total: linhas.length,
      };
    `);
    if (grupos.agrupadas < 3) {
      throw new Error(`agrupamento quase inexistente (${grupos.agrupadas} de ${grupos.total}; esperado 3: a2, b2 e o audio do bob)`);
    }
    if (grupos.comHora >= grupos.total) {
      throw new Error(`a hora aparece em todas as ${grupos.total} mensagens (sem agrupamento visual)`);
    }
    // O estado de entrega NAO pode sumir junto com a hora: e informacao.
    if (grupos.estados < 3) {
      throw new Error(`o estado de entrega sumiu no agrupamento (${grupos.estados} de 3)`);
    }
    // O agrupamento precisa mudar a GEOMETRIA, nao so a classe:
    //  - dentro de um grupo, o vao e minimo (<=4px) e o avatar some;
    //  - entre autores diferentes, o vao e o normal (>=8px).
    const vaos = await s.eval(`
      const linhas = [...document.querySelectorAll('.msg')];
      const info = linhas.map((n, i) => {
        const anterior = linhas[i - 1];
        const b = n.getBoundingClientRect();
        const a = anterior ? anterior.getBoundingClientRect() : null;
        const av = n.querySelector('.avatar');
        return {
          autor: n.dataset.autorId,
          agrupado: n.classList.contains('msg-agrupo'),
          vao: a ? Math.round(b.top - a.bottom) : null,
          avatarVisivel: av ? getComputedStyle(av).visibility !== 'hidden' : null,
        };
      });
      return info;
    `);
    const dentroDoGrupo = vaos.filter((v) => v.agrupado);
    const entreAutores = vaos.filter((v) => !v.agrupado && v.vao !== null);
    for (const v of dentroDoGrupo) {
      if (v.vao > 4) throw new Error(`mensagem agrupada ainda separada por ${v.vao}px`);
      if (v.avatarVisivel) throw new Error('mensagem de continuacao ainda mostra avatar');
    }
    for (const v of entreAutores) {
      if (v.vao < 8) throw new Error(`troca de autor colada demais (${v.vao}px)`);
    }

    // A hora e o estado de entrega ficam DENTRO da bolha. O player de audio e
    // mais alto que uma linha de texto, entao e facil o rodape da bolha
    // "sair" do fundo gradiente.
    const foraDaBolha = await s.eval(`
      return [...document.querySelectorAll('.msg-bubble')].map((b) => {
        const meta = b.querySelector('.msg-time');
        if (!meta) return null;
        const bb = b.getBoundingClientRect();
        const mb = meta.getBoundingClientRect();
        const dentro = mb.bottom <= bb.bottom + 1 && mb.top >= bb.top - 1;
        return dentro ? null : {
          texto: (b.textContent || '').trim().slice(0, 24),
          bolha: [Math.round(bb.top), Math.round(bb.bottom)],
          meta: [Math.round(mb.top), Math.round(mb.bottom)],
        };
      }).filter(Boolean);
    `);
    if (foraDaBolha.length) {
      throw new Error(`hora/estado de entrega fora da bolha: ${JSON.stringify(foraDaBolha)}`);
    }
    report.ok(`agrupamento: ${dentroDoGrupo.length} continuacoes com vao ${Math.max(...dentroDoGrupo.map((v) => v.vao))}px e sem avatar; `
      + `${entreAutores.length} trocas de autor com vao >= ${Math.min(...entreAutores.map((v) => v.vao))}px; `
      + 'hora e estado sempre dentro da bolha');

    // Item 7: duracao real do audio na conversa privada.
    const audiosAlice = await verAudios();
    if (!audiosAlice.length) throw new Error('nenhum player de audio na conversa');
    for (const a of audiosAlice) {
      if (!a.temBotaoPlay || !a.temTrilha) throw new Error('player sem botao de play ou sem trilha de progresso');
      if (a.duracaoReal === null) throw new Error(`o elemento <audio> nao revelou a duracao (${JSON.stringify(a)})`);
      const esperado = mmss(a.duracaoReal);
      if (a.textoDuracao !== esperado) {
        throw new Error(`duracao mostrada "${a.textoDuracao}" != real "${esperado}" (${JSON.stringify(a)})`);
      }
      report.ok(`audio "${a.rotulo}": duracao real ${a.duracaoReal}s mostrada como ${a.textoDuracao}`);
    }
    // Os dois audios tem duracoes diferentes e ambas aparecem.
    const textos = audiosAlice.map((a) => a.textoDuracao);
    if (!textos.includes(mmss(7)) || !textos.includes(mmss(12))) {
      throw new Error(`as duracoes esperadas (${mmss(7)} e ${mmss(12)}) nao apareceram; veio ${textos.join(', ')}`);
    }
    report.ok(`as duas duracoes reais aparecem: ${textos.join(' e ')}`);

    // ------------------------- MESMO LADO, SESSAO TROCADA (bob como "eu") ---
    await s.goto(`${server.baseUrl}/`, { waitMs: 300 });
    // Apaga o cookie da Alice e coloca o da Bob: o MESMO par de mensagens tem
    // de inverter de lado. Se o lado viesse da ordem do texto, nao inverteria.
    await s.send('Network.clearBrowserCookies');
    await autenticar(cookiesBob);
    await s.goto(`${server.baseUrl}/inbox/${conversationId}`, { waitMs: 2600 });
    for (let i = 0; i < 14; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(700);
      // eslint-disable-next-line no-await-in-loop
      const pronto = await s.eval("return document.querySelectorAll('.msg').length >= 6;");
      if (pronto) break;
    }
    const verBob = await verBolhas();
    const bolhasBob = verBob.linhas;
    if (bolhasBob.length < 6) throw new Error(`na sessao do Bob so ${bolhasBob.length} mensagem(ns)`);

    const inverteu = bolhasBob.every((b, i) => b.minha === !bolhasAlice[i].minha);
    if (!inverteu) {
      const i = bolhasBob.findIndex((b, k) => b.minha === bolhasAlice[k].minha);
      throw new Error(`o lado nao inverteu com a sessao trocada no indice ${i}: `
        + `alice=${bolhasAlice[i]?.texto} (${bolhasAlice[i]?.minha}) bob=${bolhasBob[i]?.texto} (${bolhasBob[i]?.minha})`);
    }
    report.ok('o lado das mensagens inverte ao trocar de sessao (decisao pelo ID, nao pela ordem)');

    // ---------------------------- ITEM 8: AUDIO EM COMENTARIO DE POST ---
    await s.goto(`${server.baseUrl}/video/${postId}`, { waitMs: 2400 });
    await s.eval(`
      const b = [...document.querySelectorAll('button')].find((x) => /coment/i.test(x.getAttribute('aria-label') || ''));
      if (b) b.click();
      return true;
    `);
    for (let i = 0; i < 14; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(700);
      // eslint-disable-next-line no-await-in-loop
      const pronto = await s.eval("return Boolean(document.querySelector('.comment .ab, .comment-media .ab'));");
      if (pronto) break;
    }
    const audiosComentario = await s.eval(`
      return [...document.querySelectorAll('.comment-media .ab')].map((ab) => {
        const audio = ab.querySelector('audio');
        const dur = ab.querySelector('.ab-dur');
        return {
          duracaoReal: audio && Number.isFinite(audio.duration) ? Math.round(audio.duration) : null,
          textoDuracao: dur ? dur.textContent : null,
          temBotaoPlay: Boolean(ab.querySelector('.ab-play')),
          temTrilha: Boolean(ab.querySelector('.ab-track')),
          src: audio ? String(audio.src).slice(0, 90) : null,
          readyState: audio ? audio.readyState : null,
          networkState: audio ? audio.networkState : null,
          erro: audio && audio.error ? audio.error.code : null,
        };
      });
    `);
    if (!audiosComentario.length) throw new Error('o comentario de audio nao renderizou o player');
    for (const a of audiosComentario) {
      if (!a.temBotaoPlay || !a.temTrilha) throw new Error('player do comentario sem botao ou sem trilha');
      if (a.duracaoReal === null) {
        // Antes de culpar a interface, mostra se o ARQUIVO responde: um 404 ou
        // um content-type errado aqui e problema de midia, nao de layout.
        const busca = await s.eval(`
          const audio = document.querySelector('.comment-media .ab audio');
          const r = await fetch(audio.src);
          const b = await r.blob();
          return { status: r.status, tipo: r.headers.get('content-type'), bytes: b.size };
        `);
        throw new Error(`comentario: <audio> sem duracao (${JSON.stringify(a)}) | `
          + `o arquivo responde ${JSON.stringify(busca)}`);
      }
      const esperado = mmss(a.duracaoReal);
      if (a.textoDuracao !== esperado) {
        throw new Error(`comentario: duracao "${a.textoDuracao}" != real "${esperado}"`);
      }
      if (a.textoDuracao !== mmss(9)) {
        throw new Error(`comentario: esperava ${mmss(9)} (9s reais), veio "${a.textoDuracao}"`);
      }
      report.ok(`comentario: audio de 9s mostrado como ${a.textoDuracao}, com play e progresso`);
    }

    // Recarrega: a duracao tem de se recompor (vem do arquivo, nao do HTML salvo).
    await s.goto(`${server.baseUrl}/video/${postId}`, { waitMs: 2400 });
    await s.eval(`
      const b = [...document.querySelectorAll('button')].find((x) => /coment/i.test(x.getAttribute('aria-label') || ''));
      if (b) b.click();
      return true;
    `);
    let textoDepois = null;
    for (let i = 0; i < 16; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(700);
      // eslint-disable-next-line no-await-in-loop
      textoDepois = await s.eval("const d = document.querySelector('.comment-media .ab .ab-dur'); return d ? d.textContent : null;");
      if (textoDepois && textoDepois !== '--:--') break;
    }
    if (textoDepois !== mmss(9)) {
      throw new Error(`apos recarregar o comentario mostrou "${textoDepois}", esperado "${mmss(9)}"`);
    }
    report.ok(`apos recarregar o comentario continua mostrando ${textoDepois}`);

    report.ok('conversa privada: lados, cores, agrupamento e duracoes reais conferidos');
  } catch (error) {
    report.fail('verificacao da conversa interrompida', error);
  } finally {
    try { s.close?.(); } catch { /* ignore */ }
    await browser.close();
    await server.stop();
  }

  return report.summary();
}

run().then((r) => process.exit(r.failed > 0 ? 1 : 0)).catch((e) => {
  console.error('erro fatal:', e);
  process.exit(1);
});
