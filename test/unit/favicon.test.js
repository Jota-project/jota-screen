'use strict';
// Las páginas nuestras que enseña la tele llevan un icono explícito (vacío). Sin él, Chrome pide /favicon.ico a
// 127.0.0.1 al irse de ellas a otra web, y lo pide desde la web nueva: YouTube «quiere acceder a otras aplicaciones y
// servicios de este dispositivo» (Chrome 155, acceso a la red local), un aviso que tapa la esquina.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PUB = path.join(__dirname, '..', '..', 'remote', 'public');

test('las páginas de la tele (reposo y plantillas del escenario) llevan su icono', () => {
  const pages = fs.readdirSync(PUB).filter(f => f === 'idle.html' || /^tpl-.*\.html$/.test(f));
  assert.ok(pages.length >= 4);
  for (const f of pages) assert.match(fs.readFileSync(path.join(PUB, f), 'utf8'), /<link rel="icon" href="data:,">/, f);
});
