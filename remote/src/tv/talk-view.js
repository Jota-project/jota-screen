'use strict';
// @ts-check
// Capa de la conversación en la tele: lo que dices y lo que contesta Jota, en directo, encima de cualquier página.
// Dos formatos, fijados al empezar el turno: `island` (hay vídeo: arriba en el centro, solo la frase y la respuesta) y
// `panel` (columna a la derecha con las últimas `keep` frases). La página recibe public/tv-talk.js una sola vez: la
// primera llamada lleva la fuente (con los tokens delante, src/tv/tokens.js) y las siguientes solo `TVTalk.render(…)`.
// Si la página cambia, la llamada corta devuelve false (no hay TVTalk) y se repite al momento con la fuente; server.js
// también avisa con reset() al navegar o al cambiar de pestaña. Ese reintento es uno por página (hasta reset o un render
// bueno): una web donde TVTalk no llega a existir no recibe la fuente entera cada 100 ms. Se oculta `hideMs` después de done o error,
// o al momento con hide() (y entonces nada de ese turno la vuelve a sacar hasta el turn() siguiente); onHide avisa de cada ocultación.
//
// Diseño nuevo (interruptor `design:'v2'` de `context()`, leído en cada flush): la misma conversación va a public/tv-agent.js
// como una foto completa (`Snap`, ver docs/arquitectura.md) con el estado del orbe derivado aquí, los 2 últimos turnos
// (también en la píldora, que solo enseña el último), las fichas de herramientas y sus iconos. Al cambiar de diseño se reinyecta y se oculta la
// capa del otro en la misma llamada. Se cierra `CLOSE_BASE_MS + CLOSE_PER_CHAR_MS × letras de la respuesta` tras el fin.
// Formato (ronda 3): lo decide agent-form.js (`decideForm`) con la página de context(): override del usuario, lo que pidió
// Jota (`agentLayout`), app de contenido o escenario → píldora, vídeo grande en marcha → píldora, y si no, panel. Se fija
// al empezar el turno y se vuelve a mirar cuando una página nueva ya está PINTADA (tras navegar), cuando cambia la
// reproducción (`playback`, de page-poll) y cuando el usuario arrastra (`userForm`, orden talkform o binding de la página).
// Lo automático es de un solo sentido (panel → píldora, tras `MORPH_DELAY_MS`); a panel solo vuelve el usuario o Jota.
// El tinte (`ctx`) sigue a la página en cada foto. Un turno con una ficha que abre algo (`opens`, de agent-ui.js) no se
// cierra mientras la página nueva no enseñe su contenido (y transformada, si toca): espera como mucho `AWAIT_PAGE_MS`.
// Navegar mata la capa (documento nuevo): mientras se ve, la fuente y la última foto van también como script de documento
// nuevo (Page.addScriptToEvaluateOnNewDocument), así la página siguiente la pinta en cuanto existe, en modo `restore`
// (en su caja, sin animación de entrada). Se quitan al ocultarla o al pasar al diseño viejo.
const { talkSource, agentSource } = require('./tokens');
const { KINDS } = require('../features/agent-ui');
const { CTXS, GLASS, COLOR_RE, FORM_BINDING, HOST_ID } = require('./agent-contract');
const { CONTENT_HOSTS, AGENT_LAYOUT_TTL_MS, FORCED_SOURCES, cleanForm, contentKey, decideForm } = require('./agent-form');

const DIM_ON = 'window.TVIsland&&window.TVIsland.dim(0)';
// la isla de actividades vuelve a 1 aunque hide falle
const HIDE = 'try{window.TVTalk&&window.TVTalk.hide()}finally{window.TVIsland&&window.TVIsland.dim(1)}';
const HIDE_V2 = 'try{window.TVAgent&&window.TVAgent.hide()}finally{window.TVIsland&&window.TVIsland.dim(1)}';

const KEEP_TURNS = 2;                        // turnos en el panel del diseño nuevo (el anterior, atenuado)
const CLOSE_BASE_MS = 4000;                  // diseño nuevo: se cierra esto tras el fin real…
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
/**
 * Corre EN LA PÁGINA (se serializa): se resuelve cuando la página nueva ya enseña su contenido (ver arriba).
 * @param {{ wait: number, grid: number, min: number, every: number, host: string }} o
 * @returns {Promise<boolean>} false si venció el tope
 */
function paintProbe(o) {
  return new Promise(res => {
    let done = false, iv = /** @type {any} */ (0);
    const stop = () => { done = true; clearInterval(iv); clearTimeout(cap); };
    const cap = setTimeout(() => { if (!done) { stop(); res(false); } }, o.wait);
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
      requestAnimationFrame(() => requestAnimationFrame(() => res(true)));
    };
    const start = () => { look(); if (!done) iv = setInterval(look, o.every); };
    if (performance.getEntriesByType('paint').length) return start();
    try { new PerformanceObserver((l, ob) => { ob.disconnect(); start(); }).observe({ type: 'paint' }); } catch { start(); }
  });
}
const PAINT_PROBE = `(${paintProbe})(${JSON.stringify({ wait: PAINT_WAIT_MS, grid: PAINT_GRID, min: PAINT_MIN_POINTS, every: PAINT_EVERY_MS, host: HOST_ID })})`;
const RESTORE_GUARD_MS = 3000;               // una navegación justo tras cerrar puede restaurar la capa: se vuelve a quitar
const RESTORE_GLOBAL = '__tvAgentRestore';   // global de la página con la última foto (la lee la fuente al cargarse)

const DESIGNS = ['v1', 'v2'];

/** Lo que cambia entre diseños: la variable global de la página, su fuente y cómo se oculta. */
const LAYERS = {
  v1: { global: 'TVTalk', source: talkSource, hide: HIDE },
  v2: { global: 'TVAgent', source: agentSource, hide: HIDE_V2 },
};
/** Oculta la capa de un diseño sin tocar la isla (al cambiar de diseño, antes de pintar el otro). @param {'v1' | 'v2'} d */
const hideOnly = d => `try{window.${LAYERS[d].global}&&window.${LAYERS[d].global}.hide()}catch(e){};`;

/** @typedef {'listen' | 'think' | 'talk' | 'error' | 'done'} State */
/** @typedef {{ id: string, kind: string, title: string, detail: string, status: 'run' | 'ok' | 'fail' }} Tool */
/** @typedef {{ id: number, you: string, youFinal: boolean, jota: string, tools: Tool[], error: boolean, hint: string }} Turn */
/** playback: hay una reproducción de verdad (page-poll); null si context() no lo dice. page: la página de la tele
 * (`url`, `stage` = tipo de escenario o null, `idle` = el reposo) para decidir el formato; null si context() no la trae
 * (y sin playback ni página, manda el modo de talk.js)
 * @typedef {{ url: string, stage: string | null, idle: boolean }} Page
 * @typedef {{ design: 'v1' | 'v2', ctx: string | null, night: boolean, calm: boolean, glass: string, colors: [string, string] | null,
 *   playback: boolean | null, page: Page | null }} Look */
/**
 * Foto que recibe `TVAgent.render` (diseño nuevo). `enter`: 'open' normal; 'restore' en un documento nuevo (tras navegar).
 * @typedef {{ form: 'pill' | 'panel', ctx: string, state: State, live: boolean, night: boolean, calm: boolean, glass: string,
 *   colors: [string, string] | null, turns: Turn[], icons: Record<string, any>, enter: 'open' | 'restore' }} Snap
 */

/** Sin `context()`: el diseño viejo y nada más. @type {Look} */
const V1_LOOK = Object.freeze({ design: 'v1', ctx: null, night: false, calm: false, glass: 'auto', colors: null, playback: null, page: null });
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
  if (!c || typeof c !== 'object') return V1_LOOK;
  return {
    design: DESIGNS.includes(c.design) ? c.design : 'v1',
    ctx: CTXS.includes(c.ctx) ? c.ctx : null,
    night: c.night === true, calm: c.calm === true,
    glass: GLASS.includes(c.glass) ? c.glass : 'auto',
    colors: cleanColors(c.colors),
    playback: typeof c.playback === 'boolean' ? c.playback : null,
    page: cleanPage(c.page),
  };
}

/** @param {number} id @returns {Turn} */
const newTurn = id => ({ id, you: '', youFinal: false, jota: '', tools: [], error: false, hint: '' });
/** Un turno que algo dijo o hizo (uno cancelado sin nada no se guarda). @param {Turn} t */
const said = t => !!(t.you || t.jota || t.tools.length);
/** El turno salió mal: error en la respuesta o un fallo de herramienta sin despejar (la pista lo marca). @param {Turn} t */
const failed = t => t.error || !!t.hint;
/** Las fichas que siguen girando al cerrar o archivar el turno pasan a SETTLED_STATUS (no cuentan como fallo). @param {Turn} t */
function settleTools(t) { for (const x of t.tools) if (x.status === 'run') x.status = SETTLED_STATUS; }

/**
 * Foto del diseño nuevo a partir de los turnos guardados (el último, el actual). Pura: la prueban las pruebas. Lleva los
 * KEEP_TURNS últimos también en la píldora (la página solo enseña el último): así el log no cambia en el mismo frame en
 * que cambia la forma, y el turno anterior se pliega o reaparece con el contenido ya oculto (en el viaje del paso).
 * @param {{ form: 'pill' | 'panel', ctx: string, state: State, live: boolean, look: Look, turns: Turn[], enter?: 'open' | 'restore' }} o
 * @returns {Snap}
 */
function snapshot({ form, ctx, state, live, look, turns, enter = 'open' }) {
  const shown = turns.slice(-KEEP_TURNS).map(t => ({ ...t, tools: t.tools.map(x => ({ ...x })) }));
  /** @type {Record<string, any>} */ const icons = {};
  for (const t of shown) for (const x of t.tools) if (KINDS[x.kind]) icons[x.kind] = KINDS[x.kind].icon;
  return { form, ctx, state, live, night: look.night, calm: look.calm, glass: look.glass, colors: look.colors, turns: shown, icons, enter };
}

/** Script de documento nuevo con la fuente de la capa: al cargarse pinta la última foto, si ya llegó. Solo el marco
 * principal (los scripts de documento nuevo corren también en los iframes). @param {string} source */
const sourceScript = source => `(()=>{if(window.top!==window)return;${source}\n;var s=window.${RESTORE_GLOBAL};if(s&&window.TVAgent)window.TVAgent.render(s)})()`;
/** Script de documento nuevo con la última foto (en modo restore): la deja para la fuente o la pinta si ya está. @param {Snap} snap */
const snapScript = snap => `(()=>{if(window.top!==window)return;var s=${JSON.stringify(snap)};window.${RESTORE_GLOBAL}=s;if(window.TVAgent)window.TVAgent.render(s)})()`;

/**
 * @param {{ cdp: { session?: any, call: (method: string, params: object) => Promise<any> }, pub: string,
 *           batchMs?: number, hideMs?: number, keep?: number, log?: (msg: string) => void, context?: () => any,
 *           awaitMs?: number, morphDelayMs?: number, pillBaseMs?: number, afterPaintMs?: number,
 *           contentHosts?: readonly string[] }} deps
 *   contentHosts: apps de contenido (por defecto CONTENT_HOSTS; las pruebas añaden la suya)
 */
function createTalkView({ cdp, pub, batchMs = 100, hideMs = 5000, keep = 6, log = () => {}, context,
  awaitMs = AWAIT_PAGE_MS, morphDelayMs = MORPH_DELAY_MS, pillBaseMs = PILL_DWELL_BASE_MS, afterPaintMs = AFTER_PAINT_MIN_MS,
  contentHosts = CONTENT_HOSTS }) {
  /** Turnos ya cerrados (el panel viejo enseña sus frases; el nuevo, el último). @type {Turn[]} */
  let history = [];
  let seq = 0;
  let cur = newTurn(++seq);
  /** @type {'island' | 'panel'} */
  let mode = 'panel';
  /** @type {State} */
  let state = 'done';
  let live = false;
  let open = false;      // hay un intercambio en curso (entre turn y done/error)
  let shown = false;     // la capa está (o va a estar) en pantalla
  /** @type {'' | 'v1' | 'v2'} */
  let injected = '';     // diseño cuya capa tiene la página actual (según lo último que sabemos); '' ninguna
  /** @type {'' | 'v1' | 'v2'} */
  let painted = '';      // diseño de la última foto mandada (su capa es la que hay que quitar)
  let retried = false;   // ya se reenvió la fuente tras un render sin capa (una vez por página: hasta reset o un render bueno)
  let muted = false;     // quitada con hide(): lo que quede de ese turno no se pinta (hasta el turn() siguiente)
  let morphed = false;   // este intercambio pasó solo a píldora (página de contenido o vídeo): al acabar, PILL_DWELL
  let awaiting = false;  // turno acabado esperando a que la página que abrió esté pintada (el cierre no corre)
  let doneAt = 0;        // fin del turno (para contar el cierre normal desde ahí)
  let restoreNext = false; // la próxima foto va a un documento nuevo (tras reset): entra en modo restore
  let navSeq = 0, paintedSeq = 0; // navegaciones con la capa a la vista / la última ya pintada (distintas: falta pintar)
  let paints = 0;        // páginas nuevas pintadas con la capa encima (whenPainted)
  /** @type {Set<string>} */ let opening = new Set(); // fichas de este turno que ponen otra página
  let openMark = -1;     // `paints` cuando empezó la última de ellas (si sigue igual al acabar, la página no ha llegado)
  let navOpened = false; // el servidor navegó durante el turno (control.nav): cuenta como una ficha que abre, también sin
                         // eventos de herramienta del Gateway (tool_calls_enabled apagado)
  // formato pedido por el usuario (arrastre) para un contenido, y por Jota para la página que abre (`reached`: ya se llegó)
  /** @type {{ form: 'pill' | 'panel', key: string } | null} */ let override = null;
  /** @type {{ form: 'pill' | 'panel', key: string, at: number, reached: boolean } | null} */ let pick = null;
  let hiddenAt = -Infinity, bindingAt = -Infinity;
  /** @type {() => void} */ let hidden = () => {};
  /** @type {(form: 'pill' | 'panel', canSwitch: boolean) => void} */ let formFn = () => {};
  let batchT = null, hideT = null, morphT = null;
  let bound = /** @type {any} */ (null); // sesión CDP con el binding del arrastre ya puesto
  // scripts de documento nuevo (ids de la sesión CDP que los registró; otra sesión no los tiene y no hay que quitarlos)
  let across = false;    // deben estar (la capa v2 se ve)
  let reg = { session: /** @type {any} */ (null), src: '', snap: '', sig: '' };
  let regQ = Promise.resolve();

  /** @returns {Look} */
  function look() {
    if (!context) return V1_LOOK;
    try { return cleanLook(context()); } catch (e) { log('conversación: ' + e.message); return V1_LOOK; }
  }
  /** @param {'v1' | 'v2'} d */
  const src = d => { try { return LAYERS[d].source(pub); } catch (e) { log('conversación: ' + e.message); return ''; } };

  function lines() {
    if (mode === 'island') return [{ who: 'you', text: cur.you }, { who: 'jota', text: cur.jota }].filter(l => l.text);
    const all = [];
    for (const x of [...history, cur]) { if (x.you) all.push({ who: 'you', text: x.you }); if (x.jota) all.push({ who: 'jota', text: x.jota }); }
    return all.slice(-keep);
  }
  /** Lo que recibe render según el diseño (en v2 el tinte sigue a la página actual). @param {Look} l @param {'open' | 'restore'} [enter] */
  function payload(l, enter = 'open') {
    if (l.design === 'v1') return { mode, lines: lines(), live };
    const form = mode === 'island' ? 'pill' : 'panel';
    return snapshot({ form, ctx: l.ctx || (form === 'pill' ? 'video' : 'web'), state, live, look: l, turns: [...history, cur], enter });
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
        const s = src('v2');
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
  /** @param {boolean} [retry] la llamada corta dijo que la página no tiene la capa */
  function flush(retry) {
    batchT = null;
    if (!cdp.session) return;
    const l = look(), d = l.design, g = LAYERS[d].global;
    const inj = injected !== d || retry === true;
    const s = inj ? src(d) : '';
    if (inj && !s) return;
    const other = painted && painted !== d ? hideOnly(painted) : '';   // la capa del otro diseño se quita en la misma llamada
    const enter = restoreNext || retry === true ? 'restore' : 'open';   // el reintento es por una página nueva sin aviso
    const expr = `(()=>{${s ? s + '\n;' : ''}${other}if(!window.${g})return false;window.${g}.render(${JSON.stringify(payload(l, enter))});${DIM_ON};return true})()`;
    if (inj) injected = d;
    painted = d;
    restoreNext = false;
    // el documento siguiente se restaura con lo mismo que se ve ahora (tinte incluido: ni el ancho ni el velo saltan al
    // cambiar de documento); la foto siguiente ya trae el de la página nueva y la membrana va a él con sus muelles
    if (d === 'v2') keepAcross(/** @type {Snap} */ (payload(l, 'restore'))); else dropAcross();
    const nav = navSeq;
    cdp.call('Runtime.evaluate', { expression: expr, returnByValue: true }).then(r => {
      const v = r?.result?.value;
      if (v === true && d === 'v2' && nav !== paintedSeq) whenPainted(nav);  // la capa ya está en la página nueva
      if (v === true && !inj) retried = false;
      if (v !== false || inj || retried) return;
      retried = true; // página nueva sin aviso: se repite ya con la fuente, una sola vez
      if (shown) flush(true);
    }).catch(() => { injected = ''; });
  }
  /** Espera (en la página) a que la página nueva esté pintada; entonces se mira el formato. @param {number} nav */
  function whenPainted(nav) {
    const sid = cdp.session;
    cdp.call('Runtime.evaluate', { expression: PAINT_PROBE, awaitPromise: true, returnByValue: true }).catch(() => {}).then(() => {
      if (nav !== navSeq || cdp.session !== sid || nav === paintedSeq) return;   // otra navegación por medio: manda la suya
      paintedSeq = nav; paints++;
      if (visibleV2()) follow(morphDelayMs);                                    // sin paso pendiente y esperando: a cerrar
    });
  }
  function hide() {
    hideT = null;
    clearTimeout(batchT); batchT = null;
    clearTimeout(morphT); morphT = null;
    const wasV2 = painted === 'v2' && shown;
    shown = false; awaiting = false; hiddenAt = Date.now();
    dropAcross();
    if (wasV2) emitForm(false);
    try { hidden(); } catch (e) { log('conversación: ' + e.message); }
    if (!cdp.session) return;
    cdp.call('Runtime.evaluate', { expression: LAYERS[painted || 'v1'].hide }).catch(() => {});
  }
  /** @param {'island' | 'panel'} m @param {boolean} [voice] */
  function begin(m, voice) {
    clearTimeout(hideT); hideT = null;
    clearTimeout(morphT); morphT = null;
    morphed = false; awaiting = false; opening = new Set(); openMark = -1; navOpened = false;
    settleTools(cur);                                   // interrumpido sin done: lo archivado no gira
    if (said(cur)) history = [...history, cur].slice(-Math.max(keep, KEEP_TURNS)); // un turno cancelado sin nada no se guarda
    cur = newTurn(++seq);
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
    if (look().design !== 'v2') { hideT = setTimeout(hide, hideMs); return; }
    doneAt = Date.now();
    // abrió algo y la página nueva aún no está pintada (o su paso a píldora está en el respiro): el cierre espera
    const opened = navOpened || cur.tools.some(x => opening.has(x.id) && x.status !== 'fail');
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
  /** ¿la capa del diseño nuevo está (o va a estar) a la vista? */
  const visibleV2 = () => shown && !muted && look().design === 'v2';
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
    if (l.design !== 'v2' || (!l.page && l.playback === null)) return null;
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
    if (visibleV2() && wanted()) {
      if (delay <= 0) return reform();
      morphT = setTimeout(() => {
        morphT = null;
        if (visibleV2()) reform(); else if (awaiting && pageIn()) settleWait();
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
   * (OVERRIDE_SCOPE) y se aplica ya, en los dos sentidos. Solo con la capa del diseño nuevo a la vista.
   * @param {any} form 'pill' | 'panel' @returns {{ ok: 1, form: 'pill' | 'panel' } | { error: string }}
   */
  function userForm(form) {
    const f = cleanForm(form);
    if (!f) return { error: 'formato no válido' };
    if (!visibleV2()) return { error: NO_LAYER };
    override = { form: f, key: keyOf(look()) };
    follow(0);
    return { ok: 1, form: formNow() };
  }

  return {
    /** @param {'island' | 'panel'} m @param {{ voice?: boolean }} [o] por voz empieza escuchando; escrito, pensando.
     * En v2 el formato lo decide la página (decideForm, sin la regla de un solo sentido: un turno nuevo en el reposo o en
     * una web vuelve al panel); sin página ni `playback` en context(), el modo de talk.js. */
    turn(m, o) {
      muted = false;
      const l = look(), v2 = l.design === 'v2', decided = v2 && (l.page || l.playback !== null);
      begin(decided ? (decide(l).form === 'pill' ? 'island' : 'panel') : m, !!(o && o.voice));
      schedule();
      if (v2) emitForm(true);
    },
    /** @param {string} text frase acumulada (sustituye a la anterior) @param {boolean} final */
    you(text, final) {
      if (!open) begin(mode);
      cur.you = String(text || ''); cur.youFinal = !!final;
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
    /** Quita la capa ya (Parar, Quitar de la tele): sin esperar a hideMs. */
    hide() { clearTimeout(hideT); live = false; muted = true; settleTools(cur); hide(); },
    /** Empezó (true) o acabó (false) una reproducción de verdad (page-poll; context().playback ya lo dice). Con la capa
     * del diseño nuevo a la vista en panel, se vuelve a mirar el formato (reserva: vídeo grande → píldora tras
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
      if (visibleV2()) follow(morphDelayMs);
    },
    /** @param {(form: 'pill' | 'panel', canSwitch: boolean) => void} fn formato de la capa: al empezar el turno (v2),
     *  en cada cambio y al cerrarse (canSwitch false) */
    onForm(fn) { formFn = fn; },
    /** Formato de la capa ahora y si se puede cambiar (para pruebas y para el mando). */
    form() { return { form: formNow(), canSwitch: visibleV2() }; },
    /** ¿Hay que vigilar la reproducción? (la capa del diseño nuevo está a la vista: page-poll sondea aunque no haya mandos) */
    watching() { return visibleV2(); },
    /** Esperando a que se pinte la página que abrió el turno (para pruebas y registro). */
    awaiting() { return awaiting; },
    /** @param {() => void} fn se llama cada vez que la capa se oculta (por tiempo o con hide) */
    onHide(fn) { hidden = fn; },
    /** La pestaña cambió (navegación, otra pestaña, CDP reconectado): la próxima llamada lleva la fuente. */
    reset() {
      injected = ''; retried = false;
      decide(look());                                 // el override y lo de Jota se olvidan al salir de su contenido
      if (shown && !muted) { restoreNext = true; navSeq++; schedule(); return; }
      // recién cerrada: el script de documento nuevo pudo llegar a restaurarla antes de quitarse; se quita otra vez
      if (!shown && painted === 'v2' && cdp.session && Date.now() - hiddenAt < RESTORE_GUARD_MS) cdp.call('Runtime.evaluate', { expression: HIDE_V2 }).catch(() => {});
    },
  };
}

module.exports = { createTalkView, snapshot, HIDE, HIDE_V2, KEEP_TURNS, CLOSE_BASE_MS, CLOSE_PER_CHAR_MS, RETRY_HINT, RECOVER_ON_OK, SETTLED_STATUS,
  AWAIT_PAGE_MS, AFTER_PAINT_MIN_MS, PAINT_WAIT_MS, PAINT_GRID, PAINT_MIN_POINTS, PAINT_EVERY_MS, MORPH_DELAY_MS, BINDING_GAP_MS, NO_LAYER, PAINT_PROBE, paintProbe, PILL_DWELL_BASE_MS, PILL_DWELL_PER_CHAR_MS, RESTORE_GUARD_MS, RESTORE_GLOBAL };
