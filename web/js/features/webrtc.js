/**
 * Sinalizacao e malha WebRTC da LIVE.
 *
 * Topologia: malha (mesh) em estrela. O HOST e o unico que envia midia;
 * cada espectador cria uma RTCPeerConnection com o host e recebe a MediaStream
 * real (video + audio) via ontrack. Nao existe simulacao: sem `ontrack`, sem
 * video. Nao usamos canvas, captureStream como substituto, avatar nem video
 * gravado.
 *
 * Protecoes contra duplicacao:
 * - um unico RTCPeerConnection por par (host<->espectador), guardada por chave
 * - reconexao reutiliza a mesma conexao; nao cria segunda
 * - ICE candidates duplicados sao descartados
 * - audio/video unicos por elemento
 */

export const DEFAULT_ICE = {
  iceServers: [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  ],
};

export class LiveConnection {
  /**
   * @param {object} options
   * @param {'host'|'viewer'} options.role
   * @param {(signal: object) => void} options.onSignal envia oferta/resposta/ICE ao par
   * @param {(stream: MediaStream) => void} options.onStream midia remota recebida
   * @param {(state: object) => void} options.onState mudanca de estado
   * @param {MediaStream|null} options.localStream stream local (host)
   * @param {object} options.iceServers
   */
  constructor({ role, peerId, onSignal, onStream, onState, localStream = null, iceServers = DEFAULT_ICE, sendTo }) {
    this.role = role;
    this.peerId = peerId;
    this.onSignal = onSignal;
    this.onStream = onStream;
    this.onState = onState || (() => {});
    this.localStream = localStream;
    this.iceServers = iceServers || DEFAULT_ICE;
    this.sendTo = sendTo;

    this.pc = null;
    this.remoteStream = new MediaStream();
    this.candidates = [];
    this.remoteDescriptionSet = false;
    this.makingOffer = false;
    this.ignoreOffer = false;
    this.isSettingRemoteAnswerPending = false;
    this.polite = role === 'viewer'; // viewer: polite peer (evita glare)
    this.closed = false;
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
    this.statsTimer = null;
    this.stats = { rtt: null, bitrateKbps: null, packetsLost: null, jitterMs: null };
    this.lastStats = null;
    /** Diagnostico real de ICE (host/srflx/relay) - item 3. */
    this.ice = new IceDiagnostics();
  }

  emitState(state, detail = {}) {
    this.onState({ role: this.role, peerId: this.peerId, state, ...detail });
  }

  ensurePeer() {
    if (this.pc && !this.closed) return this.pc;
    if (this.closed) return null;

    const pc = new RTCPeerConnection(this.iceServers);
    this.pc = pc;

    if (this.localStream) {
      for (const track of this.localStream.getTracks()) {
        pc.addTrack(track, this.localStream);
      }
    }

    pc.onicecandidate = (event) => {
      // Item 3: cada candidato TYPE e registrado no diagnostico. Sem isso nao
      // da para dizer se o relay do TURN foi gathering de verdade.
      this.ice.noteCandidate(event.candidate);
      if (event.candidate) {
        this.onSignal({ kind: 'ice', candidate: event.candidate.toJSON(), peerId: this.peerId });
      } else {
        // gathering terminou
        this.emitState('ice_gathering_done', { ice: this.ice.report() });
      }
    };

    pc.ontrack = (event) => {
      const [stream] = event.streams;
      if (stream) {
        for (const track of stream.getTracks()) {
          if (!this.remoteStream.getTracks().includes(track)) this.remoteStream.addTrack(track);
        }
      } else if (!this.remoteStream.getTracks().includes(event.track)) {
        this.remoteStream.addTrack(event.track);
      }
      this.onStream(this.remoteStream, { trackKind: event.track.kind });
    };

    pc.oniceconnectionstatechange = () => {
      const state = pc.iceConnectionState;
      this.emitState(`ice:${state}`);
      if (state === 'connected' || state === 'completed') {
        this.reconnectAttempts = 0;
        this.startStats();
      }
      if (state === 'failed') {
        this.reconnect('ice_failed');
      }
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      this.emitState(`pc:${state}`);
      if (state === 'failed') this.reconnect('pc_failed');
      if (state === 'disconnected') {
        // ICE desconectado pode se recuperar sozinho;timeout curto
        clearTimeout(this.disconnectTimer);
        this.disconnectTimer = setTimeout(() => {
          if (this.pc && this.pc.connectionState === 'disconnected') this.reconnect('pc_disconnected');
        }, 6000);
      }
      if (state === 'connected') {
        clearTimeout(this.disconnectTimer);
      }
    };

    pc.onnegotiationneeded = async () => {
      try {
        this.makingOffer = true;
        await pc.setLocalDescription();
        this.onSignal({ kind: 'description', description: pc.localDescription, peerId: this.peerId });
      } catch (err) {
        console.error('[live] negotiationneeded falhou:', err);
      } finally {
        this.makingOffer = false;
      }
    };

    return pc;
  }

  /** Envia uma oferta (chamado quando o host ve um novo espectador). */
  async makeOffer() {
    const pc = this.ensurePeer();
    if (!pc || this.closed) return;
    if (pc.signalingState !== 'stable') {
      // Ja existe uma oferta esperando resposta. Em vez de criar outra (o que
      // causaria glare), REENVIA a mesma oferta: cobre o caso em que o
      // espectador se anunciou antes de estar inscrito no topico e o sinal foi
      // descartado pelo servidor. Sem isso a LIVE ficava muda para sempre.
      if (pc.signalingState === 'have-local-offer' && pc.localDescription) {
        this.onSignal({ kind: 'description', description: pc.localDescription, peerId: this.peerId });
      }
      return;
    }
    try {
      this.makingOffer = true;
      await pc.setLocalDescription();
      this.onSignal({ kind: 'description', description: pc.localDescription, peerId: this.peerId });
    } catch (err) {
      console.error('[live] makeOffer falhou:', err);
    } finally {
      this.makingOffer = false;
    }
  }

  /** Processa um sinal recebido (oferta, resposta ou ICE). */
  async handleSignal(signal) {
    if (this.closed || !signal) return;
    const pc = this.ensurePeer();
    if (!pc) return;

    try {
      if (signal.kind === 'description') {
        const description = signal.description;
        const offerCollision = description.type === 'offer'
          && (this.makingOffer || pc.signalingState !== 'stable');
        this.ignoreOffer = !this.polite && offerCollision;
        if (this.ignoreOffer) return;

        if (description.type === 'offer') {
          await pc.setRemoteDescription(description);
          this.remoteDescriptionSet = true;
          await pc.setLocalDescription();
          this.onSignal({ kind: 'description', description: pc.localDescription, peerId: this.peerId });
        } else if (description.type === 'answer') {
          if (pc.signalingState === 'have-local-offer') {
            await pc.setRemoteDescription(description);
            this.remoteDescriptionSet = true;
          }
        }
        await this.drainCandidates();
      } else if (signal.kind === 'ice') {
        if (!signal.candidate) return;
        if (!pc.remoteDescription) {
          this.candidates.push(signal.candidate);
          return;
        }
        try {
          await pc.addIceCandidate(signal.candidate);
        } catch (err) {
          // Candidatos obsoletos depois de reconexao sao esperados
          if (!this.closed) console.debug('[live] ICEcandidate rejeitado:', err.message);
        }
      }
    } catch (err) {
      if (!this.closed) console.error('[live] handleSignal falhou:', err);
    }
  }

  async drainCandidates() {
    const pc = this.pc;
    if (!pc || !this.candidates.length) return;
    const pending = [...this.candidates];
    this.candidates = [];
    for (const candidate of pending) {
      try {
        await pc.addIceCandidate(candidate);
      } catch { /* obsoleto */ }
    }
  }

  /** Reconecta sem criar uma segunda PeerConnection. */
  reconnect(reason) {
    if (this.closed) return;
    if (this.reconnectTimer) return;
    this.reconnectAttempts += 1;
    if (this.reconnectAttempts > 6) {
      this.emitState('reconnect_failed', { reason });
      return;
    }
    const delay = Math.min(6000, 500 * 2 ** (this.reconnectAttempts - 1));
    this.emitState('reconnecting', { reason, attempt: this.reconnectAttempts, delay });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.restartIce();
    }, delay);
  }

  /**
   * Reinicio COMPLETO do par (usado pelo botao "Tentar novamente").
   * Diferente de `reconnect`, que reaproveita a mesma RTCPeerConnection e so
   * faz restartIce: aqui a conexao estava morta de vez (ex.:ICESfailed apos
   * varias tentativas), entao a PeerConnection e destruida e recriada, com a
   * fila de ICE zerada. Nunca deixa duas conexoes vivas.
   */
  hardReset(reason = 'manual') {
    if (this.closed) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    clearTimeout(this.disconnectTimer);
    this.stopStats();
    this.reconnectAttempts = 0;
    this.candidates = [];
    this.remoteDescriptionSet = false;
    this.makingOffer = false;
    for (const track of this.remoteStream.getTracks()) {
      try { track.stop(); } catch { /* ignore */ }
    }
    this.remoteStream = new MediaStream();
    if (this.pc) {
      try { this.pc.close(); } catch { /* ignore */ }
      this.pc = null;
    }
    this.emitState('reset', { reason });
    // O host precisa reenviar a oferta; o espectador re-anuncia a presenca.
    if (this.role === 'host') {
      this.makeOffer();
    }
  }

  /** Diagnostico consolidado de ICE desta conexao. */
  iceReport() {
    return this.ice.report();
  }

  /** Reinicia ICE na mesma conexao (padrao oficial, sem PeerConnection nova). */
  restartIce() {
    const pc = this.pc;
    if (!pc || this.closed || pc.iceConnectionState === 'closed') return;
    try {
      pc.restartIce();
      this.emitState('ice_restarted');
    } catch {
      this.emitState('reconnect_failed', { reason: 'restart_ice_unsupported' });
    }
  }

  startStats() {
    this.stopStats();
    this.statsTimer = setInterval(async () => {
      const pc = this.pc;
      if (!pc || this.closed) return;
      try {
        const report = await pc.getStats();
        let bytes = 0;
        let packets = 0;
        let lost = 0;
        let rtt = null;
        let jitter = null;
        report.forEach((entry) => {
          if (entry.type === 'inbound-rtp' && entry.kind === 'video') {
            bytes += entry.bytesReceived || 0;
            packets += entry.packetsReceived || 0;
            lost += entry.packetsLost || 0;
            jitter = entry.jitter != null ? Math.round(entry.jitter * 1000) : jitter;
          }
          if (entry.type === 'candidate-pair' && entry.state === 'succeeded' && entry.currentRoundTripTime != null) {
            rtt = Math.round(entry.currentRoundTripTime * 1000);
          }
          // Item 3: par SELECIONADO -> prova de qual caminho foi usado.
          // So com isso sabemos se o trafego saiu por relay (TURN) ou direto.
          if (entry.type === 'candidate-pair'
            && (entry.selected || entry.nominated)
            && entry.state === 'succeeded') {
            const parSelecionado = report.get(entry.localCandidateId);
            const remotoSelecionado = report.get(entry.remoteCandidateId);
            this.ice.noteSelectedPair({
              localCandidate: parSelecionado,
              remoteCandidate: remotoSelecionado,
            });
            this.emitState('ice_path', { ice: this.ice.report() });
          }
        });
        if (this.lastStats != null && bytes > this.lastStats.bytes) {
          const now = Date.now();
          const deltaSeconds = (now - this.lastStats.at) / 1000;
          this.stats.bitrateKbps = Math.round(((bytes - this.lastStats.bytes) * 8) / 1000 / Math.max(0.5, deltaSeconds));
        }
        if (lost > 0) this.stats.packetsLost = lost;
        if (rtt != null) this.stats.rtt = rtt;
        if (jitter != null) this.stats.jitterMs = jitter;
        this.stats.packetsReceived = packets;
        this.lastStats = { bytes, at: Date.now() };
        this.emitState('stats', { stats: { ...this.stats } });
      } catch { /* getStats pode falhar durante fechamento */ }
    }, 2000);
  }

  stopStats() {
    clearInterval(this.statsTimer);
    this.statsTimer = null;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.disconnectTimer);
    this.stopStats();
    for (const track of this.remoteStream.getTracks()) {
      try { track.stop(); } catch { /* ignore */ }
    }
    this.remoteStream = new MediaStream();
    if (this.pc) {
      try { this.pc.close(); } catch { /* ignore */ }
    }
    this.pc = null;
  }
}

/**
 * Mesh de LIVE: gerencia as conexoes de um usuario.
 */
export class LiveMesh {
  constructor({ role, onSignal, onPeerStream, onPeerState, iceServers }) {
    this.role = role;
    this.onSignal = onSignal;
    this.onPeerStream = onPeerStream;
    this.onPeerState = onPeerState;
    this.iceServers = iceServers;
    /** @type {Map<string, LiveConnection>} */
    this.peers = new Map();
    this.localStream = null;
  }

  setLocalStream(stream) {
    this.localStream = stream;
    for (const connection of this.peers.values()) {
      if (connection.role === 'host') {
        connection.localStream = stream;
        // Reconecta a midia sem criar conexao nova
        for (const track of stream.getTracks()) {
          const sender = connection.pc?.getSenders().find((s) => s.track?.kind === track.kind);
          if (sender) sender.replaceTrack(track).catch(() => {});
          else connection.pc?.addTrack(track, stream);
        }
      }
    }
  }

  get(peerId) {
    return this.peers.get(peerId) || null;
  }

  ensure(peerId) {
    let connection = this.peers.get(peerId);
    if (connection && !connection.closed) return connection;
    if (connection) {
      connection.close();
      this.peers.delete(peerId);
    }
    connection = new LiveConnection({
      role: this.role,
      peerId,
      iceServers: this.iceServers,
      localStream: this.role === 'host' ? this.localStream : null,
      onSignal: (signal) => this.onSignal(peerId, signal),
      onStream: (stream, meta) => this.onPeerStream(peerId, stream, meta),
      onState: (state) => this.onPeerState?.(peerId, state),
    });
    this.peers.set(peerId, connection);
    return connection;
  }

  remove(peerId) {
    const connection = this.peers.get(peerId);
    if (!connection) return;
    connection.close();
    this.peers.delete(peerId);
  }

  has(peerId) {
    const connection = this.peers.get(peerId);
    return Boolean(connection && !connection.closed);
  }

  /** Fecha TODAS as conexoes e para as faixas de midia remota. */
  destroy() {
    for (const connection of this.peers.values()) connection.close();
    this.peers.clear();
  }

  stats() {
    const out = { peers: this.peers.size, connections: [] };
    for (const [peerId, connection] of this.peers) {
      out.connections.push({
        peerId,
        state: connection.pc?.connectionState || 'new',
        ice: connection.pc?.iceConnectionState || 'new',
        stats: connection.stats,
        iceReport: connection.iceReport(),
      });
    }
    return out;
  }

  /**
   * Diagnostico de ICE de toda a malha. Consolida os candidatos de todas as
   * conexoes para o host/admin ver se o relay do TURN foi realmente obtido.
   */
  iceReport() {
    const total = { host: 0, srflx: 0, relay: 0, prflx: 0, other: 0 };
    let working = false;
    let gathered = false;
    const paths = [];
    for (const connection of this.peers.values()) {
      const r = connection.iceReport();
      for (const tipo of Object.keys(total)) total[tipo] += r.candidates[tipo] || 0;
      if (r.relayGathered) gathered = true;
      if (r.relayWorking) working = true;
      if (r.selected) paths.push(r.selected);
    }
    return {
      peers: this.peers.size,
      candidates: total,
      relayGathered: gathered,
      turnWorking: working,
      paths: [...new Set(paths)],
    };
  }

  /** Reinicia todos os pares (botao "Tentar novamente" / troca de rede). */
  hardResetAll(reason = 'manual') {
    for (const connection of this.peers.values()) connection.hardReset(reason);
  }
}

/** Monta a lista de servidores ICE a partir da configuracao do backend. */
/**
 * Diagnostico real de ICE.
 *
 * Estados reportados (item 2): configurado (variavel de ambiente preenchida),
 * relay (um candidato relay foi gathering) e working (o par CONECTADO esta
 * usando relay). So o ultimo prova que o TURN esta de fato relayando -
 * "configurado" nao e "funcionando".
 */
export class IceDiagnostics {
  constructor() {
    this.candidates = { host: 0, srflx: 0, relay: 0, prflx: 0, other: 0 };
    this.selected = null;
    this.turnConfigured = false;
  }

  /** Registra um candidato durante o gathering. */
  noteCandidate(candidate) {
    const type = candidate?.type;
    if (!type) return;
    if (type in this.candidates) this.candidates[type] += 1;
    else this.candidates.other += 1;
  }

  /** Qual tipo de caminho o par escolheu (selectedCandidatePair). */
  noteSelectedPair(pair) {
    const local = pair?.localCandidate?.type || null;
    const remote = pair?.remoteCandidate?.type || null;
    // O que importa para o relay e o TURN numa das pontas do caminho.
    if (local === 'relay' || remote === 'relay') this.selected = 'relay';
    else if (local === 'srflx' || remote === 'srflx') this.selected = 'srflx';
    else if (local === 'host' || remote === 'host') this.selected = 'host';
  }

  get relayGathered() {
    return this.candidates.relay > 0;
  }

  /** TURN so funciona quando um par conectado saiu por relay. */
  get relayWorking() {
    return this.selected === 'relay';
  }

  report() {
    return {
      turnConfigured: this.turnConfigured,
      turnWorking: this.relayWorking,
      relayGathered: this.relayGathered,
      selected: this.selected,
      candidates: { ...this.candidates },
    };
  }

  /** Texto de uma linha para o aviso (sem nomes de variaveis de ambiente). */
  line() {
    const r = this.report();
    if (r.turnWorking) return 'Transmissao via servidor relay (TURN).';
    if (r.relayGathered) return 'Relay TURN disponivel; conexao direta em uso.';
    if (r.turnConfigured) return 'TURN configurado; relay ainda nao usado nesta conexao.';
    return 'Conexao com a transmissao limitada.';
  }
}

/**
 * Lista de ICE a partir do que o backend devolveu. As credenciais do TURN
 * NUNCA vao para o frontend em HTML/JS publico: chegam pelo endpoint
 * autenticado de configuracao da LIVE.
 */
export function buildIceServers(config) {
  const list = [];
  if (config?.iceServers?.length) list.push(...config.iceServers);
  else list.push(...DEFAULT_ICE.iceServers);
  if (config?.turnServers?.length) list.push(...config.turnServers);
  return { iceServers: list, turnConfigured: Boolean(config?.turnConfigured) };
}

/**
 * Aviso COMPACTO de TURN (uma linha). Antes ocupava uma faixa grande no topo
 * da LIVE e despejava nomes de variaveis de infraestrutura na tela de quem
 * so assiste.
 */
export function turnWarning(config, { viewer = false } = {}) {
  if (config?.turnConfigured) return null;
  if (viewer) return 'Conexao com a transmissao limitada.';
  return 'Sem TURN: em redes restritivas a transmissao pode falhar.';
}

export function checkSupport() {
  return {
    rtc: typeof RTCPeerConnection !== 'undefined',
    getUserMedia: Boolean(navigator.mediaDevices?.getUserMedia),
    secure: window.isSecureContext,
    dataChannels: typeof RTCDataChannel !== 'undefined',
  };
}

