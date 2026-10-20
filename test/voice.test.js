'use strict';
// Voz: /api/voice. Audio -> texto -> agente (misma orden `ask` que el texto escrito) -> voz.
// Usa un motor falso (sin red ni créditos) y un agente falso: lo que se prueba es la ruta, los permisos y los límites.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const createVoice = require('../remote/src/features/voice');

const AUDIO = Buffer.alloc(2000, 1);
const make = (over = {}) => {
  const calls = { stt: [], tts: [], play: [], run: [] };
  const engine = {
    stt: async (file, lang) => { calls.stt.push({ file, lang, bytes: fs.statSync(file).size }); return over.text === undefined ? 'pon algo de jazz' : over.text; },
    tts: async (text, out) => { calls.tts.push(text); fs.writeFileSync(out, Buffer.from('MP3')); return over.tts !== false; },
  };
  const v = createVoice({
    cfg: { OC_BIN: '/bin/false', OC_AGENT: 'x', OC_ENV: {}, XDG_RUNTIME_DIR: os.tmpdir() },
    limiter: { blocked: () => false, fail: () => { calls.fail = (calls.fail || 0) + 1; } },
    auth: { okToken: t => t === 'ok', tokenDev: () => null },
    run: async (m, ws, ctx) => { calls.run.push({ m, ctx }); return over.reply || { ok: 1, reply: 'Hecho, jazz en el salón.' }; },
    engine, play: async f => { calls.play.push(f); },
    transcode: async (inF, outF) => { calls.tx = (calls.tx || []).concat(inF); if (over.tx === false) return false; fs.writeFileSync(outF, Buffer.alloc(900, 2)); return true; },
  });
  const route = v.routes[0];
  const call = async ({ method = 'POST', token = 'ok', type = 'audio/webm;codecs=opus', body = AUDIO, q = '' } = {}) => {
    const { Readable } = require('node:stream');
    const req = Readable.from([body]); req.method = method; req.headers = { 'content-type': type, authorization: token ? 'Bearer ' + token : '' };
    let code = 0, data = '';
    const res = { headersSent: false, writeHead(c) { code = c; }, end(d) { data = d; } };
    await route.run(req, res, { url: new URL('http://x/api/voice' + q), ip: '1.1.1.1' });
    let j = null; try { j = JSON.parse(data); } catch {}
    return { code, data, j };
  };
  return { v, calls, call };
};

test('audio válido: transcribe, pregunta al agente como un mensaje escrito y devuelve texto y voz', async () => {
  const { calls, call } = make();
  const r = await call();
  assert.equal(r.code, 200);
  assert.equal(r.j.text, 'pon algo de jazz');
  assert.equal(r.j.reply, 'Hecho, jazz en el salón.');
  assert.deepEqual(calls.run[0].m, { t: 'ask', text: 'pon algo de jazz' }, 'va por la orden ask, con sus permisos');
  assert.equal(calls.stt[0].lang, 'es');
  assert.equal(calls.stt[0].bytes, 900, 'el WebM grabado, ya pasado a MP3');
  assert.equal(r.j.tv, true, 'por defecto suena en la tele');
  assert.equal(r.j.audio, undefined, 'y no vuelve audio al móvil');
  assert.equal(calls.play.length, 1);
});

test('la voz suena en un solo sitio: tele (por defecto), móvil o ninguno; nunca los dos', async () => {
  let m = make(); let r = await m.call({ q: '?out=tv' });
  assert.equal(r.j.tv, true); assert.equal(r.j.audio, undefined); assert.equal(m.calls.play.length, 1);
  m = make(); r = await m.call({ q: '?out=phone' });
  assert.match(r.j.audio, /^data:audio\/mpeg;base64,/); assert.equal(r.j.tv, undefined); assert.equal(m.calls.play.length, 0, 'en el móvil no suena la tele');
  m = make(); r = await m.call({ q: '?out=none' });
  assert.equal(r.j.audio, undefined); assert.equal(r.j.tv, undefined); assert.equal(m.calls.tts.length, 0, 'sin voz no se gastan créditos');
  for (const q of ['?out=both', '?out=tv,phone', '?out=', '?out=loquesea']) { // lo que no es un destino válido cae en la tele, nunca en los dos
    m = make(); r = await m.call({ q });
    assert.equal(r.j.tv, true, q); assert.equal(r.j.audio, undefined, q); assert.equal(m.calls.play.length, 1, q);
  }
});

test('sin token o con token malo: 401 y cuenta como fallo; no se toca el motor', async () => {
  const m = make();
  assert.equal((await m.call({ token: '' })).code, 401);
  assert.equal((await m.call({ token: 'mal' })).code, 401);
  assert.equal(m.calls.fail, 2);
  assert.equal(m.calls.stt.length, 0);
});

test('solo POST y solo audio', async () => {
  const m = make();
  assert.equal((await m.call({ method: 'GET' })).code, 405);
  assert.equal((await m.call({ type: 'application/json' })).code, 415);
  assert.equal((await m.call({ type: 'text/html' })).code, 415);
  assert.equal(m.calls.stt.length, 0);
});

test('audio vacío o demasiado grande', async () => {
  const m = make();
  assert.equal((await m.call({ body: Buffer.alloc(10) })).code, 400);
  assert.equal((await m.call({ body: Buffer.alloc(4_000_001) })).code, 413);
  assert.equal(m.calls.stt.length, 0);
});

test('no se entiende nada: 422 y el agente no se entera', async () => {
  const m = make({ text: '' });
  const r = await m.call();
  assert.equal(r.code, 422);
  assert.equal(m.calls.run.length, 0);
});

test('el agente no está disponible para este rol: el error sale tal cual y no se sintetiza nada', async () => {
  const m = make({ reply: { error: 'El agente no está disponible para ti' } });
  const r = await m.call();
  assert.equal(r.code, 400);
  assert.equal(r.j.error, 'El agente no está disponible para ti');
  assert.equal(r.j.text, 'pon algo de jazz', 'devuelve lo entendido');
  assert.equal(m.calls.tts.length, 0);
});

test('si falla la síntesis, el texto llega igual', async () => {
  const m = make({ tts: false });
  const r = await m.call();
  assert.equal(r.code, 200);
  assert.equal(r.j.reply, 'Hecho, jazz en el salón.');
  assert.equal(r.j.audio, undefined);
});

test('no deja ficheros temporales (salvo mientras suena en la tele)', async () => {
  const ls = () => fs.readdirSync(os.tmpdir()).filter(f => f.startsWith('jota-voice-'));
  const before = ls().length;
  const m = make();
  await m.call(); await m.call({ text: '' }); await m.call({ body: Buffer.alloc(10) });
  assert.equal(ls().length, before);
});

test('la respuesta se recorta antes de sintetizar (créditos)', async () => {
  const m = make({ reply: { ok: 1, reply: 'a'.repeat(5000) } });
  await m.call();
  assert.equal(m.calls.tts[0].length, 600);
});

test('lo que no es MP3 (el WebM de Safari y Chrome) se pasa a MP3 antes de transcribir; si falla, va tal cual', async () => {
  let m = make(); await m.call({ type: 'audio/webm;codecs=opus' });
  assert.match(m.calls.tx[0], /in\.webm$/);
  assert.match(m.calls.stt[0].file, /stt\.mp3$/); assert.equal(m.calls.stt[0].bytes, 900, 'transcribe el convertido');
  m = make(); await m.call({ type: 'audio/mpeg' });
  assert.equal(m.calls.tx, undefined, 'el MP3 no se toca'); assert.match(m.calls.stt[0].file, /in\.mp3$/);
  m = make({ tx: false }); const r = await m.call({ type: 'audio/mp4' });
  assert.match(m.calls.stt[0].file, /in\.m4a$/, 'sin ffmpeg o si falla, el original'); assert.equal(r.code, 200);
});
