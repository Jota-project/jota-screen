'use strict';
// @ts-check
// Capacidad «control»: lo que hace un mando de toda la vida sobre la página de la tele. Navegar (con la dirección
// saneada), historial, reproducir/pausar y saltar en el vídeo, volumen de PipeWire, pulsar por texto o coordenadas,
// listar enlaces y capturar la pantalla. Cada orden lleva su permiso al lado.

/** La capa del agente deja pasar el puntero (o deja de hacerlo). @param {boolean} on */
const AGENT_PASS = on => `window.TVAgent&&window.TVAgent.pass&&window.TVAgent.pass(${on})`;

/**
 * @param {{
 *   cdp: { call: Function }, state: any, broadcast: () => void, key: (k: string) => any,
 *   audio: { read: Function, toggleMute: Function, step: Function, set: Function },
 *   cfg: { HOME_URL: string, SELF: string }, leaveStage: () => void,
 *   onLayout?: (url: string, layout: string) => void, onReload?: () => void, onNavigate?: () => void,
 *   netflix?: { isNetflix: (u: string) => boolean, open: (m: { url: string }) => Promise<any>, leave: () => Promise<void> },
 * }} deps   netflix: Netflix va en su propia pestaña (src/features/netflix.js); el resto de webs, en la de siempre
 *   onLayout: Jota pidió un formato para la conversación en la página que abre (`layout` de tv_open / tv_open_app)
 *   onNavigate: se va a navegar (la conversación de la tele espera a que la página nueva se pinte antes de cerrarse)
 *   onReload: se volvió a cargar la página que ya se veía (abrir la misma URL o «recargar»): documento nuevo sin cambio de
 *   URL, que Chrome no avisa como cambio de página (tv_idle show en el reposo, tv_open_app en la portada de la app…)
 */
module.exports = function createControl({ cdp, state, broadcast, key, audio, cfg, leaveStage, onLayout = () => {}, onReload = () => {}, onNavigate = () => {}, netflix }) {
  const { HOME_URL, SELF } = cfg;
  function normUrl(s) {
    s = s.trim();
    if (!s || s.length > 2000) return null;
    if (s === HOME_URL) return s;
    if (/^https?:\/\//i.test(s)) return s;
    if (/^[a-z][a-z0-9+.-]*:(?!\d+(\/|$))/i.test(s)) return null; // otros esquemas (file:, javascript:, chrome:...) bloqueados
    const host = s.split(/[/?#]/)[0].replace(/:\d+$/, '');
    if (/^(localhost|\d{1,3}(\.\d{1,3}){3})$/i.test(host)) return 'http://' + s;
    if (/^[\w-]+(\.[\w-]+)+$/.test(host) && !/\s/.test(s)) return 'https://' + s;
    return 'https://www.google.com/search?q=' + encodeURIComponent(s);
  }
  /** @param {any} url @param {any} [layout] 'pill' | 'panel' (lo demás se ignora) */
  async function nav(url, layout) {
    const u = normUrl(String(url || ''));
    if (!u) return { error: 'dirección no permitida' };
    if (!u.startsWith(SELF + '/')) leaveStage(); // salimos del escenario
    if (typeof layout === 'string' && layout) onLayout(u, layout); // antes de navegar: vale en cuanto se llega
    onNavigate();
    if (netflix && netflix.isNetflix(u)) { const r = await netflix.open({ url: u }); return r.error ? r : { ok: 1, url: u }; }
    if (netflix) await netflix.leave();          // Netflix delante: se queda cargada detrás y se vuelve a la pestaña de siempre
    const same = u === state.url;               // tras volver de Netflix: la URL ya es la de la pestaña de siempre
    await cdp.call('Page.navigate', { url: u });
    if (same) onReload();
    return { ok: 1, url: u };
  }
  async function hist(delta) {
    const h = await cdp.call('Page.getNavigationHistory');
    const e = h.entries[h.currentIndex + delta];
    if (e) await cdp.call('Page.navigateToHistoryEntry', { entryId: e.id });
    return { ok: 1 };
  }
  async function playpause() {
    const r = await cdp.call('Runtime.evaluate', {
      expression: '(()=>{const v=document.querySelector("video");if(!v)return -1;if(v.paused){v.play();return 1}v.pause();return 0})()',
      returnByValue: true,
    });
    const v = r?.result?.value;
    if (v === -1) return key(' ');
    state.media = v; broadcast();
    return { playing: v === 1 };
  }

  // volumen (PipeWire). Las pulsaciones seguidas se agrupan en una sola llamada.
  async function volRead() {
    const v = await audio.read();
    if (v) { state.vol = v.vol; state.muted = v.muted; }
  }
  let volQ = 0, volRun = false;
  async function vol(d) {
    if (d === 'mute') { await audio.toggleMute(); await volRead(); broadcast(); return { vol: state.vol, muted: state.muted }; }
    volQ += d === 'up' ? 1 : d === 'down' ? -1 : 0;
    if (!volRun) {
      volRun = true;
      try {
        while (volQ) {
          const n = volQ; volQ = 0;
          await audio.step(n);
        }
        await volRead();
      } finally { volRun = false; }
      broadcast();
    }
    return { vol: state.vol, muted: state.muted };
  }

  // interacción con la página actual: buscar y pulsar por texto, listar enlaces, clic por coordenadas, captura
  function clickable(pat, list) {
    const re = pat ? new RegExp(pat, 'i') : null;
    const out = [];
    for (const el of /** @type {NodeListOf<HTMLElement & { href?: string }>} */ (document.querySelectorAll('a,button,[role=button],[role=link],[role=menuitem],[role=tab],[tabindex],[aria-label]'))) {
      const t = (el.getAttribute('aria-label') || el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 120);
      if (!t || (re && !re.test(t))) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4 || r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') continue;
      const item = { text: t, href: el.href || undefined, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      if (!list) { el.click(); return { clicked: item }; }
      out.push(item); if (out.length >= 40) break;
    }
    return list ? out : null;
  }
  async function clickText(pat) {
    pat = String(pat || '').slice(0, 120);
    if (!pat) return { error: 'falta texto' };
    try { new RegExp(pat); } catch { return { error: 'expresión no válida' }; }
    const r = await cdp.call('Runtime.evaluate', { expression: `(${clickable})(${JSON.stringify(pat)}, false)`, returnByValue: true });
    return r?.result?.value || { error: 'no encontrado' };
  }
  async function links(pat) {
    pat = String(pat || '').slice(0, 120);
    try { if (pat) new RegExp(pat); } catch { return { error: 'expresión no válida' }; }
    const r = await cdp.call('Runtime.evaluate', { expression: `(${clickable})(${JSON.stringify(pat)}, true)`, returnByValue: true });
    return { items: r?.result?.value || [] };
  }
  async function clickAt(x, y) {
    x = Number(x); y = Number(y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { error: 'coordenadas no válidas' };
    const base = { x, y, button: 'left', clickCount: 1 };
    // la membrana de la conversación (tv-agent.js) recibe el puntero para arrastrarla: el clic de Jota pasa a través
    await cdp.call('Runtime.evaluate', { expression: AGENT_PASS(true) }).catch(() => {});
    try {
      await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
      await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
    } finally { await cdp.call('Runtime.evaluate', { expression: AGENT_PASS(false) }).catch(() => {}); }
    return { ok: 1 };
  }
  async function shot(m) {
    const lm = await cdp.call('Page.getLayoutMetrics');
    const v = lm.cssVisualViewport || lm.visualViewport;
    const w = Math.min(Math.max(Number(m.w) || 960, 320), 1920);
    const r = await cdp.call('Page.captureScreenshot', {
      format: 'jpeg', quality: 60, clip: { x: 0, y: 0, width: v.clientWidth, height: v.clientHeight, scale: Math.min(1, w / v.clientWidth) },
    });
    return { ok: 1, mime: 'image/jpeg', data: r.data };
  }
  async function seek(s) {
    s = Number(s);
    if (!Number.isFinite(s)) return { error: 'segundos no válidos' };
    const r = await cdp.call('Runtime.evaluate', {
      expression: `(()=>{const v=document.querySelector("video");if(!v)return -1;v.currentTime=Math.max(0,v.currentTime+(${s}));return v.currentTime})()`,
      returnByValue: true,
    });
    return r?.result?.value === -1 ? { error: 'no hay vídeo' } : { ok: 1, t: r?.result?.value };
  }
  async function volSet(v) {
    v = Math.min(100, Math.max(0, Number(v)));
    if (!Number.isFinite(v)) return { error: 'volumen no válido' };
    await audio.set(v);
    await volRead(); broadcast();
    return { vol: state.vol, muted: state.muted };
  }

  /** @type {import('../transport/commands').Command[]} */
  const commands = [
    // webs y navegación
    { t: 'nav', perm: 'web', run: m => nav(m.url, m.layout) },
    { t: 'links', perm: 'web', run: m => links(m.text) },
    { t: 'clicktext', perm: 'web', run: m => clickText(m.text) },
    { t: 'click', perm: 'web', run: m => clickAt(m.x, m.y) },
    { t: 'home', run: () => nav(HOME_URL) },
    { t: 'back', run: () => hist(-1) },
    { t: 'forward', run: () => hist(1) },
    { t: 'reload', run: async () => { await cdp.call('Page.reload', {}); onReload(); return { ok: 1 }; } },
    { t: 'shot', perm: 'adminQuiet', run: m => shot(m) },
    // reproducción y volumen
    { t: 'pp', run: () => playpause() },
    { t: 'seek', run: m => seek(m.s) },
    { t: 'fs', run: () => key('f') },
    { t: 'vol', perm: (m, P) => (m.d === 'up' && state.vol !== null && state.vol >= P.volMax ? 'Volumen máximo: ' + P.volMax + ' %' : null), run: m => vol(m.d) },
    { t: 'volset', clamp: (m, P) => ({ ...m, v: Math.min(Number(m.v) || 0, P.volMax) }), run: m => volSet(m.v) },
  ];

  return { nav, normUrl, hist, playpause, vol, volSet, volRead, clickText, links, clickAt, shot, seek, commands };
};
