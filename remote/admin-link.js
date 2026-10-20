#!/usr/bin/env node
'use strict';
// Enlace de administrador de un solo uso (caduca en 10 min) para dar el rol de admin a un móvil
// sin enseñarle el token maestro. Se ejecuta en el servidor: node remote/admin-link.js
// Pide el enlace al servidor del mando (los códigos viven en su memoria) con el token maestro de TV_STATE_DIR/token.
// Lee la misma configuración que el servidor (TV_PORT, TV_STATE_DIR…: src/core/config.js).
const fs = require('node:fs');
const { loadConfig } = require('./src/core/config');

const CFG = loadConfig();
let token = '';
try { token = fs.readFileSync(CFG.FILES.token, 'utf8').trim(); } catch {}
if (!token) { console.error(`No encuentro el token en ${CFG.FILES.token} (¿ha arrancado el servidor alguna vez? ¿mismo TV_STATE_DIR?)`); process.exit(1); }

fetch(`${CFG.SELF}/api/cmd`, {
  method: 'POST',
  headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
  body: JSON.stringify({ t: 'adminlink' }),
}).then(r => r.json()).then(j => {
  if (j.error) { console.error('Error:', j.error); process.exit(1); }
  console.log(`Enlace (un solo uso, caduca en ${j.minutes} min):\n  ${j.url}\nO escribe el código en «Tengo un código de administrador»:\n  ${j.code}`);
}).catch(e => { console.error('No se pudo contactar con el mando:', e.message); process.exit(1); });
