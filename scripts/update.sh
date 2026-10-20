#!/bin/bash
# Actualiza jota-screen desde git (solo avance rápido), instala dependencias si cambian, reinicia y comprueba.
# Ver «scripts/update.sh --help».
set -euo pipefail

usage() {
  cat <<'EOF'
Uso: scripts/update.sh [--from REF] [--no-doctor]

  1. git fetch del remoto y git merge --ff-only de la rama de seguimiento (o de REF, p. ej. origin/main).
     Se para sin tocar nada si hay cambios locales sin guardar o si no es un avance rápido.
  2. npm ci --omit=dev en remote/ si ha cambiado remote/package-lock.json.
  3. Reinicia jota-screen (y avisa si cambiaron las plantillas: entonces toca scripts/install.sh).
  4. Ejecuta scripts/doctor.sh.
EOF
}

# todo dentro de main: bash lo lee entero antes de empezar, así el merge puede cambiar este fichero sin romperlo
main() {
  local FROM='' DOCTOR=1 remote old new lock_sum
  while [ $# -gt 0 ]; do
    case $1 in
      --from) FROM=${2:?falta REF}; shift 2 ;;
      --no-doctor) DOCTOR=0; shift ;;
      -h|--help) usage; exit 0 ;;
      *) echo "opción desconocida: $1 (ver --help)" >&2; exit 2 ;;
    esac
  done

  # shellcheck source=scripts/lib.sh
  . "$(dirname "$(readlink -f "$0")")/lib.sh"
  cd "$JSC_APP_DIR"

  if ! git diff --quiet || ! git diff --cached --quiet; then
    echo "✗ hay cambios locales sin guardar en $JSC_APP_DIR; guárdalos o descártalos antes (git status)" >&2
    exit 1
  fi
  if [ -z "$FROM" ]; then
    FROM=$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null) || {
      echo "✗ la rama $(git branch --show-current) no sigue a ninguna rama remota; usa --from origin/main" >&2
      echo "  o fíjala: git branch --set-upstream-to=origin/main" >&2
      exit 1
    }
  fi
  remote=${FROM%%/*}
  git remote | grep -qx "$remote" || { echo "✗ $FROM no es una rama remota (remoto «${remote}» desconocido)" >&2; exit 1; }

  echo "· git fetch $remote"
  git fetch --prune "$remote"
  old=$(git rev-parse HEAD)
  if ! git merge --ff-only "$FROM"; then
    echo "✗ $FROM no es un avance rápido de $(git branch --show-current): no he cambiado nada" >&2
    exit 1
  fi
  new=$(git rev-parse HEAD)
  if [ "$old" = "$new" ]; then
    echo "✓ ya estaba al día ($(git log -1 --format='%h %s'))"
  else
    echo "✓ $(git log --oneline "$old..$new" | wc -l) commits nuevos:"
    git log --oneline "$old..$new" | sed 's/^/    /'
    if ! git diff --quiet "$old" "$new" -- remote/package-lock.json; then
      echo "· remote/package-lock.json ha cambiado: npm ci --omit=dev"
      (cd remote && npm ci --omit=dev --no-audit --no-fund)
      lock_sum=$(jsc_sha256 remote/package-lock.json)
      printf '%s omit=dev\n' "$lock_sum" >remote/node_modules/.jota-screen-install
    fi
    if ! git diff --quiet "$old" "$new" -- systemd/ config/ remote/nginx-mando.conf; then
      echo "! han cambiado las plantillas (systemd/, config/ o nginx): ejecuta scripts/install.sh para aplicarlas"
    fi
    if ! git diff --quiet "$old" "$new" -- kiosk-session.sh home.html; then
      echo "! ha cambiado el kiosco: se aplica al reiniciarlo (sudo systemctl restart jota-screen-kiosk)"
    fi
    if systemctl --user show-environment >/dev/null 2>&1; then
      echo "· reinicio jota-screen"
      systemctl --user restart jota-screen.service
      sleep 4
    else
      echo "! no hay systemctl --user: reinicia el servidor a mano"
    fi
  fi

  if [ $DOCTOR = 1 ]; then
    echo
    exec "$JSC_APP_DIR/scripts/doctor.sh"
  fi
}

main "$@"
exit $?
