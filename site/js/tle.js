// Orbital elements (GP / OMM data) from CelesTrak, cached in localStorage.
//
// CelesTrak's usage policy (https://celestrak.org/usage-policy.php):
// - GP data is updated every 2 hours; download it at most once per update. We refresh
//   after `SATS.refreshH` (6) hours, and an attempt is shared by every open tab.
// - Use FORMAT=csv: legacy FORMAT=tle is no longer served for all objects (6-digit
//   catalog numbers have no TLE) and JSON is ~3x larger.
// - Software must stop querying on any non-200 response and report it to a human.
//   So: a 5xx answer pauses downloads for `SATS.retryMin` (30, policy minimum 15)
//   minutes; any other non-200 answer (403 block, 404, a redirect) stops automatic
//   downloads entirely until someone presses Retry in the status line. A network
//   failure (no answer at all) is retried after `SATS.retryMin` minutes.
// Compression is requested by the browser automatically (gzip/brotli).
import { SATS } from './config.js';

const KEY = 'sats:gp:v3';
const GP = 'https://celestrak.org/NORAD/elements/gp.php';
// OMM fields kept per object: what satellite.js's json2satrec needs.
const FIELDS = ['OBJECT_NAME', 'NORAD_CAT_ID', 'EPOCH', 'MEAN_MOTION', 'ECCENTRICITY', 'INCLINATION',
  'RA_OF_ASC_NODE', 'ARG_OF_PERICENTER', 'MEAN_ANOMALY', 'BSTAR', 'MEAN_MOTION_DOT', 'MEAN_MOTION_DDOT'];

const load = () => { try { return JSON.parse(localStorage.getItem(KEY)); } catch { return null; } };
const save = (c) => { try { localStorage.setItem(KEY, JSON.stringify(c)); } catch { /* ignore */ } };
try { ['sats:tle:v1', 'sats:tle:v2'].forEach((k) => localStorage.removeItem(k)); } catch { /* ignore */ }

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

const wanted = () => `${SATS.group}|${SATS.extra.join(',')}`;

/** Cached elements, or null.
 *  { fetched, tried, error, halted, wanted, sats: {catnr: {name, omm}} }
 *  `halted` = { status, message, at }: CelesTrak refused; no automatic requests. */
export const cachedTLE = () => load();

/** Whether to download now: stale or the configured set changed, and allowed to try. */
export function tleNeedsRefresh(c = load(), now = Date.now()) {
  if (c?.halted) return false;
  if (c?.tried && now - c.tried < Math.max(15, SATS.retryMin) * 60e3) return false;
  if (!c?.sats || !Object.keys(c.sats).length) return true;
  return now - (c.fetched || 0) > SATS.refreshH * 3600e3 || c.wanted !== wanted();
}

/**
 * Download the group and the extras. Resolves to the updated cache; on failure the
 * previous elements are kept and `error` (and, for refusals, `halted`) is set.
 */
export async function refreshTLE() {
  const c = load() || { sats: {} };
  if (c.halted) return c;
  c.tried = Date.now();
  save(c);  // marks the attempt so other tabs don't start their own
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
    Object.assign(c, { sats: got, wanted: wanted(), fetched: Date.now(), tried: null, error: null });
  } catch (e) {
    if (got && Object.keys(got).length >= 10) {
      // The group arrived; keep it even though a later request was refused.
      Object.assign(c, { sats: { ...c.sats, ...got }, wanted: wanted(), fetched: Date.now() });
    }
    c.error = e.message;
    if (e instanceof HttpError && e.status < 500) {
      c.halted = { status: e.status, message: e.message, url: e.url, at: Date.now() };
    }
  }
  save(c);
  return c;
}

/** After a human has looked at the refusal: allow one new attempt. */
export function clearTLEHalt() {
  const c = load();
  if (!c) return;
  delete c.halted;
  c.tried = null;
  save(c);
}
