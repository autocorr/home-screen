// Pure astronomy helpers (no DOM). Uses the global `Astronomy` from
// vendor/astronomy.browser.min.js (astronomy-engine).
// Positions are topocentric, apparent (precession, nutation, aberration),
// with NO atmospheric refraction, i.e. geometric elevation.

const A = () => globalThis.Astronomy;

export const mod = (x, m) => ((x % m) + m) % m;

export function parseSexagesimal(s) {
  const t = s.trim();
  const sign = t.startsWith('-') ? -1 : 1;
  const [a, b = 0, c = 0] = t.replace(/^[+-]/, '').split(':').map(Number);
  return sign * (a + b / 60 + c / 3600);
}

export function formatHMS(hours, secDigits = 0) {
  const h = mod(hours, 24);
  let total = h * 3600;
  const hh = Math.floor(total / 3600); total -= hh * 3600;
  const mm = Math.floor(total / 60); total -= mm * 60;
  const ss = secDigits ? total.toFixed(secDigits).padStart(3 + secDigits, '0')
                       : String(Math.floor(total)).padStart(2, '0');
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${ss}`;
}

export const mjd = (date) => date.getTime() / 86400000 + 40587;

export function observer(loc) {
  return new (A().Observer)(loc.lat, loc.lon, loc.height);
}

/** Local apparent sidereal time in hours. */
export function lstHours(date, lonDeg) {
  return mod(A().SiderealTime(date) + lonDeg / 15, 24);
}

/**
 * Build target descriptors. Fixed sources are registered as user-defined
 * stars (astronomy-engine supports Star1..Star8).
 */
export function makeTargets(sources, extra = []) {
  const Ast = A();
  const slots = ['Star1', 'Star2', 'Star3', 'Star4', 'Star5', 'Star6', 'Star7', 'Star8'];
  if (sources.length > slots.length) throw new Error('At most 8 fixed sources supported');
  const targets = sources.map((s, i) => {
    const body = Ast.Body[slots[i]];
    // Distance only matters for parallax; use something effectively infinite.
    Ast.DefineStar(body, parseSexagesimal(s.ra), parseSexagesimal(s.dec), 1e9);
    return { ...s, body, kind: 'source' };
  });
  return targets.concat(extra.map((e) => ({ ...e, body: Ast.Body[e.bodyName] })));
}

/** Elevation/azimuth (deg) plus apparent RA (h) and hour angle (h). */
export function position(target, date, obs, lonDeg) {
  const Ast = A();
  const eq = Ast.Equator(target.body, date, obs, true, true);
  const hor = Ast.Horizon(date, obs, eq.ra, eq.dec);
  const ha = mod(lstHours(date, lonDeg) - eq.ra + 12, 24) - 12; // -12..12
  return { el: hor.altitude, az: hor.azimuth, ra: eq.ra, dec: eq.dec, ha };
}

/**
 * Sample tracks for all targets on a common time grid.
 * Returns { t: [unix seconds], tracks: [{ el: [], az: [] }] }.
 */
export function tracks(targets, obs, lonDeg, t0, t1, stepSec) {
  const t = [];
  for (let s = t0; s <= t1; s += stepSec) t.push(s);
  const out = targets.map(() => ({ el: new Array(t.length), az: new Array(t.length) }));
  t.forEach((sec, i) => {
    const date = new Date(sec * 1000);
    targets.forEach((tg, k) => {
      const p = position(tg, date, obs, lonDeg);
      out[k].el[i] = p.el;
      out[k].az[i] = p.az;
    });
  });
  return { t, tracks: out };
}

/**
 * Next time (Date) the target crosses elevation `el` going up or down,
 * searched by bisection over a sampled track. Returns null if none in window.
 */
export function nextCrossing(target, obs, lonDeg, from, el, rising, hours = 24) {
  const step = 600; // 10 min coarse step
  const f = (sec) => position(target, new Date(sec * 1000), obs, lonDeg).el - el;
  let a = from.getTime() / 1000, fa = f(a);
  for (let b = a + step; b <= a + hours * 3600 + step; b += step) {
    const fb = f(b);
    if ((rising && fa < 0 && fb >= 0) || (!rising && fa >= 0 && fb < 0)) {
      let lo = b - step, hi = b;
      for (let i = 0; i < 20; i++) {
        const mid = (lo + hi) / 2;
        const fm = f(mid);
        if ((fm >= 0) === rising) hi = mid; else lo = mid;
      }
      return new Date(hi * 1000);
    }
    fa = fb;
  }
  return null;
}
