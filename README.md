# tv-canvas

Lienzo programable para la tele del salón (servidor `green-house`): Chrome en modo kiosco por HDMI,
controlado por un mando web (PWA), por el agente OpenClaw y por Claude (MCP / skill / plugin).

| Carpeta | Qué es |
|---|---|
| `remote/` | Servidor del mando (Node 24, puerto 8787): WS/HTTP, CDP, emparejamiento, escenario, Spotify |
| `mcp/` | MCP `tv-canvas` (stdio) |
| `plugin/tv-canvas/` | Plugin de Claude Code (skill + `.mcp.json`; su `mcp/server.js` es copia de `mcp/`) |
| `systemd/` | Unidades de usuario (`tv-remote`, `tv-mdns`, `spotifyd`) y del kiosco (sistema) |
| `scripts/` | `install.sh` (instala unidades), `sync-plugin.sh` |
| `kiosk-session.sh`, `home.html`, `mdns-alias.sh`, `cdp-*.js` | Sesión X del kiosco, portada, alias `mando.local`, utilidades CDP |

Specs, decisiones, roadmap y notas viven en el vault de Obsidian (`Producto Jota/tv-canvas/`), no aquí.
Secretos (`remote/token`, `devices.json`, `spotify.json`) quedan fuera del repo (ver `.gitignore`).

## Arranque
```
cd remote && npm ci && node server.js     # TV_SPOTIFY_BANNER=1 deja la barra «Reproduciendo en…» de Spotify
cd mcp && npm ci
scripts/install.sh                        # unidades systemd de usuario
```
