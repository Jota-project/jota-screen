// Estado del panel de Spotify, compartido por el reproductor (spotify.js) y las listas (spotify-lists.js).
/**
 * now: lo que suena (empujado por el servidor); recv: cuándo llegó (para avanzar el progreso); tab: pestaña de la lista
 * (queue, playlists, recent); detail: playlist abierta {uri, head, items, next, loading}; cache: listas cargadas por
 * pestaña; drag: fracción mientras se arrastra el progreso; volT: temporizador del volumen (mientras, no se pisa).
 */
export const sp = { now: null, recv: 0, tab: 'queue', detail: null, cache: {}, drag: null, volT: 0 };
export const mmss = ms => { const t = Math.max(0, Math.floor((ms || 0) / 1000)); return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0'); };
