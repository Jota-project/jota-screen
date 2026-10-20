# Unidades de systemd (plantillas)

No se copian a mano: `scripts/install.sh` rellena los marcadores y las instala. Marcadores: `@USER@` (usuario),
`@HOME@`, `@APP_DIR@` (carpeta del repo), `@CONFIG@` (ruta de `screen.env`), `@NODE@` (ruta de node) y
`@NODE_DIR@` (su carpeta, para el `PATH` del servicio).

| Plantilla | Tipo | Qué hace |
|---|---|---|
| `user/jota-screen.service` | usuario | servidor del mando (`node server.js` en `remote/`), con `EnvironmentFile=-@CONFIG@` |
| `user/jota-screen-mdns.service` | usuario | alias mDNS del mando (`mdns-alias.sh`; `TV_MDNS_NAME` vacío = nada) |
| `user/jota-screen-spotify.service` | usuario | altavoz Spotify Connect (`scripts/spotifyd-run.sh`); solo se habilita si hay spotifyd |
| `system/jota-screen-kiosk.service` | sistema | Xorg en tty1 con `kiosk-session.sh` (Chrome a pantalla completa) como `@USER@` |
| `spotifyd.conf.example` | — | config de spotifyd que el instalador deja en `~/.config/jota-screen/spotifyd.conf` si no tienes `~/.config/spotifyd/spotifyd.conf` |

- Las de usuario van a `~/.config/systemd/user/` y el instalador las habilita y arranca (y activa *linger*).
- La del kiosco se genera en `~/.config/jota-screen/generated/jota-screen-kiosk.service`; el instalador enseña
  los comandos `sudo` para instalarla en `/etc/systemd/system/` (o lo hace con `--system` si hay sudo sin contraseña).
- Nombres antiguos (`tv-remote`, `tv-mdns`, `spotifyd` de usuario y `tv-kiosk` de sistema): el instalador detiene y
  deshabilita las de usuario y enseña cómo deshabilitar `tv-kiosk`. Sus ficheros quedan para poder volver atrás.

Registro: `journalctl --user -u jota-screen -f`, `journalctl -u jota-screen-kiosk -f`.
Salud: `scripts/doctor.sh`.
