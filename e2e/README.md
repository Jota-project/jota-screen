# Capturas (e2e)

Capturas automáticas con Playwright, con datos de ejemplo y sin tele: la **pantalla en reposo** (`remote/public/idle.html`)
y el **mando del móvil** (`remote/public/index.html`). Sirven de red de seguridad visual: se saca una tanda antes de un
cambio, otra después, y se comparan.

Tienen su propio `package.json` (Playwright y la fuente Fraunces) para no cargar las dependencias de la raíz ni las del
servidor con un navegador.

## Instalar

```sh
cd e2e
npm ci                                    # instala playwright y @fontsource-variable/fraunces
                                          # y descarga Chromium (postinstall: playwright install chromium)
npx playwright install-deps chromium      # solo la primera vez en Linux: bibliotecas del sistema (pide sudo)
```

El mando arranca el servidor real (`test/helpers/server.js`), así que necesita además las dependencias del servidor:

```sh
(cd remote && npm ci)
```

Para usar otro navegador ya instalado en vez del de Playwright: `CHROME=/ruta/a/chrome` en cualquiera de los dos scripts
(y `npm ci --ignore-scripts` para no descargar Chromium). Para que la fuente del reposo salga igual que en la tele,
conviene tener Inter instalada en el sistema (Fraunces la sirve el propio script).

## Reposo

```sh
npm run e2e:reposo                       # desde la raíz; o: cd e2e && node reposo-capturas.js [carpeta]
```

Sirve `remote/public` con un servidor mínimo y la misma CSP que el servidor real, y saca a 1920×1080 cada distribución
(margen, zonas, apilada) en sus tres escenas, más sin música, título largo, tarde y noche. Salida: `e2e/capturas/`
(o la carpeta que se pase; con `npm run`, una ruta relativa cuenta desde `e2e/`). Falla si la página lanza un error o hay una violación de la CSP.

## Mando

```sh
npm run e2e:mando                        # desde la raíz; o: cd e2e && node mando-capturas.js [carpeta]
```

Arranca el servidor aislado con un Chrome falso (`test/helpers/fake-cdp.js`) y un `wpctl` falso, y abre el mando en un
móvil de 390×844 a 2x, en tema oscuro y claro: cada pantalla y hoja (admin, invitado, emparejar, más escenas extra:
apaisado, sin conexión, detalle de playlist, roles, códigos…), y además apunta las órdenes que manda por WebSocket y los
`POST /pair/*` en un recorrido fijo. Es determinista (hora fija, `Math.random` fijo, sin animaciones, fuentes servidas en
local) y tarda unos 3 minutos. Salida: `e2e/capturas-mando/` (PNG y registro de órdenes; al empezar borra los `.png` y `.txt` que hubiera).
Falla si la página lanza un error o hay una violación de la CSP.

`MANDO_SOLO_EXTRA=1` saca solo las escenas extra (para depurarlas). Si Playwright no está en `e2e/node_modules`,
`NODE_PATH=/ruta/a/node_modules`.

## Comparar dos tandas del mando

```sh
python3 e2e/mando-compara.py ANTES DESPUES [--diff CARPETA]
```

Compara píxel a píxel cada escena y el registro de órdenes; con `--diff` guarda, por cada escena distinta, la de
`DESPUES` con los píxeles cambiados en rojo. Sale con 1 si hay alguna diferencia (escena distinta, que falta o que sobra,
u órdenes distintas). Necesita Python 3 con Pillow (`pip install pillow` o `apt install python3-pil`).

Flujo típico para un refactor:

```sh
git stash        # o: git switch main
npm run e2e:mando -- /tmp/antes
git stash pop    # o: git switch mi-rama
npm run e2e:mando -- /tmp/despues
python3 e2e/mando-compara.py /tmp/antes /tmp/despues --diff /tmp/diff
```

Las dos tandas tienen que salir de la **misma máquina, el mismo Chromium y el mismo `e2e/package-lock.json`**: otra
versión del navegador o de las fuentes del sistema cambia el suavizado de los píxeles. Por eso no hay capturas de
referencia en el repo.
