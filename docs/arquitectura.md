# Arquitectura

jota-screen es la pantalla del ecosistema Jota: un Chrome en modo kiosco en un equipo Linux con X, en la salida de
vídeo que diga la configuración (una tele, un monitor, un kiosco). Su nombre visible es `TV_NAME` («Pantalla» por
defecto). Se maneja desde un mando web en el móvil (PWA), desde el agente Jota (OpenClaw) y desde Claude por el MCP
`tv-canvas`. Cuando nadie la usa enseña la pantalla en reposo; encima de cualquier web pueden salir Live Activities y
avisos; el agente puede poner contenido en el escenario; la música va por Spotify (spotifyd como altavoz Connect con el
nombre de la pantalla + Web API).

Cómo se hacen los cambios habituales: [como-se-hace.md](como-se-hace.md). Pruebas: [test/README.md](../test/README.md).

## Visión general

```
  Móvil (mando PWA)                     Jota (OpenClaw) · Claude
  index.html + mando/*.js               MCP tv-canvas (mcp/server.js, stdio)
     │ /ws?t=… (órdenes JSON y puntero)    │ POST /api/cmd, GET /api/state, /api/events
     │ /pair/*  · estáticos                │ (Bearer: token maestro o de un dispositivo)
     │ LAN: mando.local (nginx) · fuera: TV_PUBLIC_URL (p. ej. Tailscale HTTPS)
     ▼                                     ▼
 ┌──────────────── servicio jota-screen · remote/server.js (Node, :8787) ────────────────┐
 │ transport/ (HTTP, WS) ──► commands.dispatch(m) ──► permiso ─► clamp ─► capacidad.run   │
 │ auth/ (tokens, roles, emparejar)   features/ (control, keyboard, stage, spotify, idle, agent)
 └──┬────────────────┬──────────────┬────────────────┬────────────────────┬───────────────┘
    │ CDP :9222      │ pointer.py   │ wpctl          │ Web API Spotify    │ CLI `openclaw agent`
    │ (127.0.0.1)    │ (XTest)      │ (PipeWire)     │ (PKCE)             │ (pregunta del mando)
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
    tv-state.js           estado público de la tele, broadcast agrupado (30 ms) y la orden `state`
  src/auth/
    permissions.js        roles, permisos por defecto, políticas con nombre y check()
    access.js             token maestro, dispositivos (solo hash), ajustes de acceso, emparejar, enlaces de admin
    commands.js           órdenes de acceso: devices, revoke, role, extend, rename, kickguests, pairanswer, adminlink, access, me
    pair-http.js          rutas /pair/* (info, start, confirm, poll, me, admin)
    ratelimit.js          freno de intentos por IP
  src/tv/
    cdp.js                adaptador de Chrome (CDP): pestaña activa, call/fire, ganchos, reconexión
    devices.js            puntero, volumen (wpctl), sonda de la página y el código de emparejar pintado en la tele
    page-poll.js          sondeo de vídeo y scroll, solo con mandos conectados
    tokens.js             lee shared/tokens-tv.css y arma la fuente de la isla (tokens delante)
  src/features/           capacidades: cada una devuelve sus `commands` (y `routes`, si tiene)
    control.js            nav, links, clicktext, click, home, back, forward, reload, shot, pp, seek, fs, vol, volset
    keyboard.js           key, text, field (escribir en directo), focus (aviso de foco)
    stage.js              present, show, stage, close, toast; ruta /stage/p*.html; canal /stage-ws
    spotify.js            spotify (todas las acciones), spwatch; rutas /spotify/login y /spotify/callback
    idle.js               envoltorio de remote/idle.js: activity, idle; ruta /idle/art
    agent.js              ask (OpenClaw por su CLI)
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
    mando/features/       controls, trackpad, keyboard, go, agent, spotify, spotify-lists, spotify-state, pair, admin, settings, idle
    mando/styles/mando.css  estilos y tokens del mando (oscuro y claro)
    idle.html, idle.css, idle-app.js   pantalla en reposo (sin nada en línea)
    shared/tokens-tv.css  tokens Jota Dusk de la tele (reposo e isla)
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
spotify → spotify-lists → spotify-state). Ningún módulo hace nada al cargarse salvo `app.js`. Lo comprueba
`test/unit/mando.test.js`.

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
- **Agente**: `TV_OPENCLAW` (`openclaw` del PATH o `~/.npm-global/bin/openclaw`), `TV_AGENT` (`jota`), `TV_OWNER`
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
- El mando tiene sus propios tokens en `mando/styles/mando.css` y las plantillas del escenario los suyos en
  `stage.css`; `tokens-tv.css` es solo de la tele (reposo e isla).
- Una sola pregunta al agente a la vez (`askBusy`).
- Spotify castiga el exceso de peticiones (429): `nowplaying.js` solo consulta si alguien mira y la espera sobrevive a
  un reinicio.
