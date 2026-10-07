import fs from 'node:fs';

/**
 * Verificador dos efeitos da LIVE (itens 9 e 10).
 *
 * Correcoes em relacao a primeira versao:
 *  - as variaveis de ambiente (banco/storage temporarios) sao passadas pelo
 *    SHELL, nao por `process.env` dentro do script. Em ESM os imports sao
 *    avaliados ANTES do corpo do modulo, entao `server/config.js` lia o
 *    ambiente real e o script escrevia no banco e no storage de dev - sem a
 *    migracao aplicada, o erro era "no such table: effects".
 *  - a migracao e aplicada explicitamente antes de sincronizar o catalogo;
 *  - `verifyAlphaChannel` recebe `{ filePath }` (nao a string solta): com a
 *    string, o parametro chegava `undefined` e TODOS os efeitos saiam como
 *    `decode_failed`.
 *
 * O que este script comprova, sem confiar em promessa:
 *  - os 15 efeitos tem arquivo e geram midia no pipeline;
 *  - `verifyAlphaChannel` mede transparencia E pixels opacos no arquivo final;
 *  - os 4 efeitos antigos ficam desabilitados e nao aparecem na API.
 */
import path from 'node:path';


const { migrate, all } = await import('../server/db/index.js');
const { syncEffectCatalog, EFFECT_CATALOG, listEffects, queueEffectMedia } = await import('../server/domain/effects.js');
const { verifyAlphaChannel } = await import('../server/media/pipeline.js');

// O banco/storage temporarios precisam existir de verdade antes de qualquer
// escrita: o script so pode montar os caminhos, nao definir o ambiente.
const esperado = process.env.STORAGE_ROOT;
if (!esperado || !esperado.includes('tmp-efeitos')) {
  console.error(' rode com:');
  console.error('   $env:DATABASE_PATH = "$PWD\\data\\.tmp-efeitos-check.db"');
  console.error('   $env:STORAGE_ROOT  = "$PWD\\data\\.tmp-efeitos-storage"');
  console.error('   node scripts/verificar-efeitos.mjs');
  process.exit(1);
}

const p = (m) => console.log(m);

migrate({ silent: true });
p(`banco migrado | ${EFFECT_CATALOG.length} efeitos no catalogo\n`);

// Os efeitos precisam existir antes de gerar midia (o boot do servidor faz isso).
syncEffectCatalog({ regenerate: false });

p('gerando midia de cada efeito (ffmpeg + medicao de alfa):');
let gerados = 0;
for (const item of EFFECT_CATALOG) {
  if (!fs.existsSync(item.source)) {
    p(`  FALTA ${item.slug}: arquivo de origem ausente (${path.basename(item.source)})`);
    continue;
  }
  // eslint-disable-next-line no-await-in-loop
  const r = await queueEffectMedia(item.slug, item);
  if (r.generated !== false) gerados += 1;
  const estado = r.generated === false ? r.reason : (r.alpha ? 'alfa medido' : `sem alfa: ${r.reason}`);
  p(`  ${item.slug.padEnd(22)} ${estado}`);
}
p(`gerados nesta rodada: ${gerados}/${EFFECT_CATALOG.length}\n`);

p('medindo o alfa real de cada arquivo gerado:');
const linhas = all(`
  SELECT e.slug, e.alpha_ready, m.bucket, m.storage_key, m.size
    FROM effects e LEFT JOIN media m ON m.id = e.media_id
   WHERE e.enabled = 1 ORDER BY e.slug`);

let comAlfa = 0;
for (const linha of linhas) {
  if (!linha.storage_key) {
    p(`  FALTA ${linha.slug}: sem midia no banco`);
    continue;
  }
  const arquivo = path.join(process.env.STORAGE_ROOT, linha.bucket, linha.storage_key);
  // eslint-disable-next-line no-await-in-loop
  const medido = await verifyAlphaChannel({ filePath: arquivo });
  if (medido.hasAlpha) {
    comAlfa += 1;
    p(`  ok    ${linha.slug.padEnd(22)} ${String(Math.round(linha.size / 1024)).padStart(5)} KB  `
      + `${(medido.transparentRatio * 100).toFixed(1)}% transp / ${(medido.opaqueRatio * 100).toFixed(1)}% opaco`);
  } else {
    p(`  FALTA ${linha.slug.padEnd(22)} ${String(Math.round(linha.size / 1024)).padStart(5)} KB  `
      + `${medido.reason} (transp ${medido.transparentRatio}, opaco ${medido.opaqueRatio})`);
  }
}
p(`\ncom alfa real medido: ${comAlfa}/${linhas.length}`);

// Os antigos nao podem aparecer no catalogo ativo.
p('');
for (const a of all(`SELECT slug, enabled FROM effects WHERE slug IN ('boneca','cemiterio','fornalha','tomate')`)) {
  p(`antigo "${a.slug}": enabled=${a.enabled} ${Number(a.enabled) === 0 ? '(desativado, ok)' : '(AINDA ATIVO)'}`);
}
const ativosAntigos = all(`SELECT slug FROM effects WHERE slug IN ('boneca','cemiterio','fornalha','tomate') AND enabled = 1`);

const publicos = listEffects(null);
const slugsApi = new Set(publicos.map((e) => e.slug));
const faltando = EFFECT_CATALOG.filter((e) => !slugsApi.has(e.slug));
p(`\nefeitos na API: ${publicos.length} (esperado ${EFFECT_CATALOG.length})`);
if (faltando.length) p(`FALTA na API: ${faltando.map((e) => e.slug).join(', ')}`);

const okFinal = comAlfa === linhas.length
  && linhas.length === EFFECT_CATALOG.length
  && ativosAntigos.length === 0
  && faltando.length === 0;

p(`\n${okFinal ? 'CATALOGO DE EFEITOS OK' : 'CATALOGO INCOMPLETO'}`);
process.exit(okFinal ? 0 : 1);
