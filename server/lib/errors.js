/**
 * Erros de aplicacao com codigo estavel.
 * Regra: nunca mascarar HTTP status. Todo erro devolvido ao cliente tem
 * `code` (estavel, para o frontend) + `message` (humana) + opcionalmente
 * `details`. Erros 500/503 nunca sao convertidos em sucesso.
 */
export class AppError extends Error {
  /**
   * @param {number} status codigo HTTP
   * @param {string} code codigo estavel (snake_case)
   * @param {string} message mensagem legivel
   * @param {object} [options]
   * @param {object} [options.details]
   * @param {Error}  [options.cause]
   * @param {boolean} [options.expose] mensagem visivel ao cliente (default true)
   */
  constructor(status, code, message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.expose = options.expose ?? true;
    this.details = options.details;
    this.expected = status < 500;
  }

  toJSON() {
    const body = { error: { code: this.code, message: this.expose ? this.message : 'Erro interno' } };
    if (this.details) body.error.details = this.details;
    return body;
  }
}

export const badRequest = (code, message, details) => new AppError(400, code, message, { details });
export const unauthorized = (code = 'unauthorized', message = 'Autenticacao necessaria') => new AppError(401, code, message);
export const forbidden = (code = 'forbidden', message = 'Acesso negado') => new AppError(403, code, message);
export const notFound = (code = 'not_found', message = 'Recurso nao encontrado') => new AppError(404, code, message);
export const conflict = (code, message, details) => new AppError(409, code, message, { details });
export const gone = (code, message) => new AppError(410, code, message);
export const payloadTooLarge = (code, message, details) => new AppError(413, code, message, { details });
export const unsupportedMedia = (code, message, details) => new AppError(415, code, message, { details });
export const unprocessable = (code, message, details) => new AppError(422, code, message, { details });
export const tooManyRequests = (code, message, details) => new AppError(429, code, message, { details });
export const internal = (message = 'Erro interno do servidor', cause) =>
  new AppError(500, 'internal_error', message, { cause, expose: false });
export const unavailable = (code, message) => new AppError(503, code, message);
export const gatewayTimeout = (code, message) => new AppError(504, code, message);

/** Erros de validacao de input (400) com lista de campos. */
export class ValidationError extends AppError {
  constructor(fields) {
    const list = Array.isArray(fields)
      ? fields.map((f) => (typeof f === 'string' ? { field: f, message: 'Valor invalido' } : f))
      : Object.entries(fields).map(([field, message]) => ({ field, message }));
    // Item 5: com UM campo invalido a mensagem principal ja e o motivo real
    // ("Usuario deve ter entre 3 e 24 caracteres."). O codigo
    // `validation_failed` continua estavel e `details.fields` mantem a lista.
    const mensagem = list.length === 1 && list[0]?.message ? list[0].message : 'Dados invalidos';
    super(422, 'validation_failed', mensagem, { details: { fields: list } });
    this.name = 'ValidationError';
  }
}
