// Pantalla en reposo (idle.html): reloj, tiempo, actividades, ahora suena, ambiente y reacomodos. Sin módulos:
// onData y TVIdle quedan globales (las capturas de e2e/ los llaman).
const $ = id => document.getElementById(id);
const B = document.body, BG = $('bg'), G = $('grid');
const W = { hora: $('wHora'), ctx: $('wCtx'), mus: $('wMus'), nfx: $('wNfx'), s0: $('wS0'), s1: $('wS1'), s2: $('wS2') };
let D = { profile: 'day', weather: null, music: null, acts: [], cfg: { dimMin: 20, layout: 'rotar', rearrangeMin: 20, calm: false } }, off = 0, lastEvent = Date.now();

// ── distribuciones: cada escena coloca los widgets en la rejilla (fila-inicio / col-inicio / fila-fin / col-fin), sin que
// dos áreas se pisen: cada widget tiene su sitio reservado. A 1920×1080 caben la hora (3 filas × 7 columnas: «00:00» mide
// ≈ 2,3 em), el contexto con una actividad (3 filas) y la música en línea (1 fila); si no, se encogen (idle.css, fit())
const L = {
  margen: [
    { hora: ['4/1/7/8', 'start', 'end', 'line', 'left'], ctx: ['1/8/4/13', 'end', 'start', 'col', 'right'], mus: ['5/8/7/13', 'end', 'end', 'line', 'right'] },
    { hora: ['1/6/4/13', 'end', 'start', 'line', 'right'], ctx: ['1/1/5/6', 'start', 'end', 'col', 'left'], mus: ['5/1/7/7', 'start', 'end', 'line', 'left'] },
    { hora: ['2/3/5/11', 'center', 'center', 'line', 'left'], ctx: ['5/1/7/7', 'start', 'end', 'col', 'left'], mus: ['1/8/2/13', 'end', 'start', 'line', 'right'] },
  ],
  zonas: [
    { ctx: ['1/1/2/13', 'stretch', 'center', 'row', 'left'], hora: ['2/1/5/13', 'start', 'start', 'line', 'left'], mus: ['6/1/7/13', 'stretch', 'center', 'band', 'left'] },
    { hora: ['1/1/4/13', 'start', 'start', 'line', 'left'], mus: ['5/1/6/13', 'stretch', 'center', 'band', 'left'], ctx: ['6/1/7/13', 'stretch', 'center', 'row', 'left'] },
    { mus: ['1/1/2/13', 'stretch', 'center', 'band', 'left'], ctx: ['3/1/4/13', 'stretch', 'center', 'row', 'left'], hora: ['4/1/7/13', 'start', 'end', 'line', 'left'] },
  ],
  apilada: [
    { hora: ['1/1/7/7', 'start', 'center', 'stack', 'left'], ctx: ['1/8/4/13', 'stretch', 'start', 'col', 'left'], mus: ['4/8/7/13', 'stretch', 'end', 'big', 'left'] },
    { hora: ['1/7/7/13', 'end', 'center', 'stack', 'right'], ctx: ['1/1/4/7', 'stretch', 'start', 'col', 'left'], mus: ['4/1/7/7', 'stretch', 'end', 'big', 'left'] },
    { hora: ['1/1/7/7', 'start', 'end', 'stack', 'left'], ctx: ['4/8/7/13', 'stretch', 'end', 'col', 'left'], mus: ['1/8/4/13', 'stretch', 'start', 'big', 'left'] },
  ],
};
L.rotar = [...L.margen, ...L.zonas, ...L.apilada];
// «Seguir viendo» (Netflix): mientras se enseña, sus propias escenas. Hora pequeña y contexto en dos filas; el widget en las
// otras cuatro, a todo el ancho; la música se aparta. Dos escenas en espejo para el reacomodo (y contra el quemado).
L.nfx = [
  { hora: ['1/1/3/6', 'start', 'start', 'line', 'left'], ctx: ['1/8/3/13', 'end', 'start', 'col', 'right'], nfx: ['3/1/7/13', 'start', 'end', '', 'left'] },
  { nfx: ['1/1/5/13', 'end', 'start', '', 'right'], hora: ['5/7/7/13', 'end', 'end', 'line', 'right'], ctx: ['5/1/7/6', 'start', 'end', 'col', 'left'] },
];
// «Seguir viendo» con varias fuentes (bloques s0, s1, s2; s0 el primero). Destacado: el primero en grande (848) y los demás
// al lado. Discreto: la hora grande de siempre y, en la franja de abajo (3 filas), Netflix como una fila de 3–4 series
// pequeñas y el resto en piezas pequeñas al lado. Dos escenas en espejo para cada número de fuentes.
L.sug2 = [
  { hora: ['1/1/3/6', 'start', 'start', 'line', 'left'], ctx: ['1/8/3/13', 'end', 'start', 'col', 'right'], s0: ['3/1/7/9', 'start', 'end', '', 'left'], s1: ['3/9/7/13', 'end', 'end', '', 'right'] },
  { s0: ['1/5/5/13', 'end', 'start', '', 'right'], s1: ['1/1/5/5', 'start', 'start', '', 'left'], hora: ['5/8/7/13', 'end', 'end', 'line', 'right'], ctx: ['5/1/7/6', 'start', 'end', 'col', 'left'] },
];
L.sug3 = [
  { hora: ['1/1/3/6', 'start', 'start', 'line', 'left'], ctx: ['1/8/3/13', 'end', 'start', 'col', 'right'], s0: ['3/1/7/8', 'start', 'end', '', 'left'], s1: ['3/8/5/13', 'end', 'center', '', 'right'], s2: ['5/8/7/13', 'end', 'end', '', 'right'] },
  { s0: ['1/6/5/13', 'end', 'start', '', 'right'], s1: ['1/1/3/6', 'start', 'start', '', 'left'], s2: ['3/1/5/6', 'start', 'center', '', 'left'], hora: ['5/8/7/13', 'end', 'end', 'line', 'right'], ctx: ['5/1/7/6', 'start', 'end', 'col', 'left'] },
];
L.dis1 = [
  { hora: ['1/1/4/8', 'start', 'start', 'line', 'left'], ctx: ['1/8/4/13', 'end', 'start', 'col', 'right'], s0: ['4/1/7/13', 'start', 'end', '', 'left'] },
  { s0: ['1/1/4/13', 'start', 'start', '', 'left'], hora: ['4/6/7/13', 'end', 'end', 'line', 'right'], ctx: ['4/1/7/6', 'start', 'end', 'col', 'left'] },
];
L.dis2 = [
  { hora: ['1/1/4/8', 'start', 'start', 'line', 'left'], ctx: ['1/8/4/13', 'end', 'start', 'col', 'right'], s0: ['4/1/7/10', 'start', 'end', '', 'left'], s1: ['4/10/7/13', 'end', 'end', '', 'right'] },
  { s0: ['1/4/4/13', 'end', 'start', '', 'right'], s1: ['1/1/4/4', 'start', 'start', '', 'left'], hora: ['4/6/7/13', 'end', 'end', 'line', 'right'], ctx: ['4/1/7/6', 'start', 'end', 'col', 'left'] },
];
L.dis3 = [
  { hora: ['1/1/3/6', 'start', 'start', 'line', 'left'], ctx: ['1/8/3/13', 'end', 'start', 'col', 'right'], s0: ['3/1/7/9', 'start', 'end', '', 'left'], s1: ['3/9/5/13', 'end', 'center', '', 'right'], s2: ['5/9/7/13', 'end', 'end', '', 'right'] },
  { s0: ['1/5/5/13', 'end', 'start', '', 'right'], s1: ['1/1/3/5', 'start', 'start', '', 'left'], s2: ['3/1/5/5', 'start', 'center', '', 'left'], hora: ['5/8/7/13', 'end', 'end', 'line', 'right'], ctx: ['5/1/7/6', 'start', 'end', 'col', 'left'] },
];
// sug: '' (reposo normal), 'nfx' (solo Netflix en grande: su widget), 'sug' (destacado) o 'dis' (discreto); n: bloques
let layout = '', scene = 0, rTimer = 0, moving = false, sug = { mode: '', n: 0 };
const scenes = () => (sug.mode === 'nfx' ? L.nfx : sug.mode ? L[sug.mode + sug.n] : L[layout]);
// cada widget ocupa su celda entera; su contenido (.wi) se alinea dentro con data-jx/data-jy (idle.css)
function place(sc) {
  for (const k of Object.keys(W)) {
    const e = W[k];
    e.classList.toggle('gone', !sc[k]);                    // lo que no está en la escena no ocupa sitio
    if (!sc[k]) continue;
    const [area, jx, jy, v, ta] = sc[k];
    e.style.gridArea = area; e.dataset.jx = jx; e.dataset.jy = jy;
    e.dataset.v = D.profile === 'night' && k === 'mus' ? 'line' : v; e.dataset.ta = ta;
    if (k === 'mus' || k === 'nfx' || k[0] === 's') e.dataset.dir = ta === 'right' ? 'rev' : '';
  }
  fit();
}
// si el contenido de un widget no cabe en su celda (más media separación, como mucho), se encoge entero: --fit < 1
// escala todas sus medidas (--s en idle.css). La hora no lo necesita: se ajusta a su celda con cqh/cqw.
function fit() {
  const g = parseFloat(getComputedStyle(G).rowGap) || 0;
  for (const e of [W.ctx, W.mus, W.nfx, W.s0, W.s1, W.s2]) {
    e.style.setProperty('--fit', '1');
    const kids = [...e.firstElementChild.children].map(c => c.getBoundingClientRect()).filter(r => r.width || r.height);
    if (!kids.length || !e.clientHeight) continue;
    const h = Math.max(...kids.map(r => r.bottom)) - Math.min(...kids.map(r => r.top));
    const w = Math.max(...kids.map(r => r.right)) - Math.min(...kids.map(r => r.left));
    const k = Math.min(1, (e.clientHeight + g / 2) / h, (e.clientWidth + g / 2) / w);
    if (k < 1) e.style.setProperty('--fit', (k * .98).toFixed(3));
  }
}
// reacomodo coreografiado: atenuar, colocar, y que el contenido de cada widget viaje desde donde estaba (FLIP)
function rearrange(next) {
  if (moving) return;
  const calm = !!D.cfg.calm; moving = true;
  G.classList.add('leaving');
  setTimeout(() => {
    const els = Object.values(W), ins = els.map(e => e.firstElementChild), first = ins.map(e => e.getBoundingClientRect());
    place(scenes()[next]); scene = next;
    if (!calm) ins.forEach((e, i) => {
      const a = first[i], b = e.getBoundingClientRect();
      e.style.transition = 'none'; e.style.transform = `translate(${a.left - b.left}px,${a.top - b.top}px)`;
    });
    requestAnimationFrame(() => requestAnimationFrame(() => {
      els.forEach((e, i) => {
        const d = i * .12;
        e.style.transition = `opacity .7s ease ${d + .35}s`;
        ins[i].style.transition = `transform 1.5s var(--ease) ${d}s`;
        ins[i].style.transform = '';
      });
      G.classList.remove('leaving');
      setTimeout(() => { els.forEach((e, i) => { e.style.transition = ins[i].style.transition = ''; }); moving = false; }, 2200);
    }));
  }, 650);
}
function setLayout(name) {
  if (!L[name]) name = 'rotar';
  if (name === layout) return;
  const first = !layout; layout = name; scene = 0;
  if (first) place(scenes()[0]); else rearrange(0);
}
function schedule() {
  clearInterval(rTimer);
  const min = Number(D.cfg.rearrangeMin) || 0;
  if (min > 0) rTimer = setInterval(() => rearrange((scene + 1) % scenes().length), min * 60e3);
}

// ── reloj con dígitos que caen al cambiar
// zona horaria: la del reposo (TV_TZ o idle.json); si no llega o no vale, la del navegador (la del sistema)
let fmtTz, fmtDate, fmtHM;
function setTz(tz) {
  if (fmtDate && tz === fmtTz) return;
  fmtTz = tz;
  try {
    fmtDate = new Intl.DateTimeFormat('es-ES', { weekday: 'long', day: 'numeric', month: 'long', timeZone: tz || undefined });
    fmtHM = new Intl.DateTimeFormat('es-ES', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: tz || undefined });
  } catch { fmtTz = null; fmtDate = fmtHM = null; setTz(undefined); }
}
setTz(undefined);
const slots = [...document.querySelectorAll('.dg')];
function setDigit(s, ch) {
  const cur = s.querySelector('span:not(.old)');
  if (cur && cur.textContent === ch) return;
  if (cur) { cur.className = 'old'; setTimeout(() => cur.remove(), 650); }
  const n = document.createElement('span'); n.textContent = ch; if (cur) n.className = 'new';
  s.appendChild(n);
}
function clock() {
  const d = new Date(), hm = fmtHM.format(d).replace(':', '');
  [...hm].forEach((ch, i) => setDigit(slots[i], ch));
  const f = fmtDate.format(d); $('date').textContent = f.charAt(0).toUpperCase() + f.slice(1);
  progress(); dimCheck(); acts();
  setTimeout(clock, 1000 - (Date.now() % 1000) + 10);
}

// ── tiempo
function wmo(c) {
  if (c === 0) return 'Despejado'; if (c === 1) return 'Casi despejado'; if (c === 2) return 'Parcialmente nuboso'; if (c === 3) return 'Nublado';
  if (c <= 48) return 'Niebla'; if (c <= 57) return 'Llovizna'; if (c <= 67) return 'Lluvia'; if (c <= 77) return 'Nieve';
  if (c <= 82) return 'Chubascos'; if (c <= 86) return 'Chubascos de nieve'; return 'Tormenta';
}
function weather() {
  const w = D.weather, el = $('wx'); el.textContent = '';
  if (!w) return;
  const t = document.createElement('span'); t.className = 'tmp'; t.textContent = w.temp + '°';
  const s = document.createElement('span'); s.className = 'wxt';
  const snow = w.code >= 71 && w.code <= 86 && !(w.code >= 80 && w.code <= 82);
  const l2 = w.rainNext >= 30 ? `${snow ? 'nieve' : 'lluvia'} ${w.rainNext} % pronto` : `máx. ${w.max}°, mín. ${w.min}°`;
  const a = document.createElement('span'), b = document.createElement('span'); a.textContent = wmo(w.code); b.className = 'w2'; b.textContent = l2;
  s.append(a, document.createElement('br'), b);
  el.append(t, s);
}

// ── actividades integradas en el contexto (fuera del reposo siguen siendo la isla)
const fmtT = ms => { const s = Math.max(0, Math.ceil(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`; };
const actNodes = new Map();
function acts() {
  const list = (D.acts || []).slice(0, 2), box = $('acts'), now = Date.now();
  for (const [id, n] of actNodes) if (!list.find(a => a.id === id)) { n.remove(); actNodes.delete(id); }
  for (const a of list) {
    let n = actNodes.get(a.id);
    if (!n) {
      n = document.createElement('div'); n.className = 'act';
      n.innerHTML = '<svg viewBox="0 0 56 56" aria-hidden="true"><circle class="rb" cx="28" cy="28" r="24"/><circle class="rf" cx="28" cy="28" r="24" stroke-dasharray="150.8" stroke-dashoffset="150.8"/></svg><div><div class="at"></div><div class="as"></div></div><span class="av"></span>';
      box.appendChild(n); actNodes.set(a.id, n);
    }
    let f = a.done ? 1 : a.endsAt && a.duration ? 1 - (a.endsAt + off - now) / a.duration : a.progress;
    const v = a.done ? (a.endsAt ? '0:00' : a.value || 'Listo') : a.endsAt ? fmtT(a.endsAt + off - now) : a.startAt ? fmtT(now - (a.startAt + off)) : a.value || (a.progress != null ? Math.round(a.progress * 100) + ' %' : '');
    n.querySelector('.at').textContent = a.title || '';
    n.querySelector('.as').textContent = a.subtitle || '';
    n.querySelector('.av').textContent = v;
    const rf = n.querySelector('.rf'), svg = n.querySelector('svg');
    svg.style.display = f == null || a.startAt ? 'none' : '';
    if (f != null) rf.style.strokeDashoffset = (150.8 * (1 - Math.min(1, Math.max(0, f)))).toFixed(1);
    n.classList.toggle('done', !!a.done);
  }
}

// ── paletas del ambiente: [luz A, luz B, base, intensidad]
const PAL = {
  dawn:    ['#8a76c0', '#c4949e', '#221b2a', .3],
  day:     ['#7c6aae', '#6e8cc4', '#211b2a', .32],
  golden:  ['#9a6aa0', '#c88a6a', '#221a26', .3],
  evening: ['#5e4c92', '#3d5486', '#16121c', .38],
  dark:    ['#000000', '#000000', '#000000', 0],
};
function rgb2hsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l];
  const d = mx - mn, s = l > .5 ? d / (2 - mx - mn) : d / (mx + mn);
  const h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}
const tone = (c, L) => { const [h, s, l] = c; return `hsl(${h.toFixed(0)} ${Math.min(80, Math.max(30, s * 100)).toFixed(0)}% ${(Math.min(Math.max(l, L * .7), L) * 100).toFixed(0)}%)`; };
function extract(img) {
  const N = 36, cv = document.createElement('canvas'); cv.width = cv.height = N;
  const x = cv.getContext('2d', { willReadFrequently: true }); x.drawImage(img, 0, 0, N, N);
  const d = x.getImageData(0, 0, N, N).data, bk = new Map();
  for (let i = 0; i < d.length; i += 4) {
    const [h, s, l] = rgb2hsl(d[i], d[i + 1], d[i + 2]); if (l < .07 || l > .94) continue;
    const k = Math.round(h / 20) + ':' + Math.round(s * 3);
    const e = bk.get(k) || { n: 0, s: 0, l: 0, hx: 0, hy: 0, c: 0 };
    e.n += 1 + s * 2.5; e.s += s; e.l += l; e.hx += Math.cos(h * Math.PI / 180); e.hy += Math.sin(h * Math.PI / 180); e.c++; bk.set(k, e);
  }
  const c = [...bk.values()].sort((a, b) => b.n - a.n).slice(0, 2).map(e => [((Math.atan2(e.hy, e.hx) * 180 / Math.PI) + 360) % 360, e.s / e.c, e.l / e.c]);
  return c.length ? (c.length > 1 ? c : [c[0], [(c[0][0] + 40) % 360, c[0][1], c[0][2]]]) : null;
}
let artPal = null;
function timePal() {
  const w = D.weather, now = Date.now();
  if (D.profile === 'evening') return PAL.evening;
  if (w && w.sunrise) {
    if (Math.abs(now - w.sunrise) < 75 * 60e3) return PAL.dawn;
    if (now > w.sunset - 90 * 60e3 && now < w.sunset + 40 * 60e3) return PAL.golden;
  }
  return PAL.day;
}
function applyPalette() {
  const dark = D.profile === 'night' || D.profile === 'cinema';
  let p = dark ? PAL.dark : timePal();
  if (!dark && artPal && (D.music || sug.mode)) { const ev = D.profile === 'evening'; p = [tone(artPal[0], ev ? .32 : .36), tone(artPal[1], ev ? .28 : .34), p[2], ev ? .32 : .3]; }
  BG.style.setProperty('--ca', p[0]); BG.style.setProperty('--cb', p[1]); BG.style.setProperty('--base', p[2]); BG.style.setProperty('--orb', p[3]);
}

// ── ahora suena
let artUrl = '', srvPalKey = '';
const mmss = ms => { const s = Math.max(0, Math.floor(ms / 1000)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
function music() {
  const m = D.music, show = !!m && D.profile !== 'cinema' && (m.playing || Date.now() - (m.at + off) < 10 * 60e3);
  W.mus.classList.toggle('off', !show);
  B.classList.toggle('playing', !!(m && m.playing));
  if (!m) { artPal = null; srvPalKey = ''; applyPalette(); return; }
  $('npt').textContent = m.title;
  const ctx = m.context && m.context.name && m.context.type !== 'album' ? ', desde ' + m.context.name : '';
  $('npa').textContent = m.artist + (W.mus.dataset.v === 'band' ? ctx : '') + (m.playing ? '' : ' (en pausa)');
  if (Array.isArray(m.colors) && m.colors.length > 1) { const k = JSON.stringify(m.colors); if (k !== srvPalKey) { srvPalKey = k; artPal = m.colors; applyPalette(); } }
  if (m.art && m.art !== artUrl) {
    artUrl = m.art;
    const img = new Image();
    img.onload = () => {
      const box = $('art'), olds = [...box.children];
      img.style.opacity = 0; box.appendChild(img);
      requestAnimationFrame(() => { img.style.opacity = 1; });
      setTimeout(() => olds.forEach(o => o.remove()), 1300);
      if (!srvPalKey) { try { artPal = extract(img); } catch { artPal = null; } }
      applyPalette();
    };
    img.src = '/idle/art?u=' + encodeURIComponent(m.art);
  }
  progress();
}
function progress() {
  const m = D.music; if (!m || !m.duration) return;
  const p = Math.min(m.duration, m.progress + (m.playing ? Date.now() - (m.at + off) : 0));
  $('pc').textContent = mmss(p); $('pd').textContent = mmss(m.duration);
  $('pf').style.transform = `scaleX(${(p / m.duration).toFixed(4)})`;
}

// ── Seguir viendo: el servidor manda los bloques (Netflix con las imágenes ya por /idle/nfx, Spotify…) solo cuando tocan
const dur = sec => { const m = Math.max(1, Math.round(sec / 60)); return m >= 60 ? Math.floor(m / 60) + ' h' + (m % 60 ? ' ' + (m % 60) + ' min' : '') : m + ' min'; };
const epLabel = it => (it.ep ? [it.ep.s && 'T' + it.ep.s, it.ep.e && 'E' + it.ep.e].filter(Boolean).join(' · ') : 'Película');
const fresh = it => !it.pos || it.pos < 30;                // capítulo aún sin empezar (el siguiente de la serie)
const leftLabel = it => (it.dur ? (fresh(it) ? dur(it.dur) : 'quedan ' + dur(it.dur - it.pos)) : '');
const frac = it => (it.dur ? Math.min(1, Math.max(0, it.pos / it.dur)) : 0);
/** pone una imagen con fundido sobre la anterior (y, si se pide, saca sus colores para el ambiente) */
function swapImg(box, url, onload) {
  if (!url) { box.textContent = ''; return; }
  if (box.dataset.u === url) return;
  box.dataset.u = url;
  const img = new Image();
  img.decoding = 'async';
  img.onload = () => {
    if (box.dataset.u !== url) return;
    const olds = [...box.querySelectorAll('img')];
    img.style.opacity = 0; box.prepend(img);
    requestAnimationFrame(() => { img.style.opacity = 1; });
    setTimeout(() => olds.forEach(o => o.remove()), 1300);
    if (onload) onload(img);
  };
  img.src = url;
}
/** el widget de Netflix entero (solo Netflix, en grande): destacado, fotograma del episodio y dos títulos más */
let nfxKey = '';
function nfxWidget(list) {
  const k = JSON.stringify(list.slice(0, 3));
  if (k === nfxKey) return;
  nfxKey = k;
  const it = list[0];
  $('nfT').textContent = it.title;
  $('nfS').textContent = epLabel(it);
  $('nfL').textContent = leftLabel(it);
  $('nfF').style.transform = `scaleX(${frac(it).toFixed(3)})`;
  swapImg($('nfHero'), it.story || it.card, img => { if (!D.music) { try { artPal = extract(img); } catch { artPal = null; } applyPalette(); } });
  // el episodio: su fotograma (en una película, la tarjeta), su número y su título
  const still = $('nfStill');
  swapImg(still, (it.ep && it.ep.still) || it.card);
  $('nfSF').style.transform = `scaleX(${frac(it).toFixed(3)})`;
  // (lo que queda ya va en el destacado: aquí, qué es y cuánto dura)
  $('nfEK').textContent = (it.ep ? (fresh(it) ? 'Siguiente episodio' : 'Episodio ' + (it.ep.e || '')) : 'Película') + (it.dur ? ' · ' + dur(it.dur) : '');
  $('nfET').textContent = it.ep ? it.ep.title || epLabel(it) : it.title;
  // dos títulos más, con la tarjeta de la serie (lleva su logo)
  const row = $('nfRow'); row.textContent = '';
  for (const o of list.slice(1, 3)) {
    const c = document.createElement('div'); c.className = 'nf-card';
    const im = document.createElement('div'); im.className = 'nf-cimg';
    const bar = document.createElement('span'); bar.className = 'nf-bar';
    const f = document.createElement('i'); f.style.transform = `scaleX(${frac(o).toFixed(3)})`; bar.append(f);
    im.append(bar);
    const cs = document.createElement('div'); cs.className = 'nf-cs'; cs.textContent = o.title + (o.ep ? ' · ' + epLabel(o) : '');
    c.append(im, cs); row.append(c);
    swapImg(im, o.card || o.story);
  }
  $('nfMore').hidden = list.length < 2;
}

// ── bloques de varias fuentes. Ninguna imagen se pinta más grande que su tamaño real en la tele (data-w, en --u): el ancho
// que toca según el sitio y la forma, acotado por el original (lo calcula block() en --iw)
const SRC = { netflix: ['Netflix', '#e50914'], spotify: ['Spotify', '#1ed760'], youtube: ['YouTube', '#ff0033'] };
const IW = { lead: { wide: 848, square: 456 }, side: { wide: 520, square: 300 }, row: { wide: 352, square: 216 }, tile: { wide: 352, square: 200 }, mini: { wide: 192, square: 160 } };
const artSrc = u => (!u ? '' : u.startsWith('/') ? u : '/idle/art?u=' + encodeURIComponent(u)); // la carátula, por nuestra ruta
/** lo que enseña un bloque: antetítulo, título, línea de abajo, progreso e imagen (con su ancho real) */
function itemOf(b, size) {
  if (b.src === 'netflix') {
    const it = b.items[0], hero = size === 'lead' && it.story;
    return { k: 'Seguir viendo', t: it.title, s: [epLabel(it), leftLabel(it)].filter(Boolean).join(' · '), f: frac(it), img: hero ? { u: it.story, w: 848 } : { u: it.card || it.story, w: it.card ? 665 : 848 }, shape: 'wide' };
  }
  if (b.src === 'spotify') {
    const img = { u: artSrc(b.art), w: b.artW || 640 };
    return b.state === 'playing'
      ? { k: 'Suena ahora', t: b.track, s: b.artist + (b.ctx ? ' · ' + b.ctx : ''), f: b.duration ? b.progress / b.duration : null, img, shape: 'square' }
      : { k: 'Seguir escuchando', t: b.ctx || b.track, s: 'Lo último: ' + b.track + ' · ' + b.artist, f: null, img, shape: 'square' };
  }
  const it = b.items[0]; // youtube
  return { k: 'Seguir viendo', t: it.title, s: it.channel + (it.dur ? ' · quedan ' + dur(it.dur - it.pos) : ''), f: it.dur ? it.pos / it.dur : null, img: { u: it.thumb, w: it.thumbW }, shape: 'wide' };
}
const keyOf = new WeakMap();
function block(el, b, size) {
  const it = itemOf(b, size), [name, dot] = SRC[b.src], k = JSON.stringify([size, it]);
  if (keyOf.get(el) === k) return;
  keyOf.set(el, k);
  const iw = Math.min(IW[size][it.shape], it.img.w);
  const cap = size === 'lead' && it.shape === 'wide' && iw >= 640 ? 'over' : '';   // texto encima de la imagen grande
  const c = document.createElement('div'); c.className = 'sg-c'; c.dataset.size = size; c.dataset.shape = it.shape; c.dataset.cap = cap; c.style.setProperty('--dot', dot);
  const im = document.createElement('div'); im.className = 'sg-img'; im.dataset.w = it.img.w; im.style.setProperty('--iw', iw);
  const m = document.createElement('div'); m.className = 'sg-m';
  m.innerHTML = '<div class="sg-k"><i></i><span></span></div><div class="sg-t"></div><div class="sg-s"></div>';
  m.querySelector('.sg-k span').textContent = size === 'lead' ? name + ' · ' + it.k : name;
  m.querySelector('.sg-t').textContent = it.t;
  m.querySelector('.sg-s').textContent = (size !== 'lead' && it.k !== 'Seguir viendo' ? it.k + ' · ' : '') + it.s;
  if (it.f != null) {
    const bar = document.createElement('span'); bar.className = 'sg-bar'; const f = document.createElement('i');
    f.style.transform = `scaleX(${Math.min(1, Math.max(0, it.f)).toFixed(3)})`; bar.append(f); (cap ? m : im).append(bar);
  }
  c.append(im, m); el.firstElementChild.replaceChildren(c);
  swapImg(im, it.img.u, size === 'lead' ? img => { if (!D.music) { try { artPal = extract(img); } catch { artPal = null; } applyPalette(); } } : null);
}
/** la fila de Netflix del aspecto discreto: antetítulo y 3–4 tarjetas de serie (665×375) a 300–320 px de la tele */
function shelf(el, b, max, cw) {
  const list = b.items.slice(0, max), k = JSON.stringify([max, cw, list]);
  if (keyOf.get(el) === k) return;
  keyOf.set(el, k);
  const box = document.createElement('div'); box.className = 'sg-shelf'; box.style.setProperty('--dot', SRC.netflix[1]);
  box.innerHTML = '<div class="sg-k"><i></i><span>Netflix · Seguir viendo</span></div><div class="sg-cards"></div>';
  const row = box.querySelector('.sg-cards');
  list.forEach((it, i) => {
    const w = it.card ? 665 : 848, iw = Math.min(cw, w);
    const c = document.createElement('div'); c.className = 'sg-card'; c.style.setProperty('--iw', iw);
    const im = document.createElement('div'); im.className = 'sg-img'; im.dataset.w = w; im.style.setProperty('--iw', iw);
    const bar = document.createElement('span'); bar.className = 'sg-bar'; const f = document.createElement('i'); f.style.transform = `scaleX(${frac(it).toFixed(3)})`; bar.append(f); im.append(bar);
    const t = document.createElement('div'); t.className = 'sg-ct'; t.textContent = it.title;
    const s = document.createElement('div'); s.className = 'sg-cs'; s.textContent = [epLabel(it), leftLabel(it)].filter(Boolean).join(' · ');
    c.append(im, t, s); row.append(c);
    swapImg(im, it.card || it.story, i === 0 ? img => { if (!D.music) { try { artPal = extract(img); } catch { artPal = null; } applyPalette(); } } : null);
  });
  el.firstElementChild.replaceChildren(box);
}
/** qué escenas tocan y qué va en cada bloque; si cambia el número de bloques o el aspecto, reacomodo */
function suggest() {
  const dark = D.profile === 'night' || D.profile === 'cinema';
  // el servidor manda suggest: { look, blocks }; uno de antes mandaba watching: { items } (solo Netflix, en grande)
  const sg = D.suggest || (D.watching && D.watching.items && D.watching.items.length ? { look: 'destacado', blocks: [{ src: 'netflix', items: D.watching.items }] } : null);
  const bl = dark || !sg ? [] : (sg.blocks || []).filter(b => b && SRC[b.src]).slice(0, 3);
  const n = bl.length, first = bl[0] && bl[0].src;
  // solo Spotify: el reposo de siempre, con su «ahora suena»; solo Netflix en grande: su widget entero
  const mode = !n || (n === 1 && first !== 'netflix') ? '' : first === 'netflix' && sg.look === 'discreto' ? 'dis' : n === 1 ? 'nfx' : 'sug';
  if (mode !== sug.mode || n !== sug.n) { sug = { mode, n }; scene = 0; if (layout) rearrange(0); }
  if (!mode) { nfxKey = ''; return; }
  if (mode === 'nfx') nfxWidget(bl[0].items);
  else if (mode === 'dis') {
    shelf(W.s0, bl[0], [0, 4, 3, 3][n], n === 3 ? 300 : 320);
    bl.slice(1).forEach((b, i) => block(W['s' + (i + 1)], b, n === 2 ? 'tile' : 'mini'));
  } else bl.forEach((b, i) => block(W['s' + i], b, i === 0 ? 'lead' : n === 2 ? 'side' : 'row'));
  requestAnimationFrame(fit);
}

// ── perfil y atenuado nocturno
function profile() {
  for (const p of ['day', 'evening', 'night', 'cinema']) B.classList.toggle(p, D.profile === p);
  B.classList.toggle('calm', !!D.cfg.calm);
  applyPalette();
}
function dimCheck() {
  const n = D.profile === 'night', mins = Number(D.cfg && D.cfg.dimMin) || 0;
  B.classList.toggle('dim', n && mins > 0 && !(D.acts && D.acts.length) && Date.now() - lastEvent > mins * 60e3);
}

// ── datos del servidor
const key = d => JSON.stringify([d.music && [d.music.title, d.music.playing], (d.acts || []).map(a => a.updated), d.profile]);
function onData(m) {
  const prev = key(D), prevCfg = JSON.stringify(D.cfg);
  off = Date.now() - m.now;
  D = { ...m, cfg: { ...D.cfg, ...(m.cfg || {}) } };
  setTz(D.cfg.tz);
  if (key(D) !== prev) lastEvent = Date.now();
  profile(); weather(); music(); acts(); suggest();
  if (JSON.stringify(D.cfg) !== prevCfg) { setLayout(D.cfg.layout); schedule(); }
  if (!moving) place(scenes()[scene % scenes().length]);
}
function connect() {
  const ws = new WebSocket('ws://' + location.host + '/idle-ws');
  ws.onmessage = e => { try { const m = JSON.parse(e.data); if (m.t === 'idle') onData(m); } catch {} };
  ws.onclose = () => setTimeout(connect, 1500);
}
// para pruebas y capturas: TVIdle.scene(n) fuerza una escena con su reacomodo; TVIdle.place(n), al momento
window.TVIdle = { scene: n => rearrange(n % scenes().length), place: n => { scene = n % scenes().length; place(scenes()[scene]); }, now: () => ({ layout, scene, moving, nfx: sug.mode === 'nfx', sug: sug.mode, n: sug.n }) };
// sin servidor también funciona: reloj y ambiente según la hora
D.profile = (h => h >= 8 && h < 20 ? 'day' : 'evening')(new Date().getHours());
// ±32 px de la tele de 1920×1080 (la misma unidad --u que idle.css), para que la deriva no se coma el margen en pantallas pequeñas
function drift() { const u = Math.min(innerWidth / 1920, innerHeight / 1080), r = () => Math.round((Math.random() * 64 - 32) * u); $('dx').style.transform = `translate(${r()}px,${r()}px)`; }
setInterval(drift, 150e3); setTimeout(drift, 1000);
setLayout(D.cfg.layout); schedule(); profile(); clock(); connect();
setInterval(applyPalette, 5 * 60e3);
// el ajuste depende de las fuentes y del tamaño de la pantalla
addEventListener('resize', fit); document.fonts.ready.then(fit);
