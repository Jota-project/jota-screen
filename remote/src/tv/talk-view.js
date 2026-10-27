'use strict';
// @ts-check
// Capa de la conversación en la tele: lo que dices y lo que contesta Jota, en directo, encima de cualquier página.
// Dos formatos, fijados al empezar el turno: `island` (hay vídeo: arriba en el centro, solo la frase y la respuesta) y
// `panel` (columna a la derecha). La página recibe public/tv-agent.js («paneles vivos») una sola vez: la primera llamada
// lleva la fuente (con los tokens delante, src/tv/tokens.js) y las siguientes solo `TVAgent.render(…)`.
// Si la página cambia, la llamada corta devuelve false (no hay TVAgent) y se repite al momento con la fuente; server.js
// también avisa con reset() al navegar o al cambiar de pestaña. Ese reintento es uno por página (hasta reset o un render
// bueno): una web donde TVAgent no llega a existir no recibe la fuente entera cada 100 ms. Con hide() se quita al momento
// (y nada de ese turno la vuelve a sacar hasta el turn() siguiente); onHide avisa de cada ocultación.
//
// Cada render lleva una foto completa (`Snap`, ver docs/arquitectura.md) con el estado del orbe derivado aquí, los 2 últimos
// turnos (también en la píldora, que solo enseña el último), las fichas de herramientas y sus iconos.
// Se cierra `CLOSE_BASE_MS + CLOSE_PER_CHAR_MS × letras de la respuesta` tras el fin.
// Formato (ronda 3): lo decide agent-form.js (`decideForm`) con la página de context(): override del usuario, lo que pidió
// Jota (`agentLayout`), app de contenido o escenario → píldora, vídeo grande en marcha → píldora, y si no, panel. Se fija
// al empezar el turno y se vuelve a mirar cuando una página nueva ya está PINTADA (tras navegar), cuando cambia la
// reproducción (`playback`, de page-poll) y cuando el usuario arrastra (`userForm`, orden talkform o binding de la página).
// Lo automático es de un solo sentido (panel → píldora, tras `MORPH_DELAY_MS`); a panel solo vuelve el usuario o Jota.
// El tinte (`ctx`) sigue a la página en cada foto. Un turno con una ficha que abre algo (`opens`, de agent-ui.js) no se
// cierra mientras la página nueva no enseñe su contenido (y transformada, si toca): espera como mucho `AWAIT_PAGE_MS`.
// Navegar mata la capa (documento nuevo): mientras se ve, la fuente y la última foto van también como script de documento
// nuevo (Page.addScriptToEvaluateOnNewDocument), así la página siguiente la pinta en cuanto existe, en modo `restore`
// (en su caja, sin animación de entrada). Se quitan al ocultarla.
// Cambio de pestaña (Netflix va en la suya; cdp.show): reset({ tab: true }) desde onAttached pinta YA (sin batchMs), con la
// pestaña aún detrás, la última foto que se vio (su tinte, `enter:'restore'` y `tab`: la página retira en seco lo que se
// quedó pintado en ella y restaura), y devuelve la promesa de esa llamada: cdp.show la espera antes de traerla al frente.
// Con `from` (la pestaña que se deja, aún enganchada) antes se le pregunta cuántas palabras de cada turno enseña ya
// (`shown`): la nueva restaura esas y revela el resto como siempre, así nace igual que se veía (FROM_WAIT_MS como mucho).
// La foto siguiente ya trae el tinte de la pestaña nueva (los muelles hacen el cambio). La que se deja se quita en seco
// (leave, con su sesión aún enganchada) tras traer la otra al frente.
const { agentSource } = require('./tokens');
const { KINDS } = require('../features/agent-ui');
const { CTXS, GLASS, COLOR_RE, FORM_BINDING, HOST_ID } = require('./agent-contract');
const { CONTENT_HOSTS, AGENT_LAYOUT_TTL_MS, FORCED_SOURCES, cleanForm, contentKey, decideForm } = require('./agent-form');

// la isla de actividades (arriba en el centro) se aparta solo bajo la píldora, que va en su sitio; con el panel (a la
// derecha) sigue a la vista, centrada a su izquierda: un temporizador que acaba no se queda escondido mientras habla Jota
const dimOn = (/** @type {string} */ form) => `window.TVIsland&&window.TVIsland.dim(${form === 'pill' ? '0' : '1,true'})`;
// la isla de actividades vuelve a 1 aunque hide falle
const HIDE = 'try{window.TVAgent&&window.TVAgent.hide()}finally{window.TVIsland&&window.TVIsland.dim(1)}';
/** Quita en seco (sin fundido) la capa de la pestaña que se deja: ya no se ve y, al volver, se restaura de cero. */
const LEAVE_HIDE = 'try{window.TVAgent&&window.TVAgent.hide(true)}finally{window.TVIsland&&window.TVIsland.dim(1)}';
/** Palabras que enseña ya cada turno en la pestaña que se deja ({ id: [tú, Jota] }), o null. */
const REVEALED = '(()=>{try{return window.TVAgent&&typeof window.TVAgent.revealed==="function"?window.TVAgent.revealed():null}catch(e){return null}})()';
const FROM_WAIT_MS = 100;                    // lo que se espera esa respuesta antes de pintar sin ella

const LEVEL_FLOOR_DB = 50, LEVEL_RANGE_DB = 40;   // nivel de la voz: -50 dBFS (silencio) → 0, -10 dBFS (voz alta) → 1
const KEEP_TURNS = 2;                        // turnos en el panel (el anterior, atenuado)
const CLOSE_BASE_MS = 4000;                  // se cierra esto tras el fin real…
const CLOSE_PER_CHAR_MS = 45;                // …más esto por letra de la respuesta
const RETRY_HINT = 'Di «otra vez» para reintentar.';   // pista tras un fallo de herramienta (el agente entiende «otra vez»)
const RECOVER_ON_OK = true;                  // una herramienta posterior que acaba bien despeja el fallo de otra (orbe y pista)
const SETTLED_STATUS = /** @type {'ok'} */ ('ok');   // ficha sin `result` al cerrar el turno: deja de girar (no 'fail': ni alerta ni pista)
const COLOR_MAX = 40;                        // caracteres de un color CSS de `context().colors`
// fichas que ponen otra página (`opens`, de agent-ui.js: tv_open, tv_open_app, tv_present…): al acabar el turno, si no se
// ha pintado ninguna página desde que empezó la herramienta, el cierre espera a que se pinte (y a la píldora, si le toca),
// no a que empiece a reproducirse nada (ronda 3: el formato lo decide la página, no la reproducción)
const AWAIT_PAGE_MS = 12000;                 // espera máxima a la página nueva (el cierre normal no corre mientras tanto)
const AFTER_PAINT_MIN_MS = 2500;             // ya pintada, la conversación se ve al menos esto encima antes de cerrarse
const PAINT_WAIT_MS = 4000;                  // la página dice «pintada» como mucho tras esto (sin contenido que se reconozca, o pestaña oculta)
const MORPH_DELAY_MS = 400;                  // respiro entre la página pintada (o `playback`) y el paso a píldora
const PILL_DWELL_BASE_MS = 3500;             // tras el paso, la píldora se queda esto…
const PILL_DWELL_PER_CHAR_MS = 45;           // …más esto por letra de la última respuesta, y se cierra
const BINDING_GAP_MS = 300;                  // avisos de arrastre desde la página más seguidos que esto se ignoran
const NO_LAYER = 'no hay conversación en la tele';
// «pintada» = el contenido nuevo ya se ve, no el primer frame: una app (Netflix, YouTube) pinta primero un esqueleto o un
// «Cargando…». Tras el primer paint (paint timing) se mira cada PAINT_EVERY_MS una rejilla de PAINT_GRID × PAINT_GRID
// puntos de la pantalla: en cuanto PAINT_MIN_POINTS caen en contenido de verdad (imagen o vídeo con imagen, fondo con
// imagen o texto; nunca la capa del agente ni las cajas grises de un esqueleto), dos rAF (ya en pantalla) y listo. Así
// también vale tras navegar dentro de la misma página (pushState). Como mucho PAINT_WAIT_MS. LCP no sirve: la capa
// restaurada (texto grande en shadow DOM) es el elemento más grande y tapa los candidatos de la web
const PAINT_GRID = 5;                        // puntos por lado de la rejilla (en el centro de cada celda)
const PAINT_MIN_POINTS = 2;                  // puntos con contenido para darla por pintada (un «Cargando…» o un spinner: 1)
const PAINT_EVERY_MS = 100;                  // cada cuánto se vuelve a mirar
// pestaña en blanco o documento vacío de arranque (about:blank mientras carga la de verdad): no es «la página nueva», ni se
// sondea (la sonda contesta PAINT_BLANK al momento) ni cuenta como pintada; la pintada llega con la navegación siguiente
const BLANK_RE = /^(about:|chrome:\/\/new-?tab|chrome-search:)/i;
const PAINT_BLANK = 'blank';
const PAINT_RETRIES = 3;                     // la sonda falló sin navegación por medio (p. ej. recarga sin aviso): se repite
// la sonda vio la pestaña aún en blanco aunque la URL ya es la nueva (Chrome avisa del cambio antes de que llegue el
// documento): se vuelve a mirar cada PAINT_EVERY_MS durante PAINT_WAIT_MS como mucho
const BLANK_RETRIES = Math.ceil(PAINT_WAIT_MS / PAINT_EVERY_MS);
/**
 * Corre EN LA PÁGINA (se serializa): se resuelve cuando la página nueva ya enseña su contenido (ver arriba). El tope vale
 * también tras encontrarlo (una pestaña oculta no da rAF: se resuelve igual).
 * @param {{ wait: number, grid: number, min: number, every: number, host: string, blank: string, blankRe: string }} o
 * @returns {Promise<boolean | string>} false si venció el tope; o.blank en una pestaña en blanco
 */
function paintProbe(o) {
  return new Promise(res => {
    if (o.blankRe && new RegExp(o.blankRe, 'i').test(String(document.URL))) return res(o.blank);
    let done = false, iv = /** @type {any} */ (0);
    const stop = () => { done = true; clearInterval(iv); };
    const cap = setTimeout(() => { stop(); res(false); }, o.wait);
    /** @param {Element} e */
    const rich = e => {
      const t = e.tagName;
      if (t === 'IMG') return /** @type {HTMLImageElement} */ (e).complete && /** @type {HTMLImageElement} */ (e).naturalWidth > 0;
      if (t === 'VIDEO') return /** @type {HTMLVideoElement} */ (e).readyState >= 2 || !!/** @type {HTMLVideoElement} */ (e).poster;
      if (/^(CANVAS|PICTURE|IFRAME|EMBED|OBJECT|svg)$/.test(t)) return true;
      if (/url\(/.test(getComputedStyle(e).backgroundImage)) return true;
      return [...e.childNodes].some(n => n.nodeType === 3 && /\S/.test(n.textContent));
    };
    /** El primer elemento de la web en (x, y), sin la capa del agente: ¿es contenido? @param {number} x @param {number} y */
    const hit = (x, y) => {
      for (const e of document.elementsFromPoint(x, y)) {
        if (e.id === o.host) continue;
        return e !== document.documentElement && e !== document.body && rich(e);
      }
      return false;
    };
    const look = () => {
      if (done) return;
      let n = 0;
      for (let i = 0; i < o.grid && n < o.min; i++) for (let j = 0; j < o.grid && n < o.min; j++) {
        if (hit(innerWidth * (i + 0.5) / o.grid, innerHeight * (j + 0.5) / o.grid)) n++;
      }
      if (n < o.min) return;
      stop();
      requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(cap); res(true); }));
    };
    const start = () => { look(); if (!done) iv = setInterval(look, o.every); };
    if (performance.getEntriesByType('paint').length) return start();
    try { new PerformanceObserver((l, ob) => { ob.disconnect(); start(); }).observe({ type: 'paint' }); } catch { start(); }
  });
}
const PAINT_PROBE = `(${paintProbe})(${JSON.stringify({ wait: PAINT_WAIT_MS, grid: PAINT_GRID, min: PAINT_MIN_POINTS, every: PAINT_EVERY_MS, host: HOST_ID,
  blank: PAINT_BLANK, blankRe: BLANK_RE.source })})`;
const RESTORE_GLOBAL = '__tvAgentRestore';   // global de la página con la última foto (la lee la fuente al cargarse)

/** @typedef {'listen' | 'think' | 'talk' | 'error' | 'done'} State */
/** @typedef {{ id: string, kind: string, title: string, detail: string, status: 'run' | 'ok' | 'fail' }} Tool */
/** @typedef {{ id: number, you: string, youFinal: boolean, jota: string, tools: Tool[], error: boolean, hint: string, media?: Media | null }} Turn */
/**
 * Tarjeta de contenido del turno (la pone el servidor, no el Gateway): Netflix o YouTube (`brand`). `list`: lo que se está viendo;
 * `play`: el título que se va a poner, con su ▶ (`state`: 'idle' → 'press' al pulsarlo). Imágenes por URL absoluta.
 * @typedef {{ title: string, sub: string, frac: number, img: string, still?: string, left?: string }} MediaItem
 * @typedef {{ key: string, kind: 'list' | 'play', state: 'idle' | 'press', brand: 'netflix' | 'youtube', items: MediaItem[] }} Media
 */
/** playback: hay una reproducción de verdad (page-poll); null si context() no lo dice. page: la página de la tele
 * (`url`, `stage` = tipo de escenario o null, `idle` = el reposo) para decidir el formato; null si context() no la trae
 * (y sin playback ni página, manda el modo de talk.js)
 * @typedef {{ url: string, stage: string | null, idle: boolean }} Page
 * @typedef {{ ctx: string | null, night: boolean, calm: boolean, glass: string, colors: [string, string] | null,
 *   playback: boolean | null, page: Page | null }} Look */
/**
 * Foto que recibe `TVAgent.render`. `enter`: 'open' normal; 'restore' en un documento nuevo (tras navegar)
 * o en otra pestaña. `tab` (solo la primera foto tras un cambio de pestaña, con 'restore'): lo que haya pintado en esa
 * pestaña es de antes y se retira en seco. `shown` (con `tab`): palabras de tú y de Jota que ya se veían de cada turno.
 * `voice` (solo con voz, del turno actual): ver Voice.
 * @typedef {{ form: 'pill' | 'panel', ctx: string, state: State, live: boolean, night: boolean, calm: boolean, glass: string,
 *   colors: [string, string] | null, turns: Turn[], icons: Record<string, any>, enter: 'open' | 'restore', tab?: true,
 *   shown?: Record<string, [number, number]>, voice?: Voice }} Snap
 */
/**
 * Voz sincronizada de la respuesta (talk.js, voice-sync.js): anclas [ms de audio, carácter], ms por carácter tras la
 * última, `head` ms de audio sonados al mandar la foto (negativo: aún no suena), `upto` ms recibidos (la página no pasa
 * de ahí) y `text` largo del texto al que se refieren. Sin anclas: en espera (la respuesta aún no se enseña).
 * @typedef {{ anchors: [number, number][], rate: number, head: number, upto: number, text: number }} Voice
 */
const VOICE_ANCHORS_MAX = 200;               // anclas que llegan a la página (las últimas)
const VOICE_HEAD_MIN = -10000;               // cabeza negativa: lo que falta para que suene (la latencia del altavoz)

/** La voz de talk.js, saneada (números finitos ≥ 0, como mucho VOICE_ANCHORS_MAX anclas) o null. @param {any} v @returns {Voice | null} */
function cleanVoice(v) {
  const ok = (/** @type {any} */ n) => typeof n === 'number' && Number.isFinite(n) && n >= 0;
  if (!v || typeof v !== 'object' || !Array.isArray(v.anchors) || !ok(v.rate) || !(v.rate > 0) || !ok(v.upto) || !ok(v.text)) return null;
  if (typeof v.head !== 'number' || !Number.isFinite(v.head) || v.head < VOICE_HEAD_MIN) return null;
  const anchors = v.anchors.filter((/** @type {any} */ a) => Array.isArray(a) && a.length === 2 && ok(a[0]) && ok(a[1]))
    .slice(-VOICE_ANCHORS_MAX).map((/** @type {number[]} */ a) => /** @type {[number, number]} */ ([a[0], a[1]]));
  return { anchors, rate: v.rate, head: Math.min(v.head, v.upto), upto: v.upto, text: v.text };
}

/** Sin `context()` (o si lanza): los valores por defecto. @type {Look} */
const DEFAULT_LOOK = Object.freeze({ ctx: null, night: false, calm: false, glass: 'auto', colors: null, playback: null, page: null });
const URL_MAX = 2000;                        // caracteres de la URL de context().page
const STAGE_MAX = 40;                        // caracteres del tipo de escenario

/** La página de context(), saneada, o null. @param {any} p @returns {Page | null} */
function cleanPage(p) {
  if (!p || typeof p !== 'object' || typeof p.url !== 'string') return null;
  return { url: p.url.slice(0, URL_MAX), stage: typeof p.stage === 'string' && p.stage ? p.stage.slice(0, STAGE_MAX) : null, idle: p.idle === true };
}

/** Dos colores CSS seguros o null. @param {any} c @returns {[string, string] | null} */
function cleanColors(c) {
  if (!Array.isArray(c) || c.length < 2) return null;
  const ok = c.slice(0, 2).every(x => typeof x === 'string' && x.length <= COLOR_MAX && COLOR_RE.test(x));
  return ok ? [c[0], c[1]] : null;
}
/** Lo que devuelve `context()`, saneado (cualquier valor desconocido cae en el de por defecto). @param {any} c @returns {Look} */
function cleanLook(c) {
  if (!c || typeof c !== 'object') return DEFAULT_LOOK;
  return {
    ctx: CTXS.includes(c.ctx) ? c.ctx : null,
    night: c.night === true, calm: c.calm === true,
    glass: GLASS.includes(c.glass) ? c.glass : 'auto',
    colors: cleanColors(c.colors),
    playback: typeof c.playback === 'boolean' ? c.playback : null,
    page: cleanPage(c.page),
  };
}

/** `shown` de la página que se deja, saneado: solo [n, n] enteros ≥ 0 por id. @param {any} o @returns {Record<string, [number, number]> | null} */
function cleanShown(o) {
  if (!o || typeof o !== 'object') return null;
  /** @type {Record<string, [number, number]>} */ const r = {};
  for (const [k, v] of Object.entries(o).slice(0, 16)) {
    if (Array.isArray(v) && v.length === 2 && v.every(n => Number.isInteger(n) && n >= 0 && n < 1e5)) r[k] = [v[0], v[1]];
  }
  return r;
}
/** La promesa `p` o, como mucho, `ms` (entonces null). @param {Promise<any>} p @param {number} ms */
function within(p, ms) {
  let t = /** @type {any} */ (0);
  return Promise.race([p, new Promise(r => { t = setTimeout(() => r(null), ms); })]).finally(() => clearTimeout(t));
}

/** @param {number} id @returns {Turn} */
const newTurn = id => ({ id, you: '', youFinal: false, jota: '', tools: [], error: false, hint: '' }); // media: solo si la hay

const MEDIA_MAX = 4;
const BRANDS = ['netflix', 'youtube'];   // de quién es la tarjeta (la capa pone su nombre)
/** ¿La tele está en una página nuestra (el reposo)? Solo ahí van las imágenes de las tarjetas. @param {Look} l */
const ourPage = l => l.ctx === 'idle' || l.ctx === 'music' || !!(l.page && l.page.idle);
/** La tarjeta sin sus imágenes. @param {Media} m @returns {Media} */
const noImages = m => ({ ...m, items: m.items.map(it => ({ ...it, img: '', still: '' })) });
/** Tarjeta saneada (viene de otra capacidad del servidor; la capa la vuelve a sanear). @param {any} m @returns {Media | null} */
function cleanMedia(m) {
  if (!m || typeof m !== 'object' || (m.kind !== 'list' && m.kind !== 'play')) return null;
  const str = (x, n = 160) => (typeof x === 'string' ? x.slice(0, n) : '');
  const url = x => (typeof x === 'string' && /^https?:\/\/[^\s"'<>]+$/.test(x) && x.length < 2048 ? x : '');
  const items = (Array.isArray(m.items) ? m.items : []).slice(0, MEDIA_MAX).filter(i => i && typeof i === 'object' && i.title).map(i => ({
    title: str(i.title, 120), sub: str(i.sub), left: str(i.left, 60), frac: Math.min(1, Math.max(0, Number(i.frac) || 0)),
    img: url(i.img), still: url(i.still),
  }));
  if (!items.length) return null;
  return { key: str(m.key, 80) || m.kind, kind: m.kind, state: m.state === 'press' ? 'press' : 'idle', brand: BRANDS.includes(m.brand) ? m.brand : 'netflix', items };
}
/** Un turno que algo dijo o hizo (uno cancelado sin nada no se guarda). @param {Turn} t */
const said = t => !!(t.you || t.jota || t.tools.length || t.media);
/** El turno salió mal: error en la respuesta o un fallo de herramienta sin despejar (la pista lo marca). @param {Turn} t */
const failed = t => t.error || !!t.hint;
/** Las fichas que siguen girando al cerrar o archivar el turno pasan a SETTLED_STATUS (no cuentan como fallo). @param {Turn} t */
function settleTools(t) { for (const x of t.tools) if (x.status === 'run') x.status = SETTLED_STATUS; }

/**
 * Foto a partir de los turnos guardados (el último, el actual). Pura: la prueban las pruebas. Lleva los
 * KEEP_TURNS últimos también en la píldora (la página solo enseña el último): así el log no cambia en el mismo frame en
 * que cambia la forma, y el turno anterior se pliega o reaparece con el contenido ya oculto (en el viaje del paso).
 * @param {{ form: 'pill' | 'panel', ctx: string, state: State, live: boolean, look: Look, turns: Turn[], enter?: 'open' | 'restore',
 *   voice?: Voice | null }} o
 * @returns {Snap}
 */
function snapshot({ form, ctx, state, live, look, turns, enter = 'open', voice = null }) {
  const shown = turns.slice(-KEEP_TURNS).map(t => ({ ...t, tools: t.tools.map(x => ({ ...x })) }));
  /** @type {Record<string, any>} */ const icons = {};
  for (const t of shown) for (const x of t.tools) if (KINDS[x.kind]) icons[x.kind] = KINDS[x.kind].icon;
  return { form, ctx, state, live, night: look.night, calm: look.calm, glass: look.glass, colors: look.colors, turns: shown, icons, enter,
    ...(voice ? { voice: { ...voice, anchors: voice.anchors.map(a => /** @type {[number, number]} */ ([a[0], a[1]])) } } : {}) };
}

/** Script de documento nuevo con la fuente de la capa: al cargarse pinta la última foto, si ya llegó. Solo el marco
 * principal (los scripts de documento nuevo corren también en los iframes). @param {string} source */
const sourceScript = source => `(()=>{if(window.top!==window)return;${source}\n;var s=window.${RESTORE_GLOBAL};if(s&&window.TVAgent)window.TVAgent.render(s)})()`;
/** Script de documento nuevo con la última foto (en modo restore): la deja para la fuente o la pinta si ya está. @param {Snap} snap */
const snapScript = snap => `(()=>{if(window.top!==window)return;var s=${JSON.stringify(snap)};window.${RESTORE_GLOBAL}=s;if(window.TVAgent)window.TVAgent.render(s)})()`;

/**
 * @param {{ cdp: { session?: any, call: (method: string, params: object) => Promise<any> }, pub: string,
 *           batchMs?: number, log?: (msg: string) => void, context?: () => any,
 *           awaitMs?: number, morphDelayMs?: number, pillBaseMs?: number, afterPaintMs?: number,
 *           contentHosts?: readonly string[], onAsk?: (text: string) => void }} deps
 *   contentHosts: apps de contenido (por defecto CONTENT_HOSTS; las pruebas añaden la suya). onAsk: la pregunta del turno,
 *   ya final (una vez por turno): quien quiera puede poner su tarjeta sin esperar al agente (media)
 */
function createTalkView({ cdp, pub, batchMs = 100, log = () => {}, context, onAsk,
  awaitMs = AWAIT_PAGE_MS, morphDelayMs = MORPH_DELAY_MS, pillBaseMs = PILL_DWELL_BASE_MS, afterPaintMs = AFTER_PAINT_MIN_MS,
  contentHosts = CONTENT_HOSTS }) {
  /** Turnos ya cerrados (el panel enseña el último). @type {Turn[]} */
  let history = [];
  let seq = 0;
  let cur = newTurn(++seq);
  /** @type {'island' | 'panel'} */
  let mode = 'panel';
  /** @type {State} */
  let state = 'done';
  let live = false;
  /** La voz del turno actual y cuándo llegó (`at`): la cabeza avanza en tiempo real hasta cada foto. @type {(Voice & { at: number }) | null} */
  let spoken = null;
  let open = false;      // hay un intercambio en curso (entre turn y done/error)
  let shown = false;     // la capa está (o va a estar) en pantalla
  let injected = false;  // la página actual tiene la capa (según lo último que sabemos)
  let levelBusy = false; // un nivel de la voz en vuelo hacia la página
  let painted = false;   // se mandó alguna foto (hay capa que quitar)
  let retried = false;   // ya se reenvió la fuente tras un render sin capa (una vez por página: hasta reset o un render bueno)
  let muted = false;     // quitada con hide(): lo que quede de ese turno no se pinta (hasta el turn() siguiente)
  let morphed = false;   // este intercambio pasó solo a píldora (página de contenido o vídeo): al acabar, PILL_DWELL
  let awaiting = false;  // turno acabado esperando a que la página que abrió esté pintada (el cierre no corre)
  let waited = false;    // el turno acabado abrió algo: una navegación después (o mientras) vuelve a armar la espera
  let weak = false;      // la última pintada fue el tope de la sonda (PAINT_WAIT_MS), no contenido visto: espera vencida
  let doneAt = 0;        // fin del turno (para contar el cierre normal desde ahí)
  let restoreNext = false; // la próxima foto va a un documento nuevo (tras reset): entra en modo restore
  /** @type {Snap | null} */ let seen = null; // la última foto mandada (en modo restore): lo que se ve ahora
  let tabbing = 0;       // navSeq de un cambio de pestaña que pregunta a la que se deja: las tandas esperan a su foto
  let navSeq = 0, paintedSeq = 0; // navegaciones con la capa a la vista / la última ya pintada (distintas: falta pintar)
  let paints = 0;        // páginas nuevas pintadas con la capa encima (whenPainted)
  /** @type {Set<string>} */ let opening = new Set(); // fichas de este turno que ponen otra página
  let openMark = -1;     // `paints` cuando empezó la última de ellas (si sigue igual al acabar, la página no ha llegado)
  let navOpened = false; // el servidor navegó durante el turno (control.nav): cuenta como una ficha que abre, también sin
                         // eventos de herramienta del Gateway (tool_calls_enabled apagado)
  // formato pedido por el usuario (arrastre) para un contenido, y por Jota para la página que abre (`reached`: ya se llegó)
  /** @type {{ form: 'pill' | 'panel', key: string } | null} */ let override = null;
  /** @type {{ form: 'pill' | 'panel', key: string, at: number, reached: boolean } | null} */ let pick = null;
  let bindingAt = -Infinity;
  /** @type {() => void} */ let hidden = () => {};
  /** @type {(form: 'pill' | 'panel', canSwitch: boolean) => void} */ let formFn = () => {};
  let batchT = null, hideT = null, morphT = null;
  let bound = /** @type {any} */ (null); // sesión CDP con el binding del arrastre ya puesto
  // scripts de documento nuevo (ids de la sesión CDP que los registró; otra sesión no los tiene y no hay que quitarlos)
  let across = false;    // deben estar (la capa se ve)
  let reg = { session: /** @type {any} */ (null), src: '', snap: '', sig: '' };
  let regQ = Promise.resolve();

  /** @returns {Look} */
  function look() {
    if (!context) return DEFAULT_LOOK;
    try { return cleanLook(context()); } catch (e) { log('conversación: ' + e.message); return DEFAULT_LOOK; }
  }
  const src = () => { try { return agentSource(pub); } catch (e) { log('conversación: ' + e.message); return ''; } };

  /** Lo que recibe render (el tinte sigue a la página actual). @param {Look} l @param {'open' | 'restore'} [enter] */
  function payload(l, enter = 'open') {
    const form = mode === 'island' ? 'pill' : 'panel';
    // una tarjeta puesta en el reposo sigue en su turno al pasar a una web ajena: allí, sin sus imágenes (son de
    // 127.0.0.1: desde la web, Chrome pediría permiso para «acceder a otras aplicaciones y servicios de este dispositivo»)
    const turns = [...history, cur].map(t => (t.media && !ourPage(l) ? { ...t, media: noImages(t.media) } : t));
    const vo = spoken && { anchors: spoken.anchors, rate: spoken.rate, head: Math.min(spoken.head + Date.now() - spoken.at, spoken.upto), upto: spoken.upto, text: spoken.text };
    return snapshot({ form, ctx: l.ctx || (form === 'pill' ? 'video' : 'web'), state, live, look: l, turns, enter, voice: vo });
  }

  // ── scripts de documento nuevo: en cola (nunca dos cambios a la vez) y siempre contra la sesión que los registró
  /** @param {() => Promise<void>} fn */
  const regDo = fn => { regQ = regQ.then(fn).catch(e => log('conversación: ' + e.message)); };
  /** @param {string} source @returns {Promise<string>} */
  const addScript = async source => String((await cdp.call('Page.addScriptToEvaluateOnNewDocument', { source }))?.identifier || '');
  /** @param {string} id */
  const removeScript = id => (id ? cdp.call('Page.removeScriptToEvaluateOnNewDocument', { identifier: id }).catch(() => {}) : Promise.resolve());
  /** Registra la fuente (una vez) y cambia la foto guardada si cambió. @param {Snap} snap en modo restore */
  function keepAcross(snap) {
    across = true;
    const sid = cdp.session, sig = JSON.stringify(snap);
    regDo(async () => {
      if (!across || !sid || cdp.session !== sid) return;
      if (reg.session !== sid) reg = { session: sid, src: '', snap: '', sig: '' };   // pestaña nueva: los de la otra se fueron con ella
      if (!reg.src) {
        const s = src();
        if (!s) return;
        await cdp.call('Page.enable', {});            // sin él, los scripts de documento nuevo no se ejecutan
        if (bound !== sid) {                          // el arrastre en la tele avisa por aquí (Runtime.bindingCalled)
          await cdp.call('Runtime.enable', {});
          await cdp.call('Runtime.addBinding', { name: FORM_BINDING });
          bound = sid;
        }
        reg.src = await addScript(sourceScript(s));
      }
      if (reg.sig === sig) return;
      const old = reg.snap;
      reg.snap = await addScript(snapScript(snap)); reg.sig = sig;
      await removeScript(old);                         // la nueva antes de quitar la vieja: nunca un hueco sin foto
    });
  }
  function dropAcross() {
    if (!across) return;
    across = false;
    regDo(async () => {
      if (across) return;                              // se volvió a pedir antes de llegar aquí
      const r = reg;
      reg = { session: null, src: '', snap: '', sig: '' };
      if (!r.session || cdp.session !== r.session) return;
      await removeScript(r.snap); await removeScript(r.src);
    });
  }

  function schedule() {
    if (muted) return;
    shown = true;
    if (!batchT) batchT = setTimeout(flush, batchMs);
  }
  /**
   * @param {boolean} [retry] la llamada corta dijo que la página no tiene la capa
   * @param {Snap | null} [first] foto que va en vez de la de ahora (cambio de pestaña: la última que se vio, con `tab`)
   * @returns {Promise<void>} cuando la página ya la tiene (o falló)
   */
  function flush(retry, first = null) {
    batchT = null;
    if (tabbing && !first) { batchT = setTimeout(flush, batchMs); return Promise.resolve(); }
    if (!cdp.session) return Promise.resolve();
    const l = look();
    const inj = !injected || retry === true;
    const s = inj ? src() : '';
    if (inj && !s) return Promise.resolve();
    const enter = restoreNext || retry === true ? 'restore' : 'open';   // el reintento es por una página nueva sin aviso
    const snap = first || payload(l, enter);
    const expr = `(()=>{${s ? s + '\n;' : ''}if(!window.TVAgent)return false;window.TVAgent.render(${JSON.stringify(snap)});${dimOn(snap.form)};return true})()`;
    if (inj) injected = true;
    painted = true;
    restoreNext = false;
    // el documento siguiente se restaura con lo mismo que se ve ahora (tinte incluido: ni el ancho ni el velo saltan al
    // cambiar de documento); la foto siguiente ya trae el de la página nueva y la membrana va a él con sus muelles
    seen = first ? { ...first } : /** @type {Snap} */ (payload(l, 'restore'));
    delete seen.tab; delete seen.shown;                 // lo que se ve; `tab` y `shown` son solo de la llamada del cambio
    keepAcross(seen);
    const nav = navSeq;
    return cdp.call('Runtime.evaluate', { expression: expr, returnByValue: true }).then(r => {
      const v = r?.result?.value;
      if (v === true && nav !== paintedSeq) whenPainted(nav);  // la capa ya está en la página nueva
      if (v === true && !inj) retried = false;
      if (v !== false || inj || retried) return;
      retried = true; // página nueva sin aviso: se repite ya con la fuente, una sola vez
      if (shown) flush(true);
    }).catch(() => { injected = false; });
  }
  /**
   * Espera (en la página) a que la página nueva esté pintada; entonces se mira el formato. Una pestaña en blanco
   * (about:blank mientras carga la de verdad) no es la página nueva: ni se sondea ni cuenta; la pintada llega con la
   * navegación siguiente (reset). Si la sonda falla sin navegación por medio, se repite (PAINT_RETRIES); si ve aún la
   * pestaña en blanco con la URL nueva ya dicha, se vuelve a mirar (BLANK_RETRIES).
   * @param {number} nav @param {number} [fails] @param {number} [blanks]
   */
  function whenPainted(nav, fails = 0, blanks = 0) {
    const sid = cdp.session, page = look().page;
    if (page && BLANK_RE.test(page.url)) return;
    const stale = () => nav !== navSeq || cdp.session !== sid || nav === paintedSeq;   // otra navegación por medio: manda la suya
    const again = (/** @type {number} */ f, /** @type {number} */ b) => setTimeout(() => { if (!stale()) whenPainted(nav, f, b); }, PAINT_EVERY_MS);
    cdp.call('Runtime.evaluate', { expression: PAINT_PROBE, awaitPromise: true, returnByValue: true }).then(r => {
      if (stale()) return;
      const v = r?.result?.value;
      if (v === PAINT_BLANK) { if (blanks < BLANK_RETRIES) again(fails, blanks + 1); return; }
      paintedSeq = nav; paints++; weak = v === false;
      if (visible()) follow(morphDelayMs);                                    // sin paso pendiente y esperando: a cerrar
    }, () => { if (!stale() && fails < PAINT_RETRIES) again(fails + 1, blanks); });
  }
  function hide() {
    hideT = null;
    clearTimeout(batchT); batchT = null;
    clearTimeout(morphT); morphT = null;
    const was = painted && shown;
    shown = false; awaiting = false;
    dropAcross();
    if (was) emitForm(false);
    try { hidden(); } catch (e) { log('conversación: ' + e.message); }
    if (!cdp.session) return;
    cdp.call('Runtime.evaluate', { expression: HIDE }).catch(() => {});
  }
  /** @param {'island' | 'panel'} m @param {boolean} [voice] */
  function begin(m, voice) {
    clearTimeout(hideT); hideT = null;
    clearTimeout(morphT); morphT = null;
    morphed = false; awaiting = false; waited = false; opening = new Set(); openMark = -1; navOpened = false;
    settleTools(cur);                                   // interrumpido sin done: lo archivado no gira
    if (said(cur)) history = [...history, cur].slice(-KEEP_TURNS); // un turno cancelado sin nada no se guarda
    cur = newTurn(++seq);
    spoken = null;                                      // la de la respuesta anterior ya no vale
    mode = m === 'island' ? 'island' : 'panel';
    state = voice ? 'listen' : 'think';
    live = true; open = true;
  }
  function end() {
    live = false; open = false;
    settleTools(cur);
    state = failed(cur) ? 'error' : 'done';
    if (muted) return;
    schedule();
    clearTimeout(hideT);
    doneAt = Date.now();
    // abrió algo y la página nueva aún no está pintada (o su paso a píldora está en el respiro): el cierre espera
    const opened = navOpened || cur.tools.some(x => opening.has(x.id) && x.status !== 'fail');
    waited = opened;
    awaiting = opened && (paints === openMark || navSeq !== paintedSeq || !!morphT);
    hideT = setTimeout(hide, awaiting ? Math.max(awaitMs, closeMs()) : mode === 'island' && morphed ? pillDwell() : closeMs());
  }
  const closeMs = () => CLOSE_BASE_MS + CLOSE_PER_CHAR_MS * cur.jota.length;
  const pillDwell = () => pillBaseMs + PILL_DWELL_PER_CHAR_MS * cur.jota.length;
  /** Acaba la espera a la página: lo que quede del cierre normal (contado desde el fin), y al menos AFTER_PAINT_MIN_MS. */
  function settleWait() {
    awaiting = false;
    clearTimeout(hideT);
    hideT = setTimeout(hide, Math.max(afterPaintMs, doneAt + closeMs() - Date.now()));
  }
  /**
   * Una navegación (o cambio de pestaña) con el turno ya acabado que abrió algo, con la espera en curso o vencida (la
   * pintada fue el tope de la sonda, no contenido): la espera se vuelve a armar (AWAIT_PAGE_MS desde ahora) y el cierre
   * contará AFTER_PAINT_MIN_MS desde la pintada de esta. Con la página ya pintada de verdad (p. ej. pushState dentro de
   * la app) no se toca el cierre.
   */
  function rearm() {
    if (open || !waited || muted || !shown || !(awaiting || weak)) return;
    awaiting = true;
    clearTimeout(hideT); hideT = setTimeout(hide, awaitMs);
  }
  /** ¿la capa está (o va a estar) a la vista? */
  const visible = () => shown && !muted;
  const formNow = () => /** @type {'pill' | 'panel'} */ (mode === 'island' ? 'pill' : 'panel');
  /** Avisa del formato (talk.js se lo dice al móvil). @param {boolean} canSwitch */
  function emitForm(canSwitch) { try { formFn(formNow(), canSwitch); } catch (e) { log('conversación: ' + e.message); } }

  /** Clave del contenido de la página actual (alcance del override y de lo que pidió Jota). @param {Look} l */
  const keyOf = l => (l.page ? contentKey({ ...l.page, hosts: contentHosts }) : '');
  /**
   * Formato que toca ahora (agent-form.js) con el override y lo de Jota que valgan para esta página. Olvida el override de
   * otro contenido y lo de Jota en cuanto se sale del sitio que abrió (o si no se llega a él en AGENT_LAYOUT_TTL_MS).
   * @param {Look} l
   */
  function decide(l) {
    const key = keyOf(l);
    if (override && override.key !== key) override = null;
    if (pick && !pick.reached && Date.now() - pick.at > AGENT_LAYOUT_TTL_MS) pick = null;   // no se llegó a abrir
    if (pick) {
      if (pick.key === key) pick.reached = true;
      else if (pick.reached) pick = null;                                                   // se salió de ese sitio
    }
    return decideForm({ ...(l.page || {}), playback: l.playback === true, override: override && override.form,
      agentLayout: pick && pick.reached ? pick.form : null, hosts: contentHosts });
  }
  /** Modo al que hay que ir ahora, o null si nada cambia: lo automático solo va de panel a píldora. */
  function wanted() {
    const l = look();
    if (!l.page && l.playback === null) return null;
    const d = decide(l), m = d.form === 'pill' ? 'island' : 'panel';
    if (m === mode || (m === 'panel' && !FORCED_SOURCES.includes(d.by))) return null;
    return m;
  }
  /** La página que abrió el turno ya está pintada (y no hay otra navegación por pintar). */
  const pageIn = () => navSeq === paintedSeq && paints !== openMark;
  /** Vuelve a mirar el formato con la capa a la vista; el cambio va tras `delay` ms (0: ya). Si no queda ningún paso
   *  pendiente y el turno esperaba a una página que ya está pintada, a cerrar (un paso cancelado en el respiro, p. ej.
   *  porque se pausó, no deja la espera colgada hasta AWAIT_PAGE_MS). @param {number} delay */
  function follow(delay) {
    clearTimeout(morphT); morphT = null;
    if (visible() && wanted()) {
      if (delay <= 0) return reform();
      morphT = setTimeout(() => {
        morphT = null;
        if (visible()) reform(); else if (awaiting && pageIn()) settleWait();
      }, delay);
      return;
    }
    if (awaiting && pageIn()) settleWait();
  }
  /** Cambia al formato que toque (si aún toca). Con el turno ya acabado: píldora automática → PILL_DWELL; si lo pidió
   *  el usuario o Jota, el cierre normal desde ahora. */
  function reform() {
    const m = wanted();
    if (!m) { if (awaiting) settleWait(); return; }
    const by = decide(look()).by;
    mode = m;
    morphed = m === 'island' && !FORCED_SOURCES.includes(by);
    if (!open && !muted) { awaiting = false; clearTimeout(hideT); hideT = setTimeout(hide, morphed ? pillDwell() : closeMs()); }
    emitForm(true);
    schedule();
  }
  /** Estado tras algo que avanza el turno, salvo si ya falló (el orbe se queda en error hasta que se despeje). @param {State} s */
  function advance(s) { if (state !== 'error') state = s; }
  /** Una herramienta acabó bien tras el fallo de otra: sin pista y el orbe vuelve a lo que toque (el error de error() no se despeja). */
  function recover() {
    if (!RECOVER_ON_OK || cur.error || !cur.hint) return;
    cur.hint = '';
    state = cur.jota ? 'talk' : 'think';
  }

  /**
   * El usuario pide otro formato (orden talkform del mando o arrastre en la tele): vale para el contenido actual
   * (OVERRIDE_SCOPE) y se aplica ya, en los dos sentidos. Solo con la capa a la vista.
   * @param {any} form 'pill' | 'panel' @returns {{ ok: 1, form: 'pill' | 'panel' } | { error: string }}
   */
  function userForm(form) {
    const f = cleanForm(form);
    if (!f) return { error: 'formato no válido' };
    if (!visible()) return { error: NO_LAYER };
    override = { form: f, key: keyOf(look()) };
    follow(0);
    return { ok: 1, form: formNow() };
  }

  return {
    /** @param {'island' | 'panel'} m @param {{ voice?: boolean }} [o] por voz empieza escuchando; escrito, pensando.
     * El formato lo decide la página (decideForm, sin la regla de un solo sentido: un turno nuevo en el reposo o en
     * una web vuelve al panel); sin página ni `playback` en context(), el modo de talk.js. */
    turn(m, o) {
      muted = false;
      const l = look(), decided = l.page || l.playback !== null;
      begin(decided ? (decide(l).form === 'pill' ? 'island' : 'panel') : m, !!(o && o.voice));
      schedule();
      emitForm(true);
    },
    /** Nivel de tu voz (dBFS de un trozo de 100 ms) mientras escucha: el orbe de la tele lo sigue. Sin foto (ni la
     *  conversación a la vista) o con uno aún en vuelo, se salta: el siguiente llega en 100 ms. @param {number} db */
    level(db) {
      if (state !== 'listen' || !painted || !visible() || levelBusy || !cdp.session) return;
      levelBusy = true;
      const lv = Math.max(0, Math.min(1, (db + LEVEL_FLOOR_DB) / LEVEL_RANGE_DB));
      cdp.call('Runtime.evaluate', { expression: `window.TVAgent&&window.TVAgent.level&&window.TVAgent.level(${lv.toFixed(2)})` })
        .catch(() => {}).finally(() => { levelBusy = false; });
    },
    /** @param {string} text frase acumulada (sustituye a la anterior) @param {boolean} final */
    you(text, final) {
      if (!open) begin(mode);
      const was = cur.youFinal;
      cur.you = String(text || ''); cur.youFinal = !!final;
      if (final && !was && onAsk) { try { onAsk(cur.you); } catch (e) { log('conversación: ' + e.message); } }
      if (final && state === 'listen') state = 'think';
      schedule();
    },
    /** @param {string} text respuesta acumulada */
    jota(text) {
      if (!open) begin(mode);
      cur.jota = String(text || '');
      if (cur.jota && (state === 'listen' || state === 'think')) state = 'talk';   // el primer token
      schedule();
    },
    /** Voz sincronizada de la respuesta del turno actual (talk.js), o null: sin voz, o se acabó o se cortó (todo a la
     * vista). Va en la foto siguiente con la cabeza al día. @param {any} v */
    voice(v) {
      const c = cleanVoice(v);
      if (!c && !spoken) return;
      spoken = c && { ...c, at: Date.now() };
      schedule();
    },
    /** Ficha de una herramienta que empieza (mismo id: se actualiza); `opens`: pone otra página en la tele.
     * @param {{ id: string, kind: string, title: string, detail: string, opens?: boolean }} c */
    tool(c) {
      if (!open || !c || !KINDS[c.kind]) return;
      if (c.opens === true) { opening.add(String(c.id)); openMark = paints; }
      const t = { id: String(c.id), kind: c.kind, title: String(c.title || ''), detail: String(c.detail || ''), status: /** @type {'run'} */ ('run') };
      const i = cur.tools.findIndex(x => x.id === t.id);
      if (i >= 0) cur.tools[i] = t; else cur.tools.push(t);
      advance('think');
      schedule();
    },
    /**
     * Tarjeta de contenido en el turno en curso (con el panel a la vista: en la píldora no cabe y no se pone).
     * Devuelve si se puso: quien la pone puede esperar a que se vea antes de seguir (el ▶ antes de abrir Netflix).
     * @param {any} m ver Media
     */
    media(m) {
      const c = cleanMedia(m), l = look();
      if (!c || !open || muted || formNow() !== 'panel') return false;
      // las imágenes solo sobre una página nuestra (el reposo): la CSP de una web ajena las bloquearía (y ensuciaría su
      // consola); allí la tarjeta va sin ellas, con su texto y su progreso
      cur.media = ourPage(l) ? c : noImages(c);
      schedule();
      return true;
    },
    /** Lo que se ha preguntado en el turno en curso ('' si no hay): para afinar su tarjeta (¿nombra una serie?). */
    asked() { return open ? cur.you : ''; },
    /** Estado de la tarjeta del turno ('press': se pulsa su ▶). @param {'idle' | 'press'} st */
    mediaState(st) {
      if (!cur.media || (st !== 'idle' && st !== 'press')) return;
      cur.media = { ...cur.media, state: st };
      schedule();
    },
    /** Fin de una herramienta con ficha; si falló, pista de reintento y orbe en error. @param {{ id: string, ok: boolean }} e */
    toolEnd(e) {
      const t = e && cur.tools.find(x => x.id === String(e.id));
      if (!t) return;
      t.status = e.ok ? 'ok' : 'fail';
      if (!e.ok) { cur.hint = RETRY_HINT; state = 'error'; } else recover();
      schedule();
    },
    done() { end(); },
    /** @param {string} text va en el hueco de la respuesta (sin turn() abierto, en un intercambio nuevo con el último formato) */
    error(text) { if (!open) begin(mode); cur.jota = String(text || ''); cur.error = true; end(); },
    /** Quita la capa ya (Parar, Quitar de la tele): sin esperar al cierre. */
    hide() { clearTimeout(hideT); live = false; muted = true; settleTools(cur); hide(); },
    /** Empezó (true) o acabó (false) una reproducción de verdad (page-poll; context().playback ya lo dice). Con la capa
     * a la vista en panel, se vuelve a mirar el formato (reserva: vídeo grande → píldora tras
     * MORPH_DELAY_MS); pausar nunca vuelve al panel ni reabre nada, y en el respiro cancela el paso si ya no toca.
     * @param {boolean} on */
    playback(on) {
      if (on && morphT) return;                       // el paso ya está en camino
      follow(morphDelayMs);
    },
    userForm,
    /** Aviso del binding de la página (arrastre con el puntero de la tele): solo 'pill' o 'panel', y no más seguido que
     *  BINDING_GAP_MS. La web también podría llamarlo: como mucho cambia el formato de la capa. @param {any} payload */
    fromPage(payload) {
      const now = Date.now();
      if (now - bindingAt < BINDING_GAP_MS || !cleanForm(payload)) return;
      bindingAt = now;
      userForm(payload);
    },
    /** El servidor va a navegar (control.nav): con un turno en curso, el cierre esperará a que la página nueva esté pintada. */
    navigating() { if (open) { navOpened = true; openMark = paints; } },
    /**
     * Jota pide un formato para la página que abre (tv_open / tv_open_app con `layout`): vale en cuanto se llega a esa
     * página y mientras se siga en ese sitio. Si ya se está en él, se aplica tras el respiro.
     * @param {any} layout 'pill' | 'panel' @param {string} url la que se abre (ya normalizada)
     */
    agentLayout(layout, url) {
      const f = cleanForm(layout);
      if (!f) return;
      pick = { form: f, key: contentKey({ url, hosts: contentHosts }), at: Date.now(), reached: false };
      if (visible()) follow(morphDelayMs);
    },
    /** @param {(form: 'pill' | 'panel', canSwitch: boolean) => void} fn formato de la capa: al empezar el turno,
     *  en cada cambio y al cerrarse (canSwitch false) */
    onForm(fn) { formFn = fn; },
    /** Formato de la capa ahora y si se puede cambiar (para pruebas y para el mando). */
    form() { return { form: formNow(), canSwitch: visible() }; },
    /** ¿Hay que vigilar la reproducción? (la capa está a la vista: page-poll sondea aunque no haya mandos) */
    watching() { return visible(); },
    /** Esperando a que se pinte la página que abrió el turno (para pruebas y registro). */
    awaiting() { return awaiting; },
    /**
     * cdp.show ya trajo otra pestaña al frente: la capa de la que se deja se quita en seco (sin fundido; ya no se ve y,
     * al volver, se restaura de cero). `call` va a la sesión de esa pestaña, aún enganchada.
     * @param {(method: string, params?: object) => Promise<any>} call
     */
    leave(call) {
      if (!painted) return;
      return call('Runtime.evaluate', { expression: LEAVE_HIDE }).catch(() => {});
    },
    /** @param {() => void} fn se llama cada vez que la capa se oculta (por tiempo o con hide) */
    onHide(fn) { hidden = fn; },
    /**
     * La pestaña cambió (navegación, otra pestaña, CDP reconectado): la próxima llamada lleva la fuente. `tab` (onAttached:
     * otra pestaña enganchada): con la capa a la vista se pinta ya, con la última foto que se vio (ver arriba), y se
     * devuelve la promesa de esa llamada (cdp.show la espera antes de traer la pestaña al frente).
     * @param {{ tab?: boolean, from?: ((method: string, params?: object) => Promise<any>) | null }} [o] `from`: llamada a la
     *   pestaña que se deja (cdp.show), para saber qué enseña ya @returns {Promise<void> | undefined}
     */
    reset(o = {}) {
      injected = false; retried = false;
      decide(look());                                 // el override y lo de Jota se olvidan al salir de su contenido
      if (shown && !muted) {
        restoreNext = true; navSeq++;
        rearm();
        if (!o.tab) { schedule(); return; }
        clearTimeout(batchT); batchT = null;
        if (!seen) return flush();
        const base = seen, nav = navSeq;
        /** @param {any} said */
        const go = said => {
          const sh = cleanShown(said);
          const p = flush(false, /** @type {Snap} */ ({ ...base, tab: true, ...(sh ? { shown: sh } : {}) }));
          schedule();                                 // la de ahora, con el tinte de esta pestaña, en la tanda siguiente
          return p;
        };
        if (!o.from) return go(null);
        tabbing = nav;
        const read = o.from('Runtime.evaluate', { expression: REVEALED, returnByValue: true }).then(r => r?.result?.value ?? null, () => null);
        return within(read, FROM_WAIT_MS).then(said => {
          if (tabbing !== nav) return;                // otro cambio por medio: manda el suyo
          tabbing = 0;
          if (nav !== navSeq || !shown || muted) return;  // otra navegación (su tanda lleva la foto) o ya cerrada
          return go(said);
        });
      }
      // cerrada: la página a la que se llega puede tener aún una capa pintada. O es un documento nuevo que el script de
      // documento nuevo llegó a restaurar antes de quitarse, o es otra pestaña que se dejó detrás con la capa a la vista
      // (Netflix va en la suya y se vuelve a la de siempre): se quita, por si acaso
      if (!shown && painted && cdp.session) cdp.call('Runtime.evaluate', { expression: HIDE }).catch(() => {});
    },
  };
}

module.exports = { createTalkView, snapshot, cleanVoice, VOICE_ANCHORS_MAX, HIDE, KEEP_TURNS, CLOSE_BASE_MS, CLOSE_PER_CHAR_MS, RETRY_HINT, RECOVER_ON_OK, SETTLED_STATUS,
  AWAIT_PAGE_MS, AFTER_PAINT_MIN_MS, PAINT_WAIT_MS, PAINT_BLANK, BLANK_RE, LEAVE_HIDE, PAINT_GRID, PAINT_MIN_POINTS, PAINT_EVERY_MS, MORPH_DELAY_MS, BINDING_GAP_MS, NO_LAYER, PAINT_PROBE, paintProbe, PILL_DWELL_BASE_MS, PILL_DWELL_PER_CHAR_MS, RESTORE_GLOBAL };
