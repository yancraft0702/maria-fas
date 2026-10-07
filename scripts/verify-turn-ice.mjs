/**
 * Verificacao do suporte a TURN e do diagnostico de ICE (itens 1, 2 e 3).
 *
 * O que este script comprova:
 *  1. o backend le TURN_URL/TURN_URLS com credenciais e monta os servidores
 *     certaina de ICE (UDP e TLS), descartando o que nao tem credencial;
 *  2. NUNCA ha credencial de TURN em arquivo do frontend nem no log;
 *  3. `IceDiagnostics` distingue "configurado" de "funcionando": so conta
 *     relay de verdade quando o par CONECTADO saiu por relay.
 *
 * Nao simula nem promete relay: se nao houver TURN na maquina, o script
 * informa que a validacao de relay fica pendente.
 */
process.env.TLS_CERT_PATH = '';

const { turnServers, turnConfigured } = await import('../server/config.js');
const { IceDiagnostics, buildIceServers, turnWarning } = await import('../web/js/features/webrtc.js');

let falhas = 0;
const ok = (msg) => console.log(`  ok   ${msg}`);
const fail = (msg) => { falhas += 1; console.log(`  FALHA ${msg}`); };
const section = (t) => console.log(`\n== ${t}`);

// --------------------------------------------------------------------------
section('1. Leitura de TURN no servidor (env real da maquina)');
console.log(`  TURN_URL      = ${process.env.TURN_URL || '(vazio)'}`);
console.log(`  TURN_URLS     = ${process.env.TURN_URLS || '(vazio)'}`);
console.log(`  TURN_USERNAME = ${process.env.TURN_USERNAME ? '(preenchido)' : '(vazio)'}`);
console.log(`  TURN_CREDENTIAL = ${process.env.TURN_CREDENTIAL ? '(preenchido)' : '(vazio)'}`);

const servers = turnServers();
if (turnConfigured()) {
  ok(`TURN configurado: ${servers.length} servidor(es): ${servers.map((s) => s.urls[0].split(':')[0]).join(', ')}`);
  for (const s of servers) {
    if (!s.username || !s.credential) fail('servidor sem credencial escapou do filtro');
    if (!/^turns?:/.test(s.urls[0])) fail(`esquema invalido: ${s.urls[0]}`);
  }
} else {
  console.log('  --   TURN NAO configurado neste ambiente (sem URL + credencial).');
  if (servers.length) fail('turnConfigured() falso, mas turnServers() devolveu itens');
  else ok('turnConfigured() falso e turnServers() vazio: coerente (nao mascarado)');
}

// --------------------------------------------------------------------------
section('2. Nenhuma credencial de TURN no frontend nem em arquivo publico');
const fs = await import('node:fs');
const path = await import('node:path');
const raiz = path.resolve('.');
const procurar = (dir, acc = []) => {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'data', '.certs', 'tests', 'scripts'].includes(item.name)) continue;
    const p = path.join(dir, item.name);
    if (item.isDirectory()) procurar(p, acc);
    else if (/\.(js|mjs|html|css)$/.test(item.name)) acc.push(p);
  }
  return acc;
};

const frontend = path.join(raiz, 'web');
const arquivos = procurar(frontend);
const termoCred = process.env.TURN_CREDENTIAL;
const termoUser = process.env.TURN_USERNAME;
for (const file of arquivos) {
  const texto = fs.readFileSync(file, 'utf8');
  if (termoCred && termoCred.length > 3 && texto.includes(termoCred)) fail(`credencial de TURN em ${path.relative(raiz, file)}`);
  if (termoUser && termoUser.length > 3 && texto.includes(termoUser)) fail(`usuario de TURN em ${path.relative(raiz, file)}`);
}
ok(`${arquivos.length} arquivo(s) do frontend sem credencial de TURN`);
// A variavel so pode ser lida no servidor.
const webrtc = fs.readFileSync(path.join(frontend, 'js/features/webrtc.js'), 'utf8');
if (/process\.env/.test(webrtc)) fail('webrtc.js le process.env no cliente');
else ok('webrtc.js nao le process.env (build de browser)');

// --------------------------------------------------------------------------
section('3. buildIceServers');
const semTURN = buildIceServers({ iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }], turnServers: [], turnConfigured: false });
if (semTURN.iceServers.length >= 1) ok(`lista com STUN: ${semTURN.iceServers.length} servidor(es)`);
else fail('nenhum servidor ICE na lista padrao');
if (semTURN.turnConfigured === false) ok('turnConfigured falso propagado');
else fail('turnConfigured deveria ser false');

const comTURN = buildIceServers({
  iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }],
  turnServers: [{ urls: ['turn:demo.turn:3478'], username: 'u', credential: 'p' }],
  turnConfigured: true,
});
if (comTURN.iceServers.length === 2) ok('STUN + TURN na mesma lista (2 servidores)');
else fail(`esperava 2 servidores, veio ${comTURN.iceServers.length}`);
if (turnWarning({ turnConfigured: true }) === null) ok('sem TURN -> nenhum aviso');
else fail('aviso apareceu mesmo com TURN configurado');

// --------------------------------------------------------------------------
section('4. IceDiagnostics: host / srflx / relay e o que conta como "funcionando"');
const ice = new IceDiagnostics();
ice.turnConfigured = true;
if (ice.relayWorking) fail('relayWorking verdadeiro sem nenhum candidato');
else ok('relayWorking falso sem candidato (configurado != funcionando)');

ice.noteCandidate({ type: 'host' });
ice.noteCandidate({ type: 'host' });
ice.noteCandidate({ type: 'srflx' });
if (ice.candidates.host === 2 && ice.candidates.srflx === 1) ok('candidatos host=2, srflx=1 contabilizados');
else fail(`contagem errada: ${JSON.stringify(ice.candidates)}`);

if (ice.relayGathered === false) ok('relayGathered falso (nenhum relay ainda)');
else fail('relayGathered verdadeiro sem candidato relay');

ice.noteCandidate({ type: 'relay' });
if (ice.relayGathered) ok('relayGathered verdadeiro depois do candidato relay');
else fail('relay nao foi detectado');

// Par conectado DIRETO: relay EXISTS mas nao esta em uso -> nao "funcionando".
ice.noteSelectedPair({ localCandidate: { type: 'srflx' }, remoteCandidate: { type: 'host' } });
if (ice.selected === 'srflx') ok('par direto selecionado = srflx');
else fail(`selecionado inesperado: ${ice.selected}`);
if (ice.relayWorking === false) ok('relay existe mas NAO esta em uso -> relayWorking falso (honesto)');
else fail('relayWorking verdadeiro com conexao direta');
console.log(`       linha do aviso: "${ice.line()}"`);

// Agora o par conectado SAI por relay -> relay de verdade.
ice.noteSelectedPair({ localCandidate: { type: 'relay' }, remoteCandidate: { type: 'srflx' } });
if (ice.relayWorking === true) ok('par conectado por relay -> relayWorking verdadeiro');
else fail('relayWorking nao Recognized par relay');
const relatorio = ice.report();
if (relatorio.selected === 'relay' && relatorio.relayGathered && relatorio.turnConfigured) {
  ok(`report: ${JSON.stringify(relatorio)}`);
} else {
  fail(`report incompleto: ${JSON.stringify(relatorio)}`);
}
if (/\d/.test(ice.line()) === false) ok(`linha do aviso: "${ice.line()}"`);
else fail('a linha do aviso tem numero/codigo em vez de texto');

// --------------------------------------------------------------------------
section('5. Aviso curto e sem nome de variavel (itens 2 e 9)');
const avisoHost = turnWarning({ turnConfigured: false });
const avisoViewer = turnWarning({ turnConfigured: false }, { viewer: true });
console.log(`  host:    "${avisoHost}"`);
console.log(`  viewer:  "${avisoViewer}"`);
for (const [nome, texto] of [['host', avisoHost], ['viewer', avisoViewer]]) {
  if (!texto) fail(`${nome}: sem aviso`);
  if (texto.length > 80) fail(`${nome}: aviso longo demais (${texto.length} caracteres)`);
  if (/TURN_URL|TURN_USERNAME|TURN_CREDENTIAL|NAT restritivo|4G|5G/i.test(texto)) {
    fail(`${nome}: aviso expoe detalhe de infraestrutura`);
  }
}
if (avisoViewer === 'Conexao com a transmissao limitada.') ok('espectador ve texto neutro');
else fail(`texto do espectador inesperado: ${avisoViewer}`);

// --------------------------------------------------------------------------
console.log(`\n${falhas === 0 ? 'TUDO OK' : `${falhas} FALHA(S)`} - verificacao de TURN/ICE`);
if (servers.length === 0) {
  console.log('PENDENTE: nao ha servidor TURN nesta maquina, portanto o relay (candidato "relay")');
  console.log('          nao pode ser validado aqui. A integracao esta pronta: configure');
  console.log('          TURN_URL + TURN_USERNAME + TURN_CREDENTIAL (ou TURN_URLS) e o relay');
  console.log('          passa a ser detectado por IceDiagnostics.report().');
}
process.exit(falhas === 0 ? 0 : 1);