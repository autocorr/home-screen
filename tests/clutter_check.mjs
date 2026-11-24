// Checks the radar clutter correction in site/js/map/iem.js and the generated
// clutter map (scripts/build_clutter.py). No network:   node tests/clutter_check.mjs
import { readFileSync } from 'node:fs';

const { declutter } = await import('../site/js/map/iem.js');
const { CLUTTER } = await import('../site/js/data/clutter.js');
const { PRECIP_MAP } = await import('../site/js/config.js');

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failed++;
};
const idx = (dbz) => Math.round((dbz + 32.5) * 2);
const dbz = (i) => 0.5 * i - 32.5;

check('no clutter: value unchanged', declutter(idx(12), 0, 0) === idx(12));
check('at the clutter limit: hidden', declutter(idx(20), idx(20), idx(12)) === 0);
check('below the clutter limit: hidden', declutter(idx(8), idx(20), idx(12)) === 0);
// 30 dBZ over 20 dBZ clutter: 10 log10(1000 - 100) = 29.54 dBZ
check('above the limit: clutter removed in linear Z', declutter(idx(30), idx(25), idx(20)) === idx(29.5), `${dbz(declutter(idx(30), idx(25), idx(20)))} dBZ`);
// Strong echo: clutter makes no visible difference.
check('strong echo kept', declutter(idx(45), idx(25), idx(20)) === idx(45));
// Equal powers: 3 dB above the clutter level leaves the clutter level.
check('twice the clutter power leaves the clutter level', declutter(idx(23), idx(22), idx(20)) === idx(20), `${dbz(declutter(idx(23), idx(22), idx(20)))} dBZ`);
check('level without limit: no clutter (limit 0 never hides)', declutter(1, 0, 0) === 1);

// The generated map covers the configured cut-out and is a real PNG of the stated size.
const png = readFileSync(new URL(`../site/${CLUTTER.url}`, import.meta.url));
check('clutter map is a PNG', png.subarray(1, 4).toString() === 'PNG');
check('clutter map size matches metadata', png.readUInt32BE(16) === CLUTTER.width && png.readUInt32BE(20) === CLUTTER.height,
  `${png.readUInt32BE(16)} x ${png.readUInt32BE(20)}`);
const lonToPx = (lon) => ((lon + 180) / 360) * 256 * 2 ** CLUTTER.z;
const latToPx = (lat) => { const s = Math.sin((lat * Math.PI) / 180); return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 256 * 2 ** CLUTTER.z; };
const [w, s, e, n] = PRECIP_MAP.bounds;
check('clutter map covers the cut-out',
  CLUTTER.x0 <= lonToPx(w) && CLUTTER.y0 <= latToPx(n) && CLUTTER.x0 + CLUTTER.width >= lonToPx(e) && CLUTTER.y0 + CLUTTER.height >= latToPx(s));

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall passed');
