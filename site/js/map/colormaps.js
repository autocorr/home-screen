// Colour maps for data layers, as weather-map-layer colour scales.

/**
 * Google's Turbo colormap (Mikhailov 2019), polynomial approximation.
 * t in [0, 1] -> [r, g, b] in 0..255.
 * https://research.google/blog/turbo-an-improved-rainbow-colormap-for-visualization/
 */
export function turbo(t) {
  t = Math.min(1, Math.max(0, t));
  const r = 0.13572138 + t * (4.61539260 + t * (-42.66032258 + t * (132.13108234 + t * (-152.94239396 + t * 59.28637943))));
  const g = 0.09140261 + t * (2.19418839 + t * (4.84296658 + t * (-14.18503333 + t * (4.27729857 + t * 2.82956604))));
  const b = 0.10667330 + t * (12.64194608 + t * (-60.58204836 + t * (110.36276771 + t * (-89.90310912 + t * 27.34824973))));
  return [r, g, b].map((c) => Math.round(255 * Math.min(1, Math.max(0, c))));
}

/**
 * A breakpoint colour scale sampling Turbo evenly across `breakpoints` (one
 * colour per step, so a roughly logarithmic list spreads the colours by order
 * of magnitude). Like Open-Meteo's own palettes, the first breakpoint is fully
 * transparent: colours blend between steps and dry cells carry tiny non-zero
 * values, so a visible first step would tint the whole map. The next steps
 * fade in (alphas) so light precipitation doesn't hide the basemap, and
 * Turbo's darkest end is skipped (tMin) so they stay visible on a dark map.
 */
export function turboBreakpointScale(unit, breakpoints, { tMin = 0.12, tMax = 1, alphas = [0, 0.55, 0.7, 0.8, 0.85] } = {}) {
  const n = breakpoints.length - 1;  // visible steps
  const colors = breakpoints.map((_, i) => [
    ...turbo(tMin + ((tMax - tMin) * Math.max(0, i - 1)) / Math.max(1, n - 1)),
    alphas[i] ?? 0.9,
  ]);
  return { type: 'breakpoint', unit, breakpoints: [...breakpoints], colors };
}

/**
 * Radar reflectivity (dBZ) in 5 dBZ steps. The library has no palette for it,
 * so this one is always used, for the forecast (RRFS `radar_reflectivity`) and
 * the observed radar alike. Below 5 dBZ is transparent (clear-air returns).
 */
export const REFLECTIVITY_SCALE = turboBreakpointScale('dBZ', Array.from({ length: 15 }, (_, i) => i * 5));

/** Colour scale overrides, keyed by variable. `name` 'turbo' also recolours precipitation; otherwise the library's palette is used for it. */
export function colorScaleOverrides(name, wml) {
  const out = { radar_reflectivity: REFLECTIVITY_SCALE };
  if (name === 'turbo') {
    const precip = wml.getColorScale('precipitation', false);
    out.precipitation = turboBreakpointScale(precip.unit, precip.breakpoints);
  }
  return out;
}
