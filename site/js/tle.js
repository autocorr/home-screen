// Orbital elements (TLEs) from CelesTrak, cached in localStorage.
//
// CelesTrak updates GP data a few times a day and asks clients not to
// re-download unchanged data more than once every two hours. One group query
// (`SATS.group`: the ~150 "visual" brightest objects, ~26 kB) brings every
// satellite in that group; `SATS.extra` ids are fetched by catalog number.
// A cached set is refreshed after `SATS.refreshH` hours; a failed attempt is
// not retried for `SATS.retryMin` minutes, and the old elements keep working.
import { SATS } from './config.js';

const KEY = 'sats:tle:v2';
const GP = 'https://celestrak.org/NORAD/elements/gp.php';

const load = () => { try { return JSON.parse(localStorage.getItem(KEY)); } catch { return null; } };
const save = (c) => { try { localStorage.setItem(KEY, JSON.stringify(c)); } catch { /* ignore */ } };
try { localStorage.removeItem('sats:tle:v1'); } catch { /* ignore */ }

/** Parse 3-line TLE text into { [catnr]: { name, l1, l2 } }. */
export function parseTLE(text) {
  const out = {};
  const lines = text.split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean);
  for (let i = 0; i + 2 < lines.length; i++) {
    const [n, a, b] = [lines[i], lines[i + 1], lines[i + 2]];
    if (a?.startsWith('1 ') && b?.startsWith('2 ') && a.length >= 69 && b.length >= 69 && checksumOK(a) && checksumOK(b)) {
      out[Number(a.slice(2, 7))] = { name: n.trim(), l1: a, l2: b };
      i += 2;
    }
  }
  return out;
}

function checksumOK(line) {
  let s = 0;
  for (const ch of line.slice(0, 68)) s += ch === '-' ? 1 : (ch >= '0' && ch <= '9' ? Number(ch) : 0);
  return s % 10 === Number(line[68]);
}

/** TLE epoch as a Date. */
export function tleEpoch(l1) {
  const yy = Number(l1.slice(18, 20)), day = Number(l1.slice(20, 32));
  const year = yy < 57 ? 2000 + yy : 1900 + yy;
  return new Date(Date.UTC(year, 0, 1) + (day - 1) * 86400e3);
}

async function getText(url) {
  const r = await fetch(url);
  const text = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${text.slice(0, 80).trim() || r.statusText}`);
  return text;
}

const wanted = () => `${SATS.group}|${SATS.extra.join(',')}`;

/** Cached elements, or null. { fetched, tried, error, wanted, sats: {catnr: {name,l1,l2}} } */
export const cachedTLE = () => load();

/** Whether to refresh now: stale or the configured set changed, and not tried recently. */
export function tleNeedsRefresh(c = load(), now = Date.now()) {
  if (c?.tried && now - c.tried < SATS.retryMin * 60e3) return false;
  if (!c?.sats) return true;
  return now - (c.fetched || 0) > SATS.refreshH * 3600e3 || c.wanted !== wanted();
}

/**
 * Fetch the group and the extras. Resolves to the updated cache; on failure
 * the previous elements are kept and `error` is set.
 */
export async function refreshTLE() {
  const c = load() || { sats: {} };
  c.tried = Date.now();
  save(c);  // marks the attempt so other tabs don't start their own
  try {
    const got = parseTLE(await getText(`${GP}?GROUP=${encodeURIComponent(SATS.group)}&FORMAT=tle`));
    if (Object.keys(got).length < 10) throw new Error('no elements in response');
    for (const id of SATS.extra.filter((x) => !got[x])) {
      try { Object.assign(got, parseTLE(await getText(`${GP}?CATNR=${id}&FORMAT=tle`))); }
      catch (e) { console.warn(`TLE ${id}:`, e.message); }
    }
    Object.assign(c, { sats: got, wanted: wanted(), fetched: Date.now(), tried: null, error: null });
  } catch (e) {
    c.error = e.message;
  }
  save(c);
  return c;
}
