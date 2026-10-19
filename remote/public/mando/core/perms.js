// Quién soy y qué puedo: el servidor manda «me» al conectar y cuando cambia el rol o los permisos.
import { persist, state, emit } from './store.js';

export const ROLE_N = { admin: 'Admin', member: 'Miembro', guest: 'Invitado' };
/** «caduca en …» de una fecha (ms). */
export const left = ms => { const h = (ms - Date.now()) / 3600e3; return h <= 0 ? 'caducado' : h < 1 ? 'caduca en ' + Math.max(1, Math.round(h * 60)) + ' min' : h < 48 ? 'caduca en ' + Math.round(h) + ' h' : 'caduca en ' + Math.round(h / 24) + ' d'; };
/** Guarda el «me» y avisa: cada parte del mando se adapta en su on('me'). */
export function applyMe(j) {
  state.me = j;
  if (j.id) persist.set('devid', j.id);
  emit('me', j);
}
