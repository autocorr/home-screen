// Precipitation & radar map section, over a cut-out around Socorro on an
// OpenStreetMap basemap:
//   - Precip: Open-Meteo model precipitation rate (RRFS or NBM).
//   - Radar:  observed reflectivity (IEM NEXRAD mosaic) for the past hours,
//             stitched to the RRFS simulated reflectivity forecast (15-minute,
//             then hourly) on one timeline.
// The map libraries (~4 MB incl. WASM) load only once the section is on
// screen and expanded. Map data is downloaded only when Update is pressed: the
// view shows the run and scans the last Update found (kept in localStorage when
// storage is on disk, else in this tab's memory), and Update then waits
// PRECIP_MAP.minUpdateMin minutes (per view, shared by every tab).
import { PRECIP_MAP, SOCORRO, TZ } from './config.js';
import { getUnitSystem } from './weather.js';
import { BASEMAPS, DEFAULT_BASEMAP } from './map/basemaps.js';
import { MapView, renderLegend, stitchLayers } from './map/view.js';
import { installProtocol, openMeteoForecastLayer } from './map/openmeteo.js';
import { installIemProtocol, iemRadarLayer } from './map/iem.js';
import { colorScaleOverrides, REFLECTIVITY_SCALE } from './map/colormaps.js';
import { CLUTTER } from './data/clutter.js';
import { createBlockCache } from './map/storage.js';
import { askStorage, useDisk, onStoragePref } from './storage.js';

const PREFS_KEY = 'precip:v1';
const DATA_KEY = 'precip:data:v1';   // { [layer id]: { tried, fetched, snap } }
const PLAY_STEP_MS = 700;
const TICK_MS = 30e3;                // refresh the status line's age and the Update button

const prefs = (() => {
  let p; try { p = JSON.parse(localStorage.getItem(PREFS_KEY)); } catch { p = null; }
  const out = { quantity: PRECIP_MAP.quantities[0].id, model: PRECIP_MAP.models[0].id, basemap: DEFAULT_BASEMAP, ...p };
  // A saved choice that is no longer offered falls back to the default.
  if (!PRECIP_MAP.models.some((m) => m.id === out.model)) out.model = PRECIP_MAP.models[0].id;
  if (!PRECIP_MAP.quantities.some((q) => q.id === out.quantity)) out.quantity = PRECIP_MAP.quantities[0].id;
  return out;
})();
const savePrefs = () => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* ignore */ } };

// What each layer's last Update found (latest.json, the radar scan list). `tried` (when
// Update last asked, in any tab) is always stored, so the wait holds across reloads;
// `snap` and `fetched` only with storage on disk. `held` is what this tab shows.
const loadData = () => { try { return JSON.parse(localStorage.getItem(DATA_KEY)) ?? {}; } catch { return {}; } };
const saveData = (d) => { try { localStorage.setItem(DATA_KEY, JSON.stringify(d)); } catch { /* ignore */ } };
const held = new Map();   // layer id -> { snap, fetched }

function recordTried(ids) {
  const d = loadData();
  ids.forEach((id) => { d[id] = { ...d[id], tried: Date.now() }; });
  saveData(d);
}
function recordFetched(layer) {
  const snap = layer.snapshot();
  if (!snap) return;
  const rec = { snap, fetched: Date.now() };
  held.set(layer.id, rec);
  if (!useDisk()) return;
  const d = loadData();
  d[layer.id] = { ...d[layer.id], ...rec };
  saveData(d);
}
/** Show the stored (or held) data for a layer; true if there was some. */
function restoreLayer(layer) {
  const rec = held.get(layer.id) ?? (useDisk() ? loadData()[layer.id] : null);
  if (!rec?.snap || !layer.restore(rec.snap)) return false;
  held.set(layer.id, { snap: rec.snap, fetched: rec.fetched });
  return true;
}
// Storage declined later (here or in another tab): forget the stored runs and scans;
// allowed later: keep what this tab holds.
onStoragePref((pref) => {
  const d = loadData();
  if (pref === 'memory') Object.values(d).forEach((r) => { delete r.snap; delete r.fetched; });
  else if (pref === 'disk') held.forEach((rec, id) => { d[id] = { ...d[id], ...rec }; });
  saveData(d);
});

// URL overrides, e.g. ?pm_run=2026-11-21T12Z&pm_time=2026-11-21T16Z: show a past
// run (it stays on S3 for a while) at a given valid time instead of the latest.
const parseUtc = (v) => {
  const m = v?.match(/^(\d{4})-(\d\d)-(\d\d)T(\d\d)(?::?(\d\d))?Z?$/);
  return m ? new Date(Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +(m[5] ?? 0))) : null;
};
const params = new URLSearchParams(location.search);
const FIXED_RUN = parseUtc(params.get('pm_run'));
const START_TIME = parseUtc(params.get('pm_time'));
let colorScales = {};

const isDark = () => {
  const t = document.documentElement.dataset.theme;
  return t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
};

const dtFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', hour: 'numeric', minute: '2-digit', hour12: false });
const runFmt = (d) => `${String(d.getUTCHours()).padStart(2, '0')}Z`;
const hmFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: false });
const leadFmt = (ms) => {
  const m = Math.round(ms / 60e3);
  return `+${Math.floor(m / 60)}${m % 60 ? `:${String(m % 60).padStart(2, '0')}` : ''} h`;
};
const isRadar = () => prefs.quantity === 'refl';

const rate = (mmh) => {
  if (mmh == null) return '—';
  if (mmh < 0.01) return 'dry';
  if (getUnitSystem() === 'metric') return `${mmh < 1 ? mmh.toFixed(2) : mmh.toFixed(1)} mm/h`;
  const inh = mmh / 25.4;
  return `${inh < 0.1 ? inh.toFixed(3) : inh.toFixed(2)} in/h`;
};
const tickFmt = (mmh) => (getUnitSystem() === 'metric'
  ? String(+mmh.toPrecision(2)) : String(+(mmh / 25.4).toPrecision(1)));
const dbz = (v) => (v == null ? '—' : v < REFLECTIVITY_SCALE.breakpoints[1] ? 'no echo' : `${Math.round(v)} dBZ`);

let view = null, wml = null, maplibregl = null;
let layers = [];       // the current quantity's data layers, in timeline order
let names = '';        // what they show, for the status line
let updating = false;  // an Update is in flight
let lastError = null;  // why the last Update of this view failed (in part)
let generation = 0;    // bumped on each rebuild, so a slow load can't install stale layers
let root, els, times = [], idx = 0, playing = false, probe = null, loading = null;

const $ = (sel) => root.querySelector(sel);

function seg(el, items, current, attr) {
  el.innerHTML = items.map((i) =>
    `<button type="button" data-${attr}="${i.id}" title="${i.title ?? ''}" aria-pressed="${i.id === current}"` +
    `${i.disabled ? ' disabled' : ''}>${i.label}</button>`).join('');
}

/** Model switch. Radar always uses RRFS (NBM has no reflectivity), but the switch stays in
 *  place, locked, so the header keeps the same rows and the map doesn't move between views. */
function renderModels() {
  const radar = isRadar();
  const rrfs = PRECIP_MAP.models.find((m) => PRECIP_MAP.radar.forecasts.some((f) => f.id === m.id))?.id;
  const items = PRECIP_MAP.models.map((m) => !radar ? m
    : { ...m, disabled: m.id !== rrfs, title: m.id === rrfs ? 'Radar forecasts use RRFS' : `${m.label} has no radar reflectivity` });
  seg(els.model, items, radar ? rrfs : prefs.model, 'model');
}

/** `wrap`: let the line wrap (errors with nothing to show); otherwise it stays one line. */
function status(msg, isError = false, wrap = isError) {
  els.status.textContent = msg;
  els.status.classList.toggle('error', isError);
  els.status.classList.toggle('wrap', wrap);
  els.status.title = '';   // describe() sets the tooltip for the data line
}

const hasData = (l) => l.snapshot() != null;
const ago = (ms) => {
  const m = Math.round((Date.now() - ms) / 60e3);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};
const fmtWait = (ms) => `${Math.max(1, Math.ceil(ms / 60e3))} min`;
const waitMin = () => PRECIP_MAP.minUpdateMin[prefs.quantity] ?? 5;

/**
 * When Update is available again (ms), or null if it is now: once every layer of the
 * view has data and was asked for less than waitMin() ago (in any tab).
 */
function updateBlockedUntil() {
  if (!layers.length || layers.some((l) => !hasData(l))) return null;
  const d = loadData();
  const until = Math.min(...layers.map((l) => (d[l.id]?.tried ?? 0) + waitMin() * 60e3));
  return until > Date.now() ? until : null;
}

function syncUpdate() {
  const b = els.update;
  const until = updateBlockedUntil();
  b.disabled = !view || !layers.length || updating || !!FIXED_RUN || !!until;
  b.title = FIXED_RUN ? 'An archived run (pm_run in the URL) never changes'
    : !view ? 'The map is loading'
    : updating ? 'Downloading…'
    : until ? `Updated less than ${waitMin()} min ago; Update is available again in ${fmtWait(until - Date.now())}`
    : `Download the newest ${isRadar() ? 'radar scans and RRFS runs' : 'model run'}`;
}

/** The layer drawing time t (the first one with a frame there). */
const layerAt = (t) => layers.find((l) => view?.frameOf(l.id, t));

function describe() {
  syncUpdate();
  if (updating) return;
  const cache = useDisk() ? 'disk cache' : 'memory cache';
  const until = updateBlockedUntil();
  const wait = until ? ` Update is available again in ${fmtWait(until - Date.now())}.` : '';
  if (!layers.some(hasData)) {
    status(lastError ? `Couldn't download ${names}: ${lastError}.${wait || ' Press Update to try again.'}`
      : FIXED_RUN ? `Loading ${names}…` : `Press Update to download ${names}.`, Boolean(lastError));
    return;
  }
  let data, detail = '';
  if (isRadar()) {
    // Kept short enough for one line on a phone, like the precip line, so the section
    // is the same height in both views. The per-feed runs go in the tooltip.
    const [obs, ...fc] = layers;
    const loaded = fc.filter((l) => l.run);
    data = [
      obs.newest ? `Radar to ${hmFmt.format(obs.newest)} MT` : 'No observed radar',
      loaded.length ? `RRFS ${loaded[0].fixed ? 'archived' : 'runs'} ${loaded.map((l) => runFmt(l.run)).join(', ')}`
        : 'No RRFS forecast',
    ].join(' · ');
    detail = loaded.map((l) => `${l.short}: run ${runFmt(l.run)} (${dtFmt.format(l.run)} MT)`).join('\n') + '\n';
  } else {
    const [layer] = layers;
    const model = PRECIP_MAP.models.find((m) => m.id === prefs.model);
    data = layer?.run ? `${model.label} ${layer.fixed ? 'archived ' : ''}run ${runFmt(layer.run)} (${dtFmt.format(layer.run)} MT)` : model.label;
  }
  const got = layers.map((l) => held.get(l.id)?.fetched).filter(Boolean);
  const updated = !FIXED_RUN && got.length ? ` · updated ${ago(Math.min(...got))}` : '';
  const failed = lastError ? ` · last update failed: ${lastError}` : '';
  // A partial failure keeps the line to one row, so the section doesn't change height.
  status(`${data}${updated}${failed}`, Boolean(lastError), false);
  // One line (ellipsis if it still doesn't fit, see .map-status): the full text is in the tooltip.
  els.status.title = `${data}${updated} · ${cache}${failed}\n` + detail + (wait ? `${wait.trim()}\n` : '') +
    (crossOriginIsolated ? 'Cross-origin isolated: data shared with render workers'
      : 'Not cross-origin isolated: each render worker gets a copy of the (small) cut-out');
}

function syncTimeline() {
  times = view.times();
  els.slider.max = String(Math.max(0, times.length - 1));
  els.slider.disabled = times.length < 2;
  syncStepButtons();
}

function syncStepButtons() {
  els.prev.disabled = idx <= 0;
  els.next.disabled = idx >= times.length - 1;
}

function nowIndex() {
  const now = Date.now();
  if (isRadar()) {
    // The newest observed scan, even if a forecast frame falls between it and now;
    // without scans, the last time at or before now.
    const newest = layers.find((l) => l.observed)?.frames().at(-1)?.time;
    const i = newest != null ? times.indexOf(newest) : times.findLastIndex((t) => t <= now);
    return Math.max(0, i);
  }
  // Precipitation frames are "hour ending at": show the frame covering now.
  const i = times.findIndex((t) => t >= now);
  return i < 0 ? times.length - 1 : i;
}

async function show(i) {
  if (!times.length) return;
  idx = Math.max(0, Math.min(times.length - 1, i));
  els.slider.value = String(idx);
  syncStepButtons();
  const t = times[idx];
  const layer = layerAt(t);
  let what;
  if (!layer) what = 'no data';
  else if (layer.observed) what = `observed${idx === nowIndex() ? ' · latest' : ''}`;
  else if (isRadar()) what = `${layer.short} ${leadFmt(t - layer.run)}${t < Date.now() ? ' · past' : ''}`;
  else {
    const step = idx > 0 ? Math.round((times[idx] - times[idx - 1]) / 60e3) : 60;
    what = `${step >= 60 ? `${step / 60} h` : `${step} min`} ending` +
      `${layer.run ? ` · +${Math.round((t - layer.run) / 3600e3)} h` : ''}${t < Date.now() ? ' · past' : ''}`;
  }
  els.time.innerHTML = `<b>${dtFmt.format(t)} MT</b> <span class="muted">· ${what}</span>`;
  const done = view.setTime(t);
  updateProbe();
  return done;
}

async function updateProbe() {
  const layer = view && layerAt(view.time);
  const frame = layer && view.frameOf(layer.id);
  const p = probe ?? { lng: SOCORRO.lon, lat: SOCORRO.lat, label: 'Socorro' };
  if (!frame) { els.value.textContent = ''; return; }
  const key = frame.key;
  await view.whenReady();  // values are sampled from the loaded frame data
  const v = await layer.valueAt(frame, p);
  if (view.frameOf(layer.id)?.key !== key) return;
  els.value.textContent = `${p.label}: ${isRadar() ? dbz(v) : v == null ? '—' : rate(Math.max(0, v))}`;
}

function renderLegendNow() {
  const lg = layers.map((l) => l.legend?.({ dark: isDark() })).find(Boolean);
  if (isRadar()) {
    renderLegend(els.legend, lg, String, { zeroLabel: false });
    els.legendUnit.textContent = 'dBZ';
  } else {
    renderLegend(els.legend, lg, tickFmt);
    els.legendUnit.textContent = getUnitSystem() === 'metric' ? 'mm/h' : 'in/h';
  }
}

async function play() {
  playing = !playing;
  els.play.textContent = playing ? '❚❚' : '▶';
  els.play.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  while (playing) {
    const next = idx + 1 >= times.length ? 0 : idx + 1;
    const t0 = performance.now();
    await show(next);                      // waits until the frame is drawn
    const wait = PLAY_STEP_MS - (performance.now() - t0);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
}
const stop = () => { if (playing) play(); };

const floorToHours = (d, h) => d && new Date(Math.floor(d / (h * 3600e3)) * h * 3600e3);

function buildLayers() {
  if (!isRadar()) {
    const m = PRECIP_MAP.models.find((x) => x.id === prefs.model) ?? PRECIP_MAP.models[0];
    return { names: `${m.label} precipitation`, layers: [openMeteoForecastLayer({ wml, model: m.id, label: `${m.label} precipitation`, run: FIXED_RUN, colorScales })] };
  }
  const { historyH, forecasts } = PRECIP_MAP.radar;
  // An archived run shows the radar up to that run's start, then its forecast.
  const obs = iemRadarLayer({ historyH, bounds: PRECIP_MAP.bounds, until: FIXED_RUN, colorScale: REFLECTIVITY_SCALE });
  const fc = forecasts.map((f) => Object.assign(openMeteoForecastLayer({
    wml, model: f.id, variable: 'radar_reflectivity', label: `${f.label} reflectivity`,
    run: floorToHours(FIXED_RUN, f.runEveryH), colorScales,
  }), { short: f.label }));
  return { names: 'radar and RRFS', layers: stitchLayers([obs, ...fc]) };
}

/**
 * (Re)build the layers for the current quantity and model. `follow`: the view
 * was at "now", so show the new layers' "now" rather than the same time.
 */
async function rebuild({ follow = false } = {}) {
  stop();
  const gen = ++generation;
  const t = follow ? undefined : times[idx];
  layers.forEach((l) => view.removeLayer(l.id));
  layers = [];
  lastError = null;
  const built = buildLayers();
  names = built.names;
  const next = built.layers;
  if (FIXED_RUN) {
    // An archived run was asked for in the URL: read it now (it never changes).
    status(`Loading ${names}…`);
    const results = await Promise.allSettled(next.map((l) => l.refresh()));
    if (gen !== generation) return;
    results.forEach((r, i) => { if (r.status === 'rejected') console.warn(`${next[i].label}: ${r.reason?.message ?? r.reason}`); });
    if (results.every((r) => r.status === 'rejected')) lastError = results[0].reason?.message ?? String(results[0].reason);
  } else {
    // Nothing is downloaded here: show what the last Update found, if anything.
    next.forEach(restoreLayer);
  }
  layers = next;
  layers.forEach((l) => view.addLayer(l));
  syncTimeline();
  renderLegendNow();
  describe();
  if (!times.length) { els.time.textContent = els.value.textContent = ''; return; }
  const want = t ?? (follow ? null : START_TIME?.getTime());
  const keep = want != null ? times.indexOf(want) : -1;
  show(keep >= 0 ? keep : nowIndex());
}

function setQuantity(id) {
  // "Now" differs between quantities (the hour ending after now vs the newest scan).
  const follow = times.length > 0 && idx === nowIndex();
  prefs.quantity = id; savePrefs();
  seg(els.qty, PRECIP_MAP.quantities, prefs.quantity, 'qty');
  renderModels();
  return rebuild({ follow });
}

function setModel(id) {
  prefs.model = id; savePrefs();
  renderModels();
  return rebuild();
}

/** Where the view is, before its layers' frames change (nowIndex() reads them). */
const position = () => ({ atNow: !times.length || idx === nowIndex(), shown: idx, t: times[idx] });

/** The layers' frames changed: redraw, staying at the same time, or at "now" if the view was there. */
function framesChanged({ atNow, shown, t }) {
  if (idx !== shown) atNow = false;   // the user moved while we were fetching
  // Stitched layers depend on each other's frames: refresh them all.
  layers.forEach((l) => view.refreshed(l.id));
  syncTimeline();
  renderLegendNow();
  const keep = times.indexOf(t);
  if (times.length) show(atNow || keep < 0 ? nowIndex() : keep);
}

/** The Update button: download the newest run (and radar scans) for the view shown. */
async function update() {
  if (updating || !view || !layers.length || FIXED_RUN || updateBlockedUntil()) { if (view) describe(); return; }
  const gen = generation, cur = layers, pos = position();
  updating = true;
  recordTried(cur.map((l) => l.id));   // before anything is sent, so other tabs wait too
  status(`Downloading ${names}…`);
  syncUpdate();
  const results = await Promise.allSettled(cur.map((l) => l.refresh()));
  updating = false;
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') recordFetched(cur[i]);
    else console.warn(`${cur[i].label}: ${r.reason?.message ?? r.reason}`);
  });
  if (gen !== generation) { describe(); return; }   // the view changed meanwhile; what arrived is kept
  const failed = results.find((r) => r.status === 'rejected');
  lastError = failed ? failed.reason?.message ?? String(failed.reason) : null;
  if (results.some((r) => r.value === true)) framesChanged(pos);
  describe();
}

/** Another tab's Update (storage on disk): show what it found. */
function syncFromStore() {
  if (!view || updating || FIXED_RUN || !useDisk()) return;
  const d = loadData(), pos = position();
  const newer = layers.filter((l) => d[l.id]?.snap && d[l.id].fetched > (held.get(l.id)?.fetched ?? 0));
  if (newer.map(restoreLayer).some(Boolean)) framesChanged(pos);
  describe();
}

// ---------- loading ----------

async function load() {
  loading ??= (async () => {
    if (!document.createElement('canvas').getContext('webgl2')) {
      status('The map needs WebGL2, which this browser has disabled or lacks.', true);
      return;  // not retried: `loading` stays resolved
    }
    await askStorage(els.consent);   // shared with the satellites and radar (storage.js)
    status('Loading map…');
    [maplibregl, wml] = await Promise.all([
      import('../vendor/maplibre-gl/maplibre-gl.mjs'),
      import('../vendor/weather-map-layer/index.mjs'),
    ]);
    colorScales = colorScaleOverrides(PRECIP_MAP.colormap, wml);
    installProtocol(maplibregl, wml, { cache: createBlockCache(wml), bounds: PRECIP_MAP.bounds, colorScales });
    installIemProtocol(maplibregl, wml, {
      colorScale: REFLECTIVITY_SCALE, bounds: PRECIP_MAP.bounds, clutterMap: PRECIP_MAP.radar.removeClutter ? CLUTTER : null,
    });
    const [w, s, e, n] = PRECIP_MAP.bounds;
    const padLon = (e - w) * 0.15, padLat = (n - s) * 0.15;
    view = new MapView(els.map, {
      maplibregl, basemaps: BASEMAPS, basemap: BASEMAPS[prefs.basemap] ? prefs.basemap : DEFAULT_BASEMAP,
      dark: isDark(), units: getUnitSystem(),
      center: PRECIP_MAP.center, zoom: PRECIP_MAP.zoom, minZoom: PRECIP_MAP.minZoom, maxZoom: PRECIP_MAP.maxZoom,
      maxBounds: [[w - padLon, s - padLat], [e + padLon, n + padLat]],
      markers: PRECIP_MAP.markers,
    });
    view.onClick((ll) => {
      probe = { lng: ll.lng, lat: ll.lat, label: `${ll.lat.toFixed(2)}°, ${ll.lng.toFixed(2)}°` };
      updateProbe();
    });
    await view.ready;
    await setQuantity(prefs.quantity);
    setInterval(() => { if (!updating && layers.length) describe(); }, TICK_MS);
    window.addEventListener('storage', (e) => { if (e.key === DATA_KEY) syncFromStore(); });
  })().catch((err) => {
    console.error(err);
    status(`Map failed to load: ${err.message}`, true);
    loading = null;
  });
  return loading;
}

let onScreen = false;

export function initPrecip(section) {
  root = section;
  els = {
    qty: $('#pm-qty'), model: $('#pm-model'), base: $('#pm-base'), map: $('#pm-map'), consent: $('#pm-consent'),
    slider: $('#pm-slider'), play: $('#pm-play'), now: $('#pm-now'), prev: $('#pm-prev'), next: $('#pm-next'), time: $('#pm-time'),
    value: $('#pm-value'), legend: $('#pm-legend'), legendUnit: $('#pm-legend-unit'), status: $('#pm-status'),
    update: $('#pm-update'),
  };
  els.update.addEventListener('click', update);
  syncUpdate();
  seg(els.qty, PRECIP_MAP.quantities, prefs.quantity, 'qty');
  renderModels();
  seg(els.base, Object.entries(BASEMAPS).map(([id, b]) => ({ id, label: b.label })), prefs.basemap, 'base');

  els.qty.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-qty]');
    if (b && view && b.dataset.qty !== prefs.quantity) setQuantity(b.dataset.qty);
  });
  els.model.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-model]');
    if (b && view && !isRadar() && b.dataset.model !== prefs.model) setModel(b.dataset.model);
  });
  els.base.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-base]');
    if (!b) return;
    prefs.basemap = b.dataset.base; savePrefs();
    seg(els.base, Object.entries(BASEMAPS).map(([id, x]) => ({ id, label: x.label })), prefs.basemap, 'base');
    view?.setBasemap(prefs.basemap, isDark());
  });
  els.slider.addEventListener('input', () => { stop(); show(Number(els.slider.value)); });
  els.play.addEventListener('click', () => { if (view) play(); });
  els.prev.addEventListener('click', () => { if (view) { stop(); show(idx - 1); } });
  els.next.addEventListener('click', () => { if (view) { stop(); show(idx + 1); } });
  els.now.addEventListener('click', () => { stop(); probe = null; show(nowIndex()); });
  // The °F/°C switch in the weather section sets units here too: legend, readout, scale bar.
  window.addEventListener('units-change', () => {
    view?.setUnits(getUnitSystem());
    if (layers.length) { renderLegendNow(); updateProbe(); }
  });

  // Collapsing or hiding the section pauses playback (scrolling away does not).
  new MutationObserver(() => {
    if (section.classList.contains('collapsed') || section.hidden) stop();
  }).observe(section, { attributes: true, attributeFilter: ['class', 'hidden'] });

  // Load when the section body is actually visible (not collapsed or hidden).
  new IntersectionObserver((entries) => {
    onScreen = entries.some((e) => e.isIntersecting);
    if (onScreen) { load(); view?.resize(); }
  }).observe(els.map.parentElement);
}

/** Theme changed: swap to the matching basemap and data palettes. */
export function rerender() {
  if (!view) return;
  view.setBasemap(prefs.basemap, isDark());
  renderLegendNow();
}
