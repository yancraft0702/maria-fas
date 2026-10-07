/* ==========================================================================
   MARIA FÃS - Service Worker
   Estrategia:
   - app shell (HTML/CSS/JS): precache + network-first com cache de reserva
   - API GET: network-first, sem cache de respostas autenticadas sensiveis
   - midia (/api/media/*): cache-first limitado (imutavel por chave)
   - tudo o mais (HLS, POST, WS): passa direto (nunca cachear)
   ========================================================================== */

const VERSION = 'pulse-v2';
const SHELL_CACHE = `${VERSION}-shell`;
const MEDIA_CACHE = `${VERSION}-media`;
const API_CACHE = `${VERSION}-api`;

const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/css/app.css',
  '/js/main.js',
  '/js/core/api.js',
  '/js/core/realtime.js',
  '/js/core/store.js',
  '/js/core/router.js',
  '/js/core/dom.js',
  '/js/core/ui.js',
  '/js/core/media.js',
  '/js/core/sounds.js',
  '/js/features/feed.js',
  '/js/features/auth.js',
  '/js/features/profile.js',
  '/js/features/comments.js',
  '/js/features/messaging.js',
  '/js/features/emoji.js',
  '/js/features/gifs.js',
  '/js/features/voice.js',
  '/js/features/youtube.js',
  '/js/features/live.js',
  '/js/features/live-viewer.js',
  '/js/features/live-effects.js',
  '/js/features/live-discover.js',
  '/js/features/webrtc.js',
  '/js/features/editor.js',
  '/js/features/admin.js',
  '/js/features/settings.js',
  '/js/features/search.js',
  '/js/features/inbox.js',
  '/js/features/friends.js',
  '/js/features/notifications.js',
  '/js/features/post-page.js',
  '/js/features/post-menu.js',
  '/js/features/share.js',
  '/js/features/report.js',
  '/js/features/analytics.js',
  '/manifest.webmanifest',
  '/icons/icon.svg',
];

const MAX_MEDIA_ENTRIES = 120;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // addAll falha inteiro se um recurso falhar: adiciona um a um.
    await Promise.all(SHELL_ASSETS.map(async (url) => {
      try {
        await cache.add(new Request(url, { cache: 'reload' }));
      } catch (err) {
        console.warn('[sw] nao foi possivel precachear', url, err.message);
      }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((key) => !key.startsWith(VERSION))
      .map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});

function isMedia(url) {
  return url.pathname.startsWith('/api/media/stream') || url.pathname.startsWith('/api/media/hls');
}

function isApiGet(url) {
  return url.pathname.startsWith('/api/') && !isMedia(url);
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return; // POST/PUT/DELETE nunca sao cacheados

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // externos (GIPHY CDN, YouTube) nao passam aqui

  // Sessao revogada / logout: limpa caches de API
  if (url.pathname === '/api/auth/logout') {
    event.respondWith((async () => {
      await caches.delete(API_CACHE);
      return fetch(request);
    })());
    return;
  }

  if (isMedia(url)) {
    event.respondWith(mediaStrategy(request));
    return;
  }

  if (isApiGet(url)) {
    if (url.pathname === '/api/live/effects') {
      event.respondWith(fetch(request, { cache: 'no-store' }));
      return;
    }
    // API autenticada: network-first SEM guardar respostas de dados sensiveis
    if (url.pathname === '/api/health' || url.pathname === '/api/app/config' || url.pathname === '/api/ready') {
      event.respondWith(networkFirst(request, API_CACHE, 24 * 60 * 60 * 1000));
      return;
    }
    event.respondWith(fetch(request).catch(() => caches.match(request).then((r) => r || offlineResponse())));
    return;
  }

  // Navegacao: network-first (pega deploys novos) com fallback para o shell
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        const cache = await caches.open(SHELL_CACHE);
        cache.put('/index.html', response.clone());
        return response;
      } catch {
        const cached = await caches.match('/index.html');
        return cached || offlineResponse();
      }
    })());
    return;
  }

  // Estaticos: network-first para que deploys substituam o shell antigo;
  // o cache local continua disponivel como fallback quando estiver offline.
  event.respondWith((async () => {
    try {
      const response = await fetch(request, { cache: 'no-cache' });
      if (response.ok && response.type === 'basic') {
        const cache = await caches.open(SHELL_CACHE);
        cache.put(request, response.clone());
      }
      return response;
    } catch {
      const cached = await caches.match(request);
      return cached || offlineResponse();
    }
  })());
});

async function mediaStrategy(request) {
  const cache = await caches.open(MEDIA_CACHE);
  const cached = await cache.match(request);
  if (cached) {
    // revalida em segundo plano (midia e imutavel por chave, mas o storage pode mudar)
    fetch(request).then((response) => {
      if (response.ok) cache.put(request, response.clone());
    }).catch(() => {});
    return cached;
  }
  try {
    const response = await fetch(request);
    // So guarda midia publica/estatica: evita vazar conteudo privado no cache
    const isPrivate = request.headers.get('X-Cache-Public') === 'false';
    if (response.ok && !isPrivate && (response.status === 200 || response.status === 206)) {
      await cache.put(request, response.clone());
      await trimCache(MEDIA_CACHE, MAX_MEDIA_ENTRIES);
    }
    return response;
  } catch {
    return new Response('', { status: 504, statusText: 'Midia indisponivel offline' });
  }
}

async function networkFirst(request, cacheName, maxAgeMs) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response.ok) {
      cache.put(request, response.clone());
      // Headers para expiracao simples
      const headers = new Headers(response.headers);
      headers.set('X-Cache-Stored-At', String(Date.now()));
      const stored = new Response(await response.clone().arrayBuffer(), { status: response.status, headers });
      cache.put(request, stored);
    }
    return response;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;
    return offlineResponse();
  }
}

async function trimCache(cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length <= maxEntries) return;
  const excess = keys.length - maxEntries;
  for (let i = 0; i < excess; i += 1) {
    await cache.delete(keys[i]);
  }
}

function offlineResponse() {
  return new Response(
    JSON.stringify({
      error: {
        code: 'offline',
        message: 'Sem conexao com o servidor. Verifique sua internet.',
      },
    }),
    { status: 503, headers: { 'Content-Type': 'application/json; charset=utf-8' } },
  );
}

// --------------------------------------------------------------------------
// Push notifications (Web Push, VAPID no servidor)
// --------------------------------------------------------------------------
self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { title: 'MARIA FÃS', body: event.data ? event.data.text() : '' };
  }
  const title = payload.title || 'MARIA FÃS';
  const options = {
    body: payload.body || '',
    icon: payload.icon || '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: payload.tag || 'pulse',
    data: { url: payload.url || '/' },
    vibrate: [80, 40, 80],
    actions: [
      { action: 'open', title: 'Abrir' },
      { action: 'dismiss', title: 'Dispensar' },
    ],
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  if (event.action === 'dismiss') return;
  const target = event.notification.data?.url || '/';
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clients) {
      if ('focus' in client) {
        client.postMessage({ type: 'navigate', url: target });
        return client.focus();
      }
    }
    return self.clients.openWindow(target);
  })());
});
