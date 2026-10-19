'use strict';
// @ts-check
// Estado de la tele que ven todos los mandos (título, dirección, volumen, vídeo, scroll, CDP) y su difusión:
// varios cambios seguidos se agrupan en un solo mensaje (30 ms).
const { WebSocket } = require('ws');

const hostOf = u => { try { return new URL(u).host; } catch { return ''; } };

/**
 * @param {{ cdpUp: () => boolean, clients: () => Iterable<any> }} o
 */
function createTvState({ cdpUp, clients }) {
  // scroll: {pos, size} de 0 a 1, o null
  const state = { title: '', url: '', vol: /** @type {number | null} */ (null), muted: false, media: -1, scroll: /** @type {any} */ (null) };
  function publicState() {
    return {
      t: 'state', title: state.title, url: state.url, host: hostOf(state.url),
      vol: state.vol, muted: state.muted, media: state.media, cdp: cdpUp(), scroll: state.scroll,
    };
  }
  let bTimer = null;
  function broadcast() {
    if (bTimer) return;
    bTimer = setTimeout(() => {
      bTimer = null;
      const s = JSON.stringify(publicState());
      for (const c of clients()) if (c.readyState === WebSocket.OPEN) c.send(s);
    }, 30);
  }
  /** Chrome se fue: la página deja de saberse. */
  function clearPage() { state.title = ''; state.url = ''; state.media = -1; state.scroll = null; }
  return { state, publicState, broadcast, clearPage, commands: [{ t: 'state', quiet: true, run: () => publicState() }] };
}

module.exports = { createTvState, hostOf };
