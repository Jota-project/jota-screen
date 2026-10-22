'use strict';
// @ts-check
// Fichas de herramientas del agente en la tele (public/tv-agent.js): qué herramienta del Gateway merece
// ficha y qué pone. Lista cerrada (`CARD_TOOLS` y las de casa que cambian algo, por palabras genéricas del nombre); el
// resto, sin ficha (las de lectura: tv_state, tv_links, tv_screenshot, tv_events, hass…get_state…). El nombre se compara por sufijo porque OpenClaw puede prefijarlo
// (`tv-canvas__tv_open`). El `detail` sale de los argumentos, corto y saneado: nunca el resultado ni args en crudo.
// Los iconos son datos (primitivas SVG en viewBox 24), no HTML: la página los monta con createElementNS.

const DETAIL_MAX = 60;                       // caracteres del detalle de una ficha
const NAME_MAX = 64;                         // caracteres del nombre de una herramienta en los logs
const HOME_WORDS = new Set(['home', 'light', 'lights', 'luz', 'luces', 'hass']);   // palabras de herramientas de casa (Home Assistant y similares)
const HOME_READ = new Set(['get', 'list', 'search', 'find', 'status', 'history']);   // verbos de lectura: sin ficha (no `state`: set_state escribe)
const SEP = '[_.:/-]';                       // separadores que admite un prefijo delante del nombre (`tv-canvas__tv_open`)
const SEPS = new RegExp(SEP + '+');          // para partir un nombre en palabras
const PREFIX_END = /__|\/|:/;               // fin del prefijo del servidor MCP en el nombre (`hass__light_on`)

/** @typedef {'web' | 'music' | 'timer' | 'volume' | 'video' | 'home' | 'screen'} Kind */
/** @typedef {[string, Record<string, string | number>][]} Icon primitivas SVG: [etiqueta, atributos] */
/** @typedef {{ kind: Kind, title: string, detail: string }} Card */

/** Congela un icono entero (se comparte entre fotos). @param {Icon} icon @returns {Icon} */
const freezeIcon = icon => /** @type {any} */ (Object.freeze(icon.map(([tag, attrs]) => Object.freeze([tag, Object.freeze(attrs)]))));

/** Tipos de ficha: icono (trazo, viewBox 24) y título genérico. @type {Readonly<Record<Kind, { icon: Icon, title: string }>>} */
const KINDS = Object.freeze({
  web: { title: 'Web', icon: freezeIcon([['circle', { cx: 12, cy: 12, r: 9 }], ['path', { d: 'M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18' }]]) },
  music: { title: 'Música', icon: freezeIcon([['path', { d: 'M9 18V5l11-2v13' }], ['circle', { cx: 6, cy: 18, r: 3 }], ['circle', { cx: 17, cy: 16, r: 3 }]]) },
  timer: { title: 'Temporizador', icon: freezeIcon([['circle', { cx: 12, cy: 13, r: 8 }], ['path', { d: 'M12 9v4l2.5 2M9.5 2.5h5' }]]) },
  volume: { title: 'Volumen', icon: freezeIcon([['path', { d: 'M4 9v6h4l5 4V5L8 9H4z' }], ['path', { d: 'M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12' }]]) },
  video: { title: 'Vídeo', icon: freezeIcon([['path', { d: 'M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v11a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17.5z' }], ['path', { d: 'M10 9l5 3-5 3z' }]]) },
  home: { title: 'Casa', icon: freezeIcon([['path', { d: 'M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.7.7 1 1.5 1 2.5h6c0-1 .3-1.8 1-2.5A6 6 0 0 0 12 3z' }]]) },
  screen: { title: 'Pantalla', icon: freezeIcon([['path', { d: 'M3 6.5A2.5 2.5 0 0 1 5.5 4h13A2.5 2.5 0 0 1 21 6.5v8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 14.5z' }], ['path', { d: 'M8 21h8M12 17v4' }]]) },
});

/** Texto apto para una ficha: sin controles ni marcas de dirección, espacios juntos y como mucho `max` puntos de código.
 *  @param {any} v @param {number} [max] */
function clip(v, max = DETAIL_MAX) {
  const s = String(v ?? '').replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim();   // Cc: controles; Cf: formato (ancho cero, dirección)
  const cps = [...s];                                            // por puntos de código: no parte un emoji
  return cps.length > max ? cps.slice(0, Math.max(0, max - 1)).join('').trimEnd() + '…' : s;
}

/** Nombre de herramienta apto para un log: solo letras, cifras y `_.:/-` (los separadores de SEP), recortado. @param {any} name */
const toolName = name => String(name ?? '').replace(/[^\w.:/-]/g, '').slice(0, NAME_MAX);

/** Host de una URL (o de un dominio suelto), sin `www.`; '' si no lo es (texto de búsqueda). @param {any} v */
function hostOf(v) {
  const s = String(v ?? '').trim();
  for (const u of [s, 'https://' + s]) {
    try {
      const url = new URL(u);
      if ((url.protocol === 'http:' || url.protocol === 'https:') && url.hostname.includes('.')) return url.hostname.replace(/^www\./, '');
    } catch {}
    if (/\s/.test(s)) break;                 // con espacios es una búsqueda, no un dominio
  }
  return '';
}

const APPS = { youtube: ['YouTube', 'video'], netflix: ['Netflix', 'video'], spotify: ['Spotify', 'music'], home: ['Inicio', 'screen'] };
const SPOTIFY_TITLES = { play: 'Reproducir música', search_play: 'Reproducir música', uri: 'Reproducir música', pause: 'Pausar música',
  playpause: 'Pausar o seguir', next: 'Siguiente canción', prev: 'Canción anterior', volume: 'Volumen de Spotify', like: 'Me gusta',
  shuffle: 'Aleatorio', repeat: 'Repetir', queue_add: 'Añadir a la cola', seek: 'Mover la canción' };
const PRESENT_KINDS = { tasks: 'Tareas', reminder: 'Recordatorio', slides: 'Diapositivas' };
const VOLUME_STEPS = { up: 'Subir', down: 'Bajar', mute: 'Silencio' };

/** Minutos de una cuenta atrás, «N min» (o «N s» por debajo del minuto). @param {any} seconds */
function duration(seconds) {
  const s = Number(seconds);
  if (!(s > 0)) return '';
  return s < 60 ? Math.round(s) + ' s' : Math.round(s / 60) + ' min';
}
const JOIN = ' · ';                                   // entre las partes de un detalle
/** Une partes no vacías con JOIN. @param {...string} parts */
const join = (...parts) => parts.filter(Boolean).join(JOIN);

/** Ficha de cada herramienta con ficha, por su nombre sin prefijo; null si esa llamada no la merece (p. ej. una lectura).
 *  @type {Record<string, (a: Record<string, any>) => Card | null>} */
const BUILDERS = {
  tv_open: a => {
    const host = hostOf(a.url);
    return host ? { kind: 'web', title: 'Abrir en la tele', detail: host } : { kind: 'web', title: 'Buscar en la web', detail: clip(a.url) };
  },
  tv_open_app: a => {
    const [name, kind] = APPS[a.app] || ['', 'screen'];
    return name ? { kind: /** @type {Kind} */ (kind), title: 'Abrir en la tele', detail: name } : null;
  },
  // Netflix va en su propia pestaña (src/features/netflix.js): abrirlo o poner un título lleva a la píldora
  tv_netflix: a => (a.action === 'open' ? { kind: 'video', title: 'Abrir en la tele', detail: 'Netflix' }
    : a.action === 'play' ? { kind: 'video', title: 'Poner en Netflix', detail: clip(a.title) || 'Netflix' }
      : a.action === 'play_last' ? { kind: 'video', title: 'Poner en Netflix', detail: 'Lo último que viste' } : null),   // last solo lee: sin ficha
  // YouTube: poner un vídeo lleva a la píldora; buscar solo lee
  tv_youtube: a => (a.action === 'play' ? { kind: 'video', title: 'Poner en YouTube', detail: clip(a.query) || 'YouTube' } : null),
  tv_spotify: a => (SPOTIFY_TITLES[a.action] ? { kind: 'music', title: SPOTIFY_TITLES[a.action], detail: 'Spotify' } : null),
  tv_activity: a => {
    const op = a.op || 'set';
    if (op === 'list') return null;
    if (op !== 'set') return { kind: 'timer', title: 'Quitar aviso', detail: '' };
    const mins = duration(a.seconds);
    const room = DETAIL_MAX - (mins ? JOIN.length + mins.length : 0);   // el título cede sitio: los minutos no se cortan
    return { kind: 'timer', title: a.seconds > 0 ? 'Temporizador' : 'Aviso en la tele', detail: join(clip(a.title, room), mins) };
  },
  tv_volume: a => {
    const detail = a.action === 'set' ? `Volumen ${Math.round(Math.min(100, Math.max(0, Number(a.level ?? 50) || 0)))} %` : VOLUME_STEPS[a.action] || '';
    return { kind: 'volume', title: 'Volumen', detail };
  },
  tv_media: a => {
    if (a.action !== 'seek') return { kind: 'video', title: 'Vídeo', detail: 'Pausa o sigue' };
    const s = Math.round(Number(a.seconds ?? 10)) || 0;
    return { kind: 'video', title: 'Vídeo', detail: (s < 0 ? 'Atrás ' : 'Adelante ') + Math.abs(s) + ' s' };
  },
  tv_present: a => ({ kind: 'screen', title: 'Mostrar en la tele', detail: clip(a.data && a.data.title) || PRESENT_KINDS[a.kind] || '' }),
  tv_show_html: () => ({ kind: 'screen', title: 'Mostrar en la tele', detail: 'Página a medida' }),
  tv_idle: a => (a.op === 'show' ? { kind: 'screen', title: 'Pantalla en reposo', detail: '' } : null),
};
/** Herramientas con ficha (además de las de casa, que van por nombre genérico). */
const CARD_TOOLS = Object.freeze(Object.keys(BUILDERS));
const SUFFIX = new Map(CARD_TOOLS.map(t => [t, new RegExp(`(^|${SEP})${t}$`)]));

/** Primer texto corto de los argumentos de una herramienta de casa (zona, nombre o entidad). @param {Record<string, any>} a */
function homeDetail(a) {
  for (const k of ['area', 'room', 'name', 'entity_id', 'entity']) {
    if (typeof a[k] === 'string' && a[k].trim()) return clip(a[k].replace(/^[a-z_]+\./, '').replace(/_/g, ' '));
  }
  return '';
}

/** Palabras de un nombre (separadores y camelCase: `HassTurnOn` → hass, turn, on). @param {string} n */
const words = n => n.replace(/([a-z\d])([A-Z])/g, '$1_$2').toLowerCase().split(SEPS);
/** Herramienta de casa que cambia algo (las de lectura, sin ficha): por palabras del nombre sin prefijo. @param {string} base */
function isHomeWrite(base) {
  if (base.startsWith('tv_')) return false;         // «hass__tv_state» no es de casa
  const w = words(base);
  return w.some(x => HOME_WORDS.has(x)) && !w.some(x => HOME_READ.has(x));
}

/**
 * Ficha de una llamada a herramienta: `{ kind, title, detail }` o null si no lleva ficha.
 * @param {any} name nombre tal como llega del Gateway (puede venir prefijado)
 * @param {any} args argumentos (objeto o null)
 * @returns {Card | null}
 */
function toolCard(name, args) {
  const n = toolName(name);
  if (!n) return null;
  const a = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  const card = cardOf(n, a);
  return card && { ...card, detail: clip(card.detail) };   // un solo tope para todas: ningún detalle pasa de DETAIL_MAX
}
/** Ficha sin el tope final del detalle. @param {string} n nombre saneado @param {Record<string, any>} a @returns {Card | null} */
function cardOf(n, a) {
  for (const [tool, re] of SUFFIX) if (re.test(n)) return BUILDERS[tool](a);
  const base = n.split(PREFIX_END).pop() || '';   // sin el prefijo del servidor
  return isHomeWrite(base) ? { kind: 'home', title: 'Casa', detail: homeDetail(a) } : null;
}

// adónde lleva tv_open_app (para el `layout` que pide Jota: basta con el sitio, la búsqueda de dentro no cuenta)
const APP_URLS = Object.freeze({ youtube: 'https://www.youtube.com/', netflix: 'https://www.netflix.com/', spotify: 'https://open.spotify.com/' });
const URL_MAX = 2000;

/**
 * Formato que pide Jota en los argumentos de tv_open / tv_open_app (`layout: 'pill' | 'panel'`) y la página a la que
 * va, o null. Lo que no sea exactamente eso no cuenta (talk-view.js lo vuelve a sanear).
 * @param {any} name @param {any} args @returns {{ layout: string, url: string } | null}
 */
function layoutOf(name, args) {
  const n = toolName(name), a = args && typeof args === 'object' ? args : {};
  if (!n || (a.layout !== 'pill' && a.layout !== 'panel')) return null;
  if (/** @type {RegExp} */ (SUFFIX.get('tv_open_app')).test(n)) return APP_URLS[a.app] ? { layout: a.layout, url: APP_URLS[a.app] } : null;
  if (!(/** @type {RegExp} */ (SUFFIX.get('tv_open')).test(n)) || typeof a.url !== 'string' || !a.url.trim()) return null;
  const u = a.url.trim().slice(0, URL_MAX);
  return { layout: a.layout, url: /^https?:\/\//i.test(u) ? u : 'https://' + u };   // un dominio suelto, como lo abre el mando
}

// herramientas que ponen otra página en la tele (navegan): al acabar el turno, la conversación espera a que se pinte
const OPENS_TOOLS = Object.freeze(['tv_open', 'tv_open_app', 'tv_netflix', 'tv_youtube', 'tv_present', 'tv_show_html', 'tv_idle']);
/** ¿Esta llamada pone otra página en la tele? (solo las que tienen ficha: tv_idle, con op=show) @param {any} name @param {any} args */
function opensPage(name, args) {
  const n = toolName(name);
  return !!n && !!toolCard(name, args) && OPENS_TOOLS.some(t => /** @type {RegExp} */ (SUFFIX.get(t)).test(n));
}

module.exports = { KINDS, CARD_TOOLS, APP_URLS, OPENS_TOOLS, toolCard, toolName, layoutOf, opensPage, clip, DETAIL_MAX };
