// Basemaps built from OpenStreetMap data. All tile servers send HTTP cache
// headers (1-7 days), so the browser's own HTTP cache handles them.
//
// Each basemap: { label, attribution, style(dark) -> MapLibre style | URL,
//                 dataBefore(style) -> id of the layer data layers go under }.
// Data layers go below the labels on vector styles; raster basemaps have no
// labels to keep on top, so data goes above everything.

const OSM_ATTR = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

// Attribution is shown by the map view (customAttribution), not per source.
// Raster tiles rendered for a light page. In dark mode the lightness is
// inverted (brightness-min > brightness-max) and the hue turned back, which
// keeps water blue and parks green on a dark ground.
const rasterStyle = (id, tiles, maxzoom) => (dark) => ({
  version: 8,
  sources: { [id]: { type: 'raster', tiles, tileSize: 256, maxzoom } },
  layers: [{
    id, type: 'raster', source: id,
    paint: dark
      ? { 'raster-brightness-min': 0.92, 'raster-brightness-max': 0.08, 'raster-hue-rotate': 180,
          'raster-saturation': -0.4, 'raster-contrast': 0.1 }
      : { 'raster-saturation': -0.3 },
  }],
});

export const BASEMAPS = {
  vector: {
    label: 'Streets',
    attribution: null,  // the style's own sources carry the OpenFreeMap / OpenMapTiles / OSM credits
    style: (dark) => `https://tiles.openfreemap.org/styles/${dark ? 'dark' : 'positron'}`,
    dataBefore: (style) => style.layers.find((l) => l.type === 'symbol')?.id,
  },
  osm: {
    label: 'OSM',
    attribution: OSM_ATTR,
    style: rasterStyle('osm', ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], 19),
    dataBefore: () => undefined,
  },
  topo: {
    label: 'Topo',
    attribution: `Map style © <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA), ${OSM_ATTR}, SRTM`,
    style: rasterStyle('topo', ['https://tile.opentopomap.org/{z}/{x}/{y}.png'], 17),
    dataBefore: () => undefined,
  },
};
export const DEFAULT_BASEMAP = 'vector';
