# Pruebas

Pruebas de **contrato** (`test/*.test.js`) y **unitarias** por módulo (`test/unit/`). Las de contrato: arrancan el servidor del mando real, aislado (copia temporal de `remote/`, `HOME` temporal,
puerto libre, sin Chrome, sin puntero X y con un agente falso), y comprueban desde fuera lo que ven el mando, la tele,
el MCP y el agente: estáticos y CSP, API y tokens, emparejamiento, roles y permisos, ajustes del reposo, bloqueo por
intentos fallidos y que el token maestro no salga nunca en el registro.

No dependen de cómo está organizado el código por dentro: deben seguir pasando igual durante y después del refactor.

```
cd remote && npm ci && cd ..
node --test test/*.test.js test/unit/*.test.js
```

`control.test.js` usa un **Chrome falso** (`helpers/fake-cdp.js`): habla lo justo del protocolo CDP, apunta lo que recibe
y emite eventos como si vinieran de la página. Así se prueban teclas, texto, navegación, el código de emparejar en la tele,
el aviso de foco, el escenario, los avisos, el agente, escribir en directo y la reconexión sin tele. `transport.test.js` cubre
las rutas HTTP (CSP, métodos, tamaños, páginas del escenario solo para la tele) y los canales WebSocket. `spotify.test.js` arranca con estado inicial (`start({ files })`).
`unit/mando.test.js` recorre los módulos ES del mando desde `mando/app.js`: sin ciclos, capas en un solo sentido (core ← ui ← features ← app), cada importación servida por `createStatic` (que solo carga 2 niveles de carpeta), ningún módulo suelto, un `modulepreload` por módulo y ninguno (salvo app.js) con efectos al cargarse.

Las capturas de la pantalla en reposo y del mando están en `e2e/` (Playwright). `e2e/mando-capturas.js` saca el mando en cada pantalla y hoja (oscuro y claro, admin, invitado y emparejar, más escenas extra al final: apaisado, sin conexión, detalle de playlist, roles, códigos…) y registra las órdenes que manda en un recorrido fijo; `e2e/mando-compara.py ANTES DESPUES` compara dos tandas píxel a píxel y las órdenes. La CI (`.github/workflows/ci.yml`) lanza todo en cada push.

Cada caso que bloquea la IP (5 fallos = 429 durante un minuto) va en su propio servidor (`access.test.js`),
porque todas las peticiones llegan desde 127.0.0.1.
