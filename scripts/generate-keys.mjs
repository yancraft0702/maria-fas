import crypto from 'node:crypto';
import { ROOT } from '../server/config.js';
import fs from 'node:fs';
import path from 'node:path';

const ENV_PATH = path.join(ROOT, '.env');
const EXAMPLE_PATH = path.join(ROOT, '.env.example');

function generateSessionSecret() {
  return crypto.randomBytes(48).toString('base64url');
}

function generateVapidKeys() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const publicKey = ecdh.getPublicKey().toString('base64url');
  const privateKey = ecdh.getPrivateKey().toString('base64url');
  return { publicKey, privateKey };
}

function upsertEnv(existing, values) {
  let content = existing;
  for (const [key, value] of Object.entries(values)) {
    const regex = new RegExp(`^${key}=.*$`, 'm');
    if (regex.test(content)) {
      content = content.replace(regex, `${key}=${value}`);
    } else {
      content += `\n${key}=${value}`;
    }
  }
  return content;
}

const existingEnv = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : '';
const base = existingEnv || fs.readFileSync(EXAMPLE_PATH, 'utf8');

const values = {};
const changes = [];

// SESSION_SECRET
if (!/^SESSION_SECRET=.+$/m.test(base)) {
  values.SESSION_SECRET = generateSessionSecret();
  changes.push('SESSION_SECRET');
}
// LIVE_TOKEN_SECRET
if (!/^LIVE_TOKEN_SECRET=.+$/m.test(base)) {
  values.LIVE_TOKEN_SECRET = crypto.randomBytes(48).toString('base64url');
  changes.push('LIVE_TOKEN_SECRET');
}
// VAPID
const hasVapid = /^VAPID_PUBLIC_KEY=.+$/m.test(base) && /^VAPID_PRIVATE_KEY=.+$/m.test(base);
if (!hasVapid) {
  const keys = generateVapidKeys();
  values.VAPID_PUBLIC_KEY = keys.publicKey;
  values.VAPID_PRIVATE_KEY = keys.privateKey;
  changes.push('VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY');
}

if (changes.length === 0) {
  console.log('Todos os segredos necessarios ja existem no .env. Nada a fazer.');
  console.log('Para rotacionar: apague SESSION_SECRET / LIVE_TOKEN_SECRET / VAPID_* do .env e rode novamente.');
  process.exit(0);
}

const header = [
  '# ---------------------------------------------------------------------------',
  '# Segredos gerados por `npm run keys` (nao edite manualmente, nao versione).',
  '# ---------------------------------------------------------------------------',
  '',
].join('\n');

const merged = upsertEnv(base, values);
fs.writeFileSync(ENV_PATH, header + merged, 'utf8');

console.log('Segredos gerados e gravados em .env:');
for (const key of changes) console.log(`  - ${key}`);
console.log('');
console.log('IMPORTANTE: esses valores sao segredo. Nao compartilhe, nao versione (.gitignore).');
