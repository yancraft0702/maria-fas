/**
 * Verifica o HTTPS real de desenvolvimento (itens 9 e 10):
 * - TLS na porta configurada e certificado com o IP da rede local
 * - API e assets servidos por HTTPS (sem mixed content)
 * - cookie de sessao com `Secure`
 * - WebSocket em wss://
 * - acesso pelo endereco da rede local
 * - no navegador: contexto seguro, getUserMedia e WebRTC
 *
 * O certificado de desenvolvimento e autoassinado (quando o mkcert nao esta
 * instalado), entao as checagens HTTP deste script desligam a validacao de
 * CA do Node. A cadeia em si e verificada logo abaixo com `tls.connect`
 * usando o arquivo `.certs/ca.crt` - o mesmo que o celular instala.
 */
import fs from 'node:fs';
import tls from 'node:tls';
import { WebSocket } from 'ws';
import { sleep } from '../tests/helpers.mjs';
import { launchChrome } from '../tests/cdp.mjs';

const BASE = process.argv[2] || 'https://localhost:3000';
const LAN = process.argv[3] || 'https://192.168.1.106:3000';
const CA_PATH = '.certs/ca.crt';
const temCa = fs.existsSync(CA_PATH);

let falhas = 0;
const ok = (msg) => console.log(`  OK   ${msg}`);
const fail = (msg) => { console.log(`  FALHA ${msg}`); falhas += 1; };
const passo = (t) => console.log(`\n=== ${t} ===`);

passo('HTTPS (TLS na porta)');

// 1) Handshake TLS + nome no certificado
const handshake = await new Promise((resolve) => {
  const socket = tls.connect({ host: 'localhost', port: 3000, rejectUnauthorized: false, servername: 'localhost' }, () => {
    const cert = socket.getPeerCertificate();
    socket.end();
    resolve({ ok: true, subject: cert?.subject, alt: cert?.subjectaltname });
  });
  socket.on('error', (e) => resolve({ ok: false, erro: e.message }));
  setTimeout(() => resolve({ ok: false, erro: 'timeout' }), 5000);
});
if (handshake.ok && handshake.subject) ok(`TLS ok; CN=${handshake.subject.CN}`);
else fail(`TLS: ${handshake.erro || 'sem certificado'}`);

if (temCa) {
  const valido = await new Promise((resolve) => {
    const socket = tls.connect({
      host: 'localhost',
      port: 3000,
      ca: [fs.readFileSync(CA_PATH)],
      servername: 'localhost',
    }, () => { socket.end(); resolve(true); });
    socket.on('error', () => resolve(false));
    setTimeout(() => resolve(false), 5000);
  });
  if (valido) ok('certificado validado pela CA local (.certs/ca.crt)');
  else fail('a CA local nao valida o certificado do servidor');
} else {
  console.log('  (sem .certs/ca.crt: pulei a validacao de cadeia)');
}

const lanIp = LAN.replace(/^https:\/\//, '').replace(/:\d+$/, '');
if (handshake.alt && String(handshake.alt).includes(lanIp)) {
  ok(`certificado cobre o IP da rede local (${lanIp})`);
} else {
  fail(`certificado NAO cobre ${lanIp} - regere com: node scripts/dev-cert.mjs --force (SAN: ${handshake.alt})`);
}

// 2) API, cookies e assets por HTTPS
const http = await import('node:http');
const antigoFetch = globalThis.fetch;
// Certificado local: a validacao de CA do Node fica desligada só aqui (o
// navegador recebe a CA de outra forma, ver abaixo).
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

passo('API, cookies e assets por HTTPS');

const login = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ identifier: 'marcos', password: 'Marcos0702@#/7' }),
});
if (login.status === 200) ok(`POST /api/auth/login por HTTPS -> HTTP ${login.status}`);
else fail(`login por HTTPS -> HTTP ${login.status}`);

const cookies = login.headers.getSetCookie();
const sessao = cookies.find((c) => /session/i.test(c));
if (sessao && /;\s*Secure/i.test(sessao)) ok('cookie de sessao com Secure');
else fail(`cookie de sessao sem Secure: ${(sessao || '(nenhum)').slice(0, 80)}`);

const html = await (await fetch(BASE)).text();
const assetsHttp = [...html.matchAll(/(?:src|href)="http:\/\/[^"]+/g)].map((m) => m[0]);
if (assetsHttp.length === 0) ok('nenhum asset absoluto em http:// (sem mixed content)');
else fail(`assets em http://: ${assetsHttp.join(', ')}`);

for (const asset of ['/js/main.js', '/css/app.css', '/manifest.webmanifest']) {
  const r = await fetch(`${BASE}${asset}`);
  if (r.ok) ok(`asset ${asset} -> HTTP ${r.status}`);
  else fail(`asset ${asset} -> HTTP ${r.status}`);
}

// 3) WebSocket em wss://
passo('WebSocket');
const wsUrl = `${BASE.replace(/^http/, 'ws')}/ws`;
const wssOk = await new Promise((resolve) => {
  const socket = new WebSocket(wsUrl, { rejectUnauthorized: false });
  const fim = setTimeout(() => { socket.close(); resolve(false); }, 6000);
  socket.on('open', () => { clearTimeout(fim); socket.close(); resolve(true); });
  socket.on('error', () => { clearTimeout(fim); resolve(false); });
});
if (wssOk) ok(`wss conectado: ${wsUrl}`);
else fail(`wss nao conectou: ${wsUrl}`);

// 4) Endereco da rede local
passo('Rede local');
const lan = await fetch(`${LAN}/api/health`).catch(() => null);
if (lan?.ok) ok(`${LAN}/api/health -> HTTP ${lan.status}`);
else fail(`sem acesso em ${LAN} (firewall do Windows ou bind)`);

// 5) Navegador: contexto seguro + camera/microfone/WebRTC
passo('Navegador em HTTPS');
const browser = await launchChrome({ extraArgs: ['--ignore-certificate-errors'] });
const s = await browser.newBrowserContext();
s.watch();
await s.goto(`${BASE}/entrar`, { waitMs: 2500 });

const suporte = await s.eval(`
  return {
    origem: location.origin,
    seguro: window.isSecureContext,
    gum: Boolean(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
    rtc: Boolean(window.RTCPeerConnection),
    httpAbsoluto: performance.getEntriesByType('resource')
      .filter((r) => r.name.startsWith('http://')).map((r) => r.name).slice(0, 3),
  };
`);
if (suporte.origem.startsWith('https://')) ok(`pagina servida em ${suporte.origem}`);
else fail(`origem nao e https: ${suporte.origem}`);
if (suporte.seguro) ok('window.isSecureContext = true');
else fail('isSecureContext = false');
if (suporte.gum) ok('navigator.mediaDevices.getUserMedia disponivel');
else fail('getUserMedia indisponivel');
if (suporte.rtc) ok('RTCPeerConnection disponivel');
else fail('RTCPeerConnection indisponivel');
if (suporte.httpAbsoluto.length === 0) ok('nenhuma requisicao http:// em pagina https://');
else fail(`mixed content: ${suporte.httpAbsoluto.join(', ')}`);

// getUserMedia pode demorar: dispara e consulta depois, como no app.
await s.eval(`
  window.__gum = { estado: 'pendente' };
  (async () => {
    if (!navigator.mediaDevices?.getUserMedia) { window.__gum = { erro: 'sem getUserMedia' }; return; }
    try {
      const st = await navigator.mediaDevices.getUserMedia({ video: { width: 480, height: 854 }, audio: true });
      const v = st.getVideoTracks()[0];
      const a = st.getAudioTracks()[0];
      window.__gum = { estado: 'ok', video: Boolean(v), audio: Boolean(a), s: v ? v.getSettings() : null };
      st.getTracks().forEach((t) => t.stop());
    } catch (e) {
      window.__gum = { erro: e.name + ': ' + e.message };
    }
  })();
  return true;
`);
let stream = null;
for (let i = 0; i < 30 && !stream; i += 1) {
  stream = await s.eval('return window.__gum && window.__gum.estado !== "pendente" ? window.__gum : null;');
  if (!stream) await sleep(500);
}
if (!stream) fail('getUserMedia nao respondeu');
else if (stream.erro) fail(`getUserMedia: ${stream.erro}`);
else ok(`getUserMedia: video=${stream.video} audio=${stream.audio} ${stream.s?.width}x${stream.s?.height}`);

await browser.close();
void http;
void antigoFetch;
console.log(falhas === 0 ? '\nHTTPS de desenvolvimento verificado' : `\n${falhas} verificacao(oes) falharam`);
process.exit(falhas === 0 ? 0 : 1);
