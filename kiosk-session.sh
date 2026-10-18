#!/bin/bash
# Sesión X que arranca xinit: sin ahorro de pantalla, gestor mínimo y Chrome a pantalla completa.
xset s off -dpms
xset s noblank
xrandr --output HDMI-0 --mode 1920x1080 --rate 60
openbox &
exec google-chrome \
  --kiosk --force-device-scale-factor=1.5 \
  --user-data-dir="$HOME/tv/chrome-profile" \
  --remote-debugging-port=9222 \
  --remote-debugging-address=127.0.0.1 \
  --no-first-run --no-default-browser-check \
  --noerrdialogs --disable-infobars \
  --password-store=basic \
  --autoplay-policy=no-user-gesture-required \
  "file://$HOME/tv/home.html"
