/**
 * Cliente minimo do Chrome DevTools Protocol.
 *
 * Usado pelos testes de navegador. Nao e um "mock": abre o Chrome de verdade
 * (headless), fala CDP por WebSocket e executa o JS da aplicacao na pagina.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  `${process.env.LOCALAPPDATA || ''}/Google/Chrome/Application/chrome.exe`,
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

export function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** Sobe o Chrome headless com uma porta de depuracao livre. */
export async function launchChrome({ extraArgs = [] } = {}) {
  const binary = findChrome();
  if (!binary) throw new Error('Chrome nao encontrado neste ambiente');

  const port = 9222 + Math.floor(Math.random() * 500);
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-chrome-'));
  const args = [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-extensions',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    // Midia real sintetica: getUserMedia devolve um MediaStream de verdade.
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    '--window-size=1280,900',
    ...extraArgs,
    'about:blank',
  ];

  const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const output = [];
  child.stdout.on('data', (c) => output.push(String(c)));
  child.stderr.on('data', (c) => output.push(String(c)));

  const wsEndpoint = await waitForEndpoint(port, 30_000, () => output.join(''));
  const browser = await Browser.connect(wsEndpoint, child, userDataDir, output);
  return browser;
}

async function waitForEndpoint(port, timeoutMs, output) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) {
        const json = await res.json();
        if (json.webSocketDebuggerUrl) return json.webSocketDebuggerUrl;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Chrome nao abriu a porta de depuracao.\n${output().split('\n').slice(-10).join('\n')}\n${lastError?.message || ''}`);
}

let sessionCounter = 0;

/** Uma sessao CDP (== uma aba). */
class Session {
  constructor(browser, sessionId, targetId) {
    this.browser = browser;
    this.sessionId = sessionId;
    this.targetId = targetId;
    this.consoleErrors = [];
    this.pageErrors = [];
    this.failedRequests = [];
    this.requests = [];
    /** Erros de console provocados de proposito pelo teste (ex.: violacao CSP). */
    this.expectedConsole = [];
  }

  send(method, params = {}) {
    return this.browser.send(method, params, this.sessionId);
  }

  on(method, handler) {
    this.browser.on(method, handler, this.sessionId);
  }

  /** Liga a captura de console/rede antes de navegar. */
  watch() {
    this.on('Runtime.consoleAPICalled', (params) => {
      if (params.type === 'error' || params.type === 'warning') {
        const text = (params.args || [])
          .map((a) => (a.value !== undefined ? String(a.value) : a.description || a.type))
          .join(' ');
        if (params.type === 'error') this.consoleErrors.push(text);
        else if (/deprecat|violation/i.test(text)) this.consoleErrors.push(`[warn] ${text}`);
      }
    });
    this.on('Runtime.exceptionThrown', (params) => {
      const d = params.exceptionDetails || {};
      this.pageErrors.push(d.exception?.description || d.text || 'erro desconhecido');
    });
    this.on('Log.entryAdded', (params) => {
      const entry = params.entry || {};
      if (entry.level === 'error') this.consoleErrors.push(`[log] ${entry.text}`);
    });
    this.on('Network.requestWillBeSent', (params) => {
      this.requests.push({ url: params.request.url, method: params.request.method });
    });
    this.on('Network.loadingFailed', (params) => {
      // Cancelamento de requisicao (ex.: navegar durante um fetch) nao e erro.
      if (params.canceled) return;
      this.failedRequests.push({
        url: params.requestId,
        error: params.errorText,
        type: params.type,
      });
    });
    return this;
  }

  async goto(url, { waitMs = 0 } = {}) {
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    await this.send('Network.enable');
    await this.send('Log.enable');
    await this.send('Page.navigate', { url });
    await this.waitForFunction('document.readyState === "complete"', 20_000)
      .catch(() => { /* segue mesmo sem readyState completo */ });
    if (waitMs) await sleep(waitMs);
    return this;
  }

  async eval(expression, { awaitPromise = true } = {}) {
    const result = await this.send('Runtime.evaluate', {
      expression: `(async () => { ${expression} })()`,
      awaitPromise,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      const d = result.exceptionDetails;
      throw new Error(`JS no navegador: ${d.exception?.description || d.text}`);
    }
    return result.result?.value;
  }

  /**
   * Espera uma condicao no navegador.
   *
   * Aceita tanto uma expressao (`document.title`) quanto um corpo com `return`
   * (`const x = ...; return x;`). O `Runtime.evaluate` e reavaliado a cada
   * tentativa, entao o corpo pode usar `await`.
   */
  async waitForFunction(source, timeoutMs = 8000, { pollMs = 120 } = {}) {
    const isBody = /\breturn\b/.test(source);
    const code = isBody ? source : `return (${source});`;
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      try {
        // eslint-disable-next-line no-await-in-loop
        last = await this.eval(code);
        if (last) return last;
      } catch (error) {
        last = error.message;
      }
      // eslint-disable-next-line no-await-in-loop
      await sleep(pollMs);
    }
    throw new Error(
      `Timeout esperando condicao no navegador: ${source.slice(0, 140)} (ultimo=${JSON.stringify(last)})`,
    );
  }

  /**
   * Mouse REAL via CDP (eventos confiaveis, nao sinteticos).
   * `type`: mousePressed | mouseMoved | mouseReleased
   */
  async mouse(type, x, y, { button = 'left', clickCount = 1 } = {}) {
    await this.send('Input.dispatchMouseEvent', {
      type, x: Math.round(x), y: Math.round(y), button, clickCount, buttons: button === 'left' ? 1 : 0,
    });
  }

  /** Arrasta com o mouse em varios passos (gera pointerdown/move/up reais). */
  async drag(from, to, steps = 8) {
    await this.mouse('mousePressed', from.x, from.y);
    for (let i = 1; i <= steps; i += 1) {
      const t = i / steps;
      // eslint-disable-next-line no-await-in-loop
      await this.mouse('mouseMoved', from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t);
      // eslint-disable-next-line no-await-in-loop
      await sleep(16);
    }
    await this.mouse('mouseReleased', to.x, to.y);
  }

  /** Encaminha um evento de toque real (para validar o caminho de touch). */
  async touchDrag(points) {
    await this.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: Math.round(points[0].x), y: Math.round(points[0].y), id: 1 }],
    });
    for (const point of points.slice(1)) {
      // eslint-disable-next-line no-await-in-loop
      await this.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: Math.round(point.x), y: Math.round(point.y), id: 1 }],
      });
      // eslint-disable-next-line no-await-in-loop
      await sleep(16);
    }
    const last = points[points.length - 1];
    await this.send('Input.dispatchTouchEvent', {
      type: 'touchEnd', touchPoints: [],
    });
    return last;
  }

  /** Fecha só a aba; o navegador continua vivo para outras sessoes. */
  async close() {
    try {
      await this.browser.send('Target.closeTarget', { targetId: this.targetId });
    } catch { /* ja fechada */ }
  }

  get errors() {
    return [...this.pageErrors, ...this.consoleErrors];
  }
}

class Browser {
  constructor(ws, child, userDataDir, output) {
    this.ws = ws;
    this.child = child;
    this.userDataDir = userDataDir;
    this.output = output;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Map();
  }

  static async connect(endpoint, child, userDataDir, output) {
    const ws = new WebSocket(endpoint, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    const browser = new Browser(ws, child, userDataDir, output);
    ws.on('message', (raw) => browser.handleMessage(String(raw)));
    return browser;
  }

  handleMessage(raw) {
    let message;
    try { message = JSON.parse(raw); } catch { return; }
    if (message.id && this.pending.has(message.id)) {
      const { resolve, reject, method } = this.pending.get(message.id);
      this.pending.delete(message.id);
      // O nome do metodo vai na mensagem: "Invalid parameters (-32602)" sozinho
      // nao diz QUAL chamada do CDP foi recusada, e essa informacao ja custou
      // varias rodadas de depuracao.
      if (message.error) {
        const erro = new Error(`${message.method || method} falhou: `
          + `${message.error.message} (${message.error.code})`);
        erro.code = message.error.code;
        erro.method = message.method || method || null;
        erro.dados = message.error.data ?? null;
        reject(erro);
      } else resolve(message.result);
      return;
    }
    if (message.method) {
      const key = `${message.sessionId || ''}:${message.method}`;
      for (const handler of this.listeners.get(key) || []) {
        try { handler(message.params || {}); } catch { /* handler nao pode derrubar o CDP */ }
      }
      for (const handler of this.listeners.get(message.method) || []) {
        try { handler(message.params || {}, message.sessionId); } catch { /* ignore */ }
      }
    }
  }

  on(method, handler, sessionId = null) {
    const key = `${sessionId || ''}:${method}`;
    if (!this.listeners.has(key)) this.listeners.set(key, []);
    this.listeners.get(key).push(handler);
  }

  send(method, params = {}, sessionId = null) {
    this.nextId += 1;
    const id = this.nextId;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} sem resposta em 30s`));
      }, 30_000);
      this.pending.set(id, {
        method,
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.ws.send(JSON.stringify(payload));
    });
  }

  /** Nova aba (target) + sessao CDP ja conectada. */
  async newPage() {
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    sessionCounter += 1;
    const session = new Session(this, sessionId, targetId);
    return session;
  }

  /** Navegador isolado (outro perfil) - usado para o 2o participante da LIVE. */
  async newBrowserContext() {
    const { browserContextId } = await this.send('Target.createBrowserContext', { disposeOnDetach: false });
    const { targetId } = await this.send('Target.createTarget', {
      url: 'about:blank',
      browserContextId,
    });
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    return new Session(this, sessionId, targetId);
  }

  async close() {
    try { this.ws.close(); } catch { /* ignore */ }
    if (this.child && this.child.exitCode === null) {
      this.child.kill();
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 4000);
        this.child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        fs.rmSync(this.userDataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 300));
      }
    }
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}