// Listas del panel de Spotify: a continuación, playlists (con su detalle) y recientes.
import { $, el } from '../core/dom.js';
import { rpc } from '../core/api.js';
import { buzz } from '../ui/haptics.js';
import { pill } from '../ui/pill.js';
import { sp, mmss } from './spotify-state.js';

export async function spLoadTab() {
  $('#spTabs').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', b.dataset.tab === sp.tab));
  if (sp.tab === 'queue') return spList();
  if (sp.tab === 'playlists' && sp.detail) return spList();
  if (sp.cache[sp.tab]) spList(); else spMsg('Cargando…');
  const r = await rpc({ t: 'spotify', a: sp.tab === 'playlists' ? 'playlists' : 'recent' });
  sp.cache[sp.tab] = r && r.items ? r.items : { error: r && r.error || 'error' };
  if (sp.cache[sp.tab].error && /403|scope|permis|Insufficient/i.test(sp.cache[sp.tab].error)) $('#spLogin').hidden = false;
  if (!(sp.tab === 'playlists' && sp.detail)) spList();
}
function spMsg(t) { const box = $('#spList'); box.textContent = ''; box.appendChild(el('div', 'spEmpty', t)); }
function spCover(x, cls) {
  const im = el('div', cls || 'im');
  const src = typeof x.image === 'string' ? x.image : x.image && (x.image.m || x.image.s);
  if (x.liked) { im.classList.add('lk'); im.textContent = '♥'; }
  else if (src) im.style.backgroundImage = `url("${src}")`;
  else im.textContent = '♪';
  return im;
}
const spPlay = (o, label) => rpc({ t: 'spotify', ...o }).then(r => pill(r && r.error ? r.error : label || 'Reproduciendo'));
function spRow(x, sub, onTap, extra) {
  const it = el('div', 'spIt' + (x.playable === false ? ' off' : ''));
  const tx = el('div', 'tx'); tx.append(el('div', 'a', x.name), el('div', 'b', sub || ''));
  it.append(spCover(x), tx, extra || el('div', 'c', x.duration ? mmss(x.duration) : ''));
  it.addEventListener('click', e => { if (e.target.closest('.spMini')) return; buzz(10); it.classList.add('dn'); setTimeout(() => it.classList.remove('dn'), 250); onTap(); });
  return it;
}
function spMiniBtn(icon, label, fn) {
  const b = el('button', 'spMini'); b.setAttribute('aria-label', label);
  b.innerHTML = `<svg><use href="#${icon}"/></svg>`;
  b.addEventListener('click', e => { e.stopPropagation(); buzz(10); fn(); });
  return b;
}
export function spList() {
  const box = $('#spList'); box.textContent = '';
  if (sp.tab === 'playlists' && sp.detail) return spRenderDetail(box);
  let items;
  if (sp.tab === 'queue') {
    items = (sp.now && sp.now.queue) || [];
    if (!items.length) return spMsg('No hay nada en cola.');
    // dentro de la playlist/álbum que suena, para no perder lo que viene después
    for (const x of items) box.appendChild(spRow(x, x.artist, () => spPlay(sp.now && sp.now.context && /^(playlist|album)$/.test(sp.now.context.type) ? { a: 'uri', uri: sp.now.context.uri, offset: x.uri } : { a: 'uri', uri: x.uri })));
    return;
  }
  const c = sp.cache[sp.tab]; if (!c) return;
  if (c.error) return spMsg(/403|scope|permis|Insufficient/i.test(c.error) ? 'Falta volver a conectar Spotify.' : c.error);
  if (!c.length) return spMsg('Nada por aquí.');
  if (sp.tab === 'playlists') {
    for (const x of c) box.appendChild(spRow(x, [x.by, x.count != null ? x.count + ' canciones' : ''].filter(Boolean).join(' · '),
      () => spOpenPl(x), spMiniBtn('i-shuf', 'Reproducir en aleatorio', () => spPlay({ a: 'uri', uri: x.uri, shuffle: true, total: x.count }, 'Aleatorio: ' + x.name))));
  } else {
    for (const x of c) box.appendChild(spRow(x, x.by, () => spPlay({ a: 'uri', uri: x.uri }),
      spMiniBtn('i-plus', 'Añadir a la cola', () => spPlay({ a: 'queue_add', uri: x.uri }, 'Añadida a la cola'))));
  }
}
async function spOpenPl(x) {
  sp.detail = { uri: x.uri, head: x, items: [], next: 0, loading: true };
  spList(); $('#spList').scrollIntoView({ block: 'nearest' });
  await spMore();
}
async function spMore() {
  const d = sp.detail; if (!d || d.next === null) return;
  d.loading = true; if (sp.tab === 'playlists') spList();
  const r = await rpc({ t: 'spotify', a: 'playlist', uri: d.uri, offset: d.next });
  if (sp.detail !== d) return;
  d.loading = false;
  if (r.error) { d.error = r.error; d.next = null; }
  else { for (const [k, v] of Object.entries(r)) if (k !== 'items' && v !== null && v !== undefined) d.head[k] = v; d.items.push(...(r.items || [])); d.next = r.next; }
  if (sp.tab === 'playlists') spList();
}
function spRenderDetail(box) {
  const d = sp.detail, h = d.head;
  const back = el('button', 'spBack', '‹ Playlists'); back.addEventListener('click', () => { buzz(7); sp.detail = null; spList(); });
  const hd = el('div', 'spPl');
  const meta = el('div', 'm');
  meta.append(el('div', 'n', h.name), el('div', 'b', [h.by, h.count != null ? h.count + ' canciones' : ''].filter(Boolean).join(' · ')));
  if (h.description) meta.appendChild(el('div', 'd', h.description));
  hd.append(spCover(h, 'cv'), meta);
  const acts = el('div', 'spPlA');
  const pb = el('button', 'bt big', 'Reproducir'); pb.addEventListener('click', () => { buzz(10); spPlay({ a: 'uri', uri: d.uri, shuffle: false }, 'Reproduciendo ' + h.name); });
  const sb = el('button', 'bt', 'Aleatorio'); sb.addEventListener('click', () => { buzz(10); spPlay({ a: 'uri', uri: d.uri, shuffle: true, total: h.count }, 'Aleatorio: ' + h.name); });
  acts.append(pb, sb);
  box.append(back, hd, acts);
  if (d.error) return box.appendChild(el('div', 'spEmpty', d.error));
  if (h.canList === false) return box.appendChild(el('div', 'spEmpty', h.note || 'No se pueden ver sus canciones.'));
  d.items.forEach((x, i) => box.appendChild(spRow(x, x.by, () => spPlay({ a: 'uri', uri: d.uri, offset: x.uri }),
    spMiniBtn('i-plus', 'Añadir a la cola', () => spPlay({ a: 'queue_add', uri: x.uri }, 'Añadida a la cola')))));
  if (d.loading) box.appendChild(el('div', 'spEmpty', 'Cargando…'));
  else if (d.next !== null) { const m = el('button', 'bt spMore', 'Cargar más'); m.addEventListener('click', () => { buzz(7); spMore(); }); box.appendChild(m); }
}
