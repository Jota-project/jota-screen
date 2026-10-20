'use strict';
// @ts-check
// Estado de la tele que ven todos los mandos (título, dirección, volumen, vídeo, scroll, CDP) y su difusión:
// varios cambios seguidos se agrupan en un solo mensaje (30 ms). Con el reposo en pantalla lleva también su ambiente
// (`amb`: perfil y colores de la carátula), para que el mando tome el mismo color que la tele.
const { WebSocket } = require('ws');

const hostOf = u => { try { return new URL(u).host; } catch { return ''; } };

/**
 * @param {{ cdpUp: () => boolean, clients: () => Iterable<any>, ambient?: () => any }} o
 *   ambient: el del reposo (se crea después), o null si la tele no está en reposo
 */
function createTvState({ cdpUp, clients, ambient = () => null }) {
  // scroll: {pos, size} de 0 a 1, o null
  const state = { title: '', url: '', vol: /** @type {number | null} */ (null), muted: false, media: -1, scroll: /** @type {any} */ (null) };
  function publicState() {
    return {
      t: 'state', title: state.title, url: state.url, host: hostOf(state.url),
      vol: state.vol, muted: state.muted, media: state.media, cdp: cdpUp(), scroll: state.scroll, amb: ambient(),
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
