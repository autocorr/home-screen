# Home Screen

A static, client-only personal dashboard. There is no build step, no server and no
database: plain HTML, CSS and ES modules in `site/`, plus two vendored libraries.

Sections can be collapsed by tapping their heading, and reordered or hidden with the
**⚙ Settings** button at the bottom. These choices are saved in the browser.

- **Clocks**: Mountain Time, UTC, and local apparent sidereal time at the VLA, plus MJD.
- **World time**: Japan, Germany, India (offset shown relative to MT).
- **Sky at the VLA**: table (El, Az, HA, Sun separation, next rise/set), polar sky view,
  and elevation/azimuth vs time for 3C48, 3C84, 3C138, 3C147, 3C286, Sun and Moon over ±12 h.
- **Satellites · Socorro**: passes of CelesTrak's ~150 brightest satellites, trimmed by
  a magnitude-cutoff slider. A sky view (stars to magnitude 4, constellation figures, Sun,
  Moon and planets) sits above an elevation-vs-time chart: a 2 h window that pans through
  the next 48 h. Below them are the brightest (or soonest) passes and a table of ISS passes
  for the next 7 days, all with estimated peak brightness. Hover or tap the chart to move the
  sky view to that time; tap a pass to centre the chart on it.
- **Weather · Socorro**: current conditions, 7-day summary, and hourly charts from
  [Open-Meteo](https://open-meteo.com/) (temperature, precipitation, cloud layers, wind,
  humidity, precipitable water, pressure, UV, solar radiation, visibility, CAPE,
  freezing level, AQI, particulates, gases, AOD).
- **Precipitation & radar map**: over a cut-out around Socorro and the VLA, drawn with
  [MapLibre](https://maplibre.org/) on an OpenStreetMap basemap (streets, OSM or topo).
  - **Precip** shows the forecast precipitation rate (RRFS or NBM) from Open-Meteo's
    spatial files on AWS.
  - **Radar** shows observed reflectivity from the
    [IEM NEXRAD mosaic](https://mesonet.agron.iastate.edu/docs/nexrad_mosaic/) for the
    past 2 h, followed by the RRFS simulated reflectivity forecast on the same timeline.

  Both have a time slider with playback and one-step ‹ › buttons, and you can tap the
  map to read the value at a point.
- **Calculator**: an IPython-style text REPL with Python syntax, numpy-like arrays and
  units and constants, e.g. `60 mi / h -> m / s`. See below.
- **Links**: placeholders. Edit `LINKS` in `site/js/config.js`.

The theme follows the OS light/dark preference by default; Settings can override it.

## Layout

```
site/
  index.html          page skeleton
  css/style.css       all styles; colour tokens for light & dark
  js/config.js        locations, sources, world clocks, links, section list  <- edit here
  js/astro.js         pure astronomy helpers (no DOM)
  js/sky.js           sky table, polar plot, el/az charts
  js/sats.js          satellites section: sky view canvas, pass chart, tables, cutoff slider
  js/sats-worker.js   Web Worker: SGP4 pass finding, sunlight and brightness
  js/tle.js           CelesTrak orbital elements: fetch, parse, store (per the storage choice)
  js/data/starmap.js  bright stars, constellation lines and labels (generated)
  js/data/satmags.js  satellite standard magnitudes (generated)
  js/data/clutter.js  radar ground-clutter map metadata (generated; the map is data/n0q_clutter.png)
  js/weather.js       Open-Meteo fetch + localStorage cache + charts
  js/clocks.js        MT/UTC/LST and world clocks
  js/links.js         links section
  js/calc.js          calculator section: transcript, keyboard, history (loads js/calc/ on first use)
  js/calc/            calculator engine, no DOM: parse.js (Python subset + ->), values.js (types,
                      display), ops.js (operators, broadcasting, indexing, conversion), units.js
                      (units and constants), builtins.js (math, array helpers), repl.js (eval, help, magics)
  js/settings.js      settings dialog (theme, section order/visibility)
  js/storage.js       data storage choice shared by satellites, map and radar: prompt, Cache Storage helpers, Settings controls
  js/charts.js        shared uPlot helpers (theme, touch cursor, now line, night shading)
  js/precip.js        precipitation & radar map section (controls, timeline)
  js/map/view.js      generic MapLibre view: basemap, markers, time-varying data layers, layer stitching
  js/map/basemaps.js  OSM-based basemaps
  js/map/openmeteo.js Open-Meteo spatial forecast (.om) data layer
  js/map/iem.js       observed radar data layer (IEM NEXRAD mosaic tiles, decoded to dBZ)
  js/map/storage.js   map data block cache (disk or memory, per js/storage.js)
  js/map/colormaps.js Turbo colour scales (precipitation, reflectivity) for weather-map-layer
  vendor/             uPlot, astronomy-engine, satellite.js, maplibre-gl, @openmeteo/weather-map-layer (see VERSIONS)
scripts/
  check_astro.py      cross-checks site positions against astropy
  astro_dump.mjs      helper used by check_astro.py
  build_starmap.py    regenerates js/data/starmap.js from d3-celestial's data
  build_satmags.py    regenerates js/data/satmags.js from McCants' magnitudes
  build_clutter.py    regenerates the radar ground-clutter map from past IEM scans
  vendor.sh           re-download vendored libraries
.github/workflows/pages.yml   deploys site/ to GitHub Pages
```

## Run locally

ES modules need HTTP, not `file://`:

```sh
python3 -m http.server -d site 8000   # then open http://localhost:8000
```

## Weather data, API budget, caching

There are two requests per refresh, defined at the top of `site/js/weather.js`:

- **Forecast** (`api.open-meteo.com`, seamless `best_match`):
  - 15 `minutely_15` variables: temperature, humidity, precipitation, wind, visibility, radiation, CAPE, freezing level. These are native NOAA RRFS over North America and interpolated from hourly beyond the RRFS horizon.
  - 12 `hourly` variables: cloud layers, pressure, UV, precipitation probability, PWV, weather code, is_day.
  - 9 `daily` variables.
  - 8 days in total (1 past + 7 forecast).
- **Air quality**: 9 hourly variables, 6 days.

Open-Meteo bills fractional "API calls": (variables / 10) × (days / 14), with a minimum of 1.
The forecast request's `X-RateLimit-Cost` response header confirms **3.6** calls, so
15-minute data costs the same as hourly. The air-quality request costs 1.0. Hover the
status line to see the last request's actual cost.

Refetching follows model runs, not a fixed timer. Every 5 minutes, and whenever the tab
becomes visible, the page reads each model's `meta.json`
(`https://api.open-meteo.com/data/<model>/static/meta.json`). These files are tiny,
CORS-enabled and not rate-limited. A dataset is refetched only when a model has a
`last_run_availability_time` newer than our copy:

- **Forecast:** watches RRFS, NBM and GFS, so it refreshes about hourly.
- **Air quality:** watches CAMS, so it refreshes about every 12 h.

Fallbacks:
- If the metadata can't be read, data older than `WX_MAX_AGE_MIN` (30 min) is refetched.
- Anything older than 6 h is always refetched.
- A changed request URL (for example, after editing the variable lists) invalidates the cache.
- ↻ forces a refetch.

The status line shows the newest model run, e.g. "newest run NBM 03Z". Leaving a tab
open all day costs about 24 × 3.6 + 2 × 1 ≈ 90 calls. The free tier allows 10,000 per day.

## Satellites

The section follows the whole of CelesTrak's
[`visual` group](https://celestrak.org/NORAD/elements/gp.php?GROUP=visual&FORMAT=csv):
about 150 of the brightest satellites, from the ISS and Tiangong down to large rocket
stages (SL-16, CZ-4B, ...), AST SpaceMobile's BlueBirds and old Earth-observation
satellites. BlueWalker 3 is not in the group, so it is added by catalog number
(`SATS.extra` in `site/js/config.js`).

**Magnitude cutoff.** A pass is shown when it is *visible* (see below), reaches 10°
(`SATS.minPassEl`) and its estimated peak brightness is at least as bright as the slider
(default magnitude 2.5, `SATS.magCut`). The cutoff applies to the chart, the sky view and
the pass list; dragging it brighter trims the clutter. At 2.5 there are typically
30–40 satellites and 60–70 passes in 48 h; at 0, a handful.

- **Chart:** each shown pass, coloured by its peak brightness on a one-hue ramp shared with
  the sky view (pale gold = bright, darker gold = near the cutoff), thick where visible, with the satellite's name at the
  peak where labels don't collide. The window is 2 h; drag it (mouse or one finger) or
  scroll sideways (trackpad, or Shift + wheel) to pan from 1 h ago to 48 h ahead, and
  **Now** returns to the current time. The background uses the sky view's own colours in both
  themes: blue by day, navy-black at night, blending through dawn and dusk. There is no per-satellite legend: the names and the
  pass list identify them.
- **Sky view:** passes in progress at the chart's time, and faintly, passes starting within
  30 min with their rise time. The readout below lists what's up, brightest first.
- **Pass list:** the 10 brightest passes in the next 48 h, or the 10 soonest. Tap one to
  centre the chart on it.
- **ISS week table:** unaffected by the cutoff; all ISS passes or only visible ones.

**Orbits.** Positions come from CelesTrak's GP elements (TLEs), propagated with SGP4
([satellite.js](https://github.com/shashwatak/satellite-js)) in a Web Worker
(`site/js/sats-worker.js`), so the page stays responsive. Each satellite is first scanned
every 60 s, and only stretches near or above the horizon are sampled at 15 s. That is about
0.5 M SGP4 steps for 48 h of the whole group, recomputed every 10 minutes.
Computation and redraws pause while the section is collapsed, hidden in Settings, or the
tab is in the background. Showing it again recomputes if the results are more than
10 minutes old. Orbital elements are only downloaded when you press **Update** (see below). Pass times agree
with Skyfield to within a few seconds.

**Fetching and caching** (`site/js/tle.js`), following CelesTrak's
[usage policy](https://celestrak.org/usage-policy.php):
- Elements are GP data in CelesTrak's CSV (OMM) format, read with satellite.js's
  `json2satrec`. The policy asks for CSV: the legacy TLE format is no longer served for
  newer (6-digit) catalog numbers, and JSON is ~3× larger.
- One request for the `visual` group plus one per `SATS.extra` id that the group doesn't
  include. The browser asks for gzip/brotli compression itself.
- **Only on request.** Opening the page sends nothing to CelesTrak: the section shows the
  elements this browser already holds, or asks you to press **Update**. The first Update
  asks where to keep data (see [Data storage](#data-storage)); elements go to Cache Storage
  (`sats-v1`) or stay in the tab's memory only.
  Update is disabled for 2 h after a successful download (`SATS.minUpdateH`; CelesTrak
  updates GP data every 2 h and asks for at most one download per update). The download
  times and any refusal are always kept in localStorage (`sats:gp:v4`), so these limits hold
  across reloads and tabs whatever the storage choice. Update's tooltip
  and the status line's tooltip say when it is available again. Each attempt is recorded before it is
  sent, so other open tabs see it, pick up the new elements and don't download their own.
- **Non-200 answers.** The policy asks clients to stop querying and tell a human.
  - 500/503: Update is disabled for 30 min (`SATS.retryMin`; the policy asks for at least 15).
  - Any other status (a 403 block, a 404, a redirect, or a 200 with no usable data): downloads
    stop, in every tab and across reloads. The status line shows CelesTrak's explanation and
    the button becomes **Retry**, which clears the stop and allows one new attempt.
  - Network failures (no answer at all): Update is disabled for 30 min.
  - The page keeps using the elements it already has. The status line also turns red when
    the ISS elements are more than 14 days old.
- `scripts/build_satmags.py` also uses CSV and stops at the first error. Don't run it more
  often than every 2 h.

**Visible** means the satellite is above the horizon, in sunlight (outside Earth's
cylindrical shadow) and the Sun is at least 6° below the horizon at Socorro
(`SATS.darkSunEl`). In the sky view, a dotted line means the satellite is in Earth's shadow.

**Brightness** is a rough estimate. Each satellite has a standard magnitude: its
brightness at 1000 km range and a 90° Sun–satellite–observer angle. The page treats it as a
diffusely reflecting sphere and scales that for the actual range and phase angle.
- Standard magnitudes come from Mike McCants' quicksat list
  ([qsmag.zip](https://www.mmccants.org/programs/qsmag.zip)), the usual source for visual
  observers. `scripts/build_satmags.py` extracts the values for the visual group into
  `js/data/satmags.js` (1.4 kB). Re-run it when CelesTrak's group changes.
- McCants has no value for about 30 newer objects (Tiangong, the BlueBirds, several Chinese
  rocket stages and satellites). `SATS.stdMag` gives estimates for the notable ones; the
  rest assume magnitude 4.0 (`SATS.defaultStdMag`), so they only show with a faint cutoff.
- `SATS.stdMag` also overrides McCants' ISS value (−2.5), which predicts about −5 for an
  overhead pass, against the −3.8 to −4 actually seen.
- Flat antenna arrays such as the BlueBirds can differ from the estimate by a magnitude or
  more. Glints and dimming in Earth's penumbra are not modelled.

**ISS week table.** The ISS (`SATS.week`) is propagated 7 days ahead. Times several days
out can be off by up to a minute or so, because of reboosts and changes in drag; the
pressing Update as the date approaches improves them.

**Sky view.** North is up and east is on the left, as seen lying on your back with your
head to the north. The disk's colour follows the Sun's elevation. Star positions are J2000
Hipparcos positions rotated to the horizon of date with astronomy-engine (precession and
nutation, no refraction). `scripts/build_starmap.py` regenerates `js/data/starmap.js` from
[d3-celestial](https://github.com/ofrohn/d3-celestial)'s data (BSD-3-Clause): 472 stars to
magnitude 4.0 (all drawn white, sized by magnitude), the constellation stick figures and
names, and names for the brightest stars.

**Download and storage size.**

| What | Size (gzip as served by GitHub Pages) | Kept where |
|---|---|---|
| Star catalogue `js/data/starmap.js` | 23 kB (8.8 kB) | Browser HTTP cache (GitHub Pages: `max-age=600`, then a 304 revalidation) |
| Magnitudes `js/data/satmags.js` | 1.4 kB | Same |
| satellite.js | 24 kB (11 kB) | Same |
| `sats.js`, `sats-worker.js`, `tle.js` | 46 kB (17 kB) | Same |
| CelesTrak `visual` group + 1 single-satellite request (CSV) | ~22 kB + 0.3 kB, only when Update is pressed, at most every 2 h (compressed in transfer) | ~55 kB of elements in Cache Storage, or memory only ([Data storage](#data-storage)) |

The star catalogue is part of the page's code, so after the first load it costs only a
revalidation request. It uses no localStorage or Cache Storage.

## Precipitation map

The map loads its libraries (MapLibre and Open-Meteo's
[weather-map-layer](https://github.com/open-meteo/weather-map-layer), about 4 MB with
WASM) only when the section is on screen and expanded. Collapsing or hiding the
section pauses playback. It needs WebGL2.

**Colours and units.** Precipitation uses Google's Turbo colour map
(`PRECIP_MAP.colormap` in `config.js`; set `'default'` for Open-Meteo's palette). The
first step (below 0.01 mm/h) is transparent, so dry ground stays clear. The weather
section's °F/°C switch also changes the map's legend, point readout and scale bar.

**Past runs.** Add `?pm_run=2026-11-21T12Z&pm_time=2026-11-21T16Z` to the URL to show
an older run at a given valid time. Old runs stay on S3 for roughly a week. The run's
`meta.json` is read once and not polled. The hourly RRFS and NBM runs used for precipitation
are only made every 6 h, so `pm_run` needs a 00/06/12/18Z hour there. In the radar view,
the observed scans end at `pm_run`. The forecast then comes from that hour's 15-minute
RRFS run and, after 18 h, from the 6-hourly run at or before it.

**Data.** Each model publishes one `.om` file per valid time on AWS
(`openmeteo.s3.amazonaws.com/data_spatial/<model>/<run>/<time>.om`). Each file is about 100 MB and holds
every variable for the whole model domain. The reader fetches only the byte ranges
for `precipitation` inside `PRECIP_MAP.bounds` (`site/js/config.js`), in 64 kB blocks.
That is about 200–250 kB per frame. Tiles are rendered in the browser.
Data outside the cut-out is never downloaded or drawn.

**Fetch budget.**
- `latest.json` (~8 kB) is read when the map opens, and then at most every 10 min while the
  map is visible. It is a conditional request, so an unchanged file costs a 304.
- File URLs are built for a specific run and valid time, so cached data never goes stale.
  The library's `latest.json?...` "capture" URLs are not used: they would re-read
  `latest.json` for every frame.
- A frame is downloaded only when it is shown. While playing, the timeline waits for
  each frame to draw before moving on.
- The first time a file is opened there is one HEAD request.

**Storage** follows the site-wide [Data storage](#data-storage) choice; if it hasn't been
made yet, the map asks before it loads.
- **Disk:** blocks go into the browser's Cache Storage (`map-blocks-v1`), capped at 300 MB.
  Blocks older than 48 h are removed. A reload re-downloads nothing for frames already seen.
- **Memory only:** a 16 MB in-memory cache, so every reload re-downloads.

Either way, blocks are held in RAM only briefly, and at most 4 decoded frames are kept.
A change of choice reaches the map after a reload. Basemap tiles use the browser's normal
HTTP cache.

GitHub Pages can't send the COOP/COEP headers that would let the renderer share memory
with its workers. Without them, each worker gets a copy of the cut-out. The cut-out is
small, so this costs little.

### Radar view

The timeline joins three layers with `stitchLayers` (`view.js`). Each layer only covers
the times after the previous layer's last frame:

1. **Observed:** the IEM NEXRAD N0Q mosaic, every 5 min for the past
   `PRECIP_MAP.radar.historyH` (2) hours. It is base reflectivity, at about 0.5 km
   resolution.
2. **RRFS 15 min:** Open-Meteo `ncep_rrfs_conus_15min` `radar_reflectivity`. New runs come
   hourly and reach 18 h ahead.
3. **RRFS hourly:** `ncep_rrfs_conus` `radar_reflectivity`. New runs come every 6 h and reach
   84 h ahead.

The first view, and **Now**, show the newest observed scan. While you stay there, the view
follows new scans as they arrive.

**Base vs composite.** The forecast is the simulated *composite* reflectivity: the
strongest echo anywhere in the column. IEM only publishes a *base* mosaic, built from each
radar's lowest beam. Composite is never lower than base, and can be noticeably higher for
tall storms, or where terrain blocks the lowest beam. Free composite mosaics exist only as
pre-coloured images (NOAA's MRMS map server) or as whole-US GRIB2 files (~1.8 MB per 2 min).

**Observed tiles, decoded.** IEM draws its tiles with a 256-colour palette that has one
colour per 0.5 dBZ step, without blending between colours. So every tile pixel maps back to
an exact dBZ value:

- the `iem://` MapLibre protocol (`site/js/map/iem.js`) fetches IEM's tile and turns its
  pixels back into dBZ;
- it then redraws the tile with the same colour scale (`REFLECTIVITY_SCALE`) the forecast
  uses, so observed and forecast frames look alike;
- the same decoded values give the tap-to-read value.

Below 5 dBZ is transparent and reads "no echo". The palette is embedded in `iem.js`, taken
from the mosaic's GIS PNG
(`mesonet.agron.iastate.edu/archive/data/YYYY/MM/DD/GIS/uscomp/n0q_*.png`).

**Ground clutter.** Where a radar's lowest beam grazes nearby mountains, the mosaic shows
weak echo in all weathers. Here that means the Sandia–Manzano crest (from KABX), the San
Andres, Organ and Franklin ranges (KEPZ), the Sacramentos (KHDX) and Mt Taylor. In clear
weather that clutter reaches 20–30 dBZ, so a higher display threshold wouldn't remove
it. Instead `scripts/build_clutter.py` samples a year of past scans, keeps the
clear ones, and writes a per-pixel clutter map (`site/data/n0q_clutter.png`, metadata in
`site/js/data/clutter.js`):

- **limit:** for pixels that show echo (≥ 5 dBZ) in at least 10% of clear scans, the
  95th percentile of those echoes. A value at or below it could be clutter alone, so it is
  hidden (and reads "no echo"). About 1.4% of the cut-out has a limit; there it removes
  ~96% of clear-sky clutter, while scans with weather keep 97% of their ≥ 20 dBZ echo.
- **level:** the median clutter power. A value above the limit is shown with that power
  removed: echo powers add in linear Z, so dBZ' = 10 log10(Z − Z_clutter). This changes
  strong echoes by under 0.5 dB, and stops rain over a ridge reading high.

Rain over the clutter pixels that is weaker than their limit is hidden with the clutter;
everywhere else the mosaic is unchanged. On coarser tiles (zoom < 8) each pixel takes the
highest limit and level of the zoom-8 pixels it covers. `PRECIP_MAP.radar.removeClutter`
turns this off. The map only needs rebuilding if a radar or the cut-out changes. The script
uses IEM's WMS (one image per scan, one request at a time, every image cached in
`~/.cache/home-screen/n0q`) and stops on any server error.

**Fetch budget.**
- **Scan list** (`json/radar.py`, ~2 kB): read at most every 2 min while the map is visible.
- **Tiles:** about 1–20 kB each. They are requested up to zoom 8 (about the mosaic's own
  resolution; MapLibre enlarges them beyond that) and only inside the cut-out. A tile URL
  names one scan and never changes, so with [Data storage](#data-storage) on disk tiles are
  kept in Cache Storage (`radar-tiles-v1`, up to 50 MB, removed after 6 h) and a reload
  fetches only new scans. With memory only they go through the browser's HTTP cache
  (IEM sends `max-age=300`).

**Adding a data source.** `site/js/map/view.js` knows nothing
about where data comes from. A data layer is a plain object with `id`, `frames()`
(sorted `{time, key}`), `sourceSpec(frame, {dark})` returning a MapLibre raster source
(an XYZ `tiles` template works as well as `om://`), and optionally `frameFor(t)`,
`maxGapMs`, `legend({dark})`, `valueAt(frame, lngLat)` and `attribution`. Add it with
`view.addLayer(layer)`. All layers share one timeline (`view.times()` is the union of
their frame times), so observed radar for past times and the forecast for future times
can sit on the same slider. `site/js/map/openmeteo.js` is the reference implementation.

## Calculator

A text REPL that behaves like IPython with `from math import *` and numpy arrays already
imported, plus units written the way physicists write them. There are no buttons.

- **Python syntax**: `+ - * / // % **`, comparisons (chained), `and/or/not`, `x if c else y`,
  `lambda`, tuples and unpacking, `x = ...`, `x += ...`, `del x`, `;` between statements
  (a trailing `;` hides the result). Integers are exact (`2**100`, `factorial(50)`), `/` gives
  a float, and `^` is bitwise xor, as in Python. No loops, comprehensions, `def` or imports.
- **Arrays**: `[1, 2, 3]` is an array, not a list. Arithmetic and every `math` function work
  elementwise and broadcast like numpy (`[1, 2, 3] + [[10], [20]]`). Indexing `a[0]`, `a[1:]`,
  `a[:, 0]`, `a[a > 1]`, item assignment, `@`, `.T`, `.shape`, and methods/functions such as
  `sum mean median std min max argmax cumsum diff sort where dot cross norm reshape arange
  linspace zeros interp`.
- **Units go right after a number** (or after `)`, `]`, a call or an index):
  - Examples: `3 km`, `9.8 m / s**2`, `1 kg m / s^2`, `2 m3 / (kg s2)`, `[1, 2] km`, `(x) m`,
    `sqrt(2) m`, `30°`, `100 °C`.
  - A unit runs over unit names joined by spaces, `*` and `/`, with powers written `**`, `^`
    or astropy's `s2`, and `/ (...)` groups. So astropy's output (`m3 / (kg s2)`) can be
    typed back in.
  - Inside a unit, names are always units. Everywhere else they are ordinary names, so
    `m = [[1, 2], [3, 4]]` and `3 m` can both be used, and `min(...)` is still the builtin
    while `5 min` is minutes.
  - If a name after `*` or `/` in a unit is also one of your variables, the unit wins and
    a note says so. Write `(2 kg) * g` to use the variable.
  - A unit after a bare variable (`x m`) is a syntax error; write `(x) m`.
- **Unit names, display and rules follow astropy.units**:
  - Names: `GHz`, `Jy`, `pc`, `Msun`, `deg_C`, ... with SI prefixes, plus binary ones for bytes.
  - Display: `km / s`, `m3 / (kg s2)`.
  - Units stay as written until converted, and `+` converts to the left operand's unit.
    Incompatible units raise `UnitConversionError`.
  - Imperial units (`mi`, `lb`, `deg_F`, `psi`, ...) are included. `%units [text]` lists them.
- **Constants**: `c.c`, `c.G`, `c.M_sun`, ... with astropy 8's values (CODATA 2022, IAU 2015).
  `c.G?` shows the uncertainty and reference; `%consts` lists them. `e` stays Euler's number;
  the electron charge is `c.e`.
- **Conversion**: `expr -> unit` (or `expr to unit`) converts everything to its left, so
  neither side needs parentheses: `c.c * 1 yr -> lyr`, `60 mi / h -> m / s`. It binds more
  loosely than anything else, so `y = x -> km` stores the converted value. Unlike astropy's
  `.to()`, it applies the spectral (wavelength / frequency / energy / wavenumber) and
  temperature equivalencies by itself: `21 cm -> GHz`, `100 °C -> °F`. Other targets:
  `-> 1/s`, `-> si`, `-> cgs`, `-> hms`, `-> dms`, or a quantity (`1 R_earth -> c.R_sun`).
  `x.si`, `x.value` and `x.unit` also work.
- **Help**: `?` for an overview; `name?`, `?name` or `help(name)` for a function's signature
  and docstring, a unit (`km?`), a constant (`c.G?`) or a variable. `_`, `__`, `_N` are earlier
  results. Magics (the `%` is optional): `%who`, `%whos`, `%reset`, `%precision [n]`,
  `%history`, `%clear`, `%units`, `%consts`, `%lsmagic`.
- **Keys**: Enter runs (or adds a line inside an unclosed bracket), Shift+Enter adds a line,
  Up/Down walk the history (filtered by what is typed before the cursor), Tab completes
  (units after a number or `->`, `c.` constants, other names elsewhere), Esc clears, Ctrl+L
  clears the screen.
- **LaTeX symbols**: as in IPython, `\epsilon<Tab>` becomes `ϵ`, `\alpha<Tab>` `α`, and a
  partial name such as `\var<Tab>` lists the matches (`site/js/calc/latex.js`).
  - Greek letters and `ħ`, `ℓ` work as variable names. Names are NFKC-normalised as in
    Python, so `ϵ` and `ε`, and `x₁` and `x1`, are the same variable.
  - These symbols are read as operators: `× · ÷` as `* /`, `≤ ≥ ≠` as `<= >= !=`, `→` as `->`,
    `√x` as `sqrt(x)`, `∞` as `inf`, superscripts as powers (`m²`, `10⁻³`), `°` as degrees,
    `µm`/`μm` as micrometres. `π` and `τ` are `pi` and `tau`.

The input history (last 500 entries) is kept in localStorage (`calc:history:v1`). Variables
and output last for the page's lifetime, as in an IPython session. The engine (~165 kB,
~45 kB gzipped) is loaded when the input is first focused. `node tests/calc_check.mjs`
checks it against values from Python and astropy.

## Data storage

Satellite elements, forecast map blocks and radar tiles share one storage choice
(`site/js/storage.js`). It is asked once, in whichever place needs it first: the map
section when it first loads, or the satellites section on the first Update. Answering in
one place answers everywhere, in every open tab.

- **Allow storage (Disk):** each kind of data gets its own Cache Storage cache:
  `sats-v1` (one entry, ~55 kB), `map-blocks-v1` (up to 300 MB, 48 h) and `radar-tiles-v1`
  (up to 50 MB, 6 h). The site also asks the browser to make its storage persistent
  (`navigator.storage.persist`), so the caches aren't evicted under storage pressure.
  Firefox may show a permission prompt for this.
- **Memory only:** nothing is written to disk; each page load starts empty.

⚙ Settings → *Data storage* changes the choice, shows the usage of each cache and clears
them. Choosing memory only deletes all three caches. Small bookkeeping (preferences, the
weather cache, CelesTrak download times) stays in localStorage either way. An earlier map
choice (`map:storage`) carries over, and satellite elements left in localStorage by
earlier versions move to Cache Storage once storage is allowed.

## Testing in browsers

**Every network service is mocked in the tests.** The test suite must never contact a real
service: CelesTrak, Open-Meteo (API and the map files on S3), IEM radar, or the basemap tile
servers. A new data source needs a mock in `tests/` in the same change. A problem that only
shows up against a live service is fixed when it appears in production.

Not done yet: `browser_check.py` and `firefox_selenium_check.py` still load Open-Meteo,
radar and map data live. They need mocks like CelesTrak's.

The tests never contact CelesTrak:
- `browser_check.py` answers every CelesTrak request with `tests/celestrak_mock.py`. The
  mock serves generated CSV element sets in CelesTrak's format: realistic low-Earth orbits
  for the satellites in `satmags.js` and `config.js`, with epochs a few hours old.
- `firefox_selenium_check.py` doesn't load satellite data at all.
- `tle_policy_check.mjs` stubs `fetch`.

```sh
python3 -m http.server -d site 8765 &
uv run --with playwright python -m playwright install firefox chromium   # once
uv run tests/browser_check.py                     # Playwright Firefox (Gecko): phone + desktop, light + dark
uv run tests/browser_check.py --engine chromium   # same checks in Chromium
uv run tests/firefox_selenium_check.py            # your installed Firefox via geckodriver
node tests/calc_check.mjs                         # calculator engine (no browser)
node tests/tle_policy_check.mjs                   # CelesTrak usage-policy handling (no network)
node tests/clutter_check.mjs                      # radar clutter correction and map (no network)
```

The checks cover: no horizontal scroll, no element overflowing its box, clocks
ticking, all charts drawn, tap/hover cursor sync, the satellite section (nothing
downloaded on load, the storage prompt on the first Update, Update fetching once and storing the elements in Cache Storage, a second Update within 2 h refused, stars drawn, chart cursor moving the sky view, passes sorted by brightness,
the magnitude cutoff, panning the chart, showing a pass, the ISS week table, no computation while collapsed), section collapse and order
persisting, theme, the weather cache being reused on reload, the precipitation map
(no second storage prompt, model run loaded, value at Socorro, timeline), the radar view (scans and
RRFS runs loaded, starting at the latest scan, dBZ readout, tiles stored, stepping into the forecast,
switching back), the calculator (unit conversion, continuation lines, errors, history, Tab
completion), and no JS errors.

Limits:
- Firefox for Android can't be automated here. The Playwright Firefox run at 393 px
  with touch input is the closest stand-in.
- The installed-Firefox run can't go narrower than about 490 px.
- Headless Firefox has no WebGL2, so the map rendering checks only run in Chromium.
  In Firefox the tests only check that the map section reports the missing WebGL2.
- Headless Firefox ESR ignores dark-mode emulation, so that run only checks that the
  page matches whatever scheme the browser reports.

## Verifying the astronomy

Positions are computed in the browser with
[astronomy-engine](https://github.com/cosinekitty/astronomy). They are topocentric and
apparent (precession, nutation, aberration), with no refraction. To compare the site's
own code against astropy over ±12 h (no Python needed at runtime; this is a dev check
only):

```sh
uv run scripts/check_astro.py
```

Typical agreement is about 2″ in El/Az and under 0.1 s in LST.

## Deploy

1. Push this repository to GitHub with `main` as the default branch.
2. Repository Settings → Pages → Source: **GitHub Actions**.
3. Every push to `main` deploys `site/`.

## Adding a source

Add an entry to `SOURCES` in `site/js/config.js` (J2000 RA/Dec, a `--series-N` colour)
and to the `SOURCES` dict in `scripts/check_astro.py`. Up to 8 fixed sources are supported.
