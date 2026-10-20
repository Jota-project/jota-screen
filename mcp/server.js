#!/usr/bin/env node
'use strict';
// MCP "tv-canvas": controla el navegador de la pantalla (Chrome en modo kiosco) a través de la API del mando.
//   TV_URL        base de la API (por defecto http://127.0.0.1:8787; desde otra máquina, la URL pública del mando)
//   TV_TOKEN      token del mando (si no se indica, se lee de TV_TOKEN_FILE o TV_STATE_DIR/token)
//   TV_STATE_DIR  carpeta de estado del servidor (por defecto ~/.local/state/jota-screen), como en el servidor
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

const BASE = (process.env.TV_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '');
function token() {
  if (process.env.TV_TOKEN) return process.env.TV_TOKEN.trim();
  const dir = process.env.TV_STATE_DIR || path.join(os.homedir(), '.local', 'state', 'jota-screen');
  const f = process.env.TV_TOKEN_FILE || path.join(dir, 'token');
  try { return fs.readFileSync(f, 'utf8').trim(); } catch { return ''; }
}

async function api(method, p, body) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 150_000);
  try {
    const r = await fetch(BASE + p, {
      method, signal: ctl.signal,
      headers: { Authorization: 'Bearer ' + token(), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let j; try { j = JSON.parse(text); } catch { j = { error: text.slice(0, 200) }; }
    if (!r.ok && !j.error) j.error = 'HTTP ' + r.status;
    return j;
  } catch (e) {
    return { error: 'no se pudo contactar con la tele (' + (e.name === 'AbortError' ? 'tiempo agotado' : e.message) + ')' };
  } finally { clearTimeout(timer); }
}
const cmd = m => api('POST', '/api/cmd', m);
const out = (j, ok) => ({
  content: [{ type: 'text', text: j.error ? 'Error: ' + j.error : (ok || JSON.stringify(j)) }],
  ...(j.error ? { isError: true } : {}),
});

const server = new McpServer({ name: 'tv-canvas', version: '0.1.0' });
const tool = (name, description, shape, fn) => server.registerTool(name, { description, inputSchema: shape }, fn);

tool('tv_state', 'Current state of the TV browser: page title, URL, volume, whether a video is playing (media: 1 playing, 0 paused, -1 no video) and what is on the stage.', {},
  async () => out(await api('GET', '/api/state')));

tool('tv_open', 'Open a URL on the TV. Bare text is turned into a Google search. Only http/https. For YouTube/Netflix searches prefer tv_open_app.',
  { url: z.string().describe('Full URL, a domain, or search text') },
  async ({ url }) => out(await cmd({ t: 'nav', url }), 'Opened'));

tool('tv_open_app', 'Open a streaming app on the TV, optionally searching inside it. After opening, use tv_screenshot / tv_links / tv_click_text to pick the result and start playback.',
  { app: z.enum(['youtube', 'netflix', 'spotify', 'home']), query: z.string().optional().describe('Search text inside the app') },
  async ({ app, query }) => {
    const q = encodeURIComponent(query || '');
    const url = app === 'youtube' ? (query ? `https://www.youtube.com/results?search_query=${q}` : 'https://www.youtube.com/')
      : app === 'netflix' ? (query ? `https://www.netflix.com/search?q=${q}` : 'https://www.netflix.com/browse')
        : app === 'spotify' ? (query ? `https://open.spotify.com/search/${q}` : 'https://open.spotify.com/') : null;
    return out(await cmd(app === 'home' ? { t: 'home' } : { t: 'nav', url }), 'Opened ' + app);
  });

tool('tv_nav', 'Browser navigation on the TV: back, forward, reload, or go to the home screen.',
  { action: z.enum(['back', 'forward', 'reload', 'home', 'fullscreen']) },
  async ({ action }) => out(await cmd({ t: action === 'fullscreen' ? 'fs' : action }), 'Done'));

tool('tv_media', 'Control the video playing on the TV: toggle play/pause, or seek relative seconds (negative = back).',
  { action: z.enum(['playpause', 'seek']), seconds: z.number().optional().describe('Seconds to seek, e.g. 30 or -10') },
  async ({ action, seconds }) => out(await cmd(action === 'seek' ? { t: 'seek', s: seconds ?? 10 } : { t: 'pp' })));

tool('tv_volume', 'TV volume: up/down (5% per step, optional repeat), mute toggle, or set an absolute level 0-100.',
  { action: z.enum(['up', 'down', 'mute', 'set']), level: z.number().min(0).max(100).optional(), steps: z.number().int().min(1).max(20).optional() },
  async ({ action, level, steps }) => {
    if (action === 'set') return out(await cmd({ t: 'volset', v: level ?? 50 }));
    let r;
    for (let i = 0; i < (action === 'mute' ? 1 : steps || 1); i++) r = await cmd({ t: 'vol', d: action });
    return out(r);
  });

tool('tv_spotify',
  'Control Spotify on the TV (the server is a Spotify Connect device, Premium account). Actions: status (short: what is playing, connected?), ' +
  'now (full now-playing: track, album+year, artist photo, playing context (playlist/album), queue, shuffle/repeat, liked, volume, album-art colours), ' +
  'play, pause, playpause, next, prev, volume (level 0-100), seek (ms, or pos 0-1), shuffle (state true/false, omit to toggle), repeat (state off|context|track, omit to cycle), ' +
  'like (save/unsave the current track to "Tus me gusta"; state true/false, omit to toggle), queue (next up), queue_add (uri of a track), playlists (the user\'s playlists), recent (recently played), ' +
  'search_play (query + type track|album|artist|playlist: finds the best match and plays it — use this for "ponme X"), search (list candidates with URIs), uri (play a Spotify link/URI; with a playlist/album uri, offset = track uri to start there). ' +
  'If it reports Spotify not configured/connected or missing permissions, tell the user in one sentence.',
  {
    action: z.enum(['status', 'now', 'play', 'pause', 'playpause', 'next', 'prev', 'volume', 'seek', 'shuffle', 'repeat', 'like', 'queue', 'queue_add', 'playlists', 'recent', 'search_play', 'search', 'uri']),
    ms: z.number().optional(), pos: z.number().min(0).max(1).optional(), state: z.union([z.boolean(), z.enum(['off', 'context', 'track'])]).optional(),
    offset: z.string().max(200).optional(),
    query: z.string().max(200).optional().describe('Search text, e.g. "Rosalía Despechá" or "lofi hip hop"'),
    type: z.enum(['track', 'album', 'artist', 'playlist']).optional().describe('What to search/play; default track. Use playlist for moods/genres, artist for "algo de X".'),
    level: z.number().min(0).max(100).optional(), uri: z.string().max(200).optional(),
  },
  async ({ action, query, type, level, uri, ms, pos, state, offset }) => {
    const r = await cmd({ t: 'spotify', a: action, query, type, v: level, uri, ms, pos, state, offset });
    if (action === 'now' && !r.error && r.colors) delete r.colors.hsl; // al agente le basta con los hex
    return out(r);
  });

tool('tv_key', 'Press a key in the TV browser (e.g. Enter, Escape, ArrowDown, Tab, Backspace, Space, or a single character).',
  { key: z.string().max(20) }, async ({ key }) => out(await cmd({ t: 'key', k: key }), 'Pressed ' + key));

tool('tv_type', 'Type text into the focused field on the TV page (search boxes, forms). Never type passwords unless the user explicitly asks.',
  { text: z.string().max(2000) }, async ({ text }) => out(await cmd({ t: 'text', v: text }), 'Typed'));

tool('tv_links', 'List clickable elements currently visible on the TV page (text, href, x, y). Optional regex filter. Use it to find results/buttons.',
  { filter: z.string().optional().describe('Case-insensitive regex on the element text') },
  async ({ filter }) => out(await cmd({ t: 'links', text: filter || '' })));

tool('tv_click_text', 'Click the first visible element whose text or aria-label matches a case-insensitive regex (e.g. "Reproducir|Play", "Perfil.*Ana").',
  { text: z.string().max(120) }, async ({ text }) => out(await cmd({ t: 'clicktext', text })));

tool('tv_click_at', 'Click at viewport coordinates (CSS pixels of the screenshot returned by tv_screenshot at width 1280).',
  { x: z.number(), y: z.number() }, async ({ x, y }) => out(await cmd({ t: 'click', x, y }), 'Clicked'));

tool('tv_screenshot', 'Take a screenshot of what the TV browser is showing (DRM video frames may appear black).',
  { width: z.number().int().min(320).max(1920).optional() },
  async ({ width }) => {
    const r = await cmd({ t: 'shot', w: width || 960 });
    if (r.error) return out(r);
    return { content: [{ type: 'image', data: r.data, mimeType: r.mime }] };
  });

tool('tv_present',
  'Show a built-in animated template on the TV. kinds and data:\n' +
  '- tasks: {title, subtitle?, kicker?, items:[{id, text, done?, tag?, due?}]} — checklist with progress bar; items can be ticked on the TV.\n' +
  '- reminder: {title, text?, time?, icon?(emoji), kicker?} — big centered card. Use seconds to auto-dismiss.\n' +
  '- slides: {title?, autoplay?(seconds), index?, slides:[{kicker?, title?, subtitle?, bullets?:[], big?(huge number/text), image?(url), html?}]}\n' +
  'The previous page is restored when it closes. Update live with tv_update.',
  { kind: z.enum(['tasks', 'reminder', 'slides']), data: z.record(z.any()), seconds: z.number().optional().describe('Auto-close after N seconds') },
  async ({ kind, data, seconds }) => out(await cmd({ t: 'present', kind, data, seconds }), 'Shown ' + kind));

tool('tv_show_html',
  'Show your own full-screen HTML page on the TV (rich presentations, animations, dashboards, games). Viewport ≈ 1280x720 CSS px, dark TV, read from the sofa: big type, high contrast, no tiny UI. ' +
  'Self-contained; https images/fonts/scripts are allowed, calls to other services are not. A global `tv` object is available: tv.onData(fn) receives live data (initial `data` and every tv_update), tv.emit(name, obj) sends events back (read with tv_events), tv.close() returns to the previous page.',
  { html: z.string().max(1_000_000), data: z.record(z.any()).optional().describe('Initial data for tv.onData'), seconds: z.number().optional() },
  async ({ html, data, seconds }) => out(await cmd({ t: 'show', html, data, seconds }), 'Shown'));

tool('tv_update', 'Update the data of what is on the stage (template or custom HTML) live, without reloading — animations run. Objects are merged shallowly unless replace is true.',
  { data: z.record(z.any()), replace: z.boolean().optional() },
  async ({ data, replace }) => out(await cmd({ t: 'stage', data, replace }), 'Updated'));

tool('tv_close', 'Close the stage and return to the page that was open before.', {},
  async () => out(await cmd({ t: 'close' }), 'Closed'));

tool('tv_toast', 'Show a short notification card in the top-right corner over whatever is playing (even fullscreen video), then fade out. Good for reminders and confirmations.',
  { title: z.string().max(120), text: z.string().max(400).optional(), icon: z.string().max(8).optional().describe('One emoji'), seconds: z.number().min(2).max(120).optional() },
  async (a) => out(await cmd({ t: 'toast', title: a.title, text: a.text, icon: a.icon, seconds: a.seconds }), 'Shown'));

tool('tv_activity',
  'Live Activity on the TV: a small black pill at the top centre, above whatever is showing (idle screen, web, fullscreen video), updated in real time — like Apple Live Activities. ' +
  'It expands briefly when created or updated (unless quiet), then stays compact. op=set creates/updates (same id = update), op=end removes, clear removes all, list shows them. ' +
  'Use seconds for a countdown timer (expands and pulses when it ends), elapsed for a running stopwatch, progress 0-1 for a progress ring, value for short text on the right (e.g. "2-1", "12 min"). ' +
  'Keep title short (2-4 words). Use ttl to auto-remove. Prefer this over toasts for things that last (timers, deliveries, a task in progress, a match score).',
  {
    op: z.enum(['set', 'end', 'clear', 'list']).optional(),
    id: z.string().max(40).optional().describe('Stable id to update/end it later, e.g. "pasta-timer"'),
    title: z.string().max(80).optional(), subtitle: z.string().max(140).optional(),
    icon: z.string().max(8).optional().describe('One emoji'), accent: z.string().max(9).optional().describe('Hex colour, e.g. #ff9f0a'),
    seconds: z.number().optional().describe('Countdown length in seconds'), elapsed: z.number().optional().describe('Stopwatch: seconds already elapsed'),
    progress: z.number().min(0).max(1).nullable().optional(), value: z.string().max(16).optional(),
    priority: z.number().min(-10).max(10).optional(), quiet: z.boolean().optional().describe('Update without expanding'),
    ttl: z.number().optional().describe('Auto-remove after N seconds'), doneText: z.string().max(140).optional().describe('Subtitle when a countdown ends'),
  },
  async (a) => out(await cmd({ t: 'activity', ...a })));

tool('tv_idle',
  'The TV idle screen (animated background by time of day or by the colours of the song playing, big clock, local weather if a location is set, now playing). ' +
  'op=show opens it now; op=get returns its settings and current profile; op=set changes settings: mode (auto|day|evening|night|cinema), ' +
  'bed/wake ("HH:MM", fixed sleep schedule), perDay + week {mon:{bed,wake},…} for a per-weekday schedule, idleMin (minutes without use before it opens itself, 0 = never), ' +
  'dimMin (at night, minutes until only a faint clock remains), music (show Spotify), city/lat/lon/tz (weather location; lat/lon null = no weather), ' +
  'layout (rotar|margen|zonas|apilada: how clock, weather and music are arranged; rotar cycles them), rearrangeMin (minutes between rearrangements, 0 = never), calm (reduced motion).',
  { op: z.enum(['show', 'get', 'set']), cfg: z.record(z.any()).optional() },
  async ({ op, cfg }) => out(await cmd({ t: 'idle', op, cfg })));

tool('tv_admin_link',
  'Create a one-time admin link for the TV remote (expires in 10 minutes). Opening it on a phone (or typing the code in the remote: ' +
  '"Tengo un código de administrador") makes that device an admin with its own revocable token, without ever exposing the master token. ' +
  'Only give it to the owner, never to guests.', {},
  async () => { const j = await cmd({ t: 'adminlink' }); return out(j, j.error ? '' : `Link (one use, expires in ${j.minutes} min): ${j.url}\nCode: ${j.code}`); });

tool('tv_events', 'Read events sent from the stage page (ticked tasks, slide changes, custom tv.emit). Pass the last value as `since` to get only new ones.',
  { since: z.number().int().optional() },
  async ({ since }) => out(await api('GET', '/api/events?since=' + (since || 0))));

server.connect(new StdioServerTransport()).catch(e => { console.error(e); process.exit(1); });
