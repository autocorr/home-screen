# /// script
# requires-python = ">=3.11"
# dependencies = ["selenium>=4.27"]
# ///
"""Smoke-test the site in the *installed* Firefox via geckodriver (WebDriver BiDi).
Selenium Manager downloads geckodriver automatically.

    uv run tests/firefox_selenium_check.py [--url URL] [--headed] [--shot FILE]
"""
import argparse
import sys
import time

from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait

ap = argparse.ArgumentParser()
ap.add_argument("--url", default="http://localhost:8765/")
ap.add_argument("--headed", action="store_true")
ap.add_argument("--shot", default=None)
args = ap.parse_args()

failures = []
def check(name, ok, detail=""):
    print(f"  {'PASS' if ok else 'FAIL'}  {name}{f'  ({detail})' if detail else ''}")
    if not ok:
        failures.append(name)

for label, (w, h), dark in [("phone-ish", (393, 851), False), ("desktop", (1280, 900), True)]:
    opts = webdriver.FirefoxOptions()
    opts.enable_bidi = True
    if not args.headed:
        opts.add_argument("-headless")
        # Firefox won't make a window narrower than ~500 px, so the "phone-ish"
        # run lands near 490 px; tests/browser_check.py covers true phone width.
        opts.add_argument(f"--width={max(w, 500)}")
        opts.add_argument(f"--height={h}")
    drv = webdriver.Firefox(options=opts)
    errors = []
    drv.script.add_javascript_error_handler(lambda e: errors.append(e.text))
    drv.script.add_console_message_handler(lambda m: errors.append(m.text) if m.level == "error" else None)
    print(f"\n[{label} {w}px, {'dark' if dark else 'light'}] Firefox {drv.capabilities['browserVersion']}")
    if args.headed:
        drv.set_window_size(w, h)
    # This test doesn't cover satellites; the page only downloads elements when Update is
    # pressed, which this test never does.
    # Window size includes browser chrome; read the real viewport width.
    drv.get(args.url)
    WebDriverWait(drv, 15).until(lambda d: d.execute_script(
        "return document.querySelectorAll('#wx-charts .uplot').length > 10"))
    js = drv.execute_script
    vw = js("return document.documentElement.clientWidth")
    check("no horizontal page scroll", js("return document.documentElement.scrollWidth") <= vw, f"viewport {vw}")
    t1 = js("return document.getElementById('clk-utc').textContent"); time.sleep(1.1)
    check("clocks tick", t1 != js("return document.getElementById('clk-utc').textContent"))
    check("sky table rows", js("return document.querySelectorAll('#sky-table tbody tr').length") == 7)
    check("charts drawn", js("return document.querySelectorAll('.uplot canvas').length") >= 22)
    check("weather tiles", js("return document.querySelectorAll('#wx-now .tile').length") == 8)
    bg = js("return getComputedStyle(document.body).backgroundColor")
    mq = js("return matchMedia('(prefers-color-scheme: dark)').matches")
    # Headless Firefox ESR may ignore the colour-scheme prefs above, so assert
    # that the page matches whatever scheme the browser reports.
    check("theme follows browser scheme", (bg == "rgb(0, 0, 0)") == mq, f"{bg}, prefers-dark={mq}")
    clipped = js("""return [...document.querySelectorAll(
        '.clock-time, .clock-sub, .day, .tile, .table-wrap, .chart-card')]
        .filter(e => e.offsetParent && e.scrollWidth > e.clientWidth + 1)
        .map(e => e.className)""")
    check("nothing overflows its box", not clipped, ", ".join(clipped))
    # Hover a weather chart; the cursor should sync to the others.
    over = drv.find_elements(By.CSS_SELECTOR, "#wx-charts .u-over")[0]
    drv.execute_script("arguments[0].scrollIntoView({block:'center'})", over)
    webdriver.ActionChains(drv).move_to_element(over).perform(); time.sleep(0.3)
    leg = drv.find_elements(By.CSS_SELECTOR, "#wx-charts .u-legend")[4].text.replace("\n", " ")
    check("chart cursor syncs", "mph" in leg or "m/s" in leg, leg[:60])
    drv.refresh(); time.sleep(1.5)
    status = js("return document.getElementById('wx-status').textContent")
    check("weather cached across reload", "fetched" in status and "Updating" not in status, status)
    check("no JS errors", not errors, "; ".join(errors)[:200])
    if args.shot:
        drv.execute_script("window.scrollTo(0,0)")
        drv.save_screenshot(args.shot.replace(".png", f"-{label}.png"))
    drv.quit()

print(f"\n{'ALL PASSED' if not failures else f'{len(failures)} FAILED: ' + ', '.join(failures)}")
sys.exit(1 if failures else 0)
