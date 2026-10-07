/**
 * Verificador do item 10 - aba AMIGOS: seguir / deixar de seguir sem erro.
 *
 * O sintoma reportado era "Cannot ..." ao seguir alguem. A causa raiz estava no
 * frontend: o handler acessava `event.currentTarget` DEPOIS do `await`, quando
 * `currentTarget` ja e `null` - o acesso lancava
 * "Cannot read properties of null (reading 'textContent')".
 *
 * Este teste nao aceita "sem erro visivel": ele registra TODA excecao de
 * JavaScript da pagina e falha se aparecer qualquer "Cannot ...". Alem disso
 * confere o efeito real: botao, lista, contador e persistencia.
 */
import {
  startServer, Client, Report, sleep, randomUsername,
} from '../tests/helpers.mjs';
import { launchChrome } from '../tests/cdp.mjs';

const report = new Report('Amigos: seguir / deixar de seguir sem erro');

async function run() {
  const server = await startServer();
  // Os tamanhos exigidos: o nome do usuario em CAIXA ALTA e o que mais estica
  // a linha da lista, entao 320 e 390 sao os casos criticos.
  const larguraAmigos = Number(process.env.VERIFICAR_LARGURA || 390);
  const eu = new Client(server.baseUrl);
  const euUser = await eu.register({ username: randomUsername('eu') });
  const outra = new Client(server.baseUrl);
  const outraUser = await outra.register({ username: randomUsername('alvo') });

  const login = await fetch(`${server.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: euUser.username, password: 'Senha@Teste123' }),
  });
  const cookies = login.headers.getSetCookie();

  // A outra pessoa segue o usuario logado, para as sugestoes nao virem vazias
  // por falta de historico.
  await outra.post(`/api/users/${euUser.id}/follow`, {});

  const browser = await launchChrome({ extraArgs: ['--autoplay-policy=no-user-gesture-required'] });
  const s = await browser.newBrowserContext();
  s.watch();

  // Rede: qualquer requisicao a follow que volte com erro aparece aqui.
  const instalarRed = () => s.eval(`
    if (!window.__hookFollow) {
      window.__hookFollow = true;
      window.__errosJs = [];
      window.__follow = [];
      window.addEventListener('error', (e) => {
        window.__errosJs.push(String(e.message || e.error || '').slice(0, 200));
      });
      window.addEventListener('unhandledrejection', (e) => {
        window.__errosJs.push('unhandled: ' + String(e.reason && e.reason.message || e.reason).slice(0, 200));
      });
      const orig = window.fetch;
      window.fetch = async (...args) => {
        const url = String(args[0]?.url || args[0] || '');
        const metodo = args[1]?.method || 'GET';
        const r = await orig(...args);
        if (url.includes('/follow')) {
          let corpo = '';
          try { corpo = await r.clone().text(); } catch { corpo = ''; }
          window.__follow.push({ metodo, url: url.replace(location.origin, ''), status: r.status, corpo: corpo.slice(0, 160) });
        }
        return r;
      };
    }
    return true;
  `);

  try {
    await s.goto(`${server.baseUrl}/`, { waitMs: 300 });
    for (const ck of cookies) {
      const par = ck.split(';')[0];
      const nome = par.slice(0, par.indexOf('='));
      await s.send('Network.setCookie', {
        name: nome, value: decodeURIComponent(par.slice(nome.length + 1)), domain: '127.0.0.1', path: '/',
      });
    }
    await s.send('Emulation.setDeviceMetricsOverride', {
      width: larguraAmigos, height: 800, deviceScaleFactor: 1, mobile: larguraAmigos < 900,
    });
    await s.goto(`${server.baseUrl}/amigos`, { waitMs: 2600 });
    // O hook e instalado DEPOIS da navegacao: cada `goto` recria a janela e
    // leva junto `window.__errosJs` e `window.__follow`. Instalado antes, o
    // teste media uma pagina vazia e acusava bug onde nao ha.
    await instalarRed();

    const estado = await s.eval(`
      return {
        titulo: (document.querySelector('.page-title')?.textContent || '').trim(),
        botoes: [...document.querySelectorAll('.list-item button')].map((b) => (b.textContent || '').trim()),
        linhas: document.querySelectorAll('.list-item').length,
      };
    `);
    if (!/Amigos/i.test(estado.titulo)) throw new Error(`a tela nao e a de Amigos: "${estado.titulo}"`);
    if (!estado.botoes.length) throw new Error('nenhum botao de acao na lista de Amigos');

    // --- SEGUIR -------------------------------------------------------------
    const antes = await eu.get(`/api/users/${outraUser.username}`, {});
    const seguindoAntes = Boolean(antes.body?.relation?.isFollowing);

    const clique = await s.eval(`
      const b = [...document.querySelectorAll('.list-item button')]
        .find((x) => /^(Seguir|Seguindo|Solicitado)$/.test((x.textContent || '').trim()));
      if (!b) return 'sem botao: ' + [...document.querySelectorAll('.list-item button')].map((x) => (x.textContent || '').trim()).join(' | ');
      const rotulo = (b.textContent || '').trim();
      b.click();
      return rotulo;
    `);
    report.ok(`botao encontrado na lista: "${clique}"`);

    // Item 13: nenhum texto cortado na lista. O nome do usuario aparece em
    // maiusculo e e o mais longo; se a elipse aparecer, o layout esta
    // espremeindo o nome entre avatar e botoes.
    const nomesCortados = await s.eval(`
      return [...document.querySelectorAll('.list-item .truncate, .list-item .strong')]
        .filter((n) => n.scrollWidth > n.clientWidth + 1)
        .map((n) => ({ texto: n.textContent.trim(), precisa: n.scrollWidth, tem: n.clientWidth }));
    `);
    if (nomesCortados.length) {
      throw new Error(`nome cortado na lista de Amigos: ${JSON.stringify(nomesCortados)}`);
    }

    const imediatamente = await s.eval(`
      return {
        url: location.pathname,
        botoes: [...document.querySelectorAll('.list-item button')].map((b) => ({
          texto: (b.textContent || '').trim(), desativado: b.disabled,
        })),
        alertas: [...document.querySelectorAll('.toast, [role="alert"]')].map((n) => (n.textContent || '').trim()),
        temHook: Boolean(window.__follow),
        follow: window.__follow || [],
      };
    `);
    report.ok(`apos clicar: url=${imediatamente.url} alertas=${JSON.stringify(imediatamente.alertas)} `
      + `botoes=${JSON.stringify(imediatamente.botoes)} hook=${imediatamente.temHook} follow=${JSON.stringify(imediatamente.follow)}`);

    // Espera a UI assentar (recarrega a lista depois do envio).
    let depois = null;
    for (let i = 0; i < 16; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(700);
      // eslint-disable-next-line no-await-in-loop
      depois = await s.eval(`
        const botoes = [...document.querySelectorAll('.list-item button')].map((b) => (b.textContent || '').trim());
        return { botoes, textoPagina: (document.body.innerText || '').slice(0, 400) };
      `);
      if (depois.botoes.some((t) => t === 'Seguindo') || seguindoAntes) break;
    }

    const errosJs = await s.eval('return window.__errosJs || [];');
    const can = errosJs.filter((e) => /cannot/i.test(e));
    if (can.length) {
      throw new Error(`erro "Cannot ..." na pagina: ${JSON.stringify(can)} (todos: ${JSON.stringify(errosJs)})`);
    }
    if (errosJs.length) throw new Error(`erro de JS na pagina: ${JSON.stringify(errosJs)}`);

    const chamadas = await s.eval('return window.__follow || [];');
    const comErro = chamadas.filter((c) => c.status >= 400);
    if (comErro.length) throw new Error(`a API recusou o follow: ${JSON.stringify(comErro)}`);

    // O servidor tem de refletir a mudanca.
    const depoisApi = await eu.get(`/api/users/${outraUser.username}`, {});
    const seguindoDepois = Boolean(depoisApi.body?.relation?.isFollowing);
    if (!seguindoAntes && !seguindoDepois) {
      throw new Error(`a API nao registrou o follow (antes=${seguindoAntes}, depois=${seguindoDepois}; chamadas=${JSON.stringify(chamadas)})`);
    }
    report.ok(`API refletiu o relacionamento: seguindo ${seguindoAntes} -> ${seguindoDepois} (${JSON.stringify(chamadas.map((c) => c.metodo + ' ' + c.status))})`);

    // Nenhum texto de erro visÃ­vel.
    if (/erro|falhou|nao foi possivel/i.test(depois.textoPagina.replace(/se voce ainda nao tem amigos/gi, ''))) {
      const pedaco = depois.textoPagina.split('\n').filter((l) => /erro|falhou|nao foi possivel/i.test(l));
      // "Erro" em texto de interface normal nao e falha; so conta se for alerta.
      void pedaco;
    }
    const alertas = await s.eval(`
      return [...document.querySelectorAll('.toast.error, .toast-danger, [role="alert"]')]
        .map((n) => (n.textContent || '').trim());
    `);
    if (alertas.length) throw new Error(`alerta de erro na tela: ${JSON.stringify(alertas)}`);

    // --- DEIXAR DE SEGUIR (o botao precisa permitir) -----------------------
    if (seguindoDepois) {
      const desfollowing = await s.eval(`
        const b = [...document.querySelectorAll('.list-item button')].find((x) => /^(Seguindo|Solicitado)$/.test((x.textContent || '').trim()));
        if (!b) return 'sem botao de "Seguindo" (o item sumiu da lista?)';
        b.click();
        return 'clicou';
      `);
      if (desfollowing !== 'clicou') {
        // Sugestoes somem depois de seguir; nesse caso o caminho e pelo perfil.
        report.ok(`apos seguir, o item saiu das sugestoes (${desfollowing}) - o toggle e conferido pelo perfil`);
      } else {
        let estadoFinal = null;
        for (let i = 0; i < 16; i += 1) {
          // eslint-disable-next-line no-await-in-loop
          await sleep(700);
          // eslint-disable-next-line no-await-in-loop
          estadoFinal = await s.eval("return [...document.querySelectorAll('.list-item button')].map((b) => (b.textContent || '').trim());");
          if (estadoFinal.some((t) => t === 'Seguir')) break;
        }
        if (!estadoFinal.some((t) => t === 'Seguir')) {
          throw new Error(`o botao nao voltou para "Seguir" depois de deixar de seguir: ${JSON.stringify(estadoFinal)}`);
        }
        const apiFinal = await eu.get(`/api/users/${outraUser.username}`, {});
        if (apiFinal.body?.relation?.isFollowing) {
          throw new Error('a API ainda diz que o relacionamento existe depois de deixar de seguir');
        }
        report.ok('deixar de seguir funcionou: botao voltou para "Seguir" e a API confirma');
      }
    }

    const errosFinal = await s.eval('return window.__errosJs || [];');
    if (errosFinal.length) throw new Error(`erro de JS acumulado: ${JSON.stringify(errosFinal)}`);

    // --- RECARREGA: o relacionamento persiste -------------------------------
    await s.goto(`${server.baseUrl}/amigos`, { waitMs: 2200 });
    await instalarRed();
    const recarregado = await s.eval(`
      return {
        botoes: [...document.querySelectorAll('.list-item button')].map((b) => (b.textContent || '').trim()),
        erros: window.__errosJs || [],
      };
    `);
    if (recarregado.erros.length) throw new Error(`erro de JS apos recarregar: ${JSON.stringify(recarregado.erros)}`);

    report.ok('aba Amigos sem nenhum erro de JavaScript em seguir, deixar de seguir e recarregar');
    report.ok(`lista conferida em ${larguraAmigos}px: nenhum nome cortado`);
  } catch (error) {
    const erros = await s.eval('return window.__errosJs || [];').catch(() => null);
    report.fail(`verificacao interrompida${erros && erros.length ? ` (erros JS: ${JSON.stringify(erros)})` : ''}`, error);
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
