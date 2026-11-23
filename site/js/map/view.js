// Generic map view: a MapLibre map with a switchable OSM basemap, reference
// markers, and any number of time-varying *data layers* sharing one timeline.
// Nothing here knows where data comes from. A data layer is an object with:
//
//   id, label            string
//   attribution          HTML string, shown in the map's attribution
//   opacity              0..1 raster opacity
//   frames()             -> [{ time: ms, key: string }], sorted by time
//   frameFor(t)          -> frame to show at timeline time t, or null to hide (optional;
//                           default: the latest frame at or before t, within maxGapMs)
//   maxGapMs             used by the default frameFor
//   sourceSpec(frame, { dark }) -> MapLibre raster source spec for that frame
//   legend({ dark })     -> { unit, stops: [[value, 'rgba(...)'], ...] } (optional)
//   valueAt(frame, lngLat) -> Promise<number | null> (optional)
//
// Frames are swapped without flicker: the next frame's layer is added
// transparent, faded in once its tiles have loaded, then the old one removed.
// A few recent frames stay resident (hidden) so stepping back and forth is
// instant; MapLibre's own tile cache stays small because the map is small.

const RESIDENT_FRAMES = 3;
const FADE_MS = 200;

export class MapView {
  /**
   * @param {HTMLElement} container
   * @param {object} opts { maplibregl, basemaps, basemap, dark, center, zoom, minZoom, maxZoom,
   *                        maxBounds, markers: [{ lngLat, label }] }
   */
  constructor(container, opts) {
    this.ml = opts.maplibregl;
    this.opts = opts;
    this.basemaps = opts.basemaps;
    this.basemapId = opts.basemap;
    this.dark = !!opts.dark;
    this.layers = new Map();   // id -> { layer, shown: frameKey|null, ready: Promise|null, resident: [frameKey] }
    this.time = null;
    this.map = new this.ml.Map({
      container,
      style: this.#style(),
      center: opts.center, zoom: opts.zoom, minZoom: opts.minZoom, maxZoom: opts.maxZoom,
      maxBounds: opts.maxBounds,
      attributionControl: false,
      dragRotate: false, pitchWithRotate: false, keyboard: false,
      cooperativeGestures: matchMedia('(pointer: coarse)').matches,  // one-finger scroll passes to the page
      fadeDuration: 0,
    });
    this.map.touchZoomRotate.disableRotation();
    this.map.addControl(new this.ml.NavigationControl({ showCompass: false }), 'top-right');
    this.scaleCtl = new this.ml.ScaleControl({ unit: opts.units === 'metric' ? 'metric' : 'imperial' });
    this.map.addControl(this.scaleCtl, 'bottom-left');
    this.#attribution();
    for (const m of opts.markers ?? []) {
      const el = document.createElement('div');
      el.className = 'map-marker';
      el.innerHTML = `<span class="map-marker-dot"></span>${m.label ? `<span class="map-marker-label">${m.label}</span>` : ''}`;
      el.title = m.title ?? m.label;
      new this.ml.Marker({ element: el, anchor: m.label ? 'left' : 'center', offset: m.label ? [-5, 0] : [0, 0] }).setLngLat(m.lngLat).addTo(this.map);
    }
    this.ready = new Promise((res) => this.map.once('load', res));
    // A style change drops every source and layer: re-add the data layers.
    // Own flag: map.isStyleLoaded() is also false while any source (e.g. a new
    // frame's TileJSON) is loading, which is not what gates adding layers.
    this.styleReady = false;
    this.map.on('style.load', () => {
      this.styleReady = true;
      this.before = this.basemaps[this.basemapId].dataBefore(this.map.getStyle());
      for (const s of this.layers.values()) { s.shown = null; s.ready = null; s.resident = []; }
      this.#render();
    });
  }

  #style() { return this.basemaps[this.basemapId].style(this.dark); }

  #attribution() {
    if (this.attrCtl) this.map.removeControl(this.attrCtl);
    const custom = [this.basemaps[this.basemapId].attribution, ...[...this.layers.values()].map((s) => s.layer.attribution)];
    this.attrCtl = new this.ml.AttributionControl({ compact: true, customAttribution: custom.filter(Boolean) });
    this.map.addControl(this.attrCtl, 'bottom-right');
    // Start collapsed (the ⓘ button expands it) so it doesn't cover a small map.
    this.map.once('idle', () => this.attrCtl?._container?.classList.remove('maplibregl-compact-show'));
  }

  setBasemap(id, dark = this.dark) {
    if (id === this.basemapId && dark === this.dark) return;
    this.basemapId = id; this.dark = dark;
    this.styleReady = false;
    this.map.setStyle(this.#style(), { diff: false });
    this.#attribution();
  }

  addLayer(layer) {
    this.layers.set(layer.id, { layer, shown: null, resident: [] });
    this.#attribution();
    this.#render();
  }

  removeLayer(id) {
    const s = this.layers.get(id);
    if (!s) return;
    s.resident.forEach((k) => this.#drop(id, k));
    this.layers.delete(id);
    this.#attribution();
  }

  /** All frame times across layers (the timeline's steps), sorted, de-duplicated. */
  times() {
    const t = new Set();
    for (const { layer } of this.layers.values()) layer.frames().forEach((f) => t.add(f.time));
    return [...t].sort((a, b) => a - b);
  }

  /** Show time t; resolves once every layer's frame for t is drawn (or superseded). */
  setTime(t) { this.time = t; return this.#render(); }

  /** Resolves once the frames currently selected are drawn. */
  whenReady() { return this.#render(); }

  /** Layer frames changed (new model run, new radar scan): drop stale frames and redraw. */
  refreshed(id) {
    const s = this.layers.get(id);
    if (!s) return;
    const keys = new Set(s.layer.frames().map((f) => f.key));
    s.resident.filter((k) => !keys.has(k)).forEach((k) => this.#drop(id, k));
    s.resident = s.resident.filter((k) => keys.has(k));
    if (!keys.has(s.shown)) s.shown = null;
    this.#render();
  }

  frameOf(id, t = this.time) {
    const s = this.layers.get(id);
    if (!s || t == null) return null;
    const { layer } = s;
    if (layer.frameFor) return layer.frameFor(t);
    const fr = layer.frames();
    let best = null;
    for (const f of fr) if (f.time <= t) best = f;
    return best && t - best.time <= (layer.maxGapMs ?? Infinity) ? best : null;
  }

  #ids(id, key) { return { src: `d:${id}:${key}`, lyr: `d:${id}:${key}:r` }; }

  #drop(id, key) {
    const { src, lyr } = this.#ids(id, key);
    if (this.map.getLayer(lyr)) this.map.removeLayer(lyr);
    if (this.map.getSource(src)) this.map.removeSource(src);
  }

  #render() {
    if (!this.styleReady || this.time == null) return Promise.resolve();
    const pending = [];
    for (const [id, s] of this.layers) {
      const frame = this.frameOf(id);
      const key = frame?.key ?? null;
      if (key === s.shown) { if (s.ready) pending.push(s.ready); continue; }
      const prev = s.shown;
      s.shown = key;
      s.ready = null;
      if (!frame) { if (prev) this.#hide(id, prev); continue; }
      const { src, lyr } = this.#ids(id, key);
      if (!this.map.getSource(src)) {
        this.map.addSource(src, s.layer.sourceSpec(frame, { dark: this.dark }));
        this.map.addLayer({
          id: lyr, type: 'raster', source: src,
          paint: { 'raster-opacity': 0, 'raster-opacity-transition': { duration: FADE_MS, delay: 0 },
            'raster-fade-duration': 0, 'raster-resampling': 'linear' },
        }, this.before);
      } else {
        this.map.setLayoutProperty(lyr, 'visibility', 'visible');  // a resident frame coming back
      }
      s.resident = [key, ...s.resident.filter((k) => k !== key)];
      const show = () => {
        if (s.shown !== key) return;  // superseded while loading
        this.#setOpacity(id, key, s.layer.opacity ?? 0.75);
        if (prev && prev !== key) this.#hide(id, prev);
        // Evict beyond the resident limit (never the one just shown).
        s.resident.slice(RESIDENT_FRAMES).forEach((k) => this.#drop(id, k));
        s.resident = s.resident.slice(0, RESIDENT_FRAMES);
      };
      s.ready = new Promise((res) => this.#whenLoaded(src, (ok) => { if (ok) show(); res(); }));
      pending.push(s.ready);
    }
    return Promise.all(pending);
  }

  #setOpacity(id, key, v) {
    const { lyr } = this.#ids(id, key);
    if (this.map.getLayer(lyr)) this.map.setPaintProperty(lyr, 'raster-opacity', v);
  }

  /** Fade a frame out, then stop its tiles loading on pan/zoom (zero opacity alone doesn't). */
  #hide(id, key) {
    this.#setOpacity(id, key, 0);
    setTimeout(() => {
      const { lyr } = this.#ids(id, key);
      if (this.layers.get(id)?.shown !== key && this.map.getLayer(lyr)) this.map.setLayoutProperty(lyr, 'visibility', 'none');
    }, FADE_MS + 50);
  }

  /**
   * Call fn(true) once the frame's tiles in view have loaded, fn(false) if the
   * source is removed first. `isSourceLoaded` alone is not enough: right after
   * the TileJSON arrives it reports loaded before any tile has been requested.
   * So require a loaded tile of this source (then no tile still pending), or
   * the map going idle (nothing pending anywhere) after the metadata loaded.
   */
  #whenLoaded(src, fn) {
    const done = (ok) => { this.map.off('sourcedata', onData); this.map.off('idle', onIdle); fn(ok); };
    const onData = (e) => {
      if (!this.map.getSource(src)) done(false);
      else if (e.sourceId === src && e.tile && this.map.isSourceLoaded(src)) done(true);
    };
    const onIdle = () => {
      const source = this.map.getSource(src);
      if (!source) done(false);
      else if (source.loaded()) done(true);
    };
    this.map.on('sourcedata', onData);
    this.map.on('idle', onIdle);
    this.map.triggerRepaint();
  }

  setUnits(units) { this.scaleCtl.setUnit(units === 'metric' ? 'metric' : 'imperial'); }

  onClick(fn) { this.map.on('click', (e) => fn(e.lngLat)); }
  resize() { this.map.resize(); }
  destroy() { this.map.remove(); }
}

/**
 * Chain layers into one timeline, e.g. observed radar, then a 15-minute
 * forecast, then an hourly one. Each layer only covers times after the last
 * frame of the layers before it, so where they overlap the earlier one wins.
 * A layer with no frames (not loaded, or failed) is skipped over.
 * Returns wrapped layers (same ids; `inner` is the original).
 */
export function stitchLayers(layers) {
  return layers.map((inner, i) => {
    const after = () => {
      let t = -Infinity;
      for (const l of layers.slice(0, i)) { const f = l.frames(); if (f.length) t = Math.max(t, f.at(-1).time); }
      return t;
    };
    const fallback = (t) => {
      let best = null;
      for (const f of inner.frames()) if (f.time <= t) best = f;
      return best && t - best.time <= (inner.maxGapMs ?? Infinity) ? best : null;
    };
    return Object.assign(Object.create(inner), {
      inner,
      frames: () => { const a = after(); return inner.frames().filter((f) => f.time > a); },
      frameFor: (t) => (t > after() ? (inner.frameFor ? inner.frameFor(t) : fallback(t)) : null),
    });
  });
}

/**
 * Legend as a CSS gradient bar with tick labels. `fmt(value)` formats a label.
 * `zeroLabel`: label the first (transparent) step 0, for quantities where below it is "none".
 */
export function renderLegend(el, legend, fmt = String, { zeroLabel = true } = {}) {
  if (!legend) { el.innerHTML = ''; return; }
  const n = legend.stops.length;
  // Equal-width steps: breakpoint scales are roughly logarithmic.
  const grad = legend.stops.map(([, c], i) => `${c} ${(i / n) * 100}% ${((i + 1) / n) * 100}%`).join(',');
  const every = Math.ceil(n / 7);
  // The first step is transparent (below it is dry): label it 0.
  const ticks = legend.stops.map(([v], i) => (i % every ? '' : i === 0 ? `<span style="left:0">${zeroLabel ? 0 : fmt(v)}</span>` :
    `<span style="left:${(i / n) * 100}%">${fmt(v)}</span>`)).join('');
  el.innerHTML = `<div class="legend-bar" style="background:linear-gradient(90deg,${grad})"></div>` +
    `<div class="legend-ticks">${ticks}</div>`;
}
