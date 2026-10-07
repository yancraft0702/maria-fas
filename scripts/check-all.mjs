/**
 * Executa TODAS as verificacoes estaticas do projeto.
 *
 *   node scripts/check-all.mjs
 *
 * Cada checker e focado numa classe de bug que quebra o boot em runtime:
 *  - sintaxe inválida
 *  - import { spawn } de caminho inexistente
 *  - import nomeado que o modulo nao exporta
 *  - parametros duplicados/colidindo em chamada
 *  - parametros SQL divergentes da SQL (ordem/nomes)
 *  - codigo morto, marcadores pendentes e segredos no frontend
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const CHECKS = [
  { id: 'sintaxe', script: 'check-syntax.mjs' },
  { id: 'imports', script: 'check-imports.mjs' },
  { id: 'exports', script: 'check-exports.mjs' },
  { id: 'params', script: 'check-params.mjs' },
  { id: 'sql-params', script: 'check-sql-params.mjs' },
  { id: 'codigo morto', script: 'check-dead-code.mjs' },
];

function run(check) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts', check.script)], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    child.on('exit', (code) => resolve({ ...check, code: code ?? 1, out: out.trim() }));
  });
}

console.log('Verificacoes estaticas\n');
const results = [];
for (const check of CHECKS) {
  // eslint-disable-next-line no-await-in-loop
  const result = await run(check);
  results.push(result);
  const label = result.code === 0 ? 'OK  ' : 'FALHA';
  console.log(`[${label}] ${result.id}`);
  if (result.code !== 0) console.log(result.out.split('\n').map((l) => `         ${l}`).join('\n'));
}

const failed = results.filter((r) => r.code !== 0);
console.log(
  failed.length === 0
    ? `\n${results.length} verificacao(oes): todas OK`
    : `\n${failed.length} de ${results.length} verificacao(oes) falharam`,
);
process.exit(failed.length === 0 ? 0 : 1);