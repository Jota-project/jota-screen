#!/bin/bash
# Arranca spotifyd para jota-screen-spotify.service con la config y el nombre del altavoz de jota-screen.
# Config: ~/.config/spotifyd/spotifyd.conf si existe; si no, ~/.config/jota-screen/spotifyd.conf (la genera
# scripts/install.sh). Nombre: TV_SPOTIFY_DEVICE (por defecto TV_NAME); binario: TV_SPOTIFYD o el del PATH.
set -euo pipefail
# shellcheck source=scripts/lib.sh
. "$(dirname "$(readlink -f "$0")")/lib.sh"
jsc_load_config

bin=${TV_SPOTIFYD:-$(command -v spotifyd || true)}
if [ -z "$bin" ] || [ ! -x "$bin" ]; then
  echo "no encuentro spotifyd (TV_SPOTIFYD=${TV_SPOTIFYD:-}; tampoco está en el PATH)" >&2
  exit 1
fi
args=(--no-daemon --device-name "$TV_SPOTIFY_DEVICE")
for conf in "$HOME/.config/spotifyd/spotifyd.conf" "$(dirname "$(jsc_config_path)")/spotifyd.conf"; do
  if [ -r "$conf" ]; then args+=(--config-path "$conf"); break; fi
done
echo "spotifyd: altavoz «${TV_SPOTIFY_DEVICE}»"
exec "$bin" "${args[@]}"
