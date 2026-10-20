// Mando de la pantalla (remote/public/index.html): arranque. Cada parte vive en su módulo y exporta un descriptor
// { name, msgs, sheets, clicks, acts, init }; aquí se registra todo (error si un mensaje, hoja o acción se repite) y se
// llama a los init() en el mismo orden que tenía el script único, para no cambiar el orden de los listeners del documento
// ni la fase de los intervalos. Ningún otro módulo hace nada al cargarse.
//   core/  dom, store (estado y ajustes), api (conexión), perms        ← no importa nada de fuera de core/
//   ui/    haptics, pill, theme, status, sheets, actions, gestures     ← solo core/
//   features/                                                          ← ui/ y core/, y entre sí solo en un sentido:
//     settings → admin → pair, settings → idle, settings → ambient, controls → ambient, spotify → ambient,
//     spotify → spotify-lists → spotify-state, agent → voice
import { initSession } from './core/store.js';
import { connect, handle, start } from './core/api.js';
import { applyMe } from './core/perms.js';
import { status } from './ui/status.js';
import { sheets, registerSheet } from './ui/sheets.js';
import { actions, registerAct, registerClick } from './ui/actions.js';
import { gestures } from './ui/gestures.js';
import { ambient } from './features/ambient.js';
import { controls } from './features/controls.js';
import { trackpad } from './features/trackpad.js';
import { keyboard } from './features/keyboard.js';
import { go } from './features/go.js';
import { agent } from './features/agent.js';
import { spotify } from './features/spotify.js';
import { pair, settle } from './features/pair.js';
import { admin } from './features/admin.js';
import { settings } from './features/settings.js';
import { idle } from './features/idle.js';

function register(list) {
  for (const f of list) {
    for (const [t, fn] of Object.entries(f.msgs || {})) handle(t, fn);
    for (const [id, h] of Object.entries(f.sheets || {})) registerSheet(id, h);
    for (const [a, fn] of Object.entries(f.clicks || {})) registerClick(a, fn);
    for (const [a, fn] of Object.entries(f.acts || {})) registerAct(a, fn);
  }
}

initSession();                                          // token de ?t= o guardado, código de #admin= y ajustes
register([controls, trackpad, keyboard, go, agent, spotify, pair, admin, settings, idle]);
handle('me', applyMe);
// orden del script único: ambiente (v3), accesos, conexión (eco cada 2 s y visibilitychange), cabecera, trackpad, gestos,
// botones, hojas, teclado, dirección, agente, Spotify, emparejar, administración, ajustes y reposo
ambient.init();
controls.init();
start();
for (const p of [status, trackpad, gestures, actions, sheets, keyboard, go, agent, spotify, pair, admin, settings, idle]) p.init();

settle().finally(connect);
