# Pruebas

Pruebas de **contrato** (`test/*.test.js`) y **unitarias** por módulo (`test/unit/`), con el ejecutor de Node
(`node:test`), sin Chrome, sin X y **sin salir a internet**. Desde la raíz del repo:

```
npm ci && (cd remote && npm ci)   # la primera vez: herramientas de la raíz y dependencias del servidor
npm test                          # node --test test/*.test.js test/unit/*.test.js (unos 20 s)
npm run verify                    # lint + tipos + pruebas: lo que pasa la CI
node --test test/unit/mando.test.js   # un fichero suelto
```

## Contrato

Arrancan el servidor del mando real, aislado (`helpers/server.js`), y comprueban desde fuera lo que ven el mando, la
tele, el MCP y el agente: estáticos y CSP, API y tokens, emparejamiento, roles y permisos, ajustes del reposo, bloqueo
por intentos fallidos y que el token maestro no salga nunca en el registro. No dependen de cómo está organizado el
código por dentro: deben seguir pasando igual tras un refactor.

`start({ files, env, legacy, cdpPort })` copia `remote/` a una carpeta temporal (con `node_modules` enlazado), usa un
`HOME` temporal, el estado en `<tmp>/state` (`TV_STATE_DIR`), un puerto libre, sin Chrome (o el falso en `cdpPort`), sin
puntero X y con un agente falso (`TV_OPENCLAW=/bin/false`):

- `files`: estado inicial, p. ej. `{ 'spotify.json': {…} }`, escrito en `TV_STATE_DIR`; con `legacy: true`, donde
  estaba antes (junto a `server.js`), para probar la migración.
- `env`: variables de más (`TV_NAME`, `TV_LAT`…).
- Devuelve `s.base`, `s.port`, `s.token`, `s.state` (la carpeta de estado), `s.root`, `s.home`, `s.logs()`, `s.get`,
  `s.api` (con `Bearer`), `s.post`, `s.ws(token)` (cliente con `rpc` y espera por tipo) y `s.stop()`, que lo borra todo.

| Fichero | Qué cubre |
|---|---|
| `contract.test.js` | API, tokens, emparejar, roles y permisos, ajustes, registro sin el token maestro |
| `access.test.js` | bloqueo por intentos (5 fallos = 429 durante un minuto); cada caso en su propio servidor, porque todas las peticiones llegan desde 127.0.0.1 |
| `control.test.js` | con un **Chrome falso** (`helpers/fake-cdp.js`, habla lo justo de CDP, apunta lo que recibe y emite eventos): teclas, texto, navegación, código de emparejar en la tele, aviso de foco, escenario, avisos, agente, escribir en directo y reconexión sin tele |
| `transport.test.js` | rutas HTTP (CSP, métodos, tamaños, páginas del escenario solo para la tele) y canales WebSocket |
| `spotify.test.js` | la espera por 429 sobrevive a un reinicio (estado inicial con `start({ files })`) |
| `runtime.test.js` | producto replicable: sin configuración, «Pantalla» y estado privado en `TV_STATE_DIR`; `TV_NAME` y la ubicación del tiempo desde el entorno (`{{TV_NAME}}` en el mando); migración del estado antiguo (`legacy`) |

**Sin internet**: sin `TV_LAT`/`TV_LON` el reposo no pide el tiempo. Cuando una prueba sí da ubicación, carga
`helpers/fetch-spy.js` en el servidor (`NODE_OPTIONS=--require …`): intercepta las peticiones a Open-Meteo, responde un
tiempo fijo y apunta en el registro `fetch-spy: open-meteo <lat>,<lon>` para comprobar qué se pidió.

## Unitarias (`test/unit/`)

| Fichero | Qué cubre |
|---|---|
| `config.test.js` | `src/core/config.js`: valores por defecto del contrato sin nada personal, las variables mandan, regla de `TV_ADMIN_URL`, OpenClaw en el PATH; `src/core/state-dir.js`: carpeta 0700, mover lo antiguo con 0600 sin enseñar contenido, nunca sobrescribir |
| `scripts.test.js` | `scripts/lib.sh` (xrandr, `ip route`, config, urlencode, perfil de Chrome), plantillas sin nada personal y sin marcadores sin rellenar, `install.sh` (`--dry-run`, sin systemd, idempotente, se para si falta algo), `kiosk-session.sh`, `mdns-alias.sh`, `doctor.sh`, `update.sh` y `scripts/cdp.js` contra un Chrome falso. HOME temporal, copia del repo y órdenes falsas en el PATH (`systemctl`, `sudo`, `xrandr`, `npm`…): no toca el sistema. `bash -n` siempre y `shellcheck` si está |
| `mando.test.js` | módulos ES del mando desde `mando/app.js`: sin ciclos, capas en un solo sentido (core ← ui ← features ← app), cada importación servida por `createStatic` (2 niveles de carpeta), ningún módulo suelto, un `modulepreload` por módulo y ninguno (salvo `app.js`) con efectos al cargarse |
| `auth.test.js` | acceso (`src/auth`) y registro de órdenes, con dobles de las sesiones y de la tele |
| `core.test.js` | núcleo (`src/core`) y freno de intentos |
| `transport.test.js` | transporte, estado de la tele y sondeo de la página |
| `tv.test.js` | adaptadores de la tele: CDP, puntero, volumen, sondeo de la página y tokens de la isla |

## Capturas y CI

Las capturas de la pantalla en reposo y del mando están en `e2e/` (Playwright; ver [e2e/README.md](../e2e/README.md)):
`e2e/mando-capturas.js` saca el mando en cada pantalla y hoja y registra las órdenes que manda en un recorrido fijo;
`e2e/mando-compara.py ANTES DESPUES` compara dos tandas píxel a píxel y las órdenes. No forman parte de `npm test`.

La CI (`.github/workflows/ci.yml`, se añade aparte) ejecuta `npm run verify` en cada push.
