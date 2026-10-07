/**
 * Instala o mkcert (CA local CONFIAVEL) sem depender de administrador.
 *
 * Por que direto do GitHub e nao pelo chocolatey: o chocolatey exige prompt
 * elevado, e `mkcert` e um binario Go unico - basta baixar o `.exe`. O
 * `mkcert -install` grava a CA na loja de certificados do USUARIO
 * (`CurrentUser\Root`), que nao exige elevacao.
 *
 * O que acontece:
 *  1. baixa o mkcert-win-amd64 das releases oficiais;
 *  2. `mkcert -install`: cria a CA e a adiciona as lojas confiaveis do
 *     usuario - e o que faz o navegador deste PC aceitar o HTTPS sem
 *     "Avancado > Continuar";
 *  3. gera o certificado de `localhost`, `127.0.0.1`, `::1` e do IP da rede
 *     local em `.certs/`;
 *  4. copia a CA para `.certs/ca.crt` (arquivo .git-ignored) para instalar no
 *     celular.
 *
 * Nao e gambiarra de frontend: e a CA de verdade, gerada pela ferramenta
 * padrao do ecossistema WebRTC/localhost.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';

const RAIZ = process.cwd();
const BIN_DIR = path.join(os.homedir(), 'bin', 'mkcert');
const MKCERT = path.join(BIN_DIR, 'mkcert.exe');
const RELEASE = 'v1.4.4';
const ASSETS = {
  'win/amd64': `https://github.com/FiloSottile/mkcert/releases/download/${RELEASE}/mkcert-${RELEASE}-windows-amd64.exe`,
  'win/arm64': `https://github.com/FiloSottile/mkcert/releases/download/${RELEASE}/mkcert-${RELEASE}-windows-arm64.exe`,
};

const log = (m) => console.log(m);
const passo = (m) => console.log(`\n=== ${m}`);

function baixar(url, destino, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('muitos redirecionamentos'));
    const arquivo = fs.createWriteStream(destino);
    https.get(url, { headers: { 'User-Agent': 'pulse-dev-setup' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        arquivo.close();
        const proximo = res.headers.location.startsWith('http')
          ? res.headers.location
          : `https://github.com${res.headers.location}`;
        return baixar(proximo, destino, redirects + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        arquivo.close();
        return reject(new Error(`HTTP ${res.statusCode} em ${url}`));
      }
      res.pipe(arquivo);
      arquivo.on('finish', () => arquivo.close(() => resolve(destino)));
    }).on('error', (err) => { arquivo.close(); reject(err); });
  });
}

function ipLan() {
  const nets = os.networkInterfaces();
  for (const nome of Object.keys(nets)) {
    for (const net of nets[nome] || []) {
      if (net.family !== 'IPv4' || net.internal) continue;
      if (net.address.startsWith('169.254.')) continue;
      return net.address;
    }
  }
  return '127.0.0.1';
}

function mkcertExiste() { return fs.existsSync(MKCERT); }

async function main() {
  const ip = ipLan();
  log(`IP da rede local: ${ip}`);

  passo('1) Binario do mkcert');
  if (mkcertExiste()) {
    log(`ja existe em ${MKCERT}`);
  } else {
    fs.mkdirSync(BIN_DIR, { recursive: true });
    const chave = os.arch() === 'arm64' ? 'win/arm64' : 'win/amd64';
    const url = ASSETS[chave];
    log(`baixando ${url}`);
    await baixar(url, MKCERT);
    log(`baixado (${(fs.statSync(MKCERT).size / 1048576).toFixed(1)} MB)`);
  }

  const versao = spawnSync(MKCERT, ['-version'], { encoding: 'utf8', timeout: 60000 });
  if (versao.status !== 0) throw new Error('mkcert nao executa nesta maquina');
  log((versao.stdout || '').trim());

  passo('2) CA local confiavel');
  // `-install` cria a CA e a registra na loja do USUARIO (sem admin) e, se
  // houver ferramenta, tenta tambem iOS e Android. Rodar de novo e seguro.
  const instalar = spawnSync(MKCERT, ['-install'], { encoding: 'utf8', stdio: 'inherit', timeout: 300000 });
  if (instalar.status !== 0) throw new Error('mkcert -install falhou');
  const ca = spawnSync(MKCERT, ['-CAROOT'], { encoding: 'utf8' });
  const caRoot = (ca.stdout || '').trim();
  log(`CAROOT: ${caRoot}`);

  passo('3) Certificado do servidor');
  const certsDir = path.join(RAIZ, '.certs');
  fs.mkdirSync(certsDir, { recursive: true });
  const certFile = path.join(certsDir, 'dev-cert.pem');
  const keyFile = path.join(certsDir, 'dev-key.pem');
  const gerar = spawnSync(
    MKCERT,
    ['-cert-file', certFile, '-key-file', keyFile, 'localhost', '127.0.0.1', '::1', ip],
    { encoding: 'utf8', stdio: 'inherit', timeout: 120000 },
  );
  if (gerar.status !== 0) throw new Error('geracao do certificado falhou');

  passo('4) CA para o celular');
  const caCrt = path.join(certsDir, 'ca.crt');
  const origem = path.join(caRoot, 'rootCA.pem');
  if (fs.existsSync(origem)) {
    fs.copyFileSync(origem, caCrt);
    log(`copiada para ${path.relative(RAIZ, caCrt)}`);
  } else {
    log(`AVISO: ${origem} nao encontrado`);
  }

  passo('Pronto');
  log('PC    : a CA foi instalada na loja de certificados do usuario.');
  log('        Chrome/Edge aceitam https://localhost e https://' + ip + ' sem aviso.');
  log('Celular: instale .certs/ca.crt como CA do usuario no aparelho.');
  log('        Android: Ajustes > Seguranca > Criptografia e credenciais >');
  log('                 Instalar um certificado > CA do usuario.');
  log('        iOS: Ajustes > Geral > VPN e gerenciamento de dispositivos >');
  log('             Instalar perfil; depois em Sobre > Confianca de certificados.');
  log('');
  log('Reinicie o servidor (npm start) para ele usar o novo certificado.');
  console.log('');
}

main().catch((err) => {
  console.error('\nfalhou:', err.message);
  process.exit(1);
});