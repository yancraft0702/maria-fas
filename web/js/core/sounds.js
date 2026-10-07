/** Sons: listagem, busca, salvar e uso. */
import { api } from './api.js';

export async function listSounds({ limit = 30, offset = 0 } = {}) {
  return api.get('/api/sounds', { query: { limit, offset } });
}

export async function getSound(soundId) {
  return api.get(`/api/sounds/${soundId}`);
}

export async function saveSound(soundId) {
  return api.post(`/api/sounds/${soundId}/save`, {});
}

export async function unsaveSound(soundId) {
  return api.delete(`/api/sounds/${soundId}/save`);
}

export async function savedSounds() {
  return api.get('/api/me/sounds');
}

export async function uploadSound(file, title) {
  const { promise } = api.upload(`/api/sounds/upload${title ? `?title=${encodeURIComponent(title)}` : ''}`, {
    file,
    onProgress: () => {},
  });
  return promise;
}
