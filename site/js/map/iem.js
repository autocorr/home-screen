// Observed radar: the Iowa Environmental Mesonet (IEM) NEXRAD base
// reflectivity mosaic (N0Q, 0.005°, every 5 min, archive back to 2010s).
// https://mesonet.agron.iastate.edu/docs/nexrad_mosaic/
//
// IEM serves the mosaic as Web Mercator PNG tiles in its own palette. That
// palette has 256 distinct colours, one per 0.5 dBZ step (index 0 = no echo,
// index i = 0.5 i - 32.5 dBZ), and the tiles are drawn nearest-neighbour, so
// every tile pixel maps back to an exact dBZ value. The iem:// protocol below
// fetches a tile, turns it back into dBZ and recolours it with the same colour
// scale the Open-Meteo forecast layer uses, so observed and forecast frames
// look alike. The decoded values also give a tap-to-read point value.
//
// Fetch budget:
//   - The scan list (json/radar.py, ~2 kB) is read on start, then at most
//     every POLL_MIN minutes while the map is on screen.
//   - Tiles are ~1-20 kB, fetched only for frames that are shown, and only at
//     zoom <= NATIVE_Z (MapLibre overzooms beyond it) inside `bounds`. They go
//     through the browser's HTTP cache (IEM sends max-age=300).

const IEM = 'https://mesonet.agron.iastate.edu';
const tileUrl = (ts, z, x, y) => `${IEM}/cache/tile.py/1.0.0/ridge::USCOMP-N0Q-${ts}/${z}/${x}/${y}.png`;
const NATIVE_Z = 8;        // ~0.5 km pixels at 34°N, about the mosaic's own resolution
const POLL_MIN = 2;        // a new mosaic every 5 min, ~1 min after its time
const TILE_CACHE = 48;     // decoded tiles (64 kB each) kept for point values

// The N0Q palette (from the mosaic's GIS PNG), 256 RGB triplets.
const PALETTE_HEX =
  '00000085718f85728f86738d87758b87768b887789897987897a878a7b858b7d848b7e848c7f828d81808d82808e837e' +
  '8f847c8f857c90877b918879918979928b77938d759691539894579b975b9d9a60a09d64a3a068a5a36da8a671aaa976' +
  'adac7ab0af7eb2b283b7b88cbabb90bdbe94bfc199c2c49dc4c7a2c7caa6cacdaaccd0afd2d4b4cfd2b4c9ccb4c6c9b4' +
  'c3c7b4c0c4b4bdc1b4b9beb4b6bbb4b3b9b4b0b6b4adb3b4aab0b4a4abb4a0a8b49da5b49aa2b497a0b4949db4919ab4' +
  '949bb59098b48c95b38892b2808cb07c89af7886ae7483ac7080ab6c7daa6779a96376a85f73a75b70a6576da44f67a2' +
  '4b64a14761a0435e9f415b9e4361a24568a6486faa4a76ae4d7db24f84b6518bbb5699c3599fc75ba6cb5eadcf60b4d4' +
  '62bbd865c2dc67c9e06ad0e46fd6e868d6d759d6b352d6a24bd69043d67e3cd66d35d65b11d51811d11710cd1710c816' +
  '10c4160fbc150fb7140eb3140eaf130eab130da6120da2120d9e110c99110c95100c91100b880f0b840e0a800e0a7c0d' +
  '0a770d09730c096f0c096b0b08660b08620a095e09327308467d085b88076f9207849d0698a806adb205c1bd05d6c704' +
  'ead204ffe200ffd800ffd300ffce00ffc900ffc400ffc000ffbb00ffb600ffb100ffac00ffa700ffa200ff9900ff9400' +
  'ff8f00ff8a00ff8500ff8000ff0000f80000f10000ea0000e30000d50000cd0000c60000bf0000b80000b10000aa0000' +
  'a300009b00009400008d00007f0000780000710000fffffffff5ffffeaffffdfffffd4ffffc9ffffbeffffb3ffff9dff' +
  'ff92ffff75fffc6bfdf960faf656f7f34bf4f040f1ed36efea2bece720e9e10be3b200ffac00fca400f79b00f49300ef' +
  '8800ea8300e87900e27200dd6900db05ecf005ebf005eaf005dde005dce005dbe005cdd005ccd004bdc004bcc004bbc0' +
  '04aeb004adb0049ea0049da0049ca0038e90038d90038c90037e80037d80036f70036e70036d70025f60025e60024f50' +
  '024e50024d50023f40023e40023d40013030012f30012020011f20011e203a67b53a66b53a65b53a64b53a63b53a62b5';

const dbzOf = (index) => 0.5 * index - 32.5;
const pad = (n) => String(n).padStart(2, '0');
const stamp = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
const iso = (d) => d.toISOString().slice(0, 16) + 'Z';

// RGB (packed) -> palette index.
const PALETTE = Array.from({ length: 256 }, (_, i) => [0, 1, 2].map((k) => parseInt(PALETTE_HEX.substr(i * 6 + k * 2, 2), 16)));
const INDEX = new Map(PALETTE.map(([r, g, b], i) => [(r << 16) | (g << 8) | b, i]));
/** Palette index of a colour; nearest palette colour if canvas readback altered it (e.g. anti-fingerprinting). */
function indexOf(r, g, b) {
  const key = (r << 16) | (g << 8) | b;
  let i = INDEX.get(key);
  if (i !== undefined) return i;
  let best = 0, bd = Infinity;
  for (let k = 1; k < 256; k++) {
    const [pr, pg, pb] = PALETTE[k];
    const d = (pr - r) ** 2 + (pg - g) ** 2 + (pb - b) ** 2;
    if (d < bd) { bd = d; best = k; }
  }
  INDEX.set(key, best);
  return best;
}

// Web Mercator, 256 px tiles.
const worldPx = (z) => 256 * 2 ** z;
const lonToPx = (lon, z) => ((lon + 180) / 360) * worldPx(z);
const latToPx = (lat, z) => {
  const s = Math.sin((lat * Math.PI) / 180);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * worldPx(z);
};

// ---------- tile decoding ----------

const decoded = new Map();   // "ts/z/x/y" -> Promise<Uint8Array(65536) of palette indices>, LRU by insertion order
let canvas = null;

async function decodeTile(ts, z, x, y, signal) {
  const key = `${ts}/${z}/${x}/${y}`;
  let p = decoded.get(key);
  if (p) { decoded.delete(key); decoded.set(key, p); return p; }
  p = (async () => {
    const r = await fetch(tileUrl(ts, z, x, y), { signal });
    if (!r.ok) throw new Error(`IEM tile ${key}: ${r.status}`);
    // Exact colours: no colour management, no premultiplied alpha (alpha is 0 or 255 anyway).
    const bmp = await createImageBitmap(await r.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    canvas ??= new OffscreenCanvas(256, 256);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.clearRect(0, 0, 256, 256);
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
    const px = ctx.getImageData(0, 0, 256, 256).data;
    const idx = new Uint8Array(256 * 256);
    for (let i = 0, j = 0; i < idx.length; i++, j += 4) if (px[j + 3] >= 128) idx[i] = indexOf(px[j], px[j + 1], px[j + 2]);
    return idx;
  })();
  decoded.set(key, p);
  p.catch(() => decoded.delete(key));   // don't keep failures (e.g. aborted)
  while (decoded.size > TILE_CACHE) decoded.delete(decoded.keys().next().value);
  return p;
}

let protocolInstalled = false;
let lut = null;              // palette index -> RGBA (Uint8ClampedArray, 256 * 4)
let clip = null;             // [w, s, e, n]

/**
 * Register the iem:// protocol once. `colorScale` is a weather-map-layer
 * colour scale (dBZ), drawn with `wml.getColor` exactly as the forecast is.
 * Pixels outside `bounds` [w, s, e, n] are left transparent.
 */
export function installIemProtocol(maplibregl, wml, { colorScale, bounds }) {
  if (protocolInstalled) return;
  protocolInstalled = true;
  clip = bounds;
  lut = new Uint8ClampedArray(256 * 4);
  for (let i = 1; i < 256; i++) {
    const [r, g, b, a = 1] = wml.getColor(colorScale, dbzOf(i), false);
    lut.set([r, g, b, Math.round(a * 255)], i * 4);
  }
  maplibregl.addProtocol('iem', async (params, abort) => {
    const m = params.url.match(/^iem:\/\/(\d{12})\/(\d+)\/(\d+)\/(\d+)/);
    if (!m) throw new Error(`bad iem url ${params.url}`);
    const [ts, z, x, y] = [m[1], +m[2], +m[3], +m[4]];
    const idx = await decodeTile(ts, z, x, y, abort.signal);
    const out = new ImageData(256, 256);
    const d = out.data;
    // Columns/rows inside the cut-out.
    const [w, s, e, n] = clip;
    const x0 = Math.max(0, Math.ceil(lonToPx(w, z) - x * 256 - 0.5)), x1 = Math.min(256, Math.floor(lonToPx(e, z) - x * 256 + 0.5));
    const y0 = Math.max(0, Math.ceil(latToPx(n, z) - y * 256 - 0.5)), y1 = Math.min(256, Math.floor(latToPx(s, z) - y * 256 + 0.5));
    for (let row = y0; row < y1; row++) {
      for (let col = x0, i = row * 256 + x0; col < x1; col++, i++) {
        const k = idx[i];
        if (k) d.set(lut.subarray(k * 4, k * 4 + 4), i * 4);
      }
    }
    return { data: await createImageBitmap(out) };
  });
}

// ---------- layer ----------

/**
 * Observed radar frames as a MapView data layer.
 * @param {object} o { label, historyH, bounds, until, colorScale }
 *   historyH: hours of past scans to offer
 *   colorScale: the scale passed to installIemProtocol (for the legend)
 *   until:    optional Date; show scans up to then (an archived view) instead of
 *             up to now. A past window never changes, so it is read once.
 */
export function iemRadarLayer({ label = 'Observed radar', historyH = 2, bounds, until = null, colorScale = null } = {}) {
  let frames = [];
  let checkedAt = 0;
  let newest = null;

  const layer = {
    id: 'iem:n0q',
    label,
    observed: true,
    attribution: '<a href="https://mesonet.agron.iastate.edu/docs/nexrad_mosaic/">IEM NEXRAD mosaic</a>',
    opacity: 0.8,
    frames: () => frames,
    /** Only within the scan window: never stretch the last scan into the future. */
    frameFor(t) {
      if (!frames.length || t < frames[0].time || t > frames.at(-1).time) return null;
      let best = frames[0];
      for (const f of frames) if (f.time <= t) best = f;
      return best;
    },
    sourceSpec(frame) {
      return { type: 'raster', tiles: [`iem://${frame.key}/{z}/{x}/{y}`], tileSize: 256, maxzoom: NATIVE_Z, bounds };
    },
    legend() {
      if (!colorScale) return null;
      const css = ([r, g, b, a = 1]) => `rgba(${r},${g},${b},${a})`;
      return { unit: colorScale.unit, stops: colorScale.breakpoints.map((v, i) => [v, css(colorScale.colors[i])]) };
    },
    async valueAt(frame, { lng, lat }) {
      const [w, s, e, n] = bounds;
      if (lng < w || lng > e || lat < s || lat > n) return null;
      const px = Math.floor(lonToPx(lng, NATIVE_Z)), py = Math.floor(latToPx(lat, NATIVE_Z));
      try {
        const idx = await decodeTile(frame.key, NATIVE_Z, px >> 8, py >> 8);
        return dbzOf(idx[(py & 255) * 256 + (px & 255)]);   // index 0 (no echo) reads as -32.5
      } catch { return null; }
    },
    get newest() { return newest; },
    /** Re-read the scan list if due (or forced). Resolves true when the frames changed. */
    async refresh({ force = false } = {}) {
      if (until && frames.length) return false;
      if (!force && Date.now() - checkedAt < POLL_MIN * 60e3) return false;
      checkedAt = Date.now();
      const end = until ?? new Date();
      const start = new Date(end - historyH * 3600e3);
      const url = `${IEM}/json/radar.py?operation=list&product=N0Q&radar=USCOMP&start=${iso(start)}&end=${iso(end)}`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`IEM scan list: ${r.status}`);
      const next = ((await r.json()).scans ?? [])
        .map((s) => Date.parse(s.ts)).filter((t) => t >= start && t <= end)
        .sort((a, b) => a - b)
        .map((t) => ({ time: t, key: stamp(new Date(t)) }));
      const same = next.length === frames.length && next.every((f, i) => f.key === frames[i].key);
      if (same) return false;
      frames = next;
      newest = frames.length ? new Date(frames.at(-1).time) : null;
      return true;
    },
  };
  return layer;
}
