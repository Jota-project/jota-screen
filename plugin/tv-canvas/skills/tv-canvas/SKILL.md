---
name: tv-canvas
description: Controlar la tele (Chrome en pantalla completa): abrir YouTube/Netflix/webs, controlar Spotify, play/pausa/volumen, mostrar tareas, recordatorios, presentaciones o páginas HTML animadas y avisos sobre lo que se está viendo. Usar cuando se pida poner algo en la tele, mostrar algo en pantalla, avisar o recordar en la tele. Y también lo que se ve en Netflix: qué series se están viendo, por dónde se va, qué se vio ayer o esta semana, y poner la última o seguir una serie por donde iba.
---

# Tele (tv-canvas)

La tele es un Chrome en modo kiosco en el servidor de jota-screen. Se maneja con las herramientas MCP `tv_*` (servidor `tv-canvas`). Los comandos que llegan por voz piden **respuestas de una frase**: actúa y confirma en pocas palabras ("Hecho, Netflix abierto"), sin explicar los pasos.

## Netflix
`tv_netflix` lo hace todo en una llamada (unos 2-3 s), sin capturas ni clics:
- «Pon Netflix» → `action: open`.
- «Ponme X» → `action: play` con `title`, directamente (no hagas `search` ni `open` antes: ya busca él). Busca, abre y retoma por donde se dejó. Si devuelve `candidates`, no había un título exacto: di qué se está poniendo y ofrece las otras (se ponen con `id`).
- «… en el perfil de Carmen» → añade `profile`. Sin él, usa el perfil por defecto. Para cambiar el de por defecto: `set_default_profile`. `profiles` lista los que hay.
- «¿Qué series estoy viendo?» → `action: watching` (lo que está a medias, con capítulo y lo que queda). «¿Por dónde voy de X?» → `watching` con `title: X` (solo esa, y su tarjeta).
- «¿Qué he visto esta semana?», «¿qué veo más?» → `action: history` (por días y lo más visto).
- «¿Qué es lo último que estaba viendo?» → `action: last`: solo contesta (y enseña su tarjeta en la tele). **Una pregunta nunca pone nada**: si quiere verla, que lo pida.
- «Ponme la de ayer», «sigue con lo último», «ponla» → `action: play_last` (la pone por donde iba).
- Consúltalo cada vez que pregunten, aunque ya lo hayas dicho antes: el dato cambia y, con la conversación en la tele, la consulta enseña la tarjeta con las imágenes. Si parece viejo (mira `at`), `action: refresh` y vuelve a preguntar. Es lo del perfil por defecto, también lo visto en el móvil.
- `watching`, `history` y `play_last` son personales del dueño: no los uses ni los cuentes cuando habla un invitado.
- Un capítulo concreto todavía no: pon la serie y, si hace falta, termina con `tv_links` / `tv_click_text`.
- En el reposo puede salir un «Seguir viendo» con Netflix y Spotify (YouTube más adelante): `tv_idle` `op: set` con `cfg: {suggest: {on: true}}`. Se ordenan las fuentes con `sources` y se elige el aspecto con `look`: `discreto` (una fila de series pequeñas, el de por defecto), `destacado` (una en grande) o `auto` (en grande si una serie manda). `netflix: "on"` sigue valiendo como atajo.
Si dice que Netflix pide iniciar sesión, no escribas contraseñas: díselo al usuario.

## YouTube
`tv_youtube` pone un vídeo en una llamada (unos 3-4 s), sin capturas ni clics:
- «Pon en YouTube X», «ponme un vídeo de X» → `action: play` con `query` tal como lo ha dicho (p. ej. `música lofi`), directamente: busca, elige el primer vídeo de verdad (ni anuncios ni Shorts), lo pone a pantalla completa y espera a que suene. No hagas `tv_open_app` ni `search` antes.
- Contesta con el `title` que devuelve («Hecho, suena …»). Si quiere otro, ofrece los de `candidates` y ponlo con `id`. Si viene `ad: true`, antes sale un anuncio: dilo y ya empieza solo.
- `action: search` solo da los resultados, sin poner nada.

## Otras webs de vídeo
1. `tv_open_app` con `app` y `query` (abre los resultados de búsqueda) o `tv_open` con la dirección.
2. `tv_screenshot` o `tv_links` (con filtro, p. ej. el título) para ver los resultados.
3. `tv_click_text` con el título (regex, sin distinguir mayúsculas) o `tv_click_at` con las coordenadas de `tv_links`.
4. Comprueba con `tv_state` (`media: 1` = se está reproduciendo). Si no, repite desde 2 o usa `tv_key` con `Enter`.
Los fotogramas de vídeo con DRM salen negros en las capturas; es normal. Si la sesión está cerrada o pide contraseña, no la escribas: dilo al usuario.

## Controles
- `tv_media`: `playpause`, o `seek` con segundos (negativo = atrás). `tv_volume`: `up`/`down` (con `steps`), `mute`, `set` (0-100). `tv_nav`: `back`, `forward`, `reload`, `home`, `fullscreen`. `tv_key`, `tv_type`, para teclas y texto.

## Spotify
`tv_spotify`: el servidor es un dispositivo Spotify Connect (con el nombre de la pantalla, cuenta Premium del usuario) y suena por la tele. Para «ponme X» usa `search_play` con `query` y `type` (`track` por defecto; `artist` para «algo de X»; `playlist` para estados de ánimo o géneros). Otras acciones: `status`, `play`, `pause`, `playpause`, `next`, `prev`, `volume` (0-100), `search` (candidatos con URI) y `uri` (enlace o URI). Para enseñar la interfaz de Spotify en la tele (explorar, ver qué suena) usa `tv_open_app` con `app: spotify`; el sonido sale por ese altavoz. Si `status` dice que no está configurado o conectado, díselo al usuario en una frase. No mezcles Spotify con un vídeo en marcha: pausa el vídeo antes (`tv_media`).

## Mostrar contenido propio
- `tv_toast`: aviso corto arriba a la derecha sobre lo que se vea (también a pantalla completa). Ideal para recordatorios mientras se ve algo.
- `tv_present` con plantillas animadas:
  - `tasks`: `{title, subtitle?, items:[{id,text,done?,tag?,due?}]}`; los ítems se pueden marcar en la tele.
  - `reminder`: `{title, text?, time?, icon?}`; usa `seconds` para que se cierre solo.
  - `slides`: `{title?, autoplay?, slides:[{kicker?,title?,subtitle?,bullets?,big?,image?,html?}]}`.
- `tv_update` cambia los datos en vivo (sin recargar, con animación): marcar una tarea, cambiar de diapositiva con `{index}`.
- `tv_show_html`: tu propia página a pantalla completa (≈1280×720 px, fondo oscuro, letra grande, legible desde el sofá). Disponible `tv.onData(fn)`, `tv.emit(nombre, obj)`, `tv.close()`. Solo recursos https; no puede llamar a otros servicios.
- `tv_events` lee lo que ocurre en la tele (tareas marcadas, diapositivas). `tv_close` vuelve a lo anterior.

## Reposo y Live Activities
- La tele vuelve sola a la **pantalla en reposo** (fondo animado según la hora o los colores de la canción, reloj, el tiempo si hay una ubicación configurada, «ahora suena») tras unos minutos sin uso. `tv_nav home` o `tv_idle op:show` la abren; `tv_idle op:get|set` lee o cambia sus ajustes (modo, ubicación del tiempo `city`/`lat`/`lon`/`tz`, horario de sueño fijo o por día, minutos sin uso, atenuado nocturno, `layout` margen|zonas|apilada|rotar, `rearrangeMin` y `calm` para menos movimiento). Las Live Activities también salen dentro del reposo, junto a la fecha y el tiempo.
- `tv_activity`: píldora en vivo arriba en el centro, por encima de todo (reposo, webs, vídeo a pantalla completa). Para cosas que duran: temporizadores (`seconds`), cronómetros (`elapsed`), progreso (`progress` 0-1), marcadores o estados (`value`). Usa un `id` estable para actualizarla (`quiet` para no expandirla) y `op:end` cuando acabe. Título de 2-4 palabras, un emoji en `icon` y un color en `accent`.

## Acceso de administrador
- `tv_admin_link` crea un enlace (y un código tecleable) de un solo uso que caduca en 10 minutos. Con él, un móvil pasa a administrador con su propio token, sin ver el token maestro. Dáselo solo al dueño, nunca a invitados. En el servidor hace lo mismo `node remote/admin-link.js`.

## Criterio
- Al terminar un recordatorio o una presentación, cierra con `tv_close` si ya no hace falta.
- No interrumpas un vídeo en marcha con pantallas completas salvo que lo pidan: usa `tv_toast`.
- Volumen por encima del 70 % solo si lo piden.
