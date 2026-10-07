import { all, get, run } from '../db/index.js';
import { newId } from '../lib/ids.js';
import { notFound, forbidden } from '../lib/errors.js';

// --------------------------------------------------------------------------
// Sons
// --------------------------------------------------------------------------
export function createSound({ ownerId, title, artist = '', mediaId = null, isOriginal = false, license = 'platform', durationMs = 0 }) {
  const id = newId('snd');
  run(
    `INSERT INTO sounds (id, title, artist, media_id, is_original, license, duration_ms, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    { id, title, artist, mediaId, isOriginal: isOriginal ? 1 : 0, license, durationMs, now: Date.now(), ts: Date.now() },
  );
  return getSound(id);
}

export function getSound(soundId) {
  const row = get('SELECT * FROM sounds WHERE id = ?', { soundId });
  if (!row) return null;
  const media = row.media_id ? get('SELECT bucket, storage_key FROM media WHERE id = ?', { mediaId: row.media_id }) : null;
  return {
    id: row.id,
    title: row.title,
    artist: row.artist ?? '',
    isOriginal: Boolean(row.is_original),
    license: row.license,
    durationMs: row.duration_ms ?? 0,
    useCount: row.use_count ?? 0,
    url: media ? `/api/media/stream?key=${encodeURIComponent(`${media.bucket}/${media.storage_key}`)}` : null,
  };
}

export function listSounds({ limit = 50, offset = 0 }) {
  return all(
    'SELECT id FROM sounds ORDER BY use_count DESC, created_at DESC LIMIT :limit OFFSET :offset',
    { limit, offset },
  ).map((r) => getSound(r.id));
}

export function saveSound({ userId, soundId }) {
  const sound = get('SELECT id FROM sounds WHERE id = ?', { soundId });
  if (!sound) throw notFound('sound_not_found', 'Som nao encontrado');
  run('INSERT OR IGNORE INTO sound_saves (user_id, sound_id, created_at) VALUES (?, ?, ?)', {
    userId, soundId, ts: Date.now(),
  });
  return { saved: true };
}

export function unsaveSound({ userId, soundId }) {
  run('DELETE FROM sound_saves WHERE user_id = ? AND sound_id = ?', { userId, soundId });
  return { saved: false };
}

export function savedSounds(userId, limit = 50) {
  return all(
    `SELECT s.id FROM sound_saves ss JOIN sounds s ON s.id = ss.sound_id
      WHERE ss.user_id = ? ORDER BY ss.created_at DESC LIMIT ?`,
    { userId, limit },
  ).map((r) => getSound(r.id));
}

// --------------------------------------------------------------------------
// Rascunhos (privados)
// --------------------------------------------------------------------------
export function saveDraft({ userId, payload, draftId = null }) {
  const json = JSON.stringify(payload ?? {});
  const now = Date.now();
  if (draftId) {
    const existing = get('SELECT * FROM drafts WHERE id = ? AND user_id = ?', { id: draftId, userId });
    if (!existing) throw notFound('draft_not_found', 'Rascunho nao encontrado');
    run('UPDATE drafts SET payload_json = ?, updated_at = ? WHERE id = ?', { json, ts: now, id: draftId });
    return getDraft(draftId, userId);
  }
  const id = newId('dft');
  run('INSERT INTO drafts (id, user_id, payload_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', {
    id, userId, json, now, ts: now,
  });
  return getDraft(id, userId);
}

export function getDraft(draftId, userId) {
  const row = get('SELECT * FROM drafts WHERE id = ? AND user_id = ?', { id: draftId, userId });
  if (!row) return null;
  return {
    id: row.id,
    payload: safeJson(row.payload_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listDrafts(userId, limit = 30) {
  return all(
    'SELECT * FROM drafts WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?',
    { userId, limit },
  ).map((row) => ({
    id: row.id,
    payload: safeJson(row.payload_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export function deleteDraft({ draftId, userId }) {
  run('DELETE FROM drafts WHERE id = ? AND user_id = ?', { id: draftId, userId });
  return { deleted: true };
}

export function publishDraft({ draftId, userId }) {
  const draft = getDraft(draftId, userId);
  if (!draft) throw notFound('draft_not_found', 'Rascunho nao encontrado');
  return draft;
}

// --------------------------------------------------------------------------
// Colecoes / playlists
// --------------------------------------------------------------------------
export function createCollection({ userId, name, description = '', privacy = 'private' }) {
  const id = newId('col');
  const now = Date.now();
  run(
    'INSERT INTO collections (id, user_id, name, description, privacy, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    { id, userId, name, description, privacy, now, ts: now },
  );
  return get('SELECT * FROM collections WHERE id = ?', { id });
}

export function addToCollection({ collectionId, userId, postId }) {
  const collection = get('SELECT * FROM collections WHERE id = ?', { id: collectionId });
  if (!collection) throw notFound('collection_not_found', 'Colecao nao encontrada');
  if (collection.user_id !== userId) throw forbidden('not_collection_owner', 'Somente o dono pode editar a colecao');
  const post = get('SELECT id FROM posts WHERE id = ?', { id: postId });
  if (!post) throw notFound('post_not_found', 'Conteudo nao encontrado');
  const position = (get('SELECT COALESCE(MAX(position), -1) AS p FROM collection_items WHERE collection_id = ?', { collectionId })?.p ?? -1) + 1;
  run(
    'INSERT OR IGNORE INTO collection_items (collection_id, post_id, position, created_at) VALUES (?, ?, ?, ?)',
    { collectionId, postId, position, ts: Date.now() },
  );
  run('UPDATE collections SET updated_at = ? WHERE id = ?', { ts: Date.now(), id: collectionId });
  return { added: true };
}

export function removeFromCollection({ collectionId, userId, postId }) {
  const collection = get('SELECT * FROM collections WHERE id = ?', { id: collectionId });
  if (!collection) throw notFound('collection_not_found', 'Colecao nao encontrada');
  if (collection.user_id !== userId) throw forbidden('not_collection_owner', 'Somente o dono pode editar a colecao');
  run('DELETE FROM collection_items WHERE collection_id = ? AND post_id = ?', { collectionId, postId });
  return { removed: true };
}

export function deleteCollection({ collectionId, userId }) {
  run('DELETE FROM collections WHERE id = ? AND user_id = ?', { id: collectionId, userId });
  return { deleted: true };
}

export function updateCollection({ collectionId, userId, changes }) {
  const collection = get('SELECT * FROM collections WHERE id = ?', { id: collectionId });
  if (!collection) throw notFound('collection_not_found', 'Colecao nao encontrada');
  if (collection.user_id !== userId) throw forbidden('not_collection_owner', 'Somente o dono pode editar a colecao');
  const sets = [];
  const params = { id: collectionId, ts: Date.now() };
  for (const [key, column] of Object.entries({ name: 'name', description: 'description', privacy: 'privacy' })) {
    if (changes[key] !== undefined) { sets.push(`${column} = ?`); params[column] = changes[key]; }
  }
  if (sets.length) run(`UPDATE collections SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, params);
  return get('SELECT * FROM collections WHERE id = ?', { id: collectionId });
}

function safeJson(json) {
  try { return JSON.parse(json || '{}'); } catch { return {}; }
}
