'use strict';
// Capacidad «teclado»: teclas, texto y escribir en la tele en directo desde el editor del mando (orden `field`:
// el texto entero + la selección, en una cola que descarta lo intermedio), con plan B (escribir encima) y plan C
// (a ciegas con teclas). Y el aviso de foco: un script en un mundo aislado de la página avisa de qué campo tiene
// el foco; el valor solo va a admin o miembro con el teclado abierto y nunca si es una contraseña.
const crypto = require('node:crypto');
const { WebSocket } = require('ws');

/**
 * @param {{ cdp: any, log: { error: Function }, clients: () => Iterable<any>, devOf: (ws: any) => any }} deps
 */
module.exports = function createKeyboard({ cdp, log, clients, devOf }) {
  // ───────────────────────── escribir en la tele en directo
  // El mando tiene su propio editor y en cada cambio manda el texto entero y la selección; aquí se aplica al
  // elemento con foco. Autocontenida: se serializa a la página. Entra en iframes del mismo origen y en shadow DOM abiertos.
  function fieldInPage(o) {
    if (window.__tvFieldBoot !== o.boot) { window.__tvFieldBoot = o.boot; window.__tvFieldSeq = 0; } // servidor reiniciado: secuencia nueva
    if (o.seq <= (window.__tvFieldSeq || 0)) return { stale: 1 };   // llegó tarde: ya se aplicó uno más nuevo
    window.__tvFieldSeq = o.seq;
    let el = document.activeElement;
    for (let i = 0; el && i < 12; i++) {
      if (el.shadowRoot && el.shadowRoot.activeElement) { el = el.shadowRoot.activeElement; continue; }
      if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
        let d = null; try { d = el.contentDocument; } catch {}
        // el body cuenta si es editable (designMode, editores en iframe como TinyMCE o CKEditor 4)
        if (d && d.activeElement && (d.activeElement !== d.body || d.designMode === 'on' || (d.body && d.body.isContentEditable))) { el = d.activeElement; continue; }
      }
      break;
    }
    if (!el || !el.tagName) return { none: 1 };
    // ¿puede haber un editor que no se ve? iframe de otro origen, o un anfitrión de shadow DOM cerrado (con foco sin
    // ser enfocable por sí mismo). Solo entonces el servidor escribe a ciegas; en el body o en un botón, nunca.
    const hidden = /^(IFRAME|FRAME|EMBED|OBJECT)$/.test(el.tagName) ||
      (el !== el.ownerDocument.body && !el.hasAttribute('tabindex') && !/^(A|BUTTON|INPUT|SELECT|TEXTAREA|SUMMARY|AREA|VIDEO|AUDIO)$/.test(el.tagName) && !el.isContentEditable);
    const W = el.ownerDocument.defaultView, doc = el.ownerDocument;
    const v = String(o.value), n = v.length;
    const a = Math.min(n, Math.max(0, o.selStart | 0)), b = Math.min(n, Math.max(a, o.selEnd | 0));
    const isTa = el.tagName === 'TEXTAREA';
    const isIn = el.tagName === 'INPUT' && ['text', 'search', 'email', 'url', 'tel', 'number', 'password'].includes((el.getAttribute('type') || 'text').toLowerCase());
    if (isIn || isTa) {
      if (el.readOnly || el.disabled) return { none: 1 };
      if (el.value !== v) {
        // setter nativo: las webs hechas con React no ven un `el.value = …` normal
        Object.getOwnPropertyDescriptor((isTa ? W.HTMLTextAreaElement : W.HTMLInputElement).prototype, 'value').set.call(el, v);
        el.dispatchEvent(W.InputEvent ? new W.InputEvent('input', { bubbles: true, inputType: 'insertReplacementText' }) : new W.Event('input', { bubbles: true }));
        el.dispatchEvent(new W.Event('change', { bubbles: true }));
        if (el.value !== v) { try { el.select(); } catch {} return { fallback: 1 }; } // lo rechaza: el servidor lo teclea encima
      }
      try { el.setSelectionRange(a, b); } catch {}                       // number y email no admiten selección
      return { ok: 1 };
    }
    if (el.isContentEditable) {
      const sel = doc.getSelection();
      if (el.innerText.replace(/ /g, ' ').replace(/\n$/, '') !== v) {
        const r = doc.createRange(); r.selectNodeContents(el); sel.removeAllRanges(); sel.addRange(r);
        if (!doc.execCommand(v ? 'insertText' : 'delete', false, v)) return { fallback: 1 };
      }
      // selección por posiciones de texto (aproximada si hay saltos de línea)
      const at = off => {
        const w = doc.createTreeWalker(el, 4); let t;
        while ((t = w.nextNode())) { if (off <= t.length) return [t, off]; off -= t.length; }
        return [el, el.childNodes.length];
      };
      try { const r = doc.createRange(); r.setStart(...at(a)); r.setEnd(...at(b)); sel.removeAllRanges(); sel.addRange(r); } catch {}
      return { ok: 1 };
    }
    return hidden ? { none: 1, hidden: 1 } : { none: 1 };
  }
  // Aviso de foco: en cada documento de la pestaña activa. Al entrar o salir de un campo llama al binding __tvFocus
  // (Runtime.addBinding) con {kind, placeholder, value?}. De una contraseña nunca sale el valor.
  function focusWatch() {
    let root = window; try { if (window.top.document) root = window.top; } catch {}
    const foreign = root !== window.top;                                 // iframe de otro origen: no puede ver el foco de arriba
    // campos que alguna vez fueron contraseña (el botón del ojo los pasa a type=text): siguen siéndolo
    const pwSet = window.__tvPw || (window.__tvPw = new WeakSet());
    const markPw = el => { if (el && el.tagName === 'INPUT' && (el.getAttribute('type') || '').toLowerCase() === 'password') pwSet.add(el); };
    const deep = () => {
      let el = root.document.activeElement;
      for (let i = 0; el && i < 12; i++) {
        if (el.shadowRoot && el.shadowRoot.activeElement) { el = el.shadowRoot.activeElement; continue; }
        if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
          let d = null; try { d = el.contentDocument; } catch {}
          if (d && d.activeElement && (d.activeElement !== d.body || d.designMode === 'on' || (d.body && d.body.isContentEditable))) { el = d.activeElement; continue; }
        }
        break;
      }
      return el && el.tagName ? el : null;
    };
    const isPw = (el, type) => {                                         // en la duda, contraseña
      const set = (el.ownerDocument.defaultView || window).__tvPw;
      if (type === 'password' || (set && set.has(el))) return true;
      let sec = 'none'; try { sec = getComputedStyle(el).webkitTextSecurity || 'none'; } catch {}
      if (sec !== 'none') return true;
      const hint = [el.name, el.id, el.getAttribute('autocomplete')].join(' ');
      return /pass|pwd|contrase|clave/i.test(hint) || /(^|[^a-z])pin($|[^a-z])/i.test(hint);
    };
    const info = () => {
      const el = deep();
      if (!el || el.readOnly || el.disabled) return { kind: 'none', placeholder: '' };
      const tag = el.tagName, type = (el.getAttribute('type') || 'text').toLowerCase(), ce = tag !== 'INPUT' && tag !== 'TEXTAREA';
      let kind = 'none';
      if (tag === 'TEXTAREA' || (ce && el.isContentEditable)) kind = 'text';
      else if (tag === 'INPUT' && ['text', 'search', 'email', 'url', 'tel', 'number', 'password'].includes(type)) kind = 'text';
      if (kind === 'none') return { kind, placeholder: '' };
      // también las contraseñas que la web pasa a type=text para «mostrar»
      if (isPw(el, type)) kind = 'password';
      else if (type === 'search' || el.getAttribute('role') === 'searchbox' || el.closest('[role=search]') ||
        /search|busca/i.test([el.name, el.id, el.getAttribute('placeholder'), el.getAttribute('aria-label')].join(' '))) kind = 'search';
      const o = { kind, placeholder: String(el.getAttribute('placeholder') || el.getAttribute('aria-label') || el.getAttribute('data-placeholder') || el.title || '').trim().slice(0, 120) };
      if (kind !== 'password') o.value = String(ce ? el.innerText.replace(/\n$/, '') : el.value).slice(0, 2000);
      return o;
    };
    const report = force => {
      const o = info();
      if (foreign && (force || o.kind === 'none')) return;               // un iframe ajeno no pisa el foco de la página
      const s = JSON.stringify(o);
      if (!force && s === root.__tvFocusLast) return;
      root.__tvFocusLast = s;
      const f = root.__tvFocus || window.__tvFocus;                      // se busca al llamar: el binding se vuelve a poner al cambiar de pestaña
      if (typeof f === 'function') try { f(s); } catch {}
    };
    if (!window.__tvFocusOn) {
      window.__tvFocusOn = 1;
      const later = () => setTimeout(report, 0);                       // tras focusout llega el focusin del siguiente
      addEventListener('focusin', e => { markPw(e.target); markPw(e.composedPath && e.composedPath()[0]); later(); }, true);
      addEventListener('focusout', later, true);
      try {
        document.querySelectorAll('input[type=password]').forEach(markPw);
        new MutationObserver(ms => { for (const m of ms) if ((m.oldValue || '').toLowerCase() === 'password') pwSet.add(m.target); else markPw(m.target); })
          .observe(document, { subtree: true, attributes: true, attributeFilter: ['type'], attributeOldValue: true, childList: false });
      } catch {}
    }
    report(true);
  }
  let tvFocus = { t: 'focus', kind: 'none', placeholder: '' };
  // lo que hay escrito en la tele solo va a quien lo está editando: admin o miembro con la vista del teclado abierta
  // (un invitado nunca lo ve: podría ser una tarjeta, un código o un correo que ha escrito otro)
  function focusFor(c) {
    const d = devOf(c);
    if (!c || !c.kbOpen || (d && d.role === 'guest') || !('value' in tvFocus)) return { t: 'focus', kind: tvFocus.kind, placeholder: tvFocus.placeholder };
    return tvFocus;
  }
  function focusSet(o) {                                                // guarda el último foco y lo empuja a los mandos
    const kind = ['text', 'search', 'password'].includes(o && o.kind) ? o.kind : 'none';
    const f = { t: 'focus', kind, placeholder: kind === 'none' ? '' : String(o.placeholder || '').slice(0, 120) };
    if ((kind === 'text' || kind === 'search') && typeof o.value === 'string') f.value = o.value.slice(0, 2000);
    if (JSON.stringify(f) === JSON.stringify(tvFocus)) return;
    tvFocus = f;
    for (const c of clients()) if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify(focusFor(c)));
  }

  // Chrome de la tele (src/tv/cdp.js). Aquí solo lo que el mando hace con lo que pasa en la pestaña activa.

  // aviso de foco: el binding y el script se ponen en cada sesión nueva (al activar otra pestaña también).
  // Van en un mundo aislado («tv»): la web no ve el binding ni puede llamarlo para inventarse un foco.
  async function watchFocus() {
    const source = `(${focusWatch})()`, sid = cdp.session, tid = cdp.targetId;
    const steps = [
      () => cdp.call('Runtime.enable'),                              // para recibir Runtime.bindingCalled
      () => cdp.call('Page.enable'),                                 // sin él, el script de documento nuevo no se ejecuta
      () => cdp.call('Runtime.addBinding', { name: '__tvFocus', executionContextName: 'tv' }),
      () => cdp.call('Page.addScriptToEvaluateOnNewDocument', { source, worldName: 'tv' }),
      async () => { // el documento actual: su mundo aislado y vuelve a avisar del foco
        const w = await cdp.call('Page.createIsolatedWorld', { frameId: tid, worldName: 'tv' });
        if (cdp.session !== sid) return;
        cdp.worlds.set('tv', w.executionContextId);
        await cdp.call('Runtime.evaluate', { expression: source, contextId: w.executionContextId });
      },
    ];
    try { for (const f of steps) { if (cdp.session !== sid) return; await f(); } } // se aborta si cambia la sesión
    catch (e) { log.error('foco', e.message); }
  }
  function focusRefresh() { // vuelve a mirar el campo con foco (por si la web lo ha cambiado por su cuenta, o lo ha escrito un mando)
    const ctx = cdp.worlds.get('tv');
    if (!ctx) return Promise.resolve();
    return cdp.call('Runtime.evaluate', { expression: `(${focusWatch})()`, contextId: ctx }).catch(() => {});
  }

  const SPECIAL = {
    Enter: [13, 'Enter', '\r'], Backspace: [8, 'Backspace'], Tab: [9, 'Tab'], Escape: [27, 'Escape'],
    ArrowLeft: [37, 'ArrowLeft'], ArrowUp: [38, 'ArrowUp'], ArrowRight: [39, 'ArrowRight'], ArrowDown: [40, 'ArrowDown'],
    ' ': [32, 'Space', ' '], Home: [36, 'Home'], End: [35, 'End'], PageUp: [33, 'PageUp'], PageDown: [34, 'PageDown'],
    Delete: [46, 'Delete'],
  };
  function keyParams(k) {
    let s = SPECIAL[k];
    if (!s) {
      if (k.length !== 1) return null;
      const u = k.toUpperCase();
      if (/[A-Z]/.test(u)) s = [u.charCodeAt(0), 'Key' + u, k];
      else if (/[0-9]/.test(k)) s = [k.charCodeAt(0), 'Digit' + k, k];
      else return null;
    }
    const [vk, code, text] = s;
    return { key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, text };
  }
  function key(k) {
    const p = keyParams(k);
    if (!p) return { error: 'tecla no válida' };
    cdp.fire('Input.dispatchKeyEvent', { type: p.text ? 'keyDown' : 'rawKeyDown', ...p });
    cdp.fire('Input.dispatchKeyEvent', {
      type: 'keyUp', key: p.key, code: p.code, windowsVirtualKeyCode: p.windowsVirtualKeyCode, nativeVirtualKeyCode: p.nativeVirtualKeyCode,
    });
    return { ok: 1 };
  }

  // escribir en directo: una sola aplicación en marcha; las pendientes se sustituyen por la más nueva (las intermedias
  // sobran), salvo las que llegaron antes que una tecla: esas se aplican tal cual antes de ella
  const fieldQ = { busy: false, jobs: [], enq: 0, done: 0, barrier: 0, wait: [] };
  // la tecla espera a lo escrito que llegó antes que ella (no a lo que llegue después), con un tope de 3 s
  function fieldBefore() {
    const k = fieldQ.enq;
    if (fieldQ.done >= k) return null;
    fieldQ.barrier = Math.max(fieldQ.barrier, k);
    return new Promise(r => { const w = { k, r }; fieldQ.wait.push(w); setTimeout(() => { fieldQ.wait = fieldQ.wait.filter(x => x !== w); r(); }, 3000); });
  }
  const BOOT = crypto.randomBytes(4).toString('hex'); // la página reinicia su secuencia si cambia (servidor reiniciado)
  let fieldN = 0;
  function field(m, ws) {
    const seq = Number(m.seq) || 0;
    if (ws && seq) { if (seq <= (ws.fieldSeq || 0)) return { stale: 1, seq }; ws.fieldSeq = seq; } // la secuencia es de cada mando
    const value = String(m.value ?? '').slice(0, 2000), n = value.length;
    const pos = (x, d) => Number.isFinite(+x) ? Math.min(n, Math.max(0, Math.floor(+x))) : d;
    const selStart = pos(m.selStart, n), selEnd = Math.max(selStart, pos(m.selEnd, selStart));
    return new Promise(res => {
      const job = { n: ++fieldQ.enq, o: { value, selStart, selEnd }, seq, ws, res };
      const last = fieldQ.jobs[fieldQ.jobs.length - 1];
      if (last && last.n > fieldQ.barrier) { last.res({ ok: 1, skipped: 1, seq: last.seq }); fieldQ.jobs[fieldQ.jobs.length - 1] = job; }
      else fieldQ.jobs.push(job);
      if (!fieldQ.busy) fieldRun();
    });
  }
  async function fieldRun() {
    fieldQ.busy = true;
    while (fieldQ.jobs.length) {
      const j = fieldQ.jobs.shift();
      let r;
      try { r = await fieldApply({ ...j.o, seq: ++fieldN, boot: BOOT }, j.ws ? j.ws.fieldPrev : undefined); } catch (e) { r = { error: e.message }; }
      if (j.ws && !r.error && !r.stale) j.ws.fieldPrev = j.o.value;     // lo último que tiene la tele de este mando (para el plan C)
      fieldQ.done = j.n;
      j.res({ ...r, seq: j.seq });
      const ready = fieldQ.wait.filter(x => x.k <= fieldQ.done);
      for (const w of ready) { fieldQ.wait.splice(fieldQ.wait.indexOf(w), 1); w.r(); }
      if (ready.length) await new Promise(r => setImmediate(r));       // que salgan esas teclas antes del siguiente field
    }
    fieldQ.busy = false;
  }
  // plan C (no se ve el campo: iframe de otro origen, shadow DOM cerrado): como antes, a ciegas con teclas.
  // Se borra lo que sobra respecto a lo último enviado por este mando y se escribe lo nuevo (supone el cursor al final).
  async function fieldBlind(v, prev = '') {
    const a = Array.from(prev), b = Array.from(v);
    let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++;
    const del = Math.min(a.length - i, 2000), add = b.slice(i).join('');
    if (!del && !add) return { none: 1, blind: 1 };                     // solo ha cambiado la selección: no se puede llevar
    const p = keyParams('Backspace');
    for (let k = 0; k < del; k++) {
      await cdp.call('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...p });
      await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', ...p });
    }
    if (add) await cdp.call('Input.insertText', { text: add });
    return { ok: 1, typed: 1, blind: 1 };
  }
  async function fieldApply(o, prev) {
    const r = await cdp.call('Runtime.evaluate', { expression: `(${fieldInPage})(${JSON.stringify(o)})`, returnByValue: true });
    const v = r && !r.exceptionDetails && r.result && r.result.value;
    if (!v || typeof v !== 'object') return { error: 'la página no ha aceptado el texto' };
    if (v.none && v.hidden) return fieldBlind(o.value, prev);
    if (!v.fallback) return v;
    // plan B (editores que rechazan el valor): ya está todo seleccionado; se escribe encima como si se tecleara
    if (o.value) await cdp.call('Input.insertText', { text: o.value });
    else {
      const p = keyParams('Backspace');
      await cdp.call('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...p });
      await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', ...p });
    }
    return { ok: 1, typed: 1 };
  }

  return {
    key, keyParams, field, fieldBefore, focusFor, focusSet, watchFocus, focusRefresh,
    focus: () => tvFocus,
    commands: [
      { t: 'key', run: async m => { const w = fieldBefore(); if (w) await w; return key(String(m.k)); } }, // lo escrito antes, primero
      { t: 'text', run: m => { cdp.fire('Input.insertText', { text: String(m.v ?? '').slice(0, 2000) }); return { ok: 1 }; } },
      { t: 'field', run: (m, { ws }) => field(m, ws) },
      { t: 'focus', quiet: true, run: async (m, { ws }) => { // el mando avisa al abrir o cerrar el teclado; va lo guardado y, si la web ha cambiado el campo, llega otro aviso
      if (ws && typeof m.open === 'boolean') ws.kbOpen = m.open;
      if (!ws || ws.kbOpen) await focusRefresh();               // primero se mira el campo: así no va un valor viejo
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(focusFor(ws)));
      return ws ? focusFor(ws) : { t: 'focus', kind: tvFocus.kind, placeholder: tvFocus.placeholder };
      } },
    ],
  };
};
