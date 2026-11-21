# /// script
# requires-python = ">=3.11"
# dependencies = ["astropy", "nodejs-wheel"]
# ///
"""Cross-check the site's in-browser astronomy (astronomy-engine via
site/js/astro.js) against astropy for the VLA.

Run:  uv run scripts/check_astro.py
"""
import json
import subprocess
import sys
from pathlib import Path

import astropy.units as u
import numpy as np
from astropy.coordinates import AltAz, EarthLocation, SkyCoord, get_body
from astropy.time import Time

ROOT = Path(__file__).resolve().parent.parent
SOURCES = {  # keep in sync with site/js/config.js
    "3C48": ("01h37m41.299431s", "+33d09m35.13299s"),
    "3C84": ("03h19m48.160102s", "+41d30m42.10305s"),
    "3C138": ("05h21m09.886021s", "+16d38m22.05122s"),
    "3C147": ("05h42m36.137916s", "+49d51m07.23356s"),
    "3C286": ("13h31m08.287984s", "+30d30m32.95886s"),
}
TOL_ARCSEC = 10.0  # far below what the plots can show

vla = EarthLocation.of_site("vla")
now = Time.now()
times = now + np.linspace(-12, 12, 25) * u.hour
unix = [float(t) for t in times.unix]

node = subprocess.run(
    [str(Path(sys.executable).with_name("node")), str(ROOT / "scripts/astro_dump.mjs"), json.dumps(unix)],
    check=True, capture_output=True, text=True,
)
js = json.loads(node.stdout)

frame = AltAz(obstime=times, location=vla)  # no pressure => no refraction
ref = {n: SkyCoord(ra, dec, frame="icrs").transform_to(frame) for n, (ra, dec) in SOURCES.items()}
ref["Sun"] = get_body("sun", times, vla).transform_to(frame)
ref["Moon"] = get_body("moon", times, vla).transform_to(frame)

ok = True
lst_ref = times.sidereal_time("apparent", longitude=vla.lon).hour
dlst = np.abs(((np.array(js["lst"]) - lst_ref + 12) % 24) - 12) * 3600
print(f"LST      max |diff| = {dlst.max():8.3f} s")
ok &= dlst.max() < 1.0
for name, c in ref.items():
    p = np.array(js["positions"][name])
    d_el = np.abs(p[:, 0] - c.alt.deg) * 3600
    d_az = np.abs(((p[:, 1] - c.az.deg + 180) % 360) - 180) * np.cos(np.radians(c.alt.deg)) * 3600
    worst = max(d_el.max(), d_az.max())
    flag = "ok" if worst < TOL_ARCSEC else "FAIL"
    ok &= worst < TOL_ARCSEC
    print(f"{name:6s}   max |dEl| = {d_el.max():6.2f}\"  max |dAz cos El| = {d_az.max():6.2f}\"  {flag}")
sys.exit(0 if ok else 1)
