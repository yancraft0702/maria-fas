import { get } from '../db/index.js';
import config, { giphyConfigured } from '../config.js';
import { unavailable, badRequest, unprocessable } from '../lib/errors.js';
import logger from '../lib/logger.js';

/**
 * Proxy oficial do GIPHY. A chave existe SOMENTE no backend
 * (GIPHY_API_KEY). Sem chave configurada a rota responde 503 com codigo
 * estavel - nunca devolve dados falsos.
 */
const GIPHY_RATINGS = ['g', 'pg', 'pg-13', 'r'];
const LANGUAGES = new Set(['pt', 'en', 'es', 'fr', 'de', 'it', 'ja', 'ko', 'zh-CN', 'ru']);

/**
 * Valida que o servico esta configurado. Usada por todas as rotas de GIF.
 * Sem GIPHY_API_KEY a resposta e 503 com codigo estavel - nunca dados falsos.
 */
export function assertConfigured() {
  if (!giphyConfigured()) {
    throw unavailable(
      'gif_provider_not_configured',
      'Servico de GIF nao configurado. Defina GIPHY_API_KEY no servidor (.env) para habilitar GIFs e stickers.',
    );
  }
}

function sanitizeRating(value) {
  if (!value) return 'pg';
  const v = String(value).toLowerCase();
  if (!GIPHY_RATINGS.includes(v)) {
    throw badRequest('invalid_giphy_rating', `Rating invalido: ${value}`);
  }
  return v;
}

async function giphyFetch(pathname, params = {}) {
  assertConfigured();
  const url = new URL(pathname, config.giphyBaseUrl);
  url.searchParams.set('api_key', config.giphyApiKey);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
    if (res.status === 429) {
      throw unavailable('giphy_rate_limited', 'Limite do GIPHY atingido. Tente novamente em instantes.');
    }
    if (res.status === 401 || res.status === 403) {
      logger.error('GIPHY rejeitou a chave', { status: res.status });
      throw unavailable('giphy_unauthorized', 'GIPHY_API_KEY invalida ou expirada.');
    }
    if (!res.ok) {
      throw unavailable('giphy_error', `GIPHY respondeu ${res.status}`);
    }
    const json = await res.json();
    return json;
  } catch (err) {
    if (err.status) throw err;
    if (err.name === 'AbortError') {
      throw unavailable('giphy_timeout', 'Tempo esgotado aguardando o GIPHY.');
    }
    throw unavailable('giphy_unreachable', `Nao foi possivel contatar o GIPHY: ${err.message}`);
  } finally {
    clearTimeout(timeout);
  }
}

function mapGif(item, kind) {
  const fixed = item.images?.fixed_width || item.images?.fixed_height_small || item.images?.original || {};
  const preview = item.images?.preview_gif || fixed;
  return {
    id: item.id,
    kind,
    title: item.title || '',
    url: fixed.url || item.url,
    previewUrl: preview.url || fixed.url || item.url,
    width: Number(fixed.width) || 0,
    height: Number(fixed.height) || 0,
    downsizedUrl: item.images?.downsized_medium?.url || fixed.url || item.url,
    mp4Url: item.images?.downsized_medium?.mp4 || null,
  };
}

export async function searchGifs({ query, offset = 0, limit = 24, rating = 'pg', language = 'pt', kind = 'gifs' }) {
  const lang = LANGUAGES.has(language) ? language : 'pt';
  const json = await giphyFetch(`/v1/${kind}/search`, {
    q: query || '',
    limit: Math.min(50, Math.max(1, Number(limit) || 24)),
    offset: Math.max(0, Number(offset) || 0),
    rating: sanitizeRating(rating),
    lang: lang,
  });
  return {
    items: (json.data || []).map((item) => mapGif(item, kind === 'stickers' ? 'sticker' : 'gif')),
    total: json.meta?.total ?? (json.data || []).length,
    offset: json.meta?.offset ?? offset,
  };
}

export async function trendingGifs({ limit = 24, rating = 'pg', language = 'pt', kind = 'gifs' }) {
  const lang = LANGUAGES.has(language) ? language : 'pt';
  const json = await giphyFetch(`/v1/${kind}/trending`, {
    limit: Math.min(50, Math.max(1, Number(limit) || 24)),
    rating: sanitizeRating(rating),
    lang: lang,
  });
  return { items: (json.data || []).map((item) => mapGif(item, kind === 'stickers' ? 'sticker' : 'gif')) };
}

export async function gifById(id) {
  const json = await giphyFetch(`/v1/gifs/${encodeURIComponent(id)}`);
  if (!json.data?.length) throw unprocessable('gif_not_found', 'GIF nao encontrado');
  return mapGif(json.data[0], 'gif');
}

/** Traducoes de reacao por palavra (para stickers). */
export async function translateGif({ term, language = 'pt' }) {
  const lang = LANGUAGES.has(language) ? language : 'pt';
  const json = await giphyFetch('/v1/gifs/translate', { s: term, lang, weirdness: 0 });
  return (json.data || []).map((item) => mapGif(item, 'gif'));
}

export function giphyStatus() {
  return {
    configured: giphyConfigured(),
    // NUNCA devolve a chave; apenas confirma se existe no servidor.
    keyPresent: giphyConfigured(),
    baseUrl: config.giphyBaseUrl,
  };
}

/**
 * Baixa os bytes de um GIF diretamente do host oficial do GIPHY.
 * Usado para persistir o GIF no nosso proprio storage (o chat nunca depende
 * de CDN de terceiros em tempo de exibicao).
 */
export async function fetchGifBytes(url, { maxBytes = 8 * 1024 * 1024 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    if (!res.ok) {
      throw unavailable('gif_download_failed', `GIPHY respondeu ${res.status} ao baixar o GIF`);
    }
    const lengthHeader = Number(res.headers.get('content-length') || 0);
    if (lengthHeader && lengthHeader > maxBytes) {
      throw unprocessable('gif_too_large', 'GIF excede o tamanho permitido');
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > maxBytes) {
      throw unprocessable('gif_too_large', 'GIF excede o tamanho permitido');
    }
    return buffer;
  } catch (err) {
    if (err.status) throw err;
    if (err.name === 'AbortError') throw unavailable('gif_timeout', 'Tempo esgotado ao baixar o GIF');
    throw unavailable('gif_download_failed', `Falha ao baixar o GIF: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}
