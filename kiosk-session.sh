#!/bin/bash
# Sesión X que arranca xinit (jota-screen-kiosk.service): sin ahorro de pantalla, salida y modo de vídeo,
# gestor de ventanas mínimo y Chrome a pantalla completa con CDP solo en 127.0.0.1.
# Configuración: ~/.config/jota-screen/screen.env (o TV_CONFIG); ver config/screen.env.example.
set -u
APP_DIR=$(cd "$(dirname "$(readlink -f "$0")")" && pwd)
# shellcheck source=scripts/lib.sh
. "$APP_DIR/scripts/lib.sh"
jsc_load_config

xset s off -dpms 2>/dev/null
xset s noblank 2>/dev/null

# salida y modo: lo que diga la config; lo que no, se detecta. Si xrandr no ve nada, se sigue como esté.
out=${TV_DISPLAY_OUTPUT:-$(jsc_detect_output)}
mode=${TV_DISPLAY_MODE:-}
rate=${TV_DISPLAY_RATE:-}
if [ -z "$out" ]; then
  echo "xrandr no ve ninguna salida conectada: sigo con la resolución actual"
else
  if [ -z "$mode" ]; then
    read -r mode drate <<<"$(jsc_detect_mode "$out")"
    [ -n "$rate" ] || rate=${drate:-}
  fi
  args=(--output "$out")
  if [ -n "$mode" ]; then args+=(--mode "$mode"); else args+=(--auto); fi
  [ -n "$rate" ] && args+=(--rate "$rate")
  echo "pantalla: xrandr ${args[*]}"
  xrandr "${args[@]}" || echo "aviso: xrandr ${args[*]} ha fallado; sigo con la resolución actual"
fi

if command -v openbox >/dev/null 2>&1; then openbox & else echo "aviso: no está openbox; sigo sin gestor de ventanas"; fi

CHROME=$(jsc_find_chrome) || { echo "error: no encuentro Chrome/Chromium (TV_CHROME=${TV_CHROME:-})" >&2; exit 1; }

# perfil en la carpeta de estado; el de las instalaciones antiguas se mueve (nunca se sobrescribe)
jsc_ensure_state_dir
# shellcheck disable=SC2119 # sin argumentos: candidatos por defecto
jsc_migrate_chrome_profile

# home.html enseña la hora hasta que el servidor responde y entonces salta a la página de inicio.
# Se abre home.html y no TV_HOME_URL directamente porque al arrancar el servidor aún no escucha y Chrome
# se quedaría en su página de error.
start="file://$APP_DIR/home.html#port=$TV_PORT&name=$(jsc_urlencode "$TV_NAME")"
[ -n "${TV_HOME_URL:-}" ] && start+="&home=$(jsc_urlencode "$TV_HOME_URL")"

exec "$CHROME" \
  --kiosk --force-device-scale-factor="$TV_SCALE" \
  --user-data-dir="$TV_STATE_DIR/chrome-profile" \
  --remote-debugging-port="$TV_CDP_PORT" \
  --remote-debugging-address=127.0.0.1 \
  --no-first-run --no-default-browser-check \
  --noerrdialogs --disable-infobars \
  --password-store=basic \
  --autoplay-policy=no-user-gesture-required \
  "$start"
