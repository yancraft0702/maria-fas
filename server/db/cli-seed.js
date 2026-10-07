/**
 * Seed seguro.
 * - Cria o primeiro administrador APENAS a partir de ADMIN_EMAIL /
 *   ADMIN_USERNAME / ADMIN_PASSWORD (nunca com credenciais no codigo).
 * - Cria usuarios de demonstracao APENAS com --demo (uso de teste).
 * - Cria sons originais de exemplo usando arquivos reais gerados por ffmpeg.
 */
import config from '../config.js';
import logger from '../lib/logger.js';
import { getDb, migrate, closeDb, get, run } from './index.js';
import { createUser } from '../domain/auth.js';
import { createSound } from '../domain/content.js';
import { saveUpload } from '../media/upload.js';
import { syncEffectCatalog } from '../domain/effects.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const execFileAsync = promisify(execFile);

async function seedAdmin() {
  if (get("SELECT id FROM users WHERE role = 'admin' LIMIT 1")) {
    logger.info('admin ja existe; nada a fazer');
    return null;
  }
  const { adminEmail, adminUsername, adminPassword } = config;
  if (!adminEmail || !adminUsername || !adminPassword) {
    logger.warn('sem ADMIN_EMAIL/ADMIN_USERNAME/ADMIN_PASSWORD: nenhum admin criado', {
      hint: 'defina as variaveis e rode `npm run seed` novamente',
    });
    return null;
  }
  if (adminPassword.length < 12) {
    throw new Error('ADMIN_PASSWORD precisa ter ao menos 12 caracteres');
  }
  const user = await createUser({
    email: adminEmail,
    username: adminUsername,
    password: adminPassword,
    displayName: 'Administracao',
    role: 'admin',
  });
  run('UPDATE users SET email_verified = 1 WHERE id = ?', { id: user.id });
  logger.info('administrador criado', { username: user.username, email: user.email });
  return user;
}

async function seedDemoUsers() {
  const demo = [
    { username: 'ana', displayName: 'Ana Ribeiro', email: 'ana@pulse.local' },
    { username: 'bruno', displayName: 'Bruno Costa', email: 'bruno@pulse.local' },
    { username: 'carla', displayName: 'Carla Dias', email: 'carla@pulse.local' },
  ];
  const password = config.demoPassword;
  const created = [];
  for (const person of demo) {
    const existing = get('SELECT * FROM users WHERE username_norm = ?', { usernameNorm: person.username.toLowerCase() });
    if (existing) {
      created.push(existing);
      continue;
    }
    created.push(await createUser({ ...person, password }));
  }
  logger.info('usuarios de teste garantidos', { count: created.length, password: 'definida pelo seed de teste' });
  return created;
}

/** Sons de demonstracao: tom sintetico real (WAV via ffmpeg), nao arquivo falso. */
async function seedSounds() {
  const existing = get('SELECT COUNT(*) AS c FROM sounds')?.c ?? 0;
  if (existing > 0) return;
  let ffmpegBin;
  try {
    const mod = await import('ffmpeg-static');
    ffmpegBin = mod.default || mod;
  } catch {
    logger.warn('ffmpeg ausente: sons de demonstracao nao gerados');
    return;
  }
  const tmp = path.join(os.tmpdir(), `pulse-seed-${Date.now()}.wav`);
  try {
    // 6s: duas harmonias com envelope suave (som sintetico original)
    await execFileAsync(ffmpegBin, [
      '-v', 'error',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6:sample_rate=44100',
      '-f', 'lavfi', '-i', 'sine=frequency=660:duration=6:sample_rate=44100',
      '-filter_complex', '[0:a]volume=0.4[a0];[1:a]volume=0.3[a1];[a0][a1]amix=inputs=2:duration=longest,afade=t=in:d=1,afade=t=out:d=2',
      '-ac', '2', '-y', tmp,
    ], { windowsHide: true });
    const buffer = await fsp.readFile(tmp);
    const saved = await saveUpload({
      ownerId: get("SELECT id FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1")?.id,
      category: 'audio',
      buffer,
      declaredMime: 'audio/wav',
      originalName: 'pulse-original.wav',
      bucket: 'sounds',
      purpose: 'sounds',
    });
    createSound({
      ownerId: saved.mediaId ? get('SELECT owner_id FROM media WHERE id = ?', { mediaId: saved.mediaId }).owner_id : null,
      title: 'MARIA FÃS Original',
      artist: 'MARIA FÃS',
      mediaId: saved.mediaId,
      isOriginal: true,
      license: 'platform',
      durationMs: 6000,
    });
    logger.info('som original criado', { mediaId: saved.mediaId });
  } catch (err) {
    logger.warn('falha ao criar som de demonstracao', { error: err.message });
  } finally {
    await fsp.rm(tmp, { force: true }).catch(() => {});
  }
}

async function main() {
  const demoMode = process.argv.includes('--demo');
  if (demoMode && config.isProd) {
    throw new Error('Seed de demonstracao (--demo) nao pode ser usado em producao');
  }
  if (demoMode && (!config.demoPassword || config.demoPassword.length < 12)) {
    throw new Error('DEMO_PASSWORD precisa ter ao menos 12 caracteres para usar --demo');
  }
  getDb();
  migrate({ silent: true });
  syncEffectCatalog();
  const admin = await seedAdmin();
  if (demoMode) {
    await seedDemoUsers();
    await seedSounds();
  }
  logger.info('seed concluido', {
    admin: admin ? admin.username : null,
    demo: demoMode,
  });
  closeDb();
}

main().catch((err) => {
  logger.error('falha no seed', { error: err.message });
  process.exit(1);
});
