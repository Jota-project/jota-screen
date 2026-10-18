`user/`: `tv-remote`, `tv-mdns`, `spotifyd` (usuario, `scripts/install.sh`).
`system/tv-kiosk.service`: kiosco (Xorg+Chrome); requiere `sudo cp … /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl restart tv-kiosk`.
`spotifyd.conf` de ejemplo en `spotifyd.conf.example` (`~/.config/spotifyd/`).
