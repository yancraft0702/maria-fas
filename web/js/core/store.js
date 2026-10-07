/**
 * Estado global da aplicacao (fonte de verdade no cliente).
 * O backend continua sendo a autoridade; aqui so ha cache de leitura.
 */
import { api } from './api.js';

const listeners = new Map();

export const store = {
  user: null,
  preferences: {
    language: 'pt-BR',
    autoplay: true,
    autoplayMuted: true,
    reduceMotion: false,
    fontScale: 1,
    highContrast: false,
    captionsDefault: true,
    dataSaver: false,
    defaultPostVisibility: 'public',
  },
  appConfig: {
    features: { live: true, giphy: false, push: false, hls: false, transcode: false, turn: false },
    limits: {},
    moderationWindows: [2, 4, 6, 10],
    iceServers: { iceServers: [], turnServers: [], turnConfigured: false },
  },
  counts: { notifications: 0, messages: 0 },
  theme: localStorage.getItem('pulse_theme') || 'dark',
  motion: localStorage.getItem('pulse_motion') || 'auto',
  serviceWorkerReady: false,
  pushEnabled: localStorage.getItem('pulse_push') === 'granted',
  session: null,
};

export function on(event, handler) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(handler);
  return () => listeners.get(event)?.delete(handler);
}

export function emit(event, payload) {
  for (const handler of listeners.get(event) || []) {
    try {
      handler(payload);
    } catch (err) {
      console.error(`[store] listener de "${event}" falhou:`, err);
    }
  }
}

export function setUser(user, preferences) {
  const changed = (store.user?.id ?? null) !== (user?.id ?? null);
  store.user = user || null;
  if (preferences) {
    store.preferences = { ...store.preferences, ...preferences };
    applyPreferences();
  }
  emit('user', store.user);
  if (changed) emit('user:changed', store.user);
}

export function isLoggedIn() {
  return Boolean(store.user);
}

export function isStaff() {
  return store.user?.role === 'admin' || store.user?.role === 'moderator';
}

export function isAdmin() {
  return store.user?.role === 'admin';
}

export function setCounts(counts) {
  let changed = false;
  for (const [key, value] of Object.entries(counts || {})) {
    if (typeof value === 'number' && store.counts[key] !== value) {
      store.counts[key] = value;
      changed = true;
    }
  }
  if (changed) emit('counts', store.counts);
}

export function applyPreferences() {
  const root = document.documentElement;
  root.style.setProperty('--font-scale', String(store.preferences.fontScale || 1));
  root.dataset.contrast = store.preferences.highContrast ? 'high' : 'normal';
  root.dataset.motion = store.preferences.reduceMotion ? 'reduce' : 'auto';
}

export function setTheme(theme) {
  store.theme = theme === 'light' ? 'light' : 'dark';
  localStorage.setItem('pulse_theme', store.theme);
  document.documentElement.dataset.theme = store.theme;
  emit('theme', store.theme);
}

export function toggleTheme() {
  setTheme(store.theme === 'dark' ? 'light' : 'dark');
}

export function applyInitialTheme() {
  const stored = localStorage.getItem('pulse_theme');
  const prefersLight = window.matchMedia('(prefers-color-scheme: light)').matches;
  setTheme(stored || (prefersLight ? 'light' : 'dark'));
}

/** Sessao + configuracao da aplicacao. */
export async function bootstrapSession() {
  const [session, appConfig] = await Promise.allSettled([
    api.get('/api/auth/me'),
    api.get('/api/app/config'),
  ]);

  if (appConfig.status === 'fulfilled') {
    store.appConfig = { ...store.appConfig, ...appConfig.value };
  }

  if (session.status === 'fulfilled' && session.value?.authenticated) {
    setUser(session.value.user, session.value.preferences);
    store.session = session.value.session;
    if (session.value.csrfToken) window.__PULSE_CSRF__ = session.value.csrfToken;
    await refreshCounts();
    return session.value.user;
  }
  setUser(null);
  return null;
}

export async function refreshCounts() {
  if (!isLoggedIn()) {
    setCounts({ notifications: 0, messages: 0 });
    return;
  }
  const results = await Promise.allSettled([
    api.get('/api/notifications/unread'),
    import('../features/messaging.js').then((m) => m.unreadMessages()),
  ]);
  const counts = {};
  if (results[0].status === 'fulfilled') counts.notifications = results[0].value.unread ?? 0;
  if (results[1].status === 'fulfilled') counts.messages = results[1].value ?? 0;
  setCounts(counts);
}

export function updatePreference(key, value) {
  store.preferences = { ...store.preferences, [key]: value };
  applyPreferences();
}

export default store;
