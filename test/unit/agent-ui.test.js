'use strict';
// Fichas de herramientas del agente (remote/src/features/agent-ui.js): lista cerrada por sufijo del nombre, detalle
// corto y seguro sacado de los argumentos, y los iconos como datos (primitivas SVG), no como HTML.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { KINDS, CARD_TOOLS, toolCard, toolName, clip, DETAIL_MAX } = require(path.join(__dirname, '..', '..', 'remote', 'src', 'features', 'agent-ui'));

test('KINDS: los 7 tipos del contrato, con título e icono hecho de primitivas path/circle', () => {
  assert.deepEqual(Object.keys(KINDS).sort(), ['home', 'music', 'screen', 'timer', 'video', 'volume', 'web']);
  for (const [k, { icon, title }] of Object.entries(KINDS)) {
    assert.ok(title, k);
    assert.ok(icon.length > 0, k);
    for (const [tag, attrs] of icon) {
      assert.ok(['path', 'circle'].includes(tag), `${k}: ${tag}`);
      if (tag === 'path') assert.match(attrs.d, /^[MLHVCSQTAZmlhvcsqtaz0-9.,\s-]+$/, `${k}: d sin nada más que trazado`);
      else for (const a of ['cx', 'cy', 'r']) assert.equal(typeof attrs[a], 'number', `${k}: ${a}`);
    }
  }
  assert.ok(Object.isFrozen(KINDS) && Object.isFrozen(KINDS.web.icon), 'datos compartidos: congelados');
});

test('lista cerrada: las del contrato con ficha; las de lectura sin ella', () => {
  assert.deepEqual([...CARD_TOOLS].sort(), ['tv_activity', 'tv_idle', 'tv_media', 'tv_open', 'tv_open_app', 'tv_present', 'tv_show_html', 'tv_spotify', 'tv_volume']);
  for (const n of ['tv_state', 'tv_links', 'tv_screenshot', 'tv_events', 'tv_key', 'tv_type', 'tv_click_text', 'tv_nav', 'tv_update', 'tv_close', 'web_search', '', null]) {
    assert.equal(toolCard(n, {}), null, String(n));
  }
});

test('se compara por sufijo con separador: el prefijo de OpenClaw vale; pegado al nombre, no', () => {
  const url = { url: 'https://www.cocina.example/receta' };
  for (const n of ['tv_open', 'tv-canvas__tv_open', 'tv-canvas.tv_open', 'mcp:tv_open']) assert.equal(toolCard(n, url)?.detail, 'cocina.example', n);
  assert.equal(toolCard('xtv_open', url), null);
  assert.equal(toolCard('tv_open_app', { app: 'netflix' }).detail, 'Netflix', 'tv_open_app no se confunde con tv_open');
});

test('detalle de cada herramienta', () => {
  const c = (n, a) => toolCard(n, a);
  assert.deepEqual(c('tv_open', { url: 'cocinadecasa.example' }), { kind: 'web', title: 'Abrir en la tele', detail: 'cocinadecasa.example' });
  assert.deepEqual(c('tv_open', { url: 'receta de paella' }), { kind: 'web', title: 'Buscar en la web', detail: 'receta de paella' });
  assert.deepEqual(c('tv_open_app', { app: 'youtube', query: 'gatos' }), { kind: 'video', title: 'Abrir en la tele', detail: 'YouTube' });
  assert.equal(c('tv_open_app', { app: 'spotify' }).kind, 'music');
  assert.deepEqual(c('tv_spotify', { action: 'search_play', query: 'jazz' }), { kind: 'music', title: 'Reproducir música', detail: 'Spotify' });
  assert.equal(c('tv_spotify', { action: 'status' }), null, 'consultas de Spotify: sin ficha');
  assert.deepEqual(c('tv_activity', { title: 'Pasta', seconds: 600 }), { kind: 'timer', title: 'Temporizador', detail: 'Pasta · 10 min' });
  assert.equal(c('tv_activity', { op: 'list' }), null);
  assert.equal(c('tv_activity', { op: 'end', id: 'x' }).title, 'Quitar aviso');
  assert.deepEqual(c('tv_volume', { action: 'set', level: 30 }), { kind: 'volume', title: 'Volumen', detail: 'Volumen 30 %' });
  assert.equal(c('tv_volume', { action: 'up' }).detail, 'Subir');
  assert.equal(c('tv_media', { action: 'seek', seconds: -10 }).detail, 'Atrás 10 s');
  assert.equal(c('tv_media', { action: 'playpause' }).kind, 'video');
  assert.deepEqual(c('tv_present', { kind: 'tasks', data: { title: 'Compra' } }), { kind: 'screen', title: 'Mostrar en la tele', detail: 'Compra' });
  assert.equal(c('tv_present', { kind: 'slides', data: {} }).detail, 'Diapositivas');
  assert.equal(c('tv_show_html', { html: '<script>x</script>' }).detail, 'Página a medida', 'nunca el HTML');
  assert.equal(c('tv_idle', { op: 'show' }).kind, 'screen');
  assert.equal(c('tv_idle', { op: 'set', cfg: {} }), null, 'tv_idle solo con op=show');
  assert.equal(c('tv_open', null).kind, 'web', 'args null no rompe');
});

test('herramientas de casa por nombre genérico (sin el prefijo del servidor)', () => {
  assert.deepEqual(toolCard('hass__light_turn_on', { entity_id: 'light.salon_techo' }), { kind: 'home', title: 'Casa', detail: 'salon techo' });
  assert.equal(toolCard('encender_luz', { area: 'Cocina' }).detail, 'Cocina');
  assert.equal(toolCard('HomeAssistant', {}).kind, 'home');
  assert.equal(toolCard('hass__tv_state', {}), null, 'el prefijo no la hace de casa');
});

test('casa: por palabras (camelCase incluido) y sin ficha para las de lectura ni para falsos positivos', () => {
  assert.equal(toolCard('HassTurnOn', {}).kind, 'home', 'camelCase de Home Assistant');
  assert.equal(toolCard('turn_on_lights', {}).kind, 'home', 'plural');
  assert.equal(toolCard('apagar_luces', {}).kind, 'home');
  assert.equal(toolCard('hass__light_set_state', {}).kind, 'home', 'set_state escribe');
  for (const n of ['hass__light_get_state', 'HassGetState', 'light_list', 'hass__highlight_text', 'spotlight_search']) {
    assert.equal(toolCard(n, {}), null, n);
  }
});

test('detalle seguro: sin controles ni marcas de dirección, espacios juntos y como mucho 60 caracteres', () => {
  assert.equal(DETAIL_MAX, 60);
  const long = toolCard('tv_present', { kind: 'reminder', data: { title: 'x'.repeat(500) } }).detail;
  assert.equal(long.length, 60);
  assert.ok(long.endsWith('…'));
  assert.equal(clip('a\u0000b\n\tc‮d  e'), 'a b c d e');
  assert.equal(toolCard('tv_open', { url: 'texto\u0007 raro\r\n' }).detail, 'texto raro');
  const host = toolCard('tv_open', { url: `https://${'a'.repeat(63)}.${'b'.repeat(63)}.example.com/x` }).detail;
  assert.equal([...host].length, DETAIL_MAX, 'un host largo también se recorta');
  const timer = toolCard('tv_activity', { op: 'set', title: 'x'.repeat(58), seconds: 600 }).detail;
  assert.equal([...timer].length, DETAIL_MAX);
  assert.ok(timer.endsWith('… · 10 min'), 'el título cede sitio a los minutos: ' + timer);
});

test('toolName: solo letras, cifras y _.:/- y como mucho 64', () => {
  assert.equal(toolName('tv-canvas__tv_open'), 'tv-canvas__tv_open');
  assert.equal(toolName('srv/tv_open'), 'srv/tv_open', '/ es separador de prefijo (SEP)');
  assert.equal(toolCard('srv/tv_open', { url: 'https://x.example' })?.detail, 'x.example');
  assert.equal(toolName('a b\n<c>"d"'), 'abcd');
  assert.equal(toolName('x'.repeat(200)).length, 64);
  assert.equal(toolName(undefined), '');
});
