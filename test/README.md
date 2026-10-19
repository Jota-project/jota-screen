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

Las capturas de la pantalla en reposo están en `e2e/` (Playwright). La CI (`.github/workflows/ci.yml`) lanza todo en cada push.

Cada caso que bloquea la IP (5 fallos = 429 durante un minuto) va en su propio servidor (`access.test.js`),
porque todas las peticiones llegan desde 127.0.0.1.
