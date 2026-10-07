/**
 * Mede, direto dos PNG de origem, a fracao transparente/opaca de cada
 * efeito (item 9).
 *
 * Existe para calibrar o gerador sem esperar o pipeline inteiro: o
 * `verifyAlphaChannel` mede o APNG final, e o criterio e o mesmo
 * (transparente > 20% E opaco > 3%). Rodar isso sobre os PNG de origem da o
 * retorno em segundos, entao da para ajustar o traço ate passar.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { ROOT } from '../server/config.js';

const DIR = path.resolve(ROOT, 'anima\u00e7\u00e3o');
const LIMITE_OPACO = 0.03;
const LIMITE_TRANSP = 0.20;

/** Le um PNG RGBA de 8 bits, sem filtro (o gerador escreve filtro 0). */
function lerPng(arquivo) {
  const buf = fs.readFileSync(arquivo);
  let p = 8; // assinatura
  let w = 0; let h = 0; let bitDepth = 8; let colorType = 6;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const tipo = buf.toString('ascii', p + 4, p + 8);
    const dados = buf.subarray(p + 8, p + 8 + len);
    if (tipo === 'IHDR') {
      w = dados.readUInt32BE(0);
      h = dados.readUInt32BE(4);
      bitDepth = dados[8];
      colorType = dados[9];
    } else if (tipo === 'IDAT') idat.push(dados);
    else if (tipo === 'IEND') break;
    p += 12 + len;
  }
  if (bitDepth !== 8 || colorType !== 6) throw new Error(`PNG inesperado: depth=${bitDepth} color=${colorType}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const px = Buffer.alloc(w * h * 4);
  const porLinha = 1 + w * 4;
  for (let y = 0; y < h; y += 1) {
    const filtro = raw[y * porLinha];
    if (filtro !== 0) throw new Error(`filtro PNG nao suportado: ${filtro}`);
    raw.copy(px, y * w * 4, y * porLinha + 1, y * porLinha + porLinha);
  }
  return { w, h, px };
}

function medir(arquivo) {
  const { w, h, px } = lerPng(arquivo);
  let transp = 0; let opaco = 0;
  const total = w * h;
  for (let i = 0; i < total; i += 1) {
    const a = px[i * 4 + 3];
    if (a < 16) transp += 1; else if (a > 200) opaco += 1;
  }
  return { w, h, transparentRatio: transp / total, opaqueRatio: opaco / total };
}

const arquivos = fs.readdirSync(DIR).filter((n) => n.endsWith('.png') && n !== 'catalogo.json');
if (!arquivos.length) {
  console.log('nenhum efeito gerado ainda');
  process.exit(1);
}

console.log('arquivo'.padEnd(26) + 'dim'.padEnd(12) + 'transp'.padEnd(10) + 'opaco'.padEnd(10) + 'status');
let ok = 0;
for (const nome of arquivos.sort()) {
  const m = medir(path.join(DIR, nome));
  const passa = m.transparentRatio > LIMITE_TRANSP && m.opaqueRatio > LIMITE_OPACO;
  if (passa) ok += 1;
  console.log(
    nome.replace('.png', '').padEnd(26)
    + `${m.w}x${m.h}`.padEnd(12)
    + `${(m.transparentRatio * 100).toFixed(1)}%`.padEnd(10)
    + `${(m.opaqueRatio * 100).toFixed(2)}%`.padEnd(10)
    + (passa ? 'ok' : `ABAIXO DE ${LIMITE_OPACO * 100}%`),
  );
}
console.log(`\n${ok}/${arquivos.length} com alfa valido (transp>${LIMITE_TRANSP * 100}%, opaco>${LIMITE_OPACO * 100}%)`);
void fsp;
process.exit(ok === arquivos.length ? 0 : 1);