// Agente: el texto (escrito o dictado con el teclado) va a OpenClaw; la respuesta llega por el WebSocket.
import { $ } from '../core/dom.js';
import { cmd } from '../core/api.js';
import { buzz } from '../ui/haptics.js';
import { openSheet } from '../ui/sheets.js';

function onAsk(j) {
  const rep = $('#rep');
  if (j.stage === 'thinking') { rep.className = 'rep wait'; rep.textContent = 'Pensando'; return; }
  rep.className = 'rep'; rep.textContent = j.reply || 'No he recibido respuesta.'; buzz(12);
}

export const agent = {
  name: 'agent',
  msgs: { ask: onAsk },
  sheets: { agS: { open() { const agin = $('#agin'); agin.value = ''; agin.focus(); } } },
  clicks: { ag: () => openSheet('agS') },
  init() {
    const agin = $('#agin'), rep = $('#rep');
    agin.addEventListener('keydown', e => {
      if (e.key !== 'Enter' || e.isComposing) return;
      e.preventDefault(); const v = agin.value.trim();
      if (!v) return;
      cmd({ t: 'ask', text: v }); agin.value = ''; rep.className = 'rep wait'; rep.textContent = 'Pensando';
    });
  },
};
