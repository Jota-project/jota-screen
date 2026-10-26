// Conexión con el servidor: WebSocket con reintentos, eco de latencia, órdenes con respuesta (rpc), POST y el registro de
// manejadores por tipo de mensaje (como el servidor: un tipo, un dueño).
import { state, emit } from './store.js';

let ws, tries = 0, rtt = 0, retryT = 0, rid = 0, gate = null, waitSince = 0, probing = 0, probeN = 0;
/* órdenes sueltas a la espera de conexión: la última de cada tipo; caducan a los QUEUE_MS (más que el sondeo de 1,5 s
   más la reconexión, para que lo pulsado al desbloquear el móvil llegue) */
const QUEUE_MS = 4000, queue = new Map();
const pend = new Map();
const handlers = new Map();
const subs = { open: [], close: [], rtt: [], bin: [] };

export const isUp = () => !!ws && ws.readyState === 1;
/** Abierto o abriéndose. */
export const isLive = () => !!ws && ws.readyState <= 1;
export const getRtt = () => rtt;
export const getTries = () => tries;
export const resetTries = () => { tries = 0; };

export const send = s => { if (ws && ws.readyState === 1 && !probing) ws.send(s); };
/** Orden JSON: sin conexión (o mientras se sondea una que puede estar muerta) espera en la cola; las rachas del trackpad
 * (send) no, que el cursor saltaría por la tele. */
export const cmd = o => {
  if (ws && ws.readyState === 1 && !probing) { ws.send(JSON.stringify(o)); return; }
  queue.set(o.id ? 'id' + o.id : o.t, { o, at: performance.now() });
};
function flushQueue() {
  const now = performance.now();
  for (const { o, at } of queue.values()) {
    if (now - at < QUEUE_MS) ws.send(JSON.stringify(o));
    else if (o.id) { const f = pend.get(o.id); if (f) { pend.delete(o.id); f({ error: 'sin conexión' }); } }
  }
  queue.clear();
}
/** Un mensaje binario (el audio del micrófono, ver features/voice.js). @param {ArrayBufferView} b */
export const sendBin = b => { if (ws && ws.readyState === 1) ws.send(b); };
/** Orden con respuesta (sin conexión, falla enseguida). */
export const rpc = o => new Promise(res => {
  if (!ws || ws.readyState !== 1) return res({ error: 'sin conexión' });
  const id = ++rid; pend.set(id, res); cmd({ ...o, id });
  setTimeout(() => { if (pend.delete(id)) res({ error: 'sin respuesta' }); }, 20000);
});
export async function post(u, b) { try { return await (await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })).json(); } catch { return { error: 'No hay conexión con el mando' }; } }

/** Manejador de un tipo de mensaje del servidor (error si ya tiene dueño). */
export function handle(type, fn) {
  if (type === 'res' || handlers.has(type)) throw new Error(`mensaje «${type}» repetido`);
  handlers.set(type, fn);
}
/**
 * Avisos de la conexión: 'open' (tras poner tries a 0 y el primer eco), 'close' (fn(ev, lost); con lost, el acceso se ha
 * perdido: 4001/4002, y antes se ha avisado 'auth:lost'), 'rtt' (nueva latencia) y 'bin' (un mensaje binario, ArrayBuffer).
 */
export function onWs(ev, fn) { subs[ev].push(fn); }
/**
 * Puerta antes de conectar: devuelve true para seguir ya, o una promesa de true/false (false: no se conecta).
 * Con true síncrono la conexión se abre en el mismo turno, como antes.
 */
export function setGate(fn) { gate = fn; }

function onMessage(e) {
  const d = e.data;
  if (typeof d !== 'string') { for (const f of subs.bin) f(d); return; }   // binario (la voz del Gateway): nunca a JSON.parse
  if (d.charCodeAt(0) === 112) { waitSince = 0; if (probing) { probing = 0; flushQueue(); } const r = performance.now() - parseFloat(d.slice(1)); rtt = rtt ? rtt * 0.6 + r * 0.4 : r; for (const f of subs.rtt) f(rtt); return; }
  try {
    const j = JSON.parse(d);
    if (j.t === 'res') { const f = pend.get(j.id); if (f) { pend.delete(j.id); f(j.r || {}); } return; }
    const h = handlers.get(j.t); if (h) h(j);
  } catch {}
}

export async function connect() {
  clearTimeout(retryT);                                 // un solo intento a la vez (reintento a mano, visibilidad, temporizador)
  const g = gate ? gate() : true;
  if (g !== true && !(await g)) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws` + (state.token ? `?t=${encodeURIComponent(state.token)}` : ''));
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => { tries = 0; waitSince = 0; probing = 0; flushQueue(); ping(); for (const f of subs.open) f(); };
  ws.onmessage = onMessage;
  ws.onclose = closed;
  ws.onerror = () => {};
}
function closed(ev) {
  probing = 0;
  const lost = ev.code === 4001 || ev.code === 4002;
  if (lost) emit('auth:lost', ev.code);
  else retryT = setTimeout(connect, Math.min(2000, 250 * ++tries));
  for (const f of subs.close) f(ev, lost);
}
/** Conexión medio abierta (el móvil vuelve del bloqueo y nadie avisó del cierre): se suelta y se reconecta ya, sin esperar
 * al cierre del navegador, que con la red muerta puede tardar minutos. */
function drop() {
  const old = ws; if (!old) return;
  old.onclose = old.onmessage = null;
  try { old.close(); } catch {}
  closed({ code: 1006 });
}
/** Cierra la conexión para que se reconecte (p. ej. con un token nuevo). */
export function reconnect() { if (ws) ws.close(); }
const DEAD_MS = 6000, PROBE_MS = 1500;
function ping() {
  if (!ws || ws.readyState !== 1 || document.hidden || probing) return;   // durante el sondeo decide probe()
  const now = performance.now();
  // un eco sin respuesta desde hace DEAD_MS: muerta (se mide desde el eco pendiente, no desde el último recibido, que con
  // la pestaña en segundo plano los temporizadores se espacian y no por eso está muerta)
  if (waitSince && now - waitSince > DEAD_MS) { drop(); return; }
  if (!waitSince) waitSince = now;
  ws.send('p' + now);
}
/** Al volver a la página: un eco y, mientras no vuelve, las órdenes esperan; sin eco en PROBE_MS, conexión muerta. */
function probe() {
  const n = probing = ++probeN; ws.send('p' + performance.now());
  setTimeout(() => { if (probing === n) drop(); }, PROBE_MS);   // cualquier eco pone probing a 0
}

/** Eco de latencia cada 2 s y reconexión al volver a la página. */
export function start() {
  setInterval(ping, 2000);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    if (!ws || ws.readyState > 1) connect();
    else if (ws.readyState === 1) probe();
  });
}
