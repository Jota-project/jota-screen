'use strict';
// Mando web para la tele: raíz de composición. Aquí solo se crean las piezas, se conectan entre sí y se arrancan.
// HTTP + WebSocket  ->  Chrome (CDP: teclas, texto, navegación)  +  puntero X real (pointer.py)  +  volumen (wpctl)
// Escucha solo en loopback, red privada y Tailscale. Todo requiere token (fichero token en TV_STATE_DIR).
//
//   src/core/       configuración, carpeta de estado, registro con redacción, almacén JSON, estado de la tele
//   src/auth/       token maestro, dispositivos, roles, emparejar, permisos y freno de intentos
//   src/tv/         adaptadores de la tele: Chrome (CDP), puntero, volumen, sondeo de la página, tokens de la isla
//   src/features/   capacidades, cada una con sus órdenes (y rutas, si las tiene)
//   src/transport/  registro de órdenes, HTTP (rutas y estáticos), WebSocket, sesiones de los mandos

const path = require('node:path');
const { loadConfig } = require('./src/core/config');
const { prepareStateDir } = require('./src/core/state-dir');
const { createLog } = require('./src/core/log');
const { createTvState } = require('./src/core/tv-state');
const { createRateLimiter } = require('./src/auth/ratelimit');
const { createAccess } = require('./src/auth/access');
const createAccessCommands = require('./src/auth/commands');
const createPairRoutes = require('./src/auth/pair-http');
const { createCdp } = require('./src/tv/cdp');
const { createPointer, createAudio, createPairScreen } = require('./src/tv/devices');
const { createPagePoll } = require('./src/tv/page-poll');
const { createGatewayClient } = require('./src/gateway/client');
const createTalk = require('./src/features/talk');
const { createSpeaker } = require('./src/tv/speaker');
const { createTalkView } = require('./src/tv/talk-view');
const { FORM_BINDING } = require('./src/tv/agent-contract');
const { stageOf } = require('./src/tv/agent-form');
const createStage = require('./src/features/stage');
const createKeyboard = require('./src/features/keyboard');
const createControl = require('./src/features/control');
const createSpotify = require('./src/features/spotify');
const createIdle = require('./src/features/idle');
const createNetflix = require('./src/features/netflix');
const { createWatch, intentOf } = require('./src/features/netflix-watch');
const createYoutube = require('./src/features/youtube');
const { createJsonStore } = require('./src/core/json-store');
const { createCommands } = require('./src/transport/commands');
const { createSessions } = require('./src/transport/sessions');
const { createWs } = require('./src/transport/ws');
const { createHttp } = require('./src/transport/http');
const { createStatic, manifestRoute } = require('./src/transport/static');
const createApiRoutes = require('./src/transport/api');
const { listen } = require('./src/transport/listen');

const CFG = loadConfig();
const { ROOT, PUB, PORT, CDP_PORT, DEBUG, NO_POINTER, SELF } = CFG;

// ───────────────────────── base: registro, conexiones de los mandos y estado de la tele
let acc = null; // el acceso se crea un poco más abajo; quien lo usa antes, lo hace al llamar
// registro con redacción: el token maestro, la clave del Gateway, los ?t= y los Bearer nunca llegan al journal
const log = createLog({ secrets: () => [...(acc ? [acc.masterToken()] : []), ...(CFG.GATEWAY_KEY ? [CFG.GATEWAY_KEY] : [])], debug: DEBUG });
// antes de leer nada: la carpeta de estado (0700) con lo que hubiera en las ubicaciones antiguas
prepareStateDir(CFG, log.info);
const ws = createWs();
const sessions = createSessions({ clients: ws.clients, acc: () => acc });
const { devOf, meOf } = sessions;
let cdp = null;
// el ambiente lo pone el reposo, que se crea más abajo (solo se pide al difundir, cuando ya existe)
const tv = createTvState({ cdpUp: () => !!(cdp && cdp.ready && cdp.session), clients: ws.clients, ambient: () => idle.ambient() });
const { state, publicState, broadcast } = tv;

// ───────────────────────── Chrome (CDP): lo que pasa en la pestaña activa se reparte entre las capacidades
// (los ganchos solo se disparan tras cdp.connect(), al final, cuando todas las capacidades ya existen)
cdp = createCdp({ port: CDP_PORT, log, hooks: {
  onDown() { tv.clearPage(); pagePoll.reset(); keyboard.focusSet(null); talkView.reset(); broadcast(); },
  onActivating() { keyboard.focusSet(null); },
  onAttached(t, from) {
    if (t && t.url !== state.url) idle.onNav(t.url); // otra pestaña delante (Netflix o la de siempre): la isla y el ambiente se repasan
    if (t) { state.title = t.title; state.url = t.url; }
    pagePoll.reset(); // otra pestaña: la reproducción se mide desde cero…
    // …y la conversación se vuelve a inyectar en ella: con la capa a la vista, ya, tal como se ve en la que se deja (`from`,
    // desde cdp.show, que espera a que esté pintada antes de traer la pestaña al frente)
    const painted = talkView.reset({ tab: true, from });
    spotify.page.attached();
    keyboard.watchFocus();
    broadcast();
    return painted;
  },
  onLeft(call) { return talkView.leave(call); }, // la pestaña que se deja (ya detrás): su capa se quita en seco
  onPage(t) {
    const moved = t.url !== state.url;
    state.title = t.title; state.url = t.url;  // antes de los avisos: la conversación decide su formato con la URL nueva
    if (moved) {
      if (!t.url.startsWith(SELF + '/')) stage.leave(); // fuera del escenario (también por «atrás» o un clic): ni su cierre programado
      idle.onNav(t.url); pagePoll.reset(); talkView.reset();
    }
    broadcast();
    spotify.page.changed(t.url); // al cambiar de página dentro de Spotify (o llegar a él) se repasa el retoque
  },
  onActiveGone(hasNext) { keyboard.focusSet(null); if (!hasNext) broadcast(); },
  onDetached() { keyboard.focusSet(null); broadcast(); },
  onBinding(name, payload) { // avisos desde la página (solo de la sesión activa)
    if (name === '__tvFocus') { try { keyboard.focusSet(JSON.parse(payload)); } catch {} }
    if (name === FORM_BINDING) talkView.fromPage(payload); // la capa del agente arrastrada con el puntero de la tele
  },
} });
const pointer = createPointer({ script: path.join(ROOT, 'pointer.py'), display: CFG.DISPLAY, disabled: NO_POINTER, log });
const audio = createAudio({ runtimeDir: CFG.XDG_RUNTIME_DIR });
// con la capa del agente (diseño nuevo) a la vista sondea también sin mandos: de ahí sale el paso del panel a la píldora
const pagePoll = createPagePoll({ cdp, state, broadcast, watched: () => ws.clients().size > 0,
  active: () => talkView.watching(), onPlayback: on => talkView.playback(on) });

// ───────────────────────── acceso: token maestro, dispositivos, roles y emparejamiento
const tvPair = createPairScreen(cdp); // el código de emparejar se pinta encima de lo que haya en la tele
acc = createAccess({ files: CFG.FILES, adminUrl: CFG.ADMIN_URL, log, sessions: sessions.forAccess, tv: tvPair });
const limiter = createRateLimiter({ max: 5, ms: 60_000 }); // 5 fallos -> 60 s bloqueada esa IP

// ───────────────────────── capacidades
const keyboard = createKeyboard({ cdp, log, clients: ws.clients, devOf });
const stage = createStage({ cdp, state, cfg: CFG, nav: u => control.nav(u) });
const pause = ms => new Promise(r => setTimeout(r, ms));
const netflix = createNetflix({ cdp, cfg: CFG, store: createJsonStore(CFG.FILES.netflix, { fallback: {} }), log: log.info, onLeave: () => nfxWatch.soon(),
  // con la conversación en el panel: la tarjeta de la serie, un respiro para verla y su ▶; luego Netflix al frente
  beforePlay: async t => {
    const card = nfxWatch.media('play', t);
    if (!card || !talkView.media(card)) return;
    await pause(1100); talkView.mediaState('press'); await pause(450);
  } });
// «Seguir viendo» e historial de Netflix: lo lee una pestaña oculta de vez en cuando; lo usan el reposo y el agente
const nfxWatch = createWatch({ cdp, netflix, store: createJsonStore(CFG.FILES.watching, { fallback: {} }), log: log.info, onChange: () => idle.nfxChanged(), self: SELF });
netflix.extend({ ...nfxWatch.ops,
  // «¿qué estoy viendo?»: además de la respuesta para el agente, la lista con sus imágenes en la conversación
  watching: m => {
    // «¿por dónde voy de X?»: la tarjeta grande de esa serie (la que diga el agente o, si no, la que se nombra en la
    // pregunta); si no, la lista de lo que está a medias
    const it = m.title ? { title: m.title } : nfxWatch.named(talkView.asked());
    const one = it ? nfxWatch.media('play', it) : null;
    const card = one || nfxWatch.media('list'), shown = !!card && talkView.media(card);
    log.info(`netflix: «qué estoy viendo»${m.title ? ' de «' + m.title + '»' : ''} (tarjeta en la conversación: ${shown ? 'sí' : card ? 'no, la capa no la admite ahora' : 'no, sin datos'})`);
    return nfxWatch.watching(m.title);
  },
  // «¿qué he visto últimamente?»: además de los días, las últimas series con sus imágenes en la conversación
  history: () => {
    const card = nfxWatch.media('recent'), shown = !!card && talkView.media(card);
    log.info(`netflix: «qué he visto» (tarjeta en la conversación: ${shown ? 'sí' : card ? 'no, la capa no la admite ahora' : 'no, sin datos'})`);
    return nfxWatch.history();
  },
  // «¿qué es lo último que estaba viendo?»: la respuesta y su tarjeta con el ▶ sin pulsar (no se pone nada)
  last: () => {
    const r = nfxWatch.last(), card = r.error ? null : nfxWatch.media('play', r), shown = !!card && talkView.media(card);
    log.info(`netflix: «lo último que veía»: ${r.title || r.error}${shown ? ' (tarjeta en la conversación)' : ''}`);
    return r;
  },
  play_last: async () => {
    const r = await nfxWatch.playLast();
    log.info(`netflix: «ponme lo último»: ${r.error || r.last}`);
    return r;
  } });
// YouTube: el vídeo se busca en una pestaña de fondo y se pone en la de siempre (por control.nav); con la conversación en
// el panel, antes su tarjeta con la miniatura y su ▶. La búsqueda ya ha llevado su rato: se navega en cuanto la tarjeta
// se ve, y el ▶ se pulsa mientras YouTube carga (el reposo, con la tarjeta, sigue a la vista hasta que se pinta)
const youtube = createYoutube({ cdp, nav: u => control.nav(u), key: k => keyboard.key(k), self: SELF, log: log.info,
  beforePlay: async card => {
    if (!talkView.media(card)) return;
    setTimeout(() => talkView.mediaState('press'), 700).unref?.();
    await pause(400);
  } });
// tv_open / tv_open_app con `layout`: Jota elige el formato de la conversación para la página que abre. Abrir la misma
// URL (o recargar) es un documento nuevo sin cambio de URL: onPage no lo ve y se avisa desde aquí
const control = createControl({ cdp, state, broadcast, key: keyboard.key, audio, cfg: CFG, leaveStage: () => stage.leave(), netflix,
  onLayout: (url, layout) => talkView.agentLayout(layout, url), onNavigate: () => talkView.navigating(), onReload: () => { pagePoll.reset(); talkView.reset(); } });
const spotify = createSpotify({ cdp, cfg: CFG, log, clients: ws.clients, idle: () => idle });
const idle = createIdle({
  PUB, SELF, file: CFG.FILES.idle, place: CFG.PLACE, cdp, nav: control.nav, state, onWatch: () => spotify.now.poll(5000).then(n => idle.setMusic(n)),
  stageKind: () => stage.stage.kind, onAmbient: () => broadcast(), log: log.info, nfx: () => nfxWatch.forIdle(),
});
// J Gateway (voz): sin TV_GATEWAY_URL el cliente no se crea y todo se comporta como un Gateway caído
const gw = CFG.GATEWAY_URL
  ? createGatewayClient({ url: CFG.GATEWAY_URL, key: CFG.GATEWAY_KEY, agent: CFG.AGENT, log })
  : { ensure: async () => false, send() {}, on: () => () => {}, audio() {}, end() {}, isReady: () => false, close() {} };
const speaker = createSpeaker({ runtimeDir: CFG.XDG_RUNTIME_DIR, cmd: CFG.SPEAKER_CMD, log });
// la conversación en la tele: isla con vídeo, panel sin él (se inyecta una vez por página). `context` se lee en cada
// pintada: el diseño (v1 tv-talk.js, v2 tv-agent.js, interruptor `agentDesign` del reposo) y el contexto de la página.
// v2: `page` (URL, escenario, reposo) decide el formato (src/tv/agent-form.js: app de contenido → píldora) y `playback`
// (vídeo grande que avanza, de page-poll; no `media`, que salta con un tráiler) es la reserva y el tinte. El escenario
// sale de la URL (stageOf), no de stage.kind: se sale de él también sin control.nav («atrás», un clic)
const agentCtx = () => {
  const a = idle.agentContext(), pb = state.playback === true;
  return { design: a.design, ctx: pb ? 'video' : a.idle ? (a.music ? 'music' : 'idle') : 'web', playback: pb,
    page: { url: state.url || '', stage: stageOf(state.url, SELF), idle: a.idle },
    night: a.night, calm: a.calm, glass: a.glass, colors: a.colors };
};
// la pregunta del turno, ya final: si es por lo que se ve en Netflix, su tarjeta al momento (sin esperar al agente)
const talkView = createTalkView({ cdp, pub: PUB, log: log.info, context: agentCtx, onAsk: text => {
  const i = intentOf(text, nfxWatch.named(text));
  if (!i) return;
  const card = i.kind === 'play' ? nfxWatch.media('play', i) : i.kind === 'last' ? (r => (r.error ? null : nfxWatch.media('play', r)))(nfxWatch.last())
    : nfxWatch.media(i.kind === 'recent' ? 'recent' : 'list');
  const shown = !!card && talkView.media(card);
  log.info(`netflix: pregunta reconocida (${i.kind}): tarjeta en la conversación: ${shown ? 'sí' : card ? 'no, la capa no la admite ahora' : 'no, sin datos'}`);
} });
const talk = createTalk({ gw, cfg: CFG, media: () => state.media, view: talkView, speaker, log });

// ───────────────────────── órdenes: cada una con su permiso al lado, en su capacidad
const commands = createCommands({ permsOf: acc.permsOf, onUse: () => idle.touch(), log });
// abrir Netflix o poner un título cambia de pestaña sin pasar por control.nav: la conversación espera igual a verla pintada
const netflixCommands = netflix.commands.map(c => ({ ...c, run: (/** @type {any} */ m, /** @type {any} */ ctx) => {
  if (m && (m.op === 'open' || m.op === 'play')) talkView.navigating();
  return c.run(m, ctx);
} }));
for (const list of [talk.commands, netflixCommands, youtube.commands, stage.commands, keyboard.commands, control.commands, spotify.commands, idle.commands,
  createAccessCommands({ acc, meOf }), tv.commands]) commands.register(list);

/** Una orden del mando (sock), de la API o del MCP (ctx.dev), con los permisos de su dispositivo. */
async function run(m, sock, ctx = {}) {
  if (!m || typeof m !== 'object') return { error: 'mensaje no válido' };
  const dev = sock ? devOf(sock) : ctx.dev || null;
  if (sock && sock.devId && !dev) return { error: 'acceso retirado' };
  return commands.dispatch(m, { dev, ws: sock });
}

// ───────────────────────── transporte: HTTP (rutas + estáticos) y WebSocket
// {{TV_NAME}} en el HTML y el manifiesto; secure: el mando abierto por http salta a la URL https (micrófono para la voz)
const statics = createStatic({ dir: PUB, vars: { TV_NAME: CFG.NAME }, secure: CFG.PUBLIC_URL });
const handler = createHttp({
  routes: [
    ...createApiRoutes({ limiter, auth: acc, run, publicState, stage, agentBusy: () => talk.busy() || talk.speaking() }),
    ...createPairRoutes({ acc, limiter, adminOnline: () => sessions.adminSockets().length > 0, tvReady: tvPair.ready }),
    ...spotify.httpRoutes({ ...limiter, okToken: acc.okToken }),
    manifestRoute(statics, acc.tokenDev),
    ...stage.routes,
    ...idle.routes,
    ...nfxWatch.routes,
    ...youtube.routes,
  ],
  fallback: statics.serve,
});
const onUpgrade = ws.wire({
  log, limiter, auth: acc, run,
  local: { '/idle-ws': (req, socket, head) => idle.upgrade(req, socket, head) }, // datos de la pantalla en reposo
  onStageSocket: stage.onSocket,
  onBinary: talk.onBinary,
  onClose: talk.onClose,
  onLine(s) {
    idle.touch();
    if (s.charCodeAt(0) === 119) pagePoll.soon();  // "w": scroll desde el mando, el carril se sondea más a menudo
    pointer.line(s);                                 // "m dx dy", "w dx dy", "c 1", "b 1 1"...
  },
  greet: sock => [
    publicState(), meOf(sock), keyboard.focusFor(sock), ...talk.greet(sock), // el móvil del intercambio que vuelve: su control de formato
    ...(acc.permsOf(devOf(sock)).admin ? acc.pairing.pendingAsks().map(p => ({ t: 'pairreq', ...p })) : []), // peticiones de acceso pendientes
  ],
});

// ───────────────────────── arranque
acc.start();
listen({ port: PORT, handler, onUpgrade, log });
ws.start();
pagePoll.start();
cdp.connect();
nfxWatch.start();                                     // primera lectura al minuto; después, cada 3 h y tras ver Netflix
pointer.start();
control.volRead();
process.on('SIGTERM', () => process.exit(0));
