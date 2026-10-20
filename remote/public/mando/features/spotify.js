// Spotify («Ahora suena», v3): panel completo del altavoz de la pantalla (TV_SPOTIFY_DEVICE), con datos en vivo empujados
// por el servidor. Las luces del panel toman los colores de la carátula (recortados para que el texto se lea) y, al
// cambiar de canción, el texto sale en 200 ms, la carátula entra en 800 ms y el texto nuevo llega escalonado.
import { $, hide } from '../core/dom.js';
import { state, on } from '../core/store.js';
import { cmd, rpc } from '../core/api.js';
import { buzz } from '../ui/haptics.js';
import { pill } from '../ui/pill.js';
import { openSheet, closeSheet, isOpen } from '../ui/sheets.js';
import { sp, mmss } from './spotify-state.js';
import { tone, themeOf, LIMITS } from './ambient.js';
import { spLoadTab, spList } from './spotify-lists.js';

const spOpen = () => isOpen('spS');
/* la búsqueda va plegada tras la lupa */
function spQuery(on) { $('#spS').classList.toggle('q', on); $('#spQ').setAttribute('aria-expanded', String(on)); if (on) $('#spin').focus(); }
function spButton() {
  openSheet('spS');
  rpc({ t: 'spwatch', on: true }).then(r => { if (r && 'now' in r) spPaint(r.now); });
  spLoadTab();
}
function spPos() { return !sp.now || sp.now.empty ? 0 : Math.min(sp.now.duration, sp.now.progress + (sp.now.playing ? Date.now() - sp.recv : 0)); }
/* luces del panel: los dos primeros colores de la carátula ([h, s, l] del servidor, o su fondo y acento) */
function spLights(n) {
  const c = n && !n.empty && n.colors, lim = LIMITS.sp[themeOf()], S = $('#spS');
  const a = c ? (Array.isArray(c.hsl) && c.hsl[0]) || c.accent : '#7c6aae';
  const b = c ? (Array.isArray(c.hsl) && c.hsl[1]) || c.bg : '#6e8cc4';
  S.style.setProperty('--sa', a ? tone(a, lim) : 'transparent'); S.style.setProperty('--sb', b ? tone(b, lim) : 'transparent');
}
/* título, artista, contexto y carátula; al cambiar de canción, con el relevo (sin él con movimiento reducido) */
let spKey = '', swapT = 0;
function spText(n) {
  const none = !n || n.empty || !n.track;
  const key = none ? '' : n.track.name + '\n' + n.artist;
  const set = () => {
    const S = $('#spS');
    if (none) { $('#spT').textContent = 'Nada sonando'; $('#spA').textContent = 'Busca algo o elige una playlist'; $('#spCtx').textContent = ''; $('#spArt').style.backgroundImage = ''; }
    else {
      $('#spT').textContent = n.track.name;
      $('#spA').textContent = n.artist;
      const c = n.context;
      $('#spCtx').textContent = c && c.name && c.type !== 'album' ? 'Desde ' + c.name : [n.album.name, n.album.year].filter(Boolean).join(' · ');
      const im = n.album.image && (n.album.image.m || n.album.image.l);
      $('#spArt').style.backgroundImage = im ? `url("${im}")` : '';
    }
    S.classList.remove('swap');
  };
  if (key === spKey && $('#spT').textContent !== '—') return set();
  const had = spKey; spKey = key; clearTimeout(swapT);
  if (!had || !key || matchMedia('(prefers-reduced-motion: reduce)').matches) return set();
  $('#spS').classList.add('swap'); swapT = setTimeout(set, 220);
}
function spPaint(n) {
  sp.now = n; sp.recv = Date.now();
  const S = $('#spS');
  $('#spLogin').hidden = !(n && n.needsLogin);
  $('#spLoginA').href = '/spotify/login?t=' + encodeURIComponent(state.token);
  spLights(n); spText(n);
  S.classList.toggle('playing', !!(n && !n.empty && n.playing));
  if (!n || n.empty || !n.track) { $('#spLike').hidden = true; spTick(); spList(); return; }
  $('#spLike').hidden = n.liked === null || n.liked === undefined; $('#spLike').classList.toggle('on', !!n.liked);
  $('#spShuf').classList.toggle('on', !!n.shuffle);
  $('#spRep').classList.toggle('on', n.repeat !== 'off'); $('#spRep').classList.toggle('one', n.repeat === 'track');
  $('#spS .big use').setAttribute('href', n.playing ? '#i-pause' : '#i-play');
  const v = n.device && n.device.volume; if (typeof v === 'number' && !sp.volT) { $('#rSp').value = v; $('#spV').textContent = v + ' %'; }
  spTick();
  if (sp.tab === 'queue') spList();
}
function spTick() {
  const d = sp.now && !sp.now.empty ? sp.now.duration : 0;
  const p = sp.drag !== null ? sp.drag * d : spPos();
  $('#spP').textContent = mmss(p); $('#spD').textContent = mmss(d);
  $('#spFill').style.width = d ? (p / d * 100).toFixed(2) + '%' : '0';
}

export const spotify = {
  name: 'spotify',
  msgs: { sp: j => { if (spOpen()) spPaint(j.now); } },
  sheets: { spS: { open() { $('#spin').value = ''; spQuery(false); }, close: () => cmd({ t: 'spwatch', on: false }) } },
  clicks: { sp: spButton },
  init() {
    setInterval(() => { if (spOpen()) spTick(); }, 500);
    setInterval(() => { if (spOpen() && !document.hidden) cmd({ t: 'spwatch', on: true }); }, 15000); // por si el WebSocket se ha reconectado
    // el servidor deja de contar el panel a los 40 s sin renovar (móvil bloqueado): al volver, se pide al momento
    document.addEventListener('visibilitychange', () => { if (spOpen() && !document.hidden) rpc({ t: 'spwatch', on: true }).then(r => { if (r && 'now' in r) spPaint(r.now); }); });
    const trk = $('#spTrk');
    const frac = e => { const r = trk.getBoundingClientRect(); return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)); };
    trk.addEventListener('pointerdown', e => { if (!sp.now || sp.now.empty) return; trk.setPointerCapture(e.pointerId); trk.classList.add('drag'); sp.drag = frac(e); spTick(); });
    trk.addEventListener('pointermove', e => { if (sp.drag === null) return; sp.drag = frac(e); spTick(); });
    trk.addEventListener('pointerup', e => {
      if (sp.drag === null) return;
      const f = frac(e); sp.drag = null; trk.classList.remove('drag'); buzz(8);
      if (sp.now && !sp.now.empty) { sp.now.progress = f * sp.now.duration; sp.recv = Date.now(); spTick(); rpc({ t: 'spotify', a: 'seek', ms: Math.round(f * sp.now.duration) }); }
    });
    trk.addEventListener('pointercancel', () => { sp.drag = null; trk.classList.remove('drag'); spTick(); });
    document.addEventListener('click', e => {
      const b = /** @type {HTMLElement} */ (/** @type {Element} */ (e.target).closest('[data-sp]')); if (!b) return;
      buzz(8);
      if (b.dataset.sp === 'playpause' && sp.now && !sp.now.empty) { sp.now.progress = spPos(); sp.recv = Date.now(); sp.now.playing = !sp.now.playing; $('#spS .big use').setAttribute('href', sp.now.playing ? '#i-pause' : '#i-play'); }
      rpc({ t: 'spotify', a: b.dataset.sp }).then(r => { if (r && r.error) pill(r.error); });
    });
    $('#spShuf').addEventListener('click', () => { buzz(8); $('#spShuf').classList.toggle('on'); rpc({ t: 'spotify', a: 'shuffle' }); });
    $('#spRep').addEventListener('click', () => { buzz(8); rpc({ t: 'spotify', a: 'repeat' }); });
    $('#spLike').addEventListener('click', () => { buzz(12); $('#spLike').classList.toggle('on'); rpc({ t: 'spotify', a: 'like' }).then(r => { if (r && r.error) { pill(r.error); $('#spLike').classList.toggle('on'); } }); });
    $('#spX').addEventListener('click', () => { buzz(7); closeSheet(); });
    $('#spQ').addEventListener('click', () => { buzz(7); spQuery(!$('#spS').classList.contains('q')); });
    $('#spTv').addEventListener('click', () => { buzz(8); cmd({ t: 'nav', url: 'https://open.spotify.com/' }); cmd({ t: 'spotify', a: 'activate' }); closeSheet(); pill('Abriendo Spotify en la tele'); });
    $('#rSp').addEventListener('input', e => {
      $('#spV').textContent = e.target.value + ' %';
      clearTimeout(sp.volT); sp.volT = setTimeout(() => { sp.volT = 0; rpc({ t: 'spotify', a: 'volume', v: +e.target.value }); }, 250);
    });
    const spin = $('#spin');
    spin.addEventListener('keydown', e => {
      if (e.key !== 'Enter' || e.isComposing) return;
      e.preventDefault(); const v = spin.value.trim(); if (!v) return;
      spin.value = ''; $('#spT').textContent = 'Buscando…'; $('#spA').textContent = v; spin.blur();
      rpc({ t: 'spotify', a: 'search_play', query: v, type: 'track' }).then(r => { if (r && r.error) { pill(r.error); spPaint(sp.now); } });
    });
    $('#spTabs').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; buzz(7); if (sp.tab === b.dataset.tab && b.dataset.tab === 'playlists') sp.detail = null; sp.tab = b.dataset.tab; spLoadTab(); });
    on('me', j => {
      const P = j.perms || {};
      hide('#spTabs [data-tab=playlists],#spTabs [data-tab=recent]', !P.library);
      if (!P.library && sp.tab !== 'queue') { sp.tab = 'queue'; if (spOpen()) spLoadTab(); }
      hide('#spLike', !P.library);
      hide('#spin,#spQ', P.music === 'off');
      $('#spin').placeholder = P.music === 'queue' ? 'Pide una canción (va a la cola)…' : 'Busca y reproduce: artista, canción…';
    });
  },
};
