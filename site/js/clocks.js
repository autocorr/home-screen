// Live clocks: Mountain Time, UTC, LST at the VLA (plus MJD), and world clocks.
import { TZ, VLA, WORLD_CLOCKS } from './config.js';
import { lstHours, formatHMS, mjd } from './astro.js';

const timeFmt = (tz) => new Intl.DateTimeFormat('en-US', {
  timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});
const zoneFmt = (tz) => new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' });
const dateFmt = (tz) => new Intl.DateTimeFormat('en-US', {
  timeZone: tz, weekday: 'short', month: 'short', day: 'numeric',
});
const shortDateFmt = (tz) => {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', day: 'numeric' });
  return { format: (d) => { const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value])); return `${p.weekday} ${p.day}`; } };
};
const isoDate = (tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz });

/** UTC offset of `tz` at `date`, in minutes. */
function offsetMin(tz, date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric',
  }).formatToParts(date).map((x) => [x.type, x.value]));
  const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return Math.round((asUTC - Math.floor(date.getTime() / 60e3) * 60e3) / 60e3);
}

const fmtOffset = (m) => {
  const s = m < 0 ? '−' : '+';
  const a = Math.abs(m);
  return `${s}${Math.floor(a / 60)}${a % 60 ? `:${String(a % 60).padStart(2, '0')}` : ''}h`;
};

const zoneName = (fmt, now) => fmt.formatToParts(now).find((p) => p.type === 'timeZoneName').value;

export function initClocks(root, worldRoot) {
  const $ = (id) => root.querySelector(id);
  const mt = { time: timeFmt(TZ), zone: zoneFmt(TZ), date: dateFmt(TZ) };

  const world = WORLD_CLOCKS.map((c) => ({
    ...c, time: timeFmt(c.tz), zone: zoneFmt(c.tz), date: shortDateFmt(c.tz), iso: isoDate(c.tz),
  }));
  const grid = worldRoot?.querySelector('#world-clocks');
  if (grid) {
    grid.innerHTML = world.map((c, i) =>
      `<div class="clock" title="${c.tz}"><div class="clock-label">${c.label}</div>` +
      `<div class="clock-time" id="w-time-${i}">--:--:--</div>` +
      `<div class="clock-sub" id="w-sub-${i}"></div></div>`).join('');
  }
  const mtIso = isoDate(TZ);

  const tick = () => {
    const now = new Date();
    $('#clk-mt').textContent = mt.time.format(now);
    $('#clk-mt-zone').textContent = zoneName(mt.zone, now);
    $('#clk-mt-date').textContent = mt.date.format(now);
    $('#clk-utc').textContent = now.toISOString().slice(11, 19);
    $('#clk-utc-date').textContent = now.toISOString().slice(0, 10);
    $('#clk-lst').textContent = formatHMS(lstHours(now, VLA.lon));
    $('#clk-mjd').textContent = `MJD ${mjd(now).toFixed(4)}`;
    if (grid) {
      const mtOff = offsetMin(TZ, now);
      const mtDay = mtIso.format(now);
      world.forEach((c, i) => {
        const day = c.iso.format(now);
        const rel = day > mtDay ? 'tomorrow' : day < mtDay ? 'yesterday' : 'today';
        grid.querySelector(`#w-time-${i}`).textContent = c.time.format(now);
        const sub = grid.querySelector(`#w-sub-${i}`);
        sub.textContent = `${c.date.format(now)} · ${fmtOffset(offsetMin(c.tz, now) - mtOff)}`;
        sub.title = `${zoneName(c.zone, now)}; ${rel} relative to Mountain Time`;
      });
    }
    setTimeout(tick, 1000 - (Date.now() % 1000) + 5); // stay aligned to the second
  };
  tick();
}
