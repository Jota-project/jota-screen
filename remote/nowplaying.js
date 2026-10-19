'use strict';
// «Ahora suena» de Spotify: un único estado completo que usan el reposo, el mando y el agente.
// Canción, disco, artista (con foto), desde dónde suena (playlist/álbum), cola, aleatorio/repetición,
// «Me gusta», volumen, controles permitidos y los colores de la carátula (calculados aquí).
// Solo se consulta a Spotify mientras alguien lo está mirando (reposo abierto o panel del mando), y con calma:
// Spotify bloquea la cuenta si se le pide demasiado (429). Cada consulta es un `/me/player`; artista, contexto,
// «me gusta» y colores se piden una vez por canción (también si fallan) y la cola solo cuando cambia algo.
// El progreso lo interpolan los clientes con `progress` + `at`.
const jpeg = require('jpeg-js');

// cada cuánto se consulta según quién mira (watching(): 0 nadie, 1 solo el reposo, 2 el panel del mando)
const EVERY = { 1: { playing: 10_000, paused: 30_000 }, 2: { playing: 5_000, paused: 15_000 } };
const FAIL_TTL = 10 * 60_000;     // un dato que ha fallado no se vuelve a pedir hasta pasado este tiempo
const QUEUE_PANEL = 60_000;       // con el panel abierto, la cola se refresca como mucho cada minuto

module.exports = function createNow({ spApi, spReady, watching, onChange, log = () => {} }) {
  let now = null;
  let sig = '';
  let queue = [], queueFor = '', queueAt = 0, queueStale = true;
  let liked = new Map();          // trackId -> bool | null (null: no se pudo saber)
  let likeOk = true;              // false si faltan permisos de biblioteca
  const artists = new Map();      // id -> {name, image}
  const contexts = new Map();     // uri -> {name, image}
  const colors = new Map();       // url -> paleta
  const failed = new Map();       // clave -> hora del fallo (artista, contexto, colores)
  let inflight = null, inflightAt = 0, lastTry = 0, lastOk = 0, endFor = '', cmdAt = 0;
  const failedRecently = k => { const t = failed.get(k); return t && Date.now() - t < FAIL_TTL; };
  const fail = (k, e) => { if (e?.wait) return; failed.set(k, Date.now()); if (failed.size > 300) failed.delete(failed.keys().next().value); };
  const cap = (m, n) => { if (m.size > n) m.delete(m.keys().next().value); };

  const img = (list = []) => {
    const s = [...list].sort((a, b) => (b.width || 0) - (a.width || 0));
    return s.length ? { l: s[0].url, m: (s[1] || s[0]).url, s: s[s.length - 1].url } : null;
  };
  const year = d => (d || '').slice(0, 4);

  // ───────── colores de la carátula (miniatura de 64 px, JPEG)
  function hsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
    if (mx === mn) return [0, 0, l];
    const d = mx - mn, s = l > .5 ? d / (2 - mx - mn) : d / (mx + mn);
    const h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [h * 60, s, l];
  }
  function hex(h, s, l) {
    const k = n => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
    const f = n => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))));
    return '#' + [f(0), f(8), f(4)].map(x => x.toString(16).padStart(2, '0')).join('');
  }
  async function palette(url) {
    if (!url) return null;
    if (colors.has(url)) return colors.get(url);
    if (failedRecently('img:' + url)) return null;
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
      const { data } = jpeg.decode(Buffer.from(await r.arrayBuffer()), { useTArray: true, maxResolutionInMP: 2 });
      const bk = new Map();
      let sr = 0, sg = 0, sb = 0, n = 0;
      for (let i = 0; i < data.length; i += 16) { // uno de cada 4 píxeles basta
        const R = data[i], G = data[i + 1], B = data[i + 2];
        sr += R; sg += G; sb += B; n++;
        const [h, s, l] = hsl(R, G, B);
        if (l < .07 || l > .94) continue;
        const key = Math.round(h / 20) + ':' + Math.round(s * 3) + ':' + Math.round(l * 4);
        const e = bk.get(key) || { w: 0, c: 0, s: 0, l: 0, x: 0, y: 0 };
        e.w += 1 + s * 2.5; e.c++; e.s += s; e.l += l; e.x += Math.cos(h * Math.PI / 180); e.y += Math.sin(h * Math.PI / 180);
        bk.set(key, e);
      }
      const cand = [...bk.values()].map(e => [((Math.atan2(e.y, e.x) * 180 / Math.PI) + 360) % 360, e.s / e.c, e.l / e.c, e.w]).sort((a, b) => b[3] - a[3]);
      const out = [];
      for (const c of cand) {
        if (out.every(o => Math.min(Math.abs(o[0] - c[0]), 360 - Math.abs(o[0] - c[0])) > 22 || Math.abs(o[2] - c[2]) > .25)) out.push(c);
        if (out.length === 4) break;
      }
      const avg = hsl(sr / n, sg / n, sb / n);
      if (!out.length) out.push(avg);
      while (out.length < 4) { const b = out[0]; out.push([(b[0] + 24 * out.length) % 360, b[1] * .8, Math.max(.15, b[2] * .7)]); }
      const p = {
        hsl: out.map(c => c.map(v => +v.toFixed(3)).slice(0, 3)),                   // [h, s, l] para ajustar luminosidad al gusto
        swatches: out.map(c => hex(c[0], c[1], c[2])),                               // tal cual
        bg: hex(out[0][0], Math.min(.7, Math.max(.25, out[0][1])), .16),              // fondo oscuro para paneles
        accent: hex(out[0][0], Math.min(.85, Math.max(.45, out[0][1])), .62),         // color de acento legible sobre oscuro
        avg: hex(avg[0], avg[1], avg[2]),
      };
      colors.set(url, p); if (colors.size > 50) colors.delete(colors.keys().next().value);
      return p;
    } catch (e) { log('colores:', e.message); fail('img:' + url); return null; }
  }

  // ───────── datos auxiliares (con caché; un fallo se recuerda FAIL_TTL salvo si es la espera por límite)
  async function artistInfo(a) {
    if (!a?.id) return null;
    if (artists.has(a.id)) return artists.get(a.id);
    const fallback = { id: a.id, name: a.name, image: null };
    if (failedRecently('artist:' + a.id)) return fallback;
    try { const j = await spApi('GET', '/artists/' + a.id); const v = { id: a.id, name: j.name, image: img(j.images) }; artists.set(a.id, v); cap(artists, 200); return v; }
    catch (e) { fail('artist:' + a.id, e); return fallback; }
  }
  async function contextInfo(c, item) {
    if (!c?.uri) return null;
    const [, , id] = c.uri.split(':');
    if (contexts.has(c.uri)) return { type: c.type, uri: c.uri, ...contexts.get(c.uri) };
    let v = { name: '', image: null };
    if (failedRecently('ctx:' + c.uri)) return { type: c.type, uri: c.uri, ...v };
    try {
      if (c.type === 'album') v = { name: item?.album?.name || '', image: img(item?.album?.images) };
      else if (c.type === 'artist') { const a = await artistInfo({ id }); v = { name: a?.name || '', image: a?.image }; }
      else if (c.type === 'playlist') { const j = await spApi('GET', `/playlists/${id}?fields=name,images,owner(display_name)`); v = { name: j.name, image: img(j.images), owner: j.owner?.display_name }; }
      else if (c.type === 'collection' || /:collection$/.test(c.uri)) v = { name: 'Tus me gusta', image: null };
      else if (c.type === 'show') { const j = await spApi('GET', '/shows/' + id); v = { name: j.name, image: img(j.images) }; }
    } catch (e) { fail('ctx:' + c.uri, e); return { type: c.type, uri: c.uri, ...v }; }   // sin cachear: se reintenta pasado el plazo
    contexts.set(c.uri, v); cap(contexts, 100);
    return { type: c.type, uri: c.uri, ...v };
  }
  async function likedOf(id) {
    if (!id) return null;
    if (liked.has(id)) return liked.get(id);
    let v = null;
    try {
      const j = await spApi('GET', '/me/library/contains?uris=' + encodeURIComponent('spotify:track:' + id));
      v = Array.isArray(j) ? !!j[0] : null; likeOk = true;
    } catch (e) {
      if (e.wait) return null;                                         // en espera por límite: se pregunta luego
      if (/403|scope|Insufficient/i.test(e.message)) likeOk = false;
    }
    liked.set(id, v); cap(liked, 500);                                 // una vez por canción, salga bien o mal
    return v;
  }
  async function loadQueue(trackId) {
    try {
      const j = await spApi('GET', '/me/player/queue');
      queue = (j.queue || []).slice(0, 10).map(t => ({
        uri: t.uri, name: t.name, artist: (t.artists || []).map(a => a.name).join(', ') || t.show?.name || '',
        image: img(t.album?.images || t.images)?.s || null, duration: t.duration_ms || 0,
      }));
      queueFor = trackId; queueAt = Date.now(); queueStale = false;
    } catch (e) { if (!e.wait) { queueFor = trackId; queueAt = Date.now(); queueStale = false; } }  // no insistir en cada vuelta
  }

  // ───────── consulta
  // poll(maxAge): devuelve el estado si se consultó hace menos de maxAge ms; si no, consulta (o se une a la consulta
  // en curso cuando esta empezó dentro de ese margen). poll(0) tras una orden exige una consulta posterior a la llamada.
  function poll(maxAge = 2000) {
    if (maxAge === true) maxAge = 2000;                                // compatibilidad: poll(true)
    const t = Date.now(), since = Math.max(t - maxAge, cmdAt);      // nada anterior a la última orden vale
    if (!spReady()) return Promise.resolve(now);
    if (inflight) {
      if (inflightAt >= since) return inflight;
      return inflight.then(() => poll(maxAge));
    }
    if (now && lastOk && lastOk >= since) return Promise.resolve(now);
    inflightAt = t; lastTry = t;
    inflight = fetchNow(t).finally(() => { inflight = null; });
    return inflight;
  }
  async function fetchNow(started) {
    try {
      const j = await spApi('GET', '/me/player?additional_types=episode');
      const at = Date.now();                                           // el progreso es de este instante, no del final
      if (started >= cmdAt) lastOk = started;
      const it = j?.item;
      if (!it) {
        if (now?.empty !== true) { now = { empty: true, device: j?.device ? { name: j.device.name, volume: j.device.volume_percent, active: j.device.is_active } : null, needsLogin: !likeOk }; emit(); }
        return now;
      }
      const isEp = it.type === 'episode';
      const art = img(isEp ? it.images || it.show?.images : it.album?.images);
      const a0 = isEp ? null : it.artists?.[0];
      const [ai, ctx, lk, pal] = await Promise.all([
        a0 ? artistInfo(a0) : null, contextInfo(j.context, it), isEp ? null : likedOf(it.id), palette(art?.s),
      ]);
      const ctxChanged = (j.context?.uri || '') !== (now?.context?.uri || '');
      const panelStale = watching() >= 2 && Date.now() - queueAt > QUEUE_PANEL;
      if (queueStale || queueFor !== it.id || ctxChanged || panelStale) await loadQueue(it.id);
      now = {
        kind: isEp ? 'episode' : 'track', playing: !!j.is_playing, progress: j.progress_ms || 0, at, duration: it.duration_ms || 0,
        track: { id: it.id, uri: it.uri, name: it.name, explicit: !!it.explicit, number: it.track_number || null, url: it.external_urls?.spotify || '' },
        artists: isEp ? [{ name: it.show?.name || '' }] : (it.artists || []).map(a => ({ id: a.id, name: a.name })),
        artist: isEp ? it.show?.name || '' : (it.artists || []).map(a => a.name).join(', '),
        album: isEp ? { name: it.show?.name || '', image: art } : {
          id: it.album?.id, uri: it.album?.uri, name: it.album?.name || '', type: it.album?.album_type || '',
          year: year(it.album?.release_date), total: it.album?.total_tracks || null, image: art,
        },
        artistInfo: ai, context: ctx, liked: lk,
        shuffle: !!j.shuffle_state, smartShuffle: !!j.smart_shuffle, repeat: j.repeat_state || 'off',
        device: j.device ? { name: j.device.name, volume: j.device.volume_percent, active: j.device.is_active, type: j.device.type } : null,
        disallows: j.actions?.disallows || {}, queue, colors: pal, needsLogin: !likeOk,
      };
      emit();
      return now;
    } catch (e) { if (!e.wait) log('spotify now:', e.message); return now; }    // la espera por límite ya se avisa una vez en spApi
  }
  function emit() {
    // solo se avisa si cambia algo visible (o la posición se desvía: un salto)
    const n = now || {};
    const exp = n.empty ? 0 : n.progress;
    const s = JSON.stringify([n.empty, n.track?.id, n.playing, n.shuffle, n.repeat, n.liked, n.device?.volume, n.device?.name, n.context?.uri, n.queue?.map(q => q.uri).join(), n.needsLogin, Math.round(exp / 1000)]);
    const prev = sig; sig = s;
    const [a, b] = [JSON.parse(prev || '[]'), JSON.parse(s)];
    const onlyTime = prev && a.slice(0, -1).join('|') === b.slice(0, -1).join('|');
    if (onlyTime && n.playing && Math.abs((a.at(-1) || 0) + (Date.now() - lastEmit) / 1000 - b.at(-1)) < 2.5) return;
    if (onlyTime && !n.playing && a.at(-1) === b.at(-1)) return;
    lastEmit = Date.now();
    onChange(now);
  }
  let lastEmit = 0;

  // tras una orden: Spotify tarda un poco en reflejarla; dos consultas frescas (la de 700 ms la comparte after() en server.js)
  function kick() { queueStale = true; cmdAt = Date.now(); setTimeout(() => poll(0), 600); setTimeout(() => poll(0), 2000); }
  function forgetLiked(id) { liked.delete(id); }
  // el panel del mando se acaba de abrir: cola y «me gusta» al día (pueden haber cambiado desde el móvil)
  function panelOpened() {
    queueStale = true;
    if (now?.track?.id) liked.delete(now.track.id);
    return poll(0);
  }

  // planificador: intervalo según quién mira y si suena; y una consulta justo al acabar la canción
  setInterval(() => {
    const w = watching();
    if (!w || inflight || !spReady()) return;
    const t = Date.now(), ev = EVERY[w >= 2 ? 2 : 1];
    if (now?.playing && now.track && endFor !== now.track.id && now.progress + (t - now.at) >= now.duration + 800) {
      endFor = now.track.id; poll(0); return;                            // una sola vez por canción: si sigue la vieja, vuelve al intervalo
    }
    if (t - lastTry >= (now?.playing ? ev.playing : ev.paused)) poll(0);
  }, 1000);

  return { poll, get: () => now, kick, forgetLiked, panelOpened, palette };
};
