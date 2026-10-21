'use strict';
// Contraste del texto del cristal del agente (remote/public/tv-agent.js) en el peor fondo posible: la capa va encima de
// cualquier web, así que se prueba sobre blanco, negro y un amarillo saturado, por contexto (idle/music/video/web), de día
// y de noche y en cada nivel de cristal (A/B/C). Los valores salen del objeto LOOK del propio fichero (entre las marcas
// @look:inicio y @look:fin): si alguien cambia un color, un velo o un brillo, esta prueba lo vigila.
//
// Modelo de lo que se pinta bajo el texto, en este orden (como el navegador):
//  1. el fondo tras el backdrop-filter. El desenfoque de un color uniforme deja ese color, así que solo cuentan saturate
//     (matriz de feColorMatrix, recortada a 0–1) y brightness. Las funciones de filtro de CSS operan sobre los valores
//     sRGB codificados (Filter Effects 1; así lo hacen Chromium y Firefox); e2e/agente-capturas.js comprueba un píxel real
//     contra este mismo modelo para que el espacio de color no sea una suposición.
//  2. el velo de tinta (--sheet al --tint).
//  3. los brillos: el de la carátula (el mayor de glow.a y glow.b, con el peor color: blanco, porque los colores de la
//     carátula pueden ser cualquiera, mezclado con la tinta en la proporción glow.color, que es como lo pinta el CSS) y
//     el reflejo blanco de arriba (glow.sheen), apilados en su punto más fuerte. La sombra
//     de abajo (glow.shade) solo oscurece y con texto claro solo ayuda: no se cuenta.
//  4. para el título y el detalle de una ficha, su fondo (card).
//  5. para la palabra provisional, su opacidad (prov) mezclando el color del texto con el fondo.
// Umbrales (WCAG 2.x): texto principal (la respuesta, lo que dices ya final y el título de la ficha) ≥ 4,5:1 aunque sea
// grande. El historial (turno anterior, atenuado por color a propósito), la pista, el detalle de la ficha y la palabra
// provisional (que dura un instante) ≥ 3:1: todos miden ≥ 24 px a 1920 (letra grande para WCAG: 18 pt) y la tele se mira
// de lejos a pantalla completa, con su escala ya aplicada.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'remote', 'public', 'tv-agent.js'), 'utf8');
const m = SRC.match(/@look:inicio\s*\n\s*const LOOK = (\{[\s\S]*?\});\s*\n\s*\/\/ @look:fin/);
assert.ok(m, 'tv-agent.js debe tener `const LOOK = {…};` entre // @look:inicio y // @look:fin');
const LOOK = new Function('return (' + m[1] + ')')();

const MAIN = 4.5, LARGE = 3;
const BACKS = { blanco: '#ffffff', negro: '#000000', amarillo: '#ffd400' };

const hex = h => { const s = h.replace('#', ''); const f = s.length === 3 ? [...s].map(c => c + c).join('') : s; return [0, 2, 4].map(i => parseInt(f.slice(i, i + 2), 16) / 255); };
const clamp = x => Math.min(1, Math.max(0, x));
const mix = (top, a, under) => top.map((c, i) => a * c + (1 - a) * under[i]);
// saturate de Filter Effects (feColorMatrix type=saturate)
function saturate([r, g, b], s) {
  return [
    (0.213 + 0.787 * s) * r + (0.715 - 0.715 * s) * g + (0.072 - 0.072 * s) * b,
    (0.213 - 0.213 * s) * r + (0.715 + 0.285 * s) * g + (0.072 - 0.072 * s) * b,
    (0.213 - 0.213 * s) * r + (0.715 - 0.715 * s) * g + (0.072 + 0.928 * s) * b,
  ].map(clamp);
}
const lin = c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

/** Color bajo el texto de la lámina (sin ficha) para un fondo, contexto, nivel y modo. */
function glass(back, ctx, tier, night) {
  const c = LOOK.ctx[ctx], t = LOOK.tiers[tier];
  if (night) return mix(hex(LOOK.night.sheet), LOOK.night.tint, hex(back));
  let px = hex(back);
  if (t.filter) px = saturate(px, t.sat).map(x => clamp(x * c.bright));
  px = mix(hex(LOOK.sheet), t.tint != null ? t.tint : c.tint, px);
  const glowColor = mix([1, 1, 1], LOOK.glow.color, hex(LOOK.sheet)); // carátula blanca, ya mezclada con la tinta
  px = mix(glowColor, Math.max(LOOK.glow.a, LOOK.glow.b), px);
  return mix([1, 1, 1], LOOK.glow.sheen, px);
}

const CASES = [];
for (const ctx of Object.keys(LOOK.ctx)) for (const night of [false, true]) for (const tier of Object.keys(LOOK.tiers)) for (const [bn, back] of Object.entries(BACKS)) CASES.push({ ctx, night, tier, bn, back });

test('LOOK tiene los valores fijados en el contrato', () => {
  assert.deepEqual(Object.keys(LOOK.ctx).sort(), ['idle', 'music', 'video', 'web']);
  assert.equal(LOOK.ctx.idle.tint, 0.76); assert.equal(LOOK.ctx.video.tint, 0.88); assert.equal(LOOK.ctx.web.tint, 0.90);
  assert.equal(LOOK.ctx.idle.bright, 0.6); assert.equal(LOOK.ctx.web.bright, 0.5);
  assert.equal(LOOK.tiers.A.blur, 42); assert.equal(LOOK.tiers.A.sat, 1.7); assert.equal(LOOK.tiers.B.blur, 20); assert.equal(LOOK.tiers.C.tint, 0.97);
  assert.equal(LOOK.night.sheet, '#0c0c0c'); assert.equal(LOOK.night.tint, 1);
  assert.equal(LOOK.text.day.old, '#a39cad'); assert.equal(LOOK.text.night.old, '#6e6e6e');
});

test('contraste en el peor fondo: contexto × día/noche × nivel × fondo', () => {
  const bad = [], worst = { main: Infinity, large: Infinity };
  for (const k of CASES) {
    const bg = glass(k.back, k.ctx, k.tier, k.night);
    const T = LOOK.text[k.night ? 'night' : 'day'];
    const card = mix(hex(LOOK.card.fill), LOOK.card.alpha, bg); // también de noche: el CSS no le quita el fondo
    const prov = mix(hex(T.you), LOOK.prov, bg);
    const checks = [
      ['respuesta', T.main, bg, MAIN], ['lo que dices', T.you, bg, MAIN], ['título de ficha', T.main, card, MAIN],
      ['historial', T.old, bg, LARGE], ['pista', T.soft, bg, LARGE], ['detalle de ficha', T.soft, card, LARGE],
      ['palabra provisional', prov, bg, LARGE],
    ];
    for (const [what, fg, under, min] of checks) {
      const r = ratio(typeof fg === 'string' ? hex(fg) : fg, under);
      const slot = min === MAIN ? 'main' : 'large';
      worst[slot] = Math.min(worst[slot], r);
      if (r < min) bad.push(`${what} ${r.toFixed(2)}:1 < ${min} (${k.ctx}, ${k.night ? 'noche' : 'día'}, nivel ${k.tier}, fondo ${k.bn})`);
    }
  }
  assert.deepEqual(bad, [], bad.join('\n'));
  // red de seguridad: si el peor caso queda muy justo, que se vea en la salida
  assert.ok(worst.main >= MAIN && worst.large >= LARGE, JSON.stringify(worst));
});

test('el «!» de un fallo (ficha y orbe) se lee sobre todo el ámbar: ≥ 3:1 (objeto gráfico, WCAG 1.4.11)', () => {
  for (const back of [LOOK.warn, ...LOOK.warnOrb]) {
    const r = ratio(hex(LOOK.ink), hex(back));
    assert.ok(r >= LARGE, `tinta ${LOOK.ink} sobre ${back}: ${r.toFixed(2)}:1`);
  }
});
