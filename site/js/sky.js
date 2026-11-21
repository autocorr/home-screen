// Sky panel: elevation/azimuth vs time and polar plot for VLA targets.
import { VLA, SOURCES, SUN_COLOR, MOON_COLOR, VLA_EL_LIMIT, SKY_WINDOW, TZ } from './config.js';
import * as astro from './astro.js';
import { makeChart, cssVar } from './charts.js';

const TZ_KEY = 'sky:tz';
let tz = (() => { try { return localStorage.getItem(TZ_KEY) || TZ; } catch { return TZ; } })();

let targets, obs, grid, charts = [], cursorIdx = null, root;
// Legend interaction state shared by the polar plot and both time charts
// (target index k; uPlot series index is k + 1).
let focusIdx = null;          // highlighted target, or null
const hidden = new Set();     // targets toggled off

const sep = (a, b) => { // angular separation (deg) from el/az pairs
  const r = Math.PI / 180;
  const c = Math.sin(a.el * r) * Math.sin(b.el * r) +
    Math.cos(a.el * r) * Math.cos(b.el * r) * Math.cos((a.az - b.az) * r);
  return Math.acos(Math.min(1, Math.max(-1, c))) / r;
};

export function initSky(el) {
  root = el;
  obs = astro.observer(VLA);
  targets = astro.makeTargets(SOURCES, [
    { name: 'Sun', bodyName: 'Sun', color: SUN_COLOR, kind: 'sun' },
    { name: 'Moon', bodyName: 'Moon', color: MOON_COLOR, kind: 'moon' },
  ]);
  root.querySelector('#sky-tz').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tz]');
    if (!b) return;
    tz = b.dataset.tz;
    try { localStorage.setItem(TZ_KEY, tz); } catch { /* ignore */ }
    buildCharts();   // axes + legend times
    updateTable();   // rise/set times
  });
  const polar = root.querySelector('#sky-polar');
  polar.addEventListener('pointermove', onPolarHover);
  polar.addEventListener('pointerleave', () => {
    charts[0]?.setCursor({ left: -10, top: -10 });
    setFocus(null);
  });
  // Polar readout behaves like a uPlot legend: hover to highlight, click to toggle.
  const info = root.querySelector('#sky-polar-info');
  info.addEventListener('pointerover', (e) => {
    const cell = e.target.closest('.pi-cell');
    if (cell) setFocus(Number(cell.dataset.k));
  });
  info.addEventListener('pointerleave', () => setFocus(null));
  info.addEventListener('click', (e) => {
    const cell = e.target.closest('.pi-cell');
    if (cell) setShown(Number(cell.dataset.k), hidden.has(Number(cell.dataset.k)));
  });
  info.addEventListener('keydown', (e) => {
    const cell = e.target.closest('.pi-cell');
    if (cell && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); cell.click(); }
  });

  computeTracks();
  buildCharts();
  updateNow();
  setInterval(updateNow, 10e3);
  setInterval(() => { computeTracks(); refreshChartData(); }, 5 * 60e3);
  setInterval(updateTable, 60e3);
}

export function rerender() { if (grid) buildCharts(); }

function computeTracks() {
  const step = SKY_WINDOW.stepMin * 60;
  const now = Math.floor(Date.now() / 1000 / step) * step;
  grid = astro.tracks(targets, obs, VLA.lon,
    now - SKY_WINDOW.before * 3600, now + SKY_WINDOW.after * 3600, step);
  updateTable();
}

function azSeries(tr) {
  // Only while above the horizon; break the line where azimuth wraps 360->0.
  return tr.az.map((a, i) => {
    if (tr.el[i] < 0) return null;
    if (i > 0 && tr.el[i - 1] >= 0 && Math.abs(a - tr.az[i - 1]) > 180) return null;
    return a;
  });
}

function chartData() {
  return {
    el: [grid.t, ...grid.tracks.map((tr) => tr.el)],
    az: [grid.t, ...grid.tracks.map(azSeries)],
  };
}

function buildCharts() {
  charts.forEach((c) => c.destroy());
  root.querySelectorAll('#sky-tz button').forEach((b) =>
    b.setAttribute('aria-pressed', String(b.dataset.tz === tz)));
  const d = chartData();
  const series = targets.map((t) => ({ label: t.name, color: t.color, fmt: (v) => `${v.toFixed(1)}°` }));
  // Sky times are 24-hour in both MT and UTC.
  const common = { tz, h24: true, timeLabel: tzLabel(), syncKey: 'sky', now: () => Date.now() / 1000,
    height: matchMedia('(max-width: 559px)').matches ? 190 : 220 };
  const elChart = makeChart(root.querySelector('#sky-el'), {
    ...common, data: d.el, series, yRange: [0, 90], ySplits: () => [0, 15, 30, 45, 60, 75, 90],
    yValues: (u, v) => v.map((x) => `${x}°`),
    hlines: [{ value: VLA_EL_LIMIT, label: `VLA limit ${VLA_EL_LIMIT}°` }],
    hooks: { setCursor: [(u) => { cursorIdx = u.cursor.idx; drawPolar(); }], setSeries: [onSeries] },
  });
  const azChart = makeChart(root.querySelector('#sky-az'), {
    ...common, data: d.az, series, yRange: [0, 360], ySplits: () => [0, 90, 180, 270, 360],
    yValues: (u, v) => v.map((x) => ({ 0: 'N', 90: 'E', 180: 'S', 270: 'W', 360: 'N' }[x] ?? `${x}°`)),
    hooks: { setSeries: [onSeries] },
  });
  charts = [elChart, azChart];
  hidden.forEach((k) => charts.forEach((c) => c.setSeries(k + 1, { show: false })));
  drawPolar();
}

// ---------- legend interaction (focus / show) ----------
let syncing = false;

/** uPlot setSeries hook: mirror legend hover/click from either time chart. */
function onSeries(u, sidx, opts) {
  if (syncing) return;
  if (opts.focus != null) {
    focusIdx = sidx == null || sidx === 0 ? null : sidx - 1;
  }
  if (opts.show != null && sidx) {
    const k = sidx - 1;
    if (opts.show) hidden.delete(k); else hidden.add(k);
    syncing = true;
    charts.forEach((c) => { if (c !== u && c.series[sidx].show !== opts.show) c.setSeries(sidx, { show: opts.show }); });
    syncing = false;
  }
  drawPolar();
}

function setFocus(k) {
  if (k === focusIdx) return;
  focusIdx = k;
  syncing = true;
  charts.forEach((c) => c.setSeries(k == null ? null : k + 1, { focus: true }));
  syncing = false;
  drawPolar();
}

function setShown(k, show) {
  if (show) hidden.delete(k); else hidden.add(k);
  syncing = true;
  charts.forEach((c) => c.setSeries(k + 1, { show }));
  syncing = false;
  drawPolar();
}

function refreshChartData() {
  const d = chartData();
  charts[0]?.setData(d.el);
  charts[1]?.setData(d.az);
  drawPolar();
}

function updateNow() {
  charts.forEach((c) => c.redraw(false));
  drawPolar();
}

// ---------- table ----------
const tzLabel = () => (tz === 'UTC' ? 'UTC' : 'MT');

function fmtClock(date) {
  if (!date) return '—';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(date);
}

function updateTable() {
  const now = new Date();
  const pos = targets.map((t) => astro.position(t, now, obs, VLA.lon));
  const sun = pos[targets.findIndex((t) => t.kind === 'sun')];
  const moonIllum = globalThis.Astronomy.Illumination(globalThis.Astronomy.Body.Moon, now).phase_fraction;
  const rows = targets.map((t, i) => {
    const p = pos[i];
    const limit = t.kind === 'source' ? VLA_EL_LIMIT : 0;
    const up = p.el >= limit;
    const next = astro.nextCrossing(t, obs, VLA.lon, now, limit, !up, 24);
    const lit = t.kind === 'moon' ? `${Math.round(moonIllum * 100)}% lit` : '';
    const nextTxt = `${up ? 'sets' : 'rises'} ${fmtClock(next)}`;
    return `<tr class="${up ? '' : 'down'}">` +
      `<th scope="row"><span class="swatch" style="border-color:var(${t.color})"></span>${t.name}` +
      (lit ? ` <span class="muted wide-only">${lit}</span>` : '') +
      `<span class="row-sub">${nextTxt}${lit ? ` · ${lit}` : ''}</span></th>` +
      `<td>${p.el.toFixed(1)}°</td><td>${p.az.toFixed(1)}°</td>` +
      `<td>${p.ha >= 0 ? '+' : '−'}${astro.formatHMS(Math.abs(p.ha)).slice(0, 5)}</td>` +
      `<td>${t.kind === 'sun' ? '—' : `${sep(p, sun).toFixed(0)}°`}</td>` +
      `<td class="col-next">${nextTxt}</td></tr>`;
  });
  root.querySelector('#sky-table tbody').innerHTML = rows.join('');
  root.querySelector('#sky-table th.col-next').textContent = `Next (${tzLabel()})`;
}

// ---------- polar ----------
const SIZE = 400, C = SIZE / 2, R = 180;
const xy = (el, az) => {
  const r = R * (90 - Math.max(el, 0)) / 90, a = az * Math.PI / 180;
  return [C + r * Math.sin(a), C - r * Math.cos(a)];
};

function pathFor(tr, i0, i1) {
  let d = '', pen = false;
  for (let i = i0; i <= i1; i++) {
    if (tr.el[i] < 0) { pen = false; continue; }
    const [x, y] = xy(tr.el[i], tr.az[i]);
    d += `${pen ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
    pen = true;
  }
  return d;
}

function drawPolar() {
  const svg = root.querySelector('#sky-polar');
  if (!grid) return;
  const nowSec = Date.now() / 1000;
  const iNow = Math.max(0, grid.t.findIndex((t) => t > nowSec) - 1);
  const now = new Date();
  let s = '';
  // rings & spokes
  for (const el of [0, 30, 60]) {
    s += `<circle class="ring" cx="${C}" cy="${C}" r="${R * (90 - el) / 90}"/>`;
    s += `<text class="ring-label" x="${C + 3}" y="${C - R * (90 - el) / 90 + 11}">${el}°</text>`;
  }
  s += `<circle class="limit" cx="${C}" cy="${C}" r="${R * (90 - VLA_EL_LIMIT) / 90}"/>`;
  for (let az = 0; az < 360; az += 45) {
    const [x, y] = xy(0, az);
    s += `<line class="spoke" x1="${C}" y1="${C}" x2="${x}" y2="${y}"/>`;
  }
  for (const [lab, az] of [['N', 0], ['E', 90], ['S', 180], ['W', 270]]) {
    const [x, y] = xy(-1, az);
    const [lx, ly] = [C + (x - C) * 1.07, C + (y - C) * 1.07];
    s += `<text class="compass" x="${lx}" y="${ly}">${lab}</text>`;
  }
  // tracks (the focused target is drawn last so it sits on top)
  const dim = (k) => (focusIdx != null && focusIdx !== k ? ' dim' : '');
  const order = targets.map((_, k) => k).filter((k) => !hidden.has(k));
  if (focusIdx != null && order.includes(focusIdx)) order.push(...order.splice(order.indexOf(focusIdx), 1));
  order.forEach((k) => {
    const t = targets[k], tr = grid.tracks[k];
    s += `<g class="target${dim(k)}">`;
    s += `<path class="track past" style="stroke:var(${t.color})" d="${pathFor(tr, 0, iNow + 1)}"/>`;
    s += `<path class="track" style="stroke:var(${t.color})" d="${pathFor(tr, iNow, grid.t.length - 1)}"/>`;
    s += `</g>`;
  });
  // current positions with direct labels
  order.forEach((k) => {
    const t = targets[k];
    const p = astro.position(t, now, obs, VLA.lon);
    if (p.el < 0) return;
    const [x, y] = xy(p.el, p.az);
    s += `<g class="target${dim(k)}">`;
    s += `<circle class="pos" cx="${x}" cy="${y}" r="5.5" style="fill:var(${t.color})"/>`;
    s += `<text class="pos-label" x="${x + 8}" y="${y + 4}">${t.name}</text></g>`;
  });
  // Readout: a fixed grid with one cell per target (always present, "—" when
  // below the horizon) so its height never changes as the cursor moves.
  const hover = cursorIdx != null && grid.t[cursorIdx] != null;
  const cells = targets.map((t, k) => {
    let el, az;
    if (hover) {
      el = grid.tracks[k].el[cursorIdx]; az = grid.tracks[k].az[cursorIdx];
      if (el >= 0 && !hidden.has(k)) {
        const [x, y] = xy(el, az);
        s += `<circle class="cursor-pos${dim(k)}" cx="${x}" cy="${y}" r="6" style="stroke:var(${t.color})"/>`;
      }
    } else {
      ({ el, az } = astro.position(t, now, obs, VLA.lon));
    }
    const val = el >= 0 ? `${el.toFixed(1)}° / ${az.toFixed(1)}°` : '—';
    const cls = `pi-cell${hidden.has(k) ? ' off' : ''}${dim(k) ? ' faded' : ''}`;
    return `<span class="${cls}" data-k="${k}" role="button" tabindex="0" ` +
      `aria-pressed="${!hidden.has(k)}" title="Hover to highlight, click to show/hide ${t.name}">` +
      `<span class="swatch" style="border-color:var(${t.color})"></span>${t.name} <b>${val}</b></span>`;
  });
  const info = `<div class="pi-time">${hover ? fmtClock(new Date(grid.t[cursorIdx] * 1000)) : 'Now'}` +
    ` <span class="muted">${hover ? tzLabel() + ' ' : ''}· El / Az</span></div>${cells.join('')}`;
  svg.innerHTML = s;
  root.querySelector('#sky-polar-info').innerHTML = info;
}

function onPolarHover(e) {
  const svg = e.currentTarget;
  const r = svg.getBoundingClientRect();
  const px = (e.clientX - r.left) * SIZE / r.width;
  const py = (e.clientY - r.top) * SIZE / r.height;
  let best = null, bestK = null, bestD = 14 * 14;
  grid.tracks.forEach((tr, k) => {
    if (hidden.has(k)) return;
    for (let i = 0; i < grid.t.length; i++) {
      if (tr.el[i] < 0) continue;
      const [x, y] = xy(tr.el[i], tr.az[i]);
      const d = (x - px) ** 2 + (y - py) ** 2;
      if (d < bestD) { bestD = d; best = i; bestK = k; }
    }
  });
  const u = charts[0];
  if (best == null || !u) { setFocus(null); return; }
  // Drive the time-chart cursor; its setCursor hook redraws the polar markers.
  u.setCursor({ left: u.valToPos(grid.t[best], 'x'), top: u.over.clientHeight / 2 });
  setFocus(bestK); // highlight the nearest track, like uPlot's proximity focus
}
