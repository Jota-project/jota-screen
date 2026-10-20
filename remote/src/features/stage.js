'use strict';
// @ts-check
// Capacidad «escenario»: contenido que el agente pone en la tele. Plantillas (tasks, reminder, slides) o HTML propio,
// con datos que se actualizan en vivo por un WebSocket local (/stage-ws), eventos de vuelta (tv.emit) y avisos
// emergentes (toast) encima de lo que se esté viendo.
const fs = require('node:fs');
const path = require('node:path');
const { WebSocket } = require('ws');
const { send, TYPES, isLocalTV } = require('../transport/http-util');
const { STAGE_CSP } = require('../transport/static');

/**
 * @param {{ cdp: { call: Function }, state: { url: string }, cfg: { SELF: string, HOME_URL: string, STAGE_DIR: string },
 *           nav: (url: string) => Promise<any> }} deps
 */
module.exports = function createStage({ cdp, state, cfg, nav }) {
  const { SELF, HOME_URL, STAGE_DIR } = cfg;
  fs.mkdirSync(STAGE_DIR, { recursive: true });
  // ───────────────────────── escenario: contenido que el agente pone en la tele
  // Plantillas (tasks, reminder, slides) o HTML propio. Los datos se actualizan en vivo por WebSocket local.
  const stage = { kind: null, data: null, prev: null, timer: null };
  const events = []; let evSeq = 0;
  const stageClients = new Set();
  const KINDS = new Set(['tasks', 'reminder', 'slides']);

  function stagePush() {
    const s = JSON.stringify({ t: 'data', data: stage.data });
    for (const c of stageClients) if (c.readyState === WebSocket.OPEN) c.send(s);
  }
  async function stageGo(url, kind, data, seconds) {
    if (!state.url.startsWith(SELF + '/')) stage.prev = state.url || null; // de dónde venimos, para volver
    stage.kind = kind; stage.data = data;
    clearTimeout(stage.timer);
    if (seconds > 0) stage.timer = setTimeout(stageClose, Math.min(seconds, 3600) * 1000);
    const r = await nav(url);
    return r.error ? r : { ok: 1, url: r.url };
  }
  async function stageClose() {
    clearTimeout(stage.timer); stage.kind = null;
    let r = stage.prev ? await nav(stage.prev) : { error: 1 };
    if (r.error) r = await nav(HOME_URL);
    return r;
  }
  async function present(m) {
    if (!KINDS.has(m.kind)) return { error: 'kind debe ser tasks, reminder o slides' };
    if (!m.data || typeof m.data !== 'object') return { error: 'falta data (objeto)' };
    return stageGo(`${SELF}/tpl-${m.kind}.html`, m.kind, m.data, Number(m.seconds) || 0);
  }
  async function show(m) {
    let html = String(m.html || '');
    if (!html.trim() || html.length > 1_000_000) return { error: 'html vacío o demasiado grande' };
    if (!/tv-stage\.js/.test(html)) { // el runtime va el primero, para que el HTML del agente ya pueda usar `tv`
      const tag = '<script src="/tv-stage.js"></script>';
      html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, h => h + tag)
        : /^\s*<!doctype[^>]*>/i.test(html) ? html.replace(/^\s*<!doctype[^>]*>/i, h => h + tag) : tag + html;
    }
    const id = 'p' + Date.now().toString(36);
    fs.writeFileSync(path.join(STAGE_DIR, id + '.html'), html);
    try { // conserva solo las 30 últimas
      const old = fs.readdirSync(STAGE_DIR).filter(f => /^p\w+\.html$/.test(f)).sort().slice(0, -30);
      for (const f of old) fs.unlinkSync(path.join(STAGE_DIR, f));
    } catch {}
    return stageGo(`${SELF}/stage/${id}.html`, 'html', m.data ?? {}, Number(m.seconds) || 0);
  }
  function stageUpdate(m) {
    if (!stage.kind) return { error: 'no hay nada en el escenario' };
    const d = m.data;
    if (d === undefined || d === null) return { error: 'falta data' };
    const obj = x => x && typeof x === 'object' && !Array.isArray(x);
    stage.data = m.replace || !obj(d) || !obj(stage.data) ? d : { ...stage.data, ...d };
    stagePush();
    return { ok: 1, data: stage.data };
  }
  function stageEvent(m) {
    if (m.name === '__close') return void stageClose();
    const e = { n: ++evSeq, ts: Date.now(), kind: stage.kind, name: String(m.name || '').slice(0, 60), payload: m.payload ?? null };
    if (stage.kind === 'tasks' && e.name === 'toggle' && Array.isArray(stage.data?.items)) {
      const it = stage.data.items.find(i => i && i.id === e.payload?.id);
      if (it) { it.done = !it.done; stagePush(); }
    }
    events.push(e); if (events.length > 200) events.shift();
  }

  // aviso emergente sobre lo que se esté viendo (incluso a pantalla completa)
  function toastInPage(o) {
    const host = document.fullscreenElement || document.documentElement;
    let box = document.getElementById('__tvtoast');
    if (!box || box.parentNode !== host) {
      if (box) box.remove();
      box = document.createElement('div'); box.id = '__tvtoast';
      box.style.cssText = 'position:fixed;top:28px;right:28px;z-index:2147483647;display:flex;flex-direction:column;gap:14px;width:min(560px,44vw);pointer-events:none;font-family:system-ui,sans-serif';
      host.appendChild(box);
    }
    const el = document.createElement('div');
    el.style.cssText = 'background:rgba(14,17,23,.94);color:#f2f5fa;border:1px solid rgba(255,255,255,.14);border-radius:20px;padding:20px 24px;box-shadow:0 18px 50px rgba(0,0,0,.55);display:flex;gap:16px;align-items:center';
    const ic = document.createElement('div'); ic.textContent = o.icon || '🔔'; ic.style.cssText = 'font-size:38px;line-height:1';
    const col = document.createElement('div');
    const t = document.createElement('div'); t.textContent = o.title; t.style.cssText = 'font-size:26px;font-weight:700;line-height:1.2';
    col.appendChild(t);
    if (o.text) { const p = document.createElement('div'); p.textContent = o.text; p.style.cssText = 'font-size:21px;opacity:.82;margin-top:4px;line-height:1.3'; col.appendChild(p); }
    el.append(ic, col); box.appendChild(el);
    el.animate([{ opacity: 0, transform: 'translateY(-16px) scale(.97)' }, { opacity: 1, transform: 'none' }], { duration: 260, easing: 'cubic-bezier(.2,.8,.2,1)' });
    setTimeout(() => {
      el.animate([{ opacity: 1 }, { opacity: 0, transform: 'translateY(-10px)' }], { duration: 300 }).onfinish = () => el.remove();
    }, o.secs * 1000);
  }
  async function toast(m) {
    const o = {
      title: String(m.title || '').slice(0, 120), text: String(m.text || '').slice(0, 400),
      icon: String(m.icon || '').slice(0, 8), secs: Math.min(Math.max(Number(m.seconds) || 8, 2), 120),
    };
    if (!o.title) return { error: 'falta title' };
    await cdp.call('Runtime.evaluate', { expression: `(${toastInPage})(${JSON.stringify(o)})` });
    return { ok: 1 };
  }

  /** Una página del escenario se conecta por /stage-ws (solo la tele): recibe los datos y manda sus eventos. */
  function onSocket(ws) {
    stageClients.add(ws);
    ws.on('error', () => {});
    ws.on('close', () => stageClients.delete(ws));
    ws.on('message', (d, bin) => { if (bin) return; try { const m = JSON.parse(d.toString()); if (m.t === 'event') stageEvent(m); } catch {} });
    if (stage.data) ws.send(JSON.stringify({ t: 'data', data: stage.data }));
  }

  /** Rutas HTTP: las páginas HTML que el agente ha puesto en el escenario (solo las pide el Chrome de la tele). */
  const routes = [{
    re: /^\/stage\/(p\w+)\.html$/,
    run(req, res, { match }) {
      if (!isLocalTV(req)) return send(res, 403, 'solo desde la tele');
      let buf; try { buf = fs.readFileSync(path.join(STAGE_DIR, match[1] + '.html')); } catch { return send(res, 404, 'no encontrado'); }
      return send(res, 200, req.method === 'HEAD' ? '' : buf, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-store', 'Content-Security-Policy': STAGE_CSP });
    },
  }];

  return {
    stage, events, clients: stageClients, onSocket, routes,
    lastEvent: () => evSeq,
    close: stageClose, event: stageEvent, toast,
    /** al navegar fuera del escenario, se olvida (y su cierre automático también) */
    leave() { stage.kind = null; clearTimeout(stage.timer); },
    /** @type {import('../transport/commands').Command[]} */
    commands: [
      { t: 'present', perm: 'stage', run: m => present(m) },
      { t: 'show', perm: 'stage', run: m => show(m) },
      { t: 'stage', perm: 'stage', run: m => stageUpdate(m) },
      { t: 'close', perm: 'stage', run: () => stageClose() },
      { t: 'toast', perm: 'stage', run: m => toast(m) },
    ],
  };
};
