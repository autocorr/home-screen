// One storage choice for all downloaded data: satellite orbital elements, forecast map
// blocks and radar tiles. Asked once (in whichever section needs it first: the map
// when it loads, the satellites on Update); changeable in Settings → Data storage.
//   - 'disk':   each kind goes into its own Cache Storage cache (CACHES), pruned by
//               age and size (LIMITS). Survives reloads, so reopening the page
//               re-downloads nothing it has already seen. Choosing it also asks the
//               browser to make this site's storage persistent (navigator.storage
//               .persist), so it is not evicted under storage pressure; Firefox may
//               show a permission prompt for that, Chromium decides silently.
//   - 'memory': nothing is written to disk; every page load re-downloads.
// Small bookkeeping (preferences, CelesTrak's download times and refusals) stays in
// localStorage either way.

const KEY = 'storage:v1';            // localStorage: 'disk' | 'memory' (unset = not asked yet)
const OLD_KEY = 'map:storage';       // the map's own choice before it was shared

export const CACHES = { sats: 'sats-v1', map: 'map-blocks-v1', radar: 'radar-tiles-v1' };
export const LIMITS = {
  map: { mb: 300, h: 48 },           // forecast blocks: runs older than 48 h are of no use
  radar: { mb: 50, h: 6 },           // the timeline shows 2 h of scans
};
const STORED_AT = 'X-Stored-At';     // header on entries this module writes
const PRUNE_DELAY_MS = 30e3;         // batch pruning: at most one scan per cache per 30 s

export const diskCacheAvailable = () => typeof caches !== 'undefined' && isSecureContext;

export function getStoragePref() {
  try {
    let v = localStorage.getItem(KEY);
    if (v === null) {
      v = localStorage.getItem(OLD_KEY);
      if (v === 'disk' || v === 'memory') localStorage.setItem(KEY, v);
      localStorage.removeItem(OLD_KEY);
    }
    return v === 'disk' || v === 'memory' ? v : null;
  } catch { return null; }
}

/** Whether data should be written to (and read from) Cache Storage now. */
export const useDisk = () => getStoragePref() === 'disk' && diskCacheAvailable();

const listeners = new Set();
/** cb(pref) after the choice changes, in this tab or another. */
export const onStoragePref = (cb) => listeners.add(cb);
const changed = () => { const p = getStoragePref(); listeners.forEach((cb) => cb(p)); settle(); };
if (typeof window !== 'undefined') window.addEventListener('storage', (e) => { if (e.key === KEY) changed(); });

export async function setStoragePref(pref) {
  try { localStorage.setItem(KEY, pref); } catch { /* ignore */ }
  if (pref === 'disk') {
    // Don't wait for it: Firefox asks the user, and the promise stays pending until
    // they answer (forever if they ignore the prompt), which would stall Update.
    try { navigator.storage?.persist?.()?.catch(() => {}); } catch { /* ignore */ }
  } else {
    await clearCaches();
  }
  changed();
}

export async function clearCaches() {
  if (!diskCacheAvailable()) return;
  await Promise.all(Object.values(CACHES).map((n) => caches.delete(n).catch(() => {})));
}

// ---------- asking ----------

const prompts = new Set();   // consent elements on show
let waiting = null;          // { promise, resolve } while not yet decided

function settle() {
  if (!getStoragePref()) return;
  prompts.forEach((el) => { el.hidden = true; });
  prompts.clear();
  waiting?.resolve(getStoragePref());
  waiting = null;
}

/**
 * Ask for the storage choice in `el` unless it is made already. Resolves to the
 * choice once it is made (here, in another section's prompt, or in another tab).
 */
export function askStorage(el) {
  if (getStoragePref() || !diskCacheAvailable()) return Promise.resolve(getStoragePref());
  if (!waiting) {
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    waiting = { promise, resolve };
  }
  if (!prompts.has(el)) {
    prompts.add(el);
    el.hidden = false;
    el.innerHTML =
      `<p><b>Keep downloaded data in this browser?</b> Satellite orbital elements, forecast map data ` +
      `(up to ${LIMITS.map.mb} MB, kept ${LIMITS.map.h} h) and radar images (up to ${LIMITS.radar.mb} MB, ` +
      `kept ${LIMITS.radar.h} h) are stored in this browser's Cache Storage, so reloading the page doesn't ` +
      `download them again. Your browser may also ask to allow persistent storage. With memory only, ` +
      `nothing is written to disk and each page load starts empty. Change this any time in ⚙ Settings.</p>` +
      `<div class="set-actions"><button type="button" class="btn" data-pref="memory">Memory only</button>` +
      `<button type="button" class="btn btn-primary" data-pref="disk">Allow storage</button></div>`;
    el.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-pref]');
      if (b) setStoragePref(b.dataset.pref);
    });
  }
  return waiting.promise;
}

// ---------- cache maintenance ----------

/**
 * Delete old and excess entries of one cache, oldest first. Entry age comes from
 * `timeHeader` (ms since epoch), size from Content-Length.
 */
export async function pruneCache(name, { mb, h }, timeHeader = STORED_AT) {
  if (!diskCacheAvailable() || !(await caches.has(name))) return { bytes: 0, entries: 0, removed: 0 };
  const maxBytes = mb * 2 ** 20, maxAgeMs = h * 3600e3;
  const cache = await caches.open(name);
  const now = Date.now();
  const entries = [];
  for (const req of await cache.keys()) {
    const r = await cache.match(req);
    if (!r) continue;
    entries.push({ req, size: +r.headers.get('Content-Length') || 0, t: +r.headers.get(timeHeader) || 0 });
  }
  entries.sort((a, b) => a.t - b.t);
  let bytes = entries.reduce((s, e) => s + e.size, 0);
  let removed = 0;
  for (const e of entries) {
    if (now - e.t < maxAgeMs && bytes <= maxBytes * 0.9) break;
    await cache.delete(e.req).catch(() => {});
    bytes -= e.size; removed++;
  }
  return { bytes, entries: entries.length - removed, removed };
}

const pruneTimers = new Map();
/** Prune a cache soon (one scan for a burst of writes). */
export function schedulePrune(name, limits, timeHeader) {
  if (pruneTimers.has(name)) return;
  pruneTimers.set(name, setTimeout(() => {
    pruneTimers.delete(name);
    pruneCache(name, limits, timeHeader).catch((e) => console.warn(`${name} prune failed`, e));
  }, PRUNE_DELAY_MS));
}

export async function cacheStats(name) {
  if (!diskCacheAvailable() || !(await caches.has(name))) return { bytes: 0, entries: 0 };
  const cache = await caches.open(name);
  let bytes = 0, entries = 0;
  for (const req of await cache.keys()) {
    const r = await cache.match(req);
    bytes += +r?.headers.get('Content-Length') || 0; entries++;
  }
  return { bytes, entries };
}

/** Store a body (Blob or string) under `key`, stamped with the time and its size. */
export async function putCached(name, key, body) {
  const blob = body instanceof Blob ? body : new Blob([body], { type: 'application/json' });
  const headers = { 'Content-Type': blob.type, 'Content-Length': String(blob.size), [STORED_AT]: String(Date.now()) };
  await (await caches.open(name)).put(key, new Response(blob, { headers }));
}

export async function getCached(name, key) {
  if (!diskCacheAvailable()) return null;
  return (await (await caches.open(name)).match(key)) ?? null;
}

/**
 * fetch(), served from and saved to the `name` cache when storage is on disk. For
 * immutable URLs only: a stored answer is used without asking the server again.
 */
export async function cachedFetch(name, limits, url, opts) {
  if (!useDisk()) return fetch(url, opts);
  const hit = await getCached(name, url).catch(() => null);
  if (hit) return hit;
  const r = await fetch(url, opts);
  if (r.ok) {
    r.clone().blob()
      .then((b) => putCached(name, url, b))
      .then(() => schedulePrune(name, limits))
      .catch(() => {});
  }
  return r;
}

// ---------- settings ----------

const fmtMB = (b) => `${(b / 2 ** 20).toFixed(b < 2 ** 20 ? 2 : 1)} MB`;

/** Data storage controls in the Settings dialog. */
export function initStorageSettings(dialog) {
  const segEl = dialog.querySelector('#set-storage');
  const usage = dialog.querySelector('#set-storage-usage');
  const sync = async () => {
    const pref = getStoragePref();
    segEl.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.pref === pref)));
    if (!diskCacheAvailable()) { usage.textContent = 'Cache Storage is unavailable here (needs https or localhost).'; return; }
    const [sats, map, radar, persisted] = await Promise.all([
      ...[CACHES.sats, CACHES.map, CACHES.radar].map((n) => cacheStats(n).catch(() => ({ bytes: 0, entries: 0 }))),
      navigator.storage?.persisted?.().catch(() => false) ?? false,
    ]);
    usage.textContent = `On disk: satellite elements ${sats.entries ? fmtMB(sats.bytes) : 'none'}; ` +
      `forecast map ${fmtMB(map.bytes)} in ${map.entries} blocks (limit ${LIMITS.map.mb} MB, ${LIMITS.map.h} h); ` +
      `radar ${fmtMB(radar.bytes)} in ${radar.entries} tiles (limit ${LIMITS.radar.mb} MB, ${LIMITS.radar.h} h). ` +
      `Persistent storage: ${persisted ? 'granted' : 'not granted'}.` +
      (pref === null ? ' Not chosen yet: you will be asked when the map first loads or on a satellite Update.' : '');
  };
  segEl.addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-pref]');
    if (!b) return;
    await setStoragePref(b.dataset.pref);
    await sync();
  });
  dialog.querySelector('#set-storage-clear').addEventListener('click', async () => { await clearCaches(); sync(); });
  document.getElementById('open-settings').addEventListener('click', sync);
}
