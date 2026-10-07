/**
 * Prova da CAUSA RAIZ do item 3, com o arquivo que o editor realmente grava.
 *
 * A `probeViaFfmpeg` (usada porque esta maquina nao tem ffprobe) tirava
 * `hasVideo` de uma regex que exigia, DEPOIS da resolucao, o par fps/tbr:
 *
 *   Stream #0:0(...): Video: vp9 (...), 1216x2160, 1k tbn
 *                (sem fps nem tbr - e o que o MediaRecorder produz)
 *
 * Com essa linha, a regex completa dava null, `hasVideo` saia false e o
 * `processVideo` recusava a publicacao com "arquivo nao contem trilha de
 * video" - num video perfeitamente valido. Este teste roda as DUAS expressoes
 * sobre a stderr real do ffmpeg e mostra a diferenca.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT } from '../server/config.js';
import { findFfmpeg, probeMedia } from '../server/media/pipeline.js';

const REGEX_ANTIGA = /Stream #\d+:\d+.*?: Video: (\w+).*?, (\d+)x(\d+).*?, ([\d.]+) (?:fps|tbr)/;
const REGEX_NOVA_PERGUNTA_EXISTE = /Stream #\d+:\d+.*?: Video: (\w+)/;
const REGEX_NOVA_DIMENSOES = /Stream #\d+:\d+.*?: Video:.*?, (\d+)x(\d+)/;

// Sem argumento: usa o WebM gravado que sobrou da ultima verificacao.
const candidatos = [];
const achar = (dir, prof) => {
  if (prof > 4) return;
  let e = [];
  try { e = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const x of e) {
    const p = path.join(dir, x.name);
    if (x.isDirectory()) achar(p, prof + 1);
    else if (/\.webm$/i.test(x.name)) candidatos.push(p);
  }
};
achar(path.join(ROOT, '.tmp-verify-video'), 0);
achar(path.join(ROOT, 'data'), 0);

if (!candidatos.length) {
  console.error('nenhum .webm encontrado; rode primeiro: node scripts/verify-video-gravado.mjs');
  process.exit(1);
}
const arquivo = candidatos.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
console.log(`arquivo analisado: ${path.basename(arquivo)} (${fs.statSync(arquivo).size} bytes)`);

const bin = await findFfmpeg();
const stderr = await new Promise((resolve) => {
  const c = spawn(bin, ['-hide_banner', '-nostdin', '-i', arquivo, '-f', 'null', '-'], { windowsHide: true });
  let out = '';
  c.stderr.on('data', (d) => { out += d.toString(); });
  c.on('close', () => resolve(out));
});

const linhaVideo = stderr.split('\n').find((l) => /Video:/.test(l)) || '(sem linha de video)';
console.log(`linha do ffmpeg: ${linhaVideo.trim()}`);

const antiga = REGEX_ANTIGA.exec(stderr);
const novaExiste = REGEX_NOVA_PERGUNTA_EXISTE.exec(stderr);
const novaDim = REGEX_NOVA_DIMENSOES.exec(stderr);

console.log(`\nregex ANTIGA (exigia fps/tbr): ${antiga ? 'casou' : 'NAO CASOU'}`
  + `  -> hasVideo = ${Boolean(antiga)}   (e o que reprovava a publicacao)`);
console.log(`regex NOVA  (existe trilha?):  ${novaExiste ? `casou, codec=${novaExiste[1]}` : 'NAO CASOU'}`
  + `  -> hasVideo = ${Boolean(novaExiste)}`);
console.log(`dimensoes pela regex nova:    ${novaDim ? `${novaDim[1]}x${novaDim[2]}` : 'n/d'}`);

const meta = await probeMedia(arquivo);
console.log(`\nprobeMedia de hoje: hasVideo=${meta.hasVideo} ${meta.width}x${meta.height} `
  + `codec=${meta.videoCodec} fps=${meta.fps} hasAudio=${meta.hasAudio}`);

if (Boolean(antiga) === Boolean(novaExiste)) {
  console.log('\nnenhuma diferenca neste arquivo - o defeito nao se reproduz aqui');
  process.exit(0);
}
if (Boolean(antiga)) {
  console.log('\nATENCAO: neste arquivo a regex antiga CASAVA - o defeito nao se reproduz aqui');
  process.exit(0);
}
console.log('\nCONFIRMADO: a regex antiga reprovava um video valido; a nova aceita. '
  + 'Este e o erro "arquivo nao contem trilha de video".');
void REGEX_NOVA_PERGUNTA_EXISTE;