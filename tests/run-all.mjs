/**
 * Runner de todos os suites de teste.
 *
 *   node tests/run-all.mjs            executa tudo
 *   node tests/run-all.mjs api        executa apenas os que casam com "api"
 *   node tests/run-all.mjs --no-browser  pula os testes de navegador
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../server/config.js';

const SUITES = [
  { id: 'api', file: 'api-flow.test.mjs', title: 'Fluxo da API', browsers: false },
  { id: 'security', file: 'security.test.mjs', title: 'Seguranca', browsers: false },
  { id: 'realtime', file: 'realtime.test.mjs', title: 'Realtime', browsers: false },
  { id: 'live', file: 'live.test.mjs', title: 'LIVE', browsers: false },
  { id: 'media', file: 'media.test.mjs', title: 'Midia e storage', browsers: false },
  { id: 'admin', file: 'admin.test.mjs', title: 'Admin, moderacao e push', browsers: false },
  { id: 'admin-realtime', file: 'admin-realtime.test.mjs', title: 'Painel administrativo em tempo real', browsers: false },
  { id: 'live-viewer', file: 'live-viewer.test.mjs', title: 'Espectador da LIVE, layout e TURN/ICE', browsers: false },
  { id: 'browser', file: 'browser.test.mjs', title: 'Navegador (Chrome headless)', browsers: true },
];

const args = process.argv.slice(2);
const filters = args.filter((a) => !a.startsWith('--'));
const skipBrowser = args.includes('--no-browser');

function run(suite) {
  return new Promise((resolve) => {
    const file = path.join(ROOT, 'tests', suite.file);
    if (!existsSync(file)) {
      console.log(`\n=== ${suite.title}: arquivo ausente (${suite.file}) ===`);
      resolve({ id: suite.id, passed: 0, failed: 0, skipped: true });
      return;
    }
    console.log(`\n${'='.repeat(70)}\n=== ${suite.title}\n${'='.repeat(70)}`);
    const child = spawn(process.execPath, [file], { cwd: ROOT, stdio: 'inherit', windowsHide: true });
    child.on('exit', (code) => resolve({ id: suite.id, code: code ?? 1 }));
  });
}

const selected = SUITES.filter((suite) => {
  if (skipBrowser && suite.browsers) return false;
  if (!filters.length) return true;
  return filters.some((f) => suite.id.includes(f) || suite.title.toLowerCase().includes(f.toLowerCase()));
});

console.log(`Executando ${selected.length} suite(s): ${selected.map((s) => s.id).join(', ')}`);

const results = [];
for (const suite of selected) {
  // Suites rodam em sequencia: cada uma sobe seu proprio servidor e banco.
  // eslint-disable-next-line no-await-in-loop
  results.push(await run(suite));
}

console.log(`\n${'#'.repeat(70)}\n# RESUMO\n${'#'.repeat(70)}`);
let failures = 0;
for (const result of results) {
  if (result.skipped) {
    console.log(`  ${result.id.padEnd(10)} (nao existe)`);
    continue;
  }
  const status = result.code === 0 ? 'OK' : 'FALHOU';
  if (result.code !== 0) failures += 1;
  console.log(`  ${result.id.padEnd(10)} ${status}`);
}
console.log(`\n${failures === 0 ? 'TODOS OS SUITES PASSARAM' : `${failures} suite(s) com falha`}`);
process.exit(failures === 0 ? 0 : 1);