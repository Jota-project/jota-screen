// ESLint 9 (flat config). Uso: npm ci && npm run lint (o npx eslint .) desde la raíz.
// Reglas: las recomendadas de @eslint/js, sin imponer estilo; cada ajuste va explicado en su sitio.
// Tipos de código: Node CommonJS (por defecto), navegador en remote/public (scripts clásicos y, en mando/, módulos ES)
// y funciones de página dentro de ficheros de Node (se serializan y se ejecutan en la página).
'use strict';
const js = require('@eslint/js');
const globals = require('globals');

// Globales de navegador que usan las funciones que se serializan y se ejecutan en una página (la de la tele por CDP, o la
// del navegador de las capturas con Playwright) desde ficheros de Node. Lista corta a propósito: abrir todo
// globals.browser en código de Node escondería errores reales (name, status, close… son globales en el navegador).
const PAGE_GLOBALS = Object.fromEntries([
  'window', 'document', 'location', 'getComputedStyle', 'requestAnimationFrame', 'addEventListener', 'innerWidth',
  'innerHeight', 'MutationObserver',
].map(g => [g, 'readonly']));

// Ficheros de Node con funciones de página (si otro fichero empieza a tenerlas, añádelo aquí)
const PAGE_FUNCTION_FILES = [
  'remote/src/features/{control,keyboard,spotify,stage}.js',
  'remote/src/tv/{devices,talk-view}.js',
  'e2e/mando-capturas.js',
  'e2e/reposo-solapes.js',
];

module.exports = [
  {
    ignores: [
      '**/node_modules/',
      'e2e/capturas/', 'e2e/capturas-mando/', // salida de las capturas (e2e/*-capturas.js)
      'tmp/', 'stage/', 'backup/', 'chrome-profile/', 'spotify/', // estado local (ver .gitignore)
      '.claude/',
    ],
  },
  js.configs.recommended,
  {
    // Ajustes a las recomendadas, para todo el código
    files: ['**/*.js'],
    rules: {
      // argumentos sin usar en manejadores (req, res, next…) y catch (e) {} son habituales y no son errores
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
      // catch {} vacío es el patrón de «mejor esfuerzo» del código (JSON roto, CDP caído…); otros bloques vacíos sí cuentan
      'no-empty': ['error', { allowEmptyCatch: true }],
      // un /* global … */ que documenta lo que usa una función de página no es un error aunque Node ya lo tenga
      // (localStorage es global en Node 22+)
      'no-redeclare': ['error', { builtinGlobals: false }],
      // espacios literales en una expresión regular (sangría de JSON en las pruebas) se leen mejor que « {2}»
      'no-regex-spaces': 'off',
    },
  },
  {
    // Node CommonJS: servidor, MCP, plugin, scripts, pruebas, capturas y cdp-*.js
    files: ['**/*.js'],
    ignores: ['remote/public/**'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'commonjs', globals: { ...globals.node } },
  },
  {
    files: PAGE_FUNCTION_FILES,
    languageOptions: { globals: PAGE_GLOBALS },
  },
  {
    // Navegador, scripts clásicos: reposo (idle-app.js), escenario e isla de la tele, y mando/theme.js (minificado, se
    // carga antes de pintar)
    files: ['remote/public/**/*.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'script', globals: { ...globals.browser } },
  },
  {
    // Mando del móvil: módulos ES de navegador (sin build)
    files: ['remote/public/mando/**/*.js'],
    ignores: ['remote/public/mando/theme.js'],
    languageOptions: { sourceType: 'module' },
  },
  {
    // tv-island.js lee los colores que src/tv/tokens.js pone delante al inyectarla en la página
    files: ['remote/public/tv-island.js'],
    languageOptions: { globals: { __TV_TOKENS: 'readonly' } },
  },
];
