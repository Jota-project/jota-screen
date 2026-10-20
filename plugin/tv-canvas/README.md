# tv-canvas

Plugin para controlar la pantalla de jota-screen (Chrome en modo kiosco) desde Claude Code / Claude Desktop.

- `mcp/server.js`: servidor MCP (stdio) con 22 herramientas `tv_*`. Habla con la API del mando (`/api/cmd`).
  Es copia de `mcp/server.js` de la raíz del repo (`scripts/sync-plugin.sh`).
- `skills/tv-canvas`: cuándo y cómo usarlas.

## Configuración

`.mcp.json` toma dos variables del entorno en el que arranca Claude Code (expansión `${VAR:-por defecto}`):

| Variable | Por defecto | Qué es |
|---|---|---|
| `TV_URL` | `http://127.0.0.1:8787` | URL del mando: en el propio servidor, la de por defecto; desde otra máquina, la pública (`TV_PUBLIC_URL` del servidor, p. ej. `https://mi-servidor.example:8443`) |
| `TV_TOKEN` | (vacío) | Token del mando. Vacío: se lee del fichero `TV_TOKEN_FILE` o `$TV_STATE_DIR/token` (por defecto `~/.local/state/jota-screen/token`), que solo existe en el servidor |

## Instalación en el propio servidor
1. `cd mcp && npm install`
2. Instala el plugin desde esta carpeta. No hace falta exportar nada: usa `http://127.0.0.1:8787` y el fichero de token
   (si el servidor usa otro `TV_STATE_DIR`, exporta el mismo valor). Así lo usa OpenClaw.

## Instalación en otra máquina
1. `cd mcp && npm install`
2. Exporta `TV_URL` con la URL pública del mando y `TV_TOKEN` con el token (en el servidor: `~/.local/state/jota-screen/token`),
   por ejemplo en tu `~/.profile`:
   ```sh
   export TV_URL=https://mi-servidor.example:8443
   export TV_TOKEN=…
   ```
3. Instala el plugin desde esta carpeta y reinicia Claude Code para que lea las variables.
