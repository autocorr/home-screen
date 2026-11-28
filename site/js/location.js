// Observer location for the sections that depend on where you are: satellites,
// Moon, weather and the map readout. Socorro (config.js) by default; Settings →
// Location can switch to the browser's current location instead, which asks the
// browser's permission. With the current location, these sections also show
// times in the browser's own timezone; with Socorro, in Mountain Time. The clocks
// and the VLA sky always use the VLA and Mountain Time.
//
// The last position fix is kept in localStorage, so a reload asks nothing and
// downloads nothing. With permission already granted, each page load also takes
// a fresh fix in the background and keeps it if it moved more than MOVE_KM.
import { SOCORRO, TZ } from './config.js';

const KEY = 'location:v1';   // { mode: 'socorro' | 'current', fix: { lat, lon, height, acc, at } }
const MOVE_KM = 1;           // smaller moves (or within the fix accuracy) keep the stored fix and weather cache
const FIX_OPTS = { enableHighAccuracy: false, timeout: 20e3, maximumAge: 10 * 60e3 };

const SOCORRO_LOC = { ...SOCORRO, short: 'Socorro', current: false, tz: TZ, tzLabel: 'MT' };

/** The browser's IANA timezone (e.g. 'America/Los_Angeles'), or TZ if it can't be read. */
export function browserTimeZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || TZ; } catch { return TZ; }
}

/** A short label for `tz`: 'MT', 'PT', 'UTC', 'HST', else its UTC offset, e.g. 'GMT+1' or 'GMT+9'. */
export function tzAbbrev(tz) {
  if (tz === TZ) return 'MT';
  if (/^(Etc\/)?(UTC|GMT|Universal|Zulu)$/.test(tz)) return 'UTC';
  const part = (style) => {
    try {
      return new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: style })
        .formatToParts(new Date()).find((x) => x.type === 'timeZoneName')?.value;
    } catch { return null; }
  };
  // "PT", "CT", "ET", "MT" where English has one; else "GMT+1" ("Germany Time" is too long).
  const generic = part('shortGeneric');
  return generic && generic.length <= 4 ? generic : part('short') || tz;
}

export const geolocationAvailable = () =>
  typeof navigator !== 'undefined' && 'geolocation' in navigator && isSecureContext;

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY));
    if (s?.fix && !Number.isFinite(s.fix.lat)) s.fix = null;
    return s && (s.mode === 'socorro' || s.mode === 'current') ? s : { mode: 'socorro', fix: null };
  } catch { return { mode: 'socorro', fix: null }; }
}
let state = load();
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* ignore */ } };

const fmtCoord = (lat, lon) =>
  `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? 'N' : 'S'} ${Math.abs(lon).toFixed(2)}°${lon >= 0 ? 'E' : 'W'}`;

/**
 * The location in use: { name, short, lat, lon, height (m), current, tz, tzLabel }.
 * `short` is for headings and labels ("Socorro" or "Here"); `tz` is the IANA
 * timezone its times are shown in (the browser's, for the current location) and
 * `tzLabel` its short name ("MT").
 */
export function getLocation() {
  const f = state.mode === 'current' && state.fix;
  if (!f) return SOCORRO_LOC;
  const tz = browserTimeZone();
  return {
    name: `Current location (${fmtCoord(f.lat, f.lon)})`, short: 'Here', lat: f.lat, lon: f.lon, height: f.height,
    current: true, tz, tzLabel: tzAbbrev(tz),
  };
}

const locKey = ({ lat, lon, height, tz }) => `${lat},${lon},${height},${tz}`;

const listeners = new Set();
/** cb(location) after the location in use changes, in this tab or another. */
export const onLocation = (cb) => listeners.add(cb);

let lastKey = '';
function changed() {
  const loc = getLocation();
  const key = locKey(loc);
  labelHeadings(loc);
  if (key === lastKey) return;
  lastKey = key;
  listeners.forEach((cb) => cb(loc));
}

/** Put the location's short name into every [data-loc-name] element, its timezone's into [data-tz-label]. */
function labelHeadings(loc = getLocation()) {
  document.querySelectorAll('[data-loc-name]').forEach((el) => { el.textContent = loc.short; el.title = loc.name; });
  document.querySelectorAll('[data-tz-label]').forEach((el) => { el.textContent = loc.tzLabel; el.title = loc.tz; });
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => { if (e.key === KEY) { state = load(); changed(); } });
}

function distKm(a, b) {
  const R = 6371, d2r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * d2r, dLon = (b.lon - a.lon) * d2r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * d2r) * Math.cos(b.lat * d2r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** One position fix from the browser (may show its permission prompt). */
function requestFix() {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition((p) => {
      const c = p.coords;
      resolve({
        // ~10 m: plenty for weather grids and pass predictions.
        lat: Math.round(c.latitude * 1e4) / 1e4,
        lon: Math.round(c.longitude * 1e4) / 1e4,
        // Most fixes carry no altitude; sea level then (a km off moves a pass by well under a second).
        height: Number.isFinite(c.altitude) ? Math.round(c.altitude) : 0,
        acc: Math.round(c.accuracy),
        at: Date.now(),
      });
    }, (err) => reject(new Error(
      err.code === err.PERMISSION_DENIED ? 'Location permission was denied. Allow it in this site\'s browser settings to use it.'
        : err.code === err.TIMEOUT ? 'The browser took too long to find your location.'
          : `The browser couldn't find your location${err.message ? `: ${err.message}` : ''}.`)), FIX_OPTS);
  });
}

/**
 * Keep `fix` unless it is within MOVE_KM, or the fixes' own uncertainty, of the
 * stored one (then only its time is refreshed). Wi-Fi and IP fixes wander by a few
 * km, and each real change refetches the weather.
 */
function storeFix(fix) {
  const old = state.fix;
  const tol = old ? Math.max(MOVE_KM, (old.acc ?? 0) / 1000, (fix.acc ?? 0) / 1000) : 0;
  state.fix = old && distKm(old, fix) < tol ? { ...old, at: fix.at } : fix;
  save();
}

/** Switch to the current location: ask the browser for a fix. Throws (and keeps the old choice) on failure. */
export async function useCurrentLocation() {
  if (!geolocationAvailable()) throw new Error('Location is unavailable here (needs https or localhost).');
  const fix = await requestFix();
  state.mode = 'current';
  storeFix(fix);
  changed();
}

export function useSocorro() {
  state.mode = 'socorro';
  save();
  changed();
}

async function permissionState() {
  try { return (await navigator.permissions?.query({ name: 'geolocation' }))?.state ?? null; } catch { return null; }
}

// ---------- settings ----------

const ago = (ms) => {
  const m = Math.round((Date.now() - ms) / 60e3);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
};

/** Location controls in the Settings dialog, and the background refresh on load. */
export function initLocation(dialog) {
  const seg = dialog.querySelector('#set-location');
  const refreshBtn = dialog.querySelector('#set-location-refresh');
  const statusEl = dialog.querySelector('#set-location-status');
  let busy = false, error = '';

  const sync = () => {
    const loc = getLocation();
    const mode = loc.current ? 'current' : 'socorro';
    seg.querySelectorAll('button').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.loc === mode));
      b.disabled = busy;
    });
    if (!geolocationAvailable()) seg.querySelector('[data-loc="current"]').disabled = true;
    refreshBtn.hidden = !loc.current;
    refreshBtn.disabled = busy;
    statusEl.classList.toggle('error', Boolean(error));
    statusEl.textContent = busy ? 'Asking the browser for your location…'
      : error || (!geolocationAvailable() ? 'Current location is unavailable here (needs https or localhost).'
        : loc.current ? `${loc.name}, ±${state.fix.acc} m, found ${ago(state.fix.at)}. Times in this browser's timezone, ${loc.tz} (${loc.tzLabel}). Stored in this browser only.`
          : `${loc.name} (${fmtCoord(loc.lat, loc.lon)}).`);
  };

  const ask = async () => {
    busy = true; error = ''; sync();
    try { await useCurrentLocation(); } catch (e) { error = e.message; }
    busy = false; sync();
  };

  seg.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-loc]');
    if (!b || busy) return;
    if (b.dataset.loc === 'current') ask();
    else { error = ''; useSocorro(); sync(); }
  });
  refreshBtn.addEventListener('click', ask);
  document.getElementById('open-settings').addEventListener('click', sync);
  onLocation(sync);

  lastKey = locKey(getLocation());
  labelHeadings();
  sync();

  // Refresh the fix on load, but only where that can't show a prompt.
  if (state.mode === 'current' && geolocationAvailable()) {
    permissionState().then((p) => {
      if (p !== 'granted') return;
      requestFix().then((fix) => { if (state.mode === 'current') { storeFix(fix); changed(); sync(); } })
        .catch((e) => console.warn('Location refresh failed:', e.message));
    });
  }
}
