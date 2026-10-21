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
 * @typedef {(method: string, params?: object) => Promise<any>} Call
 * @typedef {{
 *   onDown?: () => void,                                  // se perdió la conexión con Chrome
 *   onActivating?: () => void,                            // se va a enganchar otra pestaña
 *   onAttached?: (t: TargetInfo | undefined, from?: Call | null) => any, // pestaña activa enganchada (sesión lista); su promesa, show() la espera
 *   onLeft?: (call: Call) => any,                         // show() trajo otra al frente: call va a la que se deja
 *   onPage?: (t: TargetInfo) => void,                     // la pestaña activa cambió de URL o título
 *   onActiveGone?: (hasNext: boolean) => void,            // se cerró la pestaña activa
 *   onDetached?: () => void,                              // la sesión de la pestaña activa se soltó
 *   onBinding?: (name: string, payload: string) => void,  // un script de la página llamó a un binding (Runtime.addBinding)
 * }} Hooks
 */

// onAttached puede devolver una promesa (pintar en la pestaña aún detrás): show() la espera, como mucho frontWaitMs, antes de
// traerla al frente; desde show() recibe además `from`, una llamada a la pestaña que se va a dejar (aún enganchada y a la
// vista: lo que se ve en ella). onLeft recibe esa misma llamada ya con la nueva al frente; luego se suelta.
// show(): lo que espera como mucho a quien escucha onAttached (pintar en la pestaña antes de que se vea) y a onLeft (quitar
// lo suyo de la que se deja). Corto: el cambio de pestaña nunca se cuelga por una página que no contesta
const FRONT_WAIT_MS = 300;

/** La promesa `p` o, como mucho, `ms` (nunca rechaza). @param {any} p @param {number} ms */
function capped(p, ms) {
  if (!p || typeof p.then !== 'function') return Promise.resolve();
  let t;
  return Promise.race([Promise.resolve(p).catch(() => {}), new Promise(r => { t = setTimeout(r, ms); })]).finally(() => clearTimeout(t));
}

/**
 * @param {{ port: number, log: { info: Function, error: Function }, hooks?: Hooks, retryMs?: number, timeoutMs?: number, frontWaitMs?: number }} o
 */
function createCdp({ port, log, hooks = {}, retryMs = 2000, timeoutMs = 5000, frontWaitMs = FRONT_WAIT_MS }) {
  const h = { onDown() {}, onActivating() {}, onAttached() {}, onLeft() {}, onPage() {}, onActiveGone() {}, onDetached() {}, onBinding() {}, ...hooks };
  const cdp = {
    /** @type {WebSocket | null} */ ws: null, id: 0, pending: new Map(), stopped: false,
    /** @type {string | null} */ session: null,
    /** @type {string | null} */ targetId: null,
    /** @type {Map<string, TargetInfo>} */ pages: new Map(),
    /** contextos de los mundos aislados con nombre del marco principal (p. ej. «tv») */ worlds: new Map(),
    ready: false,
    /** @type {Promise<{ ready: any } | undefined> | null} enganche en curso (activate) */ attaching: null,

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
      return this.request(method, params, browser ? undefined : this.session, browser);
    },
    /** Llamada con respuesta a una sesión dada (la de la pestaña que se deja, en show) o al navegador (browser). */
    request(method, params = {}, /** @type {string | null | undefined} */ sid = undefined, browser = false) {
      return new Promise((res, rej) => {
        if (!this.ready || !this.ws || this.ws.readyState !== WebSocket.OPEN) return rej(new Error('cdp'));
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
          if (m.method === 'Target.targetCreated' || !this.targetId) this.autoActivate(t.targetId);
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

    /** Suelta una sesión (nunca rechaza; quien quiera, espera la respuesta). @param {string | null} sid */
    detach(sid) { return sid ? this.call('Target.detachFromTarget', { sessionId: sid }, true).catch(() => {}) : Promise.resolve(); },

    /**
     * Engancha una pestaña como activa (suelta la anterior, que si no sigue mandando eventos). Devuelve { ready } con lo
     * que devolvió onAttached (o nada si no hubo enganche nuevo). `keep`: la anterior no se suelta aquí (show() la suelta
     * tras traer la nueva al frente); sus eventos ya no cuentan (no es la sesión activa).
     * @param {string} id @param {{ keep?: boolean }} [o] @returns {Promise<{ ready: any } | undefined>}
     */
    async activate(id, o = {}) {
      if (this.targetId === id && this.session) return;
      if (this.targetId === id && this.attaching) return this.attaching; // ya se está enganchando: no abrir otra sesión
      const old = this.session;
      this.targetId = id; this.session = null; this.worlds.clear();
      h.onActivating();
      if (!o.keep) this.detach(old);
      /** @type {Call | null} */ const from = o.keep && old ? (method, params = {}) => this.request(method, params, old) : null;
      const p = this.attaching = (async () => {
        try {
          const r = await this.call('Target.attachToTarget', { targetId: id, flatten: true }, true);
          if (this.targetId !== id) { this.detach(r.sessionId); return; } // ya se activó otra
          this.session = r.sessionId;
          return { ready: h.onAttached(this.pages.get(id), from) };   // objeto: la promesa del gancho no retrasa el enganche
        } catch {}
      })();
      try { return await p; } finally { if (this.attaching === p) this.attaching = null; }
    },

    /**
     * Enganche automático (al conectar, Chrome avisa de todas las pestañas; o se abre una nueva). Si la enganchada no se
     * ve (p. ej. Netflix cargada detrás), se busca la que se ve: la tele no debe quedar mandando a una pestaña oculta.
     */
    async autoActivate(id) {
      const hidden = async () => {
        try { return (await this.call('Runtime.evaluate', { expression: 'document.visibilityState', returnByValue: true }))?.result?.value === 'hidden'; }
        catch { return false; }
      };
      await this.activate(id);
      if (this.targetId !== id || !this.session || !(await hidden())) return;
      for (const other of [...this.pages.keys()]) {
        if (other === id || this.targetId !== id) continue;
        await this.activate(other);
        if (this.targetId !== other || !this.session || !(await hidden())) return;
        id = other;
      }
    },

    /**
     * Trae una pestaña al frente (en el kiosco se ve al instante) y la engancha como activa. Primero la engancha (aún
     * detrás) y deja que quien escucha onAttached pinte en ella (espera su promesa, como mucho frontWaitMs): así ya se
     * ve con lo suyo. Luego Target.activateTarget; después onLeft con la pestaña que se deja (aún enganchada), y se suelta.
     * @param {string} id
     */
    async show(id) {
      if (!this.pages.has(id)) throw new Error('nopage');
      const old = this.targetId !== id ? this.session : null;
      try {
        const r = await this.activate(id, { keep: true });
        if (r) await capped(r.ready, frontWaitMs);
        await this.call('Target.activateTarget', { targetId: id }, true);
        if (old) await capped(h.onLeft((method, params = {}) => this.request(method, params, old)), frontWaitMs);
      } finally { await capped(this.detach(old), frontWaitMs); }
      if (this.targetId !== id || !this.session) throw new Error('nopage');
    },

    /** Abre una pestaña en blanco, la trae al frente y la engancha como activa. Devuelve su id. */
    async newTab() {
      const { targetId } = await this.call('Target.createTarget', { url: 'about:blank' }, true);
      this.pages.set(targetId, this.pages.get(targetId) || { targetId, type: 'page', url: 'about:blank', title: '' });
      await this.show(targetId);
      return targetId;
    },
  };
  return cdp;
}

module.exports = { createCdp, getJSON, FRONT_WAIT_MS };
