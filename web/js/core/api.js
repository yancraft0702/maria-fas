/**
 * Cliente HTTP.
 * - JSON com CSRF automatico (double-submit)
 * - Upload com progresso e cancelamento via XHR
 * - Erros preservam status + codigo do servidor (nunca mascarados)
 */

export class ApiError extends Error {
  constructor(status, code, message, details = null, requestId = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.requestId = requestId;
  }

  get isAuth() { return this.status === 401; }
  get isForbidden() { return this.status === 403; }
  get isNotFound() { return this.status === 404; }
  get isRateLimited() { return this.status === 429; }
  get isNetwork() { return this.status === 0; }
}

function readCookie(name) {
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

export const csrfToken = () => readCookie('pulse_csrf') || window.__PULSE_CSRF__ || '';

export const deviceId = (() => {
  const KEY = 'pulse_device_id';
  let id = localStorage.getItem(KEY);
  if (!id) {
    id = (crypto.randomUUID ? crypto.randomUUID() : `d${Date.now()}${Math.random().toString(36).slice(2)}`);
    localStorage.setItem(KEY, id);
  }
  return id;
})();

async function request(method, path, { body, query, signal, headers = {}, raw = false } = {}) {
  const url = new URL(path, location.origin);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
  }

  const init = {
    method,
    credentials: 'same-origin',
    signal,
    headers: {
      'X-Requested-With': 'fetch',
      'X-Device-Id': deviceId,
      ...headers,
    },
  };
  if (method === 'GET' && url.pathname === '/api/live/effects') {
    init.cache = 'no-store';
  }

  if (body !== undefined && body !== null) {
    if (body instanceof FormData) {
      init.body = body;
    } else {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
  }
  if (method !== 'GET' && method !== 'HEAD') {
    const token = csrfToken();
    if (token) init.headers['X-CSRF-Token'] = token;
  }

  let response;
  try {
    response = await fetch(url, init);
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new ApiError(0, 'network_error', 'Sem conexao com o servidor. Verifique sua internet.', null, null);
  }

  if (response.status === 204) return null;

  const contentType = response.headers.get('content-type') || '';
  if (raw) {
    if (!response.ok) throw await toError(response);
    return response;
  }
  if (!contentType.includes('json')) {
    if (!response.ok) throw await toError(response);
    return response;
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new ApiError(response.status, 'invalid_response', 'Resposta invalida do servidor', null, response.headers.get('X-Request-Id'));
  }

  if (!response.ok) {
    const info = payload?.error || {};
    throw new ApiError(
      response.status,
      info.code || 'unknown_error',
      info.message || `Erro ${response.status}`,
      info.details || null,
      info.request_id || response.headers.get('X-Request-Id'),
    );
  }
  return payload;
}

async function toError(response) {
  let info = {};
  try {
    const text = await response.text();
    const parsed = JSON.parse(text);
    info = parsed?.error || {};
  } catch { /* resposta sem JSON */ }
  return new ApiError(
    response.status,
    info.code || 'unknown_error',
    info.message || `Erro ${response.status}`,
    info.details || null,
    response.headers.get('X-Request-Id'),
  );
}

export const api = {
  get: (path, options) => request('GET', path, options),
  post: (path, body, options) => request('POST', path, { ...options, body }),
  patch: (path, body, options) => request('PATCH', path, { ...options, body }),
  put: (path, body, options) => request('PUT', path, { ...options, body }),
  delete: (path, body, options) => request('DELETE', path, { ...options, body }),
  raw: (path, options) => request('GET', path, { ...options, raw: true }),

  /**
   * Upload real com progresso e cancelamento.
   * @returns {{promise: Promise<any>, abort: () => void}}
   */
  upload(path, { file, data = {}, onProgress, category = 'video' } = {}) {
    const form = new FormData();
    form.append('file', file, file.name || 'arquivo');
    for (const [k, v] of Object.entries(data)) form.append(k, v);

    const xhr = new XMLHttpRequest();
    const url = new URL(path, location.origin);
    const promise = new Promise((resolve, reject) => {
      xhr.open('POST', url.toString(), true);
      xhr.withCredentials = true;
      xhr.setRequestHeader('X-Requested-With', 'upload');
      xhr.setRequestHeader('X-Device-Id', deviceId);
      const token = csrfToken();
      if (token) xhr.setRequestHeader('X-CSRF-Token', token);

      xhr.upload.onprogress = (event) => {
        if (!event.lengthComputable) return;
        onProgress?.(Math.round((event.loaded / event.total) * 100), event.loaded, event.total);
      };
      xhr.onload = () => {
        let payload = null;
        try { payload = JSON.parse(xhr.responseText); } catch { /* nao json */ }
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(payload);
          return;
        }
        const info = payload?.error || {};
        reject(new ApiError(xhr.status, info.code || 'upload_failed', info.message || `Falha no upload (${xhr.status})`, info.details || null, info.request_id || null));
      };
      xhr.onerror = () => reject(new ApiError(0, 'network_error', 'Falha de rede durante o upload'));
      xhr.onabort = () => {
        const err = new ApiError(0, 'upload_cancelled', 'Upload cancelado');
        err.cancelled = true;
        reject(err);
      };
      xhr.send(form);
    });

    return { promise, abort: () => xhr.abort() };
  },

  /** Upload de arquivo binario puro (sem multipart). */
  async uploadBinary(path, { file, mime, onProgress, signal } = {}) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', new URL(path, location.origin).toString(), true);
      xhr.withCredentials = true;
      xhr.setRequestHeader('Content-Type', mime || file.type || 'application/octet-stream');
      xhr.setRequestHeader('X-Requested-With', 'fetch');
      xhr.setRequestHeader('X-Device-Id', deviceId);
      const token = csrfToken();
      if (token) xhr.setRequestHeader('X-CSRF-Token', token);
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) onProgress?.(Math.round((event.loaded / event.total) * 100));
      };
      xhr.onload = () => {
        let payload = null;
        try { payload = JSON.parse(xhr.responseText); } catch { /* nao json */ }
        if (xhr.status >= 200 && xhr.status < 300) { resolve(payload); return; }
        const info = payload?.error || {};
        reject(new ApiError(xhr.status, info.code || 'upload_failed', info.message || `Falha no upload (${xhr.status})`));
      };
      xhr.onerror = () => reject(new ApiError(0, 'network_error', 'Falha de rede durante o upload'));
      xhr.onabort = () => {
        const err = new ApiError(0, 'upload_cancelled', 'Upload cancelado');
        err.cancelled = true;
        reject(err);
      };
      xhr.send(file);
    });
  },
};

export default api;
