import { forbidden } from './lib/errors.js';

/**
 * Roteador com parametros nomeados: /api/posts/:id/comments
 * Nao ha duplicacao: cada rota e registrada uma unica vez; registrar a mesma
 * chave duas vezes lanca erro no boot (falha cedo, nao silenciosa).
 */
export class Router {
  constructor() {
    this.routes = [];
    this.byKey = new Map();
  }

  add(method, pattern, handler, options = {}) {
    const segments = splitPath(pattern);
    const key = `${method} ${pattern}`;
    if (this.byKey.has(key)) {
      throw new Error(`Rota duplicada: ${key}`);
    }
    const route = {
      method,
      pattern,
      segments,
      handler,
      auth: options.auth ?? false,
      csrf: options.csrf ?? !(method === 'GET' || method === 'HEAD'),
      rate: options.rate ?? 'default',
      meta: options.meta ?? {},
    };
    this.routes.push(route);
    this.byKey.set(key, route);
    return this;
  }

  get(p, h, o) { return this.add('GET', p, h, o); }
  post(p, h, o) { return this.add('POST', p, h, o); }
  put(p, h, o) { return this.add('PUT', p, h, o); }
  patch(p, h, o) { return this.add('PATCH', p, h, o); }
  delete(p, h, o) { return this.add('DELETE', p, h, o); }

  /**
   * Casa uma requisicao com uma rota.
   *
   * Prioridade: segmento literal vence sempre parametro. Sem isso,
   * `/api/live/effects` seria capturado por `/api/live/:id` (a ordem de
   * registro), transforming um recurso estatico em "LIVE nao encontrada".
   */
  find(method, pathname) {
    const parts = splitPath(pathname);
    let methodMismatch = false;
    let best = null;

    for (const route of this.routes) {
      if (route.segments.length !== parts.length) continue;
      const params = {};
      let ok = true;
      let specificity = 0;
      for (let i = 0; i < route.segments.length; i += 1) {
        const seg = route.segments[i];
        if (seg.startsWith(':')) {
          params[seg.slice(1)] = decodeURIComponent(parts[i]);
        } else if (seg !== parts[i]) {
          ok = false;
          break;
        } else {
          // Segmento literal e' mais especifico que parametro.
          specificity += 1;
        }
      }
      if (!ok) continue;
      if (route.method !== method) {
        methodMismatch = true;
        continue;
      }
      if (!best || specificity > best.specificity) {
        best = { route, params, specificity };
      }
    }

    if (best) return best;
    if (methodMismatch) {
      throw forbidden('method_not_allowed', `Metodo ${method} nao permitido para ${pathname}`);
    }
    return null;
  }

  list() {
    return this.routes.map((r) => ({ method: r.method, path: r.pattern, auth: r.auth, rate: r.rate }));
  }
}

function splitPath(path) {
  return path.split('/').filter((s) => s.length > 0);
}

export const router = new Router();
export default router;
