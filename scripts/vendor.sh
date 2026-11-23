#!/usr/bin/env bash
# Refresh the vendored browser libraries in site/vendor.
# Usage: scripts/vendor.sh [uplot] [astronomy_engine] [maplibre_gl] [weather_map_layer] [satellite_js]
set -euo pipefail
UPLOT=${1:-1.6.32}
ASTRO=${2:-2.1.19}
MAPLIBRE=${3:-6.17.0}
WML=${4:-0.3.2}
SATJS=${5:-6.0.2}
NPM=https://cdn.jsdelivr.net/npm
cd "$(dirname "$0")/../site/vendor"
curl -sfLO "${NPM}/uplot@${UPLOT}/dist/uPlot.iife.min.js"
curl -sfLO "${NPM}/uplot@${UPLOT}/dist/uPlot.min.css"
curl -sfLo astronomy.browser.min.js "${NPM}/astronomy-engine@${ASTRO}/astronomy.browser.min.js"

# MapLibre GL loads its worker module from next to maplibre-gl.mjs.
mkdir -p maplibre-gl
for f in maplibre-gl.mjs maplibre-gl-worker.mjs maplibre-gl-shared.mjs maplibre-gl.css LICENSE.txt; do
  src="${NPM}/maplibre-gl@${MAPLIBRE}/dist/${f}"
  [[ $f == LICENSE.txt ]] && src="${NPM}/maplibre-gl@${MAPLIBRE}/${f}"
  curl -sfLo "maplibre-gl/${f}" "$src"
done

# Open-Meteo weather-map-layer (GPL-2.0-or-later): the module fetches worker.js,
# the WASM reader and its loader from its own directory.
mkdir -p weather-map-layer
for f in dist/index.mjs dist/worker.js dist/om_file_format.web.mjs dist/om_file_format.web.wasm LICENSE; do
  curl -sfLo "weather-map-layer/$(basename "$f")" "${NPM}/@openmeteo/weather-map-layer@${WML}/${f}"
done

# satellite.js (MIT): SGP4 orbit propagation, UMD build (global `satellite`).
mkdir -p satellite.js
curl -sfLo satellite.js/satellite.min.js "${NPM}/satellite.js@${SATJS}/dist/satellite.min.js"
curl -sfLo satellite.js/LICENSE.md "${NPM}/satellite.js@${SATJS}/LICENSE.md"

echo "uPlot ${UPLOT}, astronomy-engine ${ASTRO}, maplibre-gl ${MAPLIBRE}, @openmeteo/weather-map-layer ${WML}, satellite.js ${SATJS}" > VERSIONS
ls -lR
