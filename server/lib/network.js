/**
 * Enderecos IPv4 da maquina na rede local.
 *
 * Usado no boot para mostrar por qual URL o celular da mesma rede acessa o
 * servidor (item 10) e pelo script de certificado, que precisa cobrir
 * exatamente esses IPs: um certificado so para `localhost` faz o aparelho
 * recusar a pagina em https://192.168.x.x.
 */
import os from 'node:os';

/**
 * @returns {string[]} IPv4 nao internos, sem repeticao, em ordem estavel
 */
export function lanAddresses() {
  const found = new Set();
  for (const infos of Object.values(os.networkInterfaces())) {
    for (const info of infos || []) {
      const family = typeof info.family === 'string' ? info.family : `IPv${info.family}`;
      if (family !== 'IPv4') continue;
      if (info.internal) continue;
      if (!info.address) continue;
      found.add(info.address);
    }
  }
  return [...found].sort();
}

/** O primeiro IPv4 externo (o mais usado na rede local). */
export function primaryLanAddress() {
  return lanAddresses()[0] || null;
}

// O resto do servidor importa os helpers do `lib/` por default; manter os
// dois formatos evita surpresa em quem usa `import network from ...`.
export default { lanAddresses, primaryLanAddress };
