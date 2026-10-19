import { cfg } from '../core/store.js';

/** Vibra (si está activado en ajustes y el navegador sabe). */
export const buzz = n => { if (cfg.haptic && navigator.vibrate) navigator.vibrate(n || 8); };
