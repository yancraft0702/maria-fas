import { migrate, getDb, closeDb } from './index.js';
import logger from '../lib/logger.js';

try {
  getDb();
  const result = migrate();
  logger.info('migracoes ok', result);
  closeDb();
  process.exit(0);
} catch (err) {
  logger.error('falha nas migracoes', { error: err.message });
  process.exit(1);
}
