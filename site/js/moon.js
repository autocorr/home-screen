// Moon section: lunar calendar for the location (Socorro by default). Everything is computed in the
// browser with Astronomy Engine; nothing is downloaded.
//
// Rise/set use the Moon's upper limb with standard refraction (Astronomy
// Engine's SearchRiseSet). The chart and the dark-hours count use the geometric
// elevation of the Moon's centre.
import { MOON } from './config.js';
import { makeChart } from './charts.js';
import { getLocation, onLocation } from './location.js';

const A = () => globalThis.Astronomy;
const DAY = 86400e3;

let root, obs, chart = null, grid = null, days = [];

// ---------- time helpers (calendar days in the location's timezone, TZ) ----------
// TZ is MT for Socorro and the browser's own zone for the current location.
let TZ, isoFmt, hmFmt, dowFmt, mdFmt, dateFmt, longFmt, offFmt;
function setTZ(tz) {
  TZ = tz;
  const f = (loc, o) => new Intl.DateTimeFormat(loc, { timeZone: tz, ...o });
  isoFmt = f('en-CA', {});
  hmFmt = f('en-US', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  dowFmt = f('en-US', { weekday: 'short' });
  mdFmt = f('en-US', { month: 'numeric', day: 'numeric' });
  dateFmt = f('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  longFmt = f('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  offFmt = f('en-US', { hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric' });
}
setTZ(getLocation().tz);
const hm = (d) => (d ? hmFmt.format(d) : '—');
const when = (d) => `${dateFmt.format(d)} ${hm(d)}`;

/** UTC offset (ms) of TZ at instant `ms`. */
function tzOffset(ms) {
  const p = Object.fromEntries(offFmt.formatToParts(new Date(ms)).map((x) => [x.type, Number(x.value)]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

/** Start of the TZ calendar day containing `date`, plus `addDays` days. */
export function dayStart(date, addDays = 0) {
  const [y, m, d] = isoFmt.format(date).split('-').map(Number);
  const utc = Date.UTC(y, m - 1, d + addDays);
  return new Date(utc - tzOffset(utc + 12 * 3600e3));
}

// ---------- astronomy ----------
const QUARTERS = ['New Moon', 'First Quarter', 'Full Moon', 'Last Quarter'];
const QUARTER_ICON = ['🌑', '🌓', '🌕', '🌗'];

/** Phase name from the Moon–Sun ecliptic longitude difference (0 new, 180 full). */
export function phaseName(deg) {
  const near = 12;  // ≈ one day either side of a principal phase
  for (let q = 0; q < 4; q++) {
    const d = Math.abs(((deg - q * 90 + 540) % 360) - 180);
    if (d < near) return QUARTERS[q];
  }
  if (deg < 90) return 'Waxing crescent';
  if (deg < 180) return 'Waxing gibbous';
  if (deg < 270) return 'Waning gibbous';
  return 'Waning crescent';
}

function altitude(body, date) {
  const Ast = A();
  const eq = Ast.Equator(body, date, obs, true, true);
  return Ast.Horizon(date, obs, eq.ra, eq.dec).altitude;
}

const searchTime = (t) => t?.date ?? null;

/** Principal phases and apsides from `from` until `to`, sorted by time. */
function events(from, to) {
  const Ast = A(), out = [];
  for (let q = Ast.SearchMoonQuarter(from); q.time.date < to; q = Ast.NextMoonQuarter(q)) {
    out.push({ kind: 'phase', quarter: q.quarter, date: q.time.date, label: QUARTERS[q.quarter] });
  }
  for (let a = Ast.SearchLunarApsis(from); a.time.date < to; a = Ast.NextLunarApsis(a)) {
    out.push({ kind: 'apsis', date: a.time.date, label: a.kind === 0 ? 'Perigee' : 'Apogee', km: a.dist_km });
  }
  return out.sort((a, b) => a.date - b.date);
}

/** One calendar day: phase at local noon, rise/transit/set, events, moon-free dark time. */
function computeDay(t0, evts) {
  const Ast = A(), t1 = dayStart(t0, 1);
  const noon = new Date((t0.getTime() + t1.getTime()) / 2);
  const inDay = (d) => d && d >= t0 && d < t1 ? d : null;
  const rise = inDay(searchTime(Ast.SearchRiseSet(Ast.Body.Moon, obs, +1, t0, 1)));
  const set = inDay(searchTime(Ast.SearchRiseSet(Ast.Body.Moon, obs, -1, t0, 1)));
  const tr = Ast.SearchHourAngle(Ast.Body.Moon, obs, 0, t0, +1);
  const transit = inDay(tr.time.date) ? { date: tr.time.date, el: tr.hor.altitude } : null;
  const lit = Ast.Illumination(Ast.Body.Moon, noon).phase_fraction;
  const phase = Ast.MoonPhase(noon);
  const dist = Ast.Libration(noon).dist_km;
  return {
    t0, t1, noon, rise, set, transit, lit, phase, dist,
    events: evts.filter((e) => e.date >= t0 && e.date < t1),
    dark: darkWindows(new Date(noon), new Date(noon.getTime() + DAY)),
  };
}

/**
 * Intervals in [a, b) when the Sun is below MOON.darkSunEl and the Moon's centre
 * below the horizon, sampled every MOON.stepMin minutes.
 */
function darkWindows(a, b) {
  const Ast = A(), step = MOON.stepMin * 60e3, out = [];
  let start = null;
  for (let t = a.getTime(); t <= b.getTime(); t += step) {
    const d = new Date(t);
    const dark = t < b.getTime() && altitude(Ast.Body.Sun, d) < MOON.darkSunEl && altitude(Ast.Body.Moon, d) < 0;
    if (dark && start == null) start = t;
    if (!dark && start != null) { out.push([new Date(start), d]); start = null; }
  }
  return out;
}

// ---------- drawing ----------
// The disk is drawn from a map of the Moon (NASA LRO LROC WAC mosaic, data/moon_lroc_1k.jpg:
// equirectangular, longitude 0 in the middle, east to the right), projected for the actual
// geometry: celestial north up and east left as seen from Earth, the Moon's rotation and
// libration from its IAU rotation model, and the terminator from the Sun's direction.
const TEXTURE_URL = 'data/moon_lroc_1k.jpg';
let texture = null;   // { w, h, lum: Uint8Array } once loaded

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a) => { const n = Math.hypot(...a); return a.map((x) => x / n); };
const RAD = Math.PI / 180;

/**
 * Geometry of the Moon's face at `date` (geocentric, J2000 equatorial vectors):
 * screen right R (west), up N (celestial north), toward Earth D; the Moon's
 * body-fixed axes X (lon 0, lat 0), Y (lon 90° E), Z (north pole); Sun direction.
 */
export function moonView(date) {
  const Ast = A();
  const M = Ast.GeoMoon(date), S = Ast.GeoVector(Ast.Body.Sun, date, true);
  const D = unit([-M.x, -M.y, -M.z]);
  const sun = unit([S.x - M.x, S.y - M.y, S.z - M.z]);
  const N = unit([-D[2] * D[0], -D[2] * D[1], 1 - D[2] * D[2]]);  // north minus its D part
  const R = cross(N, D);
  const ax = Ast.RotationAxis(Ast.Body.Moon, date);
  const Z = [ax.north.x, ax.north.y, ax.north.z];
  const a = ax.ra * 15 * RAD, W = ax.spin * RAD;
  const Q = [-Math.sin(a), Math.cos(a), 0];   // ascending node of the lunar equator
  const Y0 = cross(Z, Q);
  const X = Q.map((q, i) => Math.cos(W) * q + Math.sin(W) * Y0[i]);
  const Y = cross(Z, X);
  return { R, N, D, X, Y, Z, sun };
}

function loadTexture() {
  const img = new Image();
  img.onload = () => {
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const px = ctx.getImageData(0, 0, c.width, c.height).data;
    const lum = new Uint8Array(c.width * c.height);
    for (let i = 0; i < lum.length; i++) lum[i] = (px[4 * i] * 54 + px[4 * i + 1] * 183 + px[4 * i + 2] * 19) >> 8;
    texture = { w: c.width, h: c.height, lum };
    drawDisks();
  };
  img.onerror = () => console.warn('Moon map failed to load; drawing a plain disk');
  img.src = TEXTURE_URL;
}

/** Markup for a disk canvas, drawn by drawDisks() for the Moon at `date`. */
function moonCanvas(date, size, title) {
  return `<span class="moon-disk" title="${title}" role="img" aria-label="${title}">` +
    `<canvas data-t="${date.getTime()}" data-size="${size}" style="width:${size}px;height:${size}px"></canvas></span>`;
}

function drawDisks() {
  root?.querySelectorAll('canvas[data-t]').forEach((c) => drawMoon(c, new Date(Number(c.dataset.t)), Number(c.dataset.size)));
}

/** Render the Moon's face into canvas `c` (CSS size `size` px). */
function drawMoon(c, date, size) {
  const n = Math.round(size * Math.min(3, devicePixelRatio || 1));
  c.width = n; c.height = n;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(n, n), out = img.data;
  const v = moonView(date);
  // Per-pixel dot products are linear in screen (u, v, w): precompute coefficients.
  const k = (b) => [dot(v.R, b), dot(v.N, b), dot(v.D, b)];
  const kx = k(v.X), ky = k(v.Y), kz = k(v.Z), ks = k(v.sun);
  const tex = texture, ss = 2;                 // 2×2 supersampling per pixel
  const rPx = n / 2 - 0.5;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      let sum = 0, cover = 0;
      for (let sj = 0; sj < ss; sj++) {
        for (let si = 0; si < ss; si++) {
          const u = (i + (si + 0.5) / ss - n / 2) / rPx;
          const w2 = (j + (sj + 0.5) / ss - n / 2) / rPx;   // screen y, down
          const rr = u * u + w2 * w2;
          if (rr > 1) continue;
          const vv = -w2, w = Math.sqrt(1 - rr);
          const x = kx[0] * u + kx[1] * vv + kx[2] * w;
          const y = ky[0] * u + ky[1] * vv + ky[2] * w;
          const z = kz[0] * u + kz[1] * vv + kz[2] * w;
          let alb = 165;
          if (tex) {
            const lon = Math.atan2(y, x), lat = Math.asin(Math.max(-1, Math.min(1, z)));
            const tx = Math.min(tex.w - 1, Math.floor((lon / Math.PI + 1) / 2 * tex.w));
            const ty = Math.min(tex.h - 1, Math.floor((0.5 - lat / Math.PI) * tex.h));
            alb = tex.lum[ty * tex.w + tx];
          }
          // Sharp terminator, slightly softened; the night side keeps a faint earthshine.
          const l = ks[0] * u + ks[1] * vv + ks[2] * w;
          const lit = Math.max(0, Math.min(1, l / 0.03 + 0.5));
          sum += alb * (0.1 + 0.95 * lit);
          cover++;
        }
      }
      const o = 4 * (j * n + i);
      const g = cover ? Math.min(255, sum / cover) : 0;
      out[o] = g; out[o + 1] = g; out[o + 2] = g * 0.96;
      out[o + 3] = 255 * cover / (ss * ss);
    }
  }
  ctx.putImageData(img, 0, 0);
}

// ---------- rendering ----------
export function initMoon(el) {
  root = el;
  const setObs = (o) => { obs = new (A().Observer)(o.lat, o.lon, o.height); };
  setObs(getLocation());
  onLocation((o) => { setObs(o); setTZ(o.tz); lastBuild = 0; refresh(); });
  loadTexture();
  refresh();
  // Positions change slowly: refresh the summary every minute, the calendar and
  // chart every 10 min (and when the local date changes).
  setInterval(refresh, 60e3);
  // Collapsing or hiding pauses it; showing it again catches up at once.
  new MutationObserver(refresh).observe(root, { attributes: true, attributeFilter: ['class', 'hidden'] });
}

export function rerender() { if (grid) buildChart(); }

let lastBuild = 0, lastDay = '';
function refresh() {
  if (root.closest('[hidden]') || root.classList.contains('collapsed')) {
    lastBuild = 0;  // recompute as soon as it is shown again
    return;
  }
  const now = new Date(), today = isoFmt.format(now);
  if (now - lastBuild > 10 * 60e3 || today !== lastDay) {
    lastBuild = now.getTime(); lastDay = today;
    computeCalendar(now);
    renderDays();
    buildChart();
  }
  renderNow(now);
  drawDisks();
}

function computeCalendar(now) {
  const t0 = dayStart(now), tEnd = dayStart(now, MOON.days);
  const evts = events(t0, tEnd);
  days = [];
  for (let i = 0; i < MOON.days; i++) days.push(computeDay(dayStart(now, i), evts));
  // Elevation chart over the same days.
  const step = MOON.stepMin * 60, t = [], el = [], sun = [];
  for (let s = t0.getTime() / 1000; s <= tEnd.getTime() / 1000; s += step) {
    const d = new Date(s * 1000);
    t.push(s);
    el.push(altitude(A().Body.Moon, d));
    sun.push(altitude(A().Body.Sun, d));
  }
  const night = [];
  let start = null;
  sun.forEach((v, i) => {
    if (v < 0 && start == null) start = t[i];
    if (v >= 0 && start != null) { night.push([start, t[i]]); start = null; }
  });
  if (start != null) night.push([start, t.at(-1)]);
  grid = { t, el, night };
}

function tile(label, value, sub = '', title = '') {
  return `<div class="tile"${title ? ` title="${title}"` : ''}><div class="tile-label">${label}</div>` +
    `<div class="tile-value">${value}</div>${sub ? `<div class="tile-sub">${sub}</div>` : ''}</div>`;
}

function renderNow(now) {
  const Ast = A();
  const lit = Ast.Illumination(Ast.Body.Moon, now).phase_fraction;
  const phase = Ast.MoonPhase(now);
  const name = phaseName(phase);
  const prevNew = Ast.SearchMoonPhase(0, now, -35)?.date;
  const age = prevNew ? (now - prevNew) / DAY : null;
  const lib = Ast.Libration(now);
  const eqd = Ast.Equator(Ast.Body.Moon, now, obs, true, true);
  const hor = Ast.Horizon(now, obs, eqd.ra, eqd.dec, 'normal');
  const j2000 = Ast.Equator(Ast.Body.Moon, now, obs, false, true);
  const con = Ast.Constellation(j2000.ra, j2000.dec).name;
  const up = hor.altitude > 0;
  const next = searchTime(Ast.SearchRiseSet(Ast.Body.Moon, obs, up ? -1 : +1, now, 2));

  // Next of each principal phase, soonest first.
  const quarters = [];
  for (let q = Ast.SearchMoonQuarter(now); quarters.length < 4; q = Ast.NextMoonQuarter(q)) quarters.push(q);
  const apsides = [Ast.SearchLunarApsis(now)];
  apsides.push(Ast.NextLunarApsis(apsides[0]));
  const ecl = Ast.SearchLunarEclipse(now);
  const eclEl = altitude(Ast.Body.Moon, ecl.peak.date);
  const kind = ecl.kind[0].toUpperCase() + ecl.kind.slice(1);

  const fmtKm = (km) => `${Math.round(km).toLocaleString('en-US')} km`;
  root.querySelector('#moon-now').innerHTML =
    `<div class="tile tile-hero moon-hero">${moonCanvas(now, 64, `${name}, north up, east left`)}` +
      `<div><div class="tile-label">Now</div><div class="tile-value">${name}</div>` +
      `<div class="tile-sub">${(lit * 100).toFixed(0)}% lit${age != null ? ` · ${age.toFixed(1)} d old` : ''}</div></div></div>` +
    tile('Position', up ? `${hor.altitude.toFixed(0)}° up` : 'Below horizon',
      `${up ? 'sets' : 'rises'} ${next ? when(next) : '—'}`,
      `Azimuth ${hor.azimuth.toFixed(0)}°, apparent elevation (with refraction) ${hor.altitude.toFixed(1)}°`) +
    tile('Distance', fmtKm(lib.dist_km), `${(lib.diam_deg * 60).toFixed(1)}′ across`) +
    tile('Constellation', con, `libration ${lib.elon >= 0 ? '+' : '−'}${Math.abs(lib.elon).toFixed(1)}° lon, ${lib.elat >= 0 ? '+' : '−'}${Math.abs(lib.elat).toFixed(1)}° lat`,
      'Optical libration: the sub-Earth point on the Moon, in selenographic longitude and latitude') +
    `<div class="tile tile-hero"><div class="tile-label">Next phases</div><ul class="moon-list">` +
      quarters.map((q) => `<li>${QUARTER_ICON[q.quarter]} ${QUARTERS[q.quarter]} <span>${when(q.time.date)}</span></li>`).join('') +
    `</ul></div>` +
    `<div class="tile tile-hero"><div class="tile-label">Perigee / apogee</div><ul class="moon-list">` +
      apsides.map((a) => `<li>${a.kind === 0 ? 'Perigee' : 'Apogee'} <span>${when(a.time.date)} · ${fmtKm(a.dist_km)}</span></li>`).join('') +
    `</ul></div>` +
    tile('Next eclipse', `${kind}`, `${longFmt.format(ecl.peak.date)} ${hm(ecl.peak.date)} · ${eclEl > 0 ? `visible, Moon ${eclEl.toFixed(0)}° up` : 'not visible here'}`,
      `Time of greatest eclipse (${getLocation().tzLabel}). Visible when the Moon is above the horizon at ${getLocation().current ? 'your location' : 'Socorro'} then.`);
}

function renderDays() {
  const today = isoFmt.format(new Date());
  root.querySelector('#moon-days').innerHTML = days.map((d) => {
    const isToday = isoFmt.format(d.t0) === today;
    const name = phaseName(d.phase);
    const darkH = d.dark.reduce((s, [a, b]) => s + (b - a), 0) / 3600e3;
    const darkTitle = d.dark.length
      ? `Sun below ${MOON.darkSunEl}° and Moon down, night starting ${dowFmt.format(d.t0)}: ${d.dark.map(([a, b]) => `${hm(a)}–${hm(b)}`).join(', ')}`
      : `No moon-free astronomical darkness the night starting ${dowFmt.format(d.t0)}`;
    const ev = d.events.map((e) => e.kind === 'phase'
      ? `<div class="day-meta moon-event">${QUARTER_ICON[e.quarter]} ${e.label.replace(' Moon', '')} ${hm(e.date)}</div>`
      : `<div class="day-meta" title="${Math.round(e.km).toLocaleString('en-US')} km">${e.label} ${hm(e.date)}</div>`).join('');
    return `<div class="day${isToday ? ' today' : ''}">` +
      `<div class="day-name">${isToday ? 'Today' : dowFmt.format(d.t0)} <span class="unit">${mdFmt.format(d.t0)}</span></div>` +
      `<div class="day-icon">${moonCanvas(d.noon, 34, `${name}, ${(d.lit * 100).toFixed(0)}% lit at noon; north up, east left`)}</div>` +
      `<div class="day-temps"><b>${(d.lit * 100).toFixed(0)}%</b> <span>${d.phase < 180 ? 'waxing' : 'waning'}</span></div>` +
      `<div class="day-meta" title="Moonrise">↑ ${hm(d.rise)}</div>` +
      `<div class="day-meta" title="Transit (highest point) and its elevation">⊤ ${d.transit ? `${hm(d.transit.date)} ${d.transit.el.toFixed(0)}°` : '—'}</div>` +
      `<div class="day-meta" title="Moonset">↓ ${hm(d.set)}</div>` +
      `<div class="day-meta" title="${darkTitle}">Dark ${darkH.toFixed(1)} h</div>` +
      ev + `</div>`;
  }).join('');
}

function buildChart() {
  chart?.destroy();
  const el = root.querySelector('#moon-el');
  el.innerHTML = '';
  chart = makeChart(el, {
    data: [grid.t, grid.el],
    series: [{ label: 'Moon', color: '--moon', fmt: (v) => `${v.toFixed(1)}°` }],
    tz: TZ, h24: true, timeLabel: getLocation().tzLabel, now: () => Date.now() / 1000,
    shade: () => grid.night,
    yRange: [0, 90], ySplits: () => [0, 30, 60, 90], yValues: (u, v) => v.map((x) => `${x}°`),
    xSpace: 60,  // whole days: "Wed 11/25" labels need the room on a phone
    height: matchMedia('(max-width: 559px)').matches ? 150 : 170,
  });
}
