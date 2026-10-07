/**
 * Sinais de consumo para a recomendacao.
 * Envio agregado (debounce) para nao poluir a API a cada quadro.
 */
import { api } from '../core/api.js';
import { isLoggedIn } from '../core/store.js';

const queue = new Map();
let flushTimer = null;
let intervalTimer = null;
const INTERVAL_MS = 15000;

function ensureTimer() {
  if (intervalTimer) return;
  intervalTimer = setInterval(() => flush(), INTERVAL_MS);
}

export function recordWatch(postId, signals = {}) {
  if (!isLoggedIn() || !postId) return;
  const existing = queue.get(postId) || {};
  queue.set(postId, { ...existing, ...signals });
  ensureTimer();

  clearTimeout(flushTimer);
  flushTimer = setTimeout(() => flush(), 4000);
}

export async function flush() {
  if (!queue.size) return;
  const entries = [...queue.entries()];
  queue.clear();
  for (const [postId, signals] of entries) {
    try {
      await api.post(`/api/posts/${postId}/watch`, {
        watchMs: signals.watchMs ?? 0,
        completed: Boolean(signals.completed),
        replayed: Boolean(signals.replayed),
        skipped: Boolean(signals.skipped),
        liked: Boolean(signals.liked),
        commented: Boolean(signals.commented),
        shared: Boolean(signals.shared),
        favorited: Boolean(signals.favorited),
        reposted: Boolean(signals.reposted),
        followedAuthor: Boolean(signals.followedAuthor),
        profileVisited: Boolean(signals.profileVisited),
      });
    } catch {
      // Falha de telemetria nunca interrompe a experience; descarta.
    }
  }
}

export function stopAnalytics() {
  flush();
  clearTimeout(flushTimer);
  flushTimer = null;
  clearInterval(intervalTimer);
  intervalTimer = null;
  queue.clear();
}

export function markInteraction(postId, kind) {
  recordWatch(postId, { [kind]: true });
}
