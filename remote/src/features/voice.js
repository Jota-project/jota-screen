'use strict';
// @ts-check
// Capacidad «voz»: hablar con el agente desde el mando. El audio grabado sube por HTTP (el WebSocket limita a 64 KB),
// se transcribe, la transcripción pasa por la misma orden `ask` que el texto escrito (mismos permisos y mismas
// instrucciones de invitado) y la respuesta se sintetiza. Se devuelve el texto y el audio suena en UN solo sitio:
// `out=tv` (por defecto) por los altavoces de la pantalla, `out=phone` en el móvil que preguntó, `out=none` en ninguno.
//
// STT y TTS van por la CLI de OpenClaw (`openclaw infer …`): así el servidor no guarda ninguna clave de proveedor.
// Las dos funciones están detrás de `engine` para poder cambiarlas (p. ej. a la API directa, más rápida) sin tocar la ruta.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { send, json, reqToken } = require('../transport/http-util');

const MAX_AUDIO = 4_000_000;                 // ~4 MB: de sobra para un minuto de voz comprimida
const TYPE_RE = /^audio\/(webm|ogg|mp4|mpeg|mp3|wav|x-wav|aac|x-m4a|m4a)(;|$)/i;
const EXT = { webm: 'webm', ogg: 'ogg', mp4: 'm4a', mpeg: 'mp3', mp3: 'mp3', wav: 'wav', 'x-wav': 'wav', aac: 'aac', 'x-m4a': 'm4a', m4a: 'm4a' };

/** Lee el cuerpo binario con tope. Devuelve null si pasa de `max`. @param {any} req @param {number} max */
async function readBuf(req, max) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > max) return null; chunks.push(c); }
  return Buffer.concat(chunks);
}

/**
 * Motor por defecto: la CLI de OpenClaw.
 * @param {{ bin: string, env: object, agent: string, sttModel?: string, ttsModel?: string, ttsVoice?: string }} o
 */
function cliEngine({ bin, env, agent, sttModel = 'elevenlabs/scribe_v2', ttsModel = 'elevenlabs/eleven_flash_v2_5', ttsVoice = '' }) {
  /** @param {string[]} args @param {number} ms @returns {Promise<string>} */
  const run = (args, ms) => new Promise(res => execFile(bin, args, { env, timeout: ms, maxBuffer: 4e6 }, (e, out) => res(e && !out ? '' : out)));
  const parse = out => { const i = out.indexOf('{'), j = out.lastIndexOf('}'); try { return JSON.parse(out.slice(i, j + 1)); } catch { return null; } };
  return {
    /** @param {string} file @param {string} lang @returns {Promise<string>} */
    async stt(file, lang) {
      const r = parse(await run(['infer', 'audio', 'transcribe', '--agent', agent, '--file', file, '--model', sttModel, '--language', lang, '--json'], 60_000));
      return String(r?.outputs?.[0]?.text || '').trim();
    },
    /** @param {string} text @param {string} outFile @returns {Promise<boolean>} */
    async tts(text, outFile) {
      const args = ['infer', 'tts', 'convert', '--text', text, '--provider', ttsModel.split('/')[0], '--model', ttsModel, '--output', outFile, '--json'];
      if (ttsVoice) args.push('--voice', ttsVoice);
      const r = parse(await run(args, 60_000));
      return !!r?.outputs?.[0]?.path && fs.existsSync(outFile);
    },
  };
}

/**
 * @param {{
 *   cfg: { OC_BIN: string, OC_AGENT: string, OC_ENV: object, XDG_RUNTIME_DIR?: string, VOICE_LANG?: string, VOICE_STT_MODEL?: string, VOICE_TTS_MODEL?: string, VOICE_TTS_VOICE?: string },
 *   limiter: { blocked: (ip: string) => boolean, fail: (ip: string) => void },
 *   auth: { okToken: (t: any) => boolean, tokenDev: (t: any) => any },
 *   run: (m: any, ws: any, ctx: { dev: any }) => Promise<any>,
 *   engine?: { stt: (file: string, lang: string) => Promise<string>, tts: (text: string, outFile: string) => Promise<boolean> },
 *   play?: (file: string) => Promise<void>,
 * }} deps
 */
module.exports = function createVoice({ cfg, limiter, auth, run, engine, play }) {
  const eng = engine || cliEngine({ bin: cfg.OC_BIN, env: cfg.OC_ENV, agent: cfg.OC_AGENT, sttModel: cfg.VOICE_STT_MODEL, ttsModel: cfg.VOICE_TTS_MODEL, ttsVoice: cfg.VOICE_TTS_VOICE });
  const lang = cfg.VOICE_LANG || 'es';
  // el sonido de la pantalla: PipeWire, igual que el volumen (src/tv/devices.js)
  const player = play || (file => new Promise(res => {
    const p = spawn('pw-play', [file], { env: { ...process.env, XDG_RUNTIME_DIR: cfg.XDG_RUNTIME_DIR || process.env.XDG_RUNTIME_DIR }, stdio: 'ignore' });
    p.on('error', () => res()); p.on('close', () => res());
  }));
  let busy = false;
  const rm = d => fs.rmSync(d, { recursive: true, force: true });

  async function voice(req, res, { url, ip }) {
    if (req.method !== 'POST') return send(res, 405, '');
    if (limiter.blocked(ip)) return send(res, 429, 'demasiados intentos');
    const tok = reqToken(req, url);
    if (!auth.okToken(tok)) { limiter.fail(ip); return send(res, 401, 'no autorizado'); }
    const dev = auth.tokenDev(tok);
    const m = TYPE_RE.exec(String(req.headers['content-type'] || ''));
    if (!m) return json(res, 415, { error: 'formato de audio no admitido' });
    if (busy) return json(res, 429, { error: 'Sigo con la petición anterior. Espera un momento.' });
    busy = true;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jota-voice-'));  // propia de cada petición, con permisos 0700
    let keep = false;                                                    // true: la borra el reproductor al acabar
    try {
      const buf = await readBuf(req, MAX_AUDIO);
      if (buf === null) return send(res, 413, 'audio demasiado grande', { Connection: 'close' });
      if (buf.length < 400) return json(res, 400, { error: 'audio vacío' });
      const inFile = path.join(dir, 'in.' + (EXT[m[1].toLowerCase()] || 'webm'));
      fs.writeFileSync(inFile, buf, { mode: 0o600 });

      const text = await eng.stt(inFile, lang);
      if (!text) return json(res, 422, { error: 'No te he entendido. Prueba otra vez.' });

      // la transcripción entra como cualquier mensaje escrito: mismos permisos, misma sesión del agente
      const r = await run({ t: 'ask', text }, null, { dev });
      if (r.error) return json(res, 400, { text, error: r.error });
      /** @type {any} */
      const out = { ok: 1, text, reply: r.reply };

      // un solo destino: nunca suena a la vez en la tele y en el móvil (valor desconocido = tele, el de por defecto)
      const q = url.searchParams.get('out');
      const to = q === 'phone' || q === 'none' ? q : 'tv';
      const wantPhone = to === 'phone';
      const wantTv = to === 'tv';
      if ((wantPhone || wantTv) && r.reply) {
        const outFile = path.join(dir, 'out.mp3');
        if (await eng.tts(r.reply.slice(0, 600), outFile)) {
          if (wantPhone) out.audio = 'data:audio/mpeg;base64,' + fs.readFileSync(outFile).toString('base64');
          if (wantTv) { out.tv = true; keep = true; player(outFile).finally(() => rm(dir)); }
        }
      }
      return json(res, 200, out);
    } finally {
      busy = false;
      if (!keep) rm(dir);
    }
  }

  return {
    busy: () => busy,
    routes: [{ path: '/api/voice', anyMethod: true, run: voice }],
  };
};
module.exports.cliEngine = cliEngine;
