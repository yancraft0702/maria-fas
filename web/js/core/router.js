/**
 * Roteador do cliente (SPA). Um unico lugar resolve rota -> tela.
 * Cada tela e registrada uma vez e pode declarar cleanup (listeners,
 * timers, streams de midia) que rodam ao sair.
 */
import { emit } from './store.js';

const routes = [];
let current = null;
let currentCleanup = null;
let notFoundHandler = null;

export function route(pattern, handler, meta = {}) {
  if (routes.some((r) => r.pattern === pattern)) {
    throw new Error(`Rota de cliente duplicada: ${pattern}`);
  }
  routes.push({ pattern, handler, meta, segments: split(pattern) });
}

export function setNotFound(handler) {
  notFoundHandler = handler;
}

/**
 * Guarda de sessao.
 *
 * `check(path, meta)` devolve `null` para liberar a rota ou um caminho de
 * redirecionamento. Roda ANTES do handler, dentro do mesmo `resolve()`, entao
 * o redirecionamento entra no mesmo ciclo e nao depende de um segundo
 * `navigate()` (que seria ignorado pelo bloqueio de reentrada).
 */
let sessionGuard = null;

export function setSessionGuard(fn) {
  sessionGuard = fn;
}

function split(path) {
  return path.split('/').filter(Boolean);
}

export function match(pathname) {
  const parts = split(pathname);
  for (const entry of routes) {
    if (entry.segments.length !== parts.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < entry.segments.length; i += 1) {
      const seg = entry.segments[i];
      if (seg.startsWith(':')) {
        params[seg.slice(1)] = decodeURIComponent(parts[i]);
      } else if (seg.startsWith('*')) {
        params.wildcard = parts.slice(i).join('/');
      } else if (seg.includes(':')) {
        // Segmento com parametro EMBUTIDO no meio, como `@:username`.
        // Antes isso caia na comparacao literal e NUNCA casava - o resultado
        // era "Pagina nao encontrada" em todo link de perfil (Amigos,
        // Seguindo, Seguidores, busca e comentarios).
        const partes = seg.split(':');
        const prefixo = partes[0];
        const valor = parts[i];
        if (!valor.startsWith(prefixo)) { ok = false; break; }
        const nome = partes.slice(1).join(':');
        params[nome] = decodeURIComponent(valor.slice(prefixo.length));
      } else if (seg !== parts[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return { entry, params };
  }
  return null;
}

export function currentRoute() {
  return current;
}

export function navigate(path, { replace = false, state = {} } = {}) {
  const url = new URL(path, location.origin);
  const target = `${url.pathname}${url.search}${url.hash}`;
  if (target === `${location.pathname}${location.search}${location.hash}` && replace) return;
  if (replace) history.replaceState(state, '', target);
  else history.pushState(state, '', target);
  return resolve();
}

export function back(fallback = '/') {
  if (history.length > 1 && document.referrer !== '' || history.state?.depth > 1) {
    history.back();
    return;
  }
  navigate(fallback, { replace: true });
}

let resolving = false;

export async function resolve() {
  if (resolving) return;
  resolving = true;
  try {
    const result = match(location.pathname) || (notFoundHandler ? { entry: { handler: notFoundHandler, meta: {} }, params: {} } : null);
    if (!result) {
      window.location.href = location.pathname;
      return;
    }
    const query = Object.fromEntries(new URLSearchParams(location.search).entries());

    // Guarda de sessao: nenhuma area privada abre sem estar autenticado.
    if (sessionGuard) {
      const target = sessionGuard(location.pathname, result.entry.meta, query);
      if (target) {
        const from = location.pathname;
        history.replaceState({}, '', target);
        emit('route:redirect', { from, to: target });
        // Reavalia o caminho novo no mesmo ciclo. O `finally` abaixo ja
        // liberou o `resolving` quando esta microtarefa rodar, entao o
        // login e renderizado de fato (senao a tela ficaria em branco).
        queueMicrotask(() => resolve());
        return;
      }
    }

    // Cleanup da tela anterior ANTES de montar a nova
    if (currentCleanup) {
      try { currentCleanup(); } catch (err) { console.error('[router] cleanup falhou:', err); }
      currentCleanup = null;
    }

    current = { path: location.pathname, params: result.params, query, meta: result.entry.meta };
    emit('route:start', current);
    const cleanup = await result.entry.handler({
      params: result.params,
      query,
      meta: result.entry.meta,
      path: location.pathname,
    });
    currentCleanup = typeof cleanup === 'function' ? cleanup : null;
    emit('route:end', current);
  } finally {
    resolving = false;
  }
}

export function startRouter() {
  window.addEventListener('popstate', () => resolve());
  document.addEventListener('click', (event) => {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = event.target.closest?.('a[href]');
    if (!anchor) return;
    const href = anchor.getAttribute('href');
    if (!href || href.startsWith('http') || href.startsWith('mailto:') || href.startsWith('tel:')) return;
    if (anchor.target === '_blank' || anchor.hasAttribute('download')) return;
    if (href.startsWith('#')) return;
    event.preventDefault();
    navigate(href);
  });
  return resolve();
}

export function listRoutes() {
  return routes.map((r) => r.pattern);
}
