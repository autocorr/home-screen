// Site configuration: locations, sources, refresh policy.
// Edit this file to add sources or change locations.

export const TZ = 'America/Denver';

// VLA array centre (astropy EarthLocation.of_site('vla')).
export const VLA = { name: 'VLA', lat: 34.078749, lon: -107.618283, height: 2124 };

// Weather location: New Mexico Tech campus, Socorro, NM.
export const SOCORRO = { name: 'Socorro, NM', lat: 34.0664, lon: -106.9065 };

// J2000 positions from the VLA calibrator list.
// `color` is a CSS custom property defined in css/style.css.
export const SOURCES = [
  { name: '3C48',  ra: '01:37:41.299431', dec: '+33:09:35.13299', color: '--series-1' },
  { name: '3C84',  ra: '03:19:48.160102', dec: '+41:30:42.10305', color: '--series-2' },
  { name: '3C138', ra: '05:21:09.886021', dec: '+16:38:22.05122', color: '--series-3' },
  { name: '3C147', ra: '05:42:36.137916', dec: '+49:51:07.23356', color: '--series-5' },
  { name: '3C286', ra: '13:31:08.287984', dec: '+30:30:32.95886', color: '--series-7' },
];
export const SUN_COLOR = '--series-4';
export const MOON_COLOR = '--moon';

// VLA antennas cannot point below ~8 deg elevation.
export const VLA_EL_LIMIT = 8;

// Sky track window relative to now (hours) and sampling step (minutes).
export const SKY_WINDOW = { before: 12, after: 12, stepMin: 5 };

// Weather cache: data is refetched when Open-Meteo publishes a newer model run.
// This age (minutes) is only the fallback when the model metadata can't be read.
export const WX_MAX_AGE_MIN = 30;

// Precipitation map (site/js/precip.js). `bounds` [west, south, east, north] is
// the cut-out: data outside it is never downloaded or drawn, and the map can't
// be panned far beyond it. `models` are Open-Meteo spatial domains
// (https://openmeteo.s3.amazonaws.com/index.html#data_spatial/).
export const PRECIP_MAP = {
  center: [SOCORRO.lon, SOCORRO.lat],
  zoom: 6.6,
  minZoom: 5.5,
  maxZoom: 12,
  bounds: [-109.6, 31.6, -104.2, 36.6],
  // 'turbo' (Google Turbo, see js/map/colormaps.js) or 'default' (Open-Meteo's palette).
  colormap: 'turbo',
  models: [
    // First entry is the default.
    { id: 'ncep_rrfs_conus', label: 'RRFS', title: 'NOAA RRFS, 3 km, 84 h' },
    { id: 'ncep_nbm_conus', label: 'NBM', title: 'NOAA National Blend of Models, 2.5 km, 11 days' },
  ],
  // What the map shows; first entry is the default. 'precip' uses `models` above.
  quantities: [
    { id: 'precip', label: 'Precip', title: 'Forecast precipitation rate' },
    { id: 'refl', label: 'Radar', title: 'Radar reflectivity: observed NEXRAD mosaic, then the RRFS forecast' },
  ],
  // Radar reflectivity: IEM's observed NEXRAD mosaic for the past `historyH`
  // hours, then each forecast domain in turn (RRFS `radar_reflectivity`, the
  // simulated composite reflectivity). A later domain only fills times after
  // the one before it ends.
  radar: {
    historyH: 2,
    forecasts: [
      { id: 'ncep_rrfs_conus_15min', label: 'RRFS 15 min', runEveryH: 1 },  // 18 h ahead
      { id: 'ncep_rrfs_conus', label: 'RRFS hourly', runEveryH: 6 },        // 84 h ahead
    ],
  },
  markers: [
    { label: '', lngLat: [SOCORRO.lon, SOCORRO.lat] },  // basemaps already label Socorro
    { label: 'VLA', lngLat: [VLA.lon, VLA.lat] },
  ],
};

// World clocks section.
export const WORLD_CLOCKS = [
  { label: 'Japan', tz: 'Asia/Tokyo' },
  { label: 'Germany', tz: 'Europe/Berlin' },
  { label: 'India', tz: 'Asia/Kolkata' },
];

// Links section. Placeholders: replace with real links.
// `group` is optional; links with the same group are listed together.
export const LINKS = [
  { label: 'Abstract Games', url: 'https://autocorr.github.io/abstract-games'},
  { label: 'Chess Diagram Editor', url: 'https://autocorr.github.io/chess-diagram'},
];

// Sections in default render order. Users can reorder/hide them in Settings.
// `id` matches the <section data-section="..."> in index.html.
export const SECTIONS = [
  { id: 'clocks', label: 'Clocks (MT / UTC / LST)' },
  { id: 'world', label: 'World time' },
  { id: 'sky', label: 'Sky at the VLA' },
  { id: 'weather', label: 'Weather' },
  { id: 'precip', label: 'Precipitation & radar map' },
  { id: 'links', label: 'Links' },
];
