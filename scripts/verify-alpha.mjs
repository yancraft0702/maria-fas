/**
 * Verifica o ALFA REAL de um arquivo de efeito em `storage/effects/`.
 *
 * Uso: node scripts/verify-alpha.mjs [nome-do-arquivo]
 * Sem argumento, usa o primeiro arquivo encontrado.
 *
 * O pipeline atual grava APNG animado (imagem com canal alfa). O script
 * mede o alfa decodificado - nao confia no nome do arquivo nem no metadata.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import ffmpegPath from 'ffmpeg-static';

const DIR = path.resolve('storage/effects');
const arquivos = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((f) => !f.startsWith('.')) : [];
if (!arquivos.length) {
  console.log('Nenhum arquivo em storage/effects/. Rode o servidor para preparar os efeitos.');
  process.exit(0);
}

const alvo = process.argv[2] || arquivos[0];
const src = path.join(DIR, alvo);
const bytes = fs.readFileSync(src);
const assinatura = bytes.subarray(0, 8).toString('hex');
console.log(`arquivo: ${alvo} (${(bytes.length / 1024).toFixed(0)} KB)`);
console.log(`assinatura: ${assinatura}`);
console.log(`formato: ${assinatura.startsWith('89504e47') ? 'PNG/APNG' : assinatura.startsWith('1a45dfa3') ? 'WebM/Matroska' : 'desconhecido'}`);
console.log(`animado (chunk acTL): ${bytes.includes(Buffer.from('acTL', 'ascii'))}`);

const r = spawnSync(ffmpegPath, ['-hide_banner', '-i', src], { encoding: 'utf8', windowsHide: true });
console.log('=== banner ===');
console.log(String(r.stderr).split('\n').filter((l) => /Stream|Duration|Input/.test(l)).join('\n'));

const r2 = spawnSync(ffmpegPath, [
  '-hide_banner', '-v', 'error', '-i', src, '-vf', 'format=rgba', '-frames:v', '3',
  '-f', 'rawvideo', '-pix_fmt', 'rgba', '-',
], { windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
const data = r2.stdout;
if (!data || data.length < 4096) {
  console.log('  sem pixels RGBA extraidos');
  process.exit(1);
}

let opaco = 0;
let transparente = 0;
for (let i = 3; i < data.length; i += 4) {
  if (data[i] > 200) opaco += 1;
  else if (data[i] < 40) transparente += 1;
}
const total = Math.floor(data.length / 4);
const pctTransp = (100 * transparente) / total;
const pctOpaco = (100 * opaco) / total;
console.log(`  canais: ${total} pixels | transparentes ${pctTransp.toFixed(1)}% | opacos ${pctOpaco.toFixed(1)}%`);

// Fundo removido E assunto preservado: os dois lados precisam existir.
if (pctTransp > 15 && pctOpaco > 2) {
  console.log('RESULTADO: ALFA REAL CONFIRMADO (fundo removido e assunto visivel)');
} else if (pctTransp <= 15) {
  console.log('RESULTADO: sem transparencia util (o fundo continua opaco)');
} else {
  console.log('RESULTADO: tudo transparente (o assunto foi apagado)');
  process.exit(1);
}
