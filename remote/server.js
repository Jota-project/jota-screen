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
const createStage = require('./src/features/stage');
const createKeyboard = require('./src/features/keyboard');
const createControl = require('./src/features/control');
const createSpotify = require('./src/features/spotify');
const createIdle = require('./src/features/idle');
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
  onDown() { tv.clearPage(); keyboard.focusSet(null); broadcast(); },
  onActivating() { keyboard.focusSet(null); },
  onAttached(t) {
    if (t) { state.title = t.title; state.url = t.url; }
    spotify.page.attached();
    keyboard.watchFocus();
    broadcast();
  },
  onPage(t) {
    if (t.url !== state.url) idle.onNav(t.url);
    state.title = t.title; state.url = t.url; broadcast();
    spotify.page.changed(t.url); // al cambiar de página dentro de Spotify (o llegar a él) se repasa el retoque
  },
  onActiveGone(hasNext) { keyboard.focusSet(null); if (!hasNext) broadcast(); },
  onDetached() { keyboard.focusSet(null); broadcast(); },
  onBinding(name, payload) { // aviso de foco desde la página (solo de la sesión activa)
    if (name === '__tvFocus') { try { keyboard.focusSet(JSON.parse(payload)); } catch {} }
  },
} });
const pointer = createPointer({ script: path.join(ROOT, 'pointer.py'), display: CFG.DISPLAY, disabled: NO_POINTER, log });
const audio = createAudio({ runtimeDir: CFG.XDG_RUNTIME_DIR });
const pagePoll = createPagePoll({ cdp, state, broadcast, watched: () => ws.clients().size > 0 });

// ───────────────────────── acceso: token maestro, dispositivos, roles y emparejamiento
const tvPair = createPairScreen(cdp); // el código de emparejar se pinta encima de lo que haya en la tele
acc = createAccess({ files: CFG.FILES, adminUrl: CFG.ADMIN_URL, log, sessions: sessions.forAccess, tv: tvPair });
const limiter = createRateLimiter({ max: 5, ms: 60_000 }); // 5 fallos -> 60 s bloqueada esa IP

// ───────────────────────── capacidades
const keyboard = createKeyboard({ cdp, log, clients: ws.clients, devOf });
const stage = createStage({ cdp, state, cfg: CFG, nav: u => control.nav(u) });
const control = createControl({ cdp, state, broadcast, key: keyboard.key, audio, cfg: CFG, leaveStage: () => stage.leave() });
const spotify = createSpotify({ cdp, cfg: CFG, log, clients: ws.clients, idle: () => idle });
const idle = createIdle({
  PUB, SELF, file: CFG.FILES.idle, place: CFG.PLACE, cdp, nav: control.nav, state, onWatch: () => spotify.now.poll(5000).then(n => idle.setMusic(n)),
  stageKind: () => stage.stage.kind, onAmbient: () => broadcast(), log: log.info,
});
// J Gateway (voz): sin TV_GATEWAY_URL el cliente no se crea y todo se comporta como un Gateway caído
const gw = CFG.GATEWAY_URL
  ? createGatewayClient({ url: CFG.GATEWAY_URL, key: CFG.GATEWAY_KEY, agent: CFG.AGENT, log })
  : { ensure: async () => false, send() {}, on: () => () => {}, audio() {}, end() {}, isReady: () => false, close() {} };
const speaker = createSpeaker({ runtimeDir: CFG.XDG_RUNTIME_DIR, cmd: CFG.SPEAKER_CMD, log });
const talk = createTalk({ gw, cfg: CFG, media: () => state.media, speaker, log });

// ───────────────────────── órdenes: cada una con su permiso al lado, en su capacidad
const commands = createCommands({ permsOf: acc.permsOf, onUse: () => idle.touch(), log });
for (const list of [talk.commands, stage.commands, keyboard.commands, control.commands, spotify.commands, idle.commands,
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
    ...createApiRoutes({ limiter, auth: acc, run, publicState, stage, agentBusy: () => talk.busy() }),
    ...createPairRoutes({ acc, limiter, adminOnline: () => sessions.adminSockets().length > 0, tvReady: tvPair.ready }),
    ...spotify.httpRoutes({ ...limiter, okToken: acc.okToken }),
    manifestRoute(statics, acc.tokenDev),
    ...stage.routes,
    ...idle.routes,
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
    publicState(), meOf(sock), keyboard.focusFor(sock),
    ...(acc.permsOf(devOf(sock)).admin ? acc.pairing.pendingAsks().map(p => ({ t: 'pairreq', ...p })) : []), // peticiones de acceso pendientes
  ],
});

// ───────────────────────── arranque
acc.start();
listen({ port: PORT, handler, onUpgrade, log });
ws.start();
pagePoll.start();
cdp.connect();
pointer.start();
control.volRead();
process.on('SIGTERM', () => process.exit(0));
