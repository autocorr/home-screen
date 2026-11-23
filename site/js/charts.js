// Shared uPlot helpers: theming from CSS variables, responsive sizing,
// touch-friendly cursor, "now" marker, night shading, horizontal guide lines.
import { TZ } from './config.js';

const uPlot = globalThis.uPlot;

export const cssVar = (name) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export const tzDate = (tz) => (ts) => uPlot.tzDate(new Date(ts * 1e3), tz);

/** Y-axis width that just fits its longest tick label. */
function fitAxis(u, values, axisIdx, cycleNum) {
  const axis = u.axes[axisIdx];
  if (cycleNum > 1) return axis._size;
  let size = axis.ticks.size + axis.gap + 2;
  const longest = (values ?? []).reduce((a, v) => (String(v).length > a.length ? String(v) : a), '');
  if (longest) {
    u.ctx.font = axis.font[0];
    size += u.ctx.measureText(longest).width / devicePixelRatio;
  }
  return Math.ceil(size);
}

/** Hour/day axis labels for unix-second x scales. */
const xAxisValues = [
  // tick incr, default, year, month, day, hour, min, sec, mode
  [3600 * 24, '{WWW} {M}/{D}', null, null, null, null, null, null, 1],
  [3600, '{h}{aa}', '\n{WWW} {M}/{D}', null, '\n{WWW} {M}/{D}', null, null, null, 1],
  [60, '{h}:{mm}{aa}', '\n{M}/{D}', null, '\n{M}/{D}', null, null, null, 1],
];
const xAxisValues24 = [
  [3600 * 24, '{WWW} {M}/{D}', null, null, null, null, null, null, 1],
  [3600, '{HH}:{mm}', '\n{WWW} {M}/{D}', null, '\n{WWW} {M}/{D}', null, null, null, 1],
  [60, '{HH}:{mm}', '\n{M}/{D}', null, '\n{M}/{D}', null, null, null, 1],
];

export function axes(yLabel, yValues, ySplits, h24 = false) {
  const grid = { stroke: cssVar('--grid'), width: 1 };
  const ticks = { stroke: cssVar('--axis'), width: 1, size: 4 };
  const font = '10px system-ui, -apple-system, "Segoe UI", sans-serif';
  const stroke = cssVar('--text-muted');
  return [
    { stroke, grid, ticks, font, values: h24 ? xAxisValues24 : xAxisValues, space: 46, size: 32, gap: 2 },
    { stroke, grid, ticks, font, values: yValues, splits: ySplits, gap: 3, size: fitAxis,
      ...(yLabel ? { label: yLabel, labelFont: font, labelSize: 14 } : {}) },
  ];
}

// Time of the last touch on any chart. Some browsers send a synthetic
// mouseleave right after a tap, which would hide the cursor readout.
let lastTouchAt = 0;
const ignoreLeaveAfterTouch = (u, targ, handler) => (e) => {
  if (Date.now() - lastTouchAt < 1000) return null;
  return handler(e);
};

/** Touch: tap or drag horizontally across a chart to move the cursor. */
function touchPlugin() {
  return {
    hooks: {
      init(u) {
        const over = u.over;
        const move = (e) => {
          const t = e.touches[0];
          if (!t) return;
          lastTouchAt = Date.now();
          const r = over.getBoundingClientRect();
          // fire hooks, and publish to synced charts (uPlot skips sync by default).
          u.setCursor({ left: t.clientX - r.left, top: t.clientY - r.top }, true, true);
        };
        over.addEventListener('touchstart', move, { passive: true });
        over.addEventListener('touchmove', move, { passive: true });
        over.addEventListener('touchend', () => { lastTouchAt = Date.now(); }, { passive: true });
      },
    },
  };
}

/** Vertical "now" line plus optional shaded intervals (e.g. night). */
function decorPlugin({ now, shade, hlines }) {
  return {
    hooks: {
      drawClear(u) {
        const ctx = u.ctx;
        const { left, top, width, height } = u.bbox;
        ctx.save();
        ctx.beginPath();
        ctx.rect(left, top, width, height);
        ctx.clip();
        if (shade) {
          ctx.fillStyle = cssVar('--shade');
          for (const [a, b] of shade()) {
            const x0 = Math.round(u.valToPos(a, 'x', true));
            const x1 = Math.round(u.valToPos(b, 'x', true));
            ctx.fillRect(x0, top, x1 - x0, height);
          }
        }
        ctx.restore();
      },
      draw(u) {
        const ctx = u.ctx;
        const { left, top, width, height } = u.bbox;
        ctx.save();
        ctx.beginPath();
        ctx.rect(left, top, width, height);
        ctx.clip();
        for (const h of hlines || []) {
          const y = Math.round(u.valToPos(h.value, 'y', true)) + 0.5;
          ctx.strokeStyle = cssVar('--text-muted');
          ctx.lineWidth = devicePixelRatio;
          ctx.setLineDash([4 * devicePixelRatio, 4 * devicePixelRatio]);
          ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(left + width, y); ctx.stroke();
          if (h.label) {
            ctx.setLineDash([]);
            ctx.fillStyle = cssVar('--text-muted');
            ctx.font = `${10 * devicePixelRatio}px system-ui, sans-serif`;
            ctx.textBaseline = 'bottom';
            ctx.fillText(h.label, left + 4 * devicePixelRatio, y - 2 * devicePixelRatio);
          }
        }
        if (now) {
          const x = Math.round(u.valToPos(now(), 'x', true)) + 0.5;
          ctx.setLineDash([]);
          ctx.strokeStyle = cssVar('--now');
          ctx.lineWidth = 1.5 * devicePixelRatio;
          ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, top + height); ctx.stroke();
        }
        ctx.restore();
      },
    },
  };
}

/**
 * Create a responsive uPlot chart in `el`.
 * opts: { series:[{label,color,fmt,points,paths,dash,width}], data, yRange, yLabel, legend (false hides),
 *         yValues, ySplits, syncKey, now, shade, hlines, height, xRange, plugins, hooks }
 */
export function makeChart(el, opts) {
  const height = opts.height ?? 180;
  const pad = [6, 4, 0, 0]; // top, right, bottom, left (px)
  const series = [
    { label: opts.timeLabel ? `Time (${opts.timeLabel})` : 'Time',
      value: (u, v) => (v == null ? '—' : fmtTime(v, opts.tz ?? TZ, opts.h24)) },
    ...opts.series.map((s) => ({
      label: s.label,
      stroke: cssVar(s.color),
      fill: s.fill ? s.fill() : undefined,
      width: s.width ?? 2,
      dash: s.dash,
      paths: s.paths,
      points: s.points ?? { show: false },
      spanGaps: false,
      value: (u, v) => (v == null ? '—' : s.fmt ? s.fmt(v) : v.toFixed(1)),
    })),
  ];
  const u = new uPlot({
    width: Math.max(200, el.clientWidth),
    height,
    padding: pad,
    tzDate: tzDate(opts.tz ?? TZ),
    cursor: {
      sync: opts.syncKey ? { key: opts.syncKey } : undefined,
      drag: { x: false, y: false },
      bind: { mouseleave: ignoreLeaveAfterTouch },
      points: { size: 7 },
      focus: { prox: 16 },
    },
    focus: { alpha: 0.35 },
    legend: { show: opts.legend !== false, live: true },
    scales: {
      x: { time: true, range: opts.xRange ? () => opts.xRange() : undefined },
      y: { range: opts.yRange ?? ((u, min, max) => padRange(min, max)) },
    },
    axes: axes(opts.yLabel, opts.yValues, opts.ySplits, opts.h24),
    series,
    plugins: [touchPlugin(), decorPlugin(opts), ...(opts.plugins || [])],
    hooks: opts.hooks,
  }, opts.data, el);
  new ResizeObserver(() => {
    const w = Math.max(200, el.clientWidth);
    if (Math.abs(w - u.width) > 1) u.setSize({ width: w, height });
  }).observe(el);
  return u;
}

function padRange(min, max) {
  if (min == null || max == null) return [0, 1];
  if (min === max) return [min - 1, max + 1];
  const pad = (max - min) * 0.08;
  return [min - pad, max + pad];
}

const timeFmt = new Map();
/** Short weekday + time. 24-hour when `h24` (or for UTC), else 12-hour. */
export function fmtTime(sec, tz = TZ, h24 = false) {
  const key = `${tz}|${h24}`;
  if (!timeFmt.has(key)) {
    timeFmt.set(key, new Intl.DateTimeFormat('en-US', {
      timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit',
      ...(h24 || tz === 'UTC' ? { hourCycle: 'h23' } : { hour: 'numeric', hour12: true }),
    }));
  }
  return timeFmt.get(key).format(new Date(sec * 1000));
}

export const bars = () => uPlot.paths.bars({ size: [0.7, 12], align: 0 });
