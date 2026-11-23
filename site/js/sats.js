// Satellites section: a sky view from Socorro (stars to mag 4, constellation
// figures, Sun, Moon, planets and satellite passes) above an elevation-vs-time
// chart, a list of the brightest passes and a week of ISS passes. Hovering or
// dragging along the chart moves the sky view to that time.
//
// Satellites: CelesTrak's "visual" group (site/js/tle.js), propagated with SGP4
// in a worker (site/js/sats-worker.js). A pass is shown when it is visible
// (above the horizon, sunlit, with the Sun below SATS.darkSunEl) and its
// estimated peak brightness is at or brighter than the magnitude slider.
import { SATS, TZ } from './config.js';
import { makeChart, cssVar, fmtTime } from './charts.js';
import { STARS, STAR_NAMES, LINES, LABELS } from './data/starmap.js';
import { STD_MAG, STD_MAG_DATE } from './data/satmags.js';
import { cachedTLE, tleNeedsRefresh, refreshTLE, tleEpoch } from './tle.js';

const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const RE = 6378.137;  // km
const KEYS = { tz: 'sats:tz', range: 'sats:range', sort: 'sats:sort', week: 'sats:week', mag: 'sats:mag' };
const RANGES = { '3h': 3, '12h': 12, '24h': 24, '48h': 48 };
const PASS_ROWS = 10;
const READOUT_CELLS = 6;
const UPCOMING_S = 30 * 60;  // the sky view also draws passes starting this soon
const MAG_BRIGHT = -3;      // brightness colour ramp runs from this to the cutoff

const pref = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const setPref = (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } };
const SAT = () => globalThis.satellite;
const AE = () => globalThis.Astronomy;

let root, aeObs, gd, obsEcf;
let tz = pref(KEYS.tz, TZ);
let range = RANGES[pref(KEYS.range, '12h')] ? pref(KEYS.range, '12h') : '12h';
let sortMode = pref(KEYS.sort, 'mag');
let weekMode = pref(KEYS.week, 'visible');
let magCut = (() => {
  const v = Number(pref(KEYS.mag, SATS.magCut.default));
  return Number.isFinite(v) ? Math.max(SATS.magCut.min, Math.min(SATS.magCut.max, v)) : SATS.magCut.default;
})();
let zoom = null;         // { t0, t1, p } while zoomed to one pass
let sats = new Map();    // id -> { id, name, ctName, stdMag, stdSrc, rec, epoch }
let grid = null;         // { t, sunEl } timeline of the chart; pass indices refer to it
let passes = [];         // passes over the window (from the worker); visible ones carry tracks
let week = null;         // passes of SATS.week.id over the next SATS.week.days days
let chart = null, cursorIdx = null;
let tle = null;          // cache object from tle.js
let arcs = [];           // sky-view arcs as drawn, for hover hit-testing: [{p, pts: [[x, y, i]]}]
let worker = null, seq = 0, pending = {}, computing = false;
let computedAt = 0;      // when the last computation was started (ms)
const RECOMPUTE_MS = 10 * 60e3;

// ---------- small helpers ----------
const nowSec = () => Date.now() / 1000;
const mod360 = (a) => ((a % 360) + 360) % 360;
const fmtMag = (m) => (m == null || !Number.isFinite(m) ? '—' : `${m < 0 ? '−' : ''}${Math.abs(m).toFixed(1)}`);
const dir8 = (az) => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(mod360(az) / 45) % 8];
const tzLabel = () => (tz === 'UTC' ? 'UTC' : 'MT');
const shown = (p) => p.vis && p.vis.mag != null && p.vis.mag <= magCut && p.vis.maxEl >= SATS.minPassEl;

const hm = new Map();
function fmtHM(sec) {
  if (!hm.has(tz)) hm.set(tz, new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }));
  return hm.get(tz).format(new Date(sec * 1000));
}
const dayFmt = new Map();
function fmtDay(sec) {
  if (!dayFmt.has(tz)) dayFmt.set(tz, new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'numeric', day: 'numeric' }));
  return dayFmt.get(tz).format(new Date(sec * 1000)).replace(',', '');
}

// Brightness colour: one hue, strong for bright passes, pale for faint ones.
// The chart follows the page theme (CSS tokens); the sky view is always dark.
const hexRGB = (h) => { const n = parseInt(h.replace('#', ''), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; };
let chartRamp = null;
const SKY_RAMP = [hexRGB('#fff3c4'), hexRGB('#a08a5a')];
function magColor(m, ramp) {
  // Spread the ramp over what is shown: MAG_BRIGHT (or brighter) .. the cutoff.
  const faint = Math.max(magCut, MAG_BRIGHT + 2);
  const f = Math.max(0, Math.min(1, (m - MAG_BRIGHT) / (faint - MAG_BRIGHT)));
  return `rgb(${ramp[0].map((c, i) => Math.round(c + (ramp[1][i] - c) * f))})`;
}
const readChartRamp = () => { chartRamp = [hexRGB(cssVar('--mag-bright')), hexRGB(cssVar('--mag-faint'))]; };

// ---------- geometry ----------
function unitVectors(radec) {  // flat [ra, dec, ...] degrees -> Float64Array of unit vectors
  const v = new Float64Array(radec.length / 2 * 3);
  for (let i = 0, j = 0; i < radec.length; i += 2, j += 3) {
    const ra = radec[i] * D2R, de = radec[i + 1] * D2R;
    v[j] = Math.cos(de) * Math.cos(ra); v[j + 1] = Math.cos(de) * Math.sin(ra); v[j + 2] = Math.sin(de);
  }
  return v;
}
const STAR_V = unitVectors(STARS.flatMap((s) => [s[0], s[1]]));
const LINE_V = LINES.map(unitVectors);
const LABEL_V = unitVectors(LABELS.flatMap((l) => [l[0], l[1]]));

/** Sun elevation (deg) and its geocentric unit vector in the true equator of date (~TEME). */
function sunAt(date) {
  const A = AE();
  const eq = A.Equator(A.Body.Sun, date, aeObs, true, true);
  const el = A.Horizon(date, aeObs, eq.ra, eq.dec).altitude;
  const v = A.RotateVector(A.Rotation_EQJ_EQD(date), A.GeoVector(A.Body.Sun, date, true));
  const n = Math.hypot(v.x, v.y, v.z);
  return { el, s: [v.x / n, v.y / n, v.z / n] };
}

/**
 * Position, sunlit flag and estimated magnitude of one satellite now (the
 * worker does the same for whole passes). Brightness treats the satellite as a
 * diffuse sphere of standard magnitude `stdMag` (1000 km, 90° phase):
 *   m = stdMag − 15 + 5·log10(range km) − 2.5·log10(sin φ + (π − φ)·cos φ)
 */
function satAt(sat, date, sun) {
  const S = SAT();
  const pv = S.propagate(sat.rec, date);
  const p = pv && pv.position;
  if (!p || typeof p !== 'object' || !Number.isFinite(p.x)) return null;
  const gmst = S.gstime(date);
  const la = S.ecfToLookAngles(gd, S.eciToEcf(p, gmst));
  const [sx, sy, sz] = sun.s;
  const d = p.x * sx + p.y * sy + p.z * sz;
  const lit = d > 0 || p.x * p.x + p.y * p.y + p.z * p.z - d * d > RE * RE;
  let mag = NaN;
  if (lit) {
    const o = S.ecfToEci(obsEcf, gmst);
    const dx = o.x - p.x, dy = o.y - p.y, dz = o.z - p.z, rng = Math.hypot(dx, dy, dz);
    const phi = Math.acos(Math.max(-1, Math.min(1, (dx * sx + dy * sy + dz * sz) / rng)));
    const f = Math.sin(phi) + (Math.PI - phi) * Math.cos(phi);
    mag = sat.stdMag - 15 + 5 * Math.log10(rng) - 2.5 * Math.log10(Math.max(f, 1e-3));
  }
  return { el: la.elevation * R2D, az: mod360(la.azimuth * R2D), lit, mag };
}

// ---------- init & data ----------
export function initSats(el) {
  root = el;
  const o = SATS.observer;
  aeObs = new (AE().Observer)(o.lat, o.lon, o.height);
  gd = { latitude: o.lat * D2R, longitude: o.lon * D2R, height: o.height / 1000 };
  obsEcf = SAT().geodeticToEcf(gd);
  readChartRamp();

  const seg = (id, fn) => root.querySelector(id).addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) fn(b.dataset);
  });
  seg('#sat-tz', (d) => { tz = d.tz; setPref(KEYS.tz, tz); buildChart(); renderTables(); drawPolar(); });
  seg('#sat-range', (d) => { range = d.range; setPref(KEYS.range, range); zoom = null; applyView(); renderTables(); });
  seg('#sat-sort', (d) => { sortMode = d.sort; setPref(KEYS.sort, sortMode); renderTables(); });
  seg('#sat-week-mode', (d) => { weekMode = d.mode; setPref(KEYS.week, weekMode); renderTables(); });

  const slider = root.querySelector('#sat-mag');
  Object.assign(slider, { min: SATS.magCut.min, max: SATS.magCut.max, step: SATS.magCut.step, value: magCut });
  slider.addEventListener('input', () => {
    magCut = Number(slider.value); setPref(KEYS.mag, magCut);
    if (zoom && !shown(zoom.p)) { zoom = null; applyView(); }
    renderTables(); chart?.redraw(false); drawPolar();
  });

  const table = root.querySelector('#sat-passes');
  table.addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-p]');
    if (tr) zoomToPass(passes[Number(tr.dataset.p)]);
  });
  table.addEventListener('keydown', (e) => {
    const tr = e.target.closest('tr[data-p]');
    if (tr && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); tr.click(); }
  });

  const canvas = root.querySelector('#sat-polar');
  canvas.addEventListener('pointermove', onPolarHover);
  canvas.addEventListener('pointerdown', onPolarHover);
  canvas.addEventListener('pointerleave', () => chart?.setCursor({ left: -10, top: -10 }, true));
  new ResizeObserver(() => drawPolar()).observe(canvas);

  worker = new Worker(new URL('./sats-worker.js', import.meta.url));
  worker.onmessage = onWorker;
  worker.onerror = (e) => { computing = false; setStatus(`Pass computation failed: ${e.message}`, true); };

  markButtons(); renderTables(); drawPolar();
  const c = cachedTLE();
  if (c?.sats && Object.keys(c.sats).length) useTLE(c);
  else setStatus('Loading orbital elements from CelesTrak…');
  maybeRefresh();

  // Computation and redraws pause while the section is collapsed or hidden, or the
  // tab is in the background; orbital elements keep refreshing (cheap, every 6 h).
  setInterval(() => { if (isActive()) { chart?.redraw(false); if (cursorIdx == null) drawPolar(); } }, 10e3);
  setInterval(() => recompute(), RECOMPUTE_MS);
  setInterval(() => { maybeRefresh(); setStatus(); }, 15 * 60e3);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { maybeRefresh(); wake(); } });
  new MutationObserver(wake).observe(root, { attributes: true, attributeFilter: ['class', 'hidden'] });
}

/** Whether the section is on show: expanded, not hidden in Settings, tab in the foreground. */
const isActive = () => !root.hidden && !root.classList.contains('collapsed') && !document.hidden;

/** Section shown again: recompute if the results are stale (or missing), else just redraw. */
function wake() {
  if (!isActive()) return;
  if (Date.now() - computedAt >= RECOMPUTE_MS) recompute();
  else { chart?.redraw(false); renderTables(); drawPolar(); }
}

export function rerender() { if (root) { readChartRamp(); buildChart(); renderTables(); drawPolar(); } }

function useTLE(c) {
  tle = c;
  const S = SAT();
  sats = new Map();
  for (const [key, e] of Object.entries(c.sats)) {
    const id = Number(key);
    const bb = /^SPACEMOBILE-0*(\d+)$/.exec(e.name);
    const [stdMag, stdSrc] = SATS.stdMag[id] != null ? [SATS.stdMag[id], 'config.js']
      : STD_MAG[id] != null ? [STD_MAG[id], `McCants ${STD_MAG_DATE}`] : [SATS.defaultStdMag, 'unknown; assumed'];
    sats.set(id, {
      id, ctName: e.name, name: SATS.names[id] ?? (bb ? `BlueBird ${bb[1]}` : e.name),
      stdMag, stdSrc, rec: S.twoline2satrec(e.l1, e.l2), epoch: tleEpoch(e.l1), l1: e.l1, l2: e.l2,
    });
  }
  recompute();
}

/** Ask the worker for the next 48 h of passes (all satellites) and 7 days of the week satellite. */
function recompute() {
  if (!sats.size || !worker) return;
  if (!isActive()) { computedAt = 0; return; }  // done by wake() when the section is shown
  computedAt = Date.now();
  const step = SATS.window.stepSec, now = nowSec();
  const t0 = Math.floor(now / step) * step - SATS.window.before * 3600;
  const n = Math.round((SATS.window.before + SATS.window.after) * 3600 / step) + 1;
  const w0 = Math.floor(now / step) * step, wn = Math.round(SATS.week.days * 86400 / step) + 1;
  // Sun every 5 min over both spans; the worker interpolates.
  const sunStep = 300, sunN = Math.ceil((Math.max(t0 + n * step, w0 + wn * step) - t0) / sunStep) + 2;
  const sunEl = new Float32Array(sunN), sunV = new Float64Array(3 * sunN);
  for (let j = 0; j < sunN; j++) {
    const s = sunAt(new Date((t0 + j * sunStep) * 1000));
    sunEl[j] = s.el; sunV.set(s.s, 3 * j);
  }
  const t = Array.from({ length: n }, (_, i) => t0 + i * step);
  const gridSunEl = Float32Array.from(t, (sec) => {
    const f = (sec - t0) / sunStep, j = Math.floor(f);
    return sunEl[j] + (sunEl[j + 1] - sunEl[j]) * (f - j);
  });
  const common = {
    sun: { t0, step: sunStep, el: sunEl, v: sunV }, step,
    obs: SATS.observer, darkSunEl: SATS.darkSunEl, minPassEl: SATS.minPassEl,
  };
  const list = [...sats.values()].map(({ id, l1, l2, stdMag }) => ({ id, l1, l2, stdMag }));
  pending = { grid: ++seq, gridT: { t, sunEl: gridSunEl }, week: ++seq };
  computing = true;
  if (!grid) setStatus(`Computing passes for ${sats.size} satellites…`);
  worker.postMessage({ ...common, seq: pending.grid, sats: list, t0, n, arrays: true });
  const ws = list.filter((s) => s.id === SATS.week.id);
  if (ws.length) worker.postMessage({ ...common, seq: pending.week, sats: ws, t0: w0, n: wn, arrays: false });
}

function onWorker(e) {
  const { seq: s, passes: ps } = e.data;
  if (s === pending.week) {
    week = ps;
    renderWeek();
    return;
  }
  if (s !== pending.grid) return;  // superseded
  computing = false;
  grid = pending.gridT;
  passes = ps;
  if (zoom) {
    const z = zoom.p;
    zoom.p = passes.find((p) => p.id === z.id && Math.abs(p.maxT - z.maxT) < 120);
    if (!zoom.p || zoom.t1 < nowSec()) zoom = null;
  }
  if (chart) { chart.setData(chartData()); applyView(); } else buildChart();
  renderTables(); drawPolar(); setStatus();
}

async function maybeRefresh() {
  if (!tleNeedsRefresh()) return;
  const c = await refreshTLE();
  if (c.fetched && c.fetched !== tle?.fetched) useTLE(c);
  else { tle = c; setStatus(); }
}

function setStatus(msg, isError = false) {
  const el = root.querySelector('#sat-status');
  if (msg) { el.textContent = msg; el.classList.toggle('error', isError); return; }
  if (!tle?.fetched) {
    el.textContent = `Couldn't load orbital elements from CelesTrak${tle?.error ? `: ${tle.error}` : ''}. Retrying later.`;
    el.classList.add('error');
    return;
  }
  const ago = (ms) => {
    const h = (Date.now() - ms) / 3600e3;
    return h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : h < 48 ? `${h.toFixed(h < 10 ? 1 : 0)} h` : `${Math.round(h / 24)} d`;
  };
  const all = [...sats.values()];
  const ages = all.map((s) => (Date.now() - s.epoch) / 86400e3).sort((a, b) => a - b);
  const median = ages[Math.floor(ages.length / 2)] ?? 0;
  const weekSat = sats.get(SATS.week.id);
  const stale = weekSat && (Date.now() - weekSat.epoch) / 86400e3 > 14;
  const est = all.filter((s) => !s.stdSrc.startsWith('McCants')).length;
  el.classList.toggle('error', Boolean(tle.error) || stale);
  el.textContent = `${all.length} satellites (CelesTrak “${SATS.group}” group), elements fetched ${ago(tle.fetched)} ago, ` +
    `median epoch ${median.toFixed(1)} d old · brightness from McCants' magnitudes, ${est} estimated` +
    (stale ? ` · ${weekSat.name} elements are ${Math.round((Date.now() - weekSat.epoch) / 86400e3)} d old` : '') +
    (tle.error ? ` · last refresh failed: ${tle.error}` : '') + (computing ? ' · updating…' : '');
  el.title = `Elements: celestrak.org GP data. Standard magnitudes: Mike McCants' quicksat list (${STD_MAG_DATE}); ` +
    `${est} objects not in it use estimates (config.js). Oldest epoch ${ages.at(-1)?.toFixed(1)} d.`;
}

// ---------- chart ----------
function chartData() { return [grid.t, grid.t.map(() => null)]; }

function view() {
  if (zoom) return [zoom.t0, zoom.t1];
  const span = RANGES[range] * 3600, now = nowSec();
  const a = now - Math.min(3600, span * 0.1);
  return [a, a + span];
}

function applyView() {
  markButtons();
  if (chart) { const [min, max] = view(); chart.setScale('x', { min, max }); }
}

function markButtons() {
  const press = (sel, key, val) => root.querySelectorAll(`${sel} button`).forEach((b) =>
    b.setAttribute('aria-pressed', String(b.dataset[key] === val)));
  press('#sat-tz', 'tz', tz);
  press('#sat-range', 'range', zoom ? null : range);
  press('#sat-sort', 'sort', sortMode);
  press('#sat-week-mode', 'mode', weekMode);
}

function nightIntervals() {
  const out = [], { t, sunEl } = grid;
  let a = null;
  for (let i = 0; i < t.length; i++) {
    if (sunEl[i] < 0 && a == null) a = t[i];
    if ((sunEl[i] >= 0 || i === t.length - 1) && a != null) { out.push([a, t[i]]); a = null; }
  }
  return out;
}

/**
 * Draws every shown pass in view (uPlot only supplies axes, cursor and time
 * scale): a thin line above the horizon, thick while visible, coloured by
 * peak brightness, with the satellite's name at the peak where there's room.
 */
function passPlugin() {
  return {
    hooks: {
      draw(u) {
        if (!grid) return;
        const ctx = u.ctx, { left, top, width, height } = u.bbox, dpr = devicePixelRatio;
        const [x0, x1] = [u.scales.x.min, u.scales.x.max];
        const list = passes.filter((p) => shown(p) && p.set >= x0 && p.rise <= x1)
          .sort((a, b) => b.vis.mag - a.vis.mag);  // faint first, so bright passes sit on top
        ctx.save();
        ctx.beginPath(); ctx.rect(left, top, width, height); ctx.clip();
        ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        const X = (j, p) => u.valToPos(grid.t[p.a + j], 'x', true);
        const Y = (v) => u.valToPos(Math.max(v, -2), 'y', true);
        for (const p of list) {
          const { el, vis } = p.tr;
          ctx.strokeStyle = magColor(p.vis.mag, chartRamp);
          ctx.lineWidth = 1.5 * dpr;
          ctx.beginPath();
          for (let j = 0; j < el.length; j++) ctx[j ? 'lineTo' : 'moveTo'](X(j, p), Y(el[j]));
          ctx.stroke();
          ctx.lineWidth = 4 * dpr;
          ctx.beginPath();
          let pen = false;
          for (let j = 0; j < el.length; j++) {
            if (!vis[j]) { pen = false; continue; }
            ctx[pen ? 'lineTo' : 'moveTo'](X(j, p), Y(el[j]));
            pen = true;
          }
          ctx.stroke();
        }
        // Names at the peaks, brightest first; skip any that would overlap.
        ctx.font = `600 ${10 * dpr}px system-ui, -apple-system, "Segoe UI", sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
        ctx.lineWidth = 3 * dpr; ctx.strokeStyle = cssVar('--page'); ctx.fillStyle = cssVar('--text-secondary');
        const boxes = [];
        for (const p of [...list].reverse()) {
          const text = sats.get(p.id)?.name ?? '';
          const w = ctx.measureText(text).width + 4 * dpr, h = 12 * dpr;
          const x = u.valToPos(p.maxT, 'x', true), y = Math.max(top + h, Y(p.maxEl) - 3 * dpr);
          const box = [x - w / 2, y - h, x + w / 2, y];
          if (box[0] < left || box[2] > left + width) continue;
          if (boxes.some((b) => b[0] < box[2] && box[0] < b[2] && b[1] < box[3] && box[1] < b[3])) continue;
          boxes.push(box);
          ctx.strokeText(text, x, y); ctx.fillText(text, x, y);
        }
        ctx.restore();
      },
    },
  };
}

function buildChart() {
  chart?.destroy(); chart = null;
  markButtons();
  if (!grid) return;
  const nights = nightIntervals();
  chart = makeChart(root.querySelector('#sat-el'), {
    tz, h24: true, timeLabel: tzLabel(), now: nowSec, shade: () => nights, legend: false,
    height: matchMedia('(max-width: 559px)').matches ? 200 : 240,
    data: chartData(),
    series: [{ label: 'Elevation', color: '--text-muted' }],
    yRange: [0, 90], ySplits: () => [0, 30, 60, 90], yValues: (u, v) => v.map((x) => `${x}°`),
    xRange: view,
    plugins: [passPlugin()],
    hooks: { setCursor: [(u) => { cursorIdx = u.cursor.idx ?? null; drawPolar(); }] },
  });
}

// ---------- tables ----------
function renderTables() {
  markButtons();
  renderPasses();
  renderWeek();
}

function renderPasses() {
  const body = root.querySelector('#sat-passes tbody');
  root.querySelector('#sat-passes th.col-rise').textContent = `Rises (${tzLabel()})`;
  root.querySelector('#sat-mag-out').textContent = fmtMag(magCut);
  const count = root.querySelector('#sat-count');
  if (!grid) { body.innerHTML = ''; count.textContent = ''; return; }
  const now = nowSec();
  const all = passes.filter((p) => shown(p) && p.set > now && !p.partial);
  const nSats = new Set(all.map((p) => p.id)).size;
  count.textContent = `${nSats} satellite${nSats === 1 ? '' : 's'}, ${all.length} pass${all.length === 1 ? '' : 'es'} in ${SATS.window.after} h`;
  const list = all.map((p) => ({ p, idx: passes.indexOf(p) }))
    .sort(sortMode === 'mag' ? (a, b) => a.p.vis.mag - b.p.vis.mag : (a, b) => a.p.rise - b.p.rise)
    .slice(0, PASS_ROWS);
  if (!list.length) {
    body.innerHTML = `<tr class="empty"><td colspan="6">No visible passes brighter than magnitude ${fmtMag(magCut)} in the next ${SATS.window.after} h</td></tr>`;
    return;
  }
  body.innerHTML = list.map(({ p, idx }) => {
    const s = sats.get(p.id);
    const visMin = Math.max(1, Math.round((p.vis.t1 - p.vis.t0) / 60));
    const sel = zoom?.p === p;
    const live = p.rise <= now ? ' live' : '';
    return `<tr data-p="${idx}" tabindex="0" class="${sel ? 'sel' : ''}${live}" aria-pressed="${sel}" ` +
      `title="${s.ctName} (#${s.id}), standard magnitude ${s.stdMag} (${s.stdSrc}). ` +
      `Visible ${fmtHM(p.vis.t0)}–${fmtHM(p.vis.t1)}, brightest at ${fmtHM(p.vis.magT)}. Click to zoom the chart to this pass.">` +
      `<th scope="row"><span class="swatch" style="border-color:${magColor(p.vis.mag, chartRamp)}"></span>${s.name}</th>` +
      `<td>${fmtTime(p.rise, tz, true)} <span class="muted">${dir8(p.riseAz)}</span></td>` +
      `<td>${p.maxEl.toFixed(0)}°</td>` +
      `<td>${fmtHM(p.set)} <span class="muted">${dir8(p.setAz)}</span></td>` +
      `<td class="wide-only">${visMin} min</td>` +
      `<td>${fmtMag(p.vis.mag)}</td></tr>`;
  }).join('');
}

/** Week-ahead table for one satellite (SATS.week, the ISS by default). */
function renderWeek() {
  const body = root.querySelector('#sat-week tbody');
  const s = sats.get(SATS.week.id);
  root.querySelector('#sat-week-h').firstChild.textContent = `${s?.name ?? 'ISS'} passes, next ${SATS.week.days} days `;
  root.querySelector('#sat-week th.col-day').textContent = `Date (${tzLabel()})`;
  if (!week) { body.innerHTML = ''; return; }
  const now = nowSec();
  const list = week.filter((p) => p.set > now && !p.partial &&
    (weekMode === 'all' || (p.vis && p.vis.maxEl >= SATS.minPassEl)));
  if (!list.length) {
    body.innerHTML = `<tr class="empty"><td colspan="6">No ${weekMode === 'all' ? '' : 'visible '}passes above ${SATS.minPassEl}° in the next ${SATS.week.days} days</td></tr>`;
    return;
  }
  let lastDay = '';
  body.innerHTML = list.map((p) => {
    const day = fmtDay(p.rise), newDay = day !== lastDay;
    lastDay = day;
    const vis = p.vis ? `${fmtHM(p.vis.t0)}–${fmtHM(p.vis.t1)}` : '—';
    return `<tr class="${newDay ? 'new-day' : ''}${p.vis ? '' : ' unseen'}">` +
      `<th scope="row">${newDay ? day : ''}</th>` +
      `<td>${fmtHM(p.rise)} <span class="muted">${dir8(p.riseAz)}</span></td>` +
      `<td>${p.maxEl.toFixed(0)}° <span class="muted wide-only">${fmtHM(p.maxT)}</span></td>` +
      `<td>${fmtHM(p.set)} <span class="muted">${dir8(p.setAz)}</span></td>` +
      `<td>${vis}</td><td>${fmtMag(p.vis?.mag)}</td></tr>`;
  }).join('');
}

function zoomToPass(p) {
  if (!p) return;
  if (zoom?.p === p) zoom = null;
  else {
    const pad = Math.max(180, (p.set - p.rise) * 0.4);
    zoom = { t0: p.rise - pad, t1: p.set + pad, p };
  }
  applyView(); renderTables();
  if (zoom && chart) {
    chart.setCursor({ left: chart.valToPos(p.vis.magT ?? p.maxT, 'x'), top: chart.over.clientHeight / 2 }, true);
  }
}

// ---------- sky view (canvas) ----------
const SIZE = 400, C = SIZE / 2, R = 178;
const rOf = (el) => R * (90 - el) / 90;
// Looking up: north at the top, east on the LEFT.
const xyAzEl = (el, az) => { const r = rOf(el), a = az * D2R; return [C - r * Math.sin(a), C - r * Math.cos(a)]; };
const xyHor = (x, y, z) => {  // HOR unit vector (x north, y west, z zenith)
  const r = rOf(Math.asin(Math.max(-1, Math.min(1, z))) * R2D), h = Math.hypot(x, y) || 1e-9;
  return [C + r * y / h, C - r * x / h];
};
const lerp = (a, b, f) => a + (b - a) * f;
const clamp01 = (f) => Math.max(0, Math.min(1, f));

/** Sky colour and star visibility for a solar elevation. */
function skyLook(sunEl) {
  const stops = [  // sunEl, rgb, star alpha
    [-18, [5, 8, 18], 1], [-12, [10, 17, 36], 1], [-6, [22, 38, 74], 0.85],
    [0, [52, 84, 134], 0.55], [8, [78, 118, 172], 0.4],
  ];
  let i = 0;
  while (i < stops.length - 1 && sunEl > stops[i + 1][0]) i++;
  const [e0, c0, a0] = stops[i], [e1, c1, a1] = stops[Math.min(i + 1, stops.length - 1)];
  const f = e1 === e0 ? 0 : clamp01((sunEl - e0) / (e1 - e0));
  const rgb = c0.map((c, j) => Math.round(lerp(c, c1[j], f)));
  return { fill: `rgb(${rgb})`, starA: lerp(a0, a1, f) };
}

function starColor(bv) {
  if (bv < 0) return '170,195,255';
  if (bv < 0.4) return '225,232,255';
  if (bv < 0.8) return '255,246,225';
  if (bv < 1.2) return '255,222,175';
  return '255,196,140';
}

const PLANETS = [
  ['Mercury', '#c9b8a0', 2.4], ['Venus', '#fff6d8', 3.4], ['Mars', '#ff9b6b', 2.8],
  ['Jupiter', '#f2e2c4', 3.2], ['Saturn', '#e9d59a', 2.8],
];

/** Position of a pass's satellite at grid index i (from its track), or null. */
function trackAt(p, i) {
  const j = i - p.a;
  if (!p.tr || j < 0 || j >= p.tr.el.length) return null;
  return { el: p.tr.el[j], az: p.tr.az[j], lit: p.tr.lit[j] === 1, mag: p.tr.mag[j] };
}

function drawPolar() {
  const canvas = root?.querySelector('#sat-polar');
  const w = canvas?.clientWidth;
  if (!w) return;
  const px = Math.round(w * devicePixelRatio);
  if (canvas.width !== px) { canvas.width = px; canvas.height = px; }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(px / SIZE, 0, 0, px / SIZE, 0, 0);
  ctx.clearRect(0, 0, SIZE, SIZE);
  const A = AE();

  const hover = cursorIdx != null && grid?.t[cursorIdx] != null;
  const T = hover ? grid.t[cursorIdx] : nowSec();
  const date = new Date(T * 1000);
  const sun = sunAt(date);
  const look = skyLook(sun.el);
  const font = (size, weight = 400) => `${weight} ${size}px system-ui, -apple-system, "Segoe UI", sans-serif`;

  // disk, rings
  ctx.fillStyle = look.fill;
  ctx.beginPath(); ctx.arc(C, C, R, 0, 2 * Math.PI); ctx.fill();
  ctx.save();
  ctx.beginPath(); ctx.arc(C, C, R, 0, 2 * Math.PI); ctx.clip();
  ctx.strokeStyle = 'rgba(255,255,255,0.13)'; ctx.lineWidth = 1;
  for (const el of [30, 60]) { ctx.beginPath(); ctx.arc(C, C, rOf(el), 0, 2 * Math.PI); ctx.stroke(); }
  ctx.fillStyle = 'rgba(255,255,255,0.32)'; ctx.font = font(9); ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  for (const el of [30, 60]) ctx.fillText(`${el}°`, C + 3, C - rOf(el) + 2);

  // constellations and stars (J2000 -> horizon of date, with precession and nutation)
  const m = A.Rotation_EQJ_HOR(A.MakeTime(date), aeObs).rot;
  const hor = (v, j) => {
    const x = v[j], y = v[j + 1], z = v[j + 2];
    return [m[0][0] * x + m[1][0] * y + m[2][0] * z, m[0][1] * x + m[1][1] * y + m[2][1] * z,
      m[0][2] * x + m[1][2] * y + m[2][2] * z];
  };
  ctx.strokeStyle = `rgba(130,160,225,${0.42 * look.starA})`; ctx.lineWidth = 0.9;
  ctx.beginPath();
  for (const v of LINE_V) {
    let prev = null;
    for (let j = 0; j < v.length; j += 3) {
      const h = hor(v, j);
      if (prev && (h[2] > -0.05 || prev[2] > -0.05)) {
        const [x0, y0] = xyHor(...prev), [x1, y1] = xyHor(...h);
        ctx.moveTo(x0, y0); ctx.lineTo(x1, y1);
      }
      prev = h;
    }
  }
  ctx.stroke();
  // Half-width of the disk at height y, to keep labels inside it.
  const chord = (y) => Math.sqrt(Math.max(0, R * R - (y - C) ** 2)) - 2;
  ctx.fillStyle = `rgba(150,175,230,${0.55 * look.starA})`; ctx.font = font(8.5);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  LABELS.forEach((l, i) => {
    if (l[3] > 2) return;
    const h = hor(LABEL_V, i * 3);
    if (h[2] < 0.06) return;
    const [x, y] = xyHor(...h), half = ctx.measureText(l[2]).width / 2, c = chord(y);
    ctx.fillText(l[2], Math.max(C - c + half, Math.min(C + c - half, x)), y);
  });
  const starXY = new Array(STARS.length);
  for (let i = 0; i < STARS.length; i++) {
    const h = hor(STAR_V, i * 3);
    if (h[2] < 0) continue;
    const [x, y] = xyHor(...h), mag = STARS[i][2];
    starXY[i] = [x, y];
    const r = Math.max(0.55, Math.min(3.4, 2.7 - 0.5 * mag));
    ctx.fillStyle = `rgba(${starColor(STARS[i][3])},${look.starA * Math.min(1, 1.15 - mag * 0.12)})`;
    ctx.beginPath(); ctx.arc(x, y, r, 0, 2 * Math.PI); ctx.fill();
  }
  // Labels sit right of their object (x + gap), or left of it when they would run off the disk.
  const place = (text, x, y, gap) => {
    const flip = x + gap + ctx.measureText(text).width > C + chord(y);
    ctx.textAlign = flip ? 'right' : 'left';
    return flip ? x - gap : x + gap;
  };
  ctx.fillStyle = `rgba(215,222,240,${0.6 * look.starA})`; ctx.font = font(8.5); ctx.textBaseline = 'middle';
  for (const [i, name] of STAR_NAMES) {
    if (starXY[i]) ctx.fillText(name, place(name, starXY[i][0], starXY[i][1], 4.5), starXY[i][1] + 0.5);
  }

  // Sun, Moon, planets
  const label = (text, x, y, color, size = 10, weight = 600, gap = 0) => {
    ctx.font = font(size, weight); ctx.textBaseline = 'middle';
    x = place(text, x, y, gap);
    ctx.lineWidth = 3; ctx.strokeStyle = look.fill; ctx.strokeText(text, x, y);
    ctx.fillStyle = color; ctx.fillText(text, x, y);
  };
  const body = (b) => { const eq = A.Equator(b, date, aeObs, true, true); return A.Horizon(date, aeObs, eq.ra, eq.dec); };
  for (const [name, color, r] of PLANETS) {
    const h = body(A.Body[name]);
    if (h.altitude < 0) continue;
    const [x, y] = xyAzEl(h.altitude, h.azimuth);
    ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x, y, r, 0, 2 * Math.PI); ctx.fill();
    label(name, x, y, `rgba(240,232,210,${Math.max(0.6, look.starA)})`, 9, 500, r + 3);
  }
  const moon = body(A.Body.Moon);
  if (moon.altitude > -0.5) {
    const [x, y] = xyAzEl(moon.altitude, moon.azimuth);
    drawMoon(ctx, x, y, 6.5, A.Illumination(A.Body.Moon, date).phase_fraction, A.MoonPhase(date), look.fill);
    label('Moon', x, y, '#e8e4d8', 10, 500, 10);
  }
  if (sun.el > -0.5) {
    const h = body(A.Body.Sun);
    const [x, y] = xyAzEl(h.altitude, h.azimuth);
    ctx.fillStyle = '#ffcc33'; ctx.beginPath(); ctx.arc(x, y, 7.5, 0, 2 * Math.PI); ctx.fill();
    label('Sun', x, y, '#ffe08a', 10, 500, 11);
  }

  // Shown passes in progress or starting soon (faint first), then the satellites.
  arcs = [];
  const active = passes.filter((p) => shown(p) && p.set >= T && p.rise <= T + UPCOMING_S)
    .sort((a, b) => b.vis.mag - a.vis.mag);
  const taken = [];  // label boxes of upcoming passes, brightest placed first
  for (const p of active) drawArc(ctx, p, p.rise > T ? 0.45 : 1);
  for (const p of [...active].reverse()) {
    if (p.rise <= T) continue;
    // name and rise time where the pass comes up, unless it would overlap another
    let j = 0;
    while (j < p.tr.el.length - 1 && p.tr.el[j] < 6) j++;
    const [x, y] = xyAzEl(p.tr.el[j], p.tr.az[j]);
    const text = `${sats.get(p.id).name} ${fmtHM(p.rise)}`;
    ctx.font = font(9, 600);
    const w = ctx.measureText(text).width + 6, box = [x - w - 6, y - 7, x + w + 6, y + 7];
    if (taken.some((t) => t[0] < box[2] && box[0] < t[2] && t[1] < box[3] && box[1] < t[3])) continue;
    taken.push(box);
    ctx.globalAlpha = 0.8;
    label(text, x, y, magColor(p.vis.mag, SKY_RAMP), 9, 600, 6);
    ctx.globalAlpha = 1;
  }
  const up = [];
  for (const p of active) {
    if (p.rise > T) continue;
    const s = sats.get(p.id);
    const q = hover ? trackAt(p, cursorIdx) : satAt(s, date, sun);
    if (!q || q.el < 0) continue;
    const vis = q.lit && sun.el < SATS.darkSunEl;
    up.push({ s, p, q, vis });
    const [x, y] = xyAzEl(q.el, q.az);
    ctx.fillStyle = magColor(vis ? q.mag : p.vis.mag, SKY_RAMP);
    ctx.strokeStyle = vis ? '#fff' : 'rgba(255,255,255,0.4)'; ctx.lineWidth = 1.5;
    ctx.globalAlpha = vis ? 1 : 0.6;
    ctx.beginPath(); ctx.arc(x, y, 5, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();
    label(s.name, x, y - 7, '#fff', 11, 600, 8);
    ctx.globalAlpha = 1;
  }
  ctx.restore();

  // horizon and compass (outside the disk, in page colours)
  ctx.strokeStyle = cssVar('--axis'); ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(C, C, R, 0, 2 * Math.PI); ctx.stroke();
  ctx.fillStyle = cssVar('--text-secondary'); ctx.font = font(12, 600);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const [lab, az] of [['N', 0], ['E', 90], ['S', 180], ['W', 270]]) {
    const a = az * D2R, r = R + 11;
    ctx.fillText(lab, C - r * Math.sin(a), C - r * Math.cos(a));
  }

  renderInfo(T, hover, up, sun.el);
}

function drawMoon(ctx, x, y, r, lit, phaseDeg, dark) {
  ctx.fillStyle = 'rgba(80,80,90,0.9)';
  ctx.beginPath(); ctx.arc(x, y, r, 0, 2 * Math.PI); ctx.fill();
  // Lit part: a half disk plus/minus an ellipse. Waxing = lit on the west
  // (right on this east-left chart), waning = lit on the east.
  const waxing = phaseDeg < 180, k = 1 - 2 * lit;  // terminator ellipse x-radius factor
  ctx.fillStyle = '#ece8dc';
  ctx.beginPath();
  ctx.arc(x, y, r, -Math.PI / 2, Math.PI / 2, !waxing);
  ctx.ellipse(x, y, Math.abs(k) * r, r, 0, Math.PI / 2, -Math.PI / 2, (k > 0) === waxing);
  ctx.fill();
  ctx.strokeStyle = dark; ctx.lineWidth = 0.8;
  ctx.beginPath(); ctx.arc(x, y, r, 0, 2 * Math.PI); ctx.stroke();
}

function drawArc(ctx, p, alpha) {
  const color = magColor(p.vis.mag, SKY_RAMP), { el, az, lit, vis } = p.tr;
  const pts = [];
  for (let j = 0; j < el.length; j++) pts.push([...xyAzEl(Math.max(el[j], -3), az[j]), p.a + j]);
  arcs.push({ p, pts });
  ctx.save();
  ctx.globalAlpha = alpha; ctx.strokeStyle = color; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  // One stroke per run of samples with the same style: visible thick, sunlit thin, shadow dotted.
  const style = (j) => (vis[j] ? 2 : lit[j] ? 1 : 0);
  let a = 0;
  while (a < pts.length - 1) {
    const st = style(a);
    let b = a + 1;
    while (b < pts.length - 1 && style(b) === st) b++;
    ctx.lineWidth = st === 2 ? 3.2 : st === 1 ? 1.8 : 1.5;
    ctx.setLineDash(st === 0 ? [1.5, 3.5] : []);
    ctx.beginPath(); ctx.moveTo(pts[a][0], pts[a][1]);
    for (let j = a + 1; j <= b; j++) ctx.lineTo(pts[j][0], pts[j][1]);
    ctx.stroke();
    a = b;
  }
  // Arrowhead at the setting end shows the direction of travel.
  const [xe, ye] = pts[pts.length - 1], [xp, yp] = pts[Math.max(0, pts.length - 3)];
  const ang = Math.atan2(ye - yp, xe - xp);
  ctx.setLineDash([]); ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(xe, ye);
  ctx.lineTo(xe - 7 * Math.cos(ang - 0.45), ye - 7 * Math.sin(ang - 0.45));
  ctx.lineTo(xe - 7 * Math.cos(ang + 0.45), ye - 7 * Math.sin(ang + 0.45));
  ctx.fill();
  ctx.restore();
}

/** Readout under the sky view: the shown satellites that are up, brightest first. */
function renderInfo(T, hover, up, sunEl) {
  up.sort((a, b) => (a.vis ? a.q.mag : 99) - (b.vis ? b.q.mag : 99));
  const cells = up.slice(0, READOUT_CELLS).map(({ s, q, p, vis }) =>
    `<span class="pi-cell" title="${s.ctName} (#${s.id})">` +
    `<span class="swatch" style="border-color:${magColor(p.vis.mag, chartRamp)}"></span>${s.name} ` +
    `<b>${q.el.toFixed(0)}° ${dir8(q.az)} · ${vis ? `mag ${fmtMag(q.mag)}` : q.lit ? 'sunlit' : 'in shadow'}</b></span>`);
  if (up.length > READOUT_CELLS) cells.push(`<span class="pi-cell muted">+${up.length - READOUT_CELLS} more</span>`);
  if (!up.length) {
    const next = passes.find((p) => shown(p) && p.rise > T);
    cells.push(`<span class="pi-cell pi-wide muted">Nothing brighter than mag ${fmtMag(magCut)} up` +
      (next ? ` · next: <b>${sats.get(next.id).name}</b> ${fmtTime(next.rise, tz, true)}, mag ${fmtMag(next.vis.mag)}` : '') + '</span>');
  }
  const when = hover ? `${fmtTime(T, tz, true)} <span class="muted">${tzLabel()}</span>` : 'Now';
  const sky = sunEl >= 0 ? 'day' : sunEl >= -6 ? 'civil twilight' : sunEl >= -12 ? 'nautical twilight'
    : sunEl >= -18 ? 'astronomical twilight' : 'night';
  root.querySelector('#sat-polar-info').innerHTML =
    `<div class="pi-time">${when} <span class="muted">· ${sky}, Sun ${sunEl.toFixed(0)}°</span></div>${cells.join('')}`;
}

function onPolarHover(e) {
  const canvas = e.currentTarget, r = canvas.getBoundingClientRect();
  const px = (e.clientX - r.left) * SIZE / r.width, py = (e.clientY - r.top) * SIZE / r.height;
  let best = null, bestD = 14 * 14;
  for (const { p, pts } of arcs) {
    for (const [x, y, i] of pts) {
      const d = (x - px) ** 2 + (y - py) ** 2;
      if (d < bestD && trackAt(p, i)?.el >= 0) { bestD = d; best = i; }
    }
  }
  if (best == null || !chart) return;
  // Keep the hovered time inside the chart's view so the cursor can sit on it.
  const [a, b] = view();
  if (grid.t[best] < a || grid.t[best] > b) return;
  chart.setCursor({ left: chart.valToPos(grid.t[best], 'x'), top: chart.over.clientHeight / 2 }, true);
}
