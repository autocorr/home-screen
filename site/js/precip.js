// Precipitation map section: Open-Meteo model precipitation over a cut-out
// around Socorro, on an OpenStreetMap basemap. The map libraries (~4 MB incl.
// WASM) load only once the section is on screen and expanded.
import { PRECIP_MAP, SOCORRO, TZ } from './config.js';
import { getUnitSystem } from './weather.js';
import { BASEMAPS, DEFAULT_BASEMAP } from './map/basemaps.js';
import { MapView, renderLegend } from './map/view.js';
import { installProtocol, openMeteoForecastLayer } from './map/openmeteo.js';
import { colorScaleOverrides } from './map/colormaps.js';
import {
  clearDiskCache, diskCacheStats, createBlockCache, diskCacheAvailable, getStoragePref, setStoragePref, DISK_MAX_MB, DISK_MAX_AGE_H,
} from './map/storage.js';

const PREFS_KEY = 'precip:v1';
const PLAY_STEP_MS = 700;
const POLL_TICK_MS = 60e3;   // how often to ask the layer if latest.json is due (it throttles itself)

const prefs = (() => {
  let p; try { p = JSON.parse(localStorage.getItem(PREFS_KEY)); } catch { p = null; }
  const out = { model: PRECIP_MAP.models[0].id, basemap: DEFAULT_BASEMAP, ...p };
  // A saved model that is no longer offered falls back to the default.
  if (!PRECIP_MAP.models.some((m) => m.id === out.model)) out.model = PRECIP_MAP.models[0].id;
  return out;
})();
const savePrefs = () => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* ignore */ } };

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

const rate = (mmh) => {
  if (mmh == null) return '—';
  if (mmh < 0.01) return 'dry';
  if (getUnitSystem() === 'metric') return `${mmh < 1 ? mmh.toFixed(2) : mmh.toFixed(1)} mm/h`;
  const inh = mmh / 25.4;
  return `${inh < 0.1 ? inh.toFixed(3) : inh.toFixed(2)} in/h`;
};
const tickFmt = (mmh) => (getUnitSystem() === 'metric'
  ? String(+mmh.toPrecision(2)) : String(+(mmh / 25.4).toPrecision(1)));

let view = null, layer = null, wml = null, maplibregl = null;
let root, els, times = [], idx = 0, playing = false, probe = null, loading = null;

const $ = (sel) => root.querySelector(sel);

function seg(el, items, current, attr) {
  el.innerHTML = items.map((i) =>
    `<button type="button" data-${attr}="${i.id}" title="${i.title ?? ''}" aria-pressed="${i.id === current}">${i.label}</button>`).join('');
}

function status(msg, isError = false) {
  els.status.textContent = msg;
  els.status.classList.toggle('error', isError);
}

function describe() {
  const run = layer?.run;
  const model = PRECIP_MAP.models.find((m) => m.id === prefs.model);
  const cache = getStoragePref() === 'disk' ? 'disk cache' : 'memory cache only';
  const data = run ? `${model.label} ${layer.fixed ? 'archived ' : ''}run ${runFmt(run)} (${dtFmt.format(run)} MT)` : model.label;
  status(`${data} · ${cache}`);
  els.status.title = crossOriginIsolated ? 'Cross-origin isolated: data shared with render workers'
    : 'Not cross-origin isolated: each render worker gets a copy of the (small) cut-out';
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
  // Precipitation frames are "hour ending at": show the frame covering now.
  const now = Date.now();
  const i = times.findIndex((t) => t >= now);
  return i < 0 ? times.length - 1 : i;
}

async function show(i) {
  if (!times.length) return;
  idx = Math.max(0, Math.min(times.length - 1, i));
  els.slider.value = String(idx);
  syncStepButtons();
  const t = times[idx];
  const frame = view.frameOf(layer.id, t);
  const lead = layer.run ? Math.round((t - layer.run) / 3600e3) : null;
  const step = frame && idx > 0 ? Math.round((times[idx] - times[idx - 1]) / 60e3) : 60;
  els.time.innerHTML = `<b>${dtFmt.format(t)} MT</b> <span class="muted">· ${step >= 60 ? `${step / 60} h` : `${step} min`} ending` +
    `${lead != null ? ` · +${lead} h` : ''}${t < Date.now() ? ' · past' : ''}</span>`;
  const done = view.setTime(t);
  updateProbe();
  return done;
}

async function updateProbe() {
  const frame = view?.frameOf(layer.id);
  const p = probe ?? { lng: SOCORRO.lon, lat: SOCORRO.lat, label: 'Socorro' };
  if (!frame) { els.value.textContent = ''; return; }
  const key = frame.key;
  await view.whenReady();  // values are sampled from the loaded frame data
  const v = await layer.valueAt(frame, p);
  if (view.frameOf(layer.id)?.key !== key) return;
  els.value.textContent = `${p.label}: ${v == null ? '—' : rate(Math.max(0, v))}`;
}

function renderLegendNow() {
  const lg = layer.legend({ dark: isDark() });
  renderLegend(els.legend, lg, tickFmt);
  els.legendUnit.textContent = getUnitSystem() === 'metric' ? 'mm/h' : 'in/h';
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

async function setModel(id) {
  stop();
  prefs.model = id; savePrefs();
  seg(els.model, PRECIP_MAP.models, prefs.model, 'model');
  const t = times[idx];
  if (layer) view.removeLayer(layer.id);
  const m = PRECIP_MAP.models.find((x) => x.id === id) ?? PRECIP_MAP.models[0];
  layer = openMeteoForecastLayer({ wml, model: m.id, label: `${m.label} precipitation`, run: FIXED_RUN, colorScales });
  status(`Loading ${m.label}…`);
  try {
    await layer.refresh({ force: true });
  } catch (err) { status(`Could not load ${m.label}: ${err.message}`, true); return; }
  view.addLayer(layer);
  syncTimeline();
  renderLegendNow();
  describe();
  const want = t ?? START_TIME?.getTime();
  const keep = want != null ? times.indexOf(want) : -1;
  show(keep >= 0 ? keep : nowIndex());
}

async function poll() {
  if (!layer || document.visibilityState !== 'visible' || !onScreen) return;
  try {
    if (await layer.refresh()) {
      const t = times[idx];
      view.refreshed(layer.id);
      syncTimeline();
      describe();
      const keep = times.indexOf(t);
      show(keep >= 0 ? keep : nowIndex());
    }
  } catch (err) { console.warn('precip map refresh failed', err); }
}

// ---------- loading & storage permission ----------

function askStorage() {
  return new Promise((resolve) => {
    if (getStoragePref() || !diskCacheAvailable()) { resolve(); return; }
    els.consent.hidden = false;
    els.consent.innerHTML =
      `<p><b>Store downloaded map data on disk?</b> Forecast blocks are kept in this browser's ` +
      `Cache Storage (up to ${DISK_MAX_MB} MB, entries older than ${DISK_MAX_AGE_H} h are removed) so reloading ` +
      `the page doesn't download them again. Your browser may also ask to allow persistent storage. ` +
      `Change this any time in ⚙ Settings.</p>` +
      `<div class="set-actions"><button type="button" class="btn" data-pref="memory">Memory only</button>` +
      `<button type="button" class="btn btn-primary" data-pref="disk">Allow disk cache</button></div>`;
    els.consent.addEventListener('click', async (e) => {
      const b = e.target.closest('button[data-pref]');
      if (!b) return;
      els.consent.hidden = true;
      await setStoragePref(b.dataset.pref);
      resolve();
    }, { once: false });
  });
}

async function load() {
  loading ??= (async () => {
    if (!document.createElement('canvas').getContext('webgl2')) {
      status('The map needs WebGL2, which this browser has disabled or lacks.', true);
      return;  // not retried: `loading` stays resolved
    }
    await askStorage();
    status('Loading map…');
    [maplibregl, wml] = await Promise.all([
      import('../vendor/maplibre-gl/maplibre-gl.mjs'),
      import('../vendor/weather-map-layer/index.mjs'),
    ]);
    colorScales = colorScaleOverrides(PRECIP_MAP.colormap, wml);
    installProtocol(maplibregl, wml, { cache: createBlockCache(wml), bounds: PRECIP_MAP.bounds, colorScales });
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
    await setModel(prefs.model);
    setInterval(poll, POLL_TICK_MS);
    document.addEventListener('visibilitychange', poll);
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
    model: $('#pm-model'), base: $('#pm-base'), map: $('#pm-map'), consent: $('#pm-consent'),
    slider: $('#pm-slider'), play: $('#pm-play'), now: $('#pm-now'), prev: $('#pm-prev'), next: $('#pm-next'), time: $('#pm-time'),
    value: $('#pm-value'), legend: $('#pm-legend'), legendUnit: $('#pm-legend-unit'), status: $('#pm-status'),
  };
  seg(els.model, PRECIP_MAP.models, prefs.model, 'model');
  seg(els.base, Object.entries(BASEMAPS).map(([id, b]) => ({ id, label: b.label })), prefs.basemap, 'base');

  els.model.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-model]');
    if (b && view && b.dataset.model !== prefs.model) setModel(b.dataset.model);
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
    if (layer) { renderLegendNow(); updateProbe(); }
  });

  // Load when the section body is actually visible (not collapsed or hidden).
  new IntersectionObserver((entries) => {
    onScreen = entries.some((e) => e.isIntersecting);
    if (onScreen) { load(); view?.resize(); poll(); }
  }).observe(els.map.parentElement);
}

/** Theme changed: swap to the matching basemap and data palettes. */
export function rerender() {
  if (!view) return;
  view.setBasemap(prefs.basemap, isDark());
  renderLegendNow();
}

/** Map cache controls in the Settings dialog. */
export function initPrecipSettings(dialog) {
  const segEl = dialog.querySelector('#set-map-cache');
  const usage = dialog.querySelector('#set-map-usage');
  const sync = async () => {
    const pref = getStoragePref();
    segEl.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.pref === pref)));
    if (!diskCacheAvailable()) { usage.textContent = 'Cache Storage is unavailable here (needs https or localhost).'; return; }
    const [{ bytes, entries }, persisted] = await Promise.all([
      diskCacheStats().catch(() => ({ bytes: 0, entries: 0 })),
      navigator.storage?.persisted?.().catch(() => false) ?? false,
    ]);
    usage.textContent = `On disk: ${(bytes / 2 ** 20).toFixed(1)} MB in ${entries} blocks (limit ${DISK_MAX_MB} MB, ` +
      `${DISK_MAX_AGE_H} h). Persistent storage: ${persisted ? 'granted' : 'not granted'}.` +
      (pref === null ? ' Not chosen yet: you will be asked when the map first loads.' : '');
  };
  segEl.addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-pref]');
    if (!b) return;
    await setStoragePref(b.dataset.pref);
    await sync();
    usage.textContent += ' Reload to apply.';
  });
  dialog.querySelector('#set-map-clear').addEventListener('click', async () => { await clearDiskCache(); sync(); });
  document.getElementById('open-settings').addEventListener('click', sync);
}
