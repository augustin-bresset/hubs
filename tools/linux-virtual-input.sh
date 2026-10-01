#!/bin/sh
# Câble audio virtuel pour Linux (PipeWire ou PulseAudio) : une sortie « Cable-direct » vers laquelle
# on dirige une application (Spotify, logiciel de mix…), et une entrée « Source-direct » qui en
# ressort, à choisir comme source du direct. Rien n'est écrit sur disque : tout disparaît au
# redémarrage de la session, ou avec « off ».
#
#   tools/linux-virtual-input.sh on     crée le câble
#   tools/linux-virtual-input.sh off    le retire
#
# Pour y envoyer une application : réglages du son du système (ou pavucontrol), onglet des
# applications en lecture, choisir « Cable-direct » comme sortie.
set -eu

case "${1:-}" in
  on)
    if pactl list short sinks | grep -q 'cable_direct'; then
      echo "Le câble existe déjà."
      exit 0
    fi
    pactl load-module module-null-sink sink_name=cable_direct sink_properties=device.description=Cable-direct >/dev/null
    pactl load-module module-remap-source master=cable_direct.monitor source_name=source_direct source_properties=device.description=Source-direct >/dev/null
    echo "Câble créé : sortie « Cable-direct », entrée « Source-direct »."
    ;;
  off)
    pactl list short modules | grep -E '(cable|source)_direct' | cut -f1 | sort -rn | while read -r id; do
      pactl unload-module "$id"
    done
    echo "Câble retiré."
    ;;
  *)
    echo "Usage : $0 on|off" >&2
    exit 2
    ;;
esac
