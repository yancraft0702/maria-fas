/**
 * Cria/promove um administrador usando os MESMOS modulos do sistema
 * (hash scrypt + update no banco). Nenhuma credencial no codigo: usuario e
 * senha vem de variaveis de ambiente.
 *
 *   ADMIN_USERNAME=marcos ADMIN_PASSWORD=... node scripts/set-admin.mjs
 */
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { ROOT } from '../server/config.js';
import { hashPassword } from '../server/lib/crypto.js';
import { normalizeUsername, normalizeEmail, newId } from '../server/lib/ids.js';

const username = process.env.ADMIN_USERNAME;
const password = process.env.ADMIN_PASSWORD;
const email = process.env.ADMIN_EMAIL;

if (!username || !password) {
  console.error('Defina ADMIN_USERNAME e ADMIN_PASSWORD antes de rodar.');
  process.exit(1);
}

const db = new DatabaseSync(path.join(ROOT, 'data', 'pulse.db'));
db.exec('PRAGMA foreign_keys = ON');

// Mesmo formato usado no login: scrypt$N$r$p$salt$hash
const hash = await hashPassword(password);
const now = Date.now();
const norm = normalizeUsername(username);
const existente = db.prepare('SELECT id, username, role FROM users WHERE username_norm = ?').get(norm);

if (existente) {
  db.prepare(`
    UPDATE users
       SET role = 'admin', status = 'active', status_reason = NULL, status_until = NULL,
           password_hash = ?, updated_at = ?
     WHERE id = ?
  `).run(hash, now, existente.id);
  console.log(`usuario "${existente.username}" -> ADMIN (id ${existente.id})`);
} else {
  const id = newId('usr');
  const mail = email || `${norm}@conta.mariafas.app`;
  db.prepare(`
    INSERT INTO users (id, email, email_normalized, username, username_norm, display_name,
                       password_hash, role, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'admin', 'active', ?, ?)
  `).run(id, mail, normalizeEmail(mail), username, norm, username, hash, now, now);
  console.log(`usuario "${username}" criado como ADMIN (id ${id})`);
}

console.log('estado final:', JSON.stringify(
  db.prepare('SELECT username, role, status FROM users WHERE username_norm = ?').get(norm),
));
db.close();