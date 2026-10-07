/**
 * ITEM 5 (composicao) - o efeito tem de caber no QUADRO VISIVEL do video.
 *
 * Com `object-fit: contain` (que o item 5 introduz), a caixa do elemento
 * <video> e maior que o desenho: o quadro fica centralizado com tarja preta.
 * Se a area do efeito for medida pela caixa do elemento, ele aparece partly
 * fora do video - foi o que a tela mostrou (o corpo da guitarra cortando a
 * borda inferior do desenho).
 *
 * Este verificador mede o retangulo do quadro visivel (o mesmo calculo de
 * object-fit: contain) e exige que o efeito esteja DENTRO dele.
 */
import {
  startServer, Client, Report, sleep, randomUsername,
} from '../tests/helpers.mjs';
import { launchChrome } from '../tests/cdp.mjs';

const report = new Report('LIVE: efeito dentro do quadro visivel do video');

const CENARIOS = [
  [390, 844, true, 'celular'],
  [1280, 900, false, 'desktop'],
  [1920, 1080, false, 'desktop 1080p'],
];

async function run() {
  const server = await startServer();
  const browser = await launchChrome({
    extraArgs: [
      '--autoplay-policy=no-user-gesture-required',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
    ],
  });
  const telas = [];
  try {
    for (const [w, h, mobile, rotulo] of CENARIOS) {
      const api = new Client(server.baseUrl);
      const user = await api.register({ username: randomUsername('cam') });
      const cookies = await fetch(`${server.baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: user.username, password: 'Senha@Teste123' }),
      }).then((r) => r.headers.getSetCookie());

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
      await s.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile });
      await s.goto(`${server.baseUrl}/iniciar-live`, { waitMs: 2600 });
      const inicio = await s.eval(`
        const b = [...document.querySelectorAll('button')].find((x) => /iniciar transmissao/i.test(x.textContent || ''));
        if (!b) return 'sem botao';
        b.click();
        return 'clicou';
      `);
      if (inicio !== 'clicou') throw new Error(`${w}x${h}: ${inicio}`);
      await sleep(6000);

      const sala = (await api.get(`/api/users/${user.id}/live`)).body.live;
      if (!sala?.id) throw new Error(`${w}x${h}: a LIVE nao subiu`);
      const catalogo = await api.get('/api/live/effects');
      const efeitos = (catalogo.body.effects || []).filter((e) => e.mediaUrl);

      // Dispara varios para pegar os efeitos de posicao e escala diferentes.
      const medidos = [];
      for (const efeito of efeitos.filter((e) => e.scale >= 0.9).slice(0, 4)) {
        // eslint-disable-next-line no-await-in-loop
        const r = await s.eval(`
          const csrf = (document.cookie.split(';').find((c) => c.trim().startsWith('pulse_csrf=')) || '').split('=')[1] || '';
          const resp = await fetch('/api/live/${sala.id}/effects', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': decodeURIComponent(csrf) },
            body: JSON.stringify({ effectId: ${JSON.stringify(efeito.id)}, clientEventId: 'quadro-${efeito.slug}-${Date.now()}' }),
          });
          return resp.status;
        `);
        if (r >= 400) throw new Error(`${w}x${h} ${efeito.slug}: recusado (${r})`);
        // eslint-disable-next-line no-await-in-loop
        await sleep(1800);

        // eslint-disable-next-line no-await-in-loop
        const m = await s.eval(`
          const video = document.querySelector('.live-video-wrap video');
          const inst = [...document.querySelectorAll('.effect-instance')];
          const ultimo = inst[inst.length - 1];
          if (!video || !ultimo) return null;
          const cs = getComputedStyle(video);
          const caixa = video.getBoundingClientRect();
          // Mesmo calculo de object-fit: contain: o quadro visivel.
          let q = { left: caixa.left, top: caixa.top, right: caixa.right, bottom: caixa.bottom };
          if (cs.objectFit === 'contain' && video.videoWidth && video.videoHeight) {
            const k = Math.min(caixa.width / video.videoWidth, caixa.height / video.videoHeight);
            const lw = video.videoWidth * k;
            const alt = video.videoHeight * k;
            const esq = caixa.left + (caixa.width - lw) / 2;
            const topo = caixa.top + (caixa.height - alt) / 2;
            q = { left: esq, top: topo, right: esq + lw, bottom: topo + alt };
          }
          const e = ultimo.getBoundingClientRect();
          const folga = Math.round(1.5);
          return {
            slug: ultimo.dataset.effectId,
            quadro: [Math.round(q.left), Math.round(q.top), Math.round(q.right - q.left), Math.round(q.bottom - q.top)],
            elemento: [Math.round(e.left), Math.round(e.top), Math.round(e.width), Math.round(e.height)],
            dentro: e.left >= q.left - folga && e.top >= q.top - folga
              && e.right <= q.right + folga && e.bottom <= q.bottom + folga,
            objectFit: cs.objectFit,
            rotulo: (ultimo.textContent || '').trim().slice(0, 24),
          };
        `);
        if (!m) throw new Error(`${w}x${h}: efeito "${efeito.slug}" nao apareceu`);
        medidos.push(m);
        if (!m.dentro) {
          throw new Error(`${w}x${h} (${rotulo}): o efeito "${efeito.slug}" saiu do quadro `
            + `visivel do video - elemento ${JSON.stringify(m.elemento)} vs quadro ${JSON.stringify(m.quadro)} `
            + `(object-fit ${m.objectFit})`);
        }
      }
      report.ok(`${w}x${h} (${rotulo}): ${medidos.length} efeito(s) de escala alta dentro do quadro `
        + `visivel (ex.: ${medidos[0].elemento.join(',')} em ${medidos[0].quadro.join(',')}, `
        + `object-fit ${medidos[0].objectFit})`);

      await s.eval(`
        const id = ${JSON.stringify(sala.id)};
        document.body.click();
        return true;
      `).catch(() => {});
      const fim = await api.post(`/api/live/${sala.id}/end`, {});
      if (fim.status >= 400 && fim.status !== 404) {
        throw new Error(`${w}x${h}: nao encerrou a LIVE (${fim.status})`);
      }
      await sleep(600);
    }
    report.ok('todo efeito cabe no quadro visivel do video, sem tarja e sem corte');
  } catch (error) {
    report.fail('verificacao interrompida', error);
  } finally {
    for (const s of telas) { try { s.close?.(); } catch { /* ignore */ } }
    await browser.close();
    await server.stop();
  }
  return report.summary();
}

run().then((r) => process.exit(r.failed > 0 ? 1 : 0)).catch((e) => { console.error(e); process.exit(1); });