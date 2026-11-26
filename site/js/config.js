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

// Satellites section (site/js/sats.js): passes over Socorro of CelesTrak's
// "visual" group (~150 of the brightest satellites), from orbital elements
// (TLEs) propagated with SGP4 in the browser. Satellites are keyed by NORAD
// catalog number.
//
// Brightness: each satellite has a standard magnitude (at 1000 km range, 90°
// phase angle). Most come from Mike McCants' list (js/data/satmags.js, built by
// scripts/build_satmags.py); `stdMag` below takes precedence over it and fills
// in objects it lacks, and anything else gets `defaultStdMag`. These are rough: flat antenna arrays
// (BlueBird, BlueWalker) can differ from the estimate by a magnitude or more.
export const SATS = {
  observer: { ...SOCORRO, height: 1400 },   // m
  group: 'visual',     // CelesTrak group fetched in one request
  extra: [53807],      // also fetched, by number: not in the group
  names: {             // display names; others use CelesTrak's name
    25544: 'ISS', 48274: 'Tiangong', 20580: 'Hubble', 53807: 'BlueWalker 3', 27386: 'Envisat',
  },
  stdMag: {            // used before McCants' value; estimates for objects his list lacks
    25544: -1.8,  // ISS: McCants' −2.5 predicts about −5 overhead, against an observed −3.8 to −4
    48274: -1.0,                                                // Tiangong
    53807: 1.9,                                                 // BlueWalker 3, 64 m² array
    61045: 1.9, 61046: 1.9, 61047: 1.9, 61048: 1.9, 61049: 1.9, // BlueBird 1–5, 64 m²
    67232: 1.0, 69589: 1.0, 69590: 1.0, 69591: 1.0,             // BlueBird Block 2, ~223 m²
  },
  defaultStdMag: 4.0,
  // Magnitude cutoff slider: only passes at least this bright are shown.
  magCut: { min: -2, max: 5, step: 0.5, default: 2.5 },
  week: { id: 25544, days: 7 },  // satellite and span (days) of the week-ahead pass table
  minUpdateH: 2,       // Update downloads nothing within this many hours of the last download (CelesTrak updates GP data every 2 h)
  retryMin: 30,        // after a failed download, Update waits this long before trying again
  window: { before: 1, after: 48, stepSec: 15 },  // hours around now; sampling step
  minPassEl: 10,       // passes lower than this (deg) are left out
  darkSunEl: -6,       // the sky counts as dark (satellites visible) when the Sun is below this
};

// Moon section (site/js/moon.js): lunar calendar for Socorro, computed in the
// browser with Astronomy Engine (no downloads).
export const MOON = {
  observer: { ...SOCORRO, height: 1400 },  // m
  days: 7,             // calendar days shown, starting today (MT)
  darkSunEl: -18,      // "dark" = Sun below this (astronomical twilight) and Moon below the horizon
  stepMin: 10,         // sampling step for the elevation chart and dark hours
};

// Weather cache: Update refetches only when Open-Meteo has published a newer model run.
// This age (minutes) is only the fallback when the model metadata can't be read.
export const WX_MAX_AGE_MIN = 30;
// Weather is downloaded only when Update is pressed; after that (in any tab) Update
// waits this long. Each Update only reads Open-Meteo's run metadata unless a newer
// model run exists, and its models publish at most hourly.
export const WX_MIN_UPDATE_MIN = 5;

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
  // Map data is downloaded only when Update is pressed. Afterwards (in any tab) Update
  // waits this long for the view shown: the radar mosaic is made every 5 min, and the
  // forecast models publish at most hourly.
  minUpdateMin: { precip: 5, refl: 5 },
  radar: {
    historyH: 2,
    // Hide ground clutter (mountains near the radars) with the map built by
    // scripts/build_clutter.py, and remove it from echoes above it.
    removeClutter: true,
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
  { id: 'sats', label: 'Satellites' },
  { id: 'moon', label: 'Moon' },
  { id: 'weather', label: 'Weather' },
  { id: 'precip', label: 'Precipitation & radar map' },
  { id: 'calc', label: 'Calculator' },
  { id: 'links', label: 'Links' },
];
