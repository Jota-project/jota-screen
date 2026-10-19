// Estado compartido del mando: lo guardado en el navegador (persist, cfg) y lo que escriben varias partes (state).
// Las importaciones ES son de solo lectura: lo que cambia va como propiedad de estos objetos.

/** localStorage con JSON; sin almacenamiento (privado, bloqueado) devuelve el valor por defecto. */
export const persist = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

/** Ajustes de este móvil (se rellenan en initSession). */
export const cfg = {};
export const saveCfg = () => persist.set('cfg', cfg);

/**
 * token: el de este dispositivo (se recuerda aquí y en una cookie; el maestro no se guarda nunca);
 * adminCode: el de un enlace #admin=…; viaCookie: conectado con la cookie de un emparejamiento anterior;
 * pairNote: aviso para la pantalla de emparejar; me: quién soy y qué puedo (mensaje «me»); acc: permisos por rol (admin);
 * lastState: último estado de la tele.
 */
export const state = { token: '', adminCode: '', viaCookie: false, pairNote: '', me: null, acc: null, lastState: null };

/** Al arrancar: token de ?t= (o el guardado), código de #admin= y se limpian de la barra de direcciones; ajustes. */
export function initSession() {
  const qs = new URLSearchParams(location.search);
  state.token = qs.get('t') || persist.get('token', '');
  state.adminCode = (/[#&]admin=([0-9A-Za-z-]{6,24})/.exec(location.hash) || [])[1] || '';
  if (qs.has('t') || state.adminCode) { qs.delete('t'); const q = qs.toString(); history.replaceState(null, '', location.pathname + (q ? '?' + q : '')); }
  Object.assign(cfg, { speed: 1.6, scroll: 1, natural: true, haptic: true, theme: 'oscuro', apps: ['spotify', 'netflix'] }, persist.get('cfg', {}));
}

/* avisos entre partes (me, auth:lost) */
const subs = new Map();
export function on(ev, fn) { if (!subs.has(ev)) subs.set(ev, []); subs.get(ev).push(fn); }
export function emit(ev, ...a) { for (const f of subs.get(ev) || []) f(...a); }
