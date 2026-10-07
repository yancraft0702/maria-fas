/**
 * Editor /criar (item 15): grade responsiva de ferramentas, controles
 * principais visiveis e header compacto. Medido em mobile e desktop.
 */
import { startServer, Client, Report, randomUsername, sleep } from '../tests/helpers.mjs';
import { launchChrome } from '../tests/cdp.mjs';

const report = new Report('Editor /criar: grade e controles');
const server = await startServer();
const cli = new Client(server.baseUrl);
const user = await cli.register({ username: randomUsername('ed') });

const browser = await launchChrome();

async function sessao(width, height, mobile) {
  const s = await browser.newBrowserContext();
  s.watch();
  await s.goto(`${server.baseUrl}/`, { waitMs: 300 });
  const r = await fetch(`${server.baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: user.username, password: 'Senha@Teste123' }),
  });
  for (const ck of r.headers.getSetCookie()) {
    const pair = ck.split(';')[0];
    const n = pair.split('=')[0];
    await s.send('Network.setCookie', { name: n, value: decodeURIComponent(pair.slice(n.length + 1)), domain: '127.0.0.1', path: '/' });
  }
  await s.send('Network.setCacheDisabled', { cacheDisabled: true });
  await s.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
  await s.goto(`${server.baseUrl}/criar`, { waitMs: 2500 });
  return s;
}

/** Mede a grade de ferramentas. */
const medir = (s) => s.eval(`
  const painel = document.querySelector('.editor-tools, .ed-tools, .tools');
  const botoes = painel
    ? [...painel.querySelectorAll('button')]
    : [];
  const boxes = botoes.map((b) => b.getBoundingClientRect());
  const larguras = [...new Set(boxes.map((x) => Math.round(x.width)))];
  const alturas = [...new Set(boxes.map((x) => Math.round(x.height)))];
  const vw = document.documentElement.clientWidth;
  const fora = boxes.filter((x) => x.right > vw + 1 || x.left < -1).length;
  const semNome = botoes.filter((b) => !b.getAttribute('aria-label') && !b.title).length;
  const semIcone = botoes.filter((b) => !b.querySelector('svg, img')).length;
  const paineis = document.querySelectorAll('.editor-tools *').length;

  // Controles principais: precisam estar presentes e visiveis sem rolar.
  const principal = [...document.querySelectorAll('button, .btn')]
    .filter((b) => /Gravar|REC|Publicar/i.test(b.textContent || ''))
    // Instancias de 0x0 sao botoes de painel fechado: nao contam.
    .filter((b) => b.getBoundingClientRect().width > 0);
  const principalBoxes = principal.map((b) => {
    const r = b.getBoundingClientRect();
    return { txt: (b.textContent || '').trim().slice(0, 12), visivel: r.bottom <= window.innerHeight + 1 && r.top >= 0 };
  });

  const header = document.querySelector('.editor .topbar');
  return {
    painelExiste: Boolean(painel),
    ferramentas: botoes.length,
    colunas: painel ? getComputedStyle(painel).gridTemplateColumns.split(' ').length : 0,
    display: painel ? getComputedStyle(painel).display : null,
    larguras,
    alturas,
    fora,
    semNome,
    semIcone,
    scrollHorizontal: (painel?.scrollWidth || 0) - (painel?.clientWidth || 0),
    overflowPagina: document.documentElement.scrollWidth - vw,
    principal: principalBoxes,
    alturaHeader: header ? Math.round(header.getBoundingClientRect().height) : null,
    paineis,
  };
`);

try {
  for (const [largura, altura, mobile, nome] of [[320, 700, true, '320px'], [390, 844, true, '390px'], [430, 932, true, '430px'], [768, 1024, false, '768px'], [1440, 900, false, '1440px']]) {
    // eslint-disable-next-line no-await-in-loop
    const s = await sessao(largura, altura, mobile);
    // eslint-disable-next-line no-await-in-loop
    await report.step(`editor em ${nome}: grade de ferramentas consistente e sem overflow`, async () => {
      const st = await medir(s);
      if (!st.painelExiste) throw new Error('painel de ferramentas nao encontrado');
      if (st.ferramentas < 10) throw new Error(`poucas ferramentas: ${st.ferramentas}`);
      if (st.display !== 'grid') throw new Error(`ferramentas em "${st.display}", esperado grid`);
      if (st.colunas < 2) throw new Error(`grade com ${st.colunas} coluna(s) em ${nome}`);
      if (st.scrollHorizontal > 1) throw new Error(`scroll horizontal na grade: ${st.scrollHorizontal}px`);
      if (st.overflowPagina > 1) throw new Error(`scroll horizontal na pagina: ${st.overflowPagina}px`);
      if (st.fora > 0) throw new Error(`${st.fora} ferramenta(s) fora da viewport`);
      if (st.semIcone > 0) throw new Error(`${st.semIcone} ferramenta(s) sem icone`);
      if (st.semNome > 0) throw new Error(`${st.semNome} ferramenta(s) sem nome acessível`);
      if (st.alturas.length > 2) throw new Error(`alturas irregulares: ${st.alturas.join(',')}`);
      if (st.larguras.length > 2) throw new Error(`larguras irregulares: ${st.larguras.join(',')}`);
      const min = Math.min(...st.alturas);
      if (min < 40) throw new Error(`ferramentas com ${min}px de altura (area de toque pequena)`);
      return `${st.ferramentas} ferramentas em ${st.colunas} colunas, ${st.larguras[0]}x${st.alturas[0]}px, header ${st.alturaHeader}px`;
    });

    // eslint-disable-next-line no-await-in-loop
    await report.step(`editor em ${nome}: GRAVAR e PUBLICAR visiveis, sem barra gigante`, async () => {
      const st = await medir(s);
      const textos = st.principal.map((p) => p.txt);
      if (!textos.some((t) => /Gravar|REC/i.test(t))) throw new Error(`botao de gravar ausente (${textos.join(', ')})`);
      if (!textos.some((t) => /Publicar/i.test(t))) throw new Error(`botao de publicar ausente (${textos.join(', ')})`);
      const escondidos = st.principal.filter((p) => !p.visivel);
      if (escondidos.length) {
        const caixas = await s.eval(`
          return [...document.querySelectorAll('button, .btn')]
            .filter((b) => /Gravar|REC|Publicar/i.test(b.textContent || ''))
            .map((b) => {
              const r = b.getBoundingClientRect();
              return { txt: (b.textContent || '').trim().slice(0, 12), top: Math.round(r.top), bottom: Math.round(r.bottom), w: Math.round(r.width), vh: window.innerHeight };
            });
        `);
        throw new Error(`${escondidos.length} controle(s) fora da tela: ${escondidos.map((p) => p.txt).join(', ')}; caixas=${JSON.stringify(caixas)}`);
      }
      if (st.alturaHeader && st.alturaHeader > 120) throw new Error(`header gigante: ${st.alturaHeader}px`);
      return `controles visiveis: ${textos.join(' | ')}; header ${st.alturaHeader}px`;
    });
    await s.close?.();
  }

  // Foto/texto: os fluxos novos do menu de criacao (item 9) tambem no editor?
  await report.step('erros de console nas telas do editor', async () => {
    const s = await sessao(390, 844, true);
    await sleep(1500);
    const erros = s.consoleErrors.filter((e) => !/favicon|ERR_ABORTED|net::ERR/i.test(e));
    if (erros.length) throw new Error(erros.slice(0, 2).join(' | '));
    return `${erros.length} erro(s)`;
  });
} catch (err) {
  report.fail('erro inesperado', err);
}

const resumo = report.summary();
await browser.close();
await server.stop();
process.exit(resumo.failed > 0 ? 1 : 0);
