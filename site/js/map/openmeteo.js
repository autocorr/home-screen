// Open-Meteo spatial forecast data (.om files on AWS S3) as a MapView data layer.
//
// Fetch budget:
//   - `latest.json` (~8 kB) per model: read only when the caller asks (the
//     section's Update button). `cache: 'no-cache'` makes it a conditional
//     request (ETag), so an unchanged file is a bodiless 304. snapshot() and
//     restore() let the caller keep the last answer, so a reload can show the
//     same run without asking again.
//   - .om files: one per valid time (~100 MB each, all variables, whole CONUS).
//     The reader fetches only the byte ranges covering our cut-out `bounds`
//     for one variable (a few hundred kB per frame), in 64 kB blocks that go
//     through the block cache (see storage.js). We build concrete run/time
//     file URLs ourselves instead of the library's `latest.json?...` "capture"
//     URLs, which would re-read latest.json for every frame and give cache
//     keys that change meaning when a new run is published.
//   - Frames are loaded only when shown (and the next one is prefetched while
//     playing), never the whole run up front.

export const S3_BASE = 'https://openmeteo.s3.amazonaws.com/data_spatial';

const pad = (n) => String(n).padStart(2, '0');
const runPath = (d) => `${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}/${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}Z`;
const filePart = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
const css = ([r, g, b, a = 1]) => `rgba(${r},${g},${b},${a})`;

let protocolInstalled = false;
/**
 * Register the om:// protocol once. `bounds` [w, s, e, n] is the cut-out: tiles
 * outside it are not drawn and data outside it is never read.
 */
export function installProtocol(maplibregl, wml, { cache, bounds, colorScales = {} }) {
  if (protocolInstalled) return;
  protocolInstalled = true;
  const settings = {
    ...wml.defaultOmProtocolSettings,
    // SharedArrayBuffer needs cross-origin isolation (COOP/COEP headers), which
    // GitHub Pages can't send; without it the small cut-out is copied to workers.
    fileReaderConfig: { ...wml.defaultOmProtocolSettings.fileReaderConfig, useSAB: !!globalThis.crossOriginIsolated, cache },
    clippingOptions: { bounds },
    colorScales: { ...wml.defaultOmProtocolSettings.colorScales, ...colorScales },
    // Decoded variables kept in memory: the shown frame, the one fading out,
    // and a prefetched one or two.
    maxStatesWithData: 4,
  };
  wml.updateCurrentBounds(bounds);
  maplibregl.addProtocol('om', (params, abort) => wml.omProtocol(params, abort, settings));
}

/**
 * @param {object} o { wml, model, label, variable, base, run, colorScales }
 *   model: Open-Meteo spatial domain, e.g. 'ncep_rrfs_conus'
 *   run:   optional Date of a specific (past) run to show instead of the latest.
 *          Its meta.json never changes, so it is read once and never polled.
 *   colorScales: the same overrides passed to installProtocol (for the legend)
 */
export function openMeteoForecastLayer({ wml, model, label, variable = 'precipitation', base = S3_BASE, run: fixedRun = null, colorScales = {} }) {
  let meta = null;          // parsed latest.json
  let frames = [];
  let etag = null;

  const fileUrl = (validIso) => {
    const run = new Date(meta.reference_time);
    const valid = new Date(validIso);
    let url = `${base}/${model}/${runPath(run)}/${filePart(valid)}.om?variable=${variable}`;
    // Accumulations are stored per time step; the layer converts to a rate (per hour).
    if (wml.variableUsesDeltaTime(variable)) {
      const dt = wml.deltaTimeHoursAt(valid, meta.valid_times);
      if (dt) url += `&delta_time_hours=${dt}`;
    }
    return url;
  };

  const layer = {
    id: `om:${model}:${variable}`,
    label,
    attribution: null,  // the om:// TileJSON supplies "© Open-Meteo"
    opacity: 0.8,
    get run() { return meta ? new Date(meta.reference_time) : null; },
    fixed: !!fixedRun,
    frames: () => frames,
    frameFor(t) {
      if (!frames.length || t < frames[0].time || t > frames.at(-1).time) return null;
      let best = frames[0];
      for (const f of frames) if (f.time <= t) best = f;
      return best;
    },
    sourceSpec(frame, { dark }) {
      return { type: 'raster', url: `om://${frame.url}${dark ? '&dark=true' : ''}`, tileSize: 256 };
    },
    legend({ dark }) {
      const s = wml.getColorScale(variable, dark, { ...wml.defaultOmProtocolSettings.colorScales, ...colorScales });
      if (!s?.breakpoints) return null;
      return { unit: s.unit, stops: s.breakpoints.map((v, i) => [v, css(s.colors[i])]) };
    },
    async valueAt(frame, { lng, lat }) {
      try {
        const { value } = await wml.getValueFromLatLong(lat, lng, `om://${frame.url}`);
        return Number.isFinite(value) ? value : null;
      } catch { return null; }
    },
    /** Re-read latest.json. Resolves true when the frames changed. */
    async refresh() {
      if (fixedRun && meta) return false;
      const metaUrl = fixedRun ? `${base}/${model}/${runPath(fixedRun)}/meta.json` : `${base}/${model}/latest.json`;
      const r = await fetch(metaUrl, { cache: fixedRun ? 'default' : 'no-cache' });
      if (!r.ok) throw new Error(`${model} ${fixedRun ? `run ${runPath(fixedRun)}` : 'latest.json'}: ${r.status}`);
      const tag = r.headers.get('ETag');
      if (tag && tag === etag) return false;
      const m = await r.json();
      if (meta && m.reference_time === meta.reference_time && m.valid_times.length === meta.valid_times.length) {
        etag = tag; return false;
      }
      if (!m.variables?.includes(variable)) throw new Error(`${model} has no ${variable}`);
      setMeta(m); etag = tag;
      return true;
    },
    /** What refresh() last learned, to store; null before it has succeeded. */
    snapshot: () => (meta ? { meta, etag } : null),
    /** Show a stored snapshot's run (no request). */
    restore(snap) {
      if (!snap?.meta?.valid_times || !snap.meta.variables?.includes(variable)) return false;
      setMeta(snap.meta); etag = snap.etag ?? null;
      return true;
    },
  };

  function setMeta(m) {
    meta = m;
    const run = Date.parse(m.reference_time);
    // An accumulation's first file of a run (the analysis) has nothing accumulated yet.
    const skipFirst = wml.variableUsesDeltaTime(variable);
    frames = m.valid_times.filter((v) => !(skipFirst && Date.parse(v) <= run))
      .map((v) => ({ time: Date.parse(v), key: `${runPath(new Date(run))}-${filePart(new Date(v))}`, url: fileUrl(v) }))
      .sort((a, b) => a.time - b.time);
  }
  return layer;
}
