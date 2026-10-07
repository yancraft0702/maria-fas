/**
 * Verifica o ALFA REAL de cada efeito pelo caminho que o usuario usa:
 * API -> URL de midia -> bytes -> canal alfa. Nada de confiar em metadata.
 */
import { Client } from '../tests/helpers.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ffmpegPath from 'ffmpeg-static';

const run = promisify(execFile);
// O servidor de desenvolvimento pode estar em HTTPS com certificado local
// autoassinado; a cadeia ja e verificada por scripts/verify-https.mjs.
const BASE = process.argv[2] || 'https://localhost:3000';
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'alfa-check-'));

const c = new Client(BASE);
await c.post('/api/auth/login', { identifier: 'marcos', password: 'Marcos0702@#/7' });
const lista = await c.get('/api/live/effects');

let falhas = 0;
for (const efeito of lista.body.effects || []) {
  if (!efeito.mediaUrl) {
    console.log(`${efeito.slug.padEnd(10)} SEM MIDIA`);
    falhas += 1;
    continue;
  }
  const arquivo = path.join(TMP, `${efeito.slug}${path.extname(efeito.mediaUrl.split('?')[0]) || '.bin'}`);
  const resposta = await fetch(`${BASE}${efeito.mediaUrl}`, { headers: { Cookie: c.cookieHeader() } });
  const bytes = Buffer.from(await resposta.arrayBuffer());
  fs.writeFileSync(arquivo, bytes);

  const rgba = path.join(TMP, `${efeito.slug}.raw`);
  try {
    await run(ffmpegPath, ['-hide_banner', '-v', 'error', '-y', '-i', arquivo, '-vf', 'format=rgba', '-frames:v', '3', '-f', 'rawvideo', '-pix_fmt', 'rgba', rgba], { windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    console.log(`${efeito.slug.padEnd(10)} ${(bytes.length / 1024).toFixed(0)} KB  FALHA ao decodificar: ${String(e.message).slice(0, 70)}`);
    falhas += 1;
    continue;
  }
  const data = fs.readFileSync(rgba);
  let opaco = 0;
  let transparente = 0;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] > 200) opaco += 1;
    else if (data[i] < 40) transparente += 1;
  }
  const total = data.length / 4;
  const pctT = (100 * transparente) / total;
  const pctO = (100 * opaco) / total;
  const bom = pctT > 15 && pctO > 2;
  const anim = bytes.includes(Buffer.from('acTL', 'ascii'));
  console.log(`${efeito.slug.padEnd(10)} ${String((bytes.length / 1024).toFixed(0)).padStart(5)} KB  animado=${anim ? 'sim' : 'nao'}  transparentes=${pctT.toFixed(1)}%  opacos=${pctO.toFixed(1)}%  ${bom ? 'OK' : 'AJUSTAR'}`);
  if (!bom) falhas += 1;
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(falhas === 0 ? '\nTodos os efeitos com alfa real medido' : `\n${falhas} efeito(s) precisam de ajuste`);
process.exit(falhas === 0 ? 0 : 1);
