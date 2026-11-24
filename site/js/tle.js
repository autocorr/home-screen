// Orbital elements (GP / OMM data) from CelesTrak.
//
// Downloads happen only when someone presses Update in the satellites section; opening
// the page sends nothing and shows whatever elements this browser already holds.
//
// Storage follows the shared choice in storage.js (the same one as the map and radar):
//   - elements: on disk, one entry in Cache Storage (CACHES.sats); memory only, just
//     this tab's memory, so a reload starts without elements.
//   - bookkeeping (when the last download and attempt were, CelesTrak's refusal):
//     always in localStorage (META_KEY), so the usage policy holds across reloads and
//     tabs whatever the storage choice.
//
// CelesTrak's usage policy (https://celestrak.org/usage-policy.php):
// - GP data is updated every 2 hours; download it at most once per update. Update is
//   refused for `SATS.minUpdateH` (12) hours after a successful download while the
//   elements are still held, and for POLICY_H (2) hours when they are not (memory-only
//   storage after a reload, or a cleared cache). An attempt is shared by every open tab.
// - Use FORMAT=csv: legacy FORMAT=tle is no longer served for all objects (6-digit
//   catalog numbers have no TLE) and JSON is ~3x larger.
// - Software must stop querying on any non-200 response and report it to a human.
//   So: after a 5xx answer or a network failure (no answer at all), Update is refused
//   for `SATS.retryMin` (30, policy minimum 15) minutes; any other non-200 answer (403
//   block, 404, a redirect) is shown with CelesTrak's explanation, and only an explicit
//   Retry (clearTLEHalt) allows another attempt.
// Compression is requested by the browser automatically (gzip/brotli).
import { SATS } from './config.js';
import { CACHES, getStoragePref, useDisk, onStoragePref, putCached, getCached } from './storage.js';

export const META_KEY = 'sats:gp:v4';
const OLD_KEY = 'sats:gp:v3';           // bookkeeping and elements together, in localStorage
const ELEMENTS = new URL('sats/gp.json', globalThis.location?.href ?? 'https://localhost/').href;  // Cache Storage key
const POLICY_H = 2;                     // CelesTrak updates GP data every 2 h
const GP = 'https://celestrak.org/NORAD/elements/gp.php';
// OMM fields kept per object: what satellite.js's json2satrec needs.
const FIELDS = ['OBJECT_NAME', 'NORAD_CAT_ID', 'EPOCH', 'MEAN_MOTION', 'ECCENTRICITY', 'INCLINATION',
  'RA_OF_ASC_NODE', 'ARG_OF_PERICENTER', 'MEAN_ANOMALY', 'BSTAR', 'MEAN_MOTION_DOT', 'MEAN_MOTION_DDOT'];

const loadMeta = () => { try { return JSON.parse(localStorage.getItem(META_KEY)); } catch { return null; } };
const saveMeta = ({ fetched = null, tried = null, error = null, halted = null }) => {
  try { localStorage.setItem(META_KEY, JSON.stringify({ fetched, tried, error, halted })); } catch { /* ignore */ }
};

let held = null;   // { fetched, sats }: the elements this tab uses (downloaded here, or read from disk)

async function readDisk() {
  if (!useDisk()) return null;
  try { return (await (await getCached(CACHES.sats, ELEMENTS))?.json()) ?? null; } catch { return null; }
}
async function writeDisk(e) {
  if (!useDisk() || !e) return;
  if ((await readDisk())?.fetched >= e.fetched) return;   // another tab stored newer ones
  try { await putCached(CACHES.sats, ELEMENTS, JSON.stringify(e)); } catch { /* ignore */ }
}
const dropOld = () => { try { localStorage.removeItem(OLD_KEY); } catch { /* ignore */ } };

// Elements kept in localStorage by earlier versions: moved to disk once storage is
// allowed, dropped once it is declined; until the choice is made they are used from memory.
try {
  ['sats:tle:v1', 'sats:tle:v2'].forEach((k) => localStorage.removeItem(k));
  const old = JSON.parse(localStorage.getItem(OLD_KEY));
  if (old && !loadMeta()) saveMeta(old);
  if (old?.sats && Object.keys(old.sats).length) held = { fetched: old.fetched, sats: old.sats };
  else if (old) dropOld();
} catch { /* ignore */ }
const settleOld = (pref) => {
  if (pref === 'disk') writeDisk(held).then(dropOld);
  else if (pref === 'memory') dropOld();
};
settleOld(getStoragePref());
// Storage allowed later (here or in another tab): keep what this tab holds.
onStoragePref(settleOld);

/** Split CSV text into rows of fields (handles quoted fields). */
function csvRows(text) {
  const rows = [];
  let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { f += '"'; i++; } else if (c === '"') q = false;
      else f += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(f); f = '';
      if (row.some((x) => x !== '')) rows.push(row);
      row = [];
    } else f += c;
  }
  row.push(f);
  if (row.some((x) => x !== '')) rows.push(row);
  return rows;
}

/** Parse CelesTrak FORMAT=csv (OMM) into { [catnr]: { name, omm } }. */
export function parseOMMcsv(text) {
  const [head, ...rows] = csvRows(text);
  if (!head) return {};
  const col = Object.fromEntries(head.map((h, i) => [h.trim(), i]));
  if (FIELDS.some((f) => !(f in col))) return {};
  const out = {};
  for (const r of rows) {
    const omm = Object.fromEntries(FIELDS.map((f) => [f, (r[col[f]] ?? '').trim()]));
    const id = Number(omm.NORAD_CAT_ID);
    const numeric = FIELDS.filter((f) => f !== 'OBJECT_NAME' && f !== 'EPOCH');
    if (!Number.isInteger(id) || numeric.some((f) => omm[f] === '' || !Number.isFinite(Number(omm[f])))) continue;
    if (Number.isNaN(Date.parse(`${omm.EPOCH.replace(/Z$/, '')}Z`))) continue;
    out[id] = { name: omm.OBJECT_NAME, omm };
  }
  return out;
}

/** Element set epoch as a Date. */
export const ommEpoch = (omm) => new Date(`${omm.EPOCH.replace(/Z$/, '')}Z`);

class HttpError extends Error {
  constructor(status, url, detail) {
    super(`HTTP ${status}${detail ? `: ${detail}` : ''}`);
    this.status = status;
    this.url = url;
  }
}
/** Readable text of an error page (CelesTrak's 403 page explains the cause and the fix). */
const pageText = (s) => s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/\s+/g, ' ').trim().slice(0, 400);

async function getText(url) {
  const r = await fetch(url);  // a network failure throws a TypeError: no answer from the server
  const text = await r.text();
  if (r.status !== 200) throw new HttpError(r.status, url, pageText(text));
  if (r.redirected) {
    // The policy treats a redirect (301) as a sign the URL must be updated: use the
    // data this time, but stop automatic downloads until the code is fixed.
    const e = new HttpError(301, url, `redirected to ${r.url}; update the URL in site/js/tle.js`);
    e.body = text;
    throw e;
  }
  return text;
}

/**
 * The bookkeeping and the elements this tab can use:
 *  { fetched, downloaded, tried, error, halted, sats: {catnr: {name, omm}} }
 *  `fetched` = when the elements in `sats` were downloaded (null if there are none);
 *  `downloaded` = the last successful download in any tab. `halted` = { status, message,
 *  at }: CelesTrak refused; nothing is sent until Retry.
 */
export async function cachedTLE() {
  const m = loadMeta() || {};
  if (m.fetched && !(held?.fetched >= m.fetched)) {
    // Newer elements than this tab has (another tab, or an earlier page load): on disk, if anywhere.
    const d = await readDisk();
    if (d?.sats && !(held?.fetched >= d.fetched)) held = d;
  }
  return {
    tried: null, error: null, halted: null, ...m,
    downloaded: m.fetched ?? null, fetched: held?.fetched ?? null, sats: held?.sats ?? {},
  };
}

/**
 * Why Update may not download now (given cachedTLE()), or null if it may:
 *  { reason: 'halted' } | { reason: 'recent', until: ms, hours } | { reason: 'retry', until: ms }
 *  'recent' = elements downloaded less than `hours` ago (SATS.minUpdateH if this tab has
 *  them, else POLICY_H); 'retry' = a failed (or in-progress, in another tab) attempt
 *  less than SATS.retryMin ago.
 */
export function updateBlocked(c, now = Date.now()) {
  if (c?.halted) return { reason: 'halted' };
  const retry = c?.tried ? c.tried + Math.max(15, SATS.retryMin) * 60e3 : 0;
  if (now < retry) return { reason: 'retry', until: retry };
  const last = c?.downloaded ?? c?.fetched;
  const hours = c?.sats && Object.keys(c.sats).length ? Math.max(POLICY_H, SATS.minUpdateH) : POLICY_H;
  const recent = last ? last + hours * 3600e3 : 0;
  if (now < recent) return { reason: 'recent', until: recent, hours };
  return null;
}

/**
 * Download the group and the extras, unless updateBlocked(). Resolves to the updated
 * cachedTLE(); on failure the previous elements are kept and `error` (and, for refusals,
 * `halted`) is set.
 */
export async function refreshTLE() {
  const c = await cachedTLE();
  if (updateBlocked(c)) return c;
  const m = loadMeta() || {};
  m.tried = Date.now();
  saveMeta(m);  // marks the attempt so other tabs don't start their own
  let got = null;
  try {
    const url = `${GP}?GROUP=${encodeURIComponent(SATS.group)}&FORMAT=csv`;
    let text;
    try { text = await getText(url); } catch (e) {
      if (e.status !== 301 || !e.body) throw e;
      got = parseOMMcsv(e.body);
      throw e;
    }
    got = parseOMMcsv(text);
    if (Object.keys(got).length < 10) {
      got = null;
      throw new HttpError(200, url, 'no elements in the response');
    }
    // Stop at the first refusal: no further queries after a non-200 answer.
    for (const id of SATS.extra.filter((x) => !got[x])) {
      Object.assign(got, parseOMMcsv(await getText(`${GP}?CATNR=${id}&FORMAT=csv`)));
    }
    held = { fetched: Date.now(), sats: got };
    Object.assign(m, { fetched: held.fetched, tried: null, error: null });
  } catch (e) {
    if (got && Object.keys(got).length >= 10) {
      // The group arrived; keep it even though a later request was refused.
      held = { fetched: Date.now(), sats: { ...held?.sats, ...got } };
      m.fetched = held.fetched;
    }
    m.error = e.message;
    if (e instanceof HttpError && e.status < 500) {
      m.halted = { status: e.status, message: e.message, url: e.url, at: Date.now() };
    }
  }
  await writeDisk(held);  // before the bookkeeping, so other tabs find the new elements
  saveMeta(m);
  return cachedTLE();
}

/** After a human has looked at the refusal: allow one new attempt. */
export function clearTLEHalt() {
  const m = loadMeta();
  if (!m) return;
  delete m.halted;
  m.tried = null;
  saveMeta(m);
}
