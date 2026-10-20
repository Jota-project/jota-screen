// Pantalla en reposo (idle.html): reloj, tiempo, actividades, ahora suena, ambiente y reacomodos. Sin módulos:
// onData y TVIdle quedan globales (las capturas de e2e/ los llaman).
const $ = id => document.getElementById(id);
const B = document.body, BG = $('bg'), G = $('grid');
const W = { hora: $('wHora'), ctx: $('wCtx'), mus: $('wMus') };
let D = { profile: 'day', weather: null, music: null, acts: [], cfg: { dimMin: 20, layout: 'rotar', rearrangeMin: 18, calm: false } }, off = 0, lastEvent = Date.now();

// ── distribuciones: cada escena coloca los widgets en la rejilla (fila-inicio / col-inicio / fila-fin / col-fin)
const L = {
  margen: [
    { hora: ['4/1/7/10', 'start', 'end', 'line', 'left'], ctx: ['1/8/3/13', 'end', 'start', 'col', 'right'], mus: ['6/8/7/13', 'end', 'end', 'line', 'right'] },
    { hora: ['1/4/4/13', 'end', 'start', 'line', 'right'], ctx: ['3/1/5/7', 'start', 'end', 'col', 'left'], mus: ['6/1/7/7', 'start', 'end', 'line', 'left'] },
    { hora: ['2/2/5/12', 'center', 'center', 'line', 'left'], ctx: ['5/1/7/7', 'start', 'end', 'col', 'left'], mus: ['1/8/2/13', 'end', 'start', 'line', 'right'] },
  ],
  zonas: [
    { ctx: ['1/1/2/13', 'stretch', 'center', 'row', 'left'], hora: ['2/1/5/13', 'start', 'center', 'line', 'left'], mus: ['6/1/7/13', 'stretch', 'center', 'band', 'left'] },
    { hora: ['1/1/4/13', 'start', 'start', 'line', 'left'], mus: ['5/1/6/13', 'stretch', 'center', 'band', 'left'], ctx: ['6/1/7/13', 'stretch', 'center', 'row', 'left'] },
    { mus: ['1/1/2/13', 'stretch', 'center', 'band', 'left'], ctx: ['3/1/4/13', 'stretch', 'center', 'row', 'left'], hora: ['4/1/7/13', 'start', 'end', 'line', 'left'] },
  ],
  apilada: [
    { hora: ['1/1/7/7', 'start', 'center', 'stack', 'left'], ctx: ['1/8/3/13', 'stretch', 'start', 'col', 'left'], mus: ['3/8/7/13', 'stretch', 'end', 'big', 'left'] },
    { hora: ['1/7/7/13', 'end', 'center', 'stack', 'right'], ctx: ['1/1/3/7', 'stretch', 'start', 'col', 'left'], mus: ['3/1/7/7', 'stretch', 'end', 'big', 'left'] },
    { hora: ['1/1/7/7', 'start', 'end', 'stack', 'left'], ctx: ['5/8/7/13', 'stretch', 'end', 'col', 'left'], mus: ['1/8/4/13', 'stretch', 'start', 'big', 'left'] },
  ],
};
L.rotar = [...L.margen, ...L.zonas, ...L.apilada];
let layout = '', scene = 0, rTimer = 0, moving = false;
function place(sc) {
  for (const k of ['hora', 'ctx', 'mus']) {
    const [area, jx, jy, v, ta] = sc[k], e = W[k];
    e.style.gridArea = area; e.style.justifySelf = jx; e.style.alignSelf = jy;
    e.dataset.v = D.profile === 'night' && k === 'mus' ? 'line' : v; e.dataset.ta = ta;
    if (k === 'mus') e.dataset.dir = ta === 'right' ? 'rev' : '';
  }
}
// reacomodo coreografiado: atenuar, colocar, y que cada widget viaje desde donde estaba (FLIP)
function rearrange(next) {
  if (moving) return;
  const calm = !!D.cfg.calm; moving = true;
  G.classList.add('leaving');
  setTimeout(() => {
    const els = Object.values(W), first = els.map(e => e.getBoundingClientRect());
    place(L[layout][next]); scene = next;
    if (!calm) els.forEach((e, i) => {
      const a = first[i], b = e.getBoundingClientRect();
      e.style.transition = 'none'; e.style.transform = `translate(${a.left - b.left}px,${a.top - b.top}px)`;
    });
    requestAnimationFrame(() => requestAnimationFrame(() => {
      els.forEach((e, i) => {
        const d = i * .12;
        e.style.transition = `transform 1.5s var(--ease) ${d}s, opacity .7s ease ${d + .35}s`;
        e.style.transform = '';
      });
      G.classList.remove('leaving');
      setTimeout(() => { els.forEach(e => { e.style.transition = ''; }); moving = false; }, 2200);
    }));
  }, 650);
}
function setLayout(name) {
  if (!L[name]) name = 'rotar';
  if (name === layout) return;
  const first = !layout; layout = name; scene = 0;
  if (first) place(L[layout][0]); else rearrange(0);
}
function schedule() {
  clearInterval(rTimer);
  const min = Number(D.cfg.rearrangeMin) || 0;
  if (min > 0) rTimer = setInterval(() => rearrange((scene + 1) % L[layout].length), min * 60e3);
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
  if (!dark && artPal && D.music) { const ev = D.profile === 'evening'; p = [tone(artPal[0], ev ? .32 : .36), tone(artPal[1], ev ? .28 : .34), p[2], ev ? .32 : .3]; }
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
  profile(); weather(); music(); acts();
  if (JSON.stringify(D.cfg) !== prevCfg) { setLayout(D.cfg.layout); schedule(); }
  place(L[layout][scene]);
}
function connect() {
  const ws = new WebSocket('ws://' + location.host + '/idle-ws');
  ws.onmessage = e => { try { const m = JSON.parse(e.data); if (m.t === 'idle') onData(m); } catch {} };
  ws.onclose = () => setTimeout(connect, 1500);
}
// para pruebas y capturas: TVIdle.scene(n) fuerza una escena
window.TVIdle = { scene: n => rearrange(n % L[layout].length), now: () => ({ layout, scene }) };
// sin servidor también funciona: reloj y ambiente según la hora
D.profile = (h => h >= 8 && h < 20 ? 'day' : 'evening')(new Date().getHours());
function drift() { const r = () => Math.round(Math.random() * 64 - 32); $('dx').style.transform = `translate(${r()}px,${r()}px)`; }
setInterval(drift, 150e3); setTimeout(drift, 1000);
setLayout(D.cfg.layout); schedule(); profile(); clock(); connect();
setInterval(applyPalette, 5 * 60e3);
