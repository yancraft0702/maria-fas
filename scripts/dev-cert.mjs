/**
 * Gera o CERTIFICADO DE DESENVOLVIMENTO para HTTPS na rede local (item 9).
 *
 * O objetivo e o celular abrir `https://IP-DA-MAQUINA:PORTA` num CONTEXTO
 * SEGURO de verdade: sem HTTPS o `navigator.mediaDevices` nao existe e camera,
 * microfone, WebRTC e LIVE ficam indisponiveis.
 *
 * Duas fontes, nesta ordem de preferencia:
 *
 *  1. mkcert (RECOMENDADO): emite certificado assinado por uma CA local e
 *     mostra onde instalar a CA. Depois de instalar a CA no celular, o
 *     navegador confia no certificado - HTTPS sem avisos.
 *     Instale com: winget install FiloSottile.mkcert   (ou choco install mkcert)
 *
 *  2. Sem mkcert: certificado autoassinado gerado aqui com node-forge
 *     (dependencia opcional, instalada so na hora). Funciona em HTTPS e libera
 *     camera/microfone/WebRTC, mas o aparelho avisa que o certificado nao e
 *     confiavel ate voce aceitar, ou instalar a CA gerada em `.certs/ca.crt`.
 *
 * Os arquivos ficam em `.certs/` (git-ignored): nada disso vai para o frontend
 * nem para o repositorio. O servidor apenas os LE no boot.
 *
 * Uso:
 *   node scripts/dev-cert.mjs            gera (mkcert se existir, senao autoassinado)
 *   node scripts/dev-cert.mjs --force    regenera mesmo se ja existir
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { lanAddresses } from '../server/lib/network.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, '.certs');
const CERT = path.join(DIR, 'dev-cert.pem');
const KEY = path.join(DIR, 'dev-key.pem');
const CA = path.join(DIR, 'ca.crt');
const force = process.argv.includes('--force');

const temMkcert = (() => {
  try {
    execSync('mkcert -version', { stdio: 'ignore', shell: true });
    return true;
  } catch {
    return false;
  }
})();

/** Nomes que o certificado precisa cobrir: localhost + IPv4 da rede local. */
const nomes = [...new Set(['localhost', '127.0.0.1', '::1', ...lanAddresses()])];

/** No SAN, um IP precisa de `type: 7` (iPAddress); hostnames usam `type: 2`. */
const paraSan = (n) => (/^\d+\.\d+\.\d+\.\d+$/.test(n) || n === '::1'
  ? { type: 7, ip: n }
  : { type: 2, value: n });

function portPadrao() {
  try {
    const env = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    const m = env.match(/^PORT=(\d+)/m);
    return m ? m[1] : '3000';
  } catch {
    return '3000';
  }
}

function mostraUso(metodo) {
  const ip = lanAddresses()[0] || 'IP-DA-MAQUINA';
  const porta = portPadrao();
  console.log('\n--- como usar ---');
  console.log('1) Configure o .env:');
  console.log('     TLS_CERT_PATH=.certs/dev-cert.pem');
  console.log('     TLS_KEY_PATH=.certs/dev-key.pem');
  console.log(`     PUBLIC_URL=https://${ip}:${porta}`);
  console.log('2) Suba o servidor:  npm start');
  console.log(`3) No celular, abra: https://${ip}:${porta}`);
  console.log(`   O certificado cobre: ${nomes.join(', ')}`);
  console.log(`   Metodo: ${metodo}`);
}

function instrucoesTelefone(temCa) {
  console.log('\n--- confiar no certificado no celular ---');
  if (temCa) {
    console.log('Copie o arquivo `certs/ca.crt` para o aparelho e instale como CA do usuario:');
    console.log('  Android: Ajustes > Seguranca > Criptografia e credenciais > Instalar um certificado > CA do usuario');
    console.log('  iOS:    instale o perfil (Ajustes > Perfil > Instalar) e depois ative em');
    console.log('           Ajustes > Geral > Sobre > Confianca de certificados');
  } else {
    console.log('O aparelho vai avisar "o certificado nao e confiavel". Avance uma vez em');
    console.log('"Avancado > Continuar para o site": o contexto seguro passa a valer e camera,');
    console.log('microfone e WebRTC funcionam. Para nao ver o aviso, instale `certs/ca.crt`');
    console.log('como CA do usuario no aparelho.');
  }
}

function geraComMkcert() {
  console.log('Gerando com mkcert (certificado assinado por uma CA local)...');
  execSync('mkcert -install', { stdio: 'inherit', shell: true });
  execSync(`mkcert -cert-file "${CERT}" -key-file "${KEY}" ${nomes.join(' ')}`, { stdio: 'inherit', shell: true });
  let temCa = false;
  try {
    const root = execSync('mkcert -CAROOT', { encoding: 'utf8', shell: true }).trim();
    const rootCa = path.join(root, 'rootCA.pem');
    if (fs.existsSync(rootCa)) {
      fs.copyFileSync(rootCa, CA);
      temCa = true;
    }
  } catch {
    // A CA e opcional: sem ela o servidor funciona igual.
  }
  return temCa;
}

async function geraAutoassinado() {
  console.log('mkcert nao encontrado no PATH; gerando certificado autoassinado.');
  console.log('Para HTTPS sem aviso no celular, instale o mkcert:');
  console.log('  winget install FiloSottile.mkcert   (ou)   choco install mkcert');
  console.log('Depois rode este script de novo.\n');

  let forge;
  try {
    const mod = await import('node-forge');
    // node-forge e CommonJS: em ESM chega como `default`.
    forge = mod.default?.pki ? mod.default : mod;
  } catch {
    console.error('node-forge nao esta instalado. Para gerar o certificado autoassinado:');
    console.error('  npm install --no-save node-forge');
    console.error('Ou instale o mkcert (melhor):  winget install FiloSottile.mkcert');
    process.exit(1);
    return false;
  }

  const chaves = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = chaves.publicKey;
  cert.serialNumber = `01${Date.now().toString(16)}`;
  cert.validity.notBefore = new Date(Date.now() - 24 * 60 * 60 * 1000);
  cert.validity.notAfter = new Date(Date.now() + 825 * 24 * 60 * 60 * 1000);
  const nome = { name: 'commonName', value: 'localhost' };
  cert.setSubject([nome]);
  cert.setIssuer([nome]);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true },
    { name: 'keyUsage', keyCertSign: true, digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames: nomes.map(paraSan) },
  ]);
  cert.sign(chaves.privateKey, forge.md.sha256.create());

  fs.writeFileSync(CERT, forge.pki.certificateToPem(cert), 'utf8');
  fs.writeFileSync(KEY, forge.pki.privateKeyToPem(chaves.privateKey), 'utf8');
  fs.writeFileSync(CA, forge.pki.certificateToPem(cert), 'utf8');
  return true;
}

async function main() {
  if (fs.existsSync(CERT) && fs.existsSync(KEY) && !force) {
    console.log(`Certificado ja existe em ${path.relative(ROOT, CERT)} (use --force para regerar).`);
    mostraUso(fs.existsSync(CA) ? 'autoassinado (com CA em certs/ca.crt)' : 'autoassinado');
    instrucoesTelefone(fs.existsSync(CA));
    return;
  }
  fs.mkdirSync(DIR, { recursive: true });
  const temCa = temMkcert ? geraComMkcert() : await geraAutoassinado();
  console.log(`\nCertificado criado em ${path.relative(ROOT, DIR)}/`);
  mostraUso(temMkcert ? 'mkcert (confiavel apos instalar a CA)' : 'autoassinado');
  instrucoesTelefone(temCa);
}

main().catch((err) => {
  console.error('falha ao gerar certificado:', err.message);
  process.exit(1);
});
