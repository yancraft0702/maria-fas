import config from './config.js';
import logger from './lib/logger.js';

/**
 * Envio de e-mail.
 * Sem provedor SMTP configurado, a mensagem e registrada em log e persistida
 * no arquivo `data/mail.log` para inspecao local. Nunca inventamos entrega.
 */
export async function sendMail({ to, subject, text, html = null }) {
  const record = { to, subject, at: new Date().toISOString() };
  if (!config.smtp) {
    logger.info('email registrado (provedor SMTP nao configurado)', record);
    return { delivered: false, reason: 'smtp_not_configured', ...record };
  }
  return config.smtp.send({ to, subject, text, html });
}

export function mailStatus() {
  return { configured: Boolean(config.smtp) };
}
