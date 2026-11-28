# /// script
# requires-python = ">=3.11"
# dependencies = ["playwright"]
# ///
"""Smoke-test the site in a real browser engine (default: Firefox/Gecko).

    uv run python -m http.server -d site 8765 &
    uv run --with playwright python -m playwright install firefox   # once
    uv run tests/browser_check.py [--engine firefox|chromium] [--url URL] [--shots DIR]
"""
import argparse
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

ap = argparse.ArgumentParser()
ap.add_argument("--engine", default="firefox")
ap.add_argument("--url", default="http://localhost:8765/")
ap.add_argument("--shots", default=None)
args = ap.parse_args()
shots = Path(args.shots) if args.shots else None

failures = []
def check(name, ok, detail=""):
    print(f"  {'PASS' if ok else 'FAIL'}  {name}{f'  ({detail})' if detail else ''}")
    if not ok:
        failures.append(name)

PROFILES = {
    # Firefox/Playwright cannot emulate `isMobile`; viewport + touch is the closest.
    "phone": dict(viewport={"width": 393, "height": 851}, has_touch=True, device_scale_factor=2.75),
    "desktop": dict(viewport={"width": 1280, "height": 900}),
}

# No live service is contacted: tests/celestrak_mock.py answers CelesTrak's GP queries
# with generated element sets (its usage policy limits downloads, and tests run often),
# and tests/weather_mock.py stands in for Open-Meteo, S3, IEM and the basemaps.
from celestrak_mock import CELESTRAK, celestrak_mock
from weather_mock import S3, install_mocks
from urllib.parse import urlparse

with sync_playwright() as p:
    browser = getattr(p, args.engine).launch()
    print(f"{args.engine} {browser.version}")
    for prof, opts in PROFILES.items():
        for scheme in ("light", "dark"):
            print(f"\n[{prof} / {scheme}]")
            # The browser runs in Pacific time: Socorro mode must still show MT, and the
            # current location the browser's zone.
            ctx = browser.new_context(color_scheme=scheme, timezone_id="America/Los_Angeles", **opts)
            pg = ctx.new_page()
            errors, wx_reqs = [], []
            failing = []   # URL prefixes made to fail on purpose (their 503s are not page errors)
            pg.on("pageerror", lambda e: errors.append(str(e)))
            # The S3 mock answers 503 on purpose (there is no .om mock): not a page error.
            pg.on("console", lambda m: errors.append(m.text) if m.type == "error"
                  and not ("Failed to load resource" in m.text and (S3.match(m.location.get("url", ""))
                           or any(m.location.get("url", "").startswith(u) for u in failing))) else None)
            # Data requests only (cost API calls); model meta.json checks are free.
            pg.on("request", lambda r: wx_reqs.append(r.url) if "open-meteo" in r.url and "/v1/" in r.url else None)
            tle_reqs = []
            pg.on("request", lambda r: tle_reqs.append(r.url) if "celestrak" in r.url else None)
            mocked, wx_mocked = [], []
            ctx.route(CELESTRAK, celestrak_mock(mocked))
            om = install_mocks(ctx, wx_mocked)
            site = urlparse(args.url).netloc
            external = []   # every request off this site; each must have gone to a mock
            pg.on("request", lambda r: external.append(r.url) if r.url.startswith("http") and urlparse(r.url).netloc != site else None)
            pg.goto(args.url)
            pg.wait_for_timeout(1000)

            # Weather: nothing downloaded on load; Update downloads it, then waits 5 min.
            check("weather: no Open-Meteo request on load", not wx_mocked, "; ".join(wx_mocked)[:200])
            check("weather: prompt to press Update", "Press Update" in pg.inner_text("#wx-status"), pg.inner_text("#wx-status"))
            pg.click("#wx-update")
            pg.wait_for_function("document.querySelectorAll('#wx-charts .uplot').length > 10", timeout=15000)
            check("weather: Update disabled after a download", pg.is_disabled("#wx-update") and
                  "again in 5 min" in (pg.get_attribute("#wx-update", "title") or ""), pg.get_attribute("#wx-update", "title"))
            n_wx = len(wx_reqs)
            pg.eval_on_selector("#wx-update", "(b) => { b.disabled = false; b.click(); }"); pg.wait_for_timeout(300)
            check("weather: Update within 5 min sends nothing", len(wx_reqs) == n_wx, f"{n_wx} -> {len(wx_reqs)}")

            w = opts["viewport"]["width"]
            sw = pg.evaluate("document.documentElement.scrollWidth")
            check("no horizontal page scroll", sw <= w, f"scrollWidth {sw} / viewport {w}")
            clipped = pg.evaluate("""[...document.querySelectorAll(
                '.section-head, .clock-time, .clock-sub, .day, .tile, .table-wrap, .chart-card, .map-wrap, .map-time, .map-info, .sat-grid, .sat-passes-card, .calc-term')]
                .filter(e => e.offsetParent && e.scrollWidth > e.clientWidth + 1)
                .map(e => e.className + ':' + e.textContent.trim().slice(0, 20))""")
            check("nothing overflows its box", not clipped, "; ".join(clipped)[:200])
            t1 = pg.inner_text("#clk-utc"); pg.wait_for_timeout(1100); t2 = pg.inner_text("#clk-utc")
            check("clocks tick", t1 != t2, f"{t1} -> {t2}")
            check("LST shown", ":" in pg.inner_text("#clk-lst"))
            check("world clocks", pg.locator("#world-clocks .clock").count() == 3)
            check("sky table rows", pg.locator("#sky-table tbody tr").count() == 7)
            check("polar tracks", pg.locator("#sky-polar path.track").count() == 14)
            check("sky charts", pg.locator("#sky .uplot canvas").count() == 2)
            check("moon calendar: 7 days", pg.locator("#moon-days .day").count() == 7)
            check("moon calendar: phase disks", pg.locator("#moon-days .day .moon-disk canvas").count() == 7)
            # The disks are drawn from the lunar map: the lit part shows dark maria and bright highlands.
            spread = pg.evaluate("""(() => { const c = document.querySelector('#moon-now canvas');
                const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data, g = [];
                for (let i = 0; i < d.length; i += 4) if (d[i + 3] === 255 && d[i] > 60) g.push(d[i]);
                g.sort((a, b) => a - b);
                return g.length ? g[Math.floor(g.length * 0.95)] - g[Math.floor(g.length * 0.05)] : 0; })()""")
            check("moon disk drawn from the map", spread > 40, f"lit brightness spread {spread}")
            check("moon calendar: rise/set times", pg.locator("#moon-days .day-meta").filter(has_text="↑").count() == 7)
            check("moon summary", "% lit" in pg.inner_text("#moon-now") and "next phases" in pg.inner_text("#moon-now").lower())
            check("moon chart", pg.locator("#moon-el .uplot canvas").count() == 1)
            n = pg.locator("#wx-charts .uplot").count()
            check("weather charts", n >= 20, f"{n}")
            check("weather tiles", pg.locator("#wx-now .tile").count() == 8)
            check("current values filled", "—" not in pg.inner_text("#wx-now .tile-hero"))
            check("15-min data used", pg.evaluate(
                "JSON.parse(localStorage.getItem('wx:v3')).forecast.minutely_15.time.length") > 500)
            bg = pg.evaluate("getComputedStyle(document.body).backgroundColor")
            check("theme follows OS", (bg == "rgb(0, 0, 0)") == (scheme == "dark"), bg)

            # Cursor: touch-drag on phone, mouse hover on desktop.
            over = pg.locator("#wx-charts .u-over").first
            over.scroll_into_view_if_needed()
            b = over.bounding_box()
            x, y = b["x"] + b["width"] * 0.5, b["y"] + b["height"] * 0.5
            if opts.get("has_touch"):
                pg.touchscreen.tap(x, y)
            else:
                pg.mouse.move(x, y)
            pg.wait_for_timeout(250)
            leg = pg.locator("#wx-charts .u-legend").nth(4).inner_text().replace("\n", " ")
            check("chart cursor syncs (wind legend)", "mph" in leg or "m/s" in leg, leg[:70])
            el = pg.locator("#sky-el .u-over"); el.scroll_into_view_if_needed(); b = el.bounding_box()
            x, y = b["x"] + b["width"] * 0.6, b["y"] + 40
            pg.touchscreen.tap(x, y) if opts.get("has_touch") else pg.mouse.move(x, y)
            pg.wait_for_timeout(250)
            check("sky cursor -> polar markers", pg.locator("#sky-polar circle.cursor-pos").count() > 0)

            # Satellites: nothing downloaded on load; Update fetches and caches the elements,
            # then refuses a second download; sky view drawn, chart cursor drives it.
            check("satellites: no CelesTrak request on load", not tle_reqs, "; ".join(tle_reqs)[:200])
            check("satellites: prompt to press Update", "Press Update" in pg.inner_text("#sat-status"),
                  pg.inner_text("#sat-status"))
            pg.locator("#sat-update").scroll_into_view_if_needed(); pg.click("#sat-update")
            # The first Update asks where to keep data (shared with the map and radar).
            pg.wait_for_selector("#sat-consent:not([hidden]) button[data-pref=disk]", timeout=5000)
            check("satellites: Update asks about storage first", not tle_reqs and pg.is_visible("#sat-consent"))
            pg.click("#sat-consent button[data-pref=disk]")
            pg.wait_for_function("document.querySelector('#sat-el .uplot')", timeout=15000)
            check("satellites: Update disabled after a download", pg.is_disabled("#sat-update") and
                  "again in 2" in (pg.get_attribute("#sat-update", "title") or ""), pg.get_attribute("#sat-update", "title"))
            n_tle = len(tle_reqs)
            pg.eval_on_selector("#sat-update", "(b) => { b.disabled = false; b.click(); }"); pg.wait_for_timeout(300)
            check("satellites: Update within 2 h sends nothing", len(tle_reqs) == n_tle, f"{n_tle} -> {len(tle_reqs)}")
            check("satellite elements stored in Cache Storage", pg.evaluate(
                "caches.open('sats-v1').then(c => c.match(new URL('sats/gp.json', location.href).href))"
                ".then(r => r ? r.json() : {sats: {}}).then(e => Object.keys(e.sats).length)") >= 100)
            check("no elements in localStorage", pg.evaluate(
                "Object.keys(localStorage).every(k => !/^sats:gp/.test(k) || !JSON.parse(localStorage.getItem(k)).sats)"))
            check("satellite status", "CelesTrak" in pg.inner_text("#sat-status") and
                  "error" not in (pg.get_attribute("#sat-status", "class") or ""), pg.inner_text("#sat-status"))
            pg.locator("#sat-polar").scroll_into_view_if_needed()
            lit = pg.evaluate("""(() => { const c = document.querySelector('#sat-polar');
                const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
                // brighter than the disk's sky colour (sampled inside the disk, near its edge),
                // so this holds by day too, when stars are faint
                const k = 4 * (Math.round(c.height * 0.5) * c.width + Math.round(c.width * 0.08));
                const bg = d[k] + d[k+1] + d[k+2];
                let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] + d[i+1] + d[i+2] > bg + 90) n++; return n; })()""")
            check("sky view draws stars", lit > 100, f"{lit} pixels brighter than the sky")
            check("sky view readout", pg.locator("#sat-polar-info .pi-cell").count() >= 1)
            pg.click('#sat-week-mode button[data-mode="all"]'); pg.wait_for_timeout(100)
            wk = pg.locator("#sat-week tbody tr").count()
            check("ISS week table", wk >= 20, f"{wk} passes in 7 days")
            pg.click('#sat-week-mode button[data-mode="visible"]')
            rows = pg.locator("#sat-passes tbody tr[data-p]").count()
            check("pass list", rows >= 1, f"{rows} rows")
            pass_mags = lambda: [float(t.replace("\u2212", "-")) for t in
                                 pg.locator("#sat-passes tbody tr[data-p] td:last-child").all_inner_texts()]
            mags = pass_mags()
            check("passes sorted by brightness", mags == sorted(mags), str(mags))
            n_bright = pg.inner_text("#sat-count")
            pg.eval_on_selector("#sat-mag", "(e) => { e.value = '0'; e.dispatchEvent(new Event('input')); }")
            mags0 = pass_mags()
            check("magnitude cutoff trims passes", all(m <= 0 for m in mags0) and pg.inner_text("#sat-count") != n_bright,
                  f"{n_bright} -> {pg.inner_text('#sat-count')}")
            pg.eval_on_selector("#sat-mag", "(e) => { e.value = '4'; e.dispatchEvent(new Event('input')); }")
            el = pg.locator("#sat-el .u-over"); el.scroll_into_view_if_needed(); b = el.bounding_box()
            x, y = b["x"] + b["width"] * 0.6, b["y"] + 40
            pg.touchscreen.tap(x, y) if opts.get("has_touch") else pg.mouse.move(x, y)
            pg.wait_for_timeout(250)
            t_cur = pg.inner_text("#sat-polar-info .pi-time")
            check("satellite chart cursor -> sky view time", not t_cur.startswith("Now"), t_cur)
            # The axes are canvas: compare the sky-view time under the same point before and after.
            def ticks():
                pg.touchscreen.tap(x, y) if opts.get("has_touch") else pg.mouse.move(x, y)
                pg.wait_for_timeout(150)
                return pg.inner_text("#sat-polar-info .pi-time")
            before = ticks()
            if opts.get("has_touch"):
                pg.evaluate("""(() => {
                  const o = document.querySelector('#sat-el .u-over'), r = o.getBoundingClientRect(), y = r.top + 40;
                  const ev = (type, x) => o.dispatchEvent(new PointerEvent(type, { pointerId: 7, pointerType: 'touch',
                    isPrimary: true, button: 0, clientX: x, clientY: y, bubbles: true }));
                  ev('pointerdown', r.left + r.width * 0.8);
                  for (let i = 1; i <= 10; i++) ev('pointermove', r.left + r.width * (0.8 - 0.06 * i));
                  ev('pointerup', r.left + r.width * 0.2);
                })()""")
            else:
                pg.mouse.move(b["x"] + b["width"] * 0.8, y); pg.mouse.down()
                pg.mouse.move(b["x"] + b["width"] * 0.2, y, steps=10); pg.mouse.up()
            pg.wait_for_timeout(250)
            panned = ticks()
            check("dragging pans the satellite chart", panned != before and pg.is_visible("#sat-now"),
                  f"{before!r} -> {panned!r}")
            pg.tap("#sat-now") if opts.get("has_touch") else pg.click("#sat-now")
            pg.wait_for_timeout(150)
            back = ticks()
            hhmm = lambda txt: (lambda m: int(m[1]) * 60 + int(m[2]) if m else -99)(__import__("re").search(r"(\d+):(\d\d)", txt))
            check("Now returns the chart to the current time", abs(hhmm(back) - hhmm(before)) <= 1 and not pg.is_visible("#sat-now"),
                  f"{back!r}, Now button visible: {pg.is_visible('#sat-now')}")
            first = pg.locator("#sat-passes tbody tr[data-p]").first
            first.click(); pg.wait_for_timeout(250)
            check("pass click shows it on the chart", "sel" in (first.get_attribute("class") or ""))
            pg.click("#sat-now") if pg.is_visible("#sat-now") else None

            # Precipitation map: the storage choice made in the satellites applies, then model data drawn.
            # MapLibre needs WebGL2, which headless Firefox lacks; there only check
            # that the failure is reported in the section rather than breaking the page.
            webgl2 = pg.evaluate("!!document.createElement('canvas').getContext('webgl2')")
            pg.locator("#precip").scroll_into_view_if_needed()
            map_reqs = lambda: [u for u in wx_mocked if S3.match(u) or "mesonet" in u]
            if not webgl2:
                pg.wait_for_timeout(500)
                print("  SKIP  precip map rendering (no WebGL2 in this browser)")
                check("map reports missing WebGL2", "WebGL2" in pg.inner_text("#pm-status"), pg.inner_text("#pm-status")[:80])
            else:
                check("map doesn't ask again", not pg.is_visible("#pm-consent"))
                try:
                    pg.wait_for_function("/Press Update/.test(document.querySelector('#pm-status').textContent)", timeout=30000)
                except Exception:
                    pass
                check("map: nothing downloaded on load", not map_reqs(), "; ".join(map_reqs())[:200])
                check("map: prompt to press Update", "Press Update" in pg.inner_text("#pm-status") and pg.is_enabled("#pm-update"),
                      pg.inner_text("#pm-status"))
                sec_h = pg.evaluate("document.querySelector('#precip').getBoundingClientRect().height")
                map_top = pg.evaluate("document.querySelector('#pm-map').getBoundingClientRect().top - document.querySelector('#precip').getBoundingClientRect().top")
                # There is no .om mock (S3 answers 503): the precipitation Update fails and says so.
                pg.click("#pm-update")
                try:
                    pg.wait_for_function("/Couldn't download/.test(document.querySelector('#pm-status').textContent)", timeout=15000)
                except Exception:
                    pass
                check("map: failed Update is reported", "Couldn't download" in pg.inner_text("#pm-status")
                      and any(S3.match(u) for u in map_reqs()), pg.inner_text("#pm-status"))

                # Radar: observed IEM mosaic up to now, then the RRFS reflectivity forecast.
                # Switching while at "now" lands on the radar's "now" (the latest scan).
                pg.click("#pm-now")
                pg.click("#pm-qty button[data-qty=refl]")
                pg.wait_for_timeout(300)
                check("radar: prompt to press Update", "Press Update" in pg.inner_text("#pm-status"), pg.inner_text("#pm-status"))
                pg.click("#pm-update")
                try:
                    pg.wait_for_function("/Radar to /.test(document.querySelector('#pm-status').textContent)", timeout=30000)
                    pg.wait_for_function("/Socorro: .*(dBZ|no echo)/.test(document.querySelector('#pm-value').textContent)", timeout=30000)
                except Exception:
                    pass
                st = pg.inner_text("#pm-status")
                check("radar Update loads observed scans", "Radar to" in st and "No RRFS forecast" in st, st)
                check("radar timeline steps", int(pg.get_attribute("#pm-slider", "max")) >= 10)
                pg.reload(); pg.wait_for_timeout(500)
                pg.locator("#precip").scroll_into_view_if_needed()
                n_map = len(map_reqs())
                try:
                    pg.wait_for_function("/Radar to /.test(document.querySelector('#pm-status').textContent)", timeout=30000)
                except Exception:
                    pass
                check("radar: reload shows the stored scans without asking", "Radar to" in pg.inner_text("#pm-status")
                      and not [u for u in map_reqs()[n_map:] if "radar.py" in u], pg.inner_text("#pm-status"))
                check("radar starts at the latest observed scan", "observed · latest" in pg.inner_text("#pm-time"), pg.inner_text("#pm-time"))
                check("radar reads dBZ at Socorro", "Socorro" in pg.inner_text("#pm-value"), pg.inner_text("#pm-value"))
                check("radar locks the model switch to RRFS",
                      pg.get_attribute("#pm-model button[data-model=ncep_rrfs_conus]", "aria-pressed") == "true"
                      and pg.is_disabled("#pm-model button[data-model=ncep_nbm_conus]"))
                radar_top = pg.evaluate("document.querySelector('#pm-map').getBoundingClientRect().top - document.querySelector('#precip').getBoundingClientRect().top")
                check("map stays put when switching to radar", abs(radar_top - map_top) < 0.5, f"{map_top} -> {radar_top}")
                radar_h = pg.evaluate("document.querySelector('#precip').getBoundingClientRect().height")
                check("section height same in radar view", abs(radar_h - sec_h) < 0.5, f"{sec_h} -> {radar_h}")
                check("radar legend in dBZ", pg.inner_text("#pm-legend-unit") == "dBZ")
                pg.wait_for_timeout(500)   # tiles are stored after they are drawn
                check("radar tiles stored in Cache Storage", pg.evaluate(
                    "caches.open('radar-tiles-v1').then(c => c.keys()).then(k => k.length)") > 0)
                pg.click("#pm-qty button[data-qty=precip]"); pg.wait_for_timeout(300)
                check("switch back to precipitation", pg.is_enabled("#pm-model button[data-model=ncep_nbm_conus]") and pg.inner_text("#pm-legend-unit") != "dBZ",
                      pg.inner_text("#pm-status"))

            if shots:
                pg.evaluate("window.scrollTo(0,0)")
                pg.screenshot(path=str(shots / f"{args.engine}-{prof}-{scheme}.png"), full_page=True)

            # Units: metric shows °C and wind in m/s; switch back afterwards.
            pg.click('#wx-units button[data-units="metric"]'); pg.wait_for_timeout(300)
            wind = pg.inner_text("#wx-now .tile:nth-child(2) .tile-value")
            hero = pg.inner_text("#wx-now .hero-temp")
            pg.click('#wx-units button[data-units="imperial"]'); pg.wait_for_timeout(300)
            check("metric units (°C, m/s)", "m/s" in wind and "°C" in hero, f"{hero}, {wind}")

            # Legend jitter: sweeping the cursor must not change layout.
            el = pg.locator("#sky-el .u-over"); el.scroll_into_view_if_needed(); b = el.bounding_box()
            tops, heights = set(), set()
            for f in [0.02, 0.2, 0.35, 0.5, 0.65, 0.8, 0.98]:
                pg.mouse.move(b["x"] + b["width"] * f, b["y"] + 30); pg.wait_for_timeout(40)
                tops.add(round(pg.locator("#sky-az").bounding_box()["y"]))
                heights.add(round(pg.locator("#sky-el .u-legend").bounding_box()["height"]))
            check("no legend jitter while sweeping", len(tops) == 1 and len(heights) == 1,
                  f"az chart y {sorted(tops)}, legend h {sorted(heights)}")

            # Polar legend: hover highlights everywhere; click toggles everywhere.
            pg.mouse.move(0, 0)
            cell = pg.locator('#sky-polar-info .pi-cell[data-k="4"]'); cell.scroll_into_view_if_needed()
            cell.hover(); pg.wait_for_timeout(150)
            dimmed = pg.locator("#sky-polar .target.dim").count()
            check("polar legend hover highlights", dimmed > 0, f"{dimmed} dimmed groups")
            tracks_before = pg.locator("#sky-polar path.track").count()
            cell.click(); pg.wait_for_timeout(150)
            off_rows = pg.evaluate("""[...document.querySelectorAll('#sky-el .u-legend tr, #sky-az .u-legend tr')]
                .filter(r => r.classList.contains('u-off')).length""")
            check("polar legend click hides target in all plots",
                  pg.locator("#sky-polar path.track").count() == tracks_before - 2 and off_rows == 2,
                  f"tracks {tracks_before}->{pg.locator('#sky-polar path.track').count()}, chart legend rows off {off_rows}")
            pg.locator('#sky-polar-info .pi-cell[data-k="4"]').click(); pg.wait_for_timeout(150)
            # Chart legend click -> polar cell off (and back).
            lab = pg.locator("#sky-az .u-legend tr").nth(2).locator("th"); lab.scroll_into_view_if_needed(); lab.click()
            pg.wait_for_timeout(150)
            off = "off" in (pg.get_attribute('#sky-polar-info .pi-cell[data-k="1"]', "class") or "")
            el_off = "u-off" in (pg.locator("#sky-el .u-legend tr").nth(2).get_attribute("class") or "")
            lab.click(); pg.wait_for_timeout(150)
            check("chart legend click syncs to polar + other chart", off and el_off)

            # Update refetches only what Open-Meteo has a newer model run for.
            wx_reqs.clear()
            om.new_run()
            pg.evaluate("""() => { const c = JSON.parse(localStorage.getItem('wx:v3'));
                c.fetched.forecast = Date.now() - 600e3; c.fetched.air = Date.now() + 60e3; c.checked = 0;
                localStorage.setItem('wx:v3', JSON.stringify(c)); }""")
            pg.reload(); pg.wait_for_timeout(1000)
            check("weather: nothing downloaded on reload", not wx_reqs, ", ".join(u.split("?")[0] for u in wx_reqs))
            pg.locator("#wx-update").scroll_into_view_if_needed(); pg.click("#wx-update"); pg.wait_for_timeout(1500)
            check("Update refetches the forecast when a newer run exists",
                  any("/v1/forecast" in u for u in wx_reqs) and not any("air-quality" in u for u in wx_reqs),
                  ", ".join(u.split("?")[0] for u in wx_reqs))

            # Calculator: Enter runs, units convert, errors show, history and Tab completion work.
            inp = pg.locator("#calc-input"); inp.scroll_into_view_if_needed(); inp.click()
            for line in ["x = [1, 2, 3] km", "x -> m", "undefined_name", "(1 +"]:
                inp.type(line); inp.press("Enter")
            inp.type("2)"); inp.press("Enter")
            pg.wait_for_function("document.querySelectorAll('#calc-log .calc-cell').length >= 4", timeout=10000)
            outs = pg.locator("#calc-log .calc-out").all_inner_texts()
            check("calculator converts units", any("[1000.0, 2000.0, 3000.0] m" in o for o in outs), " | ".join(outs)[:200])
            check("calculator continues an open bracket", any(o.endswith("3") for o in outs), " | ".join(outs)[:200])
            check("calculator shows errors", "NameError" in pg.inner_text("#calc-log"))
            check("calculator prompt counts", pg.inner_text("#calc-prompt") == "In [5]:", pg.inner_text("#calc-prompt"))
            inp.press("ArrowUp")
            check("calculator history recall", inp.input_value() == "(1 +\n2)", repr(inp.input_value()))
            inp.press("Escape"); inp.type("1.4 GH"); inp.press("Tab")
            check("calculator Tab completion", inp.input_value() == "1.4 GHz", inp.input_value())
            inp.press("Escape"); inp.press("Escape"); inp.type("\\epsilon"); inp.press("Tab")
            check("calculator LaTeX completion", inp.input_value() == "ϵ", inp.input_value())
            inp.press("Escape"); inp.press("Escape")
            sw = pg.evaluate("document.documentElement.scrollWidth")
            check("calculator: no horizontal page scroll", sw <= w, f"scrollWidth {sw}")

            # Every section collapses (catches ID rules overriding the collapse rule).
            bad = []
            for sec in ["clocks", "world", "sky", "sats", "moon", "weather", "precip", "calc", "links"]:
                tog = pg.locator(f'[data-section="{sec}"] .section-toggle')
                tog.scroll_into_view_if_needed(); tog.click()
                if pg.locator(f'[data-section="{sec}"] .section-body').is_visible(): bad.append(sec)
                tog.click()
            check("all sections collapse", not bad, ", ".join(bad))

            # Satellites: nothing is computed while the section is collapsed; expanding computes.
            pg.add_init_script("""(() => { const pm = Worker.prototype.postMessage; window.__satJobs = 0;
                Worker.prototype.postMessage = function (...a) { if (a[0] && a[0].sats) window.__satJobs++;
                return pm.apply(this, a); }; })()""")
            tog = pg.locator("#sat-h .section-toggle"); tog.scroll_into_view_if_needed(); tog.click()
            pg.reload(); pg.wait_for_timeout(2500)
            idle = pg.evaluate("[window.__satJobs, document.querySelectorAll('#sat-el .uplot').length]")
            pg.locator("#sat-h .section-toggle").click()
            pg.wait_for_function("document.querySelector('#sat-el .uplot')", timeout=15000)
            woke = pg.evaluate("window.__satJobs")
            check("satellite computation paused while collapsed", idle == [0, 0] and woke >= 1,
                  f"collapsed: {idle[0]} jobs, {idle[1]} charts; expanded: {woke} jobs")

            # MT/UTC switch changes legend label and table times.
            pg.click('#sky-tz button[data-tz="UTC"]'); pg.wait_for_timeout(300)
            leg_utc = pg.inner_text("#sky-el .u-legend tr:first-child")
            hdr_utc = pg.inner_text("#sky-table th.col-next") if w >= 560 else pg.inner_text("#sky-table .row-sub")
            pg.click('#sky-tz button[data-tz="America/Denver"]'); pg.wait_for_timeout(300)
            leg_mt = pg.inner_text("#sky-el .u-legend tr:first-child")
            hdr_mt = pg.inner_text("#sky-table th.col-next") if w >= 560 else pg.inner_text("#sky-table .row-sub")
            check("MT/UTC switch updates sky panel", "UTC" in leg_utc and "MT" in leg_mt and hdr_utc != hdr_mt,
                  f"{leg_utc!r} / {leg_mt!r}; {hdr_utc!r} / {hdr_mt!r}")

            if w < 560:
                cols = pg.evaluate("""[...document.querySelectorAll('.u-legend tbody, #sky-polar-info')]
                    .filter(e => e.offsetParent).map(e => getComputedStyle(e).gridTemplateColumns.split(' ').length)""")
                check("two-column legends on phone", cols and all(c == 2 for c in cols), str(sorted(set(cols))))

            # Collapse: weather collapsed persists over reload; charts size correctly on expand.
            pg.click("#wx-h .section-toggle")
            check("section collapses", not pg.is_visible("#wx-body"))
            pg.reload(); pg.wait_for_timeout(1500)
            check("collapsed state persists", not pg.is_visible("#wx-body")
                  and pg.get_attribute("#wx-h .section-toggle", "aria-expanded") == "false")
            pg.click("#wx-h .section-toggle"); pg.wait_for_timeout(400)
            widths = pg.evaluate("""[...document.querySelectorAll('#wx-charts .chart')].slice(0, 3)
                .map(c => [c.clientWidth, c.querySelector('canvas').getBoundingClientRect().width])""")
            check("charts fit after expanding", all(abs(a - b) <= 2 for a, b in widths), str(widths))

            # Location: Socorro by default; Settings can switch to the browser's location
            # (a mocked fix in Albuquerque), which only takes effect for weather on Update.
            heads = lambda: [pg.text_content(f"#{h} [data-loc-name]") for h in ("sat-h", "moon-h", "wx-h")]
            tzs = lambda: pg.eval_on_selector_all("[data-tz-label]", "els => els.map(e => e.textContent)")
            check("location: Socorro by default", heads() == ["Socorro"] * 3, str(heads()))
            check("location: Socorro times in MT", set(tzs()) == {"MT"} and "MT" in pg.inner_text("#sat-passes th.col-rise"),
                  f"{tzs()}, {pg.inner_text('#sat-passes th.col-rise')}")
            check("weather requested in MT", wx_reqs and all("timezone=America%2FDenver" in u for u in wx_reqs))
            check("weather requested for Socorro", wx_reqs and all("latitude=34.0664&longitude=-106.9065" in u for u in wx_reqs),
                  wx_reqs[-1][:120] if wx_reqs else "none")
            ctx.grant_permissions(["geolocation"], origin=args.url.rstrip("/"))
            ctx.set_geolocation({"latitude": 35.08441, "longitude": -106.65041, "accuracy": 30})
            pg.click("#open-settings")
            pg.click('#set-location button[data-loc="current"]')
            pg.wait_for_function("document.querySelector('#wx-h [data-loc-name]').textContent === 'Here'", timeout=10000)
            check("location: headings say Here", heads() == ["Here"] * 3, str(heads()))
            check("location: times in the browser's timezone", set(tzs()) == {"PT"}
                  and "PT" in pg.inner_text("#sat-passes th.col-rise") and "America/Los_Angeles" in pg.inner_text("#set-location-status"),
                  f"{tzs()}, {pg.inner_text('#sat-passes th.col-rise')}")
            check("location: settings status", "35.08°N 106.65°W" in pg.inner_text("#set-location-status"),
                  pg.inner_text("#set-location-status"))
            pg.keyboard.press("Escape")
            check("location: other location's weather hidden", "another location" in pg.inner_text("#wx-status")
                  and not pg.locator("#wx-charts .uplot").count(), pg.inner_text("#wx-status")[:100])
            check("location: Update not blocked by the 5 min wait", pg.is_enabled("#wx-update"))
            # A failed Update for the new location: old weather stays hidden, and the wait applies.
            fail = lambda route: route.fulfill(status=503, body="down")
            pg.route("https://api.open-meteo.com/v1/**", fail); failing.append("https://api.open-meteo.com/v1/")
            pg.click("#wx-update")
            pg.wait_for_function("document.querySelector('#wx-status').classList.contains('error')", timeout=10000)
            check("location: failed Update shows no other location's weather",
                  not pg.locator("#wx-charts .uplot").count() and "Couldn't download" in pg.inner_text("#wx-status"),
                  pg.inner_text("#wx-status")[:100])
            check("location: failed Update still waits 5 min", pg.is_disabled("#wx-update"))
            pg.unroute("https://api.open-meteo.com/v1/**", fail)
            pg.evaluate("(() => { const c = JSON.parse(localStorage.getItem('wx:v3')); delete c.checked; delete c.error;"
                        " localStorage.setItem('wx:v3', JSON.stringify(c)); })()")
            pg.reload(); pg.wait_for_timeout(1000)
            n_wx = len(wx_reqs)
            pg.click("#wx-update")
            pg.wait_for_function("document.querySelectorAll('#wx-charts .uplot').length > 10", timeout=15000)
            new = wx_reqs[n_wx:]
            check("location: weather requested for the new location",
                  len(new) == 2 and all("latitude=35.0844&longitude=-106.6504" in u and "timezone=America%2FLos_Angeles" in u
                                        for u in new), "; ".join(new)[:200])
            check("location: weather chart time in PT", "Time (PT)" in pg.inner_text("#wx-charts"), "")
            check("location: passes recomputed", pg.locator("#sat-passes tbody tr").count() >= 1)
            pg.click("#open-settings")
            pg.click('#set-location button[data-loc="socorro"]')
            pg.keyboard.press("Escape")
            check("location: back to Socorro", heads() == ["Socorro"] * 3 and set(tzs()) == {"MT"}, f"{heads()}, {tzs()}")
            pg.click("#wx-update")
            pg.wait_for_function("document.querySelectorAll('#wx-charts .uplot').length > 10", timeout=15000)

            # Settings (footer button): reorder + theme override persist across reload.
            pg.click("#open-settings")
            pg.click('#set-sections li[data-id="links"] button[data-move="-1"]')
            pg.click('#set-theme button[data-theme="%s"]' % ("light" if scheme == "dark" else "dark"))
            pg.keyboard.press("Escape")
            wx_reqs.clear()
            pg.reload(); pg.wait_for_timeout(1500)
            order = pg.evaluate("[...document.querySelectorAll('main > section')]"
                                ".sort((a,b)=>a.style.order-b.style.order).map(s=>s.id)")
            check("section order persists", order.index("links") < order.index("calc"), ",".join(order))
            check("theme override persists", pg.evaluate("document.documentElement.dataset.theme") in ("light", "dark"))
            check("weather served from cache on reload", not wx_reqs, f"{len(wx_reqs)} data requests")
            check("satellite elements fetched once (not on reload)", len(tle_reqs) <= 2, "; ".join(tle_reqs)[:200])
            check("CelesTrak never contacted (all requests mocked)", tle_reqs and all(u in mocked for u in tle_reqs),
                  f"{len(tle_reqs)} requests, {len(mocked)} mocked")
            check("status shows model run", "run" in pg.inner_text("#wx-status"), pg.inner_text("#wx-status"))
            live = [u for u in external if u not in mocked and u not in wx_mocked]
            check("no live service contacted (all requests mocked)", not live, "; ".join(live)[:200])
            check("no JS errors", not errors, "; ".join(errors)[:200])
            ctx.close()
    browser.close()

print(f"\n{'ALL PASSED' if not failures else f'{len(failures)} FAILED: ' + ', '.join(failures)}")
sys.exit(1 if failures else 0)
