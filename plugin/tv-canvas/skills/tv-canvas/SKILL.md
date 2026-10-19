---
name: tv-canvas
description: Controlar la tele del salón (Chrome en pantalla completa): abrir YouTube/Netflix/webs, controlar Spotify, play/pausa/volumen, mostrar tareas, recordatorios, presentaciones o páginas HTML animadas y avisos sobre lo que se está viendo. Usar cuando se pida poner algo en la tele, mostrar algo en pantalla, avisar o recordar en la tele.
---

# Tele del salón (tv-canvas)

La tele es un Chrome en modo kiosco en el servidor green-house. Se maneja con las herramientas MCP `tv_*` (servidor `tv-canvas`). Los comandos que llegan por voz piden **respuestas de una frase**: actúa y confirma en pocas palabras ("Hecho, Netflix abierto"), sin explicar los pasos.

## Cómo reproducir algo (YouTube / Netflix)
1. `tv_open_app` con `app` y `query` (abre los resultados de búsqueda).
2. `tv_screenshot` o `tv_links` (con filtro, p. ej. el título) para ver los resultados.
3. `tv_click_text` con el título (regex, sin distinguir mayúsculas) o `tv_click_at` con las coordenadas de `tv_links`.
4. En Netflix puede pedir perfil: `tv_click_text` con el nombre del perfil. En la ficha, `tv_click_text` con `Reproducir|Play|Continuar`.
5. Comprueba con `tv_state` (`media: 1` = se está reproduciendo). Si no, repite desde 2 o usa `tv_key` con `Enter`.
Los fotogramas de vídeo con DRM salen negros en las capturas; es normal. Si la sesión está cerrada o pide contraseña, no la escribas: dilo al usuario.

## Controles
- `tv_media`: `playpause`, o `seek` con segundos (negativo = atrás). `tv_volume`: `up`/`down` (con `steps`), `mute`, `set` (0-100). `tv_nav`: `back`, `forward`, `reload`, `home`, `fullscreen`. `tv_key`, `tv_type`, para teclas y texto.

## Spotify
`tv_spotify`: el servidor es un dispositivo Spotify Connect («Salón», cuenta Premium del usuario) y suena por la tele. Para «ponme X» usa `search_play` con `query` y `type` (`track` por defecto; `artist` para «algo de X»; `playlist` para estados de ánimo o géneros). Otras acciones: `status`, `play`, `pause`, `playpause`, `next`, `prev`, `volume` (0-100), `search` (candidatos con URI) y `uri` (enlace o URI). Para enseñar la interfaz de Spotify en la tele (explorar, ver qué suena) usa `tv_open_app` con `app: spotify`; el sonido sale por «Salón». Si `status` dice que no está configurado o conectado, díselo al usuario en una frase. No mezcles Spotify con un vídeo en marcha: pausa el vídeo antes (`tv_media`).

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
- La tele vuelve sola a la **pantalla en reposo** (fondo animado según la hora o los colores de la canción, reloj, tiempo de Elche, «ahora suena») tras unos minutos sin uso. `tv_nav home` o `tv_idle op:show` la abren; `tv_idle op:get|set` lee o cambia sus ajustes (modo, horario de sueño fijo o por día, minutos sin uso, atenuado nocturno).
- `tv_activity`: píldora en vivo arriba en el centro, por encima de todo (reposo, webs, vídeo a pantalla completa). Para cosas que duran: temporizadores (`seconds`), cronómetros (`elapsed`), progreso (`progress` 0-1), marcadores o estados (`value`). Usa un `id` estable para actualizarla (`quiet` para no expandirla) y `op:end` cuando acabe. Título de 2-4 palabras, un emoji en `icon` y un color en `accent`.

## Acceso de administrador
- `tv_admin_link` crea un enlace (y un código tecleable) de un solo uso que caduca en 10 minutos. Con él, un móvil pasa a administrador con su propio token, sin ver el token maestro. Dáselo solo a Sito, nunca a invitados. En el servidor hace lo mismo `node remote/admin-link.js`.

## Criterio
- Al terminar un recordatorio o una presentación, cierra con `tv_close` si ya no hace falta.
- No interrumpas un vídeo en marcha con pantallas completas salvo que lo pidan: usa `tv_toast`.
- Volumen por encima del 70 % solo si lo piden.
