'use strict';
// @ts-check
// Lo que el servidor y la capa del agente (public/tv-agent.js) tienen que decir igual: los valores que admite la foto
// (`Snap`, ver docs/arquitectura.md) y los nombres de las fuentes propias de la capa. La página no puede hacer require():
// lleva su propia copia y test/unit/tv-agent-static.test.js comprueba que coincide con esta.

const FORMS = Object.freeze(['pill', 'panel']);
const STATES = Object.freeze(['listen', 'think', 'talk', 'error', 'done']);
const CTXS = Object.freeze(['idle', 'music', 'web', 'video']);
const GLASS = Object.freeze(['auto', 'A', 'B', 'C']);
// cómo entra la capa: `open` con su animación; `restore` tras una navegación (ya estaba abierta: en su caja, sin entrada)
const ENTERS = Object.freeze(['open', 'restore']);
const COLOR_RE = /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\))$/i;   // hex o rgb(): colores de la carátula
// familias con las que la capa registra sus fuentes (FontFace desde bytes, igual en cualquier web): nombres propios para no
// mezclarse con una «Fraunces» que ya tenga la página (el reposo la carga de Google Fonts)
const FONT_SERIF = 'TV Fraunces';
const FONT_SANS = 'TV Inter';
// binding de CDP (Runtime.addBinding) con el que la capa avisa de que el usuario la arrastró al otro formato; lleva solo
// 'pill' o 'panel'. Vive en el mundo de la página: la web también podría llamarlo (como mucho cambia el formato de la capa)
const FORM_BINDING = '__tvAgentForm';
// id del host de la capa en la página (tv-agent.js lo pone; talk-view.js lo salta al mirar si la página nueva ya se ve)
const HOST_ID = '__tvagent';

module.exports = { FORMS, STATES, CTXS, GLASS, ENTERS, COLOR_RE, FONT_SERIF, FONT_SANS, FORM_BINDING, HOST_ID };
