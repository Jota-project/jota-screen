# Capturas (e2e)

Capturas automáticas con Playwright (y una prueba de la geometría del reposo), con datos de ejemplo y sin tele: la **pantalla en reposo** (`remote/public/idle.html`)
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

## Geometría del reposo (solapes)

```sh
npm run e2e:solapes                      # desde la raíz; o: cd e2e && node reposo-solapes.js
npm run e2e:solapes -- --solo 1280x720,1920x1080@1.5 --capturas /tmp/solapes   # solo unos tamaños, y con capturas
```

Prueba automática (sale con 1 si algo falla) de que el reposo se ve bien en cualquier pantalla. Recorre
**9 tamaños × 9 escenas (margen, zonas y apilada, 3 cada una) × 4 juegos de datos = 324 combinaciones** en unos 50 s:

- tamaños CSS 1280×720, 1366×768, 1920×1080, 2560×1440, 3840×2160, 1024×768 (4:3) y 2560×1080 (21:9), y la tele de
  1920×1080 con escala 1,5 (la del kiosco, `--force-device-scale-factor=1.5`: 1280×720 CSS) y 2 (960×540 CSS);
- datos de mañana (11:14, «Nightsout» de «I Am Waiting For You Last Summer», un temporizador), sin música, tarde (20:48,
  «Miércoles, 30 de septiembre», lluvia, título larguísimo y dos actividades) y noche (23:16, en pausa).

En cada una mide con `getBoundingClientRect` las cajas visibles de cada widget (de los textos, la tinta: de la línea de
base, la altura real de los glifos) y falla si alguna se sale del **área segura** (3 % por cada lado, por el
sobrebarrido de la tele), si se sale de **su celda** de la rejilla más media separación, si **dos widgets distintos se
tocan**, si un texto recortado queda en una **columna de menos de 5 em** o si un texto se parte en **más de 2 líneas**.
Es determinista (hora fija, `Math.random` fijo, escenas colocadas al momento con `TVIdle.place`) y falla también con un
error de la página o una violación de la CSP.

`--capturas carpeta` guarda una captura por combinación (`<tamaño>-<distribución>-<escena>-<datos>.png`).
`REPOSO_PUBLIC=/ruta/a/remote/public` prueba otra copia (p. ej. la de `main` sacada con `git archive`), para comparar
capturas de antes y después de un cambio.

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
