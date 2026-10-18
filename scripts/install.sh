#!/bin/bash
# Instala/actualiza las unidades de usuario desde el repo y reinicia el mando.
set -e
cd "$(dirname "$0")/.."
mkdir -p ~/.config/systemd/user
cp systemd/user/*.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now tv-remote tv-mdns
echo "ok (spotifyd y tv-kiosk: ver systemd/README)"
