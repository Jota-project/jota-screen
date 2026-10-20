#!/bin/bash
# Instalador de jota-screen. Idempotente: se puede ejecutar las veces que haga falta.
# Ver «scripts/install.sh --help».
set -euo pipefail

usage() {
  cat <<'EOF'
Uso: scripts/install.sh [--dry-run] [--system] [--help]

Instala jota-screen para el usuario actual, desde la carpeta donde esté clonado el repo:
  1. comprueba las dependencias (no instala paquetes: dice cómo hacerlo en Debian/Ubuntu);
  2. crea ~/.config/jota-screen/screen.env desde config/screen.env.example si no existe (nunca la pisa);
  3. instala las dependencias del servidor (npm ci --omit=dev en remote/) si han cambiado;
  4. genera las unidades de usuario en ~/.config/systemd/user (jota-screen, jota-screen-mdns,
     jota-screen-spotify), detiene y deshabilita las antiguas (tv-remote, tv-mdns, spotifyd),
     y habilita y arranca las nuevas; activa «linger» para que arranquen sin iniciar sesión;
  5. genera la unidad de sistema del kiosco (jota-screen-kiosk.service) y enseña los comandos sudo
     para instalarla (o la instala con --system);
  6. si hay nginx, genera el proxy de http://<TV_MDNS_NAME> y enseña cómo instalarlo.

Opciones:
  --dry-run   enseña lo que haría sin cambiar nada
  --system    instala también la unidad del kiosco (necesita sudo sin contraseña; si no, enseña los comandos)
  -h, --help  esta ayuda

Variables: TV_CONFIG (ruta de la config; por defecto ~/.config/jota-screen/screen.env).
Después: scripts/doctor.sh comprueba que todo funciona.
EOF
}

DRY=0
SYSTEM=0
for a in "$@"; do
  case $a in
    --dry-run) DRY=1 ;;
    --system) SYSTEM=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "opción desconocida: $a (ver --help)" >&2; exit 2 ;;
  esac
done

# shellcheck source=scripts/lib.sh
. "$(dirname "$(readlink -f "$0")")/lib.sh"
APP=$JSC_APP_DIR
CFG=$(jsc_config_path)
CFG_DIR=$(dirname "$CFG")
GEN_DIR=$CFG_DIR/generated
UNIT_DIR=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user
JSC_USER=$(id -un)
export JSC_USER

step() { printf '\n== %s\n' "$*"; }
ok() { printf '  ✓ %s\n' "$*"; }
info() { printf '  · %s\n' "$*"; }
warn() { printf '  ! %s\n' "$*"; }
bad() { printf '  ✗ %s\n' "$*"; }
# ejecuta una orden (o la enseña en --dry-run)
run() {
  if [ $DRY = 1 ]; then printf '  [simulado] %s\n' "$*"; else "$@"; fi
}
# escribe stdin en $1 con permisos $2 si cambia; devuelve 0 si ha cambiado (o cambiaría) y 1 si ya estaba igual
put_file() {
  local dest=$1 mode=$2 tmp
  tmp=$(mktemp)
  cat >"$tmp"
  if [ -f "$dest" ] && cmp -s "$tmp" "$dest"; then rm -f "$tmp"; return 1; fi
  if [ $DRY = 1 ]; then
    if [ -f "$dest" ]; then
      printf '  [simulado] actualizaría %s:\n' "$dest"
      diff -u "$dest" "$tmp" | sed 's/^/      /' || true
    else
      printf '  [simulado] crearía %s\n' "$dest"
    fi
    rm -f "$tmp"
    return 0
  fi
  mkdir -p "$(dirname "$dest")"
  install -m "$mode" "$tmp" "$dest"
  rm -f "$tmp"
  return 0
}

[ $DRY = 1 ] && echo "MODO SIMULADO (--dry-run): no se cambia nada."
echo "jota-screen en $APP para el usuario $JSC_USER"

# ─────────────────────────────────────────────── configuración
step "Configuración"
if [ -f "$CFG" ]; then
  ok "ya existe $CFG (no la toco)"
else
  run mkdir -p "$CFG_DIR"
  run chmod 700 "$CFG_DIR"
  run install -m 600 "$APP/config/screen.env.example" "$CFG"
  [ $DRY = 1 ] || ok "creada $CFG desde config/screen.env.example (edítala si hace falta)"
fi
jsc_load_config
info "nombre «${TV_NAME}», puerto $TV_PORT, estado en $TV_STATE_DIR"

# ─────────────────────────────────────────────── dependencias
step "Dependencias"
missing=0
APT=()
hint=()
need() { # need <nivel: req|rec|opt> <descripción> <paquetes apt> <comprobación…>
  local lvl=$1 what=$2 pkgs=$3
  shift 3
  if "$@" >/dev/null 2>&1; then ok "$what"; return 0; fi
  case $lvl in
    req) bad "falta $what"; missing=$((missing + 1)) ;;
    rec) warn "falta $what (recomendado)" ;;
    opt) info "no está $what (opcional)" ;;
  esac
  [ -n "$pkgs" ] && APT+=("$pkgs")
  return 0
}
has() { command -v "$1"; }
JSC_NODE=$(jsc_find_node || true)
export JSC_NODE
node_ok() { [ -n "$JSC_NODE" ] && [ "$(jsc_node_major "$JSC_NODE")" -ge 22 ]; }
if node_ok; then ok "node $("$JSC_NODE" --version) ($JSC_NODE)"; else
  bad "falta node ≥ 22${JSC_NODE:+ (hay $("$JSC_NODE" --version 2>/dev/null) en $JSC_NODE)}"
  missing=$((missing + 1))
  hint+=("Node 22 o posterior: https://github.com/nodesource/distributions (paquete nodejs, trae npm) o https://nodejs.org")
fi
need req "npm" "" has npm
if CHROME=$(jsc_find_chrome); then ok "navegador $CHROME"; else
  bad "falta Chrome o Chromium${TV_CHROME:+ (TV_CHROME=$TV_CHROME no existe)}"
  missing=$((missing + 1))
  hint+=("Google Chrome (recomendado: trae Widevine para Netflix y similares): https://www.google.com/chrome/ — o «sudo apt install chromium»")
fi
need req "xinit y Xorg" "xinit xserver-xorg" has xinit
need req "xrandr y xset" "x11-xserver-utils" has xrandr
need rec "openbox (gestor de ventanas del kiosco)" "openbox" has openbox
need req "python3 (puntero del mando, remote/pointer.py)" "python3" has python3
need rec "libX11 y libXtst para el puntero (si no, TV_NO_POINTER=1)" "libx11-6 libxtst6" \
  python3 -c 'import ctypes; ctypes.CDLL("libX11.so.6"); ctypes.CDLL("libXtst.so.6")'
need opt "libXfixes (ocultar el cursor)" "libxfixes3" python3 -c 'import ctypes; ctypes.CDLL("libXfixes.so.3")'
need opt "avahi-publish (alias ${TV_MDNS_NAME:-mDNS})" "avahi-utils avahi-daemon" has avahi-publish
need opt "wpctl (volumen con PipeWire)" "wireplumber pipewire-pulse" has wpctl
SPOTIFYD=${TV_SPOTIFYD:-$(command -v spotifyd || true)}
if [ -n "$SPOTIFYD" ] && [ -x "$SPOTIFYD" ]; then ok "spotifyd ($SPOTIFYD)"; else
  SPOTIFYD=
  info "no está spotifyd (opcional: altavoz Spotify Connect; https://github.com/Spotifyd/spotifyd/releases, y TV_SPOTIFYD=<ruta> si no queda en el PATH)"
fi
if [ ${#APT[@]} -gt 0 ]; then
  printf '  Para instalar lo que falta en Debian/Ubuntu:\n    sudo apt install %s\n' "${APT[*]}"
fi
for h in "${hint[@]+"${hint[@]}"}"; do printf '  %s\n' "$h"; done
if [ $missing -gt 0 ]; then
  if [ $DRY = 1 ]; then warn "faltan $missing dependencias obligatorias: la instalación de verdad se pararía aquí"
  else bad "faltan $missing dependencias obligatorias: instálalas y vuelve a ejecutar el instalador"; exit 1; fi
fi

# ─────────────────────────────────────────────── estado
step "Carpeta de estado"
if [ -d "$TV_STATE_DIR" ]; then
  ok "$TV_STATE_DIR"
  [ "$(jsc_mode "$TV_STATE_DIR")" = 700 ] || run chmod 700 "$TV_STATE_DIR"
else
  run mkdir -p "$TV_STATE_DIR"
  run chmod 700 "$TV_STATE_DIR"
  [ $DRY = 1 ] || ok "creada $TV_STATE_DIR (0700); el servidor mueve aquí el estado antiguo al arrancar"
fi

# ─────────────────────────────────────────────── npm
step "Dependencias del servidor (remote/)"
NPM_CHANGED=0
lock_sum=$(jsc_sha256 "$APP/remote/package-lock.json")
stamp=$APP/remote/node_modules/.jota-screen-install
if [ -f "$stamp" ] && [ "$(cat "$stamp")" = "$lock_sum omit=dev" ]; then
  ok "al día (package-lock.json sin cambios)"
else
  if [ $DRY = 1 ]; then
    printf '  [simulado] cd %s && npm ci --omit=dev\n' "$APP/remote"
  else
    (cd "$APP/remote" && npm ci --omit=dev --no-audit --no-fund)
    mkdir -p "$(dirname "$stamp")"
    printf '%s omit=dev\n' "$lock_sum" >"$stamp"
    ok "npm ci --omit=dev hecho"
  fi
  NPM_CHANGED=1
fi

# ─────────────────────────────────────────────── unidades de usuario
step "Unidades de usuario ($UNIT_DIR)"
# unidades que han cambiado, separadas por espacios (sin arrays asociativos: bash 3.2 no los tiene)
CHANGED=" "
for u in jota-screen jota-screen-mdns jota-screen-spotify; do
  if jsc_render "$APP/systemd/user/$u.service" | put_file "$UNIT_DIR/$u.service" 644; then
    CHANGED+="$u "
    [ $DRY = 1 ] || ok "$u.service escrita"
  else
    ok "$u.service al día"
  fi
done
if [ -n "$SPOTIFYD" ] && [ ! -f "$HOME/.config/spotifyd/spotifyd.conf" ]; then
  if jsc_render "$APP/systemd/spotifyd.conf.example" | put_file "$CFG_DIR/spotifyd.conf" 600; then
    [ $DRY = 1 ] || ok "creada $CFG_DIR/spotifyd.conf"
    CHANGED+="jota-screen-spotify "
  fi
fi

# qué se habilita
WANT=(jota-screen)
if [ -n "$TV_MDNS_NAME" ]; then
  if command -v avahi-publish >/dev/null 2>&1; then WANT+=(jota-screen-mdns)
  else warn "TV_MDNS_NAME=$TV_MDNS_NAME pero no está avahi-publish: no habilito jota-screen-mdns"; fi
else
  info "TV_MDNS_NAME vacío: sin alias mDNS"
fi
[ -n "$SPOTIFYD" ] && WANT+=(jota-screen-spotify)

# ─────────────────────────────────────────────── servicios
step "Servicios de usuario"
if ! systemctl --user show-environment >/dev/null 2>&1; then
  warn "no hay systemd de usuario aquí (systemctl --user no responde): las unidades quedan generadas pero no las habilito."
  info "En la sesión del usuario: systemctl --user daemon-reload && systemctl --user enable --now ${WANT[*]}"
  for old in tv-remote tv-mdns spotifyd; do
    [ -f "$UNIT_DIR/$old.service" ] && warn "hay una unidad antigua $UNIT_DIR/$old.service: detenla y deshabilítala (systemctl --user disable --now $old)"
  done
else
  run systemctl --user daemon-reload
  old_unit() { [ -f "$UNIT_DIR/$1.service" ] || systemctl --user cat "$1.service" >/dev/null 2>&1; }
  # antiguas: se paran justo antes de arrancar las nuevas (el puerto es el mismo)
  for u in "${WANT[@]}"; do
    case $u in jota-screen) old=tv-remote ;; jota-screen-mdns) old=tv-mdns ;; jota-screen-spotify) old=spotifyd ;; esac
    if old_unit "$old"; then
      run systemctl --user disable --now "$old.service" || true
      warn "unidad antigua $old.service detenida y deshabilitada (su fichero queda; bórralo cuando todo vaya bien)"
    fi
    run systemctl --user enable "$u.service"
    if [[ $CHANGED == *" $u "* ]] || { [ "$u" = jota-screen ] && [ $NPM_CHANGED = 1 ]; } \
       || ! systemctl --user is-active --quiet "$u.service"; then
      run systemctl --user restart "$u.service"
      [ $DRY = 1 ] || ok "$u (re)arrancado"
    else
      ok "$u activo y al día"
    fi
  done
  if [ -z "$SPOTIFYD" ] && old_unit spotifyd; then
    warn "hay una unidad antigua spotifyd.service y no encuentro spotifyd: pon TV_SPOTIFYD=<ruta> en $CFG y repite"
  fi
  # linger: que los servicios de usuario arranquen con el equipo, sin iniciar sesión
  if [ "$(loginctl show-user "$JSC_USER" --property=Linger --value 2>/dev/null || true)" = yes ]; then
    ok "linger activo"
  elif [ $DRY = 1 ]; then
    printf '  [simulado] loginctl enable-linger %s\n' "$JSC_USER"
  elif loginctl enable-linger "$JSC_USER" 2>/dev/null; then
    ok "linger activado"
  else
    warn "no he podido activar linger sin permisos; ejecuta: sudo loginctl enable-linger $JSC_USER"
  fi
fi

# ─────────────────────────────────────────────── kiosco (unidad de sistema)
step "Kiosco (unidad de sistema)"
KIOSK_GEN=$GEN_DIR/jota-screen-kiosk.service
KIOSK_DEST=/etc/systemd/system/jota-screen-kiosk.service
jsc_render "$APP/systemd/system/jota-screen-kiosk.service" | put_file "$KIOSK_GEN" 644 || true
kiosk_cmds=()
if [ -f "$KIOSK_DEST" ] && jsc_render "$APP/systemd/system/jota-screen-kiosk.service" | cmp -s - "$KIOSK_DEST"; then
  ok "$KIOSK_DEST al día"
  systemctl is-enabled --quiet jota-screen-kiosk.service 2>/dev/null || kiosk_cmds+=("systemctl enable --now jota-screen-kiosk.service")
else
  kiosk_cmds+=("install -m 0644 $(printf %q "$KIOSK_GEN") $KIOSK_DEST" "systemctl daemon-reload")
  if [ -f /etc/systemd/system/tv-kiosk.service ] || systemctl cat tv-kiosk.service >/dev/null 2>&1; then
    kiosk_cmds+=("systemctl disable --now tv-kiosk.service")
  fi
  if [ -f "$KIOSK_DEST" ]; then kiosk_cmds+=("systemctl enable jota-screen-kiosk.service" "systemctl restart jota-screen-kiosk.service")
  else kiosk_cmds+=("systemctl enable --now jota-screen-kiosk.service"); fi
fi
if [ ${#kiosk_cmds[@]} -gt 0 ]; then
  if [ $SYSTEM = 1 ] && [ $DRY = 0 ] && sudo -n true 2>/dev/null; then
    for c in "${kiosk_cmds[@]}"; do
      echo "  sudo $c"
      sudo -n bash -c "$c"
    done
    ok "kiosco instalado"
  else
    [ $SYSTEM = 1 ] && [ $DRY = 0 ] && warn "--system necesita sudo sin contraseña; hazlo a mano:"
    info "La unidad del kiosco está en $KIOSK_GEN. Para instalarla (la pantalla se reinicia):"
    for c in "${kiosk_cmds[@]}"; do printf '    sudo %s\n' "$c"; done
  fi
fi

# ─────────────────────────────────────────────── nginx (opcional)
NGINX=$(command -v nginx || { [ -x /usr/sbin/nginx ] && echo /usr/sbin/nginx; } || true)
if [ -n "$NGINX" ] && [ -n "$TV_MDNS_NAME" ]; then
  step "nginx (http://$TV_MDNS_NAME sin puerto)"
  NG_GEN=$GEN_DIR/nginx-mando.conf
  NG_DEST=/etc/nginx/sites-available/jota-screen-mando.conf
  jsc_render "$APP/remote/nginx-mando.conf" | put_file "$NG_GEN" 644 || true
  if [ -f "$NG_DEST" ] && cmp -s "$NG_GEN" "$NG_DEST" 2>/dev/null; then
    ok "$NG_DEST al día"
  else
    info "Proxy generado en $NG_GEN. Para instalarlo (si ya tienes otro sitio con server_name $TV_MDNS_NAME, quítalo):"
    printf '    sudo install -m 0644 %q %s\n' "$NG_GEN" "$NG_DEST"
    printf '    sudo ln -sf %s /etc/nginx/sites-enabled/jota-screen-mando.conf\n' "$NG_DEST"
    printf '    sudo nginx -t && sudo systemctl reload nginx\n'
  fi
fi

step "Hecho"
[ $DRY = 1 ] && echo "  (simulado: no se ha cambiado nada)"
echo "  Comprueba la instalación con: $APP/scripts/doctor.sh"
