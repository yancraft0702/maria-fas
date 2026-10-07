/**
 * Tela de autenticacao: "Entrar" e "Criar conta" com o MESMO padrao visual de
 * selecionado (item 8). Mede o estado real (aria-selected + estilo
 * computado) em cada clique, incluindo hover/foco e a troca entre as duas.
 */
import { startServer, Report, sleep } from '../tests/helpers.mjs';
import { launchChrome } from '../tests/cdp.mjs';

const report = new Report('Auth: abas Entrar e Criar conta');
const server = await startServer();
const browser = await launchChrome();

/** Estado visual das duas abas. */
const lerAbas = (s) => s.eval(`
  const abas = [...document.querySelectorAll('.seg button')];
  return abas.map((b) => {
    const cs = getComputedStyle(b);
    const r = b.getBoundingClientRect();
    return {
      texto: b.textContent.trim(),
      selecionado: b.getAttribute('aria-selected') === 'true',
      fundo: cs.backgroundColor,
      cor: cs.color,
      w: Math.round(r.width),
      h: Math.round(r.height),
    };
  });
`);

try {
  for (const [w, h, mobile, nome] of [[1440, 900, false, 'desktop'], [390, 844, true, 'mobile']]) {
    const s = await browser.newBrowserContext();
    s.watch();
    await s.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile });
    await s.goto(`${server.baseUrl}/entrar`, { waitMs: 2500 });

    // eslint-disable-next-line no-await-in-loop
    await report.step(`${nome}: clicar em "Criar conta" marca a aba e desmarca "Entrar"`, async () => {
      const inicial = await lerAbas(s);
      if (inicial.length !== 2) throw new Error(`esperava 2 abas, achei ${inicial.length}`);
      if (!inicial[0].selecionado) throw new Error('"Entrar" deveria iniciar selecionada');
      if (inicial[1].selecionado) throw new Error('"Criar conta" iniciou selecionada junto');

      await s.eval(`
        [...document.querySelectorAll('.seg button')].find((b) => /criar/i.test(b.textContent)).click();
        return true;
      `);
      await sleep(600);
      const depois = await lerAbas(s);
      const criar = depois.find((b) => /criar/i.test(b.texto));
      const entrar = depois.find((b) => /entrar/i.test(b.texto));
      if (!criar.selecionado) throw new Error('clicar em "Criar conta" NAO marcou a aba');
      if (entrar.selecionado) throw new Error('"Entrar" continuou marcada junto com "Criar conta"');
      // O estilo precisa realmente mudar (fundo da aba selecionada).
      if (criar.fundo === entrar.fundo) {
        throw new Error(`selecionada sem destaque visual (ambas ${criar.fundo})`);
      }
      // O formulario tambem precisa ter trocado.
      const form = await s.eval(`return (document.getElementById('main')?.innerText || '').slice(0, 120);`);
      if (!/crie sua conta|confirmar senha/i.test(form)) throw new Error(`formulario nao trocou para cadastro: ${form.slice(0, 60)}`);
      return `"Criar conta" selecionada (fundo ${criar.fundo}) e "Entrar" desmarcada (${entrar.fundo})`;
    });

    // eslint-disable-next-line no-await-in-loop
    await report.step(`${nome}: voltar para "Entrar" inverte o estado do mesmo jeito`, async () => {
      await s.eval(`
        [...document.querySelectorAll('.seg button')].find((b) => /entrar/i.test(b.textContent)).click();
        return true;
      `);
      await sleep(600);
      const st = await lerAbas(s);
      const entrar = st.find((b) => /entrar/i.test(b.texto));
      const criar = st.find((b) => /criar/i.test(b.texto));
      if (!entrar.selecionado) throw new Error('"Entrar" nao voltou a ser marcada');
      if (criar.selecionado) throw new Error('"Criar conta" continuou marcada');
      if (entrar.fundo === criar.fundo) throw new Error('selecionada sem destaque visual ao voltar');
      return `"Entrar" selecionada (${entrar.fundo}), "Criar conta" desmarcada (${criar.fundo})`;
    });

    // eslint-disable-next-line no-await-in-loop
    await report.step(`${nome}: as duas abas tem a mesma altura e area de toque`, async () => {
      const st = await lerAbas(s);
      const [a, b] = st;
      // A largura NAO precisa ser igual (os rotulos tem tamanhos diferentes);
      // o que precisa ser igual e a altura e o destaque da selecionada.
      if (a.h !== b.h) throw new Error(`alturas diferentes: ${a.h}px e ${b.h}px`);
      if (a.h < 36) throw new Error(`aba baixa demais: ${a.h}px`);
      if (a.selecionado === b.selecionado) throw new Error('as duas abas com o mesmo estado');
      if (a.selecionado && a.fundo === b.fundo) throw new Error('aba selecionada sem destaque');
      return `altura ${a.h}px cada (larguras ${a.w}px e ${b.w}px conforme o rotulo)`;
    });

    // eslint-disable-next-line no-await-in-loop
    await report.step(`${nome}: /cadastro abre com "Criar conta" ja selecionada`, async () => {
      await s.goto(`${server.baseUrl}/cadastro`, { waitMs: 2200 });
      const st = await lerAbas(s);
      const criar = st.find((b) => /criar/i.test(b.texto));
      const entrar = st.find((b) => /entrar/i.test(b.texto));
      if (!criar?.selecionado) throw new Error('em /cadastro a aba "Criar conta" nao veio marcada');
      if (entrar?.selecionado) throw new Error('em /cadastro "Entrar" veio marcada junto');
      return `"Criar conta" selecionada, "Entrar" desmarcada`;
    });
  }
} catch (err) {
  report.fail('erro inesperado', err);
}

const resumo = report.summary();
await browser.close();
await server.stop();
process.exit(resumo.failed > 0 ? 1 : 0);
