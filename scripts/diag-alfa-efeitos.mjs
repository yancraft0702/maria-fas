/**
 * Diagnostico do alfa: compara os quadros de ORIGEM (rasterizados em Node)
 * com o APNG final (codificado pelo ffmpeg).
 *
 * Sintoma medido: varios efeitos tem ~0% de pixel totalmente opaco e poucos
 * percentuaissemi-transparentes. Isso tem duas causas possiveis, bem diferentes:
 *  - o DESENHO produz alpha parcial (falha do `mistura`);
 *  - o DESENHO esta correto e o ENCODER APNG esta alterando o alpha.
 *
 * Este script separa as duas, motivo a motivo (histograma de alpha).
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ROOT } from '../server/config.js';
import { findFfmpeg } from '../server/media/pipeline.js';

const run = promisify(execFile);
const DIR = path.resolve(ROOT, 'anima\u00e7\u00e3o');
const TMP = path.resolve(ROOT, 'data', '.tmp-diag-alfa');

function lerPng(arquivo) {
  const buf = fs.readFileSync(arquivo);
  let p = 8;
  let w = 0; let h = 0;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const tipo = buf.toString('ascii', p + 4, p + 8);
    const dados = buf.subarray(p + 8, p + 8 + len);
    if (tipo === 'IHDR') { w = dados.readUInt32BE(0); h = dados.readUInt32BE(4); }
    else if (tipo === 'IDAT') idat.push(dados);
    else if (tipo === 'IEND') break;
    p += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const px = Buffer.alloc(w * h * 4);
  const porLinha = 1 + w * 4;
  for (let y = 0; y < h; y += 1) {
    raw.copy(px, y * w * 4, y * porLinha + 1, y * porLinha + porLinha);
  }
  return { w, h, px };
}

function histograma({ w, h, px }) {
  const faixas = [0, 0, 0, 0, 0]; // 0, 1-15, 16-200, 201-254, 255
  for (let i = 0; i < w * h; i += 1) {
    const a = px[i * 4 + 3];
    if (a === 0) faixas[0] += 1;
    else if (a < 16) faixas[1] += 1;
    else if (a < 201) faixas[2] += 1;
    else if (a < 255) faixas[3] += 1;
    else faixas[4] += 1;
  }
  const total = w * h;
  return faixas.map((n) => `${((n / total) * 100).toFixed(1)}%`).join(' / ');
}

const alvos = process.argv.slice(2);
if (!alvos.length) {
  console.log('uso: node scripts/diag-alfa-efeitos.mjs <slug> [...]');
  process.exit(1);
}

await fsp.rm(TMP, { recursive: true, force: true });
await fsp.mkdir(TMP, { recursive: true });
const ffmpeg = await findFfmpeg();

for (const slug of alvos) {
  const apng = path.join(DIR, `${slug}.png`);
  if (!fs.existsSync(apng)) {
    console.log(`${slug}: sem arquivo`);
    continue;
  }
  // Quadro 1 do APNG, extraido como PNG independente.
  const quadro = path.join(TMP, `${slug}-f1.png`);
  await run(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-i', apng, '-frames:v', '1', quadro,
  ], { windowsHide: true, maxBuffer: 32 * 1024 * 1024 });

  const origem = lerPng(quadro);
  const m = lerPng(apng);
  console.log(`\n${slug}`);
  console.log(`  APNG       ${m.w}x${m.h}  alfa 0 / 1-15 / 16-200 / 201-254 / 255 = ${histograma(m)}`);
  console.log(`  quadro 1   ${origem.w}x${origem.h}  alfa 0 / 1-15 / 16-200 / 201-254 / 255 = ${histograma(origem)}`);
}

await fsp.rm(TMP, { recursive: true, force: true });
