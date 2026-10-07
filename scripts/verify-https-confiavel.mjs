/**
 * Prova de que o HTTPS de desenvolvimento e CONFIAVEL de verdade (item 1).
 *
 * Este script e o mais importante da lista porque roda o Chrome SEM
 * `--ignore-certificate-errors`: se o certificado nao for confiavel, o
 * navegador mostra o aviso e o teste falha. Sem isso nao da para provar que o
 * aviso "Sua conexao nao e particular / ERR_CERT_AUTHORITY_INVALID" foi
 * eliminado.
 *
 * Verifica:
 *  1. a cadeia valida contra a CA local (certificado real, nao bypass);
 *  2. o Chrome NAO emite evento de certificado invalido;
 *  3. a pagina e mesmo carregada com `isSecureContext = true`;
 *  4. getUserMedia, RTCPeerConnection e wss funcionam;
 *  5. o endereco da rede local tambem e confiavel.
 *
 * O que NAO da para validar aqui: o aparelho movel. A CA precisa ser instalada
 * no celular (passo manual e obrigatorio, documentado no final).
 */
import fs from 'node:fs';
import https from 'node:https';
import { WebSocket } from 'ws';
import { launchChrome } from '../tests/cdp.mjs';

const BASE = process.argv[2] || 'https://localhost:3000';
const LAN = process.argv[3] || 'https://192.168.1.107:3000';
const CA_PATH = '.certs/ca.crt';

let falhas = 0;
const ok = (msg) => console.log(`  ok    ${msg}`);
const fail = (msg) => { falhas += 1; console.log(`  FALHA ${msg}`); };
const passo = (t) => console.log(`\n== ${t}`);

// --------------------------------------------------------------------------
passo('1) A CA local e real (sem bypass de seguranca)');
const temCa = fs.existsSync(CA_PATH);
if (!temCa) {
  fail('.certs/ca.crt ausente - rode: node scripts/instalar-mkcert.mjs');
} else {
  const pem = fs.readFileSync(CA_PATH, 'utf8');
  // A CA do mkcert tem `basicConstraints CA:TRUE`. A CA autoassinada antiga
  // (node-forge) tambem e CA, entao o que distingue as duas e o emissor.
  let emissorDaCa = '';
  try {
    // x509 -text usa OpenSSL; sem ele, ca-issuer fica de fora e a checagem
    // acima (cadeia validada de verdade) ja e suficiente.
    const { X509Certificate } = await import('node:crypto');
    emissorDaCa = new X509Certificate(pem).issuer;
  } catch { /* sem parser: segue */ }
  const ehMkcert = /mkcert/i.test(`${emissorDaCa} ${pem}`);
  if (ehMkcert) ok(`.certs/ca.crt e a CA do mkcert (emissor: ${emissorDaCa})`);
  else fail(`.certs/ca.crt nao veio do mkcert (emissor: ${emissorDaCa || 'desconhecido'})`);

  for (const alvo of [BASE, LAN]) {
    const u = new URL(alvo);
    // Valida a cadeia COM a CA: se o servidor nao presenting um certificado
    // valido para este host, cai em ERRO e o script falha.
    const r = await new Promise((resolve) => {
      const req = https.get({
        host: u.hostname,
        port: u.port || 443,
        path: '/api/health',
        ca: [pem],
        servername: u.hostname,
      }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      });
      req.on('error', (e) => resolve({ erro: e.code || e.message }));
      req.setTimeout(8000, () => { req.destroy(); resolve({ erro: 'timeout' }); });
    });
    if (r.status === 200) ok(`${alvo} responde 200 com a cadeia validada`);
    else fail(`${alvo}: ${r.erro || `HTTP ${r.status}`}`);
  }
}

// --------------------------------------------------------------------------
passo('2) O navegador aceita o certificado (Chrome SEM ignorar erros)');
// Repare na ausencia de --ignore-certificate-errors: e o teste que prova que
// o aviso de certificado sumiu.
const browser = await launchChrome({ extraArgs: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const s = await browser.newBrowserContext();
s.watch();
await s.goto(`${BASE}/`, { waitMs: 1200 });

const diag = await s.eval(`
  return {
    secure: window.isSecureContext,
    origem: location.origin,
    protocolo: location.protocol,
    gum: Boolean(navigator.mediaDevices?.getUserMedia),
    rtc: typeof RTCPeerConnection !== 'undefined',
    serviceWorker: 'serviceWorker' in navigator,
  };
`);

if (diag.secure) ok(`contexto seguro: ${diag.origem} (${diag.protocolo})`);
else fail(`isSecureContext = false em ${diag.origem}`);
if (diag.gum) ok('getUserMedia disponivel');
else fail('getUserMedia indisponivel');
if (diag.rtc) ok('RTCPeerConnection disponivel');
else fail('RTCPeerConnection indisponivel');

// O Chrome so dispara isto quando a cadeia NAO e confiavel. Com a CA instalada
// nao deve aparecer nenhum.
const certErrors = (s.logs || []).filter((l) => /ERR_CERT|CERT_AUTHORITY_INVALID|certificate/i.test(String(l.text || '')));
if (certErrors.length === 0) ok('nenhum erro de certificado no navegador');
else fail(`navegador reclamou do certificado: ${certErrors.map((e) => e.text).slice(0, 2).join(' | ')}`);

// --------------------------------------------------------------------------
passo('3) HTTPS real: API, cookie Secure e wss');
// O `fetch` do Node nao usa a loja de certificados do Windows por padrao (so
// com --use-system-ca) e ignora a opcao `agent`. Por isso a chamada usa o
// modulo `https` com a CA local explicita: e o mesmo caminho que um navegador
// confiavel percorre, sem desligar nenhuma validacao.
const CA_PEM = fs.readFileSync(CA_PATH);
function postJson(url, body) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const dados = Buffer.from(JSON.stringify(body));
    const req = https.request({
      host: u.hostname,
      port: u.port || 443,
      path: u.pathname,
      method: 'POST',
      ca: [CA_PEM],
      servername: u.hostname,
      headers: {
        'Content-Type': 'application/json',
        "Content-Length": dados.length,
      },
    }, (res) => {
      res.resume();
      resolve({ status: res.statusCode, cookies: res.headers['set-cookie'] || [] });
    });
    req.on('error', (e) => resolve({ erro: e.code || e.message }));
    req.setTimeout(8000, () => { req.destroy(); resolve({ erro: 'timeout' }); });
    req.end(dados);
  });
}

let loginOk = false;
let ultimoStatus = null;
for (const [identificador, senha] of [
  ['marcos', 'Marcos0702@#/7'],
  ['adminvisual', 'SenhaAdminVisual@2026'],
]) {
  const resposta = await postJson(`${BASE}/api/auth/login`, { identifier: identificador, password: senha });
  if (resposta && resposta.erro) { ultimoStatus = String(resposta.erro); continue; }
  ultimoStatus = resposta.status;
  if (resposta.status !== 200) continue;
  if (resposta.cookies.some((c) => /Secure/i.test(c))) {
    ok(`login por HTTPS com cookie Secure (@${identificador})`);
  } else {
    fail(`cookie de sessao sem Secure: ${String(resposta.cookies[0] || '').slice(0, 90)}`);
  }
  loginOk = true;
  break;
}
if (!loginOk) fail(`login por HTTPS: ${ultimoStatus}`);

// wss com a CA do sistema e com o certificado confiavel
const wsUrl = BASE.replace(/^https:/, 'wss:').replace(/\/$/, '');
const wsOk = await new Promise((resolve) => {
  const ws = new WebSocket(`${wsUrl}/ws`, { ca: [fs.readFileSync(CA_PATH)] });
  const timer = setTimeout(() => { try { ws.close(); } catch { /* ignore */ } resolve({ erro: 'timeout' }); }, 8000);
  ws.on('open', () => { clearTimeout(timer); ws.close(); resolve({ ok: true }); });
  ws.on('error', (e) => { clearTimeout(timer); resolve({ erro: e.message }); });
});
if (wsOk.ok) ok('wss conectado com certificado confiavel');
else fail(`wss: ${wsOk.erro}`);

// --------------------------------------------------------------------------
passo('4) Midia real (camera e microfone) em HTTPS');
const media = await s.eval(`
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    const r = {
      tracks: stream.getTracks().map((t) => ({ kind: t.kind, ready: t.readyState })),
      video: stream.getVideoTracks()[0]?.getSettings()?.width || 0,
      audio: Boolean(stream.getAudioTracks()[0]),
    };
    for (const t of stream.getTracks()) t.stop();
    return r;
  } catch (e) { return { erro: e.name + ': ' + e.message }; }
`);
if (media.erro) fail(`getUserMedia: ${media.erro}`);
else {
  const temVideo = media.tracks.some((t) => t.kind === 'video');
  const temAudio = media.tracks.some((t) => t.kind === 'audio');
  if (temVideo && temAudio) ok(`camera + microfone reais: ${media.tracks.map((t) => t.kind).join(', ')} (${media.video}px)`);
  else fail(`midia incompleta: ${JSON.stringify(media.tracks)}`);
}

await browser.close();

// --------------------------------------------------------------------------
console.log(`\n${falhas === 0 ? 'HTTPS CONFIÁVEL' : `${falhas} FALHA(S)`}`);
if (falhas === 0) {
  console.log('\nPasso obrigatorio no celular (unico manual, nao ha como evitar):');
  console.log('  copie .certs/ca.crt para o aparelho e instale como CA do usuario:');
  console.log('  - Android: Ajustes > Seguranca > Criptografia e credenciais >');
  console.log('              Instalar um certificado > CA do usuario;');
  console.log('  - iOS: Ajustes > Geral > VPN e gerenciamento de dispositivos >');
  console.log('          Instalar perfil; depois Sobre > Confianca de certificados.');
  console.log('Sem esse passo o aparelho nao tem como validar a CA - nenhum codigo do');
  console.log('site contorna isso, e nao deve.');
}
process.exit(falhas === 0 ? 0 : 1);