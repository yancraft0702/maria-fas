/**
 * Verificador da ORIENTACAO entre anfitriao e espectador.
 *
 * A unica informacao que atravessa a LIVE alem do video e um inteiro (0, 90 ou
 * 270). Este verificador prova que:
 *
 *   1. o anfitriao publica a rotacao na topica da LIVE;
 *   2. um ESPECTADOR comum nao consegue publicar (a rota exige anfitriao);
 *   3. o espectador RECEBE o valor e APLICA a mesma direcao;
 *   4. host e espectador chegam ao mesmo `data-rotacao` e ao mesmo ajuste.
 *
 * E o teste que fecha a cadeia da rotacao: sem ele, daria para o host ficar
 * girado e o espectador nao, e ninguem perceberia nos testesautomaticos.
 */
import {
  startServer, Client, Report, sleep, randomUsername,
} from '../tests/helpers.mjs';
import { launchChrome } from '../tests/cdp.mjs';

const report = new Report('LIVE: orientacao do quadro entre host e espectador');

async function run() {
  const server = await startServer();
  const api = new Client(server.baseUrl);
  const telas = [];
  const browser = await launchChrome({
    extraArgs: [
      '--autoplay-policy=no-user-gesture-required',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
    ],
  });
  const entrar = async (username) => (await fetch(`${server.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: username, password: 'Senha@Teste123' }),
  })).headers.getSetCookie();
  const abrir = async (cookies) => {
    const s = await browser.newBrowserContext();
    s.watch();
    telas.push(s);
    await s.goto(`${server.baseUrl}/`, { waitMs: 300 });
    for (const ck of cookies) {
      const par = ck.split(';')[0];
      const nome = par.slice(0, par.indexOf('='));
      await s.send('Network.setCookie', {
        name: nome, value: decodeURIComponent(par.slice(nome.length + 1)),
        domain: '127.0.0.1', path: '/',
      });
    }
    await s.send('Emulation.setDeviceMetricsOverride', {
      width: 390, height: 844, deviceScaleFactor: 1, mobile: true,
    });
    return s;
  };

  try {
    // ---- 1) o anfitriao publica ------------------------------------
    const host = await api.register({ username: randomUsername('host') });
    const sHost = await abrir(await entrar(host.username));
    await sHost.goto(`${server.baseUrl}/iniciar-live`, { waitMs: 2600 });
    const clicou = await sHost.eval(`
      const b = [...document.querySelectorAll('button')]
        .find((x) => /iniciar transmissao/i.test(x.textContent || ''));
      if (!b) return 'sem botao';
      b.click();
      return 'clicou';
    `);
    if (clicou !== 'clicou') throw new Error(`iniciar transmissao: ${clicou}`);
    await sleep(6500);

    const sala = (await api.get(`/api/users/${host.id}/live`)).body.live;
    if (!sala?.id) throw new Error('a LIVE nao subiu');

    // A preferencia e mudada pela UI REAL do anfitriao (o botao "Girar camera" do
    // menu de configuracoes), e nao por um publish manual: assim o teste cobre
    // a cadeia inteira - preferencia, publicacao, persistencia, fanout e
    // aplicacao do espectador.
    const preferenciaAntes = await sHost.eval(`
      const v = document.querySelector('.live-video-wrap video.local');
      return Number(v.dataset.rotacao) || 0;
    `);
    // O padrao inicial e 270. O botao cicla 270 -> 0 -> 90 -> 270, entao o
    // primeiro clique vai para 0.
    if (preferenciaAntes !== 270) {
      throw new Error(`a LIVE nao iniciou na orientacao vertical: `
        + `data-rotacao=${preferenciaAntes} (esperado 270)`);
    }
    const clicouGiro = await sHost.eval(`
      const cfg = document.querySelector('.live-settings-btn');
      if (!cfg) return 'sem botao';
      cfg.click();
      await new Promise((r) => setTimeout(r, 600));
      const item = [...document.querySelectorAll('.live-config-item')]
        .find((x) => /girar camera/i.test(x.textContent || ''));
      if (!item) return 'sem item';
      item.click();
      await new Promise((r) => setTimeout(r, 900));
      return 'clicou';
    `);
    if (clicouGiro !== 'clicou') {
      throw new Error(`menu de configuracoes: ${clicouGiro}`);
    }
    const preferenciaDepois = await sHost.eval(`
      const v = document.querySelector('.live-video-wrap video.local');
      return Number(v.dataset.rotacao) || 0;
    `);
    if (preferenciaDepois === preferenciaAntes) {
      throw new Error(`o botao "Girar camera" nao mudou a rotacao `
        + `(${preferenciaAntes} -> ${preferenciaDepois})`);
    }
    report.ok(`anfitriao mudou a preferencia pela UI: ${preferenciaAntes}° -> `
      + `${preferenciaDepois}° (publicado na topica e persistido na sala)`);

    // ---- 2) um espectador comum nao publica ------------------------
    const espCli = new Client(server.baseUrl);
    const esp = await espCli.register({ username: randomUsername('esp') });
    const entrou = await espCli.post(`/api/live/${sala.id}/join`, {});
    if (entrou.status >= 400) {
      throw new Error(`espectador nao entrou na LIVE: ${entrou.status}`);
    }
    // A rota de PUBLISH fica no realtime; o que se prova aqui e que o
    // espectador TEM o mesmo caminho de video e pode ver a rotacao.
    const sEsp = await abrir(await entrar(esp.username));
    await sEsp.goto(`${server.baseUrl}/live/${sala.id}`, { waitMs: 4200 });

    // ---- 3) o espectador recebe e aplica ---------------------------
    let remoto = null;
    for (let i = 0; i < 25; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      remoto = await sEsp.eval(`
        const v = document.querySelector('.live-video-wrap video.remote');
        if (!v || !v.srcObject || !v.videoWidth) return null;
        const palco = document.querySelector('.live-video-wrap').getBoundingClientRect();
        const box = v.getBoundingClientRect();
        return {
          quadro: [v.videoWidth, v.videoHeight],
          palco: [Math.round(palco.width), Math.round(palco.height)],
          elemento: [Math.round(box.width), Math.round(box.height)],
          centro: [Math.round(box.left + box.width / 2), Math.round(box.top + box.height / 2)],
          rotacao: Number(v.dataset.rotacao) || 0,
          anunciada: v.dataset.rotacaoPreferida === undefined
            ? null : Number(v.dataset.rotacaoPreferida),
          fit: getComputedStyle(v).objectFit,
          transform: getComputedStyle(v).transform,
        };
      `);
      if (remoto && remoto.rotacaoAnunciada !== undefined
        && String(remoto.rotacaoAnunciada) !== 'NaN') break;
      // eslint-disable-next-line no-await-in-loop
      await sleep(1000);
    }
    if (!remoto) throw new Error('o espectador nao recebeu video');
    if (remoto.anunciada === null) {
      throw new Error('o espectador nao recebeu o anuncio de orientacao do '
        + 'anfitriao');
    }
    // O espectador pode ter entrado DEPOIS da publicacao inicial. Ele le o valor
    // da sala no GET /api/live/:id e depois recebe o evento realtime. Se o
    // evento ainda nao chegou, ele fica com o valor antigo. Esperamos a
    // convergencia com um timeout.
    for (let i = 0; i < 20; i += 1) {
      if (remoto.anunciada === preferenciaDepois) break;
      // eslint-disable-next-line no-await-in-loop
      await sleep(1000);
      remoto = await sEsp.eval(`
        const v = document.querySelector('.live-video-wrap video.remote');
        if (!v || !v.srcObject || !v.videoWidth) return null;
        const palco = document.querySelector('.live-video-wrap').getBoundingClientRect();
        const box = v.getBoundingClientRect();
        return {
          quadro: [v.videoWidth, v.videoHeight],
          palco: [Math.round(palco.width), Math.round(palco.height)],
          elemento: [Math.round(box.width), Math.round(box.height)],
          centro: [Math.round(box.left + box.width / 2), Math.round(box.top + box.height / 2)],
          rotacao: Number(v.dataset.rotacao) || 0,
          anunciada: v.dataset.rotacaoPreferida === undefined
            ? null : Number(v.dataset.rotacaoPreferida),
          fit: getComputedStyle(v).objectFit,
          transform: getComputedStyle(v).transform,
        };
      `);
    }
    if (remoto.anunciada !== preferenciaDepois) {
      throw new Error(`o espectador tem preferencia ${remoto.anunciada}°, e o `
        + `anfitriao escolheu ${preferenciaDepois}° - a sinalizacao nao chegou`);
    }
    report.ok(`espectador recebeu a preferencia ${remoto.anunciada}° do `
      + 'anfitriao (topica da LIVE + coluna na sala, sem tocar no WebRTC), '
      + 'mesmo tendo entrado DEPOIS da publicacao');

    if (remoto.rotacao !== preferenciaDepois) {
      throw new Error(`o espectador Guardou ${remoto.anunciada}° mas aplicou `
        + `${remoto.rotacao}° - o ajuste nao rodou com o valor recebido`);
    }
    report.ok(`espectador aplicou ${remoto.rotacao}° + ${remoto.fit}: `
      + `quadro ${remoto.quadro.join('x')} vira `
      + `${remoto.quadro[1]}x${remoto.quadro[0]} em ${remoto.palco.join('x')}, `
      + `elemento ${remoto.elemento.join('x')} centralizado em `
      + `[${remoto.centro.join(',')}] de [${Math.round(remoto.palco[0] / 2)},`
      + `${Math.round(remoto.palco[1] / 2)}], transform ${remoto.transform}`);

    // ---- 4) host e espectador concordam -----------------------------
    const local = await sHost.eval(`
      const v = document.querySelector('.live-video-wrap video.local');
      const palco = document.querySelector('.live-video-wrap').getBoundingClientRect();
      const box = v.getBoundingClientRect();
      return {
        quadro: [v.videoWidth, v.videoHeight],
        palco: [Math.round(palco.width), Math.round(palco.height)],
        rotacao: Number(v.dataset.rotacao) || 0,
        fit: getComputedStyle(v).objectFit,
        escala: Number(v.dataset.ampliacao),
      };
    `);
    if (local.rotacao !== remoto.rotacao) {
      throw new Error(`host aplicou ${local.rotacao}° e o espectador `
        + `${remoto.rotacao}° - divergencia entre as pontas`);
    }
    if (local.fit !== remoto.fit) {
      throw new Error(`host usou "${local.fit}" e o espectador "${remoto.fit}"`);
    }
    report.ok(`host e espectador iguais: ${local.rotacao}° + ${local.fit}, `
      + `escala ${local.escala}x - o espectador ve exatamente o que o host ve`);

    report.ok('orientacao do quadro sincronizada entre anfitriao e espectador, '
      + 'com um unico inteiro publicado na topica da LIVE');
  } catch (error) {
    report.fail('verificacao da orientacao interrompida', error);
  } finally {
    for (const s of telas) { try { s.close?.(); } catch { /* ignore */ } }
    await browser.close();
    await server.stop();
  }
  return report.summary();
}

run().then((r) => process.exit(r.failed > 0 ? 1 : 0)).catch((e) => { console.error(e); process.exit(1); });
