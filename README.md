# Home Screen

A static, client-only personal dashboard. There is no build step, no server and no
database: plain HTML, CSS and ES modules in `site/`, plus two vendored libraries.

Sections can be collapsed by tapping their heading, and reordered or hidden with the
**⚙ Settings** button at the bottom. These choices are saved in the browser.

- **Clocks**: Mountain Time, UTC, and local apparent sidereal time at the VLA, plus MJD.
- **World time**: Japan, Germany, India (offset shown relative to MT).
- **Sky at the VLA**: table (El, Az, HA, Sun separation, next rise/set), polar sky view,
  and elevation/azimuth vs time for 3C48, 3C84, 3C138, 3C147, 3C286, Sun and Moon over ±12 h.
- **Weather · Socorro**: current conditions, 7-day summary, and hourly charts from
  [Open-Meteo](https://open-meteo.com/) (temperature, precipitation, cloud layers, wind,
  humidity, precipitable water, pressure, UV, solar radiation, visibility, CAPE,
  freezing level, AQI, particulates, gases, AOD).
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
  js/weather.js       Open-Meteo fetch + localStorage cache + charts
  js/clocks.js        MT/UTC/LST and world clocks
  js/links.js         links section
  js/settings.js      settings dialog (theme, section order/visibility)
  js/charts.js        shared uPlot helpers (theme, touch cursor, now line, night shading)
  vendor/             uPlot 1.6.32, astronomy-engine 2.1.19 (see VERSIONS)
scripts/
  check_astro.py      cross-checks site positions against astropy
  astro_dump.mjs      helper used by check_astro.py
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

- **Forecast:** watches HRRR, RRFS, NBM and GFS, so it refreshes about hourly.
- **Air quality:** watches CAMS, so it refreshes about every 12 h.

Fallbacks:
- If the metadata can't be read, data older than `WX_MAX_AGE_MIN` (30 min) is refetched.
- Anything older than 6 h is always refetched.
- A changed request URL (for example, after editing the variable lists) invalidates the cache.
- ↻ forces a refetch.

The status line shows the newest model run, e.g. "newest run NBM 03Z". Leaving a tab
open all day costs about 24 × 3.6 + 2 × 1 ≈ 90 calls. The free tier allows 10,000 per day.

## Testing in browsers

```sh
python3 -m http.server -d site 8765 &
uv run --with playwright python -m playwright install firefox chromium   # once
uv run tests/browser_check.py                     # Playwright Firefox (Gecko): phone + desktop, light + dark
uv run tests/browser_check.py --engine chromium   # same checks in Chromium
uv run tests/firefox_selenium_check.py            # your installed Firefox via geckodriver
```

The checks cover: no horizontal scroll, no element overflowing its box, clocks
ticking, all charts drawn, tap/hover cursor sync, section collapse and order
persisting, theme, the weather cache being reused on reload, and no JS errors.

Limits:
- Firefox for Android can't be automated here. The Playwright Firefox run at 393 px
  with touch input is the closest stand-in.
- The installed-Firefox run can't go narrower than about 490 px.
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
