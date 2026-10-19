// Abrir una dirección en la tele.
import { $ } from '../core/dom.js';
import { cmd } from '../core/api.js';
import { openSheet, closeSheet } from '../ui/sheets.js';

export const go = {
  name: 'go',
  sheets: { goS: { open() { const gin = $('#gin'); gin.value = ''; gin.focus(); } } },
  clicks: { go: () => openSheet('goS') },
  init() {
    const gin = $('#gin');
    gin.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      e.preventDefault(); const v = gin.value.trim();
      if (v) { cmd({ t: 'nav', url: v }); closeSheet(); }
    });
  },
};
