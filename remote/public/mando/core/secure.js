// Paso a HTTPS: el micrófono (la voz) solo existe en una página segura. Si el mando se abre por http:// (mando.local o
// la IP) y la instalación tiene una URL https (TV_PUBLIC_URL, p. ej. Tailscale o un funnel), se comprueba que responde
// y se salta a ella con el token de este móvil en el fragmento (#t=…: no llega a ningún servidor ni registro), para no
// tener que emparejar otra vez. Si no responde (un móvil fuera de esa red), el mando sigue por http como siempre.

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/**
 * Adónde saltar, o '' si no toca. Pura, para poder probarla.
 * @param {{ protocol: string, hostname: string, origin: string, pathname: string, search: string, hash: string }} loc
 * @param {string} secure URL https de la instalación (vacía si no hay) @param {string} token el de este móvil
 */
export function secureTarget(loc, secure, token) {
  if (loc.protocol !== 'http:' || LOOPBACK.has(loc.hostname)) return '';
  let u; try { u = new URL(secure); } catch { return ''; }
  if (u.protocol !== 'https:' || u.origin === loc.origin) return '';
  const frag = [loc.hash.replace(/^#/, ''), token ? 't=' + encodeURIComponent(token) : ''].filter(Boolean).join('&');
  return u.origin + loc.pathname + loc.search + (frag ? '#' + frag : '');
}

/** Si toca y la URL segura responde (2,5 s como mucho), se va a ella. No bloquea el arranque del mando. */
export async function toSecure(token) {
  const meta = /** @type {HTMLMetaElement | null} */ (document.querySelector('meta[name="tv-secure"]'));
  const to = secureTarget(location, meta ? meta.content : '', token);
  if (!to) return;
  try {
    await fetch(new URL(to).origin + '/manifest.webmanifest', { mode: 'no-cors', cache: 'no-store', signal: AbortSignal.timeout(2500) });
    location.replace(to);
  } catch {}                                            // no se llega: se queda en http
}
