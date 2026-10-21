'use strict';
// @ts-check
// Cliente del J Gateway (STT local + agente + TTS) por WebSocket: ws://<host>:8004/ws/stream.
// Una sola sesión, perezosa: solo `ensure()` conecta (handshake → `ready`); no reconecta por su cuenta, quien la necesite
// vuelve a llamar a `ensure()`. Traduce los mensajes del Gateway a eventos simples (`GwEvent`) y deja el resto a quien escucha.
// El audio que sale antes de `ready` se guarda (con tope) y sale en orden después. Los logs no llevan la clave ni texto,
// solo códigos de cierre y tamaños.
const { WebSocket } = require('ws');

const AUDIO_MAGIC = 0xA1;                    // frame de audio del Gateway: 0xA1 + turn_seq (uint16 BE) + PCM16 LE 24 kHz mono

/**
 * @typedef {{type:'partial',text:string} | {type:'final',text:string} | {type:'turn_start',turnId:string,seq:number}
 *   | {type:'token',turnId:string,text:string} | {type:'turn_end',turnId:string} | {type:'audio',seq:number,pcm:Buffer,frame:Buffer}
 *   | {type:'turn_error',turnId:string,message:string} | {type:'down'}} GwEvent
 */

/**
 * @param {{ url: string, key: string, agent: string, log: { info: Function, warn: Function }, WebSocketImpl?: any, readyMs?: number, bufferMax?: number }} o
 */
function createGatewayClient({ url, key, agent, log, WebSocketImpl = WebSocket, readyMs = 5000, bufferMax = 131072 }) {
  /** @type {any} */ let ws = null;
  let ready = false;
  /** @type {Promise<boolean> | null} */ let pending = null;
  /** @type {{ data: string | Buffer, audio: boolean }[]} */ let queue = [];
  let queued = 0;                                    // bytes de audio en `queue`
  const subs = new Set();

  /** @param {GwEvent} ev */
  const emit = ev => { for (const fn of [...subs]) { try { fn(ev); } catch (e) { log.warn('gateway: oyente con error', e); } } };

  const clearQueue = () => { queue = []; queued = 0; };

  /** Escribe ya si la sesión está lista; si solo está conectando, lo guarda; si no hay conexión, lo descarta. @param {string | Buffer} data @param {boolean} audio */
  function out(data, audio) {
    if (ready && ws) { try { ws.send(data); } catch {} return; }
    if (!ws) return;
    queue.push({ data, audio });
    if (audio) {
      queued += /** @type {Buffer} */ (data).length;
      while (queued > bufferMax) {                   // se descarta lo más antiguo
        const i = queue.findIndex(q => q.audio);
        if (i < 0) break;
        queued -= /** @type {Buffer} */ (queue[i].data).length;
        queue.splice(i, 1);
      }
    }
  }

  /** @param {Buffer} buf */
  function onBinary(buf) {
    if (buf.length < 3 || buf[0] !== AUDIO_MAGIC) return;
    emit({ type: 'audio', seq: buf.readUInt16BE(1), pcm: buf.subarray(3), frame: buf });
  }

  /** @param {any} m */
  function onJson(m) {
    switch (m && m.type) {
      case 'transcription_partial': return emit({ type: 'partial', text: String(m.text ?? '') });
      case 'transcription': return emit({ type: 'final', text: String(m.text ?? '') });
      case 'turn_start': return emit({ type: 'turn_start', turnId: m.turn_id, seq: m.turn_seq });
      case 'token': return emit({ type: 'token', turnId: m.turn_id, text: String(m.text ?? '') });
      case 'turn_end': return emit({ type: 'turn_end', turnId: m.turn_id });
      case 'error': if (m.code === 'TURN_ERROR') emit({ type: 'turn_error', turnId: m.turn_id, message: String(m.message ?? '') }); return;
      default: return;                               // status, interrupted, tool_call…: no hacen falta
    }
  }

  function connect() {
    return new Promise(resolve => {
      const sock = new WebSocketImpl(url);
      ws = sock;
      let settled = false;
      const done = (/** @type {boolean} */ ok) => { if (settled) return; settled = true; clearTimeout(timer); resolve(ok); };
      const timer = setTimeout(() => {
        log.warn(`gateway: sin ready en ${readyMs} ms`);
        done(false);
        try { sock.terminate(); } catch {}
      }, readyMs);

      sock.on('open', () => {
        sock.send(JSON.stringify({ client_key: key, input_mode: 'audio', output_mode: ['audio', 'text', 'status'], agent }));
      });
      sock.on('message', (/** @type {Buffer} */ data, /** @type {boolean} */ isBinary) => {
        if (sock !== ws) return;
        if (isBinary) return onBinary(Buffer.isBuffer(data) ? data : Buffer.from(data));
        let m; try { m = JSON.parse(data.toString()); } catch { return; }
        if (!ready && m && m.type === 'ready') {
          ready = true;
          const q = queue; clearQueue();
          for (const it of q) { try { sock.send(it.data); } catch {} }
          log.info('gateway: listo');
          return done(true);
        }
        if (ready) onJson(m);                        // antes de ready solo puede haber status
      });
      sock.on('error', (/** @type {NodeJS.ErrnoException} */ e) => { log.warn('gateway: error de conexión', e.code || e.name); });
      sock.on('close', (/** @type {number} */ code) => {
        const was = ready;
        if (sock === ws) { ws = null; ready = false; clearQueue(); }
        log.info(`gateway: cierre ${code}`);
        done(false);
        if (was && !closing.has(sock)) emit({ type: 'down' });
      });
    });
  }

  /** @type {Set<any>} */ const closing = new Set();  // sockets cerrados a propósito: no son un `down`

  return {
    /** Abre la sesión si hace falta; true cuando el Gateway la da por lista. Un ensure en curso se comparte. */
    ensure() {
      if (ready) return Promise.resolve(true);
      if (!pending) pending = connect().finally(() => { pending = null; });
      return pending;
    },
    /** @param {Buffer} buf PCM Float32 16 kHz mono */
    audio(buf) { out(buf, true); },
    end() { out(JSON.stringify({ type: 'end' }), false); },
    /** Corta el turno en curso; el Gateway lo cierra con su propio turn_end. */
    cancel() { out(JSON.stringify({ type: 'cancel' }), false); },
    /** @param {string} text */
    send(text) { out(JSON.stringify({ type: 'send', text }), false); },
    /** @param {(ev: GwEvent) => void} fn */
    on(fn) { subs.add(fn); return () => { subs.delete(fn); }; },
    isReady: () => ready,
    close() {
      const sock = ws;
      ws = null; ready = false; clearQueue();
      if (sock) { closing.add(sock); try { sock.close(); } catch {} }
    },
  };
}

module.exports = { createGatewayClient };
