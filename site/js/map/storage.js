// Where forecast map data blocks are cached, per the shared storage choice
// (site/js/storage.js).
//
// The weather-map-layer reads .om files in byte-range "blocks". Two caches:
//   - disk:   Cache Storage (CACHES.map), capped at LIMITS.map.mb and pruned of
//             blocks older than LIMITS.map.h. Each block is held in RAM only ~1 s
//             after use. Survives reloads, so reopening the page re-downloads
//             nothing for the runs it has already seen.
//   - memory: a small in-RAM LRU (MEM_BLOCKS x 64 KiB). Nothing is written to
//             disk, but every page load re-downloads.
// The choice is read when the map loads, so a change applies after a reload.
//
// Cache keys are a hash of the file URL plus a block index. File URLs name a
// specific model run and valid time, and Open-Meteo never rewrites a
// published file, so cached blocks never go stale; old runs are only removed
// by the age/size pruning.
import { CACHES, LIMITS, useDisk, pruneCache, schedulePrune } from '../storage.js';

const BLOCK_SIZE = 64 * 1024 - 1408;  // 64 KiB minus HTTP overhead, as the maps app uses
const MEM_BLOCKS = 256;               // 16 MiB in memory-only mode
const CREATED_AT = 'X-Om-Created-At'; // set by the library's BrowserBlockCache

/**
 * Block cache for the weather-map-layer's file reader, per the stored preference.
 * `wml` is the weather-map-layer module (it re-exports the file-reader caches).
 */
export function createBlockCache(wml) {
  if (!useDisk()) return new wml.LruBlockCache(BLOCK_SIZE, MEM_BLOCKS);

  // The library's BrowserBlockCache re-scans the whole cache after every
  // block it writes (O(n) per write); replace that with one batched prune.
  class DiskBlockCache extends wml.BrowserBlockCache {
    evictIfNeeded() {
      schedulePrune(CACHES.map, LIMITS.map, CREATED_AT);
      return Promise.resolve();
    }
  }
  pruneCache(CACHES.map, LIMITS.map, CREATED_AT).catch(() => {});  // drop expired runs on startup
  return new DiskBlockCache({
    blockSize: BLOCK_SIZE, cacheName: CACHES.map, memCacheTtlMs: 1000,
    maxBytes: LIMITS.map.mb * 2 ** 20, maxConcurrentFetches: 6,
  });
}
