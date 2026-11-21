// Dump positions computed by site/js/astro.js (the same code the site runs)
// as JSON, for comparison against astropy in check_astro.py.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
globalThis.Astronomy = require('../site/vendor/astronomy.browser.min.js');
const { VLA, SOURCES } = await import('../site/js/config.js');
const astro = await import('../site/js/astro.js');

const times = JSON.parse(process.argv[2]); // unix seconds
const obs = astro.observer(VLA);
const targets = astro.makeTargets(SOURCES, [
  { name: 'Sun', bodyName: 'Sun' }, { name: 'Moon', bodyName: 'Moon' },
]);
const out = { lst: [], positions: {} };
for (const t of times) out.lst.push(astro.lstHours(new Date(t * 1000), VLA.lon));
for (const tg of targets) {
  out.positions[tg.name] = times.map((t) => {
    const p = astro.position(tg, new Date(t * 1000), obs, VLA.lon);
    return [p.el, p.az];
  });
}
console.log(JSON.stringify(out));
