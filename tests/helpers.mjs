/**
 * Infraestrutura dos testes.
 * Sobe um servidor real (porta propria + banco temporario) e fornece
 * clientes HTTP e WebSocket com sessoes independentes.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { WebSocket } from 'ws';
import { ROOT } from '../server/config.js';

/**
 * Servidores vivos, indexados pelo diretorio temporario.
 *
 * Nao pode ser uma variavel unica: os testes sobem servidores aninhados
 * (ex.: "ffmpeg ausente") e cada `stop()` precisa encerrar O SEU processo.
 */
const running = new Map();

export function tempDir(prefix = 'pulse-test') {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

export function randomUsername(prefix = 'u') {
  return `${prefix}${crypto.randomBytes(4).toString('hex')}`;
}

/** Sobe o servidor com um banco e storage proprios. */
export async function startServer({ port = 0, env = {} } = {}) {
  const dir = tempDir('pulse-run');
  const chosenPort = port || 3200 + Math.floor(Math.random() * 400);
  const databasePath = path.join(dir, 'test.db');
  const storageRoot = path.join(dir, 'storage');

  const childEnv = {
    ...process.env,
    NODE_ENV: 'test',
    PORT: String(chosenPort),
    HOST: '127.0.0.1',
    PUBLIC_URL: `http://127.0.0.1:${chosenPort}`,
    DATABASE_PATH: databasePath,
    STORAGE_ROOT: storageRoot,
    MEDIA_TRANSCODE: 'true',
    MEDIA_HLS: 'true',
    LOG_LEVEL: 'warn',
    SESSION_SECRET: 'test-secret-nao-usar-em-producao-000000000',
    LIVE_TOKEN_SECRET: 'test-live-secret-0000000000000000000000',
    // Os testes speaks HTTP mesmo quando o `.env` de desenvolvimento liga
    // HTTPS (item 9): o `.env` e lido do disco pelo servidor, entao sem isto
    // cada suite subiria em TLS e o health check em http:// falharia. O HTTPS
    // de desenvolvimento tem verificacao propria em scripts/verify-https.mjs.
    TLS_CERT_PATH: '',
    TLS_KEY_PATH: '',
    TLS_CA_PATH: '',
    ...env,
  };

  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'main.js')], {
    cwd: ROOT,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  running.set(dir, child);

  const baseUrl = `http://127.0.0.1:${chosenPort}`;
  const wsUrl = `ws://127.0.0.1:${chosenPort}/ws`;

  const logs = [];
  child.stdout.on('data', (chunk) => logs.push(String(chunk)));
  child.stderr.on('data', (chunk) => logs.push(String(chunk)));

  const ready = await waitForHealth(baseUrl, 60000);
  if (!ready) {
    const tail = logs.join('').split('\n').slice(-25).join('\n');
    // Nao deixa processo orfao quando o boot falha.
    await stopServer(dir);
    throw new Error(`Servidor nao subiu a tempo.\n${tail}`);
  }

  return {
    baseUrl,
    wsUrl,
    dir,
    databasePath,
    storageRoot,
    logs,
    dumpLogs(lines = 30) {
      return logs.join('').split('\n').slice(-lines).join('\n');
    },
    stop: () => stopServer(dir),
  };
}

/**
 * Encerra um servidor e apaga o diretorio temporario.
 *
 * No Windows o ffmpeg pode segurar o handle do arquivo por alguns ms depois
 * de sair: a remocao e tentada com retry e, se ainda assim falhar, o SO
 * limpa o `%TEMP%`. Falha de limpeza NAO deve reprovar um teste.
 */
export async function stopServer(dir) {
  const child = dir ? running.get(dir) : null;
  if (child && child.exitCode === null && !child.killed) {
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 5000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
  if (dir) {
    running.delete(dir);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
        return;
      } catch (err) {
        if (attempt === 4) {
          console.warn(`  (aviso) nao foi possivel apagar ${path.basename(dir)}: ${err.code}`);
          return;
        }
        await new Promise((r) => setTimeout(r, 300));
      }
    }
  }
}

async function waitForHealth(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(15000) });
      if (res.ok) return true;
    } catch { /* ainda subindo */ }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return false;
}

// --------------------------------------------------------------------------
// Cliente HTTP com cookies + CSRF
// --------------------------------------------------------------------------
export class Client {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
    this.cookies = new Map();
    this.csrf = null;
    this.user = null;
  }

  cookieHeader() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  storeCookies(res) {
    const raw = res.headers.getSetCookie?.() || [];
    for (const line of raw) {
      const [pair] = line.split(';');
      const idx = pair.indexOf('=');
      if (idx === -1) continue;
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      if (value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
      if (name === 'pulse_csrf') this.csrf = value;
    }
  }

  async request(method, urlPath, { body, headers = {}, raw = false, expectStatus = null, query = null } = {}) {
    // `query` monta a querystring. Sem isto um `get(rota, { query })` era
    // silenciosamente ignorado e a paginacao devolvia sempre a primeira
    // pagina - o teste "sem repetidos entre paginas" passava sem exercitar.
    let target = urlPath;
    if (query && typeof query === 'object') {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null || v === '') continue;
        params.set(k, String(v));
      }
      const qs = params.toString();
      if (qs) target += (target.includes('?') ? '&' : '?') + qs;
    }
    const init = {
      method,
      headers: {
        'X-Requested-With': 'test',
        ...headers,
      },
      redirect: 'manual',
    };
    if (this.cookies.size) init.headers.Cookie = this.cookieHeader();
    if (method !== 'GET' && method !== 'HEAD' && this.csrf) {
      init.headers['X-CSRF-Token'] = this.csrf;
    }
    if (body instanceof FormData) {
      init.body = body;
    } else if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    const res = await fetch(`${this.baseUrl}${target}`, { ...init, signal: AbortSignal.timeout(30000) });
    this.storeCookies(res);

    let payload = null;
    if (raw) payload = res;
    else {
      const text = await res.text();
      try { payload = text ? JSON.parse(text) : null; } catch { payload = { _raw: text }; }
    }

    if (expectStatus !== null && res.status !== expectStatus) {
      throw new Error(`${method} ${urlPath} esperava ${expectStatus}, recebeu ${res.status}: ${JSON.stringify(payload).slice(0, 300)}`);
    }
    return { status: res.status, body: payload, headers: res.headers };
  }

  get(urlPath, options) { return this.request('GET', urlPath, options); }
  post(urlPath, body, options) { return this.request('POST', urlPath, { ...options, body }); }
  patch(urlPath, body, options) { return this.request('PATCH', urlPath, { ...options, body }); }
  delete(urlPath, body, options) { return this.request('DELETE', urlPath, { ...options, body }); }

  async register({ username, password = 'Senha@Teste123', email } = {}) {
    const user = username || randomUsername();
    const result = await this.post('/api/auth/register', {
      email: email || `${user}@pulse.test`,
      username: user,
      password,
      displayName: user.toUpperCase(),
    });
    if (result.status !== 201) {
      throw new Error(`Cadastro falhou (${result.status}): ${JSON.stringify(result.body)}`);
    }
    this.user = result.body.user;
    return this.user;
  }

  async login(email, password = 'Senha@Teste123') {
    const result = await this.post('/api/auth/login', { email, password });
    if (result.status === 200) this.user = result.body.user;
    return result;
  }

  async upload(path, buffer, { filename = 'arquivo.bin', mime = 'application/octet-stream', field = 'file' } = {}) {
    const form = new FormData();
    form.append(field, new Blob([buffer], { type: mime }), filename);
    const result = await this.request('POST', path, { body: form });
    return result;
  }
}

// --------------------------------------------------------------------------
// Cliente WebSocket
// --------------------------------------------------------------------------
export class RealtimeClient {
  constructor(wsUrl, client) {
    this.wsUrl = wsUrl;
    this.client = client;
    this.ws = null;
    this.events = [];
    this.errors = [];
    this.listeners = new Set();
    this.seq = 0;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const headers = {};
      if (this.client?.cookies?.size) {
        headers.Cookie = this.client.cookieHeader();
      }
      this.ws = new WebSocket(this.wsUrl, { headers });
      const timer = setTimeout(() => reject(new Error('Timeout no WS')), 15000);

      this.ws.on('open', () => {
        const token = this.client?.csrf; // csrf nao autentica WS; usamos o cookie
        void token;
        this.ws.send(JSON.stringify({ type: 'SUBSCRIBE', data: { topics: [] } }));
        clearTimeout(timer);
        resolve(this);
      });
      this.ws.on('error', (err) => { clearTimeout(timer); reject(err); });
      this.ws.on('message', (data) => {
        let frame;
        try { frame = JSON.parse(data.toString()); } catch { return; }
        if (frame.type === 'EVENT') {
          this.seq += 1;
          this.events.push(frame.data);
          for (const listener of this.listeners) listener(frame.data);
        } else if (frame.type === 'ERROR') {
          this.errors.push(frame.data);
        } else if (frame.type === 'AUTH_OK' || frame.type === 'HELLO') {
          this.handshake = frame;
        } else if (frame.type === 'SUBSCRIBED') {
          // Guarda os topicos ACEITOS: e assim que se prova que o servidor
          // recusou uma inscricao (filtro de papel no backend).
          this.subscribed = frame.data;
        }
      });
    });
  }

  send(frame) {
    this.ws.send(JSON.stringify(frame));
  }

  /** Aceita string ou array de topicos. */
  subscribe(topics) {
    const list = Array.isArray(topics) ? topics : [topics];
    this.send({ type: 'SUBSCRIBE', data: { topics: list.filter(Boolean) } });
  }

  publish(event, data) {
    this.send({ type: 'PUBLISH', data: { event, ...data } });
  }

  /** Espera por um evento que satisfaz o predicado (com timeout). */
  waitFor(predicate, { timeoutMs = 6000, label = 'evento' } = {}) {
    const existing = this.events.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners.delete(listener);
        reject(new Error(`Timeout esperando ${label}. Eventos recebidos: ${this.events.map((e) => e.type).join(', ') || '(nenhum)'}`));
      }, timeoutMs);
      const listener = (event) => {
        if (!predicate(event)) return;
        clearTimeout(timer);
        this.listeners.delete(listener);
        resolve(event);
      };
      this.listeners.add(listener);
    });
  }

  eventsOfType(type) {
    return this.events.filter((e) => e.type === type);
  }

  clear() {
    this.events.length = 0;
    this.errors.length = 0;
  }

  close() {
    try { this.ws?.close(); } catch { /* ignore */ }
  }
}

// --------------------------------------------------------------------------
// Relatorio simples
// --------------------------------------------------------------------------
export class Report {
  constructor(title) {
    this.title = title;
    this.checks = [];
    this.startedAt = Date.now();
  }

  ok(name, detail = '') {
    this.checks.push({ name, pass: true, detail });
    console.log(`  OK   ${name}${detail ? ` - ${detail}` : ''}`);
  }

  fail(name, error, detail = '') {
    const message = error?.message || String(error);
    this.checks.push({ name, pass: false, detail: `${message}${detail ? ` | ${detail}` : ''}` });
    console.log(`  FALHA ${name} - ${message}${detail ? ` | ${detail}` : ''}`);
  }

  async step(name, fn) {
    try {
      const detail = await fn();
      this.ok(name, typeof detail === 'string' ? detail : '');
      return detail;
    } catch (error) {
      this.fail(name, error);
      throw error;
    }
  }

  summary() {
    const passed = this.checks.filter((c) => c.pass).length;
    const failed = this.checks.length - passed;
    console.log(`\n[${this.title}] ${passed} ok, ${failed} falha(s) em ${((Date.now() - this.startedAt) / 1000).toFixed(1)}s`);
    return { passed, failed, checks: this.checks };
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Espera ate a condicao ser verdadeira (poll). */
export async function waitUntil(fn, { timeoutMs = 8000, intervalMs = 200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last) return last;
    } catch (err) {
      last = err;
    }
    await sleep(intervalMs);
  }
  throw new Error(`waitUntil expirou: ${last instanceof Error ? last.message : 'condicao falsa'}`);
}

// --------------------------------------------------------------------------
// Fabrica de midia real (ffmpeg): video e imagem validos para upload
// --------------------------------------------------------------------------
let ffmpegBin = null;
async function ffmpeg() {
  if (ffmpegBin) return ffmpegBin;
  const mod = await import('ffmpeg-static');
  ffmpegBin = mod.default || mod;
  return ffmpegBin;
}

/** Video MP4 real de teste (padroes de teste do ffmpeg), com audio. */
export async function makeTestVideo({ seconds = 2, width = 480, height = 854, withAudio = true, color = 'blue' } = {}) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const bin = await ffmpeg();
  const out = path.join(tempDir('pulse-media'), `video-${crypto.randomBytes(3).toString('hex')}.mp4`);
  const args = [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc=size=${width}x${height}:rate=25:duration=${seconds}`,
    '-f', 'lavfi', '-i', `color=c=${color}:s=${width}x${height}:r=25:d=${seconds}`,
    '-filter_complex', '[0:v][1:v]blend=all_mode=screen:all_opacity=0.5,format=yuv420p[v]',
  ];
  if (withAudio) {
    args.push('-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}:sample_rate=44100`);
    args.push('-map', '[v]', '-map', '2:a', '-c:a', 'aac', '-b:a', '64k', '-shortest');
  } else {
    args.push('-map', '[v]', '-an');
  }
  args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-t', String(seconds), out);
  await run(bin, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  return { path: out, buffer: fs.readFileSync(out), filename: path.basename(out), mime: 'video/mp4' };
}

/** WebM com alpha (para testar efeitos no navegador). */
export async function makeTestAlphaWebm({ seconds = 1, width = 320, height = 320 } = {}) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const bin = await ffmpeg();
  const out = path.join(tempDir('pulse-media'), `alpha-${crypto.randomBytes(3).toString('hex')}.webm`);
  await run(bin, [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=0x00FF00:s=${width}x${height}:d=${seconds}:r=15,format=rgba`,
    '-vf', `format=gbrap,colorkey=0x00FF00:0.3:0.1,format=yuva420p`,
    '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-auto-alt-ref', '0', '-b:v', '200k', '-deadline', 'realtime',
    out,
  ], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  return { path: out, buffer: fs.readFileSync(out), filename: path.basename(out), mime: 'video/webm' };
}

/** Imagem PNG real. */
export async function makeTestImage({ width = 320, height = 320, color = 'red' } = {}) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const bin = await ffmpeg();
  const out = path.join(tempDir('pulse-media'), `image-${crypto.randomBytes(3).toString('hex')}.png`);
  await run(bin, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${color}:s=${width}x${height}`, '-frames:v', '1', out], { windowsHide: true });
  return { path: out, buffer: fs.readFileSync(out), filename: path.basename(out), mime: 'image/png' };
}

/** Audio WAV real (gravacao de chat). */
export async function makeTestAudio({ seconds = 1, frequency = 440 } = {}) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const bin = await ffmpeg();
  const out = path.join(tempDir('pulse-media'), `audio-${crypto.randomBytes(3).toString('hex')}.wav`);
  await run(bin, [
    '-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=${frequency}:duration=${seconds}:sample_rate=44100`,
    '-ac', '1', out,
  ], { windowsHide: true });
  return { path: out, buffer: fs.readFileSync(out), filename: path.basename(out), mime: 'audio/wav' };
}

export { ROOT };
