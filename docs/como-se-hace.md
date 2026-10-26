# Cómo se hace

Recetas cortas para los cambios habituales. El porqué de cada pieza está en [arquitectura.md](arquitectura.md).

## Una orden nueva en el servidor

1. **Dónde**: en la capacidad que toca lo que la orden cambia (`remote/src/features/`): la página de la tele en
   `control.js`, el teclado en `keyboard.js`, el escenario en `stage.js`, la música en `spotify.js`, el reposo en
   `idle.js`; las de acceso en `src/auth/commands.js`.
2. **Declararla** en su lista `commands`, con el permiso al lado. Ejemplos reales:

   ```js
   // src/features/control.js
   { t: 'reload', run: async () => { await cdp.call('Page.reload', {}); return { ok: 1 }; } },  // perm 'any'
   { t: 'shot', perm: 'adminQuiet', run: m => shot(m) },
   { t: 'vol', perm: (m, P) => (m.d === 'up' && state.vol !== null && state.vol >= P.volMax ? 'Volumen máximo: ' + P.volMax + ' %' : null), run: m => vol(m.d) },
   { t: 'volset', clamp: (m, P) => ({ ...m, v: Math.min(Number(m.v) || 0, P.volMax) }), run: m => volSet(m.v) },
   // src/features/idle.js
   { t: 'idle', perm: (m, P) => (m.op === 'set' && !P.admin ? 'Solo el administrador' : null), quiet: true, run: m => idle.run(m) },
   ```

   - `perm`: una política de `src/auth/permissions.js` (`any`, `admin`, `adminQuiet`, `stage`, `web`, `agent`) o una
     función `(m, P, ctx) => texto del error | null`. Si hace falta una política reutilizable, se añade a `POLICIES`.
     Un permiso configurable nuevo va en `Perms`, `PERM_DEFAULT`, `ADMIN_PERMS` y `permSan`, y en la hoja de
     administración del mando (`features/admin.js`).
   - `clamp`: recorta la orden a lo permitido en vez de rechazarla.
   - `quiet: true` si es una consulta: no cuenta como uso y no retrasa el reposo.
   - Dentro de `run`, sanear la entrada (`Number(...)`, `String(...).slice(0, n)`) y devolver `{ ok: 1, … }` o
     `{ error: '…' }` (en español, se enseña en el mando). Una excepción se convierte en `{ error: e.message }`.
3. **Probarla** por fuera, contra el servidor real con el Chrome falso (`test/control.test.js`):

   ```js
   test('reproducir/pausar el vídeo de la página', async () => {
     assert.deepEqual(await cmd({ t: 'pp' }), { playing: true });
     assert.equal((await (await s.api('/api/state')).json()).media, 1);
   });
   // y lo que le llega a Chrome:
   await cmd({ t: 'reload' });
   await cdp.waitFor(m => m.method === 'Page.reload');
   ```

   El permiso, con un invitado por WebSocket, como en `test/contract.test.js` («permisos: un invitado no administra…»):
   `assert.match((await g.rpc({ t: 'devices' })).error, /administrador/)`.
4. **Quién la usa**: el mando con `cmd({ t: … })` o `rpc({ t: … })` (`mando/core/api.js`); los agentes, con una
   herramienta en `mcp/server.js` (`tool('tv_…', descripción, esquema zod, fn)` → `cmd(m)`), después
   `scripts/sync-plugin.sh` y una línea en `plugin/tv-canvas/skills/tv-canvas/SKILL.md`.

## Una capacidad nueva

```js
// remote/src/features/ejemplo.js
'use strict';
// Capacidad «ejemplo»: qué hace, en una frase.
/** @param {{ cdp: { call: Function }, log: { info: Function } }} deps */
module.exports = function createEjemplo({ cdp, log }) {
  async function hacer(m) { … return { ok: 1 }; }
  return {
    commands: [{ t: 'ejemplo', perm: 'admin', run: m => hacer(m) }],
    routes: [],                       // solo si tiene rutas HTTP
  };
};
```

En `remote/server.js`: `require`, crearla en «capacidades» con sus dependencias explícitas, añadir `ejemplo.commands` a
la lista del `for` que llama a `commands.register(list)` y, si tiene, `...ejemplo.routes` en `createHttp({ routes })`.
Si necesita algo que se crea después, se le pasa como función (así lo hacen `idle: () => idle` en Spotify o
`nav: u => control.nav(u)` en el escenario). Si reacciona a Chrome, se llama desde los `hooks` de `createCdp`. Nada de
`process.env` (va en `src/core/config.js`) ni de trabajo al hacer `require`. Pruebas unitarias con dependencias falsas
en `test/unit/` y de contrato en `test/`.

## Una ruta HTTP

Una ruta es `{ path | prefix | re, anyMethod?, run(req, res, { url, p, ip, match }) }` y la aporta su capacidad. Sin
`anyMethod` solo atiende GET/HEAD. Con lo de `src/transport/http-util.js`:

```js
// src/features/spotify.js: con token y freno de intentos
{ path: '/spotify/login', run(req, res, { url, ip }) {
  if (blocked(ip)) return send(res, 429, 'demasiados intentos');
  if (!okToken(url.searchParams.get('t'))) { fail(ip); return send(res, 401, 'no autorizado'); }
  …
} },
// src/features/idle.js: solo para el Chrome de la tele
{ path: '/idle/art', run(req, res, { url }) {
  if (!isLocalTV(req)) return send(res, 403, 'solo desde la tele');
  return idle.art(req, res, url, send);
} },
```

Cuerpos con `readBody(req, max)` (devuelve `null` si se pasa: 413) y respuestas JSON con `json(res, code, obj)`. Si la
ruta estrena un primer segmento (`/nuevo/…`), añadir `'nuevo'` a `RESERVED` en `src/transport/static.js` para que
ninguna carpeta de `public/` lo tape. Pruebas: `test/transport.test.js` (contrato) y `test/unit/transport.test.js`.

## Una pantalla, hoja o feature del mando

1. **Marcado** en `remote/public/index.html`: la hoja `<div class="sheet" id="ejS" role="dialog" aria-label="…">` y el
   botón que la abre `<button class="b2" data-a="ej" data-click aria-label="…">`. Sin `style=`, `<style>` ni
   `<script>` en línea (la CSP los bloquea): estilos en `mando/styles/mando.css`.
2. **Módulo** `remote/public/mando/features/ej.js` con su descriptor; importa solo de `core/`, `ui/` y, sin ciclos, de
   otras features. Importaciones relativas y con `.js`. Nada al cargarse: todo en `init()`.

   ```js
   import { $ } from '../core/dom.js';
   import { cmd } from '../core/api.js';
   import { openSheet } from '../ui/sheets.js';

   export const ej = {
     name: 'ej',
     msgs: { ej: j => { … } },                         // mensajes { t: 'ej' } del servidor
     sheets: { ejS: { open() { … }, close() { … } } },
     clicks: { ej: () => openSheet('ejS') },           // [data-a=ej][data-click]
     acts: { ejGo: () => cmd({ t: 'ejemplo' }) },      // botones de orden directa [data-a=ejGo]
     init() { … },
   };
   ```

3. **Registro** en `mando/app.js`: `import { ej } from './features/ej.js';`, añadirlo a `register([...])` y a la lista
   de `init()` (el orden importa: es el de los listeners). Para reaccionar al rol: `on('me', j => …)` de `core/store.js`.
4. **Precarga** en `index.html`: `<link rel="modulepreload" href="/mando/features/ej.js">`.
5. **Pruebas**: `node --test test/unit/mando.test.js` (o `npm test`) falla si falta el `modulepreload`, si queda un módulo suelto, si
   hay un ciclo o una capa al revés, si algo se ejecuta al cargarse o si un fichero queda a más de 2 niveles de
   `public/`. Después, capturas antes/después (abajo) y, si es una pantalla nueva, su escena en `e2e/mando-capturas.js`.

## Colores de la tele

Se cambian en `remote/public/shared/tokens-tv.css` (Jota Dusk de la tele): un solo bloque `:root{…}` de declaraciones
simples, sin nada fuera. El reposo lo enlaza (`idle.html`) y la isla lo recibe del servidor delante de
`tv-island.js` (`src/tv/tokens.js`). No poner colores sueltos en `tv-island.js` (`test/unit/tv.test.js` lo vigila).
El mando (`shared/tokens-mando.css`) y las plantillas del escenario (`stage.css`) tienen sus propios tokens. Como los
estáticos se cargan al arrancar, en la tele el reposo cambia tras reiniciar `jota-screen`. Comprobar con las capturas
del reposo.

## Textos con el nombre de la pantalla

En el HTML de `public/` y en el manifiesto, `{{TV_NAME}}` se sustituye al cargar los estáticos por el nombre de la
pantalla (`TV_NAME`, escapado para HTML o JSON; `createStatic({ vars })` en `src/transport/static.js`). Nada de nombres
de casa, personas ni lugares en el código, las plantillas o las pruebas: `test/unit/config.test.js` y
`test/unit/scripts.test.js` lo vigilan. En el servidor, el nombre llega como `cfg.NAME` (`src/core/config.js`); el del
dueño, solo para las instrucciones del agente, como `cfg.OWNER` (`TV_OWNER`).

## Una variable de configuración nueva

1. Leerla solo en `remote/src/core/config.js` (con su valor por defecto) y pasarla a quien la use por sus dependencias.
   Si la usan los scripts de bash, su valor por defecto también en `jsc_load_config` (`scripts/lib.sh`).
2. Documentarla, comentada y con su valor por defecto, en `config/screen.env.example` y en
   [arquitectura.md](arquitectura.md#configuración).
3. Prueba en `test/unit/config.test.js` (y en `test/runtime.test.js` si cambia lo que se ve desde fuera).

## Control nativo de la tele por ADB

Opcional: apagar y encender la tele, cambiar entre J-Screen y la tele, la cruceta y el volumen real (el de la barra de la tele).
Sin `TV_ADB` todo sigue como antes (volumen de PipeWire).

1. En la tele (Google TV): Ajustes → Sistema → Acerca de → pulsar «Compilación del SO de Android TV» 7 veces; después, en
   Opciones para desarrolladores, activar «Depuración USB» (en esta tele también abre ADB por red, en el puerto 5555).
2. En el equipo de la pantalla: `sudo apt install adb`.
3. Con el usuario de la pantalla: `adb connect <ip-de-la-tele>:5555` y, en la tele, «¿Permitir depuración?» →
   «Permitir siempre». `adb devices` debe enseñar la tele como `device`.
4. La entrada de J-Screen: `adb -s <ip-de-la-tele>:5555 shell dumpsys tv_input` y buscar el HDMI al que está conectado el
   equipo (`state: 0`, el `inputId` de la sesión principal), p. ej. `com.mediatek.tvinput/.hdmi.HDMIInputService/HW4`.
5. En `screen.env`: `TV_ADB=<ip-de-la-tele>:5555` y `TV_INPUT=<inputId>`; para poner canales por número, también
   `TV_TDT=<inputId de la antena>` (el `TunerInputService`, p. ej. `com.mediatek.tvinput/.tuner.TunerInputService/HW0`).
   `systemctl --user restart jota-screen`.
   Con la IP fija en el router (la conexión ADB va por IP). En `spotifyd.conf`, `initial_volume = 100`: el volumen de Spotify
   es el de la tele. `scripts/doctor.sh` comprueba que `adb -s $TV_ADB get-state` diga `device`.
6. Si ha cambiado `mcp/` (herramientas nuevas para Jota): reiniciar el cliente del MCP a mano
   (`systemctl --user restart openclaw-gateway`; deja vivos los procesos del MCP viejo) y añadir las herramientas a su skill.

## Pruebas

```
npm ci && (cd remote && npm ci) && (cd mcp && npm ci)   # la primera vez: raíz, servidor y MCP (test/mcp.test.js lo necesita)
npm run verify                     # lint (eslint) + tipos (tsc) + pruebas, todo desde la raíz
npm test                           # solo las pruebas: node --test test/*.test.js test/unit/*.test.js
```

Contrato y unitarias, en unos 20 s, sin Chrome, sin X y sin salir a internet. Detalle en [test/README.md](../test/README.md).

**Capturas** (`e2e/`, Playwright; la primera vez `cd e2e && npm ci`, que instala Chromium; el mando necesita
además `remote/node_modules`). Detalle en [e2e/README.md](../e2e/README.md):

```
node e2e/reposo-capturas.js [carpeta]                # reposo a 1920×1080, sin servidor (por defecto e2e/capturas)
node e2e/mando-capturas.js [carpeta]                 # mando en cada pantalla y hoja + ordenes.txt (por defecto e2e/capturas-mando)
python3 e2e/mando-compara.py ANTES DESPUES [--diff CARPETA]   # píxel a píxel y órdenes; sale con 1 si algo cambia (Pillow)
```

Para un refactor del mando: capturas en `main` a una carpeta, capturas con el cambio a otra, y comparar. También
`npm run e2e:reposo` y `npm run e2e:mando` desde la raíz, o `npm run mando:compara -- ANTES DESPUES` desde `e2e/`.
`CHROME=/ruta` usa otro navegador; `NODE_PATH` si Playwright está en otro sitio.

**Lint y tipos**: `npm run lint` (`eslint.config.js` en la raíz, ESLint 9 con `globals`, versiones fijadas en el
`package.json` de la raíz) y `npm run check` (`tsc` sobre `remote/` y sobre los módulos del mando con
`remote/tsconfig.mando.json`). Las funciones que se mandan a evaluar al navegador (por CDP o con Playwright) viven en
ficheros de Node; esos ficheros van en `PAGE_FUNCTION_FILES` de `eslint.config.js`, que les da los globales del navegador.
Si un fichero nuevo hace lo mismo, añadirlo a esa lista (corta a propósito).

## Despliegue

- Una rama por cambio; varias sesiones a la vez, cada una en su worktree (`.claude/worktrees/`, ignorado).
- **En el equipo de desarrollo**: `npm run verify` en verde → merge a `main` → `git push`.
- **En la pantalla** (por ssh, con el usuario de la pantalla, en la carpeta del clon):

  ```
  scripts/update.sh                 # fetch + merge --ff-only, npm ci si cambió el lock, reinicia jota-screen y doctor.sh
  ```

  Si avisa de que cambiaron las plantillas (`systemd/`, `config/`, nginx), `scripts/install.sh`; si cambió el kiosco,
  `sudo systemctl restart jota-screen-kiosk`. Si cambió el MCP, `(cd mcp && npm ci)`. Una variable nueva en
  `config/screen.env.example` no se copia sola a `screen.env`: añadirla a mano si se quiere otro valor.
- **Salud** tras reiniciar: `scripts/doctor.sh` (no cambia nada; sale con 1 si algo falla). Comprueba los servicios
  (`jota-screen`, `jota-screen-mdns`, `jota-screen-spotify` si está habilitado, `jota-screen-kiosk`), «CDP conectado»
  en el registro, `/api/state` con el token de `TV_STATE_DIR` (200 y `cdp:true`) y sin él (401), que el token no salga
  en el registro reciente (`--since MINUTOS`, 15 por defecto), los permisos del estado, que CDP solo escuche en
  127.0.0.1, el alias mDNS y, con `TV_ADB`, que la tele responda por ADB. Registro: `journalctl --user -u jota-screen -f` y `journalctl -u jota-screen-kiosk -f`.
- **Depurar la pantalla** a mano: `node scripts/cdp.js tabs`, `nav <url>`, `eval <js>`, `click <texto>`.

## Instalar en otra pantalla

1. En el equipo nuevo (Linux con systemd y X), con el usuario que será dueño de la pantalla, clonar en cualquier carpeta:
   `git clone https://github.com/Jota-project/jota-screen.git && cd jota-screen`.
2. `scripts/install.sh --dry-run`: dice qué falta (con la línea de `sudo apt install …`) y qué haría. Instalar lo que
   falte (Node 22+, Chrome o Chromium, xinit/Xorg, x11-xserver-utils, python3; y lo opcional: avahi, PipeWire,
   spotifyd, nginx).
3. `scripts/install.sh`: crea `~/.config/jota-screen/screen.env` desde la plantilla, la carpeta de estado, las
   dependencias del servidor y los servicios de usuario.
4. Editar `~/.config/jota-screen/screen.env` si hace falta (`TV_NAME`, salida de vídeo con
   `DISPLAY=:0 xrandr --query`, `TV_MDNS_NAME` distinto si ya hay otra pantalla con `mando.local` en la red, ubicación
   del tiempo…) y `systemctl --user restart jota-screen`.
5. Ejecutar los comandos `sudo` que enseña el instalador para el kiosco (instalar `jota-screen-kiosk.service` en
   `/etc/systemd/system/`, `daemon-reload`, `enable --now`), o `scripts/install.sh --system` si hay sudo sin contraseña.
   Si hay nginx, también los del proxy.
6. `scripts/doctor.sh` hasta que todo salga con ✓, y `node remote/admin-link.js` para el primer móvil admin.
7. Spotify (opcional): `clientId` de una app de Spotify en `$TV_STATE_DIR/spotify.json`, `TV_PUBLIC_URL` con la URL a la
   que vuelve Spotify (`…/spotify/callback`), y conectar la cuenta desde el mando.

## Migrar una instalación antigua (tv-remote/tv-kiosk, estado en remote/)

Las instalaciones de antes del producto replicable tienen las unidades `tv-remote`, `tv-mdns` y `spotifyd` (usuario) y
`tv-kiosk` (sistema), el estado junto al código (`remote/token`, `remote/devices.json`, `remote/access.json`,
`remote/spotify.json`, `remote/idle.json`), el escenario en `~/tv/stage` y el perfil de Chrome en `~/tv/chrome-profile`.
Se migra **en la misma carpeta del repo** (el servidor busca el estado antiguo en el `remote/` del código que arranca).
En los ejemplos, el clon está en `~/tv`.

1. **Copia de seguridad** del estado y de las unidades antiguas (el token y `spotify.json` son secretos: la copia,
   con 0600):

   ```
   cd ~/tv
   mkdir -p ~/jota-screen-backup && chmod 700 ~/jota-screen-backup
   tar czf ~/jota-screen-backup/estado.tgz -C ~/tv remote/token remote/devices.json remote/access.json \
       remote/spotify.json remote/idle.json stage chrome-profile 2>/dev/null; chmod 600 ~/jota-screen-backup/estado.tgz
   cp ~/.config/systemd/user/{tv-remote,tv-mdns,spotifyd}.service ~/jota-screen-backup/ 2>/dev/null
   systemctl cat tv-kiosk > ~/jota-screen-backup/tv-kiosk.service
   git rev-parse HEAD > ~/jota-screen-backup/commit          # para volver atrás
   ```

   (Ajustar la lista a lo que exista: `ls remote ~/tv`.)
2. **Actualizar el código**: `git fetch && git merge --ff-only origin/main` (la versión antigua aún no trae
   `scripts/update.sh`; si hay cambios locales, guardarlos antes).
3. **Crear `screen.env`** con los valores de la instalación antigua, para que todo se vea y se llame igual:

   ```
   mkdir -p ~/.config/jota-screen && chmod 700 ~/.config/jota-screen
   install -m 600 config/screen.env.example ~/.config/jota-screen/screen.env
   ```

   y descomentar en él:
   - `TV_NAME`: el nombre que tenía la pantalla (también el del altavoz de Spotify, para no perder el dispositivo en
     la app; o `TV_SPOTIFY_DEVICE` si eran distintos).
   - `TV_DISPLAY_OUTPUT` (y `TV_DISPLAY_MODE` / `TV_DISPLAY_RATE`): la salida, el modo y la frecuencia de la línea
     `xrandr` del `kiosk-session.sh` antiguo (`git show $(cat ~/jota-screen-backup/commit):kiosk-session.sh`).
   - `TV_NET_IFACE`: la interfaz que usaba `mdns-alias.sh`, si la detección automática no sirve.
   - `TV_PUBLIC_URL` (y el resto de `Environment=`) si la unidad `tv-remote` lo tenía (`~/jota-screen-backup/tv-remote.service`).
   - `TV_SPOTIFYD` con la ruta de spotifyd si la unidad `spotifyd` lo arrancaba desde una ruta fuera del PATH. Si había
     `~/.config/spotifyd/spotifyd.conf`, se sigue usando.
   - Ubicación del tiempo (`TV_CITY`, `TV_LAT`, `TV_LON`): solo si `idle.json` no la tenía; la de `idle.json` manda.
4. `scripts/install.sh --dry-run` para repasar y después `scripts/install.sh`: detiene y deshabilita `tv-remote`,
   `tv-mdns` y `spotifyd`, arranca `jota-screen`, `jota-screen-mdns` y `jota-screen-spotify`, y el servidor, al arrancar,
   **mueve** el estado a `~/.local/state/jota-screen` (o `TV_STATE_DIR`). Comprobarlo:
   `journalctl --user -u jota-screen -b | grep 'estado:'` (rutas «movido …», nunca el contenido).
5. `scripts/doctor.sh`: el kiosco aún sale con ✗ (sigue `tv-kiosk`).
6. **Kiosco**: ejecutar los comandos `sudo` que enseñó el instalador (instalan `jota-screen-kiosk.service`, hacen
   `systemctl disable --now tv-kiosk.service` y arrancan el nuevo). La pantalla se reinicia y `kiosk-session.sh` mueve
   `~/tv/chrome-profile` a `$TV_STATE_DIR/chrome-profile` (las sesiones de Netflix, YouTube… se conservan).
7. `scripts/doctor.sh` otra vez: todo con ✓. Los móviles emparejados siguen funcionando (mismos `devices.json` y token).
   Si el MCP de OpenClaw o de Claude tenía `TV_TOKEN_FILE=~/tv/remote/token`, quitarlo (por defecto ya lee
   `~/.local/state/jota-screen/token`) y `(cd mcp && npm ci)`. Si había un sitio de nginx propio para `mando.local`,
   cambiarlo por el que genera el instalador o dejarlo si apunta al mismo puerto.
8. **Limpieza**, cuando todo lleve unos días bien: borrar `~/.config/systemd/user/{tv-remote,tv-mdns,spotifyd}.service`
   y `systemctl --user daemon-reload`; `sudo rm /etc/systemd/system/tv-kiosk.service && sudo systemctl daemon-reload`;
   lo antiguo que el servidor no movió porque ya existía el nuevo (lo dice el registro: «no se mueve, ya existe»); y la
   copia de seguridad.

**Vuelta atrás** (antes de la limpieza):

```
sudo systemctl disable --now jota-screen-kiosk
systemctl --user disable --now jota-screen jota-screen-mdns jota-screen-spotify
cd ~/tv && git checkout "$(cat ~/jota-screen-backup/commit)"     # el código antiguo (rama separada)
S=~/.local/state/jota-screen
mv $S/token $S/devices.json $S/access.json $S/spotify.json $S/idle.json remote/ 2>/dev/null
mv $S/stage ~/tv/stage; mv $S/chrome-profile ~/tv/chrome-profile
systemctl --user enable --now tv-remote tv-mdns spotifyd
sudo systemctl enable --now tv-kiosk
```

(o restaurar `~/jota-screen-backup/estado.tgz` con `tar xzf … -C ~/tv` si se prefiere el estado de antes de migrar).
