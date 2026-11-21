// Weather + air quality for Socorro from Open-Meteo, cached in localStorage.
import { SOCORRO, TZ, WX_MAX_AGE_MIN } from './config.js';
import { makeChart, bars, fmtTime } from './charts.js';

const CACHE_KEY = 'wx:v3';
const UNITS_KEY = 'wx:units';
const RANGE_KEY = 'wx:range';

// Request budget. Open-Meteo bills "API calls" fractionally: a request counts
// as (variables / 10) x (days / 14) calls, at least 1. Keep these lists to
// what the page actually shows. 15-minutely data is native RRFS over North
// America and interpolated from hourly past its horizon (seamless best_match).
const MINUTELY_15 = [
  'temperature_2m', 'apparent_temperature', 'dew_point_2m', 'relative_humidity_2m',
  'precipitation', 'snowfall', 'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m',
  'visibility', 'shortwave_radiation', 'direct_radiation', 'diffuse_radiation',
  'cape', 'freezing_level_height',
];
const HOURLY = [
  'precipitation_probability', 'weather_code', 'pressure_msl', 'surface_pressure',
  'cloud_cover', 'cloud_cover_low', 'cloud_cover_mid', 'cloud_cover_high',
  'uv_index', 'uv_index_clear_sky', 'is_day', 'total_column_integrated_water_vapour',
];
const DAILY = [
  'weather_code', 'temperature_2m_max', 'temperature_2m_min', 'precipitation_sum',
  'precipitation_probability_max', 'wind_gusts_10m_max', 'uv_index_max', 'sunrise', 'sunset',
];
const AQ_HOURLY = [
  'us_aqi', 'pm2_5', 'pm10', 'dust', 'ozone', 'nitrogen_dioxide', 'sulphur_dioxide',
  'carbon_monoxide', 'aerosol_optical_depth',
];
const PAST_DAYS = 1, FORECAST_DAYS = 7, AQ_FORECAST_DAYS = 5;

function urls() {
  const common = `latitude=${SOCORRO.lat}&longitude=${SOCORRO.lon}` +
    `&timezone=${encodeURIComponent(TZ)}&timeformat=unixtime&past_days=${PAST_DAYS}`;
  return {
    forecast: `https://api.open-meteo.com/v1/forecast?${common}&forecast_days=${FORECAST_DAYS}` +
      `&minutely_15=${MINUTELY_15}&hourly=${HOURLY}&daily=${DAILY}`,
    air: `https://air-quality-api.open-meteo.com/v1/air-quality?${common}` +
      `&forecast_days=${AQ_FORECAST_DAYS}&hourly=${AQ_HOURLY}`,
  };
}

/** Estimated Open-Meteo API-call cost of one refresh (both requests). */
export function apiCost() {
  const cost = (vars, days) => Math.max(1, vars / 10) * Math.max(1, days / 14);
  return {
    forecast: cost(MINUTELY_15.length + HOURLY.length + DAILY.length, PAST_DAYS + FORECAST_DAYS),
    air: cost(AQ_HOURLY.length, PAST_DAYS + AQ_FORECAST_DAYS),
  };
}

// ---------- cache ----------
// Responses live in localStorage with the URL they were fetched with. Rather
// than a fixed expiry, we ask Open-Meteo when its models last published a run
// (static meta.json files: tiny, CORS-enabled, not rate-limited) and refetch a
// dataset only when a run newer than our copy exists. Fallbacks: if the
// metadata can't be read, refetch after WX_MAX_AGE_MIN; always after MAX_AGE_H.
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
};

// Models that can feed the seamless best_match forecast over New Mexico, and
// the air-quality model. A newer run of any of them triggers a refetch.
const RUN_SOURCES = {
  forecast: { host: 'api.open-meteo.com',
    models: ['ncep_hrrr_conus', 'ncep_rrfs_conus', 'ncep_nbm_conus', 'ncep_gfs013'] },
  air: { host: 'air-quality-api.open-meteo.com', models: ['cams_global'] },
};
const META_CHECK_MIN = 5;  // don't poll metadata more often than this
const MAX_AGE_H = 6;

async function fetchJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  const j = await r.json();
  if (j.error) throw new Error(j.reason || 'API error');
  const cost = parseFloat(r.headers.get('x-ratelimit-cost'));
  return { json: j, cost: Number.isFinite(cost) ? cost : null };
}

/** Newest available run among `models`: { model, init, avail } (unix s) or null. */
async function latestRun({ host, models }) {
  const metas = await Promise.allSettled(models.map((m) =>
    fetch(`https://${host}/data/${m}/static/meta.json`, { cache: 'no-cache' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status))))
      .then((j) => ({ model: m, init: j.last_run_initialisation_time, avail: j.last_run_availability_time }))));
  const ok = metas.filter((m) => m.status === 'fulfilled' && m.value.avail).map((m) => m.value);
  return ok.length ? ok.reduce((a, b) => (b.avail > a.avail ? b : a)) : null;
}

let lastMetaCheck = 0;
/** Which datasets need refetching: { forecast: bool, air: bool, runs }. */
async function whatIsStale(c, force) {
  const u = urls();
  const need = { forecast: force, air: force, runs: {} };
  const ageMin = (t) => (Date.now() - (t ?? 0)) / 60e3;
  const missing = (k) => !c?.[k] || c.urls?.[k] !== u[k] || ageMin(c.fetched?.[k]) > MAX_AGE_H * 60;
  need.forecast ||= missing('forecast');
  need.air ||= missing('air');
  if (!force && Date.now() - lastMetaCheck < META_CHECK_MIN * 60e3) return need;
  lastMetaCheck = Date.now();
  // Always read run metadata (it also labels the status line), in parallel.
  const runs = await Promise.all(['forecast', 'air'].map((k) => latestRun(RUN_SOURCES[k]).catch(() => null)));
  ['forecast', 'air'].forEach((k, i) => {
    const run = runs[i];
    if (run) need.runs[k] = run;
    if (need[k]) return;
    need[k] = run ? run.avail * 1000 > c.fetched[k] : ageMin(c.fetched[k]) > WX_MAX_AGE_MIN;
  });
  return need;
}

async function fetchStale(need) {
  const u = urls();
  const c = store.get(CACHE_KEY) || {};
  const next = { ...c, urls: { ...c.urls }, fetched: { ...c.fetched }, cost: { ...c.cost },
    runs: { ...c.runs, ...need.runs } };
  const jobs = ['forecast', 'air'].filter((k) => need[k]).map(async (k) => {
    const r = await fetchJSON(u[k]);
    next[k] = r.json; next.urls[k] = u[k]; next.fetched[k] = Date.now(); next.cost[k] = r.cost;
  });
  const res = await Promise.allSettled(jobs);
  const failed = res.find((r) => r.status === 'rejected');
  if (!next.forecast) throw failed?.reason ?? new Error('no data');
  next.fetchedAt = next.fetched.forecast;
  store.set(CACHE_KEY, next);
  if (failed) console.warn('Partial weather update:', failed.reason);
  return next;
}

// ---------- units ----------
const UNITS = {
  imperial: {
    temp: { u: '°F', f: (c) => c * 9 / 5 + 32, d: 0 },
    speed: { u: 'mph', f: (k) => k / 1.609344, d: 0 },
    precip: { u: 'in', f: (mm) => mm / 25.4, d: 2 },
    snow: { u: 'in', f: (cm) => cm / 2.54, d: 1 },
    depth: { u: 'in', f: (m) => m / 0.0254, d: 1 },
    dist: { u: 'mi', f: (m) => m / 1609.344, d: 1 },
    height: { u: 'ft', f: (m) => m / 0.3048, d: 0 },
  },
  metric: {
    temp: { u: '°C', f: (c) => c, d: 1 },
    speed: { u: 'm/s', f: (k) => k / 3.6, d: 1 },
    precip: { u: 'mm', f: (mm) => mm, d: 1 },
    snow: { u: 'cm', f: (cm) => cm, d: 1 },
    depth: { u: 'cm', f: (m) => m * 100, d: 0 },
    dist: { u: 'km', f: (m) => m / 1000, d: 1 },
    height: { u: 'm', f: (m) => m, d: 0 },
  },
};
const FIXED = {
  pct: { u: '%', f: (x) => x, d: 0 },
  hpa: { u: 'hPa', f: (x) => x, d: 0 },
  uv: { u: '', f: (x) => x, d: 1 },
  wm2: { u: 'W/m²', f: (x) => x, d: 0 },
  pwv: { u: 'mm', f: (x) => x, d: 1 }, // kg/m² == mm of water
  deg: { u: '°', f: (x) => x, d: 0 },
  jkg: { u: 'J/kg', f: (x) => x, d: 0 },
  kpa: { u: 'kPa', f: (x) => x, d: 2 },
  ugm3: { u: 'µg/m³', f: (x) => x, d: 1 },
  aqi: { u: '', f: (x) => x, d: 0 },
  aod: { u: '', f: (x) => x, d: 2 },
};
let unitSystem = store.get(UNITS_KEY) || 'imperial';
const unit = (kind) => UNITS[unitSystem][kind] || FIXED[kind];
const conv = (kind, v) => (v == null ? null : unit(kind).f(v));
const fmt = (kind, v, withUnit = true) => {
  if (v == null || Number.isNaN(v)) return '—';
  const U = unit(kind);
  const s = U.f(v).toFixed(U.d);
  return withUnit && U.u ? `${s}${U.u.startsWith('°') || U.u === '%' ? '' : ' '}${U.u}` : s;
};

// ---------- presentation helpers ----------
const WMO = {
  0: ['Clear', '☀️'], 1: ['Mostly clear', '🌤️'], 2: ['Partly cloudy', '⛅'], 3: ['Overcast', '☁️'],
  45: ['Fog', '🌫️'], 48: ['Rime fog', '🌫️'],
  51: ['Light drizzle', '🌦️'], 53: ['Drizzle', '🌦️'], 55: ['Heavy drizzle', '🌧️'],
  56: ['Freezing drizzle', '🌧️'], 57: ['Freezing drizzle', '🌧️'],
  61: ['Light rain', '🌦️'], 63: ['Rain', '🌧️'], 65: ['Heavy rain', '🌧️'],
  66: ['Freezing rain', '🌧️'], 67: ['Freezing rain', '🌧️'],
  71: ['Light snow', '🌨️'], 73: ['Snow', '🌨️'], 75: ['Heavy snow', '❄️'], 77: ['Snow grains', '🌨️'],
  80: ['Light showers', '🌦️'], 81: ['Showers', '🌧️'], 82: ['Violent showers', '⛈️'],
  85: ['Snow showers', '🌨️'], 86: ['Heavy snow showers', '❄️'],
  95: ['Thunderstorm', '⛈️'], 96: ['Thunderstorm, hail', '⛈️'], 99: ['Thunderstorm, hail', '⛈️'],
};
const wmo = (c) => WMO[c] || ['—', ''];
const compass = (deg) =>
  deg == null ? '' : ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'][Math.round(deg / 22.5) % 16];

const AQI_BANDS = [
  [50, 'Good', 'good'], [100, 'Moderate', 'warning'], [150, 'Unhealthy (sensitive)', 'serious'],
  [200, 'Unhealthy', 'critical'], [300, 'Very unhealthy', 'critical'], [Infinity, 'Hazardous', 'critical'],
];
const aqiBand = (v) => AQI_BANDS.find(([max]) => v <= max);
const UV_BANDS = [
  [2.99, 'Low', 'good'], [5.99, 'Moderate', 'warning'], [7.99, 'High', 'serious'],
  [10.99, 'Very high', 'critical'], [Infinity, 'Extreme', 'critical'],
];
const uvBand = (v) => UV_BANDS.find(([max]) => v <= max);

// ---------- charts ----------
// Each chart: one y-scale only. `src: 'a'` = air quality; otherwise forecast
// (15-minutely if the variable is in MINUTELY_15, else hourly).
const CHARTS = [
  { title: 'Temperature', kind: 'temp', series: [
    ['temperature_2m', 'Air', '--series-2'], ['apparent_temperature', 'Feels like', '--series-4'],
    ['dew_point_2m', 'Dew point', '--series-1']] },
  { title: 'Precipitation probability', kind: 'pct', range: [0, 100], series: [
    ['precipitation_probability', 'Chance', '--series-1']] },
  { title: 'Precipitation (per 15 min)', kind: 'precip', bars: true, min0: true, minMax: 0.5, series: [
    ['precipitation', 'Total', '--series-1']] },
  { title: 'Snowfall (per 15 min)', kind: 'snow', bars: true, min0: true, hideIfZero: true, series: [
    ['snowfall', 'Snowfall', '--series-7']] },
  { title: 'Cloud cover', kind: 'pct', range: [0, 100], series: [
    ['cloud_cover', 'Total', '--text-secondary'], ['cloud_cover_low', 'Low', '--series-1'],
    ['cloud_cover_mid', 'Mid', '--series-2'], ['cloud_cover_high', 'High', '--series-3']] },
  { title: 'Wind', kind: 'speed', min0: true, series: [
    ['wind_speed_10m', 'Speed', '--series-1'], ['wind_gusts_10m', 'Gusts', '--series-2']] },
  { title: 'Wind direction (from)', kind: 'deg', range: [0, 360], yValues: compassTicks, ySplits: () => [0, 90, 180, 270, 360], points: true,
    series: [['wind_direction_10m', 'Direction', '--series-1']] },
  { title: 'Relative humidity', kind: 'pct', range: [0, 100], series: [
    ['relative_humidity_2m', 'RH', '--series-1']] },
  { title: 'Precipitable water vapour', kind: 'pwv', min0: true, series: [
    ['total_column_integrated_water_vapour', 'PWV', '--series-3']] },
  { title: 'Surface pressure', kind: 'hpa', series: [['surface_pressure', 'Surface', '--series-7']] },
  { title: 'Sea-level pressure', kind: 'hpa', series: [['pressure_msl', 'MSL', '--series-7']] },
  { title: 'UV index', kind: 'uv', min0: true, series: [
    ['uv_index', 'Forecast', '--series-5'], ['uv_index_clear_sky', 'Clear sky', '--series-4']] },
  { title: 'Solar radiation', kind: 'wm2', min0: true, series: [
    ['shortwave_radiation', 'Global', '--series-4'], ['direct_radiation', 'Direct', '--series-2'],
    ['diffuse_radiation', 'Diffuse', '--series-1']] },
  { title: 'Visibility', kind: 'dist', min0: true, series: [['visibility', 'Visibility', '--series-1']] },
  { title: 'CAPE (convective energy)', kind: 'jkg', min0: true, series: [['cape', 'CAPE', '--series-8']] },
  { title: 'Freezing level', kind: 'height', series: [['freezing_level_height', 'Height', '--series-1']] },
  { title: 'US Air Quality Index', src: 'a', kind: 'aqi', min0: true, series: [['us_aqi', 'US AQI', '--series-6']] },
  { title: 'Particulates', src: 'a', kind: 'ugm3', min0: true, series: [
    ['pm2_5', 'PM2.5', '--series-1'], ['pm10', 'PM10', '--series-2'], ['dust', 'Dust', '--series-4']] },
  { title: 'Gases', src: 'a', kind: 'ugm3', min0: true, series: [
    ['ozone', 'O₃', '--series-1'], ['nitrogen_dioxide', 'NO₂', '--series-2'],
    ['sulphur_dioxide', 'SO₂', '--series-3']] },
  { title: 'Carbon monoxide', src: 'a', kind: 'ugm3', min0: true, series: [
    ['carbon_monoxide', 'CO', '--series-7']] },
  { title: 'Aerosol optical depth', src: 'a', kind: 'aod', min0: true, series: [
    ['aerosol_optical_depth', 'AOD', '--series-2']] },
];

function compassTicks(u, vals) {
  return vals.map((v) => ({ 0: 'N', 90: 'E', 180: 'S', 270: 'W', 360: 'N' }[v] ?? ''));
}

function nightIntervals(h) {
  const out = [];
  let start = null;
  h.time.forEach((t, i) => {
    if (h.is_day[i] === 0 && start == null) start = t;
    if (h.is_day[i] === 1 && start != null) { out.push([start, t]); start = null; }
  });
  if (start != null) out.push([start, h.time.at(-1) + 3600]);
  return out;
}

// Visible window: [hours before now, hours after now].
const RANGES = { '12h': [2, 12], '24h': [3, 24], '2d': [6, 48], '4d': [6, 96], '7d': [6, 168] };
let rangeKey = store.get(RANGE_KEY) || '24h';
if (!(rangeKey in RANGES) && rangeKey !== 'all') rangeKey = '24h';
function xRange(data) {
  const t = data.forecast.hourly.time;
  if (rangeKey === 'all') return [t[0], t.at(-1)];
  const now = Date.now() / 1000;
  const [before, after] = RANGES[rangeKey];
  return [now - before * 3600, Math.min(t.at(-1) + 3600, now + after * 3600)];
}

// ---------- rendering ----------
let charts = [];
let current = null;

export function initWeather(root) {
  root.querySelector('#wx-units').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-units]');
    if (!b) return;
    unitSystem = b.dataset.units;
    store.set(UNITS_KEY, unitSystem);
    render(root);
  });
  root.querySelector('#wx-range').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-range]');
    if (!b) return;
    rangeKey = b.dataset.range;
    store.set(RANGE_KEY, rangeKey);
    syncButtons(root);
    // The x-scale range function reads rangeKey, so any setScale re-applies it.
    charts.forEach((c) => { const [min, max] = xRange(current); c.setScale('x', { min, max }); });
  });
  root.querySelector('#wx-refresh').addEventListener('click', () => refresh(root, true));

  current = store.get(CACHE_KEY);
  if (current?.forecast) render(root); else current = null;
  refresh(root, false);
  // Re-check staleness periodically and whenever the tab comes back.
  setInterval(() => refresh(root, false), 5 * 60e3);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refresh(root, false);
  });
  setInterval(() => updateStatus(root), 30e3);
}

export function rerender(root) { if (current) render(root); }

let inflight = null;
async function refresh(root, force) {
  if (inflight) return inflight;
  const status = root.querySelector('#wx-status');
  inflight = (async () => {
    const need = await whatIsStale(current, force);
    if (!need.forecast && !need.air) {
      // Nothing new upstream; just remember what we learned about model runs.
      if (Object.keys(need.runs).length && current) {
        current.runs = { ...current.runs, ...need.runs };
        store.set(CACHE_KEY, current);
        updateStatus(root);
      }
      return;
    }
    status.textContent = 'Updating…';
    current = await fetchStale(need);
    render(root);
  })().catch((err) => {
    status.textContent = current
      ? `Update failed (${err.message}); showing data from ${ago(current.fetchedAt)}.`
      : `Could not load weather: ${err.message}`;
  }).finally(() => { inflight = null; });
  return inflight;
}

const ago = (ms) => {
  const m = Math.round((Date.now() - ms) / 60e3);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};

const RUN_NAMES = {
  ncep_hrrr_conus: 'HRRR', ncep_rrfs_conus: 'RRFS', ncep_nbm_conus: 'NBM', ncep_gfs013: 'GFS',
  cams_global: 'CAMS',
};
const runLabel = (r) => r && `${RUN_NAMES[r.model] ?? r.model} ${new Date(r.init * 1000).toISOString().slice(11, 13)}Z`;

function updateStatus(root) {
  if (!current) return;
  const el = root.querySelector('#wx-status');
  const run = runLabel(current.runs?.forecast);
  el.textContent = `Open-Meteo · fetched ${ago(current.fetchedAt)}${run ? ` · newest run ${run}` : ''}`;
  const est = apiCost();
  const cost = (k) => (current.cost?.[k] ?? est[k]).toFixed(1);
  el.title = `Refetched when Open-Meteo publishes a newer model run (checked every ${META_CHECK_MIN} min)` +
    `${current.runs?.air ? `; air quality: ${runLabel(current.runs.air)}` : ''}. ` +
    `Last request cost: forecast ${cost('forecast')} + air ${cost('air')} API calls.`;
}

function syncButtons(root) {
  root.querySelectorAll('#wx-units button').forEach((b) =>
    b.setAttribute('aria-pressed', String(b.dataset.units === unitSystem)));
  root.querySelectorAll('#wx-range button').forEach((b) =>
    b.setAttribute('aria-pressed', String(b.dataset.range === rangeKey)));
}

function render(root) {
  syncButtons(root);
  updateStatus(root);
  renderCurrent(root.querySelector('#wx-now'));
  renderDaily(root.querySelector('#wx-daily'));
  renderCharts(root.querySelector('#wx-charts'));
}

function tile(label, value, sub = '', status = '') {
  return `<div class="tile"><div class="tile-label">${label}</div>` +
    `<div class="tile-value">${value}</div>` +
    (sub ? `<div class="tile-sub">${status ? `<span class="dot ${status}"></span>` : ''}${sub}</div>` : '') +
    `</div>`;
}

/** Value of `key` at the latest sample at or before now (15-min first, then hourly). */
function nowValue(block, key) {
  if (!block?.[key]) return null;
  const now = Date.now() / 1000;
  let i = block.time.findIndex((t) => t > now) - 1;
  if (i < 0) i = i === -2 ? block.time.length - 1 : 0;
  return block[key][i];
}

function renderCurrent(el) {
  const f = current.forecast;
  const v = (key) => nowValue(f.minutely_15, key) ?? nowValue(f.hourly, key);
  const a = (key) => nowValue(current.air?.hourly, key);
  const [desc, icon] = wmo(v('weather_code'));
  const uvNow = v('uv_index');
  const uv = uvBand(uvNow ?? 0);
  const aqiNow = a('us_aqi');
  const aqi = aqiNow != null ? aqiBand(aqiNow) : null;
  el.innerHTML = [
    `<div class="tile tile-hero">` +
      `<div class="hero"><span class="hero-icon" aria-hidden="true">${icon}</span>` +
      `<span class="hero-temp">${fmt('temp', v('temperature_2m'))}</span></div>` +
      `<div class="tile-sub">${desc} · feels ${fmt('temp', v('apparent_temperature'))}</div></div>`,
    tile('Wind', fmt('speed', v('wind_speed_10m')),
      `${compass(v('wind_direction_10m'))} · gust ${fmt('speed', v('wind_gusts_10m'))}`),
    tile('Humidity', fmt('pct', v('relative_humidity_2m')), `dew pt ${fmt('temp', v('dew_point_2m'))}`),
    tile('Clouds', fmt('pct', v('cloud_cover')), `vis ${fmt('dist', v('visibility'))}`),
    tile('Pressure', fmt('hpa', v('surface_pressure')), `MSL ${fmt('hpa', v('pressure_msl'))}`),
    tile('UV index', fmt('uv', uvNow), uv[1], uv[2]),
    tile('Air quality', aqiNow != null ? fmt('aqi', aqiNow) : '—',
      aqi ? `${aqi[1]} · PM2.5 ${fmt('ugm3', a('pm2_5'))}` : 'unavailable', aqi?.[2]),
    tile('Precip. water', fmt('pwv', v('total_column_integrated_water_vapour')),
      `precip ${fmt('precip', v('precipitation'))} /15 min`),
  ].join('');
}

function nearestIdx(arr, v) {
  let best = 0;
  arr.forEach((x, i) => { if (Math.abs(x - v) < Math.abs(arr[best] - v)) best = i; });
  return best;
}

function renderDaily(el) {
  const d = current.forecast.daily;
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
  const dayFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' });
  const tFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true });
  // Sunrise is always AM and sunset PM in Socorro, so drop the suffix to save width.
  const hm = (sec) => tFmt.format(new Date(sec * 1000)).replace(/\s?[AP]M$/, '');
  el.innerHTML = d.time.map((t, i) => {
    const date = new Date(t * 1000);
    const iso = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(date);
    if (iso < today) return '';
    const [desc, icon] = wmo(d.weather_code[i]);
    return `<div class="day${iso === today ? ' today' : ''}" title="${desc}">` +
      `<div class="day-name">${iso === today ? 'Today' : dayFmt.format(date)}</div>` +
      `<div class="day-icon" aria-label="${desc}">${icon}</div>` +
      `<div class="day-temps"><b>${fmt('temp', d.temperature_2m_max[i])}</b> ` +
      `<span>${fmt('temp', d.temperature_2m_min[i])}</span></div>` +
      `<div class="day-meta">💧 ${fmt('pct', d.precipitation_probability_max[i])}` +
      `${d.precipitation_sum[i] > 0 ? ` · ${fmt('precip', d.precipitation_sum[i])}` : ''}</div>` +
      `<div class="day-meta" title="Max UV index · max wind gust">UV ${Math.round(d.uv_index_max[i])} · 💨${fmt('speed', d.wind_gusts_10m_max[i], false)}</div>` +
      `<div class="day-meta" title="Sunrise / sunset">☀ ${hm(d.sunrise[i])}–${hm(d.sunset[i])}</div>` +
      `</div>`;
  }).join('');
}

function renderCharts(el) {
  charts.forEach((c) => c.destroy());
  charts = [];
  el.innerHTML = '';
  const f = current.forecast;
  const fh = f.hourly;
  const night = nightIntervals(fh);
  for (const def of CHARTS) {
    // Air quality is hourly; forecast series use 15-minutely data when requested.
    const src = def.src === 'a' ? current.air?.hourly
      : f.minutely_15?.[def.series[0][0]] ? f.minutely_15 : fh;
    if (!src) continue;
    const ys = def.series.map(([key]) => (src[key] || []).map((v) => conv(def.kind, v)));
    if (def.hideIfZero && ys.every((y) => y.every((v) => !v))) continue;
    const U = unit(def.kind);
    const card = document.createElement('figure');
    card.className = 'chart-card';
    card.innerHTML = `<figcaption>${def.title}${U.u ? ` <span class="unit">(${U.u})</span>` : ''}</figcaption><div class="chart"></div>`;
    el.appendChild(card);
    let yRange = def.range;
    if (def.min0) {
      const floor = def.minMax ? U.f(def.minMax) : 0;
      yRange = (u, min, max) => [0, Math.max((max ?? 0) * 1.08, floor) || 1];
    }
    const colorOf = (c) => getComputedStyle(document.documentElement).getPropertyValue(c).trim();
    charts.push(makeChart(card.querySelector('.chart'), {
      data: [src.time, ...ys],
      series: def.series.map(([, label, color]) => ({
        label, color,
        fmt: (v) => (def.kind === 'deg' ? `${v.toFixed(0)}° ${compass(v)}`
          : `${v.toFixed(U.d)}${!U.u ? '' : /^[°%]/.test(U.u) ? U.u : ` ${U.u}`}`),
        paths: def.bars ? bars() : def.points ? () => null : undefined,
        fill: def.bars ? () => colorOf(color) : undefined,
        width: def.bars ? 0 : 2,
        points: def.points ? { show: true, size: 5, width: 0, fill: colorOf(color) } : undefined,
      })),
      yRange,
      yValues: def.yValues,
      ySplits: def.ySplits,
      syncKey: 'wx',
      timeLabel: 'MT',
      now: () => Date.now() / 1000,
      shade: () => night,
      xRange: () => xRange(current),
      height: matchMedia('(max-width: 559px)').matches ? 150 : 170,
    }));
  }
}
