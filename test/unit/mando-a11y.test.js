'use strict';
// K5 (accesible y nativo en el móvil), lo que se comprueba sin navegador: zoom permitido, contraste AA del tema claro,
// nombres accesibles de los campos, la barra de Spotify como slider, y la PWA (iconos maskable y página sin conexión).
// Lo que necesita un navegador (foco de las hojas, inert) va en e2e/mando-capturas.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PUB = path.join(__dirname, '..', '..', 'remote', 'public');
const read = f => fs.readFileSync(path.join(PUB, f), 'utf8');
const html = read('index.html');

// contraste WCAG 2.1 entre dos colores #rrggbb
const lum = h => {
  const c = [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255).map(x => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

test('se puede hacer zoom: el viewport no lo bloquea', () => {
  const vp = html.match(/<meta name="viewport" content="([^"]+)">/)[1];
  assert.doesNotMatch(vp, /user-scalable\s*=\s*no|maximum-scale\s*=\s*1\b/);
});

test('tema claro: estado, aviso, error y textos a AA (4,5:1) sobre el fondo, las superficies y la superficie 2', () => {
  const css = read('shared/tokens-mando.css');
  const block = css.match(/:root\[data-theme=claro\]\{([\s\S]*?)\}/)[1];
  const tok = n => {
    const h = block.match(new RegExp(`--${n}:#([0-9a-f]{6}|[0-9a-f]{3})\\b`, 'i'))[1];
    return '#' + (h.length === 3 ? [...h].map(c => c + c).join('') : h);
  };
  for (const fg of ['status', 'warn', 'bad', 'text-soft', 'text-faint', 'accent-text']) {
    for (const bg of ['bg', 'surface', 'surface-2']) {
      const r = ratio(tok(fg), tok(bg));
      assert.ok(r >= 4.5, `--${fg} sobre --${bg}: ${r.toFixed(2)}:1`);
    }
  }
});

test('todos los campos tienen nombre accesible (no solo el placeholder)', () => {
  const labelled = new Set([...html.matchAll(/<label\b[^>]*\sfor="([\w-]+)"/g)].map(m => m[1]));
  for (const m of html.matchAll(/<(input|select|textarea)\b([^>]*)>/g)) {
    const a = m[2], id = (a.match(/\sid="([\w-]+)"/) || [])[1];
    if (/\stype="hidden"/.test(a)) continue;
    const ok = /\saria-label(ledby)?="[^"]+"/.test(a) || (id && labelled.has(id));
    assert.ok(ok, `${m[1]}#${id} sin nombre accesible`);
  }
});

test('la barra de Spotify es un slider que se alcanza con el teclado', () => {
  const trk = html.match(/<div class="spTrk"[^>]*>/)[0];
  assert.match(trk, /role="slider"/);
  assert.match(trk, /tabindex="0"/);
  assert.match(trk, /aria-label="[^"]+"/);
  assert.match(read('mando/features/spotify.js'), /aria-valuetext/);
});

test('PWA: iconos de 192 y 512, también maskable, y cada uno existe con su tamaño', () => {
  const man = JSON.parse(read('manifest.webmanifest'));
  for (const [size, purpose] of [['192x192', 'any'], ['512x512', 'any'], ['192x192', 'maskable'], ['512x512', 'maskable']]) {
    const i = man.icons.find(x => x.sizes === size && (x.purpose || 'any').split(' ').includes(purpose));
    assert.ok(i, `falta el icono ${size} ${purpose}`);
    const buf = fs.readFileSync(path.join(PUB, i.src));
    assert.equal(`${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)}`, size, i.src);  // ancho y alto del PNG (IHDR)
  }
});

test('PWA: el service worker solo sirve la página sin conexión y lo que ella usa, y todo eso existe', () => {
  const sw = read('sw.js');
  const keep = JSON.parse(sw.match(/const KEEP = (\[[\s\S]*?\]);/)[1].replace(/'/g, '"').replace(/OFFLINE/, '"/offline.html"'));
  for (const p of keep) assert.ok(fs.existsSync(path.join(PUB, p)), p);
  assert.match(sw, /r\.mode === 'navigate'/);
  assert.doesNotMatch(sw, /\/api\b|cache\.put|\.put\(/, 'no guarda respuestas de la red (ni la API ni el mando)');
  const off = read('offline.html');
  for (const m of off.matchAll(/(?:href|src)="(\/[^"]+)"/g)) if (m[1] !== '/') assert.ok(keep.includes(m[1]), `offline.html usa ${m[1]} y sw.js no lo guarda`);
  assert.doesNotMatch(off, /<style\b|\sstyle=|<script>/, 'sin estilos ni scripts en línea');
  assert.match(read('mando/app.js'), /serviceWorker\.register\('\/sw\.js'\)/);
});
