#!/usr/bin/env node
'use strict';
// Enlace de administrador de un solo uso (caduca en 10 min) para dar el rol de admin a un móvil
// sin enseñarle el token maestro. Se ejecuta en el servidor: node remote/admin-link.js
// Pide el enlace al servidor del mando (los códigos viven en su memoria) con el token maestro de ./token.
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.TV_PORT) || 8787;
let token = '';
try { token = fs.readFileSync(path.join(__dirname, 'token'), 'utf8').trim(); } catch {}
if (!token) { console.error('No encuentro remote/token'); process.exit(1); }

fetch(`http://127.0.0.1:${PORT}/api/cmd`, {
  method: 'POST',
  headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
  body: JSON.stringify({ t: 'adminlink' }),
}).then(r => r.json()).then(j => {
  if (j.error) { console.error('Error:', j.error); process.exit(1); }
  console.log(`Enlace (un solo uso, caduca en ${j.minutes} min):\n  ${j.url}\nO escribe el código en «Tengo un código de administrador»:\n  ${j.code}`);
}).catch(e => { console.error('No se pudo contactar con el mando:', e.message); process.exit(1); });
