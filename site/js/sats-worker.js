// Pass finder for the satellites section, run in a Web Worker so ~150
// satellites x 2 days of SGP4 don't block the page.
//
// Request:  { seq, sats: [{id, omm, stdMag}], t0, step, n, sun, obs,
//             darkSunEl, minPassEl, arrays }
//   Times are t0 + i*step (unix s), i < n. `sun` = { t0, step, el: Float32Array,
//   v: Float64Array (unit vectors, equator of date) } sampled coarsely; it is
//   interpolated here. `arrays`: return per-sample tracks for visible passes.
// Response: { seq, passes: [...] } (see passOut below), sorted by rise time.
//
// Each satellite is first scanned every COARSE samples; only stretches where it
// is near or above the horizon are sampled at the full step.
/* global satellite */
importScripts('../vendor/satellite.js/satellite.min.js');

const S = self.satellite;
const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const RE = 6378.137;  // km
const COARSE = 4;     // coarse scan every 4 steps (60 s at 15 s)
const NEAR = -8;      // a coarse sample this high (deg) may belong to a pass
const recs = new Map();

function satrec(s) {
  const key = `${s.omm.EPOCH}|${s.omm.MEAN_ANOMALY}`;
  let r = recs.get(s.id);
  if (!r || r.key !== key) { r = { key, rec: S.json2satrec(s.omm) }; recs.set(s.id, r); }
  return r.rec;
}

self.onmessage = (e) => {
  const q = e.data;
  const gd = { latitude: q.obs.lat * D2R, longitude: q.obs.lon * D2R, height: q.obs.height / 1000 };
  const obsEcf = S.geodeticToEcf(gd);
  const { sun } = q;
  const sunAt = (sec) => {
    const f = (sec - sun.t0) / sun.step, j = Math.max(0, Math.min(sun.el.length - 2, Math.floor(f))), w = f - j;
    const v = sun.v;
    return {
      el: sun.el[j] + (sun.el[j + 1] - sun.el[j]) * w,
      s: [0, 1, 2].map((m) => v[3 * j + m] + (v[3 * j + 3 + m] - v[3 * j + m]) * w),
    };
  };
  // el/az (deg), sunlit, magnitude (NaN unless sunlit)
  const look = (rec, sec, stdMag, full) => {
    const date = new Date(sec * 1000);
    const pv = S.propagate(rec, date);
    const p = pv && pv.position;
    if (!p || typeof p !== 'object' || !Number.isFinite(p.x)) return null;
    const gmst = S.gstime(date);
    const la = S.ecfToLookAngles(gd, S.eciToEcf(p, gmst));
    const el = la.elevation * R2D;
    if (!full) return { el };
    const sn = sunAt(sec), [sx, sy, sz] = sn.s;
    const d = p.x * sx + p.y * sy + p.z * sz;
    const lit = d > 0 || p.x * p.x + p.y * p.y + p.z * p.z - d * d > RE * RE;
    let mag = NaN;
    if (lit) {
      const o = S.ecfToEci(obsEcf, gmst);
      const dx = o.x - p.x, dy = o.y - p.y, dz = o.z - p.z, rng = Math.hypot(dx, dy, dz);
      const phi = Math.acos(Math.max(-1, Math.min(1, (dx * sx + dy * sy + dz * sz) / rng)));
      const f = Math.sin(phi) + (Math.PI - phi) * Math.cos(phi);
      mag = stdMag - 15 + 5 * Math.log10(rng) - 2.5 * Math.log10(Math.max(f, 1e-3));
    }
    return { el, az: ((la.azimuth * R2D) % 360 + 360) % 360, lit, mag, vis: el >= 0 && lit && sn.el < q.darkSunEl };
  };

  const passes = [], transfer = [];
  const tAt = (i) => q.t0 + i * q.step;
  for (const s of q.sats) {
    const rec = satrec(s);
    // coarse scan -> fine index ranges
    const ranges = [];
    let start = -1;
    const nc = Math.ceil((q.n - 1) / COARSE) + 1;
    for (let c = 0; c < nc; c++) {
      const i = Math.min(c * COARSE, q.n - 1);
      const p = look(rec, tAt(i), s.stdMag, false);
      const near = p && p.el > NEAR;
      if (near && start < 0) start = c;
      if ((!near || c === nc - 1) && start >= 0) {
        const end = near ? c : c - 1;
        ranges.push([Math.max(0, (start - 1) * COARSE), Math.min(q.n - 1, (end + 1) * COARSE)]);
        start = -1;
      }
    }
    for (const [r0, r1] of ranges) {
      const m = r1 - r0 + 1;
      const el = new Float32Array(m), az = new Float32Array(m), mag = new Float32Array(m);
      const lit = new Uint8Array(m), vis = new Uint8Array(m);
      for (let j = 0; j < m; j++) {
        const p = look(rec, tAt(r0 + j), s.stdMag, true);
        el[j] = p ? p.el : -90; az[j] = p ? p.az : 0; mag[j] = p ? p.mag : NaN;
        lit[j] = p?.lit ? 1 : 0; vis[j] = p?.vis ? 1 : 0;
      }
      findPasses(s, rec, r0, { el, az, mag, lit, vis });
    }
  }

  function findPasses(s, rec, r0, tr) {
    const { el, vis, mag } = tr, m = el.length;
    const t = (j) => tAt(r0 + j);
    const cross = (a, b) => t(a) + (t(b) - t(a)) * (0 - el[a]) / (el[b] - el[a]);
    for (let j = 0; j < m;) {
      if (el[j] < 0) { j++; continue; }
      const j0 = j;
      while (j < m && el[j] >= 0) j++;
      const j1 = j - 1;
      let jm = j0, v0 = -1, v1 = -1;
      for (let k = j0; k <= j1; k++) {
        if (el[k] > el[jm]) jm = k;
        if (vis[k]) { if (v0 < 0) v0 = k; v1 = k; }
      }
      // The grid can clip a near-zenith peak by a few degrees: refine it to 1 s.
      let maxEl = el[jm], maxT = t(jm);
      if (jm > j0 && jm < j1) {
        for (let sec = t(jm - 1); sec <= t(jm + 1); sec += 1) {
          const p = look(rec, sec, s.stdMag, false);
          if (p && p.el > maxEl) { maxEl = p.el; maxT = sec; }
        }
      }
      if (maxEl < q.minPassEl) continue;
      let visMax = -90, peak = Infinity, peakT = null;
      if (v0 >= 0) {
        for (let k = v0; k <= v1; k++) {
          visMax = Math.max(visMax, el[k]);
          if (vis[k] && mag[k] < peak) { peak = mag[k]; peakT = t(k); }
        }
      }
      const i0 = r0 + j0, i1 = r0 + j1;
      const pass = {
        id: s.id, i0, i1,
        rise: j0 > 0 ? cross(j0 - 1, j0) : t(j0),
        set: j1 < m - 1 ? cross(j1, j1 + 1) : t(j1),
        partial: i0 === 0 || i1 === q.n - 1,
        maxEl, maxT, riseAz: tr.az[j0], setAz: tr.az[j1],
        vis: v0 >= 0 ? { t0: t(v0), t1: t(v1), maxEl: visMax, mag: Number.isFinite(peak) ? peak : null, magT: peakT } : null,
      };
      if (q.arrays && pass.vis) {
        // samples from one before rise to one after set, so lines meet the horizon
        const a = Math.max(0, j0 - 1), b = Math.min(m - 1, j1 + 1);
        pass.a = r0 + a;
        pass.tr = {};
        for (const key of ['el', 'az', 'mag', 'lit', 'vis']) {
          pass.tr[key] = tr[key].slice(a, b + 1);
          transfer.push(pass.tr[key].buffer);
        }
      }
      passes.push(pass);
    }
  }

  passes.sort((x, y) => x.rise - y.rise);
  self.postMessage({ seq: q.seq, passes }, transfer);
};
