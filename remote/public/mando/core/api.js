// Conexión con el servidor: WebSocket con reintentos, eco de latencia, órdenes con respuesta (rpc), POST y el registro de
// manejadores por tipo de mensaje (como el servidor: un tipo, un dueño).
import { state, emit } from './store.js';

let ws, tries = 0, rtt = 0, retryT = 0, rid = 0, gate = null;
const pend = new Map();
const handlers = new Map();
const subs = { open: [], close: [], rtt: [], bin: [] };

export const isUp = () => !!ws && ws.readyState === 1;
/** Abierto o abriéndose. */
export const isLive = () => !!ws && ws.readyState <= 1;
export const getRtt = () => rtt;
export const getTries = () => tries;
export const resetTries = () => { tries = 0; };

export const send = s => { if (ws && ws.readyState === 1) ws.send(s); };
export const cmd = o => send(JSON.stringify(o));
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
  if (d.charCodeAt(0) === 112) { const r = performance.now() - parseFloat(d.slice(1)); rtt = rtt ? rtt * 0.6 + r * 0.4 : r; for (const f of subs.rtt) f(rtt); return; }
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
  ws.onopen = () => { tries = 0; ping(); for (const f of subs.open) f(); };
  ws.onmessage = onMessage;
  ws.onclose = ev => {
    const lost = ev.code === 4001 || ev.code === 4002;
    if (lost) emit('auth:lost', ev.code);
    else retryT = setTimeout(connect, Math.min(2000, 250 * ++tries));
    for (const f of subs.close) f(ev, lost);
  };
  ws.onerror = () => {};
}
/** Cierra la conexión para que se reconecte (p. ej. con un token nuevo). */
export function reconnect() { if (ws) ws.close(); }
function ping() { if (ws && ws.readyState === 1 && !document.hidden) send('p' + performance.now()); }

/** Eco de latencia cada 2 s y reconexión al volver a la página. */
export function start() {
  setInterval(ping, 2000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && (!ws || ws.readyState > 1)) connect(); });
}
