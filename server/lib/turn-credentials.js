/**
 * Credenciais TURN EFEMERAS (TURN REST API).
 *
 * Item 3: "expiracao/seguranca das credenciais" e "NUNCA colocar segredo
 * permanente no JavaScript".
 *
 * O navegador PRECISA de um usuario e uma senha para falar com o TURN - nao ha
 * como esconder isso. O que se evita e o segredo PERMANENTE: em vez de enviar
 * `TURN_USERNAME`/`TURN_CREDENTIAL` (que valeriam para sempre e apareceriam em
 * qualquer devtools), o backend gera credenciais que expiram em minutos.
 *
 * O formato e o da TURN REST API (usado por coturn com
 * `use-auth-secret`/`static-auth-secret`):
 *
 *   username  = "<timestamp de expiracao em segundos>:<identificador>"
 *   credential = base64( HMAC-SHA1( segredo , username ) )
 *
 * O coturn recalcula o HMAC com o mesmo segredo compartilhado; se bater, a
 * credencial vale ate o timestamp. Logo:
 *  - o segredo NUNCA sai do servidor;
 *  - a credencial que vai ao navegador e de uso unico e curta duracao;
 *  - revogar o segredo invalida todas as credenciais pendentes.
 *
 * Sem `TURN_SECRET` o projeto cai no modo estatico ja existente
 * (`TURN_USERNAME`/`TURN_CREDENTIAL`) - que e o unico modo possivel com um
 * coturn em modo `lt-cred-mech`. A funcao `modoCredencial` diz qual esta em uso,
 * para o diagnostico nunca mentir.
 */
import crypto from 'node:crypto';
import config, { turnUrls } from '../config.js';

/** Segundos de validade por padrao (1 hora). */
export const TTL_PADRAO_SEGUNDOS = 3600;

/**
 * @returns {'efemera'|'estatica'|'nenhum'} como as credenciais sao emitidas
 */
export function modoCredencial() {
  if (config.turnSecret) return 'efemera';
  if (config.turnUsername && config.turnCredential) return 'estatica';
  return 'nenhum';
}

/**
 * Gera uma credencial TURN que expira.
 *
 * @param {object} [opcoes]
 * @param {string} [opcoes.rotulo] identificador do usuario (aparece no log do TURN)
 * @param {number} [opcoes.ttlSegundos] validade
 * @param {Date} [opcoes.agora] injetavel para teste
 * @returns {{username: string, credential: string, expiresAt: number, ttlSeconds: number, modo: string}}
 */
export function credencialTurn({ rotulo = 'app', ttlSegundos = TTL_PADRAO_SEGUNDOS, agora = new Date() } = {}) {
  const segredo = config.turnSecret;
  if (!segredo) {
    // Modo estatico: as credenciais fixas, sem expiracao. E o que da para fazer
    // com um coturn em `lt-cred-mech`; quem pode, deve usar `TURN_SECRET`.
    if (!config.turnUsername || !config.turnCredential) {
      return { username: '', credential: '', expiresAt: 0, ttlSeconds: 0, modo: 'nenhum' };
    }
    return {
      username: config.turnUsername,
      credential: config.turnCredential,
      expiresAt: 0,
      ttlSeconds: 0,
      modo: 'estatica',
    };
  }

  const expiraEm = Math.floor(agora.getTime() / 1000) + Math.max(60, Math.trunc(ttlSegundos));
  // O rotulo vai no usuario: assim da para saber, no log do coturn, qual LIVE
  // usou a credencial - sem expor nada alem do rotulo.
  const username = `${expiraEm}:${String(rotulo).slice(0, 40)}`;
  const credential = crypto
    .createHmac('sha1', segredo)
    .update(username)
    .digest('base64');
  return {
    username,
    credential,
    expiresAt: expiraEm * 1000,
    ttlSeconds: Math.max(60, Math.trunc(ttlSegundos)),
    modo: 'efemera',
  };
}

/**
 * Lista de servidores TURN com credenciais JA VALENDO.
 *
 * Reaproveita o interpretador de `TURN_URL`/`TURN_URLS` do `config.js` (UDP,
 * TCP e TURNS) e troca as credenciais por uma ephemera quando ha segredo.
 *
 * @param {object} [opcoes]
 * @param {string} [opcoes.rotulo]
 * @param {number} [opcoes.ttlSegundos]
 * @returns {{urls: string[], username: string, credential: string, expiresAt: number, modo: string}[]}
 */
export function servidoresTurnComCredencial({ rotulo = 'app', ttlSegundos = TTL_PADRAO_SEGUNDOS } = {}) {
  const base = turnUrls();
  if (!base.length) return [];
  const gerada = credencialTurn({ rotulo, ttlSegundos });
  if (gerada.modo === 'nenhum') return [];
  return base.map((s) => ({
    urls: s.urls,
    username: gerada.username,
    credential: gerada.credential,
    expiresAt: gerada.expiresAt,
    modo: gerada.modo,
  }));
}