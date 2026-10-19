'use strict';
// @ts-check
// Adaptador de Chrome (Chrome DevTools Protocol): conexión persistente al navegador del kiosco, la pestaña activa
// y llamadas con respuesta (call) o sin ella (fire). Genérico: lo que cada capacidad quiere saber (página nueva,
// pestaña perdida, avisos de los scripts de la página) le llega por `hooks`. Se reconecta solo.
const http = require('node:http');
const { WebSocket } = require('ws');

function getJSON(url) {
  return new Promise((resolve, reject) => {
    http.get(url, { timeout: 2000 }, res => {
      let d = '';
      res.on('data', c => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('timeout')); });
  });
}

/**
 * @typedef {{ targetId: string, type: string, url: string, title: string }} TargetInfo
 * @typedef {{
 *   onDown?: () => void,                                  // se perdió la conexión con Chrome
 *   onActivating?: () => void,                            // se va a enganchar otra pestaña
 *   onAttached?: (t: TargetInfo | undefined) => void,     // pestaña activa enganchada (sesión lista)
 *   onPage?: (t: TargetInfo) => void,                     // la pestaña activa cambió de URL o título
 *   onActiveGone?: (hasNext: boolean) => void,            // se cerró la pestaña activa
 *   onDetached?: () => void,                              // la sesión de la pestaña activa se soltó
 *   onBinding?: (name: string, payload: string) => void,  // un script de la página llamó a un binding (Runtime.addBinding)
 * }} Hooks
 */

/**
 * @param {{ port: number, log: { info: Function, error: Function }, hooks?: Hooks, retryMs?: number, timeoutMs?: number }} o
 */
function createCdp({ port, log, hooks = {}, retryMs = 2000, timeoutMs = 5000 }) {
  const h = { onDown() {}, onActivating() {}, onAttached() {}, onPage() {}, onActiveGone() {}, onDetached() {}, onBinding() {}, ...hooks };
  const cdp = {
    /** @type {WebSocket | null} */ ws: null, id: 0, pending: new Map(), stopped: false,
    /** @type {string | null} */ session: null,
    /** @type {string | null} */ targetId: null,
    /** @type {Map<string, TargetInfo>} */ pages: new Map(),
    /** contextos de los mundos aislados con nombre del marco principal (p. ej. «tv») */ worlds: new Map(),
    ready: false,

    async connect() {
      if (this.stopped) return;
      let v;
      try { v = await getJSON(`http://127.0.0.1:${port}/json/version`); }
      catch { setTimeout(() => this.connect(), retryMs).unref?.(); return; }
      if (this.stopped) return;
      const ws = new WebSocket(v.webSocketDebuggerUrl, { perMessageDeflate: false });
      this.ws = ws;
      ws.on('open', () => {
        this.ready = true;
        this.send('Target.setDiscoverTargets', { discover: true });
        log.info('CDP conectado');
      });
      ws.on('message', d => { try { this.onMessage(JSON.parse(d.toString())); } catch {} });
      ws.on('error', () => {});
      ws.on('close', () => { this.down(); if (!this.stopped) setTimeout(() => this.connect(), retryMs).unref?.(); });
    },
    stop() { this.stopped = true; try { this.ws && this.ws.close(); } catch {} },

    down() {
      this.ready = false; this.session = null; this.targetId = null; this.pages.clear(); this.worlds.clear();
      for (const [, p] of this.pending) { clearTimeout(p.t); p.rej(new Error('cdp')); }
      this.pending.clear();
      h.onDown();
    },

    send(method, params = {}, sessionId) {
      const id = ++this.id;
      const msg = { id, method, params };
      if (sessionId) msg.sessionId = sessionId;
      /** @type {WebSocket} */ (this.ws).send(JSON.stringify(msg));
      return id;
    },

    /** Llamada con respuesta, en la pestaña activa (o al navegador con browser = true). */
    call(method, params = {}, browser = false) {
      return new Promise((res, rej) => {
        if (!this.ready || !this.ws || this.ws.readyState !== WebSocket.OPEN) return rej(new Error('cdp'));
        const sid = browser ? undefined : this.session;
        if (!browser && !sid) return rej(new Error('nopage'));
        const id = this.send(method, params, sid || undefined);
        const t = setTimeout(() => { this.pending.delete(id); rej(new Error('timeout')); }, timeoutMs);
        this.pending.set(id, { res, rej, t });
      });
    },

    /** Sin esperar respuesta (camino rápido de teclas y texto). */
    fire(method, params) {
      if (this.ready && this.session && this.ws && this.ws.readyState === WebSocket.OPEN) this.send(method, params, this.session);
    },

    onMessage(m) {
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id); clearTimeout(p.t);
        return m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
      }
      if (!m.method) return;
      const pr = m.params || {};
      switch (m.method) {
        case 'Target.targetCreated':
        case 'Target.targetInfoChanged': {
          const t = pr.targetInfo;
          if (!t || t.type !== 'page' || /^(devtools|chrome-extension):/.test(t.url)) return;
          this.pages.set(t.targetId, t);
          if (m.method === 'Target.targetCreated' || !this.targetId) this.activate(t.targetId);
          if (t.targetId === this.targetId) h.onPage(t);
          break;
        }
        case 'Target.targetDestroyed': {
          this.pages.delete(pr.targetId);
          if (pr.targetId === this.targetId) {
            this.targetId = null; this.session = null; this.worlds.clear();
            const next = [...this.pages.keys()].pop();
            h.onActiveGone(!!next);
            if (next) this.activate(next);
          }
          break;
        }
        case 'Target.detachedFromTarget':
          if (pr.sessionId === this.session) { this.session = null; this.worlds.clear(); h.onDetached(); }
          break;
        case 'Runtime.bindingCalled': // solo de la sesión activa
          if (m.sessionId === this.session) h.onBinding(pr.name, pr.payload);
          break;
        case 'Runtime.executionContextCreated': { // mundo aislado con nombre del marco principal
          const c = pr.context || {};
          if (m.sessionId === this.session && c.name && c.auxData && c.auxData.frameId === this.targetId) this.worlds.set(c.name, c.id);
          break;
        }
        case 'Runtime.executionContextsCleared':
          if (m.sessionId === this.session) this.worlds.clear();
          break;
      }
    },

    /** Engancha una pestaña como activa (suelta la anterior, que si no sigue mandando eventos). */
    async activate(id) {
      if (this.targetId === id && this.session) return;
      const old = this.session;
      this.targetId = id; this.session = null; this.worlds.clear();
      h.onActivating();
      if (old) this.call('Target.detachFromTarget', { sessionId: old }, true).catch(() => {});
      try {
        const r = await this.call('Target.attachToTarget', { targetId: id, flatten: true }, true);
        if (this.targetId !== id) { this.call('Target.detachFromTarget', { sessionId: r.sessionId }, true).catch(() => {}); return; } // ya se activó otra
        this.session = r.sessionId;
        h.onAttached(this.pages.get(id));
      } catch {}
    },
  };
  return cdp;
}

module.exports = { createCdp, getJSON };
