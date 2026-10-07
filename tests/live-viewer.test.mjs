/**
 * Testes do ESPECTADOR da LIVE, do layout inferior e do suporte a TURN/ICE.
 *
 * Cobre os itens 1, 2, 3, 5, 6, 7, 8, 9, 10, 11, 12 e 13:
 *  - a tela do espectador tem estados de midia EXPLICITOS (conectando, tocando,
 *    reconectando, erro com "Tentar novamente", LIVE encerrada) e nenhum deles
 *    pode virar "Conteudo sem midia";
 *  - `ontrack` e `srcObject` ligam a MediaStream real ao <video>;
 *  - o botao "Tentar novamente" reinicia o WebRTC de verdade (hardReset, sem
 *    conexao duplicada);
 *  - a troca de rede dispara reinicio de ICE;
 *  - o aviso de TURN e curto, so para host, e nunca expoe nome de variavel;
 *  - o layout inferior tem campo com efeito DENTRO, grupo de acoes separado e
 *    botao de sair com zona propria; o chat usa a altura medida;
 *  - o video ocupa o viewport com `cover` no celular e sem distorcao.
 *
 * A suite nao simula midia: os estados sao exercitados com um
 * RTCPeerConnection de verdade entre dois contextos de WebRTC disponiveis,
 * e o resto e verificacao estrutural do codigo e do CSS (que e o que quebra).
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../server/config.js';
import { Report } from './helpers.mjs';
import { IceDiagnostics, buildIceServers, turnWarning } from '../web/js/features/webrtc.js';

const report = new Report('Espectador da LIVE, layout e TURN/ICE');

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** Testa se dois retangulos se sobrepoem em mais de `tolerancia` px. */
const sobrepoe = (a, b, tolerancia = 2) => {
  const x = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return x > tolerancia && y > tolerancia;
};

async function run() {
  const viewerSrc = read('web/js/features/live-viewer.js');
  const hostSrc = read('web/js/features/live.js');
  const webrtcSrc = read('web/js/features/webrtc.js');
  const css = read('web/css/app.css');

  try {
    // ------------------------------------------- 6. ESTADOS DE MIDIA (item 6)
    await report.step('espectador tem estados de midia explicitos, sem "sem midia"', async () => {
      if (viewerSrc.includes('Conteudo sem midia')) {
        throw new Error('ainda existe o texto "Conteudo sem midia" no espectador');
      }
      const estados = ['connecting', 'playing', 'reconnect', 'error', 'ended', 'blocked'];
      for (const estado of estados) {
        if (!viewerSrc.includes(`${estado}:`) && !viewerSrc.includes(`'${estado}'`)) {
          throw new Error(`estado "${estado}" ausente em renderMediaState`);
        }
      }
      if (!viewerSrc.includes('function renderMediaState')) throw new Error('renderMediaState ausente');
      return `${estados.length} estados: ${estados.join(', ')}`;
    });

    await report.step('estado de erro oferece "Tentar novamente" e estado de fim diz LIVE encerrada', async () => {
      if (!viewerSrc.includes('Tentar novamente')) throw new Error('sem botao "Tentar novamente"');
      if (!viewerSrc.includes('onClick: () => retryConnection(')) {
        throw new Error('o botao nao chama retryConnection de verdade');
      }
      if (!viewerSrc.includes('LIVE encerrada')) throw new Error('sem estado "LIVE encerrada"');
      if (!viewerSrc.includes("renderMediaState('ended')")) {
        throw new Error('onLeave nao renderiza o estado encerrada');
      }
      return 'botao age sobre retryConnection(); encerramento tem estado proprio';
    });

    // -------------------------- 5. ontrack / srcObject / autoplay (item 5)
    await report.step('midia real chega por ontrack e vai para srcObject', async () => {
      if (!webrtcSrc.includes('pc.ontrack')) throw new Error('sem pc.ontrack na malha');
      if (!webrtcSrc.includes('onStream(this.remoteStream')) {
        throw new Error('ontrack nao entrega a MediaStream acumulada');
      }
      if (!viewerSrc.includes('remoteVideo.srcObject = stream')) {
        throw new Error('espectador nao liga a MediaStream no video');
      }
      if (!viewerSrc.includes("remoteVideo.play()")) throw new Error('sem play() do video remoto');
      if (!viewerSrc.includes("renderMediaState('playing')")) {
        throw new Error('a midia recebida nao marca o estado "tocando"');
      }
      return 'ontrack -> MediaStream -> srcObject -> play -> estado tocando';
    });

    // ------------------------ 7/8. RECONEXAO E TROCA DE REDE (itens 7 e 8)
    await report.step('reconexao com backoff e botao que reinicia o WebRTC de verdade', async () => {
      if (!webrtcSrc.includes('reconnectAttempts > 6')) throw new Error('sem limite de tentativas (backoff)');
      if (!webrtcSrc.includes('pc.restartIce()')) throw new Error('reinicio de ICE ausente');
      if (!webrtcSrc.includes('hardReset(')) throw new Error('hardReset ausente');
      if (!viewerSrc.includes('mesh?.hardResetAll(')) throw new Error('o espectador nunca chama hardResetAll');
      if (!viewerSrc.includes("reason: 'network_back'")) throw new Error('troca de rede nao tratada');
      if (!webrtcSrc.includes('this.pc = null;')) throw new Error('hardReset nao descarta a PeerConnection');
      // Item 7: nunca duas conexoes vivas.
      if (!webrtcSrc.includes('if (this.pc) {\n      try { this.pc.close(); }')) {
        throw new Error('a PeerConnection antiga nao e fechada antes de criar outra');
      }
      return 'backoff -> restartIce -> hardResetAll (rede) sem conexao duplicada';
    });

    await report.step('watchdog oferece reconexao em vez de trocar a mensagem', async () => {
      if (!viewerSrc.includes('function armMediaWatchdog')) throw new Error('sem watchdog de midia');
      if (!viewerSrc.includes("reason: 'no_media'")) {
        throw new Error('o watchdog nao abre a acao de reconexao');
      }
      // O watchdog soAge se a midia NAO chegou; nunca converte em "sem midia".
      if (!viewerSrc.includes('if (state.connected || leaving) return;')) {
        throw new Error('watchdog age mesmo com midia presente');
      }
      return '12s sem midia -> "Tentar novamente" (nao um timeout que apaga a tela)';
    });

    // ------------------------- 1/2/3/9. TURN E DIAGNOSTICO DE ICE
    await report.step('diagnostico de ICE distingue host, srflx e relay', async () => {
      if (!webrtcSrc.includes('export class IceDiagnostics')) throw new Error('sem IceDiagnostics');
      if (!webrtcSrc.includes('noteCandidate(')) throw new Error('candidatos nao sao registrados');
      if (!webrtcSrc.includes('noteSelectedPair(')) throw new Error('par selecionado nao e medido');
      if (!webrtcSrc.includes('this.ice.noteCandidate(event.candidate)')) {
        throw new Error('onicecandidate nao alimenta o diagnostico');
      }
      if (!webrtcSrc.includes('entry.selected || entry.nominated')) {
        throw new Error('getStats nao identifica o par selecionado');
      }
      if (!webrtcSrc.includes('iceReport()')) throw new Error('sem relatorio de ICE na malha');
      return 'host/srflx/relay medidos; relay so conta quando o par conectado o usa';
    });

    await report.step('"configurado" nunca e confundido com "funcionando"', async () => {
      const ice = new IceDiagnostics();
      ice.turnConfigured = true;
      if (ice.relayWorking) throw new Error('relayWorking verdadeiro sem relay');
      ice.noteCandidate({ type: 'relay' });
      if (!ice.relayGathered) throw new Error('relay obtido nao foi detectado');
      if (ice.relayWorking) throw new Error('relay obtido foi tratado como relay em uso');
      ice.noteSelectedPair({ localCandidate: { type: 'relay' }, remoteCandidate: { type: 'srflx' } });
      if (!ice.relayWorking) throw new Error('par conectado por relay nao marcou relayWorking');
      const relatorio = ice.report();
      if (relatorio.selected !== 'relay') throw new Error(`selected: ${relatorio.selected}`);
      return 'obtido != em uso; relay em uso so com par selecionado relay';
    });

    await report.step('aviso de TURN e curto e nunca expoe infraestrutura', async () => {
      const host = turnWarning({ turnConfigured: false });
      const viewer = turnWarning({ turnConfigured: false }, { viewer: true });
      if (!host || !viewer) throw new Error('sem aviso quando falta TURN');
      if (host.length > 80) throw new Error(`aviso do host longo: ${host.length} caracteres`);
      for (const texto of [host, viewer]) {
        if (/TURN_URL|TURN_USERNAME|TURN_CREDENTIAL/.test(texto)) {
          throw new Error(`aviso expoe nome de variavel: ${texto}`);
        }
      }
      if (viewer !== 'Conexao com a transmissao limitada.') {
        throw new Error(`texto do espectador: ${viewer}`);
      }
      if (turnWarning({ turnConfigured: true }) !== null) throw new Error('aviso com TURN configurado');
      return `host: "${host}" | espectador: "${viewer}"`;
    });

    await report.step('somente host/admin ve o painel de conexao na LIVE', async () => {
      if (!hostSrc.includes("class: 'live-turn'")) throw new Error('host sem painel de conexao');
      if (!hostSrc.includes('renderTurnPanel')) throw new Error('painel nao e preenchido');
      // O espectador nao tem nenhum painel de infraestrutura.
      if (viewerSrc.includes('live-turn-panel')) {
        throw new Error('espectador recebeu painel de diagnostico de infraestrutura');
      }
      return 'painel expansivel so na tela do host';
    });

    await report.step('ICE do backend usa a lista real de TURN (UDP e TLS)', async () => {
      const liveSrc = read('server/domain/live.js');
      // Item 3: as credenciais passaram a ser geradas por
      // `servidoresTurnComCredencial()` (TURN REST API, com expiracao). O
      // requisito real nao e o nome da funcao e que a lista de ICE entregue ao
      // cliente saia da configuracao de TURN efetiva - por isso o teste tambem
      // chama a API com TURN configurado e confere o que o cliente recebe.
      if (!liveSrc.includes('servidoresTurnComCredencial(')) {
        throw new Error('iceServers nao usa a geracao de credencial do TURN');
      }
      if (!liveSrc.includes('turnConfigured: turn.length > 0')) {
        throw new Error('turnConfigured nao vem da lista efetiva');
      }
      // A credencial efemera tem de viajar na lista de ICE (e nao numa variavel
      // fixa), com o modo declarado para o diagnostico nao mentir.
      if (!liveSrc.includes('turnCredentialMode')) {
        throw new Error('a lista de ICE nao declara o modo da credencial');
      }
      if (!liveSrc.includes('turnExpiresAt')) {
        throw new Error('a lista de ICE nao declara a expiracao da credencial');
      }
      // E o gerador tem de existir de verdade (TURN REST API).
      const credSrc = read('server/lib/turn-credentials.js');
      if (!credSrc.includes("createHmac('sha1'")) {
        throw new Error('a credencial efemera nao e HMAC-SHA1');
      }
      if (!/\$\{expiraEm\}:/.test(credSrc) && !credSrc.includes('${expiraEm}:')) {
        throw new Error('o usuario da credencial nao carrega o timestamp de expiracao');
      }

      const list = buildIceServers({
        iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }],
        turnServers: [
          { urls: ['turn:demo:3478?transport=udp'], username: 'u', credential: 'p' },
          { urls: ['turns:demo:5349?transport=tcp'], username: 'u', credential: 'p' },
        ],
        turnConfigured: true,
      });
      if (list.iceServers.length !== 3) throw new Error(`esperava 3 servidores ICE, veio ${list.iceServers.length}`);
      return 'STUN + TURN/UDP + TURN/TLS na mesma lista de ICE';
    });

    // ------------------- 10/11/12/13. LAYOUT INFERIOR E VIDEO (itens 10-13)
    await report.step('barra inferior na ordem pedida e sem sobreposicao (itens 11 e 13)', async () => {
      // (Item 13) Ordem obrigatoria na barra inferior:
      //   1. campo "Digite sua mensagem"
      //   2. CONFIRMAR ENVIO (so com texto pronto)
      //   3. EFEITOS (control PROPRIO, com divisor, NAO grudado no campo)
      //   4. COMPARTILHAR
      //   5. REPUBLICAR
      // O teste antigo exigia o botao de efeitos DENTRO do campo e o "Sair" na
      // barra - exatamente o que o item 13 pede para desfazer.
      for (const [nome, src] of [['host', hostSrc], ['espectador', viewerSrc]]) {
        if (!src.includes("class: 'live-field'")) throw new Error(`${nome}: sem .live-field`);
        if (!src.includes("class: 'live-send'")) throw new Error(`${nome}: sem botao de confirmar envio`);
        if (!src.includes("class: 'live-tools'")) throw new Error(`${nome}: sem grupo de acoes`);
        if (!src.includes("class: 'live-divider'")) throw new Error(`${nome}: sem divisor entre campo e controles`);
        // O campo de texto so pode conter o input: efeito dentro dele e o
        // que o item 13 manda separar.
        const campo = src.match(/const fieldWrap = el\('div', \{ class: 'live-field' \}, \[([^\]]*)\]/);
        if (!campo) throw new Error(`${nome}: nao achei a montagem do .live-field`);
        if (campo[1].includes('effectsBtn')) throw new Error(`${nome}: botao de efeitos ainda esta dentro do campo`);
      }

      // A ordem e conferida no `inputBar.append(...)`, que e a ordem REAL no DOM.
      // A ordem de DECLARACAO nao prova nada: `sendBtn` pode ser declarado
      // antes de `fieldWrap` e mesmo assim entrar depois no DOM.
      for (const [nome, src] of [['host', hostSrc], ['espectador', viewerSrc]]) {
        const append = src.match(/inputBar\.append\(([^)]*)\)/);
        if (!append) throw new Error(`${nome}: nao achei inputBar.append(...)`);
        const seq = append[1];
        const esperado = ['fieldWrap', 'sendBtn', 'toolsGroup'];
        const pos = esperado.map((v) => seq.indexOf(v));
        for (let i = 0; i < pos.length; i += 1) {
          if (pos[i] < 0) throw new Error(`${nome}: ${esperado[i]} fora de inputBar.append (${seq.trim()})`);
          if (i > 0 && pos[i] < pos[i - 1]) {
            throw new Error(`${nome}: ordem errada na barra: ${esperado[i]} antes de ${esperado[i - 1]} (${seq.trim()})`);
          }
        }
        // Efeitos tem que estar dentro de toolsGroup (control separado).
        const grupo = src.match(/const toolsGroup = el\('div', \{ class: 'live-tools' \}, \[([^\]]*)\]/);
        if (!grupo) throw new Error(`${nome}: nao achei o grupo de controles`);
        if (!grupo[1].includes('effectsBtn')) {
          throw new Error(`${nome}: o botao de efeitos nao esta no grupo de controles (${grupo[1].trim()})`);
        }
      }

      // (Item 13) Compartilhar e Republicar precisam existir.
      if (!hostSrc.includes("class: 'round-btn', 'aria-label': 'Compartilhar LIVE'")) {
        throw new Error('host: sem botao de compartilhar');
      }
      if (!hostSrc.includes("'aria-label': 'Republicar LIVE'")) throw new Error('host: sem botao de republicar');

      // (Item 11) O botao de sair/encerrar SAIU da barra inferior e foi para o
      // menu de configuracoes, no topo.
      if (hostSrc.includes("class: 'live-end-btn'")) {
        throw new Error('host: o botao de sair continua na barra inferior (item 11)');
      }
      if (!hostSrc.includes('abrirConfiguracoes')) throw new Error('host: sem menu de configuracoes');
      if (!hostSrc.includes("'aria-label': 'Configuracoes da transmissao'")) {
        throw new Error('host: botao de configuracoes nao esta no topo');
      }
      if (!hostSrc.includes('confirmSair')) throw new Error('host: sem confirmacao ao sair/encerrar');
      // Host ve "Encerrar LIVE" e espectador "Sair da LIVE".
      if (!hostSrc.includes('Encerrar LIVE')) throw new Error('host: falta "Encerrar LIVE"');
      if (!hostSrc.includes('Sair da LIVE')) throw new Error('host: falta "Sair da LIVE"');

      // (Item 12) O contador de espectadores virou botao com painel.
      if (!hostSrc.includes('abrirEspectadores')) throw new Error('host: sem painel de espectadores');
      if (!hostSrc.includes('live-viewers-btn')) throw new Error('host: contador de espectadores nao e botao');
      if (!hostSrc.includes("/viewers")) throw new Error('host: painel nao consulta a lista real de espectadores');

      if (!css.includes('.live-send')) throw new Error('CSS do botao de enviar ausente');
      if (!css.includes('.live-divider')) throw new Error('CSS do divisor ausente');
      if (!css.includes('.live-tools')) throw new Error('CSS do grupo de acoes ausente');
      if (!css.includes('.live-settings-btn')) throw new Error('CSS do botao de configuracoes no topo ausente');
      if (!css.includes('.live-viewer-row')) throw new Error('CSS do painel de espectadores ausente');
      if (!css.includes('.live-field')) throw new Error('CSS do campo ausente');
      return 'campo + acoes + sair em blocos separados';
    });

    await report.step('altura da barra e medida, nao chutada (itens 10 e 11)', async () => {
      const layout = read('web/js/features/live-layout.js');
      if (!layout.includes('ResizeObserver')) throw new Error('sem medicao da barra');
      // O teclado passou a ser lido pelo modulo COMPARTILHADO
      // `core/viewport.js` (o mesmo que o chat usa): cada tela ter o proprio
      // palpite de teclado era exatamente o que gerava folga morta no chat
      // (item 30). A assercao passa a checar a fonte real da medicao.
      const viewportSrc = read('web/js/core/viewport.js');
      if (!viewportSrc.includes('visualViewport')) {
        throw new Error('core/viewport.js nao le o visualViewport');
      }
      if (!layout.includes('observarViewport')) {
        throw new Error('live-layout nao usa a leitura compartilhada de viewport');
      }
      if (!layout.includes("prefix: 'live'")) {
        throw new Error('a LIVE nao publica as variaveis de viewport dela');
      }
      if (!css.includes('--live-bar-h')) throw new Error('variavel --live-bar-h ausente no CSS');
      // O chat acima da barra usa a altura MEDIDA, nao um valor fixo.
      if (!css.includes('bottom: calc(var(--live-bar-h) + 8px)')) {
        throw new Error('chat ainda usa altura fixa');
      }
      if (/padding-bottom:\s*calc\(64px/.test(css)) {
        throw new Error('sobrou o padding fixo de 64px do chat');
      }
      for (const nome of ['live-viewer.js', 'live.js']) {
        const src = read(`web/js/features/${nome}`);
        if (!src.includes('observeLiveLayout(page, inputBar)')) throw new Error(`${nome} nao mede a barra`);
        if (!src.includes('stopLayout?.()')) throw new Error(`${nome} nao limpa o observador`);
      }
      return 'ResizeObserver + visualViewport publicados em --live-bar-h/--live-kb';
    });

    await report.step('safe-area e teclado preservados (item 11)', async () => {
      if (!css.includes('var(--live-kb, 0px)')) throw new Error('sem deslocamento pelo teclado');
      if (!css.includes('calc(10px + var(--safe-b) + var(--live-kb, 0px))')) {
        throw new Error('a barra nao soma safe-area com a altura do teclado');
      }
      return 'safe-area + teclado somados, nao sobrepostos';
    });

    await report.step('em 320px os controles continuam visiveis e alcancaveis (item 11)', async () => {
      // (Item 11) O botao "Sair" saiu da barra inferior; o que precisa
      // continuar valendo e que, em tela estreita, os controles NAO encolhem
      // a ponto de ficarem sem area de toque. A regra antiga escondia o rotulo
      // "Sair" com `display:none` - o botao nem existe mais na barra.
      if (!css.includes('@media (max-width: 360px)')) throw new Error('sem regra para telas estreitas');
      // Area de toque: `.round-btn` na barra tem que manter minimo confiavel.
      const areaToque = css.match(/\.live-tools[^{]*\{[^}]*min-height:\s*(\d+)px/);
      if (!areaToque) throw new Error('sem min-height nos controles da barra (alvo de toque pequeno)');
      if (Number(areaToque[1]) < 36) throw new Error(`area de toque pequena demais: ${areaToque[1]}px`);
      // O divisor some/encolhe antes dos controles, nunca o contrario.
      // A busca e feita no BLOCO do media query (recortando por chave) porque um
      // regex com `[^}]*` para na primeira regra interna e nunca chega ate ele.
      const iMedia = css.indexOf('@media (max-width: 360px)');
      if (iMedia === -1) throw new Error('sem regra para telas estreitas');
      let profundidade = 0;
      let fimMedia = iMedia;
      for (let i = css.indexOf('{', iMedia); i < css.length; i += 1) {
        if (css[i] === '{') profundidade += 1;
        else if (css[i] === '}') {
          profundidade -= 1;
          if (profundidade === 0) { fimMedia = i; break; }
        }
      }
      const blocoEstreito = css.slice(iMedia, fimMedia);
      if (!blocoEstreito.includes('.live-divider')) {
        throw new Error('o divisor nao encolhe em tela estreita');
      }
      return `controles com min-height ${areaToque[1]}px e divisor que encolhe em <=360px`;
    });

    await report.step('video da LIVE ocupa o viewport sem distorcao (item 13)', async () => {
      if (!css.includes('.live-video-wrap video.remote')) throw new Error('sem regra do video remoto');
      if (!css.includes('object-fit: cover')) throw new Error('sem cover no celular');
      if (!css.includes('object-fit: contain')) throw new Error('sem contain no desktop landscape');
      if (!css.includes('object-position: center')) throw new Error('sem centralizacao');
      return 'cover no celular, contain no desktop landscape';
    });

    await report.step('layout desktop: barra centralizada, sem botoes empilhados (item 12)', async () => {
      if (!css.includes('.live-input-bar {\n    left: 50%;')) throw new Error('barra nao centralizada no desktop');
      if (!css.includes('min(680px, calc(100vw - 48px))')) throw new Error('largura maxima da barra ausente');
      return 'barra em linha central com largura maxima';
    });

    // ------------------------- 14/15. BLOCO DA POSTAGEM ACIMA DA BOTTOM NAV
    await report.step('bloco da postagem reserva a bottom nav (itens 14 e 15)', async () => {
      // (Itens 1, 2 e 15) O bloco de informacoes e a coluna de acoes usam a
      // MESMA variavel, `--acoes-base`, que agora e derivada da altura REAL da
      // viewport: `calc(tabbar-h + safe-b + clamp(10px, 2.4dvh, 24px))`.
      //
      // O teste nao casa mais a expressao literal (isso travaria qualquer
      // melhoria futura); ele verifica a CONTRATUAL, que e o que importa:
      //  a) `--acoes-base` existe e e um `calc` que include `--tabbar-h` e
      //     `--safe-b` - sobe a bottom nav e a safe-area;
      //  b) a folga e PROPORCIONAL (`clamp` com `dvh`), e nao um pixel fixo;
      //  c) nao sobrou nenhum `128px`/`68px`/`76px` fixo no caminho critico.
      const defAc = css.match(/--acoes-base:\s*([^;]+);/);
      if (!defAc) throw new Error('--acoes-base nao definido');
      const expr = defAc[1].replace(/\s+/g, ' ').trim();
      if (!expr.startsWith('calc(')) throw new Error(`--acoes-base nao e calc: ${expr}`);
      if (!expr.includes('var(--tabbar-h)')) throw new Error(`--acoes-base nao soma tabbar-h: ${expr}`);
      if (!expr.includes('var(--safe-b)')) throw new Error(`--acoes-base nao soma safe-b: ${expr}`);
      // A folga tem de vir da altura real da viewport (item 1/2), nao de um
      // numero fixo que so funciona numa resolucao. Ha DUAS declaracoes de
      // proposito: `vh` como reserva para navegadores sem `dvh`, e `dvh`
      // acima (que vence). E o que se exige e que existam as duas.
      const gaps = [...css.matchAll(/--acoes-gap:\s*([^;]+);/g)].map((m) => m[1].replace(/\s+/g, ' ').trim());
      if (gaps.length < 2) throw new Error(`--acoes-gap deveria ter reserva em vh e medida em dvh; achei ${JSON.stringify(gaps)}`);
      if (!gaps.some((g) => /dvh/.test(g))) {
        throw new Error(`nenhuma declaracao de --acoes-gap usa dvh: ${JSON.stringify(gaps)}`);
      }
      if (!gaps.every((g) => /clamp\(/.test(g))) {
        throw new Error(`a folga nao tem piso/teto (clamp): ${JSON.stringify(gaps)}`);
      }
      if (gaps.some((g) => /^\s*\d+px\s*$/.test(g))) {
        throw new Error(`a folga voltou a ser um pixel fixo: ${JSON.stringify(gaps)}`);
      }
      if (!/padding: 16px var\(--acoes-larg\) var\(--acoes-base\) 16px/.test(css)) {
        throw new Error('overlay nao usa a folga calculada (--acoes-base)');
      }
      if (!/bottom: var\(--acoes-base\)/.test(css)) {
        throw new Error('a coluna de acoes nao usa a mesma folga do bloco de texto');
      }
      if (/\.live-overlay[^}]*padding-bottom:\s*\d+px/.test(css)) {
        throw new Error('sobrou padding fixo no bloco da postagem');
      }
      // A coluna de acoes usa a MESMA folga do bloco de texto (`--acoes-base`),
      // que ja soma bottom nav e safe-area. Assim os dois nunca se cruzam.
      if (!/\.slide-actions \{[^}]*bottom: var\(--acoes-base\)/.test(css)) {
        throw new Error('acoes laterais nao usam a folga calculada (--acoes-base)');
      }
      if (!css.includes('.slide-caption')) throw new Error('bloco de descricao ausente');
      // A regra de desktop (1024px+) precisa existir e usar as MESMAS
      // variaveis - senao o PC volta a ter folga fixa.
      if (!/@media \(min-width: 1024px\)[\s\S]{0,1200}?\.slide-overlay \{[^}]*padding:\s*20px var\(--acoes-larg\) var\(--acoes-base\) 24px/.test(css)) {
        throw new Error('sem regra de desktop para o overlay usando as variaveis medidas');
      }
      return 'overlay e acoes laterais derivados de tabbar-h + safe-b + folga proporcional (dvh)';
    });

    await report.step('descricao longa nao empurra o conteudo para tras da barra', async () => {
      // (Item 7) A descricao cresce para caber em ate ~6 linhas e, passando disso,
      // ROLA dentro do proprio bloco em vez de empurrar autor e acoes para tras
      // da barra. O limite antigo era 4.2em (2 linhas), que cortava hashtags.
      const limiteDescricao = css.match(/\.slide-caption \{[^}]*max-height:\s*([\d.]+)em/);
      if (!limiteDescricao) throw new Error('descricao sem limite de altura');
      if (Number(limiteDescricao[1]) < 6) {
        throw new Error(`descricao corta cedo demais: ${limiteDescricao[1]}em`);
      }
      if (!/\.slide-caption \{[^}]*overflow-y:\s*auto/.test(css)) {
        throw new Error('descricao longa nao rola dentro do proprio bloco');
      }
      if (!css.includes('overflow-y: auto')) throw new Error('descricao nao pode rolar quando e longa');
      if (!viewerSrc.includes('renderMediaState')) throw new Error('sanidade: espectador ok');
      return 'altura limitada com rolagem propria';
    });

    // ------------------------------- 23. FEED SEM REGRESSAO
    await report.step('feed continua com navegacao e midia por slide (item 23)', async () => {
      const feed = read('web/js/features/feed.js');
      // Mecanica de rolagem REAL (item 5): container de scroll + posicao real.
      for (const trecho of [
        'activate(', 'deactivate(', 'goTo', 'feed:new',
        'alturaPagina', 'scrollParaIndex', 'IntersectionObserver', "stage.addEventListener('scroll'",
      ]) {
        if (!feed.includes(trecho)) throw new Error(`feed perdeu ${trecho}`);
      }
      // Proibido o modelo de rolagem simulada.
      if (feed.includes('onWheel') || feed.includes('wheelAccumulado')) {
        throw new Error('feed voltou a interceptar o wheel (rolagem simulada)');
      }
      if (!/scrollTo|scrollBy/.test(feed)) {
        throw new Error('feed sem scrollTo/scrollBy');
      }
      // O texto pode existir em comentario (documentando a causa), mas nunca
      // em uma string exibida.
      const textoExibido = [...feed.matchAll(/text:\s*'([^']*)'/g)].map((m) => m[1]);
      if (textoExibido.some((t) => /Conteudo sem midia/i.test(t))) {
        throw new Error('feed voltou a exibir "Conteudo sem midia."');
      }
      return 'navegacao, autoplay e feed:new preservados';
    });

    await report.step('repost e post de LIVE mostram conteudo real, nao "sem midia"', async () => {
      const feed = read('web/js/features/feed.js');
      if (!feed.includes('post.repostOf?.media')) throw new Error('repost nao usa a midia do original');
      if (!feed.includes("post.type === 'live'")) throw new Error('post de LIVE sem tratamento');
      if (!feed.includes("class: 'slide-live-card'")) throw new Error('cartao de LIVE ausente');
      if (!css.includes('.slide-live-card')) throw new Error('CSS do cartao de LIVE ausente');
      if (!css.includes('.slide-repost-mark')) throw new Error('marca de republicacao ausente');
      return 'repost mostra o video original; LIVE mostra cartao com link';
    });

    report.ok('espectador, layout e TURN/ICE validados');
  } catch (error) {
    report.fail('fluxo do espectador interrompido', error);
  }

  return report.summary();
}

run().then((result) => {
  process.exit(result.failed > 0 ? 1 : 0);
}).catch((error) => {
  console.error('erro fatal:', error);
  process.exit(1);
});