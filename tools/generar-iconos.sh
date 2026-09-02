#!/usr/bin/env bash
#
# Genera los iconos de la app a partir de icons/icon.svg.
#
# Se usa Chrome en modo headless como rasterizador porque en esta máquina no hay
# ImageMagick, ni Pillow, ni rsvg-convert, y el objetivo del proyecto es no
# arrastrar dependencias. Chrome ya está instalado y entiende SVG de sobra.
#
# Solo hay que volver a lanzarlo si cambia el logo:
#     ./tools/generar-iconos.sh
#
set -euo pipefail
cd "$(dirname "$0")/.."

CHROME=${CHROME:-google-chrome}
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

CUERPO=$(sed -e '1d' -e '$d' icons/icon.svg)   # los rects, sin la etiqueta <svg>

# $1 destino  $2 tamaño  $3 radio de esquina  $4 escala del contenido
render() {
  local destino=$1 tam=$2 radio=$3 escala=$4
  cat > "$TMP/icono.html" <<HTML
<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;padding:0;background:transparent}svg{display:block}</style>
<svg xmlns="http://www.w3.org/2000/svg" width="$tam" height="$tam" viewBox="0 0 1024 1024">
  <rect width="1024" height="1024" rx="$radio" fill="#123A33"/>
  <g transform="translate(512 512) scale($escala) translate(-512 -512)">
$CUERPO
  </g>
</svg>
HTML
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars \
    --force-device-scale-factor=1 --default-background-color=00000000 \
    --window-size="$tam,$tam" --screenshot="$destino" \
    "file://$TMP/icono.html" 2>/dev/null
  echo "  $destino  ${tam}px"
}

echo "Generando iconos desde icons/icon.svg…"

# "any": el logo tal cual, con sus esquinas redondeadas y transparencia fuera.
render icons/icon-192.png 192 239 1
render icons/icon-512.png 512 239 1

# "maskable": Android recorta un círculo y cada fabricante con su forma, así que
# el fondo va a sangre (radio 0) y el dibujo se encoge para caber entero dentro
# del círculo de seguridad del 80%. Sin esto, el libro inclinado de la derecha
# se queda fuera del recorte y sale decapitado.
render icons/icon-maskable-192.png 192 0 0.78
render icons/icon-maskable-512.png 512 0 0.78

# iOS aplica SU PROPIA máscara redondeada al apple-touch-icon. Si el PNG ya
# viniera con las esquinas redondeadas, se redondearía dos veces y aparecerían
# cuatro muescas oscuras en las esquinas. Por eso va a sangre y sin transparencia.
render icons/apple-touch-icon.png 180 0 1

echo "Listo."
