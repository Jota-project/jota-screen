'use strict';
// Reloj de la voz (remote/src/features/voice-sync.js) con PCM sintético: tramos de seno a 220 Hz con amplitud 0,3 (voz) y
// ceros (silencio), en PCM16 LE 24 kHz mono como los manda el Gateway.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vs = require(path.join(__dirname, '..', '..', 'remote', 'src', 'features', 'voice-sync'));
const { createVoiceSync, charAt, DEFAULT_MS_PER_CHAR, PAUSE_MS } = vs;

/** PCM de `ms` milisegundos: seno a 220 Hz (voz) o ceros (silencio). @param {number} ms @param {boolean} voice */
function pcm(ms, voice) {
  const n = ms * 24, b = Buffer.alloc(n * 2);
  if (voice) for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(0.3 * 32767 * Math.sin(2 * Math.PI * 220 * i / 24000)), i * 2);
  return b;
}
const voz = ms => pcm(ms, true), calla = ms => pcm(ms, false);
/** Como llega del Gateway: detrás de 3 bytes de cabecera (byteOffset impar) y en trozos que no cuadran con las ventanas. */
function feed(s, ...parts) {
  const all = Buffer.concat(parts);
  const frame = Buffer.concat([Buffer.from([0xA1, 0, 1]), all]);
  for (let i = 3; i < frame.length; i += 1001) s.pcm(frame.subarray(i, Math.min(frame.length, i + 1001)));
}

test('arranque con silencio inicial: la primera ancla es [arranque, 0]', () => {
  const s = createVoiceSync();
  s.text('Hola, ¿qué tal?');
  feed(s, calla(200));
  assert.deepEqual(s.anchors(), [], 'solo silencio: aún no ha empezado');
  feed(s, voz(400));
  assert.deepEqual(s.anchors(), [[200, 0]]);
  assert.equal(s.receivedMs(), 600);
});

test('una pausa de 300 ms tras «Hola.» se empareja con el hueco tras el punto', () => {
  const s = createVoiceSync();
  s.text('Hola. Qué tal estás hoy.');
  feed(s, voz(300), calla(300), voz(400));                 // «Hola.» a ~62 ms por letra: 5 × 62 ≈ 300
  assert.deepEqual(s.anchors(), [[0, 0], [300, 5], [600, 6]], 'fin de lo dicho y comienzo de la palabra siguiente');
});

test('una pausa de 120 ms (< PAUSE_MS) se ignora: es una respiración', () => {
  assert.ok(120 < PAUSE_MS);
  const s = createVoiceSync();
  s.text('Hola. Qué tal estás hoy.');
  feed(s, voz(300), calla(120), voz(400));
  assert.deepEqual(s.anchors(), [[0, 0]]);
});

test('una pausa lejos de cualquier puntuación (fuera de tolerancia) se ignora', () => {
  const s = createVoiceSync();
  s.text('Hola. Esta frase es bastante larga y no tiene ninguna coma en medio de lo que se dice ahora mismo.');
  feed(s, voz(2400), calla(300), voz(400));                // a 2,4 s se esperan ~39 letras: el punto más cercano está a 5 o a 99
  assert.deepEqual(s.anchors(), [[0, 0]]);
});

test('el carácter dicho nunca retrocede y se recorta a la longitud del texto', () => {
  const s = createVoiceSync();
  s.text('Hola, Sito.');
  feed(s, voz(400));
  assert.equal(s.at(-50), 0, 'antes del arranque, nada');
  assert.equal(s.at(124), 124 / DEFAULT_MS_PER_CHAR);
  assert.equal(s.at(100), 124 / DEFAULT_MS_PER_CHAR, 'no retrocede');
  assert.equal(s.at(60000), 'Hola, Sito.'.length, 'recortado al texto');
  // la función pura: interpola entre anclas y extrapola tras la última
  const a = [[100, 0], [400, 5], [700, 6]];
  assert.equal(charAt(a, 50, 50, 99), 0);
  assert.equal(charAt(a, 50, 250, 99), 2.5);
  assert.equal(charAt(a, 50, 550, 99), 5.5);
  assert.equal(charAt(a, 50, 800, 99), 8);
  assert.equal(charAt(a, 50, 800, 7), 7);
  assert.equal(charAt([], 50, 800, 7), 0);
});

// «Uno dos tres.» y «Cuatro cinco.» (13 letras cada una) a `ms` por letra, con dos pausas de 240 ms detrás
const TRES = 'Uno dos tres. Cuatro cinco. Seis siete ocho nueve.';
function dosPausas(ms, rateMsPerChar) {
  const s = createVoiceSync({ rateMsPerChar });
  s.text(TRES);
  feed(s, voz(13 * ms), calla(240), voz(13 * ms));
  const una = s.rate();
  feed(s, calla(240), voz(500));
  return { s, una };
}

test('rate() se recalibra con dos pausas y respeta [35, 120]', () => {
  assert.equal(createVoiceSync().rate(), DEFAULT_MS_PER_CHAR);
  const { s, una } = dosPausas(80);
  assert.equal(una, DEFAULT_MS_PER_CHAR, 'una sola pausa: aún la de por defecto');
  assert.deepEqual(s.anchors(), [[0, 0], [1040, 13], [1280, 14], [2320, 27], [2560, 28]]);
  assert.equal(s.rate(), 80);
  assert.equal(dosPausas(160, 120).s.rate(), 120, 'muy lento: se queda en 120');
  assert.equal(dosPausas(20, 35).s.rate(), 35, 'muy rápido: se queda en 35');
  assert.deepEqual(dosPausas(20, 35).s.anchors().map(a => a[1]), [0, 13, 14, 27, 28]);
});

test('texto que llega después que el audio: la pausa queda pendiente y se resuelve al llegar la puntuación', () => {
  const s = createVoiceSync();
  s.text('Hola');
  feed(s, voz(300), calla(300), voz(400));
  assert.deepEqual(s.anchors(), [[0, 0]], 'sin el punto aún: pendiente');
  s.text('Hola. Qué tal.');
  assert.deepEqual(s.anchors(), [[0, 0], [300, 5], [600, 6]]);
});

test('una pausa pendiente se descarta cuando el texto ya pasa de su tolerancia sin puntuación', () => {
  const s = createVoiceSync();
  s.text('Hola');
  feed(s, voz(300), calla(300), voz(400));
  s.text('Hola que tal estas tu hoy por aqui con todos. Bien.');
  assert.deepEqual(s.anchors(), [[0, 0]], 'el punto más cercano está a 45: fuera');
});

test('la voz de verdad con su ruido: el umbral de silencio sigue a la mediana de la voz', () => {
  const s = createVoiceSync();
  s.text('Hola. Adiós.');
  // la «pausa» es un murmullo al 3 % de la voz: por encima de 0,012, por debajo del 15 % de la mediana
  const murmullo = Buffer.alloc(300 * 24 * 2);
  for (let i = 0; i < 300 * 24; i++) murmullo.writeInt16LE(Math.round(0.03 * 32767 * Math.sin(2 * Math.PI * 220 * i / 24000)), i * 2);
  feed(s, voz(300), murmullo, voz(400));
  assert.deepEqual(s.anchors(), [[0, 0], [300, 5], [600, 6]]);
});
