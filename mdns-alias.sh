#!/bin/bash
# Publica mando.local (mDNS, con avahi) apuntando a la IP de la LAN (A y AAAA, para que los clientes no esperen).
# Si la IP cambia, sale y systemd lo relanza.
NAME=${1:-mando.local}
ip4() { ip -4 -o addr show scope global dev eno2 | awk "{print \$4}" | cut -d/ -f1 | head -1; }
ip6() { ip -6 -o addr show scope link dev eno2 | awk "{print \$4}" | cut -d/ -f1 | head -1; }
IP=$(ip4); IP6=$(ip6)
[ -z "$IP" ] && exit 1
avahi-publish -a -R "$NAME" "$IP" &
P1=$!
[ -n "$IP6" ] && { avahi-publish -a -R "$NAME" "$IP6" & P2=$!; }
trap "kill $P1 $P2 2>/dev/null" EXIT
while kill -0 $P1 2>/dev/null; do
  sleep 30
  [ "$(ip4)" = "$IP" ] || exit 1
done
