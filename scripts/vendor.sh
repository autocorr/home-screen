#!/usr/bin/env bash
# Refresh the vendored browser libraries in site/vendor.
# Usage: scripts/vendor.sh [uplot_version] [astronomy_engine_version]
set -euo pipefail
UPLOT=${1:-1.6.32}
ASTRO=${2:-2.1.19}
cd "$(dirname "$0")/../site/vendor"
curl -sfLO "https://cdn.jsdelivr.net/npm/uplot@${UPLOT}/dist/uPlot.iife.min.js"
curl -sfLO "https://cdn.jsdelivr.net/npm/uplot@${UPLOT}/dist/uPlot.min.css"
curl -sfLo astronomy.browser.min.js "https://cdn.jsdelivr.net/npm/astronomy-engine@${ASTRO}/astronomy.browser.min.js"
echo "uPlot ${UPLOT}, astronomy-engine ${ASTRO}" > VERSIONS
ls -l
