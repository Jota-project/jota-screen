// Gestos del navegador que el mando no quiere: desplazar o hacer zoom la página (salvo dentro de hojas y emparejar) y el
// menú contextual.
export const gestures = {
  name: 'gestures',
  init() {
    document.addEventListener('touchmove', e => { if (!/** @type {Element} */ (e.target).closest('.sheet,.pairV')) e.preventDefault(); }, { passive: false });
    document.addEventListener('gesturestart', e => e.preventDefault());
    document.addEventListener('contextmenu', e => e.preventDefault());
  },
};
