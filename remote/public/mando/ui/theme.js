import { cfg } from '../core/store.js';

/** Cambia el tema en caliente (el <head> ya lo pone antes de pintar, con mando/theme.js). */
export function applyTheme() {
  const light = cfg.theme === 'claro';
  document.documentElement.dataset.theme = light ? 'claro' : 'oscuro';
  /** @type {HTMLMetaElement} */ (document.querySelector('meta[name=theme-color]')).content = light ? '#f6f3f0' : '#2a2433';
  /** @type {HTMLMetaElement} */ (document.querySelector('meta[name=color-scheme]')).content = light ? 'light' : 'dark';
}
