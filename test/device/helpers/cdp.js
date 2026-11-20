// 最小の Chrome DevTools Protocol の入口（担当 F）。Node.js 標準の WebSocket だけを使う（依存なし）。
// adb forward で PC の 127.0.0.1:<9222〜9229> に出したスマホの Chrome に、つなぐ。
// スマホの中のファイルは読まない。ページの中の JavaScript を評価して、値を受け取るだけ。

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function httpJson(url, { method = 'GET', timeoutMs = 5000 } = {}) {
  const res = await fetch(url, { method, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return text; }
}

export class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.closed = false;
    ws.addEventListener('message', (ev) => {
      let m;
      try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8')); } catch { return; }
      if (m.id !== undefined) {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        clearTimeout(p.timer);
        if (m.error) p.reject(Object.assign(new Error(`${p.method}: ${m.error.message}`), { cdp: m.error }));
        else p.resolve(m.result);
      } else if (m.method) {
        for (const fn of this.listeners.get(m.method) || []) { try { fn(m.params); } catch { /* 無視 */ } }
      }
    });
    const onEnd = () => {
      this.closed = true;
      for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error(`cdp-closed during ${p.method}`)); }
      this.pending.clear();
      for (const fn of this.listeners.get('__closed') || []) { try { fn(); } catch { /* 無視 */ } }
    };
    ws.addEventListener('close', onEnd);
    ws.addEventListener('error', () => { /* close で処理する */ });
  }

  static connect(wsUrl, { timeoutMs = 10000 } = {}) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const timer = setTimeout(() => { try { ws.close(); } catch { /* 無視 */ } reject(new Error('cdp-connect-timeout')); }, timeoutMs);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(new Cdp(ws)); });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('cdp-connect-error')); });
    });
  }

  on(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(fn);
  }

  send(method, params = {}, timeoutMs = 30000) {
    if (this.closed) return Promise.reject(new Error(`cdp-closed: ${method}`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`cdp-timeout: ${method} (${timeoutMs} ms)`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try { this.ws.send(JSON.stringify({ id, method, params })); } catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }

  /** ページの中で式を評価し、値（JSON）を返す。Promise は待つ。userGesture を真にすると、マイクなどの許可の要求が通る。 */
  async eval(expression, { userGesture = false, timeoutMs = 30000 } = {}) {
    const r = await this.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true, userGesture, timeout: timeoutMs,
    }, timeoutMs + 5000);
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      const msg = (d.exception && (d.exception.description || d.exception.value)) || d.text;
      throw new Error(`page-exception: ${String(msg).split('\n')[0]}`);
    }
    return r.result ? r.result.value : undefined;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.ws.close(); } catch { /* 無視 */ }
  }
}
