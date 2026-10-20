// Escribir en la tele: el móvil tiene su propio editor y en cada cambio manda el texto entero y la selección (agrupado
// por fotograma); la tele lo aplica al campo con foco. De una contraseña, la tele nunca manda el valor.
import { $ } from '../core/dom.js';
import { cmd, rpc, isUp, onWs } from '../core/api.js';
import { buzz } from '../ui/haptics.js';
import { openSheet, closeSheet } from '../ui/sheets.js';

let kbV, kbTa, kbPw, kbPwB, kbE;
let tvF = { kind: 'none', placeholder: '' };            // último foco que ha avisado la tele
let fSeq = 0, fAck = 0, fRaf = 0, fT = 0, fHold = /** @type {{ a: number, b: number } | false} */ (false), fLast = '', fComp = false, fTyped = 0, fOk = null, fErr = '', fBlind = false;
let fSynced = false;                                     // ¿el editor tiene lo mismo que el campo de la tele? Si no, no se manda hasta que se escriba
const kbOn = () => kbV.classList.contains('on');
const kbEd = () => kbPwB.hidden ? kbTa : kbPw;
function kbMode(pw) {                                    // contraseña <-> texto; el foco pasa al editor que toque
  if (pw === !kbPwB.hidden) return;
  const had = document.activeElement === kbTa || document.activeElement === kbPw;
  kbPwB.hidden = !pw; kbTa.hidden = pw;
  kbPw.value = ''; kbPw.type = 'password'; kbRvPaint();
  $('#kbL').htmlFor = pw ? 'kbPw' : 'kbTa';
  if (had) kbEd().focus();
}
function kbFill(j, replace) {                            // pone en el editor lo que hay en el campo de la tele
  if (j.kind === 'none') return;                         // sin campo: el editor se queda como está
  kbMode(j.kind === 'password');
  if (!replace) return;
  // la tele no manda lo escrito (invitados, vista cerrada) ni el de una contraseña: el editor no sabe qué hay, así que
  // abrir o mover el cursor no manda nada (no se borra el campo); solo al escribir
  if (j.kind !== 'password' && !('value' in j)) { fSynced = false; return; }
  fSynced = j.kind !== 'password';
  const e = kbEd(), v = j.kind === 'password' ? '' : String(j.value);
  e.value = v;
  try { if (document.activeElement === e) e.setSelectionRange(v.length, v.length); } catch {}
  fLast = v.length + ':' + v.length + ':' + v.length + ':' + v; // ya está así en la tele: no hace falta mandarlo
}
function kbOpen() {
  kbEd().focus();                                        // dentro del toque: si no, iOS no abre el teclado
  kbFill(tvF, true); kbPaint();
  cmd({ t: 'focus', open: true });                       // el servidor manda lo que hay en el campo solo con la vista abierta
}
function kbClose() { kbPw.value = ''; kbPw.type = 'password'; kbRvPaint(); cmd({ t: 'focus', open: false }); }
function kbOnline() {                                    // al (re)conectar: lo escrito sin conexión se manda ahora
  fLast = ''; fAck = fSeq;
  if (kbOn()) { kbFlush(); cmd({ t: 'focus', open: true }); }
  kbPaint();
}
function onTvFocus(j) {
  // el aviso sin valor del mismo campo conserva lo que este mando ya había escrito
  tvF = 'value' in j || j.kind !== tvF.kind || j.placeholder !== tvF.placeholder || !('value' in tvF) ? j : { ...j, value: tvF.value };
  fOk = null; fBlind = false;
  // con la vista abierta se actualiza el editor, salvo que el usuario esté escribiendo (no se le pisa)
  if (kbOn()) kbFill(j, !(fComp || Date.now() - fTyped < 1500 || fAck < fSeq));
  kbPaint();
}
function kbPaint() {
  const pw = !kbPwB.hidden, v = kbEd().value, n = v.length;
  const none = fOk === false || (fOk === null && tvF.kind === 'none');
  const m = $('#tvM'), t = $('#tvT');
  m.classList.toggle('pw', pw); m.classList.toggle('none', none);
  const shown = none ? '' : pw ? '•'.repeat(Math.min(n, 40)) : (n > 60 ? '…' : '') + v.slice(-60).replace(/\s+/g, ' ');
  t.textContent = shown || (none ? 'Ningún campo seleccionado' : tvF.placeholder || (pw ? 'Contraseña' : 'Campo vacío'));
  t.classList.toggle('ph', !shown);
  m.setAttribute('aria-label', pw ? 'En la tele: contraseña oculta de ' + n + ' caracteres' : 'En la tele: ' + (none ? 'ningún campo' : v || 'campo vacío'));
  $('#kbN').textContent = n === 1 ? '1 carácter' : n + ' caracteres';
  kbE.classList.toggle('none', none);
  $('#kbL').textContent = none ? 'Toca un campo en la tele para escribir' : pw ? 'Contraseña, oculta en el móvil y en la tele' : 'Escribe, borra y corrige aquí';
  const st = $('#kbSt'), up = isUp();
  const s = !up ? ['off', 'Sin conexión'] : fAck < fSeq ? ['busy', 'Enviando…'] : fErr ? ['off', 'No se ha podido escribir'] : none && fBlind ? ['off', 'Enviado sin ver el campo'] : none ? ['off', 'Sin campo en la tele'] : ['', 'Al día en la tele'];
  st.className = 'kbSt' + (s[0] ? ' ' + s[0] : ''); st.lastChild.textContent = s[1];
}
function kbSched() { if (!fRaf) { fRaf = requestAnimationFrame(kbFlush); fT = setTimeout(kbFlush, 120); } } // por fotograma (y por si no se pinta)
function kbFlush(force) {                                // manda el estado del editor si ha cambiado (texto o selección)
  if (fRaf) { cancelAnimationFrame(fRaf); clearTimeout(fT); fRaf = 0; }
  if (!fSynced) return;                                  // aún no se ha escrito nada sobre un campo desconocido
  if (!force && (fComp || fHold)) return;                // composición (IME, dictado) a medias: se manda al terminar
  const e = kbEd(), v = e.value, a = e.selectionStart ?? v.length, b = e.selectionEnd ?? a;
  const sig = v.length + ':' + a + ':' + b + ':' + v;
  if (sig === fLast) return;
  fLast = sig;
  const seq = ++fSeq; kbPaint();
  rpc({ t: 'field', value: v, selStart: a, selEnd: b, seq }).then(r => {
    fAck = Math.max(fAck, seq);
    if (seq === fSeq && !r.stale && !r.skipped) { fErr = r.error || ''; fOk = r.error ? fOk : r.blind ? null : !r.none; fBlind = !!r.blind; }
    if (r.ok && !r.skipped && (tvF.kind === 'text' || tvF.kind === 'search')) tvF = { ...tvF, value: v }; // al reabrir sale lo escrito (nunca una contraseña)
    kbPaint();
  });
}
function kbKey(k) {                                     // lo escrito llega antes que la tecla (el servidor la hace esperar)
  kbFlush(true); cmd({ t: 'key', k }); buzz(8);           // aunque haya una composición a medias: la última palabra va antes
  if (k === 'Tab' || k === 'Enter' || k === 'Escape') fTyped = 0; // cambiar de campo desde aquí no es estar escribiendo: que se rellene
}
function kbRvPaint() { const on = kbPw.type === 'text'; $('#kbRv').setAttribute('aria-pressed', on); $('#kbRv span').textContent = on ? 'Ocultar' : 'Mostrar'; }

export const keyboard = {
  name: 'keyboard',
  msgs: { focus: onTvFocus },                            // campo con foco en la tele
  sheets: { kbS: { open: kbOpen, close: kbClose, keepEscInside: true } },
  clicks: { kb: () => openSheet('kbS') },
  init() {
    kbV = $('#kbS'); kbTa = $('#kbTa'); kbPw = $('#kbPw'); kbPwB = $('#kbPwB'); kbE = $('#kbE');
    document.addEventListener('mousedown', e => { if (/** @type {Element} */ (e.target).closest('.kbK,.kbA')) e.preventDefault(); });
    onWs('open', kbOnline); onWs('close', () => kbPaint());
    for (const e of [kbTa, kbPw]) {
      e.addEventListener('input', ev => { fTyped = Date.now(); fSynced = true; kbPaint(); if (!ev.isComposing && !fComp) kbSched(); });
      e.addEventListener('compositionstart', () => { fComp = true; });
      e.addEventListener('compositionend', () => { fComp = false; fTyped = Date.now(); kbSched(); });
      e.addEventListener('select', kbSched);
      e.addEventListener('keydown', ev => {                  // teclado físico: Intro, Tab y Esc van a la tele (Mayús+Intro, salto de línea)
        if (ev.isComposing || fComp) return;
        if ((ev.key === 'Enter' && !ev.shiftKey) || ev.key === 'Tab' || ev.key === 'Escape') { ev.preventDefault(); kbKey(ev.key); }
      });
    }
    document.addEventListener('selectionchange', () => {
      const a = document.activeElement;
      if (fHold && a === kbPw && (kbPw.selectionStart !== fHold.a || kbPw.selectionEnd !== fHold.b)) try { kbPw.setSelectionRange(fHold.a, fHold.b); } catch {}
      if ((a === kbTa || a === kbPw) && !fComp) kbSched();
    });
    // los botones no le quitan el foco al editor (así el teclado del móvil no se cierra)
    kbV.addEventListener('pointerdown', e => { if (e.target.closest('.kbK button,.kbA button,.kbRv')) e.preventDefault(); });
    kbV.addEventListener('touchmove', e => e.stopPropagation(), { passive: true }); // dejar desplazar el editor
    $('#kbK').addEventListener('click', e => { const b = e.target.closest('[data-k]'); if (b) kbKey(b.dataset.k); });
    $('#kbGo').addEventListener('click', () => kbKey('Enter'));
    $('#kbClr').addEventListener('click', () => { const e = kbEd(); e.value = ''; fSynced = true; fTyped = Date.now(); buzz(10); kbPaint(); kbFlush(); });
    $('#kbBk').addEventListener('click', () => { buzz(7); closeSheet(); });
    $('#kbRv').addEventListener('click', () => {
      const a = kbPw.selectionStart, b = kbPw.selectionEnd;
      // Chrome lleva el cursor al principio un poco después: mientras, se repone y no se manda nada
      fHold = { a, b }; kbPw.type = kbPw.type === 'password' ? 'text' : 'password'; kbRvPaint();
      setTimeout(() => { try { kbPw.setSelectionRange(a, b); } catch {} fHold = false; kbSched(); }, 250);
    });
    const vv = window.visualViewport;
    if (vv) {                                              // la vista ocupa lo que se ve: la barra queda pegada encima del teclado
      const kbVV = () => { kbV.style.setProperty('--vt', vv.offsetTop + 'px'); kbV.style.setProperty('--vh', vv.height + 'px'); kbV.classList.toggle('kb', innerHeight - vv.height > 80); };
      vv.addEventListener('resize', kbVV); vv.addEventListener('scroll', kbVV); kbVV();
    }
  },
};
