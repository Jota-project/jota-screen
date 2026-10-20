// Ambiente del mando (v3): dos luces en órbita con el color de lo que hay en la tele (malva y cielo en reposo, los colores
// de la carátula si suena algo, el color de la app si hay una abierta) y la cabecera que dice qué es. Los colores pasan a
// --ca/--cb de <html>, que cambian en 4 s (@property en mando.css); las luces se paran con la página oculta.
// Los colores de fuera se recortan en luminancia: con las dos luces superpuestas, el texto secundario no baja de 4,5:1.
import { cfg } from '../core/store.js';
import { setTitle } from '../ui/status.js';

/**
 * Luminancia relativa permitida a cada luz. Medida en el peor punto (los dos centros encima, con el relleno del
 * trackpad) recorriendo todos los tonos con saturación de 0,3 a 0,75: el texto secundario queda a 5,07:1 o más en
 * oscuro y a 4,54:1 o más en claro.
 */
export const LIMITS = {
  mando: { oscuro: [0, 0.26], claro: [0.11, 1] },   // luces al 24 % / 16 % sobre #211b2a / #f6f3f0
  sp: { oscuro: [0, 0.18], claro: [0.17, 1] },      // ahora suena: luces al 40 % sobre #1a1420, 20 % sobre #f6f3f0
};
const MALVA = '#7c6aae', CIELO = '#6e8cc4';

/* apps conocidas por su dominio: nombre y color (el segundo, malva) */
/** @type {[RegExp, string, string][]} */
const APPS = [
  [/(^|\.)netflix\.com$/, 'Netflix', '#b8323c'],
  [/(^|\.)youtube\.com$|(^|\.)youtu\.be$/, 'YouTube', '#c4302b'],
  [/(^|\.)spotify\.com$/, 'Spotify', '#1db954'],
  [/(^|\.)primevideo\.com$/, 'Prime Video', '#1a98ff'],
  [/(^|\.)disneyplus\.com$/, 'Disney+', '#113ccf'],
  [/(^|\.)max\.com$|(^|\.)hbomax\.com$/, 'Max', '#2f3fe0'],
  [/(^|\.)twitch\.tv$/, 'Twitch', '#9146ff'],
  [/(^|\.)rtve\.es$/, 'RTVE Play', '#e05a1c'],
];

const lin = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
/** @param {number[]} c */
const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
/** @returns {number[]} */
function rgbOf(h, s, l) {
  const k = n => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = n => 255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1)));
  return [f(0), f(8), f(4)];
}
/** @returns {number[]} */
function hslOf(hex) {
  const n = parseInt(hex.slice(1), 16), r = (n >> 16 & 255) / 255, g = (n >> 8 & 255) / 255, b = (n & 255) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  if (!d) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = mx === r ? ((g - b) / d + (g < b ? 6 : 0)) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}
/**
 * Un color ([h, s, l] de 0–360 y 0–1, o '#rrggbb') ajustado a [ymin, ymax] de luminancia: se mueve solo su luminosidad
 * (el tono se queda) y la saturación va de 0,3 a 0,75 para que no grite ni quede gris.
 * @param {number[] | string} c
 * @param {number[]} lim [ymin, ymax]
 */
export function tone(c, lim) {
  const [ymin, ymax] = lim;
  let [h, s, l] = typeof c === 'string' ? hslOf(c) : c;
  if (![h, s, l].every(Number.isFinite)) return MALVA;
  s = Math.min(0.75, Math.max(0.3, s)); l = Math.min(0.9, Math.max(0.1, l));
  const y = lum(rgbOf(h, s, l));
  if (y > ymax || y < ymin) {                            // bisección sobre la luminosidad hasta caer dentro
    let lo = y > ymax ? 0 : l, hi = y > ymax ? l : 1;
    for (let i = 0; i < 20; i++) { l = (lo + hi) / 2; const v = lum(rgbOf(h, s, l)); if (v > ymax) hi = l; else if (v < ymin) lo = l; else break; }
  }
  return 'rgb(' + rgbOf(h, s, l).map(v => Math.round(v)).join(' ') + ')';
}
export const themeOf = () => (cfg.theme === 'claro' ? 'claro' : 'oscuro');
const appOf = host => { for (const [re, n, c] of APPS) if (re.test(host)) return { n, c }; return null; };
/* sin app conocida, un tono fijo sacado del dominio */
const hueOf = host => { let x = 0; for (const ch of host) x = (x * 31 + ch.charCodeAt(0)) % 360; return x; };
/* «Lo-fi para estudiar · Directo - YouTube» → «Lo-fi para estudiar · Directo» */
const clean = (t, n) => (n ? t.replace(new RegExp('\\s*[-–—|·]\\s*' + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$', 'i'), '') : t).trim();

/** Qué hay en la tele (título, detalle y los dos colores) a partir del mensaje «state». */
export function contextOf(s) {
  if (!s || !s.cdp) return { t: 'Navegador no disponible', m: '', a: MALVA, b: CIELO };
  const amb = s.amb;
  if (amb) {                                             // reposo: malva y cielo, o la carátula si suena algo
    const mu = amb.music;
    if (mu && mu.title) return { t: mu.title, m: (mu.artist ? mu.artist + ' en ' : 'En ') + 'Spotify', a: mu.colors ? mu.colors[0] : MALVA, b: mu.colors ? mu.colors[1] : CIELO };
    return { t: 'En reposo', m: 'Hora y tiempo', a: MALVA, b: CIELO };
  }
  if (!s.host) return { t: 'Inicio', m: '', a: MALVA, b: CIELO };
  const app = appOf(s.host);
  const t = clean(String(s.title || ''), app && app.n) || (app ? app.n : s.host);
  return { t, m: app ? (t === app.n ? '' : app.n) : s.host === t ? '' : s.host, a: app ? app.c : [hueOf(s.host), 0.5, 0.5], b: MALVA };
}

let last = null;
/** Pinta el ambiente y la cabecera con el estado de la tele (sin argumento, repinta el último: p. ej. al cambiar de tema). */
export function paintAmbient(s) {
  if (s !== undefined) last = s;
  const c = contextOf(last), lim = LIMITS.mando[themeOf()], r = document.documentElement.style;
  r.setProperty('--ca', tone(c.a, lim)); r.setProperty('--cb', tone(c.b, lim));
  if (last) setTitle(c.t, c.m);                         // sin estado aún, la cabecera sigue en «Conectando…»
}

export const ambient = {
  name: 'ambient',
  init() {
    const pause = () => document.documentElement.classList.toggle('ambOff', document.hidden);
    document.addEventListener('visibilitychange', pause); pause();
    paintAmbient(null);                                  // malva y cielo hasta que llegue el estado
  },
};
