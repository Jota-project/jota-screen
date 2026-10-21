// Conversación con Jota en la tele, diseño nuevo («paneles vivos»): una lámina de cristal que crece con lo que se dice,
// encima de cualquier web (también a pantalla completa). La inyecta el servidor por CDP una vez por página
// (src/tv/talk-view.js, design 'v2') y luego llama a render(SNAP) cada ~100 ms y a hide(). SNAP: ver docs/arquitectura.md.
// Dos formatos, los decide el servidor (src/tv/agent-form.js): `panel` (columna a la derecha con los 2 últimos turnos y las
// fichas de las herramientas) y `pill` (se ve contenido: arriba en el centro, solo el último turno). Si cambia con la capa
// abierta, aquí se transforma en cualquiera de los dos sentidos (MORPH: el contenido sale, la membrana viaja con sus muelles
// a la caja nueva, el orbe la acompaña con FLIP y entra el contenido en su forma nueva).
// Arrastre con el puntero de la tele (el ratón de verdad, que mueve el trackpad del mando): SOLO la membrana visible
// recibe el puntero (el resto de la capa no captura nada). Píldora arrastrada hacia la derecha → panel; panel arrastrado
// hacia el centro o hacia arriba → píldora. Mientras se arrastra, el contenido y la membrana siguen al dedo con resistencia
// (goma, que nunca saca la caja del área segura); al soltar encajan con los muelles en uno de los dos destinos (nunca
// libre) y se avisa al servidor por el binding de CDP __tvAgentForm (el mismo camino que la orden talkform del mando).
// Los eventos del puntero sobre la membrana no SUBEN a la web (stopPropagation): sus oyentes normales no los ven, pero uno
// en fase de captura en document o window sí (con #__tvagent de destino). A pantalla completa de un elemento (un <div>,
// como YouTube o Netflix) el host se mete dentro de él: lo de fuera queda inerte y la membrana no recibiría el puntero.
// Con un <video> a pantalla completa no hay sitio dentro: la capa se ve (capa superior) pero no se arrastra.
// Tras una navegación (documento nuevo) el servidor la repinta con `enter:'restore'` desde un script de documento nuevo:
// en su caja, sin animación de entrada, con lo ya dicho a la vista. Las animaciones de entrada que ya acabaron se marcan
// (.sd) para que mover el host o sacarlo y volverlo a meter en la capa superior no las repita.
// Fuentes: las suyas (FontFace desde los bytes de __TV_FONTS, con nombre propio), igual en el reposo que en cualquier web.
// Reglas de la capa:
// - Como tv-island.js: shadow DOM, solo createElement/createElementNS/textContent (Trusted Types) y estilos en una hoja
//   construida (la CSP del reposo bloquea <style>); los tokens de Jota Dusk llegan en __TV_TOKENS.
// - render() hace un diff por clave (turn.id, índice de palabra, tool.id): lo que ya está no se recrea, así las animaciones
//   de entrada no se reinician con cada foto.
// - Un solo requestAnimationFrame: primero LEE (cajas) y luego ESCRIBE (geometría y radios del cristal); se para cuando la
//   membrana está asentada (abierta y quieta, o ya cerrada) y lo despiertan una foto distinta, una palabra o una caja nueva.
// - Va en la capa superior (popover manual) para verse encima de un <video> a pantalla completa.
// - Todas las medidas en múltiplos de --u (1 px de la tele de 1920×1080; la página ve 1280×720).
// - Nunca opacity/filter/transform/mask en un ancestro del cristal (.body, con backdrop-filter): lo romperían. Por eso el
//   cristal y el contenido son hermanos y los fundidos van en cada uno.
/* global __TV_TOKENS, __TV_FONTS */
(function () {
  if (window.TVAgent) return; // ya inyectada en esta página
  const TOK = typeof __TV_TOKENS === 'string' ? __TV_TOKENS : '';
  const FONTS = typeof __TV_FONTS !== 'undefined' && Array.isArray(__TV_FONTS) ? __TV_FONTS : [];

  // ── Aspecto: única fuente de los valores de color y material. test/unit/agent-contrast.test.js evalúa este objeto
  // (entre las marcas) y comprueba el contraste en el peor fondo: si cambias un valor, la prueba lo vigila.
  // @look:inicio
  const LOOK = {
    sheet: '#2a2233',              // tinta de la lámina (día)
    ctx: {                         // por contexto: brillo del fondo bajo el cristal y velo de tinta encima
      idle: { bright: 0.6, tint: 0.76 },
      music: { bright: 0.6, tint: 0.76 },
      video: { bright: 0.5, tint: 0.88 },
      web: { bright: 0.5, tint: 0.90 },
    },
    tiers: {                       // A completo, B ligero (blur corto, sin saturate), C opaco (sin backdrop-filter)
      A: { blur: 42, sat: 1.7, filter: true },
      B: { blur: 20, sat: 1, filter: true },
      C: { blur: 0, sat: 1, filter: false, tint: 0.97 },
    },
    // noche: lámina opaca, sin cristal, sin halo y sin brillos; orbe gris (luz y sombra del degradado)
    night: { sheet: '#0c0c0c', tint: 1, orb: ['#8a8a8a', '#3a3a3a'] },
    // brillos de la carátula en dos esquinas (a, b), reflejo arriba y sombra abajo. `color`: parte del color de la carátula
    // en el brillo (el resto es tinta), para que una carátula blanca no aclare el fondo del texto
    glow: { a: 0.08, b: 0.06, color: 0.4, sheen: 0.02, shade: 0.10 },
    card: { fill: '#ffffff', alpha: 0.05 }, // fondo de las fichas
    prov: 0.8,                     // opacidad de la palabra provisional de lo que dices
    text: {
      day: { main: '#ddd6d0', you: '#c3b7e3', soft: '#d0c9d9', old: '#a39cad' },
      night: { main: '#8a8a8a', you: '#808080', soft: '#808080', old: '#6e6e6e' },
    },
    warn: '#e3a46f',               // ámbar de los fallos
    warnOrb: ['#f6dcc2', '#a8683a'], // orbe en error: luz y sombra del degradado (el ámbar va en medio)
    ink: '#14101a',                // tinta del «!» sobre ámbar (ficha y orbe): ≥ 3:1 en todo el degradado
    orb: ['#7c6aae', '#6e8cc4'],   // malva y cielo, sin carátula
    orbLight: '#efe9fb',           // brillo del orbe
  };
  // @look:fin

  // ── Decisiones revisables (todas en una constante)
  const KEEP_TURNS = 2;            // turnos a la vista en el panel (la píldora solo enseña el último)
  const WORD_MS = 340;             // ritmo del revelado, por palabra
  const FAST_AFTER = 6;            // con más palabras pendientes que estas, el ritmo acelera
  const FLUSH_MS = 1200;           // con live:false, lo que falte sale en este tiempo como mucho
  const MIN_TICK_MS = 40;          // paso mínimo del revelado (al vaciar la cola salen varias palabras por paso)
  const LONG_REPLY = 120;          // caracteres a partir de los que la respuesta va con letra algo menor
  const FADE_MS = 650;             // fundido de cierre hacia el orbe
  const REMOVE_SAFETY_MS = 2000;   // si el rAF no corre (pestaña oculta), la capa se quita igual tras este tiempo
  const LOG_KEEP = 8;              // frases en la región accesible
  const SPRING = {                 // muelles por borde: crece rápido y con algo de rebote, encoge despacio
    grow: { k: 230, c: 21 },
    shrink: { k: 105, c: 16 },
    calm: { k: 300, c: 2 * Math.sqrt(300) }, // críticamente amortiguado: sin rebote
    // panel → píldora: el viaje es largo (medio ancho de pantalla), así que muelles más blandos y casi sin rebote para que
    // dure ~900 ms sin latigazos; los que encogen, aún más suaves. En calma, críticamente amortiguado
    travel: { grow: { k: 140, c: 21 }, shrink: { k: 90, c: 17 }, calm: { k: 120, c: 2 * Math.sqrt(120) } },
  };
  const RADIUS_U = { pill: 70, open: 64, rest: 48 }; // radio de las esquinas (en --u): píldora, escuchando/pensando, resto
  // pulso de la membrana (amp, 0–1): lo que suma cada evento, cuánto queda tras 1 s y el mínimo por estado (escucha late)
  const PULSE = { gain: 0.4, word: 0.6, event: 1, keep: 0.05, rest: 0.01, think: 0.05, listen: { base: 0.14, depth: 0.06, hz: 2.6 } };
  const ORB_SCALE = 0.28;          // cuánto crece el orbe con el pulso
  const RADIUS_RATE = 4;           // 1/s: velocidad con la que el radio va al de su estado
  const MAX_DT = 0.05;             // s: un frame largo (pestaña de fondo) no hace saltar los muelles
  const SUBSTEP_HZ = 120;          // pasos de integración por segundo
  // ondulación de las esquinas: deriva lenta (fuerza y frecuencias base + paso por esquina, en rad/s) y temblor del pulso.
  // `fade` (1/s): la deriva se apaga con la membrana quieta (y vuelve sin salto al despertar), así el rAF puede pararse.
  // `tier`: cuánto ondula cada nivel de cristal (B y C, para equipos lentos: radio fijo, menos que repintar)
  const WOBBLE = { slow: 0.05, kick: 0.06, kickHz: 5, fx: [0.45, 0.11], fy: [0.37, 0.09], fade: 2, tier: { A: 1, B: 0, C: 0 } };
  const OVERFLOW_PX = 32;          // contenido que sobra del log antes de difuminar su borde de arriba
  const SETTLE = { px: 0.4, v: 2, frames: 20 };       // asentado: cerca del objetivo, casi quieto, durante tantos frames
  // medida del tiempo de frame (ms) para glass:'auto': media de `frames` frames abiertos (sin los `skip` primeros ni los
  // saltos de más de `gap`); el nivel medido se aplica al empezar el turno siguiente, nunca a media frase
  const AUTO_TIER = { skip: 10, frames: 90, b: 24, c: 34, gap: 250 };
  // área segura contra el sobrebarrido: el mayor de N px de la tele (en --u) y el porcentaje de la pantalla
  const SAFE = { x: { u: 96, pct: 5 }, y: { u: 72, pct: 6 } };
  // con transparencia reducida, más contraste, colores forzados o sin backdrop-filter: lámina opaca (nivel C)
  const FORCE_C_QUERY = '(prefers-reduced-transparency: reduce), (prefers-contrast: more), (forced-colors: active)';
  const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';
  // panel → píldora (ms): sale el contenido, viaja la membrana (muelles) y el orbe (FLIP), y entra la píldora solapada al
  // final del viaje. En calma (o de noche) todo más corto; la membrana ya va críticamente amortiguada
  const MORPH = {
    normal: { out: 250, travel: 900, overlap: 300, in: 300, blur: 6 },
    calm: { out: 150, travel: 550, overlap: 200, in: 200, blur: 0 },
    ease: 'cubic-bezier(.32,.72,0,1)', // la de --tv-ease (WAAPI no lee variables CSS)
  };
  // fuentes propias de la capa (src/tv/agent-contract.js): primero las registradas aquí, luego la misma reserva en todas
  // partes. Sin Inter vendorizada, la de palo seco cae en la del sistema también en el reposo (que sí tiene Inter): así no
  // salta al navegar
  const FONT_SERIF = 'TV Fraunces';
  const FONT_SANS = 'TV Inter';
  const SERIF_STACK = `"${FONT_SERIF}","Fraunces",Georgia,serif`;
  const SANS_STACK = `"${FONT_SANS}",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif`;
  // animaciones de entrada: al acabar, su elemento queda marcado (.sd) y no se repiten
  const ENTRY_ANIMS = new Set(['wIn', 'wInCalm', 'fadeIn', 'bud']);
  const CHECK_D = 'M5 12.5l4.5 4.5L19 7.5';
  const SVG_NS = 'http://www.w3.org/2000/svg';
  // primitivas y atributos permitidos en los iconos que manda el servidor (datos, no HTML)
  const ICON_TAGS = new Set(['path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'ellipse']);
  const ICON_ATTRS = new Set(['d', 'cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'width', 'height', 'x1', 'y1', 'x2', 'y2', 'points']);
  const COLOR_RE = /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\))$/i;
  // valores que acepta la foto (test/unit/tv-agent-static.test.js los compara con los de src/tv/agent-contract.js)
  const FORMS = ['pill', 'panel'];
  const STATES = ['listen', 'think', 'talk', 'error', 'done'];
  const TIERS = ['A', 'B', 'C'];
  const ENTERS = ['open', 'restore'];
  // binding de CDP (Runtime.addBinding, lo pone el servidor) con el que se avisa del formato elegido arrastrando
  const FORM_BINDING = '__tvAgentForm';
  const HOST_ID = '__tvagent';     // id del host (el servidor lo salta al mirar si la página nueva ya enseña su contenido)
  // arrastre (medidas en --u): a partir de `start` es un arrastre; cambia de formato pasado `swap` hacia el destino o con
  // un gesto rápido: velocidad de más de `flick` (--u/ms) en los últimos `win` ms antes de soltar (con el punto de soltar:
  // moverse deprisa, pararse y soltar no es un golpe) y un recorrido de al menos `flickMin` (un temblor al pulsar no
  // cuenta); la goma nunca deja ir más allá de `band` ni sacar la caja del área segura; `back`: lo que tarda en volver si
  // no cambia; `hold`: ms que se mantiene la forma elegida aunque las fotos sigan con la vieja (hasta que el servidor la
  // confirme); `pts`: puntos del gesto que se guardan como mucho
  const DRAG = { start: 8, swap: 150, flick: 0.9, win: 90, flickMin: 40, band: 240, back: 380, hold: 1500, pts: 64 };
  // estados en los que el orbe respira (en el resto está quieto: una animación infinita repinta sin parar)
  const BREATHE_STATES = ['listen', 'think'];
  // estilos que el navegador pone a [popover] (tamaño ajustado, margen, borde, fondo Canvas…): el host los anula
  const HOST_CSS = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;overflow:visible;'
    + 'width:auto;height:auto;max-width:none;max-height:none;margin:0;padding:0;border:0;background:transparent';

  const u = n => `calc(${n} * var(--u))`;
  const TXT = LOOK.text;
  // los niveles sin filtro (C) y la noche: lámina opaca, sin backdrop-filter (la prueba de contraste usa el mismo `filter`)
  const NO_BACKDROP = [...Object.entries(LOOK.tiers).filter(([, v]) => !v.filter).map(([k]) => `.w[data-tier=${k}] .body`), '.w[data-night] .body'].join(',');
  const STYLE = `
:host{all:initial;${TOK};
  --tv-serif:${SERIF_STACK};--tv-sans:${SANS_STACK};
  --u:min(calc(100vw / 1920), calc(100vh / 1080));
  /* área segura contra el sobrebarrido: al menos 5 % del ancho y 6 % del alto */
  --mx:max(${u(SAFE.x.u)}, ${SAFE.x.pct}vw);--my:max(${u(SAFE.y.u)}, ${SAFE.y.pct}vh)}
.w{--la:${LOOK.orb[0]};--lb:${LOOK.orb[1]};--sheet:${LOOK.sheet};--tint:${LOOK.ctx.idle.tint};--br:${LOOK.ctx.idle.bright};
  --blur:${u(LOOK.tiers.A.blur)};--sat:${LOOK.tiers.A.sat};
  --t-main:${TXT.day.main};--t-you:${TXT.day.you};--t-soft:${TXT.day.soft};--t-old:${TXT.day.old};--warn:${LOOK.warn};--ink:${LOOK.ink};
  font-family:var(--tv-sans);color:var(--t-main);-webkit-font-smoothing:antialiased}
${Object.entries(LOOK.ctx).map(([k, v]) => `.w[data-ctx=${k}]{--tint:${v.tint};--br:${v.bright}}`).join('\n')}
${Object.entries(LOOK.tiers).map(([k, v]) => `.w[data-tier=${k}]{--blur:${u(v.blur)};--sat:${v.sat}${v.tint != null ? `;--tint:${v.tint}` : ''}}`).join('\n')}
.w[data-night]{--sheet:${LOOK.night.sheet};--tint:${LOOK.night.tint};
  --t-main:${TXT.night.main};--t-you:${TXT.night.you};--t-soft:${TXT.night.soft};--t-old:${TXT.night.old}}

/* cristal: dos capas hermanas del contenido, colocadas por el rAF (left/top/width/height y radios). El velo cambia de
   tinte con la página (ctx) sin saltar */
.halo,.body{position:fixed;left:0;top:0;width:0;height:0;pointer-events:none;transition:opacity .6s var(--tv-ease)}
.body{transition:opacity .6s var(--tv-ease),background-color .6s var(--tv-ease)}
/* solo la membrana visible recibe el puntero de la tele (para arrastrarla); cerrándose, ya no */
.body{pointer-events:auto;cursor:grab;touch-action:none}
.body.off,.w[data-pass] .body{pointer-events:none}
.w[data-drag] .body{cursor:grabbing}
.halo{box-shadow:0 ${u(2)} ${u(6)} rgba(10,6,16,.35),0 ${u(30)} ${u(70)} ${u(-18)} rgba(10,6,16,.6)}
.body{overflow:hidden;background:color-mix(in srgb,var(--sheet) calc(var(--tint) * 100%),transparent);
  -webkit-backdrop-filter:blur(var(--blur)) saturate(var(--sat)) brightness(var(--br));
  backdrop-filter:blur(var(--blur)) saturate(var(--sat)) brightness(var(--br));
  /* filos de luz: 1px y .5px son líneas finas de borde, no medidas (a cualquier escala deben ser una línea) */
  box-shadow:inset 0 1px 0 rgba(255,255,255,.14),inset 0 0 0 .5px rgba(255,255,255,.08)}
.body::before,.body::after{content:"";position:absolute;inset:0}
.body::before{--ga:color-mix(in srgb,var(--la) ${LOOK.glow.color * 100}%,var(--sheet));--gb:color-mix(in srgb,var(--lb) ${LOOK.glow.color * 100}%,var(--sheet));
  background:linear-gradient(135deg,color-mix(in srgb,var(--ga) ${LOOK.glow.a * 100}%,transparent),transparent 55%),
  linear-gradient(315deg,color-mix(in srgb,var(--gb) ${LOOK.glow.b * 100}%,transparent),transparent 55%)}
.body::after{background:linear-gradient(180deg,rgba(255,255,255,${LOOK.glow.sheen}),rgba(255,255,255,0) 38%,rgba(0,0,0,${LOOK.glow.shade}))}
${NO_BACKDROP}{-webkit-backdrop-filter:none;backdrop-filter:none}
.w[data-night] .halo,.w[data-night] .body::before,.w[data-night] .body::after{display:none}
.w[data-night] .body{box-shadow:none}
.off{opacity:0}

/* contenido */
.sheet{position:fixed;box-sizing:border-box;display:flex;min-width:0}
.sheet>*{animation:fadeIn .6s .25s var(--tv-ease) backwards;transition:opacity .3s}
.sheet.gone>*{opacity:0}
.w[data-form=panel] .sheet{right:var(--mx);top:var(--my);width:min(${u(640)}, calc(100vw - 2 * var(--mx)));
  max-height:calc(100vh - 2 * var(--my));flex-direction:column;gap:${u(22)};padding:${u(34)} ${u(44)} ${u(40)}}
.w[data-form=panel][data-ctx=web] .sheet{width:min(${u(580)}, calc(100vw - 2 * var(--mx)))}
.w[data-form=pill] .sheet{left:0;right:0;margin:0 auto;top:var(--my);width:fit-content;
  min-width:min(${u(880)}, calc(100vw - 2 * var(--mx)));max-width:min(${u(1120)}, calc(100vw - 2 * var(--mx)));
  flex-direction:row;align-items:flex-start;gap:${u(26)};padding:${u(26)} ${u(46)} ${u(28)} ${u(30)}}
.hd{flex:none;display:flex;align-items:center}
.w[data-form=pill] .hd{padding-top:${u(6)}}
.log{display:flex;flex-direction:column;justify-content:flex-end;gap:${u(36)};min-height:0;min-width:0;flex:1 1 auto;overflow:hidden}
.log.over{-webkit-mask-image:linear-gradient(180deg,transparent 0,#000 ${u(56)});mask-image:linear-gradient(180deg,transparent 0,#000 ${u(56)})}
/* píldora: la ficha compacta y hasta 3 líneas de la respuesta (lo de antes sale difuminado por arriba) */
.w[data-form=pill] .log{max-height:${u(212)};gap:0}
.w[data-form=pill] .log.over{-webkit-mask-image:linear-gradient(180deg,transparent 0,#000 45%);mask-image:linear-gradient(180deg,transparent 0,#000 45%)}
.w[data-form=pill] .tn:not(:last-child){display:none}
.tn{display:flex;flex-direction:column;gap:${u(14)};min-width:0}
.u,.j,.hint{margin:0;overflow-wrap:anywhere}
.u{font:380 ${u(32)}/1.25 var(--tv-serif);font-variation-settings:'opsz' 72;color:var(--t-you)}
.j{font:380 ${u(44)}/1.18 var(--tv-serif);font-variation-settings:'opsz' 144;color:var(--t-main);text-wrap:pretty}
.j.sm{font-size:${u(38)}}
.w[data-form=pill] .j{font-size:${u(40)}}
.w[data-form=pill] .u{font-size:${u(30)}}
.u:empty,.j:empty,.hint:empty{display:none}
.hint{font:400 ${u(26)}/1.3 var(--tv-sans);color:var(--t-soft)}
/* el turno anterior se atenúa por color, nunca por opacidad */
.tn:not(:last-child) :is(.u,.j,.hint){color:var(--t-old)}
/* panel → píldora: el contenido sale (opacidad y desenfoque), viaja oculto y vuelve a entrar ya en la píldora */
.log{transition:opacity ${MORPH.normal.in}ms var(--tv-ease),filter ${MORPH.normal.in}ms var(--tv-ease)}
.w[data-morph=out] .log{opacity:0;filter:blur(${u(MORPH.normal.blur)});transition-duration:${MORPH.normal.out}ms}
.w[data-morph=travel] .log{opacity:0;transition:none}
.w[data-calm] .log{transition-duration:${MORPH.calm.in}ms}
.w[data-calm][data-morph=out] .log{filter:none;transition-duration:${MORPH.calm.out}ms}
/* entradas ya hechas (o restauradas tras navegar): no se repiten al mover el host */
.sd{animation:none!important}
/* palabras: entran con desenfoque, sin desplazamiento (solo opacity y filter) */
.wd{display:inline-block;max-width:100%;margin-right:.26em;animation:wIn .5s var(--tv-ease) backwards}
.wd.prov{opacity:${LOOK.prov}}
@keyframes wIn{from{opacity:0;filter:blur(${u(4)})}}
@keyframes fadeIn{from{opacity:0}}

/* orbe: escucha (anillo), piensa (satélite), error (ámbar con «!»); solo respira mientras escucha o piensa */
.orbe{position:relative;width:${u(48)};height:${u(48)};flex:none}
${BREATHE_STATES.map(k => `.w[data-state=${k}] .orbe`).join(',')}{animation:breathe 3.4s ease-in-out infinite}
.w[data-form=pill] .orbe{width:${u(44)};height:${u(44)}}
.orbe i{position:absolute;inset:0;border-radius:50%;
  background:radial-gradient(circle at 34% 28%,${LOOK.orbLight},var(--la) 52%,var(--lb) 125%);
  box-shadow:0 0 ${u(30)} color-mix(in srgb,var(--la) 55%,transparent),0 0 0 calc(var(--ring, 0) * ${u(18)}) color-mix(in srgb,var(--tv-accent) 16%,transparent)}
.orbe::after{content:"";position:absolute;left:50%;top:50%;width:${u(11)};height:${u(11)};margin:${u(-5.5)};border-radius:50%;
  background:var(--tv-accent);opacity:0;transition:opacity .5s}
.w[data-state=think] .orbe::after{opacity:1;animation:sat 3.1s linear infinite}
.w[data-form=pill][data-state=think] .orbe::after{animation-name:sat2}
.w[data-state=error] .orbe::before{content:"!";position:absolute;inset:0;display:grid;place-items:center;z-index:2;
  font:500 ${u(28)}/1 var(--tv-sans);color:var(--ink)}
.w[data-state=error] .orbe i{background:radial-gradient(circle at 34% 28%,${LOOK.warnOrb[0]},var(--warn) 60%,${LOOK.warnOrb[1]});
  box-shadow:0 0 0 ${u(6)} color-mix(in srgb,var(--warn) 25%,transparent)}
.w[data-night] .orbe i{background:radial-gradient(circle at 34% 28%,${LOOK.night.orb[0]},${LOOK.night.orb[1]} 70%);box-shadow:none}
@keyframes breathe{50%{transform:scale(1.06)}}
@keyframes sat{to{transform:rotate(360deg) translateY(${u(-34)})}}
@keyframes sat2{to{transform:rotate(360deg) translateY(${u(-28)})}}

/* fichas de herramienta: icono, título, detalle y giro → check o «!» ámbar */
.tcs{display:flex;flex-direction:column;align-items:flex-start;gap:${u(12)}}
.tc{display:grid;grid-template-columns:${u(52)} minmax(0,1fr) ${u(36)};gap:0 ${u(18)};align-items:center;box-sizing:border-box;
  width:100%;padding:${u(16)} ${u(22)};border-radius:${u(26)};
  background:color-mix(in srgb,${LOOK.card.fill} ${LOOK.card.alpha * 100}%,transparent);
  box-shadow:inset 0 0 0 .5px rgba(255,255,255,.1); /* filo fino, ver .body */
  animation:bud .9s var(--tv-ease) backwards}
@keyframes bud{from{opacity:0;transform:translateY(${u(-14)}) scale(.94)}}
.ic{width:${u(52)};height:${u(52)};border-radius:${u(16)};background:color-mix(in srgb,var(--t-you) 14%,transparent);display:grid;place-items:center}
.ic svg{width:${u(30)};height:${u(30)};stroke:var(--tv-accent);fill:none;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
.tx{min-width:0}
.tt{font:500 ${u(28)}/1.2 var(--tv-sans);color:var(--t-main);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tb{font:400 ${u(26)}/1.25 var(--tv-sans);color:var(--t-soft);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tb:empty{display:none}
.ss{width:${u(30)};height:${u(30)};justify-self:end;display:grid;place-items:center}
.spin{box-sizing:border-box;width:100%;height:100%;border-radius:50%;border:${u(3)} solid color-mix(in srgb,var(--t-you) 25%,transparent);
  border-top-color:var(--tv-accent);animation:rot 1s linear infinite}
@keyframes rot{to{transform:rotate(360deg)}}
.ss svg{width:100%;height:100%;stroke:var(--tv-accent);fill:none;stroke-width:2.4;stroke-linecap:round;stroke-linejoin:round}
.x{display:grid;place-items:center;width:100%;height:100%;border-radius:50%;background:var(--warn);color:var(--ink);
  font:500 ${u(24)}/1 var(--tv-sans)}
/* ficha pequeña: la anterior del turno, las de turnos anteriores y todas en la píldora (sin detalle) */
.tcs>.tc:not(:last-child),.tn:not(:last-child) .tc,.w[data-form=pill] .tc{grid-template-columns:${u(36)} auto ${u(30)};
  width:auto;max-width:100%;padding:${u(8)} ${u(18)} ${u(8)} ${u(10)};border-radius:${u(999)}}
:is(.tcs>.tc:not(:last-child),.tn:not(:last-child) .tc,.w[data-form=pill] .tc) .ic{width:${u(36)};height:${u(36)};border-radius:50%}
:is(.tcs>.tc:not(:last-child),.tn:not(:last-child) .tc,.w[data-form=pill] .tc) .ic svg{width:${u(22)};height:${u(22)}}
:is(.tcs>.tc:not(:last-child),.tn:not(:last-child) .tc,.w[data-form=pill] .tc) .tb{display:none}
.w[data-form=pill] .tcs{margin-bottom:${u(12)}}
/* en la píldora la ficha dice lo concreto («Netflix») si lo hay, no lo genérico («Abrir en la tele») */
.w[data-form=pill] .tc[data-d] .tt{display:none}
.w[data-form=pill] .tc[data-d] .tb{display:block;font:500 ${u(26)}/1.2 var(--tv-sans);color:var(--t-main)}
.w[data-form=pill] .tt{font-size:${u(26)}}
.w[data-night] .ic svg,.w[data-night] .ss svg{stroke:var(--t-main)}
.w[data-night] .spin{border-top-color:var(--t-main)}

/* calma (o noche): nada ondula ni gira deprisa; las palabras entran sin desenfoque */
.w[data-calm] .orbe,.w[data-calm] .orbe::after{animation:none}
.w[data-calm][data-state=think] .orbe::after{opacity:0}
.w[data-calm] .wd{animation-duration:.2s;animation-name:wInCalm}
@keyframes wInCalm{from{opacity:0}}
.w[data-calm] .spin{animation-duration:2.4s}

/* región accesible: fuera de la vista, sin foco */
.sr{position:fixed;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
`;

  // ── Estado de la capa
  /** @type {any} */ let host = null;
  /** @type {any} */ let dom = null;   // { root, w, halo, body, sheet, orb, ring, log, sr, alert }
  /** @type {any} */ let last = null;  // última foto saneada
  let open = false, closing = false, closedAt = 0;
  let raf = 0, lastT = 0, removeT = 0, revealT = 0, revealAt = 0, flushBy = 0;
  /** @type {Map<number, any>} */ const turns = new Map(); // turn.id → { el, you, jota, tcs, tools, hint, said, sm }
  /** @type {number | null} */ let curId = null; // turno actual a la vista (al cambiar, se limpia el aviso y se aplica el nivel medido)
  let lastSig = '';                 // última foto (JSON): la misma foto no despierta el rAF
  // nivel medido para glass:'auto' (se recuerda en la página); `autoNext` espera al turno siguiente para aplicarse
  let autoTier = 'A', autoNext = '', autoFrames = 0, autoSum = 0;
  let resizeObs = null;             // ResizeObserver del contenido: un cambio de caja despierta el rAF parado
  let restoring = false;            // la foto en curso restaura la capa en un documento nuevo (sin entradas)
  let seed = false;                 // la membrana nace ya en la caja del contenido (restore), no desde el centro
  /** @type {any} */ let morph = null; // paso panel → píldora en curso: { phase, timers }
  let traveling = false;            // la membrana viaja a la píldora (muelles SPRING.travel) hasta asentarse
  /** @type {any} */ let waiting = null; // foto que espera a que exista documentElement (script de documento nuevo)
  /** @type {any} */ let drag = null;  // arrastre en curso: { id, x0, y0, dx, dy, pts, room, form, on }
  /** @type {any} */ let hold = null;  // forma elegida arrastrando, hasta que la foto la confirme: { form, until }
  /** @type {any} */ let backAnim = null; // vuelta del contenido a su sitio tras un arrastre que no cambia de forma

  // geometría del cristal: bordes (e) y velocidades (v) en px, amplitud de la ondulación y radio base
  /** @type {any} */ let edge = null;
  const vel = { l: 0, t: 0, r: 0, b: 0 };
  let amp = 0, radius = 0, stillFrames = 0;
  let drift = 0;                    // fuerza de la deriva lenta de las esquinas (0–1): se apaga con la membrana quieta
  const phase = Array.from({ length: 8 }, (_, i) => i * 0.79 + 0.3); // fases fijas: la membrana no depende de Math.random

  const el = (tag, cls, txt) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  };
  const svg = () => { const s = document.createElementNS(SVG_NS, 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true'); return s; };
  const mqls = new Map(); // MediaQueryList por consulta: se crean una vez y se leen en cada foto
  const mq = q => {
    try { if (!mqls.has(q)) mqls.set(q, window.matchMedia(q)); return !!mqls.get(q).matches; } catch { return false; }
  };
  // escribe un atributo de datos solo si cambia (render llega cada 100 ms: no invalidar estilos para nada)
  const setData = (e, k, v) => { if (e.dataset[k] !== v) e.dataset[k] = v; };
  const setFlag = (e, k, on) => { if (e.hasAttribute(k) !== on) e.toggleAttribute(k, on); };
  // fuentes de __TV_FONTS (bytes en base64) registradas una vez por documento; un fallo deja la pila de reserva
  function loadFonts() {
    for (const f of FONTS) {
      try {
        if (!f || typeof f.family !== 'string' || typeof f.data !== 'string' || typeof FontFace !== 'function') continue;
        const bin = atob(f.data), buf = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
        // 'block': sin texto un instante antes que Georgia y luego Fraunces (se nota al restaurar tras navegar)
        const face = new FontFace(f.family, buf, { weight: typeof f.weight === 'string' ? f.weight : 'normal', style: 'normal', display: 'block' });
        document.fonts.add(face);
        face.load().catch(() => {});
      } catch { /* la capa sigue con la reserva */ }
    }
  }
  const hasBackdrop = () => { try { return window.CSS.supports('backdrop-filter', 'blur(1px)') || window.CSS.supports('-webkit-backdrop-filter', 'blur(1px)'); } catch { return false; } };

  // ── Foto: se sanea todo lo que llega (viene del servidor, pero la capa no debe romperse con un dato raro)
  function clean(o) {
    const s = o && typeof o === 'object' ? o : {};
    const str = x => (typeof x === 'string' ? x : '');
    const turnsIn = Array.isArray(s.turns) ? s.turns.slice(-KEEP_TURNS) : [];
    return {
      form: FORMS.includes(s.form) ? s.form : 'panel',
      ctx: Object.hasOwn(LOOK.ctx, s.ctx) ? s.ctx : 'idle',
      state: STATES.includes(s.state) ? s.state : 'done',
      live: !!s.live, night: !!s.night, calm: !!s.calm,
      glass: TIERS.includes(s.glass) ? s.glass : 'auto',
      colors: Array.isArray(s.colors) && s.colors.length === 2 && s.colors.every(c => typeof c === 'string' && COLOR_RE.test(c)) ? s.colors : null,
      turns: turnsIn.filter(t => t && Number.isFinite(t.id)).map(t => ({
        id: t.id, you: str(t.you), youFinal: !!t.youFinal, jota: str(t.jota), error: !!t.error, hint: str(t.hint),
        tools: (Array.isArray(t.tools) ? t.tools : []).filter(x => x && x.id != null).map(x => ({
          id: String(x.id), kind: str(x.kind), title: str(x.title), detail: str(x.detail),
          status: x.status === 'ok' || x.status === 'fail' ? x.status : 'run',
        })),
      })),
      icons: s.icons && typeof s.icons === 'object' ? s.icons : {},
      enter: ENTERS.includes(s.enter) ? s.enter : 'open',
    };
  }
  const calmNow = () => !!(last && (last.calm || last.night)) || mq(REDUCED_MOTION_QUERY);
  function tierNow() {
    if (!hasBackdrop() || mq(FORCE_C_QUERY)) return 'C';
    return last && last.glass !== 'auto' ? last.glass : autoTier;
  }

  // ── Montaje: host en fullscreenElement (si admite hijos) o body; se vuelve a colgar al cambiar de pantalla completa.
  // Además va en la capa superior (popover manual): lo que está a pantalla completa se pinta ahí, por encima de cualquier
  // z-index, y un <video> a pantalla completa no admite hijos. Sin popover (navegador viejo) queda el z-index.
  function parentNow() {
    const f = document.fullscreenElement;
    // un <video>, <iframe>, <img> o <canvas> a pantalla completa no pinta hijos: la capa no se vería
    return f && !/^(VIDEO|IFRAME|IMG|CANVAS)$/.test(f.tagName) ? f : document.body || document.documentElement;
  }
  function ensure() {
    const parent = parentNow();
    // ya montada: mover no recrea (shadow root y estado van con el host). Se mueve también en la capa superior: se vería
    // igual desde body, pero lo que queda fuera del elemento a pantalla completa es inerte (sin puntero: no se arrastraría).
    // Mover suelta la captura del puntero (el arrastre en curso se deja) y saca el popover de la capa superior (se vuelve
    // a subir); las entradas ya acabadas no se repiten (.sd)
    if (host && host.isConnected) { if (host.parentNode !== parent) { dropDrag(); parent.appendChild(host); lift(false); } return; }
    host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText = HOST_CSS;
    if (topLayer()) host.popover = 'manual';
    const root = host.attachShadow({ mode: 'open' });
    try { const sh = new CSSStyleSheet(); sh.replaceSync(STYLE); root.adoptedStyleSheets = [sh]; }
    catch { root.appendChild(el('style', null, STYLE)); }
    if (typeof root.addEventListener === 'function') {
      root.addEventListener('animationend', e => { if (ENTRY_ANIMS.has(e.animationName) && e.target && e.target.classList) e.target.classList.add('sd'); });
    }
    const w = el('div', 'w');
    // el aspecto de la foto ya al nacer (antes de entrar en la página, que calcula estilos): el velo y el satélite del orbe
    // no hacen su transición desde los valores de partida
    if (last) { setData(w, 'ctx', last.ctx); setData(w, 'state', last.state); setData(w, 'tier', tierNow()); setFlag(w, 'data-night', last.night); setFlag(w, 'data-calm', calmNow()); }
    // restaurada tras navegar: el cristal ya está (sin fundido de entrada, que dejaría el texto un instante sin cristal)
    const off = restoring ? '' : ' off';
    const halo = el('div', 'halo' + off), body = el('div', 'body' + off);
    const sheet = el('div', 'sheet');
    const sd = restoring ? ' sd' : ''; // restaurada: la cabecera y el log ya estaban
    sheet.setAttribute('aria-hidden', 'true'); // el texto accesible va en la región role=log
    const hd = el('div', 'hd' + sd), orb = el('div', 'orbe'), ring = el('i');
    orb.appendChild(ring); hd.appendChild(orb);
    const log = el('div', 'log' + sd);
    sheet.append(hd, log);
    const sr = el('div', 'sr'); sr.setAttribute('role', 'log'); sr.setAttribute('aria-live', 'polite');
    const alert = el('div', 'sr'); alert.setAttribute('role', 'alert');
    w.append(halo, body, sheet, sr, alert);
    root.appendChild(w);
    parent.appendChild(host);
    lift(false);
    dom = { root, w, halo, body, sheet, hd, orb, ring, log, sr, alert };
    grab(body);
    edge = null; amp = 0; radius = 0; drift = 0; curId = null; lastSig = ''; seed = restoring;
    turns.clear(); // host nuevo (la página lo quitó, o tras cerrar): los turnos se vuelven a pintar desde la foto
    if (resizeObs) resizeObs.disconnect();
    resizeObs = typeof ResizeObserver === 'function' ? new ResizeObserver(() => wake()) : null;
    if (resizeObs) resizeObs.observe(sheet);
  }
  const topLayer = () => !!host && typeof host.showPopover === 'function';
  const lifted = () => { try { return host.matches(':popover-open'); } catch { return false; } };
  // a la capa superior; `again`: sale y vuelve a entrar para quedar la última (encima de un fullscreen que entró después)
  function lift(again) {
    if (!topLayer()) return;
    try { if (again && lifted()) host.hidePopover(); if (!lifted()) host.showPopover(); } catch { /* sigue con el z-index */ }
  }

  // ── Arrastre con el puntero de la tele. Los eventos no suben de la membrana a la web (sus oyentes en fase de captura
  // sí los ven, ver arriba) y el mousedown no hace su acción por defecto: ni quita el foco al campo en el que se escribe
  // ni selecciona texto
  const STOP_EVENTS = ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu', 'wheel'];
  function grab(body) {
    if (typeof body.addEventListener !== 'function') return;
    for (const k of STOP_EVENTS) body.addEventListener(k, e => { e.stopPropagation(); if (k === 'mousedown' || k === 'contextmenu') e.preventDefault(); });
    body.addEventListener('pointerdown', e => {
      if (drag || morph || closing || !open || !last || e.button !== 0) return;
      if (backAnim) { backAnim.cancel(); backAnim = null; }   // antes de medir: el contenido, en su sitio
      drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, dx: 0, dy: 0, pts: [{ x: e.clientX, y: e.clientY, t: e.timeStamp }],
        room: roomOf(), form: dom.w.dataset.form, on: false };
      try { body.setPointerCapture(e.pointerId); } catch { /* sin captura: sigue mientras el puntero esté encima */ }
    });
    body.addEventListener('pointermove', e => {
      if (!drag || e.pointerId !== drag.id) return;
      track(drag, e);
      const { dx, dy, room } = drag;
      if (!drag.on && Math.hypot(dx, dy) >= DRAG.start * unit()) { drag.on = true; setFlag(dom.w, 'data-drag', true); }
      if (drag.on) {
        const tx = band(dx, dx > 0 ? room.r : room.l), ty = band(dy, dy > 0 ? room.b : room.t);
        dom.sheet.style.transform = `translate(${tx.toFixed(1)}px, ${ty.toFixed(1)}px)`;
        wake();
      }
    });
    const end = e => {
      if (!drag || e.pointerId !== drag.id) return;
      const d = drag;
      drag = null;
      try { body.releasePointerCapture(e.pointerId); } catch { /* ya suelta */ }
      setFlag(dom.w, 'data-drag', false);
      if (e.type === 'pointerup') track(d, e);
      const to = d.on && e.type === 'pointerup' ? dropTo(d, releaseVel(d.pts, e.timeStamp)) : '';
      settleBack(d, !!to);
      if (to) { hold = { form: to, until: performance.now() + DRAG.hold }; startMorph(to); tell(to); }
      wake();
    };
    body.addEventListener('pointerup', end);
    body.addEventListener('pointercancel', end);
  }
  // un punto más del gesto (recorrido desde el inicio y los últimos puntos para la velocidad al soltar)
  function track(d, e) {
    d.dx = e.clientX - d.x0; d.dy = e.clientY - d.y0;
    d.pts.push({ x: e.clientX, y: e.clientY, t: e.timeStamp });
    if (d.pts.length > DRAG.pts) d.pts.shift();
  }
  // velocidad (px/ms) en los últimos DRAG.win ms del gesto, contando el punto de soltar: 0 si se paró antes de soltar
  function releaseVel(pts, tUp) {
    const w = pts.filter(p => p.t >= tUp - DRAG.win);
    const a = w[0], b = w[w.length - 1], dt = a && b ? b.t - a.t : 0;
    return dt > 0 ? { vx: (b.x - a.x) / dt, vy: (b.y - a.y) / dt } : { vx: 0, vy: 0 };
  }
  const unit = () => Math.min(innerWidth / 1920, innerHeight / 1080);
  // área segura en px (como --mx/--my): el mayor de N px de la tele y el porcentaje de la pantalla
  const safeOf = U => ({ x: Math.max(SAFE.x.u * U, innerWidth * SAFE.x.pct / 100), y: Math.max(SAFE.y.u * U, innerHeight * SAFE.y.pct / 100) });
  // sitio que tiene el contenido hacia cada lado sin salir del área segura (al empezar el arrastre, con todo en su sitio)
  function roomOf() {
    const b = dom.sheet.getBoundingClientRect(), s = safeOf(unit());
    return { l: Math.max(0, b.left - s.x), r: Math.max(0, innerWidth - s.x - b.right), t: Math.max(0, b.top - s.y), b: Math.max(0, innerHeight - s.y - b.bottom) };
  }
  // goma: el desplazamiento crece cada vez menos y nunca pasa de DRAG.band ni del sitio que hay hacia ese lado
  const band = (d, room) => { const B = Math.min(DRAG.band * unit(), room); return B > 0 ? B * d / (B + Math.abs(d)) : 0; };
  // destino al soltar: la píldora hacia la derecha → panel; el panel hacia el centro o hacia arriba → píldora; si no, ''
  function dropTo(d, v) {
    const U = unit(), T = DRAG.swap * U, V = DRAG.flick * U, M = DRAG.flickMin * U;
    const go = (dist, vel) => dist > T || (vel > V && dist >= M);
    if (d.form === 'pill') return go(d.dx, v.vx) ? 'panel' : '';
    return go(-d.dx, -v.vx) || go(-d.dy, -v.vy) ? 'pill' : '';
  }
  // suelta el arrastre en curso sin cambiar nada (al cerrar, o al mover el host: se pierde la captura del puntero)
  function dropDrag() {
    if (!drag || !dom) return;
    drag = null; dom.sheet.style.transform = ''; setFlag(dom.w, 'data-drag', false);
  }
  // el contenido vuelve a su sitio: si cambia de forma, sale desde donde lo soltó el dedo (el paso lo recoloca ya oculto);
  // si no, deslizándose (la membrana lo sigue)
  function settleBack(d, swap) {
    if (swap) return;
    const from = dom.sheet.style.transform;
    dom.sheet.style.transform = '';
    if (!from || !d.on || typeof dom.sheet.animate !== 'function') return;
    backAnim = dom.sheet.animate([{ transform: from }, { transform: 'none' }], { duration: calmNow() ? MORPH.calm.out : DRAG.back, easing: MORPH.ease });
    backAnim.onfinish = () => { backAnim = null; };
  }
  // aviso al servidor (binding de CDP): la misma orden que «Ampliar en la tele» / «Hacer píldora» del mando
  function tell(form) {
    const f = window[FORM_BINDING];
    if (typeof f === 'function') try { f(form); } catch { /* sin servidor: queda la forma local hasta la foto siguiente */ }
  }

  // ── Diff de la foto contra el DOM
  function apply(s) {
    const w = dom.w;
    setForm(s.form); setData(w, 'ctx', s.ctx); setData(w, 'state', s.state); setData(w, 'tier', tierNow());
    setFlag(w, 'data-night', s.night);
    setFlag(w, 'data-calm', calmNow());
    const [la, lb] = s.colors || LOOK.orb;
    if (w.style.getPropertyValue('--la') !== la) w.style.setProperty('--la', la);
    if (w.style.getPropertyValue('--lb') !== lb) w.style.setProperty('--lb', lb);
    const ids = new Set(s.turns.map(t => t.id));
    for (const [id, t] of turns) if (!ids.has(id)) { t.el.remove(); turns.delete(id); }
    newTurn(s.turns.length ? s.turns[s.turns.length - 1].id : null);
    s.turns.forEach((t, i) => {
      const current = i === s.turns.length - 1;
      let v = turns.get(t.id);
      if (!v) { v = makeTurn(); turns.set(t.id, v); if (!current || restoring) hush(v, t, current && s.live); }
      // orden: solo se mueve si no está en su sitio (mover reinicia las animaciones de dentro)
      const at = dom.log.children[i];
      if (at !== v.el) dom.log.insertBefore(v.el, at || null);
      setWords(v.you, t.you, current && !t.youFinal);
      // la respuesta en directo: la última palabra puede estar a medias (llega por trozos), se espera a que se cierre
      setWords(v.jota, t.jota, false, current && s.live && !/[\s.,;:!?¡¿…»"')]$/.test(t.jota));
      v.jota.el.classList.toggle('sm', small(v, t, current, s.live));
      if (v.hint.textContent !== t.hint) v.hint.textContent = t.hint;
      syncTools(v, t.tools, s.icons);
      // un turno que ya no es el actual se enseña entero; al restaurar, también el actual (lo ya dicho no se revela otra vez)
      if (!current || restoring) flushLine(v.you), flushLine(v.jota);
      speak(v, t, current && s.live);
    });
  }
  // cambia el turno actual: el aviso de un fallo anterior ya no vale y el nivel medido entra ahora (no a media frase)
  function newTurn(id) {
    if (id === curId) return;
    curId = id;
    if (dom.alert.textContent) warn('');
    if (autoNext) { autoTier = autoNext; autoNext = ''; setData(dom.w, 'tier', tierNow()); }
  }
  function makeTurn() {
    const e = el('div', 'tn');
    const you = line('p', 'u'), tcs = el('div', 'tcs'), jota = line('p', 'j'), hint = el('p', 'hint');
    e.append(you.el, tcs, jota.el, hint);
    return { el: e, you, jota, tcs, hint, tools: new Map(), said: { you: false, jota: false, fails: new Set() }, sm: null };
  }
  // un turno que llega ya como anterior (p. ej. al reabrir la capa) se anunció cuando era el actual: no se repite. Al
  // restaurar tras navegar, el actual tampoco (salvo lo que aún no era final: la respuesta en directo)
  function hush(v, t, liveNow) {
    v.said.you = !liveNow || t.youFinal; v.said.jota = !liveNow;
    for (const x of t.tools) if (x.status === 'fail') v.said.fails.add(x.id);
  }
  // forma: directa al montar (o restaurar), y con paso animado si cambia con la capa abierta (el paso lleva la forma
  // mientras dura; durante un arrastre, la decide quien arrastra)
  function setForm(f) {
    const was = dom.w.dataset.form;
    if (morph || drag || was === f) return;
    if (was && open && !closing && !restoring) return startMorph(f);
    setData(dom.w, 'form', f);
  }
  // ── Cambio de forma (panel ↔ píldora). Solo transform/opacity/filter en el contenido; el cristal lo mueve el rAF de
  // siempre (muelles por borde: los que encogen, más suaves) hacia la caja nueva del contenido
  function startMorph(to) {
    const M = calmNow() ? MORPH.calm : MORPH.normal;
    const w = dom.w;
    morph = { phase: 'out', timers: [] };
    const later = (ms, f) => morph.timers.push(setTimeout(f, ms));
    setData(w, 'morph', 'out');
    later(M.out, () => {
      if (!dom) return;
      const a = dom.orb.getBoundingClientRect();           // FLIP: dónde está el orbe (donde lo dejó el dedo, si se arrastró)…
      dom.sheet.style.transform = '';                      // el contenido, ya oculto, vuelve a su sitio
      setData(w, 'form', to); setData(w, 'morph', 'travel'); morph.phase = 'travel'; traveling = true;
      const b = dom.orb.getBoundingClientRect();           // …y dónde va en la forma nueva (el orbe es el ancla del paso)
      if (typeof dom.orb.animate === 'function' && b.width && b.height) {
        const dx = a.left - b.left, dy = a.top - b.top, k = a.width / b.width;
        dom.orb.animate([{ transform: `translate(${dx}px, ${dy}px) scale(${k})`, transformOrigin: '0 0' }, { transform: 'none', transformOrigin: '0 0' }],
          { duration: M.travel, easing: MORPH.ease });
      }
      kick(PULSE.event);
      later(Math.max(0, M.travel - M.overlap), () => {     // entra el contenido, solapado al final del viaje
        if (!dom) return;
        delete w.dataset.morph;
        morph.phase = 'in';
        later(M.in, endMorph);
      });
    });
  }
  function endMorph() {
    if (!morph) return;
    morph.timers.forEach(t => clearTimeout(t));
    morph = null;
    if (dom) { delete dom.w.dataset.morph; if (last) setForm(last.form); }
  }
  // letra menor para una respuesta larga: el turno actual lo decide una vez, al verlo por primera vez (en directo, grande,
  // para que no encoja a media lectura); un turno anterior, por su largo
  function small(v, t, current, live) {
    if (!current) return t.jota.length > LONG_REPLY;
    if (v.sm == null) v.sm = !live && t.jota.length > LONG_REPLY;
    return v.sm;
  }
  // una línea de palabras: `want` es lo que hay que enseñar, `spans` lo que ya se ve
  const line = (tag, cls) => ({ el: el(tag, cls), want: /** @type {string[]} */ ([]), spans: /** @type {any[]} */ ([]), prov: false });
  function setWords(ln, text, prov, holdLast) {
    let words = text.split(/\s+/).filter(Boolean);
    if (holdLast) words = words.slice(0, -1);
    ln.want = words; ln.prov = prov;
    // lo que ya se ve y ha cambiado (la transcripción corrige): se actualiza el texto, sin recrear el nodo
    while (ln.spans.length > words.length) ln.spans.pop().remove();
    ln.spans.forEach((sp, i) => { if (sp.textContent !== words[i]) sp.textContent = words[i]; });
    markProv(ln);
  }
  function markProv(ln) {
    ln.spans.forEach((sp, i) => sp.classList.toggle('prov', ln.prov && i === ln.want.length - 1));
  }
  function showNext(ln) {
    const sp = el('span', restoring ? 'wd sd' : 'wd', ln.want[ln.spans.length]);
    ln.el.appendChild(sp); ln.spans.push(sp);
    markProv(ln);
  }
  function flushLine(ln) { while (ln.spans.length < ln.want.length) showNext(ln); }
  const pendingOf = ln => ln.want.length - ln.spans.length;

  function syncTools(v, tools, icons) {
    const ids = new Set(tools.map(x => x.id));
    for (const [id, c] of v.tools) if (!ids.has(id)) { c.el.remove(); v.tools.delete(id); }
    for (const x of tools) {
      let c = v.tools.get(x.id);
      if (!c) { c = makeCard(x, icons); v.tools.set(x.id, c); v.tcs.appendChild(c.el); kick(PULSE.event); }
      if (c.tt.textContent !== x.title) c.tt.textContent = x.title;
      if (c.tb.textContent !== x.detail) c.tb.textContent = x.detail;
      setFlag(c.el, 'data-d', !!x.detail);
      if (c.status !== x.status) setStatus(c, x.status);
    }
  }
  function makeCard(x, icons) {
    const e = el('div', restoring ? 'tc sd' : 'tc'), ic = el('div', 'ic'), tx = el('div', 'tx'), tt = el('div', 'tt'), tb = el('div', 'tb'), ss = el('div', 'ss');
    ic.appendChild(icon(icons[x.kind]));
    tx.append(tt, tb);
    e.append(ic, tx, ss);
    return { el: e, tt, tb, ss, status: '' };
  }
  // icono a partir de primitivas [[tag, attrs], …] (viewBox 24); lo desconocido se ignora
  function icon(prims) {
    const s = svg();
    for (const p of Array.isArray(prims) ? prims : []) {
      if (!Array.isArray(p) || !ICON_TAGS.has(p[0]) || !p[1] || typeof p[1] !== 'object') continue;
      const e = document.createElementNS(SVG_NS, p[0]);
      for (const [k, val] of Object.entries(p[1])) if (ICON_ATTRS.has(k) && (typeof val === 'string' || typeof val === 'number')) e.setAttribute(k, String(val));
      s.appendChild(e);
    }
    if (!s.firstChild) { const c = document.createElementNS(SVG_NS, 'circle'); c.setAttribute('cx', '12'); c.setAttribute('cy', '12'); c.setAttribute('r', '4'); s.appendChild(c); }
    return s;
  }
  function setStatus(c, status) {
    c.status = status;
    c.el.dataset.status = status;
    if (status === 'run') c.ss.replaceChildren(el('div', 'spin'));
    else if (status === 'ok') { const s = svg(), p = document.createElementNS(SVG_NS, 'path'); p.setAttribute('d', CHECK_D); s.appendChild(p); c.ss.replaceChildren(s); }
    else c.ss.replaceChildren(el('div', 'x', '!'));
    if (status !== 'run') kick(PULSE.event);
  }

  // ── Accesibilidad: frases finales en role=log (no palabra a palabra) y fallos en role=alert
  function speak(v, t, live) {
    if (t.youFinal && t.you && !v.said.you) { v.said.you = true; say('Tú: ' + t.you); }
    if (!live && t.jota && !v.said.jota) { v.said.jota = true; if (t.error) warn(t.jota); else say('Jota: ' + t.jota); }
    for (const x of t.tools) if (x.status === 'fail' && !v.said.fails.has(x.id)) { v.said.fails.add(x.id); warn('No se pudo: ' + x.title + (t.hint ? '. ' + t.hint : '')); }
  }
  function say(text) {
    dom.sr.appendChild(el('p', null, text));
    while (dom.sr.childNodes.length > LOG_KEEP) dom.sr.firstChild.remove();
  }
  function warn(text) { dom.alert.textContent = text; }

  // ── Revelado palabra a palabra: un solo temporizador para toda la capa; primero tu frase, luego la respuesta
  function queue() {
    const v = last && last.turns.length ? turns.get(last.turns[last.turns.length - 1].id) : null;
    return v ? [v.you, v.jota] : [];
  }
  // el paso se recalcula con cada foto, pero solo se adelanta (si llegara antes cada 100 ms, nunca saldría ninguna palabra)
  function schedule() {
    if (!open) return;
    const pending = queue().reduce((n, ln) => n + pendingOf(ln), 0);
    if (!pending) { flushBy = 0; return; }
    const now = performance.now();
    let ms = WORD_MS, per = 1;
    if (!last.live) {
      // plazo fijo desde que el turno deja de estar en directo: el retraso de los temporizadores no lo alarga
      if (!flushBy) flushBy = now + FLUSH_MS;
      const left = Math.max(0, flushBy - now);
      ms = Math.min(WORD_MS, Math.max(MIN_TICK_MS, left / pending));
      per = left <= ms ? pending : Math.ceil(pending * ms / left);
      if (left === 0) ms = 0;
    } else {
      flushBy = 0;
      if (pending > FAST_AFTER) ms = Math.max(MIN_TICK_MS, WORD_MS * FAST_AFTER / pending);
    }
    const at = now + ms;
    if (revealT && revealAt <= at) return;
    clearTimeout(revealT);
    revealAt = at;
    revealT = setTimeout(() => { revealT = 0; reveal(per); schedule(); }, ms);
  }
  function reveal(n) {
    if (!dom) return;
    for (const ln of queue()) while (n > 0 && pendingOf(ln) > 0) { showNext(ln); n--; kick(PULSE.word); }
    wake();
  }

  // ── Motor de la membrana: un rAF que lee y luego escribe
  function kick(a) { if (!calmNow()) amp = Math.min(1, amp + a * PULSE.gain); wake(); }
  function wake() { stillFrames = 0; if (!raf && host) { lastT = 0; raf = requestAnimationFrame(frame); } }
  function frame(now) {
    raf = 0;
    if (!dom) return;
    const dt = lastT ? Math.min(MAX_DT, (now - lastT) / 1000) : 1 / 60;
    measureTier(lastT ? now - lastT : 0);
    lastT = now;
    const m = read();
    const settled = step(m, dt, now / 1000);
    write(m, now / 1000);
    if (settled && !morph) traveling = false;
    if (closing && settled && now - closedAt >= FADE_MS) return finish();
    if (settled && !closing) { if (++stillFrames >= SETTLE.frames) return; } else stillFrames = 0;
    raf = requestAnimationFrame(frame);
  }
  // LEER: todo lo que fuerza el cálculo de la página, antes de escribir nada
  function read() {
    const U = Math.min(innerWidth / 1920, innerHeight / 1080);
    const target = closing ? dom.orb.getBoundingClientRect() : dom.sheet.getBoundingClientRect();
    // el log se pega abajo (flex-end): lo que sobra sale por arriba y no cuenta en scrollHeight, así que se mide la caja
    const first = Array.prototype.find.call(dom.log.children, c => c.getClientRects().length > 0); // en la píldora, el anterior no se ve
    const over = !closing && !!first && first.getBoundingClientRect().top < dom.log.getBoundingClientRect().top - OVERFLOW_PX * U;
    // área segura (como --mx/--my): el cristal no la invade aunque el muelle se pase; si el contenido ya está fuera, se respeta
    const { x: sx, y: sy } = safeOf(U);
    const safe = { l: Math.min(target.left, sx), t: Math.min(target.top, sy), r: Math.max(target.right, innerWidth - sx), b: Math.max(target.bottom, innerHeight - sy) };
    return { U, target, over, safe };
  }
  // CALCULAR: muelles por borde y radio; devuelve si todo está quieto
  function step(m, dt, time) {
    const T = { l: m.target.left, t: m.target.top, r: m.target.right, b: m.target.bottom };
    if (seed) { edge = { ...T }; vel.l = vel.t = vel.r = vel.b = 0; seed = false; } // restaurada: ya en su caja
    if (drag && drag.on) { edge = { ...T }; vel.l = vel.t = vel.r = vel.b = 0; }      // arrastrando: pegada al contenido
    if (!edge) { const cx = (T.l + T.r) / 2, cy = (T.t + T.b) / 2; edge = { l: cx, t: cy, r: cx, b: cy }; } // nace del centro
    const calm = calmNow(), n = Math.max(1, Math.ceil(dt * SUBSTEP_HZ)), h = dt / n;
    let moving = false;
    for (const k of ['l', 't', 'r', 'b']) {
      let x = edge[k], vv = vel[k];
      const tg = T[k], grow = k === 'l' || k === 't' ? tg < x : tg > x;
      const S = traveling ? SPRING.travel : SPRING;
      const sp = calm ? S.calm : grow ? S.grow : S.shrink;
      for (let j = 0; j < n; j++) { vv += (sp.k * (tg - x) - sp.c * vv) * h; x += vv * h; }
      edge[k] = x; vel[k] = vv;
      if (Math.abs(tg - x) > SETTLE.px || Math.abs(vv) > SETTLE.v) moving = true;
    }
    const state = last ? last.state : 'done';
    amp *= Math.pow(PULSE.keep, dt);
    const L = PULSE.listen;
    // al cerrar no hay mínimo: la capa se asienta y se quita al acabar el fundido, no por el temporizador de seguridad
    const floor = calm || closing ? 0 : state === 'listen' ? L.base + L.depth * Math.sin(time * L.hz) : state === 'think' ? PULSE.think : 0;
    if (calm) amp = 0; else if (amp < floor) amp = floor;
    const want = closing ? (m.target.right - m.target.left) / 2 / m.U
      : last && last.form === 'pill' ? RADIUS_U.pill : state === 'listen' || state === 'think' ? RADIUS_U.open : RADIUS_U.rest;
    const rt = want * m.U;
    radius = radius ? radius + (rt - radius) * Math.min(1, dt * RADIUS_RATE) : rt;
    if (Math.abs(rt - radius) > SETTLE.px) moving = true;
    // la deriva sigue mientras algo se mueve o late; quieta (o al cerrar, o en calma) se apaga despacio hasta 0
    const lively = !calm && !closing && (moving || amp >= PULSE.rest);
    drift = Math.min(1, Math.max(0, drift + (lively ? 1 : -1) * WOBBLE.fade * dt));
    return !moving && !drag && !backAnim && amp < PULSE.rest && drift === 0;
  }
  // ESCRIBIR: geometría y radios del cristal, anillo del orbe y difuminado del log
  function write(m, time) {
    const mod = calmNow() ? 0 : WOBBLE.tier[dom.w.dataset.tier] || 0, slow = WOBBLE.slow * drift, rx = [], ry = [];
    for (let q = 0; q < 4; q++) {
      const slowX = slow * Math.sin(time * (WOBBLE.fx[0] + WOBBLE.fx[1] * q) + phase[q]);
      const shake = WOBBLE.kick * amp * Math.sin(time * WOBBLE.kickHz + phase[q + 4]);
      rx.push((radius * (1 + mod * (slowX + shake))).toFixed(1));
      ry.push((radius * (1 + mod * slow * Math.sin(time * (WOBBLE.fy[0] + WOBBLE.fy[1] * q) + phase[q + 4]))).toFixed(1));
    }
    const S = m.safe, l = Math.max(S.l, edge.l), t = Math.max(S.t, edge.t), r = Math.min(S.r, edge.r), b = Math.min(S.b, edge.b);
    const g = {
      left: l.toFixed(1) + 'px', top: t.toFixed(1) + 'px',
      width: Math.max(1, r - l).toFixed(1) + 'px', height: Math.max(1, b - t).toFixed(1) + 'px',
      borderRadius: rx.join('px ') + 'px / ' + ry.join('px ') + 'px',
    };
    for (const k in g) { dom.body.style[k] = g[k]; dom.halo.style[k] = g[k]; }
    dom.ring.style.transform = 'scale(' + (1 + amp * ORB_SCALE).toFixed(3) + ')';
    dom.ring.style.setProperty('--ring', amp.toFixed(2));
    if (dom.log.classList.contains('over') !== m.over) dom.log.classList.toggle('over', m.over);
  }
  // nivel automático: media del tiempo de frame en los primeros frames con la capa abierta (sin los primeros ni los saltos)
  function measureTier(ms) {
    if (!open || autoFrames >= AUTO_TIER.skip + AUTO_TIER.frames || !ms || ms > AUTO_TIER.gap) return;
    if (++autoFrames <= AUTO_TIER.skip) return;
    autoSum += ms;
    if (autoFrames < AUTO_TIER.skip + AUTO_TIER.frames) return;
    const avg = autoSum / AUTO_TIER.frames;
    autoNext = avg > AUTO_TIER.c ? 'C' : avg > AUTO_TIER.b ? 'B' : 'A';
  }
  // una medida a medias no sigue en la conversación siguiente (sería de dos momentos distintos)
  function dropPartialTier() { if (autoFrames < AUTO_TIER.skip + AUTO_TIER.frames) autoFrames = autoSum = 0; }

  // ── Abrir y cerrar
  function setOpen(on) {
    open = on;
    document.documentElement.classList.toggle('tv-agent-talk', on); // el reposo se atenúa (idle.css)
  }
  function finish() {
    clearTimeout(removeT); removeT = 0;
    endMorph();
    if (raf) cancelAnimationFrame(raf);
    raf = 0; closing = false;
    if (resizeObs) resizeObs.disconnect();
    if (host) host.remove();
    host = null; dom = null; edge = null; last = null; resizeObs = null; lastSig = ''; traveling = false;
    drag = null; hold = null; backAnim = null;
    turns.clear();
  }

  window.TVAgent = {
    render(o) {
      // script de documento nuevo: aún no hay documentElement; se pinta en cuanto lo haya
      if (!parentNow()) { waitForRoot(o); return true; }
      last = clean(o);
      // la forma que eligió el usuario arrastrando manda hasta que la foto la confirme (o pase DRAG.hold)
      if (hold && (last.form === hold.form || performance.now() > hold.until)) hold = null;
      if (hold) last.form = hold.form;
      const sig = JSON.stringify({ ...last, enter: '' }), fresh = !host || !host.isConnected, reopened = closing;
      restoring = fresh && last.enter === 'restore';
      clearTimeout(removeT); removeT = 0;
      ensure();
      if (closing) { closing = false; dom.sheet.classList.remove('gone'); }
      dom.halo.classList.remove('off'); dom.body.classList.remove('off');
      setOpen(true);
      const tier = dom.w.dataset.tier;
      apply(last);
      restoring = false;
      schedule();
      // la misma foto (llega cada ~100 ms) no despierta una membrana asentada; las palabras y las cajas ya la despiertan
      if (fresh || reopened || sig !== lastSig || dom.w.dataset.tier !== tier) wake();
      lastSig = sig;
      return true;
    },
    hide() {
      clearTimeout(revealT); revealT = 0; flushBy = 0;
      if (waiting) { waiting.mo.disconnect(); waiting = null; }
      setOpen(false);
      dropDrag();
      hold = null;
      endMorph();                 // cerrada ya: la forma pendiente se pone sin paso
      dropPartialTier();
      if (!host) return;
      closing = true; closedAt = performance.now();
      dom.sheet.classList.add('gone');
      dom.halo.classList.add('off'); dom.body.classList.add('off');
      wake();
      clearTimeout(removeT);
      removeT = setTimeout(finish, REMOVE_SAFETY_MS);
    },
    // la membrana deja pasar el puntero (on) o vuelve a recibirlo: el servidor la aparta mientras Jota pulsa por
    // coordenadas (tv_click_at), que tiene que llegar a la web aunque caiga debajo del panel o de la píldora
    pass(on) { if (dom) setFlag(dom.w, 'data-pass', !!on); return true; },
    // topLayer: la capa está en la capa superior (se ve encima de un vídeo a pantalla completa); sin popover, false
    // form: la que se ve (durante el paso, la de antes hasta el cambio); morph: fase del paso de forma o ''; drag: se arrastra
    _debug() {
      return { open, tier: dom ? dom.w.dataset.tier : tierNow(), rafRunning: !!raf, topLayer: topLayer() && lifted(),
        form: dom ? dom.w.dataset.form || '' : '', morph: morph ? morph.phase : '', drag: !!(drag && drag.on) };
    },
  };
  // espera a que el documento tenga raíz (el script de documento nuevo corre antes); la última foto que llegue es la que vale
  function waitForRoot(o) {
    if (waiting) { waiting.o = o; return; }
    const mo = new MutationObserver(() => {
      if (!parentNow()) return;
      const w = waiting; waiting = null; mo.disconnect();
      window.TVAgent.render(w.o);
    });
    waiting = { o, mo };
    mo.observe(document, { childList: true, subtree: true });
  }
  loadFonts();
  // al entrar en pantalla completa el navegador cierra los popovers y lo de pantalla completa queda encima: se sube otra vez
  document.addEventListener('fullscreenchange', () => { if (host) { ensure(); lift(true); wake(); } });
  addEventListener('resize', () => wake());
})();
