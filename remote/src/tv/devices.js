'use strict';
// @ts-check
// Adaptadores pequeños de la tele: puntero X real (helper en Python), volumen (PipeWire con wpctl),
// sondeo de la página (vídeo y scroll) y el código de emparejar pintado encima de lo que se vea.
const path = require('node:path');
const { spawn: nodeSpawn, execFile } = require('node:child_process');

// ── puntero: líneas «m dx dy», «w dx dy», «c 1», «b 1 1» del mando al helper XTest
const RE_PTR = /^(?:[mw] -?\d{1,4}(?:\.\d{1,2})? -?\d{1,4}(?:\.\d{1,2})?|[bc] [1-3](?: [01])?)$/;
/**
 * @param {{ script: string, display: string, disabled?: boolean, log: { debug: Function }, spawn?: typeof nodeSpawn }} o
 */
function createPointer({ script, display, disabled = false, log, spawn = nodeSpawn }) {
  let ptr = null;
  function start() {
    if (disabled) return;
    ptr = spawn('python3', [script], { stdio: ['pipe', 'ignore', 'inherit'], env: { ...process.env, DISPLAY: display } });
    ptr.stdin.on('error', () => {});
    ptr.on('exit', () => { ptr = null; setTimeout(start, 1000); });
  }
  /** @param {string} s */
  function line(s) {
    if (!RE_PTR.test(s)) return false;
    log.debug('ptr', s);
    if (ptr && ptr.stdin.writable) ptr.stdin.write(s + '\n');
    return true;
  }
  return { start, line };
}

// ── volumen: el altavoz por defecto de PipeWire
const SINK = '@DEFAULT_AUDIO_SINK@';
/**
 * @param {{ runtimeDir: string, exec?: (args: string[]) => Promise<string> }} o
 */
function createAudio({ runtimeDir, exec }) {
  const env = { ...process.env, XDG_RUNTIME_DIR: runtimeDir };
  const wp = exec || (args => new Promise(r => execFile('wpctl', args, { env, timeout: 2000 }, (e, o) => r(e ? '' : o))));
  return {
    /** @returns {Promise<{ vol: number, muted: boolean } | null>} */
    async read() {
      const m = /Volume:\s*([\d.]+)(\s*\[MUTED\])?/.exec(await wp(['get-volume', SINK]));
      return m ? { vol: Math.round(parseFloat(m[1]) * 100), muted: !!m[2] } : null;
    },
    toggleMute: () => wp(['set-mute', SINK, 'toggle']),
    unmute: () => wp(['set-mute', SINK, '0']),
    /** @param {number} n pasos de 5 % (negativo = bajar); nunca por encima del 100 % */
    step: n => wp(['set-volume', SINK, `${Math.abs(n) * 5}%${n > 0 ? '+' : '-'}`, ...(n > 0 ? ['-l', '1.0'] : [])]),
    /** @param {number} v de 0 a 100 */
    set: v => wp(['set-volume', SINK, (v / 100).toFixed(2)]),
  };
}

// ── sondeo de la página: [vídeo (-1 sin vídeo, 0 pausa, 1 suena), scrollY, alto total, alto visible, reproducción]
// `media` mira el primer <video> de cualquier tamaño (el mando y tv_state lo usan así). La reproducción «de verdad» va
// aparte (5.º valor): el <video> que suena con más área visible, como [área (0–1; 1 a pantalla completa), currentTime],
// o null si ninguno suena. Si es lo bastante grande y avanza, lo decide createPlaybackWatch (aquí no hay memoria).
const PLAYBACK_MIN_AREA = 0.6;        // parte del viewport que debe ocupar el vídeo (o estar a pantalla completa)
const PLAYBACK_MIN_READY = 3;         // readyState mínimo (HAVE_FUTURE_DATA): con menos aún no se ve imagen
const PLAYBACK_MIN_ADVANCE_S = 0.05;  // currentTime tiene que avanzar al menos esto entre dos lecturas
const PLAYBACK_DWELL_MS = 600;        // y seguir así este tiempo antes de dar `playback: true` (un tráiler que asoma, no)
const PLAYBACK_PROBE = '(()=>{let b=null;const f=document.fullscreenElement,W=innerWidth,H=innerHeight;' +
  'for(const v of document.querySelectorAll("video")){if(v.paused||v.ended||v.readyState<' + PLAYBACK_MIN_READY + ')continue;' +
  'const r=v.getBoundingClientRect(),w=Math.max(0,Math.min(r.right,W)-Math.max(r.left,0)),h=Math.max(0,Math.min(r.bottom,H)-Math.max(r.top,0));' +
  'const a=f&&(f===v||f.contains(v))?1:W&&H?w*h/(W*H):0;if(!b||a>b[0])b=[Math.round(a*1000)/1000,v.currentTime]}return b})()';
const PAGE_PROBE = '(()=>{const v=document.querySelector("video"),e=document.scrollingElement||document.documentElement;' +
  'return [v?(v.paused?0:1):-1,scrollY,e?e.scrollHeight:0,innerHeight,' + PLAYBACK_PROBE + ']})()';
const r3 = n => Math.round(n * 1000) / 1000;
/** Traduce lo que devuelve PAGE_PROBE: { media, scroll: {pos, size} de 0 a 1 o null si no hay scroll } */
function parseProbe(v) {
  if (!Array.isArray(v)) return null;
  const [m, y, h, ih] = v.slice(0, 4).map(Number);
  const max = h - ih;
  const scroll = Number.isFinite(max) && max > 4 && ih > 0 ? { pos: r3(Math.min(1, Math.max(0, y / max))), size: r3(Math.min(1, ih / h)) } : null;
  return { media: Number.isFinite(m) ? m : null, scroll };
}
/**
 * El 5.º valor de PAGE_PROBE: el vídeo que suena con más área, o null.
 * @param {any} v lo que devolvió PAGE_PROBE @returns {{ area: number, t: number } | null}
 */
function parsePlayback(v) {
  const p = Array.isArray(v) ? v[4] : null;
  if (!Array.isArray(p)) return null;
  const area = Number(p[0]), t = Number(p[1]);
  return Number.isFinite(area) && Number.isFinite(t) ? { area, t } : null;
}
/**
 * Reproducción de verdad a partir de lecturas sucesivas: vídeo grande (o a pantalla completa) cuyo currentTime avanza
 * entre lecturas durante `dwellMs`. Cualquier lectura que no cumple lo pone a false al momento.
 * @param {{ dwellMs?: number, minArea?: number }} [o]
 */
function createPlaybackWatch({ dwellMs = PLAYBACK_DWELL_MS, minArea = PLAYBACK_MIN_AREA } = {}) {
  let prev = /** @type {{ t: number, at: number } | null} */ (null), since = /** @type {number | null} */ (null), on = false;
  return {
    /** @param {{ area: number, t: number } | null} pb @param {number} now ms @returns {boolean} */
    update(pb, now) {
      if (!pb || pb.area < minArea) { prev = null; since = null; return (on = false); }
      const moving = !!prev && pb.t - prev.t >= PLAYBACK_MIN_ADVANCE_S;
      if (!moving) since = null;
      else if (since === null) since = /** @type {{ at: number }} */ (prev).at; // cuenta desde la lectura en la que ya sonaba
      prev = { t: pb.t, at: now };
      return (on = moving && since !== null && now - since >= dwellMs);
    },
    get on() { return on; },
    reset() { prev = null; since = null; on = false; },
  };
}

// ── código de emparejar en la tele: se pinta encima de lo que haya (también a pantalla completa)
function pairInPage(o) {
  const old = document.getElementById('__tvpair'); if (old) old.remove();
  if (!o) return;
  const host = document.fullscreenElement || document.documentElement;
  const b = document.createElement('div'); b.id = '__tvpair';
  b.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;background:rgba(5,7,10,.78);font-family:system-ui,sans-serif;color:#f3f6fb;text-align:center';
  const c = document.createElement('div');
  c.style.cssText = 'background:#12161c;border:1px solid rgba(255,255,255,.14);border-radius:28px;padding:44px 64px;box-shadow:0 30px 90px rgba(0,0,0,.6)';
  const k = document.createElement('div'); k.textContent = 'Nuevo mando'; k.style.cssText = 'font-size:22px;letter-spacing:.18em;text-transform:uppercase;color:#8ba7ff;font-weight:650';
  const n = document.createElement('div'); n.textContent = o.name + ' quiere conectarse'; n.style.cssText = 'font-size:28px;margin-top:10px;opacity:.85';
  const d = document.createElement('div'); d.textContent = o.code.split('').join(' '); d.style.cssText = 'font-size:120px;font-weight:800;letter-spacing:.06em;margin:22px 0 6px;font-variant-numeric:tabular-nums';
  const h = document.createElement('div'); h.textContent = 'Escribe este código en el mando'; h.style.cssText = 'font-size:22px;opacity:.6';
  c.append(k, n, d, h); b.appendChild(c); host.appendChild(b);
  b.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220 });
}
/** @param {{ ready: boolean, session: string | null, call: Function }} cdp */
function createPairScreen(cdp) {
  return {
    ready: () => !!(cdp.ready && cdp.session),
    showCode: (code, name) => cdp.call('Runtime.evaluate', { expression: `(${pairInPage})(${JSON.stringify({ code, name })})` }).catch(() => {}),
    hideCode: () => { cdp.call('Runtime.evaluate', { expression: `(${pairInPage})(null)` }).catch(() => {}); },
  };
}

module.exports = { createPointer, createAudio, createPairScreen, PAGE_PROBE, parseProbe, parsePlayback, createPlaybackWatch,
  PLAYBACK_MIN_AREA, PLAYBACK_MIN_READY, PLAYBACK_MIN_ADVANCE_S, PLAYBACK_DWELL_MS, RE_PTR, pairInPage, pointerScript: root => path.join(root, 'pointer.py') };
