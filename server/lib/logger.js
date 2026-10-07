import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../config.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const level = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;

const SENSITIVE = /^(password|senha|password_confirmation|token|session|csrf|secret|authorization|cookie|api[_-]?key|client_secret|totp_secret|recovery_codes|turn_credential|credential)$/i;

function redact(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (depth > 4) return '[deep]';
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE.test(k) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

const COLORS = {
  debug: '\x1b[90m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
  reset: '\x1b[0m',
};
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;

let stream = null;
function fileStream() {
  if (stream) return stream;
  try {
    const dir = path.join(ROOT, 'data');
    fs.mkdirSync(dir, { recursive: true });
    stream = fs.createWriteStream(path.join(dir, 'pulse.log'), { flags: 'a' });
    stream.on('error', () => { stream = null; });
  } catch {
    stream = null;
  }
  return stream;
}

function write(kind, message, meta) {
  const time = new Date().toISOString();
  const safe = meta ? redact(meta) : undefined;
  const line = safe && Object.keys(safe).length ? `${message} ${JSON.stringify(safe)}` : message;
  const text = `${time} ${kind.toUpperCase().padEnd(5)} ${line}`;
  const out = kind === 'error' || kind === 'warn' ? process.stderr : process.stdout;
  out.write(`${useColor ? `${COLORS[kind]}${kind.toUpperCase()}${COLORS.reset}` : kind.toUpperCase()} ${useColor ? '' : ''}${message}${safe && Object.keys(safe).length ? ' ' + JSON.stringify(safe) : ''}\n`);
  const f = fileStream();
  if (f) f.write(`${text}\n`);
}

export const logger = {
  debug: (m, meta) => level <= 10 && write('debug', m, meta),
  info: (m, meta) => level <= 20 && write('info', m, meta),
  warn: (m, meta) => level <= 30 && write('warn', m, meta),
  error: (m, meta) => write('error', m, meta),
  child(base) {
    return {
      debug: (m, meta) => logger.debug(m, { ...base, ...meta }),
      info: (m, meta) => logger.info(m, { ...base, ...meta }),
      warn: (m, meta) => logger.warn(m, { ...base, ...meta }),
      error: (m, meta) => logger.error(m, { ...base, ...meta }),
    };
  },
};

export default logger;
