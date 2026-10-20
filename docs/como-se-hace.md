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
5. **Pruebas**: `node --test test/unit/mando.test.js` falla si falta el `modulepreload`, si queda un módulo suelto, si
   hay un ciclo o una capa al revés, si algo se ejecuta al cargarse o si un fichero queda a más de 2 niveles de
   `public/`. Después, capturas antes/después (abajo) y, si es una pantalla nueva, su escena en `e2e/mando-capturas.js`.

## Colores de la tele

Se cambian en `remote/public/shared/tokens-tv.css` (Jota Dusk de la tele): un solo bloque `:root{…}` de declaraciones
simples, sin nada fuera. El reposo lo enlaza (`idle.html`) y la isla lo recibe del servidor delante de
`tv-island.js` (`src/tv/tokens.js`). No poner colores sueltos en `tv-island.js` (`test/unit/tv.test.js` lo vigila).
El mando (`shared/tokens-mando.css`) y las plantillas del escenario (`stage.css`) tienen sus propios tokens. Como los
estáticos se cargan al arrancar, en la tele el reposo cambia tras reiniciar `tv-remote`. Comprobar con las capturas
del reposo.

## Pruebas

```
cd remote && npm ci && cd ..
node --test test/*.test.js test/unit/*.test.js
```

Contrato y unitarias, en unos 15 s, sin Chrome ni X. Detalle en [test/README.md](../test/README.md).

**Capturas** (`e2e/`, Playwright; la primera vez `cd e2e && npm install`, que instala Chromium; el mando necesita
además `remote/node_modules`):

```
node e2e/reposo-capturas.js [carpeta]                # reposo a 1920×1080, sin servidor (por defecto e2e/capturas)
node e2e/mando-capturas.js [carpeta]                 # mando en cada pantalla y hoja + ordenes.txt (por defecto e2e/capturas-mando)
python3 e2e/mando-compara.py ANTES DESPUES [--diff CARPETA]   # píxel a píxel y órdenes; sale con 1 si algo cambia (Pillow)
```

Para un refactor del mando: capturas en `main` a una carpeta, capturas con el cambio a otra, y comparar. También
`npm run reposo`, `npm run mando` y `npm run mando:compara -- ANTES DESPUES` desde `e2e/`. `CHROME=/ruta` usa otro
navegador; `NODE_PATH` si Playwright está en otro sitio.

**Lint**: `eslint.config.js` en la raíz (ESLint 9 con `globals`), `npx eslint .`. Hoy carga `globals` desde una ruta
absoluta de la máquina donde se escribió y no declara los módulos ES del mando (`remote/public/mando/`) ni los globales
del navegador del reposo y la isla, así que da errores que no son del código; hay que ponerlo al día antes de fiarse de él.

## Despliegue

- Una rama por cambio; varias sesiones a la vez, cada una en su worktree (`.claude/worktrees/`, ignorado).
- **En el Mac**: pruebas en verde → merge a `main` → `git push`.
- **En green-house** (`ssh sito@192.168.1.19`, clon en `~/tv`, servicio de usuario `tv-remote` con
  `WorkingDirectory=%h/tv/remote`):

  ```
  cd ~/tv && git fetch && git merge --ff-only origin/main
  (cd remote && npm ci)                                 # solo si cambió package-lock.json
  systemctl --user restart tv-remote
  ```

  Si cambian las unidades de `systemd/user/`, `scripts/install.sh`. Si cambia el MCP, `cd mcp && npm ci`.
- **Salud** tras reiniciar:

  ```
  systemctl --user is-active tv-remote                                          # active
  journalctl --user -u tv-remote -n 50 | grep 'CDP conectado'                   # Chrome enganchado
  curl -s -H "Authorization: Bearer $(cat ~/tv/remote/token)" http://127.0.0.1:8787/api/state   # JSON con "cdp":true
  curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/api/state      # 401 sin token
  journalctl --user -u tv-remote | grep -cFf ~/tv/remote/token                  # 0: el token no está en el registro
  ```
