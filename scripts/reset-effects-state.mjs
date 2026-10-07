/**
 * Zera o estado de processamento dos efeitos da LIVE.
 * Use quando os arquivos em storage/effects forem removidos manualmente:
 * o proximo boot regenera a partir de animacao/.
 */
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('data/pulse.db');
const before = db.prepare('SELECT slug, media_id, alpha_ready FROM effects').all();
console.log('antes:', before);
db.exec('UPDATE effects SET media_id = NULL, alpha_ready = 0');
db.exec("UPDATE media SET status = 'failed', processing_error = 'asset removido do storage' WHERE kind = 'video'");
console.log('depois:', db.prepare('SELECT slug, media_id, alpha_ready FROM effects').all());
console.log('\nProximo boot regenera os efeitos a partir de animacao/.');
process.exit(0);