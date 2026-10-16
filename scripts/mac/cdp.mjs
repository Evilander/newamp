// A small DevTools-protocol client for driving a running NewAmp. The renderer
// is reached through --remote-debugging-port (the same way cpu-bench.mjs and
// ui-playlists-smoke.mjs do it) and the main process through --inspect, which
// speaks the same protocol. Uses the WebSocket and fetch globals of Node 22.
import { keyEvents } from './parsers.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class CdpSession {
  #socket;
  #seq = 0;
  #pending = new Map();
  #listeners = new Map();
  closed = false;

  constructor(socket, label) {
    this.#socket = socket;
    this.label = label;
    socket.addEventListener('message', (event) => this.#onMessage(event.data));
    socket.addEventListener('close', () => this.#onClose());
    socket.addEventListener('error', () => this.#onClose());
  }

  static async connect(url, label, timeoutMs = 8000) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label}: websocket did not open`)), timeoutMs);
      socket.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error(`${label}: websocket error`));
      });
    });
    return new CdpSession(socket, label);
  }

  #onMessage(data) {
    let message;
    try {
      message = JSON.parse(String(data));
    } catch {
      return;
    }
    if (message.id && this.#pending.has(message.id)) {
      const { resolve, reject, timer } = this.#pending.get(message.id);
      this.#pending.delete(message.id);
      clearTimeout(timer);
      if (message.error) reject(new Error(`${message.error.message ?? 'protocol error'} (${message.error.code})`));
      else resolve(message.result);
      return;
    }
    if (message.method) for (const listener of this.#listeners.get(message.method) ?? []) listener(message.params);
  }

  #onClose() {
    if (this.closed) return;
    this.closed = true;
    for (const [, entry] of this.#pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(`${this.label}: connection closed`));
    }
    this.#pending.clear();
  }

  send(method, params = {}, timeoutMs = 30000) {
    if (this.closed) return Promise.reject(new Error(`${this.label}: connection closed`));
    const id = ++this.#seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${this.label}: ${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.#socket.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, listener) {
    const list = this.#listeners.get(method) ?? [];
    list.push(listener);
    this.#listeners.set(method, list);
  }

  /**
   * Runs an expression and returns its value. A thrown error or a rejected
   * promise inside the page becomes a rejection here, carrying the page's own
   * message.
   */
  async evaluate(expression, { timeoutMs = 30000 } = {}) {
    const result = await this.send(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
      timeoutMs,
    );
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails;
      throw new Error(detail.exception?.description ?? detail.exception?.value ?? detail.text ?? 'evaluation failed');
    }
    return result.result?.value;
  }

  async pressKey(spec) {
    for (const event of keyEvents(spec)) await this.send('Input.dispatchKeyEvent', event);
  }

  async moveMouse(x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  }

  async wheel(x, y, deltaX, deltaY, modifiers = 0) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX, deltaY, modifiers });
  }

  close() {
    this.closed = true;
    try {
      this.#socket.close();
    } catch {
      /* already closed */
    }
  }
}

/** Polls /json/list on a debugging port until a target matching `want` shows up. */
export async function waitForTarget(port, want, { timeoutMs = 60000, label = 'target', abort } = {}) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    // `abort` returns a message once waiting is pointless (the app already exited).
    const reason = abort?.();
    if (reason) throw new Error(`${label}: ${reason}`);
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const found = list.find(want);
      if (found?.webSocketDebuggerUrl) return found;
    } catch (err) {
      lastError = err;
    }
    await sleep(400);
  }
  throw new Error(`${label}: nothing on port ${port} after ${timeoutMs} ms${lastError ? ` (${lastError.message})` : ''}`);
}

export { sleep };
