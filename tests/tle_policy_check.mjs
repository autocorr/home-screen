// Checks that site/js/tle.js follows CelesTrak's usage policy, with fetch and
// localStorage stubbed (no network):   node tests/tle_policy_check.mjs
// https://celestrak.org/usage-policy.php: CSV format, at most one download per 2 h
// update, stop on any non-200 answer, wait at least 15 min after a 5xx.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
const calls = [];
let answer = () => ({ status: 200, body: CSV });
globalThis.fetch = async (url) => {
  calls.push(url);
  const a = answer(url);
  if (a.network) throw new TypeError('Failed to fetch');
  return { status: a.status, ok: a.status >= 200 && a.status < 300, redirected: !!a.redirected, url: a.redirected || url, text: async () => a.body ?? '' };
};

const HEAD = 'OBJECT_NAME,OBJECT_ID,EPOCH,MEAN_MOTION,ECCENTRICITY,INCLINATION,RA_OF_ASC_NODE,ARG_OF_PERICENTER,MEAN_ANOMALY,EPHEMERIS_TYPE,CLASSIFICATION_TYPE,NORAD_CAT_ID,ELEMENT_SET_NO,REV_AT_EPOCH,BSTAR,MEAN_MOTION_DOT,MEAN_MOTION_DDOT';
const row = (id, name) => `"${name}",1998-067A,2026-11-20T12:00:00.000000,15.4986,.0005,51.6400,100.0,90.0,270.0,0,U,${id},999,50000,.0002,.0001,0`;
const CSV = [HEAD, row(25544, 'ISS (ZARYA)'), ...Array.from({ length: 12 }, (_, i) => row(40000 + i, `SAT, ${i}`))].join('\r\n') + '\r\n';
const EXTRA_CSV = [HEAD, row(53807, 'BLUEWALKER 3')].join('\n');

const { refreshTLE, tleNeedsRefresh, clearTLEHalt, parseOMMcsv, cachedTLE } = await import('../site/js/tle.js');
const { SATS } = await import('../site/js/config.js');

let fails = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) fails++;
};
const H = 3600e3;
const reset = () => { store.clear(); calls.length = 0; };

// Parsing, and satellite.js accepting the result.
const parsed = parseOMMcsv(CSV);
check('CSV parses (quoted names with commas)', Object.keys(parsed).length === 13 && parsed[40003].name === 'SAT, 3');
const sandbox = { self: {}, window: {} };
vm.runInNewContext(readFileSync(new URL('../site/vendor/satellite.js/satellite.min.js', import.meta.url), 'utf8'), sandbox);
const S = sandbox.satellite ?? sandbox.self.satellite ?? sandbox.window.satellite;
const rec = S.json2satrec(parsed[25544].omm);
// A Date from the sandbox's own realm: satellite.js checks `instanceof Date`.
const pv = S.propagate(rec, vm.runInNewContext('new Date(Date.UTC(2026, 10, 20, 13))', sandbox));
const r = Math.hypot(pv.position.x, pv.position.y, pv.position.z);
check('json2satrec propagates the parsed elements', r > 6600 && r < 6900, `${r.toFixed(0)} km`);

// Normal download: CSV URLs, group then extras.
reset();
answer = (url) => ({ status: 200, body: url.includes('CATNR') ? EXTRA_CSV : CSV });
let c = await refreshTLE();
check('downloads the group and extras as CSV', calls.length === 1 + SATS.extra.length && calls.every((u) => u.includes('FORMAT=csv')), calls.join(' '));
check('stores the elements', Object.keys(c.sats).length === 14 && !c.error && !c.halted);
check('no download within the refresh interval', !tleNeedsRefresh(cachedTLE(), Date.now() + 2 * H));
check('downloads again after it', tleNeedsRefresh(cachedTLE(), Date.now() + SATS.refreshH * H + 1));
check('refresh interval is at least the 2 h update cycle', SATS.refreshH >= 2);

// 403: stop everything until a human clears it.
reset();
answer = () => ({ status: 403, body: '<html><body><h1>Forbidden</h1><p>Your IP has been blocked because...</p></body></html>' });
c = await refreshTLE();
check('403 halts automatic downloads', c.halted?.status === 403 && /blocked because/.test(c.halted.message), c.error);
check('…even days later', !tleNeedsRefresh(cachedTLE(), Date.now() + 72 * H));
calls.length = 0;
await refreshTLE();
check('…and refreshTLE itself sends nothing', calls.length === 0);
clearTLEHalt();
check('Retry clears the halt', tleNeedsRefresh(cachedTLE()));

// 404 on an extra id: keep the group, stop querying.
reset();
answer = (url) => (url.includes('CATNR') ? { status: 404, body: 'Not found' } : { status: 200, body: CSV });
c = await refreshTLE();
check('404 on an extra keeps the group but halts', Object.keys(c.sats).length === 13 && c.halted?.status === 404);

// 503: no halt, but wait at least 15 min (SATS.retryMin).
reset();
answer = () => ({ status: 503, body: 'busy' });
c = await refreshTLE();
check('503 does not halt', !c.halted && /503/.test(c.error));
check('…and waits at least 15 min', !tleNeedsRefresh(cachedTLE(), Date.now() + 14.9 * 60e3) &&
  tleNeedsRefresh(cachedTLE(), Date.now() + Math.max(15, SATS.retryMin) * 60e3 + 1));

// Network failure (no answer): retried later, not halted.
reset();
answer = () => ({ network: true });
c = await refreshTLE();
check('network failure retries later', !c.halted && !tleNeedsRefresh(cachedTLE()) && tleNeedsRefresh(cachedTLE(), Date.now() + 31 * 60e3));

// Redirect: use the data, but stop until the URL is fixed.
reset();
answer = (url) => ({ status: 200, body: CSV, redirected: url.replace('celestrak.org', 'www.celestrak.org') });
c = await refreshTLE();
check('redirect uses the data and halts', Object.keys(c.sats).length >= 13 && c.halted?.status === 301, c.error);

// A 200 with no usable data (format change): halt rather than retry forever.
reset();
answer = () => ({ status: 200, body: 'something else' });
c = await refreshTLE();
check('unusable 200 response halts', !!c.halted, c.error);

console.log(fails ? `${fails} failure(s)` : 'all policy checks passed');
process.exit(fails ? 1 : 0);
