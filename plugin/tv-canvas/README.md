# tv-canvas

Plugin para controlar la tele del salón (Chrome kiosco en green-house) desde Claude Code / Claude Desktop.

- `mcp/server.js`: servidor MCP (stdio) con 22 herramientas `tv_*`. Habla con la API del mando (`/api/cmd`).
- `skills/tv-canvas`: cuándo y cómo usarlas.

## Instalación fuera del servidor
1. `cd mcp && npm install`
2. Exporta `TV_TOKEN` con el token del mando (`~/tv/remote/token` en el servidor). La URL HTTPS de Tailscale va en `.mcp.json`.
3. Instala el plugin desde esta carpeta.

En el propio servidor basta con `TV_URL` por defecto (`http://127.0.0.1:8787`) y el fichero de token; así lo usa OpenClaw.
