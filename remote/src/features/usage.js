'use strict';
// @ts-check
// Registro de uso local: qué estuvo en pantalla (Netflix, web, Spotify). Solo { src, title, url, at }, 90 días,
// y no sale de la máquina. Lo lee A3 («Recientes») con list().

/**
 * @param {{ store: { load: () => any, save: (v: any) => void }, now?: () => number, enabled: () => boolean, keepDays?: number }} deps
 */
function createUsage({ store, now = Date.now, enabled, keepDays = 90 }) {
  /** @type {{ src: string, title: string, url: string, at: number }[] | null} */
  let items = null; // newest first; se lee una vez
  const load = () => items || (items = (() => { const r = store.load(); return Array.isArray(r) ? r.filter(x => x && typeof x.at === 'number') : []; })());

  return {
    /** @param {{ src: 'netflix' | 'web' | 'spotify', title: string, url?: string }} e */
    add(e) {
      if (!enabled()) return;
      const list = load(), at = now();
      const title = String(e.title || '').slice(0, 200), url = String(e.url || '').slice(0, 200);
      const top = list[0];
      // misma seguida: solo la hora (en la web basta la url: el título puede llegar tarde y se corrige)
      if (top && top.src === e.src && top.url === url && (e.src === 'web' || top.title === title)) { top.at = at; top.title = title; }
      else list.unshift({ src: e.src, title, url, at });
      items = list.filter(x => at - x.at <= keepDays * 864e5);
      store.save(items);
    },
    list: () => load().slice(),
  };
}

module.exports = createUsage;
