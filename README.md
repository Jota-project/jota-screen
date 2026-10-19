# jota-screen

Lienzo programable para la tele del salón (servidor `green-house`): Chrome en modo kiosco por HDMI,
controlado por un mando web (PWA), por el agente OpenClaw y por Claude (MCP / skill / plugin).
Antes se llamaba `tv-canvas`; el MCP, la skill y el plugin conservan ese nombre para no romper configuraciones.

| Carpeta | Qué es |
|---|---|
| `remote/` | Servidor del mando (Node 24, puerto 8787): WS/HTTP, CDP, emparejamiento, roles, escenario, Spotify, reposo |
| `remote/public/` | Lo que se sirve: el mando (`index.html`), la pantalla en reposo (`idle.html` con `idle.css` e `idle-app.js`, sin nada en línea), la isla de Live Activities (`tv-island.js`), los tokens de la tele (`shared/tokens-tv.css`, que el servidor también inyecta en la isla) y las plantillas del escenario (`tpl-*.html`) |
| `mcp/` | MCP `tv-canvas` (stdio) |
| `plugin/tv-canvas/` | Plugin de Claude Code (skill + `.mcp.json`; su `mcp/server.js` es copia de `mcp/`, ver `scripts/sync-plugin.sh`) |
| `systemd/` | Unidades de usuario (`tv-remote`, `tv-mdns`, `spotifyd`) y del kiosco (sistema) |
| `scripts/` | `install.sh` (instala unidades), `sync-plugin.sh` |
| `e2e/` | Capturas automáticas (Playwright) de la pantalla en reposo y del mando, con datos de ejemplo; `mando-compara.py` compara dos tandas del mando |
| `kiosk-session.sh`, `home.html`, `mdns-alias.sh`, `cdp-*.js` | Sesión X del kiosco, portada, alias `mando.local`, utilidades CDP |

Specs, decisiones, roadmap y notas viven en el vault de Obsidian (`Producto Jota/tv-canvas/`), no aquí:
el roadmap con los frentes abiertos es `TVC Roadmap`, la técnica `TVC Arquitectura`.
Secretos y estado local (`remote/token`, `devices.json`, `spotify.json`, `idle.json`, `access.json`) quedan fuera del repo (ver `.gitignore`).

## Piezas principales
- **Mando** (`index.html`): v1 por defecto; el Mando v2 (Jota Dusk) se prueba con `?v=2` o en Ajustes → «Probar mando nuevo». Roles admin, miembro e invitado.
- **Pantalla en reposo v2** (`idle.html` + `idle.js`): widgets de hora, contexto y música en una rejilla de 12×6, con tres distribuciones (`margen`, `zonas`, `apilada`) o `rotar`, reacomodo cada `rearrangeMin` minutos y modo `calm`. Se configura en Ajustes del mando o con `tv_idle`.
- **Live Activities**: dentro del reposo van junto a la fecha; encima de cualquier otra web, como la isla de `tv-island.js`.

## Arranque
```
cd remote && npm ci && node server.js     # TV_SPOTIFY_BANNER=1 deja la barra «Reproduciendo en…» de Spotify
cd mcp && npm ci
scripts/install.sh                        # unidades systemd de usuario
```

## Flujo de trabajo
- Una rama por cambio; si trabajan varias sesiones a la vez, cada una en su worktree (`.claude/worktrees/`, ignorado).
- En el Mac: commit, merge a `main` y `git push`.
- En el servidor (`ssh sito@192.168.1.19`, árbol vivo en `~/tv`): `git pull --ff-only && systemctl --user restart tv-remote`.
