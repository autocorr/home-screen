#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "pillow"]
# ///
"""Build the radar ground-clutter map: site/data/n0q_clutter.png + site/js/data/clutter.js.

The IEM NEXRAD mosaic (N0Q) shows weak, persistent echoes where a radar beam
grazes nearby mountains (Sandia/Manzano from KABX, the San Andres, Organ and
Franklin ranges from KEPZ, the Sacramentos from KHDX, Mt Taylor). This script
samples past scans over the precip-map cut-out, keeps the clear ones, and
stores two numbers per pixel, both as N0Q palette indices (dBZ = 0.5 i - 32.5):

  R  clutter limit: where a pixel shows echo (>= 5 dBZ) in at least
     MIN_PERSIST of clear scans, the 95th percentile of those echoes; 0
     elsewhere. The page hides values at or below it.
  G  clutter level: the median of the clear-scan values in linear Z (no echo
     = 0). The page subtracts it, in linear Z, from values above the limit.

The grid is the page's own: zoom-8 Web Mercator pixels over PRECIP_MAP.bounds.
WMS images (on the mosaic's 0.005° lat/lon grid) are resampled onto it the
way IEM resamples its tiles: they agree pixel for pixel.

Being polite to IEM: scans come from its WMS (one ~60 kB image per scan rather
than ~24 tiles), one request at a time, at most one every DELAY seconds. Every
image is cached in --cache, so reruns fetch only scans not seen before. Any
HTTP error other than 404 stops the run (rerun later to continue).
--tiles also reads zoom-8 tiles already on disk ("<yyyymmddhhmm>_<x>_<y>.png").

Clutter is set by terrain and the radars, so this needs rerunning only when
those change (a radar is moved or re-sited), or with a different cut-out.

Run:  uv run scripts/build_clutter.py [--days 365] [--every-h 29] [--cache DIR] [--tiles DIR]
"""
import argparse
import math
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
OUT_PNG = ROOT / "site/data/n0q_clutter.png"
OUT_JS = ROOT / "site/js/data/clutter.js"
BOUNDS = (-109.6, 31.6, -104.2, 36.6)   # PRECIP_MAP.bounds in site/js/config.js
Z = 8                                    # NATIVE_Z in site/js/map/iem.js
RES = 0.005                              # mosaic grid, degrees
WMS = ("https://mesonet.agron.iastate.edu/cgi-bin/wms/nexrad/n0q-t.cgi?SERVICE=WMS&VERSION=1.1.1"
       "&REQUEST=GetMap&LAYERS=nexrad-n0q-wmst&STYLES=&SRS=EPSG:4326&BBOX={w},{s},{e},{n}"
       "&WIDTH={nx}&HEIGHT={ny}&FORMAT=image/png&TRANSPARENT=true&TIME={time}")
UA = "home-screen build script"
DELAY = 2.0          # seconds between requests
LIT = 75             # palette index of 5 dBZ, the map's lowest visible value
WET = 105            # 20 dBZ
CLEAR_WET = 0.002    # a scan is clear when < 0.2% of non-clutter pixels are >= 20 dBZ
CLEAR_LIT = 0.03     #   and < 3% of them are >= 5 dBZ
MIN_PERSIST = 0.10   # a pixel is clutter when it shows echo in >= 10% of clear scans
LIMIT_PCT = 95


def palette():
    src = (ROOT / "site/js/map/iem.js").read_text()
    hexs = "".join(l.split("'")[1] for l in src.split("PALETTE_HEX =")[1].split(";")[0].splitlines() if "'" in l)
    lut = np.zeros(1 << 24, np.uint8)   # packed RGB -> index; unknown colours read as no echo
    for i in range(1, 256):
        lut[int(hexs[i * 6:i * 6 + 6], 16)] = i
    return lut


PAL = palette()


def decode(path):
    a = np.asarray(Image.open(path).convert("RGBA"))
    rgb = (a[..., 0].astype(np.int32) << 16) | (a[..., 1].astype(np.int32) << 8) | a[..., 2]
    return np.where(a[..., 3] >= 128, PAL[rgb], 0).astype(np.uint8)


# ---------- grids ----------

def lon2x(lon): return (lon + 180) / 360 * 256 * 2 ** Z
def lat2y(lat):
    s = math.sin(math.radians(lat))
    return (0.5 - math.log((1 + s) / (1 - s)) / (4 * math.pi)) * 256 * 2 ** Z
def x2lon(x): return x / (256 * 2 ** Z) * 360 - 180
def y2lat(y): return math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / (256 * 2 ** Z)))))


W, S, E, N = BOUNDS
X0, X1 = math.floor(lon2x(W)), math.ceil(lon2x(E))
Y0, Y1 = math.floor(lat2y(N)), math.ceil(lat2y(S))
NX, NY = round((E - W) / RES), round((N - S) / RES)
# Mercator pixel centre -> WMS (lat/lon grid) pixel. The half-pixel shift is what
# matches IEM's own tiles (99.96% of echo pixels identical on a scan fetched both ways).
COLS = np.clip(np.floor((np.array([x2lon(x + 0.5) for x in range(X0, X1)]) - W) / RES - 0.5).astype(int), 0, NX - 1)
ROWS = np.clip(np.floor((N - np.array([y2lat(y + 0.5) for y in range(Y0, Y1)])) / RES + 0.5).astype(int), 0, NY - 1)


def from_wms(idx): return idx[np.ix_(ROWS, COLS)]


def from_tiles(tiles, ts):
    out = np.zeros((Y1 - Y0, X1 - X0), np.uint8)
    for ty in range(Y0 >> 8, ((Y1 - 1) >> 8) + 1):
        for tx in range(X0 >> 8, ((X1 - 1) >> 8) + 1):
            p = tiles / f"{ts}_{tx}_{ty}.png"
            if not p.exists():
                return None
            t = decode(p)
            ya, yb = max(Y0, ty * 256), min(Y1, ty * 256 + 256)
            xa, xb = max(X0, tx * 256), min(X1, tx * 256 + 256)
            out[ya - Y0:yb - Y0, xa - X0:xb - X0] = t[ya - ty * 256:yb - ty * 256, xa - tx * 256:xb - tx * 256]
    return out


# ---------- fetching ----------

last_request = 0.0


def fetch_wms(cache, t):
    ts = t.strftime("%Y%m%d%H%M")
    p = cache / f"n0q_{ts}.png"
    if p.exists():
        return p
    global last_request
    time.sleep(max(0.0, last_request + DELAY - time.monotonic()))
    last_request = time.monotonic()
    url = WMS.format(w=W, s=S, e=E, n=N, nx=NX, ny=NY, time=t.strftime("%Y-%m-%dT%H:%M:00Z"))
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=60) as r:
            body, ctype = r.read(), r.headers.get("Content-Type", "")
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise SystemExit(f"IEM answered {e.code} for {ts}; stopping (rerun later, cached scans are kept)")
    if not ctype.startswith("image/png"):
        # MapServer reports errors (e.g. no data for that time) as XML with status 200.
        print(f"  {ts}: no image ({ctype})")
        return None
    tmp = p.with_suffix(".part")
    tmp.write_bytes(body)
    tmp.rename(p)
    return p


# ---------- main ----------

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--days", type=int, default=365, help="sample this many past days")
    ap.add_argument("--every-h", type=int, default=29, help="hours between samples (not a divisor of 24, so all hours get covered)")
    ap.add_argument("--end", default=None, help="last sample, YYYY-MM-DD (default: yesterday)")
    ap.add_argument("--cache", type=Path, default=Path.home() / ".cache/home-screen/n0q", help="WMS image cache")
    ap.add_argument("--tiles", type=Path, default=None, help="directory of zoom-8 tiles already fetched")
    args = ap.parse_args()
    args.cache.mkdir(parents=True, exist_ok=True)

    end = (datetime.fromisoformat(args.end).replace(tzinfo=timezone.utc) if args.end
           else datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(days=1))
    times = []
    t = end
    while t > end - timedelta(days=args.days):
        times.append(t)
        t -= timedelta(hours=args.every_h)

    scans, names = [], []
    if args.tiles:
        stamps = sorted({p.name.split("_")[0] for p in args.tiles.glob("*_*_*.png")})
        for ts in stamps:
            a = from_tiles(args.tiles, ts)
            if a is not None:
                scans.append(a); names.append(ts)
        print(f"{len(scans)} scans from tiles in {args.tiles}")
    have = set(names)
    todo = [t for t in times if t.strftime("%Y%m%d%H%M") not in have]
    cached = sum((args.cache / f"n0q_{t.strftime('%Y%m%d%H%M')}.png").exists() for t in todo)
    print(f"{len(todo)} WMS scans wanted, {cached} cached, {len(todo) - cached} to fetch (~{(len(todo) - cached) * DELAY / 60:.0f} min)")
    for k, t in enumerate(todo):
        p = fetch_wms(args.cache, t)
        if p is not None:
            scans.append(from_wms(decode(p))); names.append(t.strftime("%Y%m%d%H%M"))
        if (k + 1) % 25 == 0:
            print(f"  {k + 1}/{len(todo)}")
    st = np.stack(scans)
    print(f"{len(st)} scans, grid {st.shape[2]} x {st.shape[1]}")

    # Clear scans. Clutter itself reaches 20 dBZ, so judge each scan on pixels
    # that aren't often lit across all scans (rain is rarely that persistent).
    common = (st >= LIT).mean(axis=0) >= 0.3
    rest = ~common
    wet = (st[:, rest] >= WET).mean(axis=1)
    lit = (st[:, rest] >= LIT).mean(axis=1)
    clear = (wet < CLEAR_WET) & (lit < CLEAR_LIT)
    c = st[clear]
    print(f"{clear.sum()} clear scans ({(~clear).sum()} with weather left out)")
    if clear.sum() < 50:
        raise SystemExit("too few clear scans for a reliable map; sample more (--days/--every-h)")

    persist = (c >= LIT).mean(axis=0)
    # The limit is a percentile of the values the clutter takes when it shows,
    # not of all clear scans: a pixel lit in 10% of them would otherwise get
    # the middle of its clutter values as its limit.
    limit = np.zeros(persist.shape, np.uint8)
    sel = persist >= MIN_PERSIST
    v = c[:, sel].astype(np.float64)
    v[v < LIT] = np.nan
    limit[sel] = np.nanpercentile(v, LIMIT_PCT, axis=0, method="higher").astype(np.uint8)
    zlin = np.where(c > 0, 10 ** ((0.5 * c.astype(np.float64) - 32.5) / 10), 0)
    zmed = np.median(zlin, axis=0)
    level = np.where(zmed > 0, np.clip(np.round((10 * np.log10(np.maximum(zmed, 1e-9)) + 32.5) * 2), 1, 255), 0).astype(np.uint8)
    level[limit == 0] = 0


    n = int((limit >= LIT).sum())
    print(f"clutter pixels (limit >= 5 dBZ): {n} ({n / limit.size:.2%}); "
          f"limit p50/p90 = {np.percentile(0.5 * limit[limit >= LIT] - 32.5, [50, 90])} dBZ")

    OUT_PNG.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(np.dstack([limit, level, np.zeros_like(limit)]), "RGB").save(OUT_PNG, optimize=True)
    first, last = min(names), max(names)
    OUT_JS.write_text(
        "// Generated by scripts/build_clutter.py; do not edit.\n"
        "// Ground-clutter map for the IEM N0Q mosaic: see that script and site/js/map/iem.js.\n"
        "export const CLUTTER = {\n"
        f"  url: 'data/{OUT_PNG.name}',  // relative to the page\n"
        f"  z: {Z}, x0: {X0}, y0: {Y0}, width: {X1 - X0}, height: {Y1 - Y0},  // zoom-{Z} Web Mercator pixels\n"
        f"  scans: {int(clear.sum())}, from: '{first[:8]}', to: '{last[:8]}',\n"
        "};\n")
    print(f"wrote {OUT_PNG.relative_to(ROOT)} ({OUT_PNG.stat().st_size // 1024} kB) and {OUT_JS.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
