#!/bin/bash
# Publica el alias mDNS del mando (TV_MDNS_NAME, p. ej. mando.local) con avahi, apuntando a la IP de la LAN
# (A y AAAA de enlace, para que los clientes no esperen). Si la IP cambia, sale con error y systemd lo relanza.
# Uso: mdns-alias.sh [nombre]   (sin nombre: TV_MDNS_NAME de la config; vacío = no publica nada y sale con 0)
set -u
APP_DIR=$(cd "$(dirname "$(readlink -f "$0")")" && pwd)
# shellcheck source=scripts/lib.sh
. "$APP_DIR/scripts/lib.sh"
jsc_load_config

NAME=${1:-$TV_MDNS_NAME}
if [ -z "$NAME" ]; then
  echo "TV_MDNS_NAME vacío: no publico ningún alias"
  exit 0
fi
if ! command -v avahi-publish >/dev/null 2>&1; then
  echo "no está avahi-publish (paquete avahi-utils): no publico $NAME" >&2
  exit 0
fi
IFACE=${TV_NET_IFACE:-$(jsc_detect_iface)}
if [ -z "$IFACE" ]; then
  echo "no hay ruta por defecto todavía (ni TV_NET_IFACE): reintento luego" >&2
  exit 1
fi

ip4() { ip -4 -o addr show scope global dev "$IFACE" | awk '{print $4}' | cut -d/ -f1 | head -1; }
ip6() { ip -6 -o addr show scope link dev "$IFACE" | awk '{print $4}' | cut -d/ -f1 | head -1; }
IP=$(ip4); IP6=$(ip6)
if [ -z "$IP" ]; then
  echo "$IFACE no tiene IPv4 todavía: reintento luego" >&2
  exit 1
fi

pids=()
# shellcheck disable=SC2329 # la llama el trap
cleanup() { [ ${#pids[@]} -gt 0 ] && kill "${pids[@]}" 2>/dev/null; }
trap cleanup EXIT
echo "publico $NAME -> $IP${IP6:+ y $IP6} ($IFACE)"
avahi-publish -a -R "$NAME" "$IP" &
pids+=($!)
if [ -n "$IP6" ]; then avahi-publish -a -R "$NAME" "$IP6" & pids+=($!); fi
while kill -0 "${pids[0]}" 2>/dev/null; do
  sleep 30
  [ "$(ip4)" = "$IP" ] || { echo "la IP de $IFACE ha cambiado: salgo para volver a publicar"; exit 1; }
done
echo "avahi-publish ha terminado" >&2
exit 1
