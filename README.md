# jota-screen

La pantalla del ecosistema Jota: convierte cualquier pantalla conectada a un equipo Linux (la tele del salón, un
monitor, un kiosco) en un lienzo que se maneja desde el móvil y desde los agentes. Chrome a pantalla completa,
controlado por un mando web (PWA), por el agente Jota (J Gateway) y por Claude (MCP, skill y plugin `tv-canvas`).

- **Mando** en el móvil: touchpad, teclado, atajos, música, ajustes. Roles admin, miembro e invitado; se empareja con un
  código que sale en la pantalla.
- **Pantalla en reposo**: hora, tiempo (opcional), música y Live Activities cuando nadie la usa.
- **Escenario**: presentaciones, tareas y avisos que pone el agente encima de cualquier web.
- **Spotify Connect** (opcional): spotifyd como altavoz y la Web API para manejarlo desde el mando.

Antes se llamaba `tv-canvas`; el MCP, la skill y el plugin conservan ese nombre para no romper configuraciones.

## Requisitos

- Linux con systemd y X (Xorg + `xinit`; el kiosco ocupa tty1). Las pistas de paquetes del instalador son de Debian/Ubuntu.
- Node.js 22 o posterior (el servidor usa el de `.nvmrc`, 24) y npm.
- Google Chrome (recomendado: trae Widevine para Netflix y similares) o Chromium.
- `xrandr`/`xset` (x11-xserver-utils), `python3` con libX11 y libXtst (puntero del mando), `openbox` (recomendado).
- Opcional: `avahi-utils` (alias `mando.local`), PipeWire con `wpctl` (volumen), spotifyd, nginx (mando sin puerto),
  el J Gateway local (el agente que contesta desde el mando, por texto y voz).

El instalador comprueba todo esto y dice qué paquetes faltan; no instala paquetes del sistema.

## Instalar en una máquina nueva

Con el usuario que va a ser dueño de la pantalla (no root), en cualquier carpeta:

```sh
git clone https://github.com/Jota-project/jota-screen.git && cd jota-screen
scripts/install.sh --dry-run     # enseña lo que haría, sin cambiar nada
scripts/install.sh               # config, npm ci en remote/, servicios de usuario y unidad del kiosco
```

`scripts/install.sh` (idempotente, se puede repetir):

1. comprueba las dependencias;
2. crea `~/.config/jota-screen/screen.env` desde `config/screen.env.example` si no existe (nunca la pisa);
3. crea la carpeta de estado (`~/.local/state/jota-screen`, 0700) e instala las dependencias del servidor
   (`npm ci --omit=dev` en `remote/`) si han cambiado;
4. genera, habilita y arranca los servicios de usuario `jota-screen` (servidor), `jota-screen-mdns` (alias mDNS, si hay
   avahi y `TV_MDNS_NAME`) y `jota-screen-spotify` (si hay spotifyd), y activa *linger* para que arranquen con el equipo;
5. genera la unidad de sistema del kiosco en `~/.config/jota-screen/generated/jota-screen-kiosk.service` y enseña los
   comandos `sudo` para instalarla y arrancarla (con `--system` lo hace él si hay sudo sin contraseña);
6. si hay nginx, genera el proxy de `http://<TV_MDNS_NAME>` y enseña cómo instalarlo.

Después, los comandos `sudo` que haya enseñado para el kiosco y la comprobación:

```sh
scripts/doctor.sh                # servicios, CDP, /api/state con y sin token, permisos, alias; no cambia nada
node remote/admin-link.js        # enlace de admin de un solo uso para el primer móvil
```

Para que Claude o Jota manejen la pantalla: `(cd mcp && npm ci)` y el plugin de [plugin/tv-canvas](plugin/tv-canvas/README.md).

## Configuración

Todo es opcional y vive en `~/.config/jota-screen/screen.env` (o la ruta de `TV_CONFIG`), formato `KEY=valor`. La
plantilla con todas las variables y su valor por defecto es [config/screen.env.example](config/screen.env.example).
Las principales:

| Variable | Por defecto | Para qué |
|---|---|---|
| `TV_NAME` | `Pantalla` | Nombre visible: título, textos y altavoz de Spotify |
| `TV_DISPLAY_OUTPUT`, `TV_DISPLAY_MODE`, `TV_DISPLAY_RATE` | detección con xrandr | Salida de vídeo, modo y frecuencia |
| `TV_SCALE` | `1.5` | Escala de Chrome |
| `TV_PORT` / `TV_CDP_PORT` | `8787` / `9222` | Puerto del servidor / de depuración de Chrome (solo 127.0.0.1) |
| `TV_MDNS_NAME`, `TV_NET_IFACE` | `mando.local`, interfaz de la ruta por defecto | Alias mDNS del mando (vacío = sin alias) |
| `TV_PUBLIC_URL`, `TV_ADMIN_URL` | `http://127.0.0.1:8787`, `http://mando.local` | URL pública (vuelta de Spotify) y de los enlaces de admin |
| `TV_CHROME`, `TV_HOME_URL` | primer Chrome/Chromium, el reposo | Navegador y página de inicio del kiosco |
| `TV_GATEWAY_URL`, `TV_GATEWAY_KEY`, `TV_AGENT`, `TV_OWNER` | vacía (sin agente), vacía, `j-assistant`, vacío | J Gateway y agente que contesta desde el mando (texto y voz) |
| `TV_SPEAKER_CMD` | `pw-cat` | Orden que reproduce el PCM de la respuesta en la tele |
| `TV_SPOTIFY_DEVICE`, `TV_SPOTIFYD` | `TV_NAME`, `spotifyd` del PATH | Altavoz Spotify Connect |
| `TV_CITY`, `TV_LAT`, `TV_LON`, `TV_TZ` | vacío, zona del sistema | Tiempo en el reposo: sin latitud y longitud no se pide |
| `TV_STATE_DIR` | `~/.local/state/jota-screen` | Estado: token, dispositivos, ajustes, escenario, perfil de Chrome |

Tras cambiarla: `systemctl --user restart jota-screen` (y `jota-screen-mdns` / `jota-screen-spotify` si toca); lo
de la pantalla (salida, escala, Chrome) con `sudo systemctl restart jota-screen-kiosk`.

## Actualizar

```sh
scripts/update.sh                # git fetch + merge --ff-only, npm ci si cambió el lock, reinicia y pasa doctor.sh
```

Se para sin tocar nada si hay cambios locales o si no es un avance rápido (`--from origin/main` si la rama no sigue a
ninguna remota). Si cambian las plantillas (`systemd/`, `config/`, nginx) avisa para repetir `scripts/install.sh`; si
cambia el kiosco, para reiniciarlo. Venir de una instalación antigua (`tv-remote`, `tv-kiosk`, estado en `remote/`):
[docs/como-se-hace.md](docs/como-se-hace.md#migrar-una-instalación-antigua-tv-remotetv-kiosk-estado-en-remote).

## Desarrollo local

```sh
npm ci && (cd remote && npm ci)  # herramientas (raíz) y servidor
npm run verify                   # lint + tipos + pruebas (npm run lint / check / test por separado)
```

El servidor en local, con un estado temporal y sin puntero X:

```sh
export TV_STATE_DIR=$(mktemp -d)
TV_NO_POINTER=1 node remote/server.js                       # crea $TV_STATE_DIR/token; sin Chrome la tele sale «no disponible»
xdg-open "http://127.0.0.1:8787/?t=$(cat "$TV_STATE_DIR/token")"   # el mando canjea el token maestro por un dispositivo admin
```

Para tener «tele», un Chrome aparte con CDP:
`google-chrome --remote-debugging-port=9222 --user-data-dir="$(mktemp -d)" http://127.0.0.1:8787/idle.html`.
Sin `wpctl` no hay volumen y sin `TV_GATEWAY_URL` Jota no está disponible; el resto funciona. Con `TV_LAT`/`TV_LON` el reposo pide
el tiempo a Open-Meteo.

## Herramientas

- `node scripts/cdp.js tabs | nav <url> | eval <js> | click <texto>`: habla con el Chrome del kiosco por CDP
  (`--port`, `--tab`; ver `--help`).
- `scripts/doctor.sh [--since MINUTOS]`: salud de la instalación.
- `node remote/admin-link.js`: enlace de admin de un solo uso.
- `npm run sync-plugin`: copia el MCP al plugin tras cambiarlo.
- `npm run e2e:reposo`, `npm run e2e:mando`: capturas con Playwright ([e2e/README.md](e2e/README.md)).

## Documentación

- **Arquitectura** (piezas, patrón, permisos, seguridad, estado, configuración, límites): [docs/arquitectura.md](docs/arquitectura.md)
- **Cómo se hace** (órdenes, capacidades, rutas, mando, colores, pruebas, despliegue, instalar y migrar): [docs/como-se-hace.md](docs/como-se-hace.md)
- **Pruebas**: [test/README.md](test/README.md) · **capturas**: [e2e/README.md](e2e/README.md) · **servicios**: [systemd/README.md](systemd/README.md)

| Carpeta | Qué es |
|---|---|
| `remote/` | Servidor (Node): `server.js` compone las piezas de `src/` (core, auth, tv, features, transport) |
| `remote/public/` | Lo que se sirve: el mando (`index.html` + módulos ES en `mando/`), el reposo (`idle.*`), la isla de Live Activities (`tv-island.js`), los tokens de la tele (`shared/tokens-tv.css`) y el escenario (`tv-stage.js`, `tpl-*.html`) |
| `config/` | `screen.env.example`, la plantilla de configuración |
| `systemd/` | Plantillas de las unidades (`jota-screen*`) que rellena el instalador |
| `scripts/` | `install.sh`, `update.sh`, `doctor.sh`, `cdp.js`, `lib.sh` (funciones comunes), `spotifyd-run.sh`, `sync-plugin.sh` |
| `kiosk-session.sh`, `home.html` | Sesión X del kiosco (salida, Chrome con CDP) y su portada, que salta al reposo cuando el servidor responde |
| `mdns-alias.sh` | Alias mDNS del mando (lo lanza `jota-screen-mdns`) |
| `mcp/`, `plugin/tv-canvas/` | MCP `tv-canvas` (stdio) sobre la API y el plugin de Claude Code que lo empaqueta |
| `e2e/` | Capturas del reposo y del mando con datos de ejemplo, y su comparador |
| `test/` | Pruebas de contrato (servidor real aislado, Chrome falso) y unitarias |

Secretos y estado (token, `devices.json`, `access.json`, `spotify.json`, `idle.json`, `stage/`, `chrome-profile/`)
viven en `TV_STATE_DIR`, fuera del repo.
