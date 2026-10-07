import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import { gzipSync } from 'node:zlib';
import { URL } from 'node:url';
import config, { turnConfigured, giphyConfigured, pushConfigured } from './config.js';
import logger from './lib/logger.js';
import { AppError, notFound, payloadTooLarge, unsupportedMedia, badRequest } from './lib/errors.js';
import { run as dbRun } from './db/index.js';
import { newId } from './lib/ids.js';
import { cors } from './middleware.js';

const MAX_BODY = config.maxVideoBytes + 1024 * 1024;

// --------------------------------------------------------------------------
// Body parsing com limite real. Rejeita MIME desconhecido e corpo gigante.
// --------------------------------------------------------------------------
function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let aborted = false;
    // Respeita Content-Length declarado: recusa antes de consumir o corpo.
    const declared = Number(req.headers['content-length'] || 0);
    if (Number.isFinite(declared) && declared > limit) {
      aborted = true;
      // Nao destroy(): destruir cortaria a conexao e o cliente veria "fetch
      // failed" em vez da resposta 413 com codigo estavel.
      req.resume();
      reject(payloadTooLarge(
        'payload_too_large',
        `Corpo excede o limite de ${Math.floor(limit / 1048576)} MB`,
        { limitBytes: limit, receivedBytes: declared },
      ));
      return;
    }
    req.on('data', (chunk) => {
      if (aborted) return;
      size += chunk.length;
      if (size > limit) {
        aborted = true;
        req.resume();
        reject(payloadTooLarge(
          'payload_too_large',
          `Corpo excede o limite de ${Math.floor(limit / 1048576)} MB`,
          { limitBytes: limit, receivedBytes: size },
        ));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!aborted) resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => {
      if (!aborted) reject(badRequest('request_stream_error', `Falha ao ler requisicao: ${err.message}`));
    });
    req.on('aborted', () => {
      if (!aborted) reject(badRequest('client_aborted', 'Requisicao abortada pelo cliente'));
    });
  });
}

function parseBody(req, raw, contentType) {
  if (!raw.length) return { body: {}, files: {} };
  const ct = (contentType || '').split(';')[0].trim().toLowerCase();
  if (ct === 'application/json' || ct === '') {
    try {
      const parsed = JSON.parse(raw.toString('utf8'));
      return { body: parsed && typeof parsed === 'object' ? parsed : {}, files: {} };
    } catch {
      throw badRequest('invalid_json', 'Corpo JSON invalido');
    }
  }
  if (ct === 'application/x-www-form-urlencoded') {
    const params = new URLSearchParams(raw.toString('utf8'));
    const out = {};
    for (const [k, v] of params) out[k] = v;
    return { body: out, files: {} };
  }
  if (ct === 'multipart/form-data') {
    // Upload real: campos de texto viram body; arquivos ficam em ctx.files
    const { parseMultipart } = parseMultipartModule();
    const parsed = parseMultipart(raw, contentType);
    return { body: parsed.fields, files: parsed.files };
  }
  throw unsupportedMedia('unsupported_content_type', `Content-Type nao suportado: ${ct}`);
}

// Importado sob demanda para evitar ciclo entre http.js e routes/auth.js
let multipartModule = null;
function parseMultipartModule() {
  if (!multipartModule) {
    throw new Error('parseMultipart indisponivel: importe de routes/auth.js antes do uso');
  }
  return multipartModule;
}
export function registerMultipartParser(module) {
  multipartModule = module;
}

/**
 * Servidor HTTP. Um unico lugar que traduz excecao em resposta HTTP real,
 * preservando status e codigo (nunca mascarar 500/503).
 * Também é o unico handler de 'request': faz CORS, sessao, roteamento de API
 * e fallback de arquivos estaticos do PWA (sem duplo consumo do stream).
 */
export function createServer({ router, onRequestEnd, getSocketForUser, serveStatic, loadSession }) {
  // HTTPS real de desenvolvimento: com TLS_CERT_PATH/TLS_KEY_PATH o mesmo
  // handler roda sobre `https.createServer`. O `upgrade` do WebSocket fica
  // igual, entao o cliente passa a falar `wss://` sem nenhuma mudanca no
  // frontend (ele deriva o scheme de `location`).
  const handler = async (req, res) => {
    const startedAt = process.hrtime.bigint();
    const requestId = newId('req');
    res.setHeader('X-Request-Id', requestId);
    // Protocolo real da requisicao (respeita proxy local, se houver).
    const scheme = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim()
      || (config.useTls ? 'https' : 'http');
    let url;
    try {
      url = new URL(req.url, `${scheme}://${req.headers.host || 'localhost'}`);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: { code: 'invalid_url', message: 'URL invalida' } }));
      return;
    }

    try {
      cors(req, res);
    } catch (err) {
      logger.error('falha no CORS', { error: err.message });
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const ctx = {
      requestId,
      method: req.method,
      path: url.pathname,
      url,
      query: Object.fromEntries(url.searchParams.entries()),
      headers: req.headers,
      ip: (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '',
      user: null,
      session: null,
      params: {},
      startedAt,
      cookies: parseCookies(req.headers.cookie),
      files: {},
      log: logger.child({ requestId }),
    };

    const isApi = ctx.path.startsWith('/api/') || ctx.path === '/api';
    const acceptEncoding = String(req.headers['accept-encoding'] || '');
    const wantsGzip = /\bgzip\b/.test(acceptEncoding) && !isMediaStream(ctx.path);
    // Sinaliza para writeJson que a resposta pode ser compactada de verdade.
    res.wantsGzip = wantsGzip;
    const origWrite = res.writeHead.bind(res);
    res.writeHead = (status, headers) => {
      const h = { ...headers };
      if (h['Content-Encoding']) return origWrite(status, h);
      if (wantsGzip && typeof h['Content-Type'] === 'string' && isJson(h['Content-Type'])) {
        h.Vary = 'Accept-Encoding';
      }
      // Cabecalhos de seguranca aplicados em TODAS as respostas (API e PWA),
      // sem sobrescrever o que o handler ja definiu.
      h['X-Content-Type-Options'] = h['X-Content-Type-Options'] || 'nosniff';
      h['Referrer-Policy'] = h['Referrer-Policy'] || 'strict-origin-when-cross-origin';
      h['X-Frame-Options'] = h['X-Frame-Options'] || 'DENY';
      h['Content-Security-Policy'] = h['Content-Security-Policy'] || CSP;
      h['Permissions-Policy'] = h['Permissions-Policy'] || PERMISSIONS_POLICY;
      h['Cross-Origin-Opener-Policy'] = h['Cross-Origin-Opener-Policy'] || 'same-origin';
      return origWrite(status, h);
    };

    try {
      loadSession?.(ctx);

      if (!isApi) {
        // PWA / SPA fallback
        if (serveStatic) {
          await serveStatic(ctx, res);
          if (res.writableEnded || res.headersSent) {
            return;
          }
        }
        throw notFound('route_not_found', `Rota nao encontrada: ${req.method} ${ctx.path}`);
      }

      const needsBody = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
      if (needsBody) {
        const raw = await readBody(req);
        ctx.rawBody = raw;
        const parsed = parseBody(req, raw, req.headers['content-type']);
        ctx.body = parsed.body;
        ctx.files = parsed.files;
      } else {
        ctx.body = {};
        ctx.files = {};
      }

      const match = router.find(req.method, ctx.path);
      if (!match) throw notFound('route_not_found', `Rota nao encontrada: ${req.method} ${ctx.path}`);
      ctx.params = match.params;
      ctx.route = match.route;
      ctx.getSocketForUser = getSocketForUser;
      await match.route.handler(ctx, res);
      if (!res.writableEnded && !res.headersSent) {
        throw new AppError(500, 'handler_did_not_respond', 'Handler nao respondeu');
      }
    } catch (err) {
      handleError(err, ctx, res);
    } finally {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      const status = res.statusCode || 0;
      try {
        onRequestEnd?.(ctx, status, durationMs);
      } catch (auditErr) {
        logger.error('falha ao auditar requisicao', { requestId, error: auditErr.message });
      }
      if (status >= 400) {
        // 503 por dependencia externa nao configurada (GIF), 429 por rate
        // limit e 401/403 sao respostas honestas do contrato, nao falha do
        // servidor: ficam em debug para nao poluir o log de operacao.
        const expected = status === 503 || status === 429 || status === 401 || status === 403;
        const emit = expected ? logger.debug.bind(logger) : logger.warn.bind(logger);
        emit(`${req.method} ${ctx.path} -> ${status}`, {
          requestId,
          user: ctx.user?.id ?? null,
          durationMs: Math.round(durationMs),
        });
      } else {
        logger.debug(`${req.method} ${ctx.path} -> ${status}`, {
          requestId,
          user: ctx.user?.id ?? null,
          durationMs: Math.round(durationMs),
        });
      }
    }
  };

  // HTTPS real quando ha certificado configurado; caso contrario, HTTP puro.
  let server;
  if (config.useTls) {
    try {
      server = https.createServer(tlsOptions(), handler);
    } catch (err) {
      logger.error('TLS configurado mas nao pode ser lido; caindo para HTTP', {
        cert: config.tlsCertPath,
        key: config.tlsKeyPath,
        error: err.message,
      });
      server = http.createServer(handler);
    }
  } else {
    server = http.createServer(handler);
  }

  server.headersTimeout = 30_000;
  server.requestTimeout = 0;
  server.keepAliveTimeout = 72_000;
  server.maxRequestsPerSocket = 0;
  return server;
}

/**
 * Materiais do TLS de desenvolvimento. O certificado e a chave ficam em
 * `.certs/` (fora do frontend e fora do versionamento) e so o servidor os
 * le. `ca` e opcional e so e enviado quando o certificado foi emitido por uma
 * CA local (mkcert), para o aparelho da rede local validar a cadeia.
 */
function tlsOptions() {
  const options = {
    cert: fs.readFileSync(config.tlsCertPath),
    key: fs.readFileSync(config.tlsKeyPath),
  };
  if (config.tlsCaPath) {
    try {
      options.ca = fs.readFileSync(config.tlsCaPath);
    } catch (err) {
      logger.warn('TLS_CA_PATH nao pode ser lido; seguindo sem a cadeia', { path: config.tlsCaPath, error: err.message });
    }
  }
  if (config.tlsPassphrase) options.passphrase = config.tlsPassphrase;
  return options;
}

function isJson(contentType) {
  return contentType.includes('json') || contentType.includes('javascript') || contentType.includes('manifest');
}

/**
 * CSP da aplicacao.
 * - `script-src 'self'` SEM 'unsafe-inline' e SEM 'unsafe-eval': nenhum
 *   script inline e aceito. A unica excecao externa e a IFrame API oficial do
 *   YouTube (exigida pelo mini-player); `frame-src` permite o player e
 *   `connect-src` o trafego dele. Nenhum outro host.
 * - `blob:` em media/img e necessario para WebRTC (MediaStream em <video>)
 *   e para WebGL dos efeitos da LIVE.
 */
const YT_ORIGIN = 'https://www.youtube.com https://www.youtube-nocookie.com';
/**
 * CDN do GIPHY. Sem estes hosts a API respondia 200 mas TODA imagem era
 * bloqueada pelo navegador (imagem quebrada no seletor de GIF/sticker).
 * A chave continua no servidor; aqui so os hosts publicos de entrega de
 * midia. A CSP nao aceita curinga em host, entao eles sao listados.
 */
const GIPHY_MEDIA = [
  'https://i.giphy.com',
  'https://media.giphy.com',
  ...Array.from({ length: 8 }, (_, i) => `https://media${i}.giphy.com`),
].join(' ');
const CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  `script-src 'self' ${YT_ORIGIN}`,
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: blob: https://i.ytimg.com https://yt3.ggpht.com ${GIPHY_MEDIA}`,
  `media-src 'self' blob: https://www.youtube.com ${GIPHY_MEDIA}`,
  "connect-src 'self' ws: wss: https://www.youtube.com",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  `frame-src 'self' ${YT_ORIGIN}`,
].join('; ');

const PERMISSIONS_POLICY = [
  'camera=(self)',
  'microphone=(self)',
  'geolocation=()',
  'payment=()',
  'usb=()',
].join(', ');

function isMediaStream(pathname) {
  return pathname.startsWith('/api/media/');
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (!k) continue;
    try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
  }
  return out;
}

function handleError(err, ctx, res) {
  if (res.headersSent || res.writableEnded) {
    if (!res.writableEnded) res.end();
    return;
  }
  const requestId = ctx.requestId;
  if (err instanceof AppError) {
    const payload = err.toJSON();
    payload.error.request_id = requestId;
    if (err.status >= 500) {
      logger.error(err.message, { requestId, code: err.code, stack: err.stack, cause: err.cause?.message });
    }
    writeJson(res, err.status, payload);
    return;
  }
  logger.error('erro nao tratado', {
    requestId,
    message: err?.message,
    name: err?.name,
    stack: err?.stack,
    path: ctx.path,
  });
  writeJson(res, 500, {
    error: {
      code: 'internal_error',
      message: 'Erro interno do servidor',
      request_id: requestId,
    },
  });
}

/**
 * Envia JSON. Compacta de verdade quando o cliente aceita gzip e o corpo
 * passa do limite. Nunca anuncia `Content-Encoding` sem compactar.
 */
export function writeJson(res, status, payload, extraHeaders = {}) {
  const raw = Buffer.from(JSON.stringify(payload), 'utf8');
  const canCompress = res.wantsGzip && raw.length >= 1024
    && !extraHeaders['Content-Encoding'];
  const body = canCompress ? gzipSync(raw, { level: 6 }) : raw;

  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    ...extraHeaders,
  };
  if (canCompress) {
    headers['Content-Encoding'] = 'gzip';
    headers.Vary = 'Accept-Encoding';
  }
  res.writeHead(status, headers);
  res.end(body);
}

export function sendJson(ctx, res, status, payload, extraHeaders) {
  writeJson(res, status, payload, extraHeaders);
}

export { dbRun, config, turnConfigured, giphyConfigured, pushConfigured };
