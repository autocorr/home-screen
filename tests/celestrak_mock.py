"""A stand-in for CelesTrak's GP query API, so the tests never contact celestrak.org.

It serves FORMAT=csv (OMM) element sets in CelesTrak's column layout: the satellites in
site/js/data/satmags.js plus those named in config.js (ISS, Tiangong, BlueWalker 3, the
BlueBirds), with made-up but realistic low-Earth orbits. Epochs are a few hours before
the test starts, so pass predictions look like live data. The orbits are seeded, so a
run is repeatable apart from the time of day.

    from celestrak_mock import celestrak_mock
    page.route(CELESTRAK, celestrak_mock())
"""
import random
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import parse_qs, urlparse

# Every CelesTrak host and scheme: nothing gets through to the real site.
CELESTRAK = re.compile(r"^https?://([^/]*\.)?celestrak\.(org|com)(/|$)")

ROOT = Path(__file__).resolve().parent.parent
HEAD = ("OBJECT_NAME,OBJECT_ID,EPOCH,MEAN_MOTION,ECCENTRICITY,INCLINATION,RA_OF_ASC_NODE,"
        "ARG_OF_PERICENTER,MEAN_ANOMALY,EPHEMERIS_TYPE,CLASSIFICATION_TYPE,NORAD_CAT_ID,"
        "ELEMENT_SET_NO,REV_AT_EPOCH,BSTAR,MEAN_MOTION_DOT,MEAN_MOTION_DDOT")
# Inclinations typical of the visual group: ISS-like, Starlink-ish, Soviet rocket
# stages (71°, 74°, 82°) and sun-synchronous.
INCLINATIONS = [51.6, 53.0, 65.0, 71.0, 74.0, 81.2, 82.5, 97.6, 98.2, 99.0]
NAMED = {25544: ("ISS (ZARYA)", 51.64, 15.50), 48274: ("CSS (TIANHE)", 41.47, 15.60),
         53807: ("BLUEWALKER 3", 53.2, 15.18), 20580: ("HST", 28.47, 15.28)}


def catalog_ids():
    """NORAD ids the page knows magnitudes for (satmags.js and config.js)."""
    text = (ROOT / "site/js/data/satmags.js").read_text() + (ROOT / "site/js/config.js").read_text()
    ids = {int(x) for x in re.findall(r"\b(\d{3,6})\s*:", text)}
    return sorted(i for i in ids if i >= 100)


def row(cat, rng, epoch):
    name, inc, mm = NAMED.get(cat, (f"OBJECT {cat}", rng.choice(INCLINATIONS) + rng.uniform(-0.3, 0.3),
                                    rng.uniform(14.1, 15.6)))
    return ",".join([
        f'"{name}"', f"20{cat % 100:02d}-{cat % 97 + 1:03d}A", epoch.strftime("%Y-%m-%dT%H:%M:%S.%f"),
        f"{mm:.8f}", f"{rng.uniform(0.0002, 0.004):.7f}", f"{inc:.4f}", f"{rng.uniform(0, 360):.4f}",
        f"{rng.uniform(0, 360):.4f}", f"{rng.uniform(0, 360):.4f}", "0", "U", str(cat), "999",
        str(rng.randint(1000, 90000)), f"{rng.uniform(1e-5, 4e-4):.6e}", "0.00001", "0",
    ])


def mock_csv(ids=None, now=None, seed=1):
    """CSV text for the given NORAD ids (default: the whole mock group)."""
    now = now or datetime.now(timezone.utc)
    rng = random.Random(seed)
    rows = {}
    for cat in catalog_ids():
        epoch = now - timedelta(hours=rng.uniform(2, 12))
        rows[cat] = row(cat, rng, epoch)
    pick = [c for c in (ids or [c for c in rows if c != 53807]) if c in rows]  # BlueWalker 3 is not in the group
    return "\n".join([HEAD] + [rows[c] for c in pick]) + "\n"


def celestrak_mock(log=None):
    """A Playwright route handler answering GP queries; anything else gets a 404."""
    now = datetime.now(timezone.utc)

    def handle(route):
        url = route.request.url
        if log is not None:
            log.append(url)
        q = {k: v[0] for k, v in parse_qs(urlparse(url).query).items()}
        cors = {"access-control-allow-origin": "*"}
        if urlparse(url).path.endswith("/gp.php") and q.get("FORMAT", "").lower() == "csv":
            if "GROUP" in q:
                return route.fulfill(status=200, body=mock_csv(now=now), headers={**cors, "content-type": "text/csv"})
            if "CATNR" in q and q["CATNR"].isdigit():
                return route.fulfill(status=200, body=mock_csv([int(q["CATNR"])], now=now),
                                     headers={**cors, "content-type": "text/csv"})
        route.fulfill(status=404, body=f"celestrak_mock: no mock for {url}", headers=cors)

    return handle
