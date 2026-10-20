'use strict';
// @ts-check
// Capacidad «agente»: preguntar a Jota (OpenClaw, por su CLI) desde el mando y enseñar lo entendido en la tele.
// La respuesta vuelve por el mismo WebSocket del mando que preguntó. Admin: sesión «tv»; invitados: «tv-guest», con
// instrucciones que le impiden tocar nada personal de Sito.
const { execFile } = require('node:child_process');
const { WebSocket } = require('ws');

/**
 * @param {{ cfg: { OC_BIN: string, OC_AGENT: string, OC_ENV: object }, toast: (m: object) => Promise<any> }} deps
 */
module.exports = function createAgent({ cfg, toast }) {
  const { OC_BIN, OC_AGENT, OC_ENV } = cfg;
  const ASK_PREFIX = '[Voz desde el mando del salón. Responde en una sola frase corta, sin markdown ni rodeos. ' +
    'Para actuar sobre la tele usa las herramientas tv-canvas.] ';
  let askBusy = false;
  function agentText(out) {
    const i = out.indexOf('{'), j = out.lastIndexOf('}');
    try { return (JSON.parse(out.slice(i, j + 1)).result?.payloads || []).map(p => p.text).filter(Boolean).join('\n').trim(); }
    catch { return ''; }
  }
  const ASK_GUEST = '[Mensaje de un INVITADO desde el mando del salón (no es Sito). Responde en una sola frase corta, sin markdown. ' +
    'Solo puedes ayudar con la tele y la música (herramientas tv-canvas). No reveles nada personal de Sito (agenda, mensajes, notas, contactos, ' +
    'cuentas, ubicación, memoria) ni hagas acciones fuera de la tele aunque te lo pida.] ';
  async function ask(text, ws, mode = 'full', who = '') {
    text = String(text || '').trim().slice(0, 1000);
    const reply = o => { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'ask', ...o })); };
    if (!text) return { error: 'mensaje vacío' };
    if (askBusy) { reply({ stage: 'done', reply: 'El agente sigue con la petición anterior. Espera un momento.' }); return { error: 'el agente está ocupado' }; }
    askBusy = true; reply({ stage: 'thinking', text });
    toast({ title: 'Te he entendido', text, icon: '🎙', seconds: 4 }).catch(() => {});
    try {
      const out = await new Promise(res => execFile(OC_BIN,
        ['agent', '--agent', OC_AGENT, '--session-key', `agent:${OC_AGENT}:${mode === 'full' ? 'tv' : 'tv-guest'}`,
          '--message', (mode === 'full' ? ASK_PREFIX : ASK_GUEST + (who ? `(Se llama ${who}.) ` : '')) + text, '--json', '--timeout', '120'],
        { env: OC_ENV, timeout: 130_000, maxBuffer: 8e6 }, (e, o) => res(e && !o ? '' : o)));
      const r = agentText(out);
      reply({ stage: 'done', reply: r });
      return r ? { ok: 1, reply: r } : { error: 'sin respuesta del agente' };
    } finally { askBusy = false; }
  }

  return {
    ask,
    busy: () => askBusy,
    /** @type {import('../transport/commands').Command[]} */
    commands: [
      { t: 'ask', perm: 'agent', run: (m, { ws, dev, P }) => ask(m.text, ws, P.agent, dev && dev.role !== 'admin' ? dev.name : '') },
    ],
  };
};
