#!/bin/bash
# Funciones comunes de los scripts de jota-screen (kiosco, alias mDNS, instalador, doctor, actualizar).
# Se carga con «. scripts/lib.sh»; no ejecuta nada al cargarse salvo fijar JSC_APP_DIR.
# Las funciones de detección leen la salida de la orden por la entrada estándar para poder probarlas
# con textos de ejemplo (test/unit/scripts.test.js).

# Carpeta del repo (la que contiene scripts/).
JSC_APP_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

# Ruta del fichero de configuración (contrato: TV_CONFIG o ~/.config/jota-screen/screen.env).
jsc_config_path() {
  printf '%s\n' "${TV_CONFIG:-$HOME/.config/jota-screen/screen.env}"
}

# Carga la configuración (si existe) y rellena los valores por defecto del contrato.
# Lo que ya venga en el entorno y no esté en el fichero se respeta.
jsc_load_config() {
  local cfg
  cfg=$(jsc_config_path)
  if [ -r "$cfg" ]; then
    set -a
    # shellcheck disable=SC1090
    . "$cfg"
    set +a
  fi
  : "${TV_NAME:=Pantalla}"
  : "${TV_PORT:=8787}"
  : "${TV_CDP_PORT:=9222}"
  : "${TV_STATE_DIR:=$HOME/.local/state/jota-screen}"
  : "${TV_SCALE:=1.5}"
  : "${TV_SPOTIFY_DEVICE:=$TV_NAME}"
  : "${DISPLAY:=:0}"
  # vacío explícito = no publicar alias; sin definir = mando.local
  TV_MDNS_NAME=${TV_MDNS_NAME-mando.local}
  export TV_NAME TV_PORT TV_CDP_PORT TV_STATE_DIR TV_SCALE TV_SPOTIFY_DEVICE TV_MDNS_NAME DISPLAY
}

# Navegador del kiosco: TV_CHROME o el primero que exista.
jsc_find_chrome() {
  local c
  if [ -n "${TV_CHROME:-}" ]; then
    command -v "$TV_CHROME" 2>/dev/null || return 1
    return 0
  fi
  for c in google-chrome google-chrome-stable chromium chromium-browser; do
    if command -v "$c" >/dev/null 2>&1; then command -v "$c"; return 0; fi
  done
  return 1
}

# Salida conectada a partir de «xrandr --query» (stdin): la primaria si está conectada; si no, la primera.
jsc_parse_xrandr_output() {
  awk '$2 == "connected" { if ($3 == "primary") { print $1; found = 1; exit } if (!first) first = $1 }
       END { if (!found && first) print first }'
}

# Modo preferido y su frecuencia («1920x1080 60.00») de la salida $1, a partir de «xrandr --query» (stdin).
# Preferido = el que lleva «+»; si ninguno lo lleva, el actual («*»); si tampoco, el primero.
jsc_parse_xrandr_mode() {
  awk -v out="$1" '
    /^[^ \t]/ { inside = ($1 == out); next }
    inside && $1 ~ /^[0-9]+x[0-9]+/ {
      if (!firstm) { firstm = $1; firstr = $2; sub(/[*+]+$/, "", firstr) }
      # cada frecuencia va seguida de «*» (actual) y «+» (preferida); el «+» puede ir separado («30.00 +»)
      lr = ""
      for (i = 2; i <= NF; i++) {
        num = $i; sub(/[*+]+$/, "", num); fl = substr($i, length(num) + 1)
        if (num == "") num = lr; else lr = num
        if (fl ~ /\+/ && !pm) { pm = $1; pr = num }
        if (fl ~ /\*/ && !cm) { cm = $1; cr = num }
      }
    }
    END {
      if (pm) print pm, pr; else if (cm) print cm, cr; else if (firstm) print firstm, firstr
    }'
}

# Interfaz de la ruta por defecto a partir de «ip route show default» (stdin); la de menor métrica.
jsc_parse_default_iface() {
  awk '$1 == "default" {
         dev = ""; metric = 0
         for (i = 2; i < NF; i++) { if ($i == "dev") dev = $(i + 1); if ($i == "metric") metric = $(i + 1) + 0 }
         if (dev != "" && (best == "" || metric < bm)) { best = dev; bm = metric }
       }
       END { if (best != "") print best }'
}

# Lo mismo con las órdenes reales.
jsc_detect_output() { xrandr --query 2>/dev/null | jsc_parse_xrandr_output; }
jsc_detect_mode() { xrandr --query 2>/dev/null | jsc_parse_xrandr_mode "$1"; }
jsc_detect_iface() { ip route show default 2>/dev/null | jsc_parse_default_iface; }

# Node: la ruta absoluta del que haya en el PATH (o en los sitios habituales).
jsc_find_node() {
  local n
  for n in "$(command -v node 2>/dev/null)" /usr/local/bin/node /usr/bin/node; do
    if [ -n "$n" ] && [ -x "$n" ]; then printf '%s\n' "$n"; return 0; fi
  done
  return 1
}

# Versión principal de node ($1 = ruta). «22» para v22.x.
jsc_node_major() {
  "$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null
}

# Codifica $1 para usarlo en una URL (componente de query o fragmento).
jsc_urlencode() {
  local s=$1 out='' c i
  local LC_ALL=C
  for ((i = 0; i < ${#s}; i++)); do
    c=${s:i:1}
    case $c in
      [a-zA-Z0-9.~_-]) out+=$c ;;
      *) out+=$(printf '%%%02X' "'$c") ;;
    esac
  done
  printf '%s\n' "$out"
}

# Crea la carpeta de estado con 0700 si no existe (y la deja en 0700 si ya existe).
jsc_ensure_state_dir() {
  mkdir -p "$TV_STATE_DIR"
  chmod 700 "$TV_STATE_DIR"
}

# Mueve el perfil de Chrome antiguo a $TV_STATE_DIR/chrome-profile. Nunca sobrescribe: si el nuevo ya
# existe, no toca nada (y avisa de los antiguos que queden). Candidatos: los argumentos o, por defecto,
# ~/tv/chrome-profile y <repo>/chrome-profile.
jsc_migrate_chrome_profile() {
  local dest="$TV_STATE_DIR/chrome-profile" src
  local -a cands=("$@")
  [ ${#cands[@]} -gt 0 ] || cands=("$HOME/tv/chrome-profile" "$JSC_APP_DIR/chrome-profile")
  for src in "${cands[@]}"; do
    [ -d "$src" ] && [ ! -L "$src" ] || continue
    if [ -e "$dest" ] || [ -L "$dest" ]; then
      [ "$(readlink -f -- "$src")" = "$(readlink -f -- "$dest")" ] && continue
      echo "aviso: queda un perfil de Chrome antiguo en $src (no lo muevo: ya existe $dest)" >&2
      continue
    fi
    jsc_ensure_state_dir
    if mv -- "$src" "$dest"; then
      echo "perfil de Chrome movido: $src -> $dest"
    else
      echo "aviso: no he podido mover $src a $dest" >&2
    fi
  done
  return 0
}

# Sustituye los marcadores de las plantillas en el fichero $1 y escribe el resultado en stdout:
# los del contrato (@USER@, @HOME@, @APP_DIR@, @CONFIG@, @NODE@), @NODE_DIR@ (carpeta de node, para el PATH
# del servicio: OpenClaw usa «#!/usr/bin/env node») y los de nginx (@MDNS_NAME@, @PORT@).
# Variables: JSC_USER (por defecto, el usuario actual) y JSC_NODE (ruta de node).
jsc_render() {
  local t
  t=$(<"$1")
  t=${t//@USER@/"${JSC_USER:-$(id -un)}"}
  t=${t//@HOME@/"$HOME"}
  t=${t//@APP_DIR@/"$JSC_APP_DIR"}
  t=${t//@CONFIG@/"$(jsc_config_path)"}
  t=${t//@NODE@/"${JSC_NODE:-/usr/bin/node}"}
  t=${t//@NODE_DIR@/"$(dirname "${JSC_NODE:-/usr/bin/node}")"}
  t=${t//@MDNS_NAME@/"${TV_MDNS_NAME:-mando.local}"}
  t=${t//@PORT@/"${TV_PORT:-8787}"}
  printf '%s\n' "$t"
}
