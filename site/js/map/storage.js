// Where map data blocks are cached, and the user's permission for it.
//
// The weather-map-layer reads .om files in byte-range "blocks". Two caches:
//   - 'disk':   Cache Storage (on disk), capped at DISK_MAX_MB and pruned of
//               blocks older than DISK_MAX_AGE_H. Each block is held in RAM
//               only ~1 s after use. Survives reloads, so reopening the page
//               re-downloads nothing for the runs it has already seen.
//   - 'memory': a small in-RAM LRU (MEM_BLOCKS x 64 KiB). Nothing is written
//               to disk, but every page load re-downloads.
// The disk cache is only used after the user allows it (asked once, in the
// map section; changeable in Settings). Allowing it also asks the browser to
// make this site's storage persistent (navigator.storage.persist), which
// stops the browser evicting it under storage pressure; this may show a
// browser permission prompt (Firefox) or be decided silently (Chromium).
//
// Cache keys are a hash of the file URL plus a block index. File URLs name a
// specific model run and valid time, and Open-Meteo never rewrites a
// published file, so cached blocks never go stale; old runs are only removed
// by the age/size pruning below.

const KEY = 'map:storage';           // localStorage: 'disk' | 'memory' (unset = not asked yet)
export const CACHE_NAME = 'map-blocks-v1';
export const DISK_MAX_MB = 300;
export const DISK_MAX_AGE_H = 48;
const BLOCK_SIZE = 64 * 1024 - 1408;  // 64 KiB minus HTTP overhead, as the maps app uses
const MEM_BLOCKS = 256;               // 16 MiB in memory-only mode
const MAINTAIN_DELAY_MS = 30e3;       // batch pruning: at most one scan per 30 s

export function getStoragePref() {
  try { const v = localStorage.getItem(KEY); return v === 'disk' || v === 'memory' ? v : null; } catch { return null; }
}

export async function setStoragePref(pref) {
  try { localStorage.setItem(KEY, pref); } catch { /* ignore */ }
  if (pref === 'disk') {
    try { await navigator.storage?.persist?.(); } catch { /* ignore */ }
  } else {
    await clearDiskCache();
  }
}

export const diskCacheAvailable = () => typeof caches !== 'undefined' && isSecureContext;

/** Delete old and excess blocks. Entries carry X-Om-Created-At / Content-Length headers. */
export async function pruneDiskCache({ maxBytes = DISK_MAX_MB * 2 ** 20, maxAgeMs = DISK_MAX_AGE_H * 3600e3 } = {}) {
  if (!diskCacheAvailable()) return { bytes: 0, entries: 0, removed: 0 };
  const cache = await caches.open(CACHE_NAME);
  const now = Date.now();
  const entries = [];
  for (const req of await cache.keys()) {
    const r = await cache.match(req);
    if (!r) continue;
    entries.push({ req, size: +r.headers.get('Content-Length') || 0, t: +r.headers.get('X-Om-Created-At') || 0 });
  }
  entries.sort((a, b) => a.t - b.t);  // oldest first
  let bytes = entries.reduce((s, e) => s + e.size, 0);
  let removed = 0;
  for (const e of entries) {
    if (now - e.t < maxAgeMs && bytes <= maxBytes * 0.9) break;
    await cache.delete(e.req).catch(() => {});
    bytes -= e.size; removed++;
  }
  return { bytes, entries: entries.length - removed, removed };
}

export async function diskCacheStats() {
  if (!diskCacheAvailable() || !(await caches.has(CACHE_NAME))) return { bytes: 0, entries: 0 };
  const cache = await caches.open(CACHE_NAME);
  let bytes = 0, entries = 0;
  for (const req of await cache.keys()) {
    const r = await cache.match(req);
    bytes += +r?.headers.get('Content-Length') || 0; entries++;
  }
  return { bytes, entries };
}

export async function clearDiskCache() {
  if (diskCacheAvailable()) await caches.delete(CACHE_NAME).catch(() => {});
}

/**
 * Block cache for the weather-map-layer's file reader, per the stored preference.
 * `wml` is the weather-map-layer module (it re-exports the file-reader caches).
 */
export function createBlockCache(wml) {
  if (getStoragePref() !== 'disk' || !diskCacheAvailable()) return new wml.LruBlockCache(BLOCK_SIZE, MEM_BLOCKS);

  // The library's BrowserBlockCache re-scans the whole cache after every
  // block it writes (O(n) per write); replace that with one batched prune.
  class DiskBlockCache extends wml.BrowserBlockCache {
    #timer = null;
    evictIfNeeded() {
      this.#timer ??= setTimeout(() => {
        this.#timer = null;
        pruneDiskCache().catch((e) => console.warn('map cache prune failed', e));
      }, MAINTAIN_DELAY_MS);
      return Promise.resolve();
    }
  }
  pruneDiskCache().catch(() => {});  // drop expired runs on startup
  return new DiskBlockCache({
    blockSize: BLOCK_SIZE, cacheName: CACHE_NAME, memCacheTtlMs: 1000,
    maxBytes: DISK_MAX_MB * 2 ** 20, maxConcurrentFetches: 6,
  });
}
