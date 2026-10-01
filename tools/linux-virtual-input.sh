#!/bin/sh
# Câble audio virtuel pour Linux (PipeWire ou PulseAudio) : une sortie « Behind-cable » vers laquelle
# on dirige une application (Spotify, logiciel de mix…), et une entrée « Behind-source » qui en
# ressort, à choisir comme source du direct. Rien n'est écrit sur disque : tout disparaît au
# redémarrage de la session, ou avec « off ».
#
#   tools/linux-virtual-input.sh on     crée le câble
#   tools/linux-virtual-input.sh off    le retire
#
# Pour y envoyer une application : réglages du son du système (ou pavucontrol), onglet des
# applications en lecture, choisir « Behind-cable » comme sortie.
set -eu

case "${1:-}" in
  on)
    if pactl list short sinks | grep -q 'behind_cable'; then
      echo "Le câble existe déjà."
      exit 0
    fi
    pactl load-module module-null-sink sink_name=behind_cable sink_properties=device.description=Behind-cable >/dev/null
    pactl load-module module-remap-source master=behind_cable.monitor source_name=behind_source source_properties=device.description=Behind-source >/dev/null
    echo "Câble créé : sortie « Behind-cable », entrée « Behind-source »."
    ;;
  off)
    pactl list short modules | grep -E 'behind_(cable|source)' | cut -f1 | sort -rn | while read -r id; do
      pactl unload-module "$id"
    done
    echo "Câble retiré."
    ;;
  *)
    echo "Usage : $0 on|off" >&2
    exit 2
    ;;
esac
