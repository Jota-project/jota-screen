# jota-screen

Lienzo programable para la tele del salón (servidor `green-house`): Chrome en modo kiosco por HDMI,
controlado por un mando web (PWA), por el agente OpenClaw y por Claude (MCP / skill / plugin).
Antes se llamaba `tv-canvas`; el MCP, la skill y el plugin conservan ese nombre para no romper configuraciones.

- **Arquitectura** (piezas, patrón, permisos, seguridad, estado, límites): [docs/arquitectura.md](docs/arquitectura.md)
- **Cómo se hace** (órdenes, capacidades, rutas, mando, colores, pruebas, despliegue): [docs/como-se-hace.md](docs/como-se-hace.md)
- **Pruebas**: [test/README.md](test/README.md) · **capturas**: `e2e/` (Playwright)

| Carpeta | Qué es |
|---|---|
| `remote/` | Servidor del mando (Node, puerto 8787): `server.js` compone las piezas de `src/` (core, auth, tv, features, transport) |
| `remote/public/` | Lo que se sirve: el mando (`index.html` + módulos ES en `mando/`), la pantalla en reposo (`idle.html`, `idle.css`, `idle-app.js`), la isla de Live Activities (`tv-island.js`), los tokens de la tele (`shared/tokens-tv.css`) y el escenario (`tv-stage.js`, `tpl-*.html`) |
| `mcp/` | MCP `tv-canvas` (stdio) sobre la API del mando |
| `plugin/tv-canvas/` | Plugin de Claude Code (skill + `.mcp.json`; su `mcp/server.js` es copia de `mcp/`, ver `scripts/sync-plugin.sh`) |
| `systemd/` | Unidades de usuario (`tv-remote`, `tv-mdns`, `spotifyd`); la del kiosco (`tv-kiosk`, de sistema) vive solo en el servidor |
| `scripts/` | `install.sh` (instala las unidades de usuario), `sync-plugin.sh` |
| `e2e/` | Capturas del reposo y del mando con datos de ejemplo; `mando-compara.py` compara dos tandas del mando |
| `test/` | Pruebas de contrato (servidor real aislado, Chrome falso) y unitarias |
| `kiosk-session.sh`, `home.html` | Sesión X del kiosco (Chrome con CDP en 9222) y su portada, que salta al reposo |
| `mdns-alias.sh` | Alias `mando.local` (lo lanza `tv-mdns`) |
| `cdp-click.js`, `cdp-eval.js`, `cdp-nav.js` | Utilidades CDP sueltas para depurar a mano en el servidor |

Specs, decisiones, roadmap y notas viven en el vault de Obsidian (`Producto Jota/tv-canvas/`), no aquí:
el roadmap con los frentes abiertos es `TVC Roadmap`, la técnica `TVC Arquitectura`.
Secretos y estado local (`remote/token`, `devices.json`, `spotify.json`, `idle.json`, `access.json`) quedan fuera del repo (ver `.gitignore`).

## Piezas principales
- **Mando** (`index.html` + `mando/`): Mando v2 (Jota Dusk), tema oscuro o claro. Roles admin, miembro e invitado.
- **Pantalla en reposo v2** (`idle.html` + `remote/idle.js`): widgets de hora, contexto y música en una rejilla de 12×6, con tres distribuciones (`margen`, `zonas`, `apilada`) o `rotar`, reacomodo cada `rearrangeMin` minutos y modo `calm`. Se configura en Ajustes del mando o con `tv_idle`.
- **Live Activities**: dentro del reposo van junto a la fecha; encima de cualquier otra web, como la isla de `tv-island.js`.
- **Escenario**: plantillas (`tasks`, `reminder`, `slides`) o HTML del agente, con datos en vivo y eventos de vuelta.
- **Spotify**: spotifyd es el altavoz Connect «Salón»; se maneja con la Web API (cuenta conectada en `/spotify/login?t=…`).

## Desarrollar en local
```
cd remote && npm ci
TV_NO_POINTER=1 node server.js            # crea remote/token; sin Chrome la tele sale «no disponible»
open "http://127.0.0.1:8787/?t=$(cat token)"   # el mando canjea el token maestro por un dispositivo admin
```
Para tener «tele», un Chrome aparte con `--remote-debugging-port=9222 --user-data-dir=/tmp/tv-chrome`. Sin `wpctl`
no hay volumen y sin OpenClaw el agente no responde; el resto funciona. `TV_SPOTIFY_BANNER=1` deja la barra
«Reproduciendo en…» de Spotify. Más variables en [docs/arquitectura.md](docs/arquitectura.md#configuración).

Pruebas: `node --test test/*.test.js test/unit/*.test.js` desde la raíz.

## En el servidor
```
cd remote && npm ci && cd ../mcp && npm ci && cd ..
scripts/install.sh                        # unidades systemd de usuario (spotifyd y tv-kiosk: systemd/README.md)
node remote/admin-link.js                 # enlace de admin de un solo uso para un móvil
```
Flujo de despliegue y comprobación de salud: [docs/como-se-hace.md](docs/como-se-hace.md#despliegue).
