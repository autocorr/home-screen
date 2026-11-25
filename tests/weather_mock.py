"""Stand-ins for the weather and map services, so the browser tests never contact them.

- Open-Meteo API (api.open-meteo.com, air-quality-api.open-meteo.com): /v1/forecast and
  /v1/air-quality answer with smooth made-up series for exactly the variables, days and
  time zone asked for (timeformat=unixtime); /data/<model>/static/meta.json reports a
  model run whose time the test can move (`OpenMeteoMock.new_run()`).
- Open-Meteo spatial files on S3: answered 503. There is no .om mock, so the precipitation
  view's Update fails, and the radar view shows the observed scans with the RRFS
  forecast missing.
- IEM radar: the scan list (one scan every 5 min) and blank (no echo) mosaic tiles.
- Basemaps: an empty vector style and blank raster tiles.

    from weather_mock import install_mocks
    om = install_mocks(context, log)   # log: list collecting every mocked URL
"""
import json
import math
import re
import struct
import zlib
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qs, urlparse
from zoneinfo import ZoneInfo

OPEN_METEO = re.compile(r"^https?://([^/]*\.)?open-meteo\.com(/|$)")
S3 = re.compile(r"^https?://openmeteo\.s3[^/]*\.amazonaws\.com(/|$)")
IEM = re.compile(r"^https?://mesonet\.agron\.iastate\.edu(/|$)")
BASEMAPS = re.compile(r"^https?://([^/]*\.)?(openfreemap\.org|openstreetmap\.org|opentopomap\.org)(/|$)")
CORS = {"access-control-allow-origin": "*", "access-control-expose-headers": "*"}


def blank_png(w=256, h=256):
    """A fully transparent RGBA PNG."""
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    raw = b"".join(b"\0" + b"\0" * (4 * w) for _ in range(h))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


BLANK = blank_png()


def series(name, t):
    """A plausible value of variable `name` at unix time t (s)."""
    hour = (t / 3600 - 7) % 24          # Mountain Time, roughly
    day = math.sin((hour - 9) / 24 * 2 * math.pi)  # peaks mid-afternoon
    if name.startswith("temperature") or name == "apparent_temperature":
        return round(10 + 8 * day, 1)
    if name == "dew_point_2m":
        return round(-2 + 2 * day, 1)
    if name == "relative_humidity_2m":
        return round(45 - 20 * day)
    if name in ("precipitation", "snowfall", "precipitation_sum"):
        return 0.0
    if "probability" in name:
        return 10
    if name.startswith("wind_speed") or name.startswith("wind_gusts"):
        return round(12 + 6 * day + (8 if "gusts" in name else 0), 1)
    if name == "wind_direction_10m":
        return round((200 + 40 * day) % 360)
    if name == "visibility":
        return 40000.0
    if name.endswith("radiation"):
        return round(max(0.0, 800 * math.sin((hour - 6) / 12 * math.pi)) if 6 <= hour <= 18 else 0.0)
    if name == "cape":
        return 50.0
    if name == "freezing_level_height":
        return 3200.0
    if name == "weather_code":
        return 1
    if name in ("pressure_msl",):
        return 1015.0
    if name == "surface_pressure":
        return 860.0
    if name.startswith("cloud_cover"):
        return 20
    if name.startswith("uv_index"):
        return round(max(0.0, 6 * math.sin((hour - 6) / 12 * math.pi)), 1) if 6 <= hour <= 18 else 0.0
    if name == "is_day":
        return 1 if 6 <= hour < 18 else 0
    if name == "total_column_integrated_water_vapour":
        return 8.0
    if name == "us_aqi":
        return 35
    if name == "aerosol_optical_depth":
        return 0.08
    return 5.0   # gases and particulates, µg/m³


def forecast_json(q):
    tz = ZoneInfo(q.get("timezone", "UTC"))
    past, days = int(q.get("past_days", 0)), int(q.get("forecast_days", 7))
    today = datetime.now(tz).replace(hour=0, minute=0, second=0, microsecond=0)
    start = today - timedelta(days=past)
    day_starts = [start + timedelta(days=i) for i in range(past + days)]
    t0, t1 = int(day_starts[0].timestamp()), int((day_starts[-1] + timedelta(days=1)).timestamp())
    out = {"latitude": float(q.get("latitude", 0)), "longitude": float(q.get("longitude", 0)),
           "timezone": str(tz), "utc_offset_seconds": int(today.utcoffset().total_seconds())}
    for block, step in (("minutely_15", 900), ("hourly", 3600)):
        names = [n for n in q.get(block, "").split(",") if n]
        if names:
            ts = list(range(t0, t1, step))
            out[block] = {"time": ts, **{n: [series(n, t) for t in ts] for n in names}}
    names = [n for n in q.get("daily", "").split(",") if n]
    if names:
        ts = [int(d.timestamp()) for d in day_starts]
        d = {"time": ts}
        for n in names:
            if n == "sunrise":
                d[n] = [t + 7 * 3600 for t in ts]
            elif n == "sunset":
                d[n] = [t + 17 * 3600 for t in ts]
            elif n.endswith("_max"):
                d[n] = [max(series(n[:-4], t + h * 3600) for h in range(24)) for t in ts]
            elif n.endswith("_min"):
                d[n] = [min(series(n[:-4], t + h * 3600) for h in range(24)) for t in ts]
            else:
                d[n] = [series(n, t + 12 * 3600) for t in ts]
        out["daily"] = d
    return out


class OpenMeteoMock:
    def __init__(self):
        self.run = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0) - timedelta(hours=1)

    def new_run(self):
        """Publish a newer model run (meta.json), as Open-Meteo does about hourly."""
        self.run = datetime.now(timezone.utc)

    def handle(self, route):
        u = urlparse(route.request.url)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        if re.fullmatch(r"/data/[^/]+/static/meta\.json", u.path):
            init = int(self.run.timestamp()) - 3600
            body = {"last_run_initialisation_time": init, "last_run_availability_time": int(self.run.timestamp())}
            return route.fulfill(status=200, body=json.dumps(body), headers={**CORS, "content-type": "application/json"})
        if u.path in ("/v1/forecast", "/v1/air-quality"):
            cost = "3.6" if u.path == "/v1/forecast" else "1.0"
            return route.fulfill(status=200, body=json.dumps(forecast_json(q)),
                                 headers={**CORS, "content-type": "application/json", "x-ratelimit-cost": cost})
        route.fulfill(status=404, body=f"weather_mock: no mock for {route.request.url}", headers=CORS)


def iem(route):
    u = urlparse(route.request.url)
    q = {k: v[0] for k, v in parse_qs(u.query).items()}
    if u.path == "/json/radar.py":
        end = datetime.fromisoformat(q["end"].replace("Z", "+00:00"))
        start = datetime.fromisoformat(q["start"].replace("Z", "+00:00"))
        t = end.replace(minute=end.minute - end.minute % 5, second=0, microsecond=0) - timedelta(minutes=5)
        scans = []
        while t >= start:
            scans.append({"ts": t.strftime("%Y-%m-%dT%H:%MZ")})
            t -= timedelta(minutes=5)
        return route.fulfill(status=200, body=json.dumps({"scans": scans[::-1]}),
                             headers={**CORS, "content-type": "application/json"})
    if u.path.startswith("/cache/tile.py/"):
        return route.fulfill(status=200, body=BLANK, headers={**CORS, "content-type": "image/png"})
    route.fulfill(status=404, body="weather_mock: no IEM mock", headers=CORS)


def basemap(route):
    u = urlparse(route.request.url)
    if u.path.startswith("/styles/"):
        style = {"version": 8, "sources": {}, "layers": [{"id": "bg", "type": "background",
                                                          "paint": {"background-color": "#ddd"}}]}
        return route.fulfill(status=200, body=json.dumps(style), headers={**CORS, "content-type": "application/json"})
    route.fulfill(status=200, body=BLANK, headers={**CORS, "content-type": "image/png"})


def install_mocks(ctx, log=None):
    """Route every weather and map service of the page to mocks. Returns the Open-Meteo mock."""
    om = OpenMeteoMock()

    def logged(fn):
        def h(route):
            if log is not None:
                log.append(route.request.url)
            fn(route)
        return h

    ctx.route(OPEN_METEO, logged(om.handle))
    ctx.route(S3, logged(lambda r: r.fulfill(status=503, body="weather_mock: no S3 mock", headers=CORS)))
    ctx.route(IEM, logged(iem))
    ctx.route(BASEMAPS, logged(basemap))
    return om
