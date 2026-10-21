# Arquitectura

jota-screen es la pantalla del ecosistema Jota: un Chrome en modo kiosco en un equipo Linux con X, en la salida de
vídeo que diga la configuración (una tele, un monitor, un kiosco). Su nombre visible es `TV_NAME` («Pantalla» por
defecto). Se maneja desde un mando web en el móvil (PWA), desde el agente Jota (J Gateway) y desde Claude por el MCP
`tv-canvas`. Cuando nadie la usa enseña la pantalla en reposo; encima de cualquier web pueden salir Live Activities y
avisos; el agente puede poner contenido en el escenario; la música va por Spotify (spotifyd como altavoz Connect con el
nombre de la pantalla + Web API).

Cómo se hacen los cambios habituales: [como-se-hace.md](como-se-hace.md). Pruebas: [test/README.md](../test/README.md).

## Visión general

```
  Móvil (mando PWA)                     Jota · Claude
  index.html + mando/*.js               MCP tv-canvas (mcp/server.js, stdio)
     │ /ws?t=… (órdenes JSON y puntero)    │ POST /api/cmd, GET /api/state, /api/events
     │ /pair/*  · estáticos                │ (Bearer: token maestro o de un dispositivo)
     │ LAN: mando.local (nginx) · fuera: TV_PUBLIC_URL (p. ej. Tailscale HTTPS)
     ▼                                     ▼
 ┌──────────────── servicio jota-screen · remote/server.js (Node, :8787) ────────────────┐
 │ transport/ (HTTP, WS) ──► commands.dispatch(m) ──► permiso ─► clamp ─► capacidad.run   │
 │ auth/ (tokens, roles, emparejar)   features/ (control, keyboard, stage, spotify, idle, talk)
 └──┬────────────────┬──────────────┬────────────────┬────────────────────┬───────────────┘
    │ CDP :9222      │ pointer.py   │ wpctl          │ Web API Spotify    │ J Gateway (WS)
    │ (127.0.0.1)    │ (XTest)      │ (PipeWire)     │ (PKCE)             │ (texto y voz)
    ▼                ▼              ▼                ▼                    ▼
 Chrome kiosco ◄── puntero X     volumen        spotifyd (TV_NAME) ──► suena por la tele
  ├ idle.html (reposo) ◄──────── /idle-ws  (solo desde la tele)
  ├ tpl-*.html, /stage/p*.html ◄ /stage-ws (solo desde la tele)
  └ cualquier web + isla tv-island.js y avisos, inyectados por CDP
```

El kiosco es la unidad de sistema `jota-screen-kiosk` (Xorg en tty1 con `kiosk-session.sh` como el usuario de la
pantalla): pone la salida y el modo (`TV_DISPLAY_*` o lo que detecte xrandr), arranca openbox y Chrome con
`--remote-debugging-port=$TV_CDP_PORT` solo en 127.0.0.1 y el perfil en `$TV_STATE_DIR/chrome-profile`, abriendo
`home.html#port=…&name=…[&home=…]`, que enseña la hora y salta a la página de inicio (`TV_HOME_URL`, por defecto
`http://127.0.0.1:8787/idle.html`) en cuanto el servidor responde. `mdns-alias.sh` (unidad `jota-screen-mdns`)
publica `TV_MDNS_NAME` (`mando.local`) en la interfaz de la ruta por defecto (o `TV_NET_IFACE`) y el proxy que el
instalador genera desde `remote/nginx-mando.conf` lo lleva al puerto del servidor. Los scripts de bash comparten
`scripts/lib.sh` (leer `screen.env`, detectar salida, modo, interfaz y Chrome, rellenar plantillas).

## Estructura

```
remote/
  server.js               raíz de composición: crea las piezas, las conecta y arranca (nada más)
  idle.js                 núcleo del reposo y de las Live Activities: idle.json, /idle-ws, isla por CDP, carátulas
  nowplaying.js           «ahora suena» de Spotify: un solo estado para reposo, mando y agente; consulta con calma
  admin-link.js           CLI en el servidor: enlace/código de admin de un solo uso (orden adminlink)
  pointer.py              puntero X real (XTest): lee «m dx dy», «w dx dy», «c 1», «b 1 1» por stdin
  nginx-mando.conf        plantilla del proxy http://<TV_MDNS_NAME> → 127.0.0.1:<TV_PORT> (sin access_log: las URLs llevan ?t=)
  src/core/
    config.js             único lector de process.env: TV_*, puertos, URLs, rutas del estado (FILES) y las antiguas (LEGACY)
    state-dir.js          crea TV_STATE_DIR (0700) y mueve allí el estado de las ubicaciones antiguas al arrancar
    log.js                registro con redacción (token maestro, ?t=, ?token=, Bearer)
    json-store.js         readJson / writeJson (atómico, 0600) / createJsonStore
    tv-state.js           estado público de la tele (con `amb`, el ambiente del reposo), broadcast agrupado (30 ms) y la orden `state`
  src/auth/
    permissions.js        roles, permisos por defecto, políticas con nombre y check()
    access.js             token maestro, dispositivos (solo hash), ajustes de acceso, emparejar, enlaces de admin
    commands.js           órdenes de acceso: devices, revoke, role, extend, rename, kickguests, pairanswer, adminlink, access, me
    pair-http.js          rutas /pair/* (info, start, confirm, poll, me, admin)
    ratelimit.js          freno de intentos por IP
  src/tv/
    cdp.js                adaptador de Chrome (CDP): pestaña activa, call/fire, ganchos, reconexión
    devices.js            puntero, volumen (wpctl), sonda de la página y el código de emparejar pintado en la tele
    page-poll.js          sondeo de vídeo y scroll con mandos conectados; `playback` (vídeo grande que avanza) también con la capa
                          del agente (v2) a la vista
    agent-contract.js     lo que el servidor y tv-agent.js dicen igual: valores de la foto, fuentes propias y el binding del arrastre
    agent-form.js         formato de la capa del agente (`formFor`/`decideForm`), apps de contenido (`CONTENT_HOSTS`), alcance
    tokens.js             lee shared/tokens-tv.css y arma la fuente de la isla (tokens delante)
  src/features/           capacidades: cada una devuelve sus `commands` (y `routes`, si tiene)
    control.js            nav (con `layout` opcional), links, clicktext, click, home, back, forward, reload, shot, pp, seek, fs, vol, volset
    keyboard.js           key, text, field (escribir en directo), focus (aviso de foco)
    stage.js              present, show, stage, close, toast; ruta /stage/p*.html; canal /stage-ws
    spotify.js            spotify (todas las acciones), spwatch; rutas /spotify/login y /spotify/callback
    idle.js               envoltorio de remote/idle.js: activity, idle; ruta /idle/art
    talk.js               ask, vstart, vend, vcancel, stop, hide, talkform: hablar con Jota por el J Gateway, un turno a la vez; la voz sube
                          en directo y la respuesta vuelve por el mismo WS del mando (`talk`); suena en la tele, en el móvil o en
                          ninguno. La tele quita la conversación 5 s después del audio (o del texto, si no sonó). `stop` cancela el
                          turno en el Gateway (`cancel`) y corta el audio; `hide` solo la quita; `vstart`/`ask` con `interrupt`
                          paran lo que haya y siguen (sin él, BUSY mientras hay turno o Jota habla). Interrumpe este servidor:
                          el barge-in del Gateway sigue desactivado. Las llamadas a herramientas del turno van a la tele como fichas.
                          `talkform` cambia el formato de la capa (v2) y el móvil recibe `ev:'form'`
    agent-ui.js           fichas de herramientas del agente: lista cerrada (`CARD_TOOLS`, por sufijo), `toolCard`, tipos e iconos
                          (`KINDS`); `layoutOf` (el `layout` de tv_open / tv_open_app) y `opensPage` (la herramienta pone otra página)
  src/gateway/
    client.js             cliente WS del J Gateway: ensure, send, audio, end, cancel y eventos (partial, final, token, tool, audio, turn_end, down)
  src/tv/ (voz)
    speaker.js            altavoz de la tele: PCM sin cabecera a `TV_SPEAKER_CMD`; onIdle cuando acaba de sonar
    talk-view.js          lo que se dice y la respuesta, pintado en la tele (isla o panel); hide() y onHide; diseño v1 o v2;
                          en v2, formato (userForm, agentLayout, onForm), scripts de documento nuevo y binding del arrastre
  src/transport/
    commands.js           registro de órdenes y dispatch() (patrón Command)
    http.js               tabla de rutas; si ninguna encaja, estáticos
    http-util.js          send, json, readBody con tope, cookie tvt, reqToken, clientIp, isLocalTV
    static.js             public/ en memoria (gzip, ETag), {{TV_NAME}} en HTML y manifiesto, CSP por página, caché, nombres reservados
    api.js                /api/state, /api/events, /api/cmd
    ws.js                 /ws del mando, canales locales de la tele, latido de 20 s
    sessions.js           sockets vistos como sesiones de dispositivo (lo que access.js necesita)
    listen.js             escucha en bucle local, red privada y Tailscale
  public/
    index.html            esqueleto del mando: hojas, botones, un modulepreload por módulo
    manifest.webmanifest, icon-*.png
    mando/theme.js        script clásico del <head>: pone el tema antes de pintar
    mando/app.js          registra los descriptores de features y llama a los init()
    mando/core/           dom, store (estado, ajustes, avisos), api (WebSocket, rpc, handle, onWs, setGate), perms
    mando/ui/             haptics, pill, theme, status, sheets, actions, gestures
    mando/features/       ambient, controls, trackpad, keyboard, go, agent, voice, pcm-player, mic-worklet, spotify, spotify-lists, spotify-state, pair, admin, settings, idle
    mando/styles/mando.css  estilos del mando (v3: glifos flotantes, luces en órbita, voz, ahora suena y teclado)
    tv-talk.js            capa de la tele con la conversación (la pinta talk-view.js; diseño v1)
    tv-agent.js           paneles vivos del agente: cristal, orbe y fichas (diseño v2; la pinta talk-view.js)
    fonts/                fuentes propias de la capa del agente (Fraunces, OFL), mandadas como bytes con la fuente
    idle.html, idle.css, idle-app.js   pantalla en reposo (sin nada en línea)
    shared/tokens-tv.css  tokens Jota Dusk de la tele (reposo e isla)
    shared/tokens-mando.css  tokens Jota Dusk del mando (oscuro y claro), alineados con los de la tele
    tv-island.js          isla de Live Activities (reposo y, por CDP, cualquier web)
    tv-stage.js           runtime de las páginas del escenario: tv.onData, tv.emit, tv.close
    stage.css, tpl-tasks.html, tpl-reminder.html, tpl-slides.html   plantillas del escenario
mcp/server.js             MCP tv-canvas: 22 herramientas tv_* sobre /api (TV_URL, TV_TOKEN o el token de TV_STATE_DIR)
plugin/tv-canvas/         plugin de Claude Code: copia del MCP (scripts/sync-plugin.sh) y la skill
config/screen.env.example plantilla de la configuración (~/.config/jota-screen/screen.env)
kiosk-session.sh, home.html, mdns-alias.sh   sesión X del kiosco, su portada y el alias mDNS
scripts/                  install.sh, update.sh, doctor.sh, cdp.js (depurar por CDP), lib.sh (común), spotifyd-run.sh, sync-plugin.sh
systemd/                  plantillas: user/jota-screen{,-mdns,-spotify}.service, system/jota-screen-kiosk.service
e2e/                      capturas con Playwright del reposo y del mando, y mando-compara.py
test/                     contrato (servidor real aislado), unitarias y helpers (servidor, Chrome falso, fetch-spy)
```

## El patrón

**Servidor.** Cada pieza es una fábrica `createX(deps)` que recibe por parámetro todo lo que usa (nada de `require`
de estado ajeno ni de `process.env` fuera de `config.js`). Las capacidades devuelven sus órdenes, cada una con su
permiso al lado, y sus rutas HTTP si las tienen:

```js
// src/features/control.js
{ t: 'nav', perm: 'web', run: m => nav(m.url) },
{ t: 'shot', perm: 'adminQuiet', run: m => shot(m) },
{ t: 'volset', clamp: (m, P) => ({ ...m, v: Math.min(Number(m.v) || 0, P.volMax) }), run: m => volSet(m.v) },
```

- `perm`: nombre de una política de `permissions.js` (`any` por defecto, `admin`, `adminQuiet`, `stage`, `web`,
  `agent`) o una función `(m, P, ctx) => error | null`.
- `clamp`: ajusta la orden a lo permitido (volumen máximo, encolar en vez de reproducir).
- `quiet: true`: consultas que no cuentan como uso de la tele (no retrasan el paso al reposo).

`server.js` solo crea, conecta (`commands.register(lista)` por capacidad; rutas en `createHttp({ routes })`) y arranca
(`acc.start()`, `listen`, `ws.start()`, `pagePoll.start()`, `cdp.connect()`, `pointer.start()`). El mando (WebSocket),
la API (`/api/cmd`), el MCP y el agente pasan todos por el mismo `commands.dispatch()`: una orden, un dueño (registrar
dos veces el mismo `t` lanza un error al arrancar). Lo que pasa en Chrome llega a las capacidades por los ganchos de
`createCdp({ hooks })`, que solo se disparan tras `cdp.connect()`.

**Mando.** Módulos ES sin build. Cada feature exporta un descriptor:

```js
// public/mando/features/go.js
export const go = {
  name: 'go',
  sheets: { goS: { open() { … } } },     // ganchos de la hoja #goS
  clicks: { go: () => openSheet('goS') }, // botones [data-a=go][data-click]
  init() { … },                           // listeners; se llama desde app.js
};
```

`msgs` (manejador por tipo de mensaje del servidor), `sheets`, `clicks` (botones `data-click`) y `acts` (botones de
orden directa `data-a`) se registran en `app.js` con `register([...])`; un nombre repetido es un error. Capas en un solo
sentido y sin ciclos: `core ← ui ← features ← app` (y entre features: settings → admin → pair, settings → idle,
settings, controls y spotify → ambient, spotify → spotify-lists → spotify-state). Ningún módulo hace nada al cargarse salvo `app.js`. Lo comprueba
`test/unit/mando.test.js`.

## Conversación en la tele: paneles vivos (diseño v2)

Interruptor `agentDesign` del reposo (`v1` por defecto; `idle set`, solo admin) y nivel de cristal `glass`
(`auto|A|B|C`). `talk-view.js` lee `context()` (server.js: `idle.agentContext()`, la página y `state.playback`) en cada
pintada; si el diseño cambia, reinyecta la capa del otro y quita la anterior en la misma llamada. v1 sigue siendo
`tv-talk.js` tal cual.

```
Gateway ── tool_call {turn_id, phase start|result, name, tool_call_id, args, is_error}   (solo con tool_calls_enabled)
   │  client.js → {type:'tool', turnId, phase start|end, id, name, args (start) | ok (end)}   el resultado no se propaga
   ▼
talk.js ── mismo filtro de turnId/fantasma que los tokens, rearma el plazo (arm); con un turno que aún puede ser
   │  el parado (`maybeGhost`) las retiene hasta su primer token y las tira si resulta ser el fantasma
   │  toolCard(name, args) → ficha {kind, title, detail ≤ 60, opens?}: view.tool(…) / view.toolEnd({id, ok})
   │  layoutOf(name, args) → view.agentLayout(layout, url)   (tv_open / tv_open_app con `layout`)
   │  sin ficha (lecturas, desconocidas): solo el nombre al registro
   ▼
talk-view.js ── foto completa cada ≤ 100 ms: TVAgent.render(SNAP)
      {form pill|panel, ctx idle|music|web|video, state listen|think|talk|error|done, live, night, calm, glass, colors,
       turns: [{id, you, youFinal, jota, tools:[{id, kind, title, detail, status run|ok|fail}], error, hint, media?}], icons,
       enter open|restore, tab? (solo la foto del cambio de pestaña), shown? {turnId: [tú, Jota]} (con tab)}
      media? = tarjeta de contenido del turno (la pone el servidor, no el Gateway; hoy, Netflix):
       {key, kind list|play, state idle|press, items:[{title, sub, left, frac 0–1, img, still}]}
```

- `media`: `view.media(m)` la pone en el turno en curso solo en v2 y con el panel delante (devuelve si la puso), y
  `view.mediaState('press')` pulsa su ▶. Las imágenes van por dirección entera (`/idle/nfx` del servidor) y solo cuando
  la capa está sobre el reposo: la CSP de una web ajena las bloquearía; allí la tarjeta va sin ellas. En la píldora no
  se ve ni se construye. La usa Netflix (`server.js`): «¿qué estoy viendo?» pone la lista; al poner un título de «seguir
  viendo», antes de traer Netflix al frente, su tarjeta, 1,1 s para verla y el ▶ (0,45 s); luego la píldora.

- Los valores que admite la foto, los nombres de las fuentes y el del binding viven en `src/tv/agent-contract.js`;
  `tv-agent.js` lleva su copia y `tv-agent-static.test.js` comprueba que coinciden.
- El estado del orbe se deriva aquí: turno por voz → `listen`; escrito o frase final → `think`; herramienta → `think`;
  primer token → `talk`; `done` → `done`. Un `error()` o una herramienta fallida → `error` (la fallida, con la pista
  «Di «otra vez» para reintentar.»). El de `error()` se queda hasta el turno siguiente; el de una herramienta se
  despeja si otra posterior acaba bien (`RECOVER_ON_OK`), y entonces `done` → `done`.
- Una ficha cuyo resultado no llega (done, error o caída antes, Parar, interrumpir) deja de girar al cerrar o archivar
  el turno: pasa a `SETTLED_STATUS` (`ok`), nunca a `fail` (ni alerta ni pista).
- Herramientas de casa: por palabras del nombre sin prefijo (`home|light(s)|luz|luces|hass`, camelCase incluido); las que llevan
  un verbo de lectura (`get|list|search|find|status|history`) no tienen ficha.
- Panel: los 2 últimos turnos (`KEEP_TURNS`); píldora: solo el último a la vista (la foto lleva los 2 igual: el turno
  anterior se pliega o reaparece en el viaje del paso, con el contenido ya oculto). `ctx` (el tinte) sigue a la página en cada foto;
  noche, calma, cristal y colores también. Colores: solo con el reposo en pantalla y música.
- Se cierra `4000 + 45 × letras de la respuesta` ms tras el fin real del audio (o del texto); Parar la quita al momento.
- Los `tool_call` solo llegan si el Gateway tiene `tool_calls_enabled=true` para este cliente; este servidor no lo
  pide en el handshake. Sin ellos, v2 funciona igual, sin fichas (y sin el `layout` de los args: queda el de la orden `nav`).

### Formato: lo decide lo que se ve

`agent-form.js` es una función pura, `formFor({ url, stage, idle, playback, override, agentLayout })` (`decideForm` dice
además de dónde sale), con este orden:

1. `override` del usuario (arrastre en la tele u orden `talkform` del mando) para el contenido actual → `user`
2. `agentLayout`: Jota lo pidió al abrir esta página (`tv_open` / `tv_open_app` con `layout: 'pill' | 'panel'`) → `agent`
3. app de contenido (`CONTENT_HOSTS`: Netflix, YouTube, Spotify, Prime Video, Disney+, Max, Movistar+, Twitch, RTVE Play,
   Atresplayer, Filmin, Apple TV…, por sufijo de host con límite de etiqueta y, si lleva ruta, de segmento) o el
   escenario propio (`stageOf(url)`: `tpl-<tipo>.html` o `stage/…`, sacado de la URL y no del estado del escenario, que
   «atrás» o un clic no limpian) → píldora aunque no se reproduzca nada → `content`
4. `playback` (vídeo grande que avanza, de page-poll) en cualquier web → píldora → `playback` (reserva)
5. reposo y webs normales → panel → `default`

- Al empezar un turno se decide de cero (un turno nuevo en el reposo o en una web vuelve al panel; uno que empieza ya
  dentro de una app nace píldora). Con la capa a la vista se vuelve a mirar cuando una página nueva ya **enseña su
  contenido** (tras la foto `restore`, la página contesta a `PAINT_PROBE`: tras el primer paint, cada `PAINT_EVERY_MS`
  mira una rejilla de `PAINT_GRID`² puntos y cuando `PAINT_MIN_POINTS` caen en contenido de verdad —imagen o vídeo con
  imagen, fondo con imagen o texto, nunca la capa ni las cajas grises de un esqueleto— dos rAF y listo; `PAINT_WAIT_MS`
  como mucho. LCP no sirve: la capa restaurada es el candidato más grande),
  cuando cambia `playback` y cuando el usuario o Jota piden otro formato. Lo automático (3, 4) solo va de panel a
  píldora y tras `MORPH_DELAY_MS`; volver al panel es cosa del usuario (al momento) o de Jota (tras el respiro).
- `override` vale mientras siga el mismo contenido (`OVERRIDE_SCOPE = 'content'`: misma entrada de `CONTENT_HOSTS`, mismo
  host sin `www.`, el mismo escenario o el reposo); al cambiar de contenido se olvida. Lo de Jota vale en cuanto se llega
  a la página que abrió y mientras se siga en ese sitio; si no se llega en `AGENT_LAYOUT_TTL_MS`, se olvida.
- Cierre: un turno con una ficha que pone otra página (`opens`: tv_open, tv_open_app, tv_present, tv_show_html,
  tv_idle show) y sin ninguna página pintada desde que empezó no se cierra hasta que se pinte (`AWAIT_PAGE_MS` como
  mucho); pintada, lo que quede del cierre normal y al menos `AFTER_PAINT_MIN_MS`. Si pasa sola a píldora, se queda
  `PILL_DWELL_BASE_MS + 45 ms/letra`; si la cambia el usuario o Jota con el turno acabado, el cierre normal desde ahí.
  Un paso que se cancela en el respiro (se pausó) no deja la espera colgada. Abrir la URL que ya se ve (tv_idle show en el
  reposo, la portada de una app en la que ya se está) o «recargar» es un documento nuevo sin cambio de URL: `control.nav`
  avisa con `onReload` (server.js → `talkView.reset()`), porque `onPage` no lo ve.

### Navegar con la capa abierta

Navegar es un documento nuevo. Mientras la capa v2 se ve, la fuente (con tokens y fuentes) y la última foto van también
como scripts de documento nuevo (`Page.addScriptToEvaluateOnNewDocument`, solo el marco principal); la página siguiente
la pinta en cuanto hay `documentElement`, con `enter:'restore'`: en su caja, sin animaciones de entrada y con lo ya dicho
a la vista, con el cristal ya opaco (sin fundido) y con el tinte del documento anterior (ni el ancho ni el velo saltan
al cambiar de documento; la foto siguiente trae el de la página nueva y la membrana va a él con sus muelles, el velo con
una transición). Se quitan al ocultarla o al pasar a v1. La capa va en la capa superior (popover manual) y el host se
mueve, nunca se recrea, al entrar o salir de pantalla completa: dentro del elemento a pantalla completa si admite hijos
(un `<div>`, como los reproductores de YouTube o Netflix: lo de fuera queda inerte y la membrana no recibiría el puntero),
y en body con un `<video>` a pantalla completa (se ve, pero no se puede arrastrar: queda el gesto del mando). Fuentes: Fraunces de `public/fonts/` (OFL) mandada como bytes
(`FontFace` desde un ArrayBuffer, nombre propio `TV Fraunces`), así se ve igual con `font-src 'none'`; Inter no está
vendorizada: la de palo seco es la del sistema en todas partes.

### Cambiar de pestaña con la capa abierta (Netflix va en la suya)

`cdp.show(id)` engancha primero la pestaña de destino, aún detrás (la anterior sigue enganchada), y espera la promesa de
`onAttached` (como mucho `FRONT_WAIT_MS`): `talkView.reset({ tab: true, from })` pinta ya, sin `batchMs`, la última foto
que se vio (su tinte, `enter:'restore'` y `tab`), con `shown`: lo que la pestaña que se deja enseña de cada turno
(`TVAgent.revealed()`, preguntado por `from` con `FROM_WAIT_MS` de tope). La página retira en seco lo que se quedó
pintado en ella y restaura esas palabras sin entradas; el resto se revela como siempre. Luego `Target.activateTarget`
(se ve ya con la capa), `onLeft` → `talkView.leave()` quita en seco (`TVAgent.hide(true)`) la capa de la que se deja, y
se suelta su sesión. La foto siguiente trae el tinte de la pestaña nueva (los muelles hacen el cambio de ancho).
`activate` / `autoActivate` siguen soltando la anterior antes de enganchar.

Pestaña en blanco: `about:blank` (y `chrome://newtab`, `chrome-search:`) no es la página nueva: con esa URL no se sondea,
y si la sonda ve el documento aún en blanco contesta `blank` y se vuelve a mirar; no cuenta como pintada. Un fallo de la
sonda tampoco cuenta (se repite si no hubo navegación). Si llega una navegación con la espera en curso o vencida (la
pintada fue el tope de la sonda), la espera se vuelve a armar y el cierre cuenta `AFTER_PAINT_MIN_MS` desde la pintada
de verdad.

### Cambiar el formato: mando y puntero de la tele

```
mando ── {t:'talkform', form:'panel'|'pill'}   permiso agent; solo quien puede parar (el móvil que preguntó o agente completo)
   │                                           → {ok:1, form} | {error}
tele ─── arrastre de la membrana con el ratón (pointer.py) → binding __tvAgentForm('panel'|'pill')
   ▼                                           (Runtime.addBinding, una vez por sesión CDP; server.js onBinding)
talk-view.userForm(form) ── override del contenido actual, cambio al momento (los dos sentidos)
   │
   ▼  onForm(form, canSwitch)
talk.js ── {t:'talk', ev:'form', form:'pill'|'panel', canSwitch:true|false} al móvil del intercambio
```

- `ev:'form'` llega al empezar cada turno en v2, en cada cambio de formato (automático, de Jota o del usuario) y al
  cerrarse la capa (`canSwitch:false`). En v1 no llega (no hay nada que cambiar). El mando pinta con él su control
  («Ampliar en la tele» / «Hacer píldora»). Va al móvil del intercambio, como `hidden`: otro móvil con el agente completo
  puede mandar `talkform` (como `stop`) pero no ve el control. Si el móvil del intercambio se reconecta (otra conexión
  del mismo dispositivo, `devId`), `talk.greet` la hace la del intercambio y le manda el formato al conectarse; `may()`
  también reconoce el mismo dispositivo. Con el token maestro (sin dispositivo) solo vale la misma conexión.
- En la tele solo la membrana visible (`.body`) recibe el puntero; el host y el resto de la capa siguen con
  `pointer-events:none`. Píldora hacia la derecha → panel; panel hacia el centro o hacia arriba → píldora (pasado
  `DRAG.swap` o con un gesto rápido: velocidad de más de `DRAG.flick` en los últimos `DRAG.win` ms antes de soltar, con el
  punto de soltar, y al menos `DRAG.flickMin` de recorrido); mientras se arrastra, contenido y membrana siguen al dedo con
  goma (`DRAG.band`, y nunca más que el sitio que queda hasta el área segura: el panel, ya arriba del todo, no sube) y al
  soltar encajan con los muelles en uno de los dos destinos. Los eventos no **suben** de la membrana a la web
  (`stopPropagation`; los oyentes en fase de captura de `document` o `window` sí los ven, con `#__tvagent` de destino) y
  el `mousedown` no hace su acción por defecto: ni foco perdido ni selección. La página cambia ya y mantiene lo elegido
  `DRAG.hold` ms hasta que la foto lo confirme.
- El binding vive en el mundo de la página (la capa se pinta ahí): una web podría llamarlo. Solo acepta exactamente
  `pill` o `panel`, con la capa v2 a la vista y no más seguido que `BINDING_GAP_MS`; como mucho cambia el formato.

## Roles y permisos

| Rol | Cómo se obtiene | Permisos |
|---|---|---|
| admin | enlace o código de admin (`adminlink`, `node remote/admin-link.js`) o canjear el token maestro en `/pair/admin` | todo (`ADMIN_PERMS`) |
| member | un admin lo concede al aceptar una petición, o cambia el rol | los de `access.json` → `member` |
| guest | código de 4 cifras en la tele, o petición aceptada por un admin; caduca a las `guestHours` (24 por defecto) | los de `access.json` → `guest` |

Permisos configurables (`permSan`): `web` (abrir webs), `agent` (`off` / `guest` / `full`), `music` (`play` / `queue` /
`off`), `library` (biblioteca de Spotify), `volMax` (10–100), `stage` (presentaciones y Live Activities). El token
maestro (`token` en `TV_STATE_DIR`) cuenta como admin; es para el agente y el MCP. Sin dispositivo (API con el maestro),
`permsOf(null)` es admin. Al cambiar rol o ajustes, el servidor manda otro `me` a los mandos afectados; al retirar o
caducar un dispositivo cierra su WebSocket (4001 / 4002).

## Seguridad

- **Token maestro**: se genera si falta (`$TV_STATE_DIR/token`, 0600) y no llega nunca al móvil: se canjea por un dispositivo
  admin propio (`/pair/admin`) y el manifiesto no lo conserva. De cada dispositivo se guarda solo el sha256 de su
  token; la comparación con el maestro es de tiempo constante.
- **Registro**: `createLog` tapa el maestro, los `?t=`/`?token=` y los `Bearer`; lo escrito en un campo (`field`) se
  registra solo como longitud. Una prueba de contrato comprueba que el maestro no sale en el registro.
- **Freno de intentos**: 5 fallos desde una IP → 429 durante 60 s, en `/api/*`, `/pair/*` (confirmar y admin), `/ws` y
  `/spotify/login`. El código de la tele admite 3 fallos y caduca a los 2 min.
- **Dónde escucha**: 127.0.0.1, redes privadas y Tailscale (100.64/10); nunca IPs públicas ni redes de Docker. CDP
  (`TV_CDP_PORT`) solo en 127.0.0.1; `scripts/doctor.sh` lo comprueba.
- **CSP por página** (`static.js`): mando (`CSP`) y reposo (`IDLE_CSP`) sin `'unsafe-inline'` (solo `'self'` y las
  fuentes de Google); las páginas del escenario (`tpl-*.html` y `/stage/p*.html`, `STAGE_CSP`) llevan
  `'unsafe-inline'` y `https:` a propósito, porque las escribe el agente, pero `connect-src 'self'`. Además, en todas
  las respuestas, `nosniff` y `Referrer-Policy: no-referrer`.
- **Canales solo para la tele**: `/idle-ws`, `/stage-ws`, `/stage/p*.html` e `/idle/art` exigen `isLocalTV` (bucle
  local sin cabeceras de proxy); lo reenviado por nginx o Tailscale recibe 403 o se corta.
- **Límites de tamaño**: `/api/cmd` 1,2 MB (413 y cierre), `/pair/*` 2 KB, mensajes WS 64 KB, HTML del escenario 1 MB
  (se guardan las 30 últimas páginas), orden `text` 2000 caracteres, pregunta al agente 1000.
- **Navegación**: `normUrl` solo deja `http(s)`; otros esquemas (`file:`, `javascript:`, `chrome:`…) se rechazan.
- **Cookie** `tvt` del dispositivo: `HttpOnly; SameSite=Lax`.

## Estado persistido

Todo en `TV_STATE_DIR` (por defecto `~/.local/state/jota-screen`), fuera del repo: la carpeta con 0700 y los
ficheros con 0600. Los JSON se escriben con `writeJson`: atómico (temporal + `rename`) y 0600.

| Fichero | Qué guarda | Quién lo escribe |
|---|---|---|
| `token` | token maestro (texto) | `src/auth/access.js` (si falta o es corto) |
| `devices.json` | dispositivos: id, nombre, rol, hash del token, fechas | `src/auth/access.js` |
| `access.json` | `guestHours` y permisos de `guest` y `member` | `src/auth/access.js` (`setAccess`) |
| `spotify.json` | `clientId` (a mano), tokens de la cuenta, espera por 429 (`waitUntil`) | `src/features/spotify.js` |
| `idle.json` | ajustes del reposo (ciudad y coordenadas, modo, horario, minutos, `layout`…) | `remote/idle.js` |
| `stage/p*.html` | páginas del escenario (`show`), las 30 últimas | `src/features/stage.js` |
| `chrome-profile/` | perfil de Chrome del kiosco (sesiones de Netflix, YouTube…) | Chrome (`kiosk-session.sh`) |

**Migración.** Antes el estado vivía junto al código (`remote/token`, `remote/*.json`), el escenario en `~/tv/stage` y
el perfil en `~/tv/chrome-profile` o `<repo>/chrome-profile`. Al arrancar, antes de leer nada, `prepareStateDir`
(`src/core/state-dir.js`) mueve a `TV_STATE_DIR` cada fichero antiguo que no exista ya en la carpeta nueva (`rename`;
entre sistemas de ficheros, copia y borra), le pone 0600 y lo apunta en el registro sin enseñar el contenido; si ya
existe el nuevo, deja el antiguo y lo avisa. Como busca en el `remote/` del código que arranca, hay que arrancar desde
la misma carpeta del repo de la instalación antigua. El perfil de Chrome lo mueve `kiosk-session.sh`
(`jsc_migrate_chrome_profile`) con la misma regla.

En el móvil: `localStorage` (`token` del dispositivo, `cfg`, `devid`, `pname`) y la cookie `tvt`. El maestro no se
guarda nunca en el navegador.

## Configuración

El servidor no lee ficheros de configuración: recibe el entorno de systemd (`EnvironmentFile=` con
`~/.config/jota-screen/screen.env`, o `TV_CONFIG`) y `src/core/config.js` es el único que lee `process.env`. Los scripts
de bash leen el mismo fichero con `scripts/lib.sh` (`jsc_load_config`). Todo es opcional; la lista completa, con sus
valores por defecto, está en [config/screen.env.example](../config/screen.env.example):

- **Pantalla**: `TV_NAME` (`Pantalla`; título, textos del mando con `{{TV_NAME}}`, altavoz de Spotify),
  `TV_DISPLAY_OUTPUT` / `TV_DISPLAY_MODE` / `TV_DISPLAY_RATE` (detección con xrandr), `TV_SCALE` (1.5), `DISPLAY` (`:0`).
- **Red**: `TV_PORT` (8787), `TV_MDNS_NAME` (`mando.local`; vacío = sin alias), `TV_NET_IFACE`, `TV_PUBLIC_URL` (vuelta
  de Spotify; por defecto `http://127.0.0.1:<puerto>`), `TV_ADMIN_URL` (por defecto `http://<TV_MDNS_NAME>` o, sin
  alias, `http://<equipo>.local:<puerto>`).
- **Kiosco**: `TV_CHROME`, `TV_CDP_PORT` (9222), `TV_HOME_URL` (el reposo).
- **Agente**: `TV_GATEWAY_URL` y `TV_GATEWAY_KEY` (J Gateway; sin URL = «Jota no está disponible.»), `TV_AGENT` (`j-assistant`), `TV_SPEAKER_CMD` (altavoz de la tele), `TV_OWNER`
  (nombre del dueño en las instrucciones al agente; vacío = «el dueño»).
- **Spotify**: `TV_SPOTIFY_DEVICE` (= `TV_NAME`), `TV_SPOTIFYD`, `TV_SPOTIFY_BANNER`.
- **Tiempo**: `TV_CITY`, `TV_LAT`, `TV_LON`, `TV_TZ` (la del sistema): valores iniciales del reposo; lo guardado desde el
  mando (`idle.json`) manda. Sin latitud y longitud no se pide el tiempo.
- **Avanzado**: `TV_STATE_DIR`, `TV_DEBUG` (registra las órdenes), `TV_NO_POINTER`, `XDG_RUNTIME_DIR`.

El MCP usa `TV_URL` (`http://127.0.0.1:8787`), `TV_TOKEN` o, si no, el fichero `TV_TOKEN_FILE` o `$TV_STATE_DIR/token`.

## Servicios

| Unidad | Tipo | Qué es |
|---|---|---|
| `jota-screen` | usuario | servidor (`node server.js` en `remote/`) |
| `jota-screen-mdns` | usuario | alias mDNS (`mdns-alias.sh`), si hay avahi y `TV_MDNS_NAME` |
| `jota-screen-spotify` | usuario | spotifyd (`scripts/spotifyd-run.sh`), si hay spotifyd |
| `jota-screen-kiosk` | sistema | Xorg en tty1 + `kiosk-session.sh` como el usuario de la pantalla |

Las genera `scripts/install.sh` desde las plantillas de `systemd/` ([systemd/README.md](../systemd/README.md)).
Sustituyen a las antiguas `tv-remote`, `tv-mdns`, `spotifyd` y `tv-kiosk`: el instalador detiene y deshabilita las
de usuario y enseña los comandos `sudo` para la del kiosco.

## Límites conocidos

- `public/` se carga en memoria al arrancar y solo hasta **2 niveles de carpetas** (`public/a/b/f.js` sí,
  `public/a/b/c/f.js` no). Cambiar algo de `public/` exige reiniciar `jota-screen`.
- **Nombres de carpeta reservados** en `public/`: `api`, `pair`, `stage`, `idle`, `spotify`, `ws`, `idle-ws`,
  `stage-ws` (chocan con rutas del servidor; arrancar con una de ellas da error).
- Los estáticos no piden token: no debe haber nada secreto en `public/`.
- La **isla** no puede cargar CSS dentro de webs ajenas (su CSP, su red): el servidor le antepone los tokens de
  `shared/tokens-tv.css` como texto (`__TV_TOKENS`), y por eso ese fichero debe tener un solo bloque `:root{…}` de
  declaraciones simples. La isla se relee en cada inyección; el reposo, no (va por estáticos).
- El mando tiene sus propios tokens en `shared/tokens-mando.css` (mismos valores de base que la tele: tinta, malva,
  cielo, Fraunces y ease-salon) y las plantillas del escenario los suyos en `stage.css`; `tokens-tv.css` es solo de la
  tele (reposo e isla).
- **Ambiente del mando**: con el reposo en pantalla, el mensaje `state` lleva `amb` (perfil y dos colores `[h, s, l]` de
  la carátula, de `idle.js`, que avisa con `onAmbient` solo si cambian). `mando/features/ambient.js` decide el color de
  las luces (reposo, carátula o app por su dominio) y lo recorta en luminancia para que el texto secundario no baje de
  4,5:1 con las dos luces superpuestas.
- Una sola pregunta al agente a la vez (`askBusy`).
- Spotify castiga el exceso de peticiones (429): `nowplaying.js` solo consulta si alguien mira y la espera sobrevive a
  un reinicio.
