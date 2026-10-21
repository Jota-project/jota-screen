'use strict';
// @ts-check
// Qué formato lleva la capa del agente: `pill` (arriba, pequeña: lo que se ve manda) o `panel` (columna a
// la derecha con la conversación). Función pura: talk-view.js la consulta al empezar el turno, al acabar de pintarse una
// página nueva, cuando cambia la reproducción y cuando el usuario o Jota piden otro formato. Orden:
//   1. `override` del usuario (arrastre en la tele o en el mando) para el contenido actual
//   2. `agentLayout`: Jota lo pidió al abrir esta página (tv_open / tv_open_app con `layout`)
//   3. destino de contenido (app de vídeo o música, o el escenario propio) → pill, se reproduzca o no
//   4. `playback`: un vídeo grande que avanza en cualquier web → pill (reserva)
//   5. reposo y webs normales → panel
// Lo automático (3, 4) solo lleva de panel a píldora: volver al panel es cosa del usuario o de Jota (o de un turno nuevo).
const { FORMS } = require('./agent-contract');

// Apps de contenido (lo que abre tv_open_app y las de vídeo y música habituales en España). Se compara por sufijo del
// host con límite de etiqueta (`www.netflix.com` sí, `notnetflix.com` no); con ruta, también por prefijo de ruta con límite
// de segmento (`rtve.es/play/…` sí, `rtve.es/playa` no)
const CONTENT_HOSTS = Object.freeze([
  'netflix.com', 'youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be', 'open.spotify.com',
  'primevideo.com', 'disneyplus.com', 'max.com', 'hbomax.com', 'movistarplus.es', 'twitch.tv', 'rtve.es/play',
  'atresplayer.com', 'mitele.es', 'filmin.es', 'tv.apple.com', 'skyshowtime.com', 'dazn.com', 'crunchyroll.com',
  'pluto.tv', 'vimeo.com', 'music.apple.com', 'soundcloud.com',
]);
// el usuario fuerza un formato mientras siga el mismo contenido (mismo destino, o el mismo escenario); al volver al
// reposo o abrir otra cosa se olvida
const OVERRIDE_SCOPE = 'content';
// Jota pide un formato para la página que abre: vale mientras se esté en ese destino; si en este tiempo no se llega a él
// (la navegación falló), se olvida
const AGENT_LAYOUT_TTL_MS = 20000;
// de dónde sale el formato (talk-view.js: lo automático no vuelve al panel; usuario y Jota sí)
const FORM_SOURCES = Object.freeze(['user', 'agent', 'content', 'playback', 'default']);
/** quién puede devolver la píldora al panel */
const FORCED_SOURCES = Object.freeze(['user', 'agent']);

/** @param {any} f @returns {'pill' | 'panel' | null} */
const cleanForm = f => (FORMS.includes(f) ? f : null);

/** Host (minúsculas, sin punto final ni puerto) y ruta de una URL; null si no es http(s). @param {any} url */
function partsOf(url) {
  let u;
  try { u = new URL(String(url || '')); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  return { host: u.hostname.toLowerCase().replace(/\.$/, ''), path: u.pathname || '/' };
}
/** Entrada de `hosts` que casa con la URL (la más larga si casan varias), o ''. @param {any} url @param {readonly string[]} [hosts] */
function contentEntry(url, hosts = CONTENT_HOSTS) {
  const p = partsOf(url);
  if (!p) return '';
  let best = '';
  for (const e of hosts) {
    const i = e.indexOf('/'), h = i < 0 ? e : e.slice(0, i), pre = i < 0 ? '' : e.slice(i);
    if (p.host !== h && !p.host.endsWith('.' + h)) continue;
    if (pre && p.path !== pre && !p.path.startsWith(pre + '/')) continue;
    if (e.length > best.length) best = e;
  }
  return best;
}
/** ¿La URL es de una app de contenido? @param {any} url @param {readonly string[]} [hosts] */
const isContent = (url, hosts) => !!contentEntry(url, hosts);

/**
 * Clave del contenido para el alcance del override y de lo que pidió Jota: el reposo (`idle`), el escenario
 * (`stage:<tipo>`), la app de contenido (su entrada de la lista, así un salto de `netflix.com` a `www.netflix.com` sigue siendo
 * lo mismo) o el host sin `www.`. '' si no hay URL.
 * @param {{ url?: any, stage?: any, idle?: boolean, hosts?: readonly string[] }} o
 */
function contentKey({ url, stage, idle, hosts }) {
  if (idle) return 'idle';                         // el escenario puede seguir marcado con el reposo ya en pantalla
  if (stage) return 'stage:' + String(stage);
  const e = contentEntry(url, hosts);
  if (e) return e;
  const p = partsOf(url);
  return p ? p.host.replace(/^www\./, '') : '';
}

/**
 * Escenario que enseña la URL (tv_present: `<self>/tpl-<tipo>.html`; tv_show_html: `<self>/stage/…` → 'html'), o null.
 * Sale de la URL y no del estado del escenario: «atrás», un clic o tv_click_at salen de él sin pasar por control.nav.
 * @param {any} url @param {string} self origen del servidor (SELF)
 * @returns {string | null}
 */
function stageOf(url, self) {
  const u = String(url || '').split(/[?#]/)[0];
  if (!self || !u.startsWith(self + '/')) return null;
  const rest = u.slice(self.length + 1), tpl = /^tpl-([a-z]+)\.html$/.exec(rest);
  return tpl ? tpl[1] : rest.startsWith('stage/') ? 'html' : null;
}

/**
 * Formato y de dónde sale (ver arriba). `override` y `agentLayout` ya filtrados por el llamante (los de este contenido).
 * @param {{ url?: any, stage?: any, idle?: boolean, playback?: boolean, override?: any, agentLayout?: any,
 *   hosts?: readonly string[] }} o
 * @returns {{ form: 'pill' | 'panel', by: 'user' | 'agent' | 'content' | 'playback' | 'default' }}
 */
function decideForm({ url, stage, idle, playback, override, agentLayout, hosts }) {
  const o = cleanForm(override), a = cleanForm(agentLayout);
  if (o) return { form: o, by: 'user' };
  if (a) return { form: a, by: 'agent' };
  if (!idle && (stage || isContent(url, hosts))) return { form: 'pill', by: 'content' };
  if (playback === true) return { form: 'pill', by: 'playback' };
  return { form: 'panel', by: 'default' };
}
/** Solo el formato. @param {Parameters<typeof decideForm>[0]} o @returns {'pill' | 'panel'} */
const formFor = o => decideForm(o).form;

module.exports = { CONTENT_HOSTS, OVERRIDE_SCOPE, AGENT_LAYOUT_TTL_MS, FORM_SOURCES, FORCED_SOURCES,
  cleanForm, contentEntry, isContent, contentKey, stageOf, decideForm, formFor };
