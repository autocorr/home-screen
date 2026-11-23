// Units and constants for the calculator, modelled on astropy.units / astropy.constants
// (astropy 8, CODATA 2022, IAU 2015). Units are kept as written (km / h stays km / h)
// and only converted on request, as astropy does. No DOM; also used by tests in Node.

// Base dimensions. Like astropy, radians and bits are bases of their own.
export const BASES = ['m', 'kg', 's', 'A', 'K', 'mol', 'cd', 'rad', 'bit'];
const NB = BASES.length;

/** Dimension vector from 'kg m2 s-2' style text. */
function D(spec = '') {
  const d = new Array(NB).fill(0);
  for (const tok of spec.split(' ').filter(Boolean)) {
    const [, b, p] = /^([A-Za-z]+)(-?\d+)?$/.exec(tok);
    d[BASES.indexOf(b)] += p ? Number(p) : 1;
  }
  return d;
}
const dimKey = (d) => d.map((x) => +x.toFixed(9)).join(',');

// ---- unit definitions ----------------------------------------------------------------

export class UnitDef {
  constructor(name, scale, dims, long, opts = {}) {
    this.name = name;            // display name (astropy's canonical name)
    this.scale = scale;          // in SI bases
    this.dims = dims;
    this.long = long;            // long name for help
    this.aliases = [name];
    this.prefix = opts.prefix || false;  // 'si', 'bin' (SI + binary), or false
    this.offset = opts.offset || 0;      // temperatures: K = scale * x + offset
    this.group = opts.group || '';
  }
}

const REG = new Map();   // alias -> UnitDef
const DEFS = [];         // canonical defs, in definition order (for %units)

function def(aliases, scale, dims, long, opts = {}) {
  const names = aliases.split(' ');
  const d = new UnitDef(names[0], scale, typeof dims === 'string' ? D(dims) : dims, long, opts);
  d.aliases = names;
  for (const n of names) REG.set(n, d);
  DEFS.push(d);
  return d;
}

export const SI_PREFIXES = [
  ['Q', 1e30, 'quetta'], ['R', 1e27, 'ronna'], ['Y', 1e24, 'yotta'], ['Z', 1e21, 'zetta'],
  ['E', 1e18, 'exa'], ['P', 1e15, 'peta'], ['T', 1e12, 'tera'], ['G', 1e9, 'giga'],
  ['M', 1e6, 'mega'], ['k', 1e3, 'kilo'], ['h', 1e2, 'hecto'], ['da', 1e1, 'deka'],
  ['d', 1e-1, 'deci'], ['c', 1e-2, 'centi'], ['m', 1e-3, 'milli'], ['u', 1e-6, 'micro'],
  ['n', 1e-9, 'nano'], ['p', 1e-12, 'pico'], ['f', 1e-15, 'femto'], ['a', 1e-18, 'atto'],
  ['z', 1e-21, 'zepto'], ['y', 1e-24, 'yocto'], ['r', 1e-27, 'ronto'], ['q', 1e-30, 'quecto'],
];
export const BIN_PREFIXES = [
  ['Ki', 2 ** 10, 'kibi'], ['Mi', 2 ** 20, 'mebi'], ['Gi', 2 ** 30, 'gibi'], ['Ti', 2 ** 40, 'tebi'],
  ['Pi', 2 ** 50, 'pebi'], ['Ei', 2 ** 60, 'exbi'],
];

const PI = Math.PI;
const P = { prefix: 'si' };
// Physical constants used below (values as in astropy.constants).
const C = 299792458, H = 6.62607015e-34, E_CHG = 1.602176634e-19, G0 = 9.80665;
const AU = 149597870700, JYEAR = 365.25 * 86400;

// SI
def('m meter', 1, 'm', 'meter', { ...P, group: 'SI' });
def('s second', 1, 's', 'second', { ...P, group: 'SI' });
def('g gram', 1e-3, 'kg', 'gram', { ...P, group: 'SI' });
REG.set('kg', null); // resolved through the prefix "k" + "g" (so it displays as kg)
def('A ampere', 1, 'A', 'ampere', { ...P, group: 'SI' });
def('K Kelvin', 1, 'K', 'Kelvin', { ...P, group: 'SI' });
def('mol mole', 1, 'mol', 'mole', { ...P, group: 'SI' });
def('cd candela', 1, 'cd', 'candela', { ...P, group: 'SI' });
def('rad radian', 1, 'rad', 'radian', { ...P, group: 'SI' });
def('sr steradian', 1, 'rad2', 'steradian', { ...P, group: 'SI' });
def('Hz Hertz hertz', 1, 's-1', 'Hertz', { ...P, group: 'SI' });
def('N Newton newton', 1, 'kg m s-2', 'Newton', { ...P, group: 'SI' });
def('J Joule joule', 1, 'kg m2 s-2', 'Joule', { ...P, group: 'SI' });
def('W Watt watt', 1, 'kg m2 s-3', 'Watt', { ...P, group: 'SI' });
def('Pa Pascal pascal', 1, 'kg m-1 s-2', 'Pascal', { ...P, group: 'SI' });
def('C coulomb', 1, 'A s', 'coulomb', { ...P, group: 'SI' });
def('V Volt volt', 1, 'kg m2 s-3 A-1', 'Volt', { ...P, group: 'SI' });
def('Ohm ohm', 1, 'kg m2 s-3 A-2', 'Ohm', { ...P, group: 'SI' });
def('S Siemens siemens', 1, 'kg-1 m-2 s3 A2', 'Siemens', { ...P, group: 'SI' });
def('F Farad farad', 1, 'kg-1 m-2 s4 A2', 'Farad', { ...P, group: 'SI' });
def('H Henry henry', 1, 'kg m2 s-2 A-2', 'Henry', { ...P, group: 'SI' });
def('T Tesla tesla', 1, 'kg s-2 A-1', 'Tesla', { ...P, group: 'SI' });
def('Wb Weber weber', 1, 'kg m2 s-2 A-1', 'Weber', { ...P, group: 'SI' });
def('lm lumen', 1, 'cd rad2', 'lumen', { ...P, group: 'SI' });
def('lx lux', 1, 'cd rad2 m-2', 'lux', { ...P, group: 'SI' });
def('Bq becquerel', 1, 's-1', 'becquerel', { ...P, group: 'SI' });
def('Gy gray', 1, 'm2 s-2', 'gray', { ...P, group: 'SI' });
def('Ci curie', 3.7e10, 's-1', 'curie', { group: 'SI' });
// Angles
def('deg degree', PI / 180, 'rad', 'degree', { group: 'Angle' });
def('arcmin arcminute', PI / 180 / 60, 'rad', 'arc minute', { group: 'Angle' });
def('arcsec arcsecond', PI / 180 / 3600, 'rad', 'arc second', { group: 'Angle' });
def('mas', PI / 180 / 3600e3, 'rad', 'milli arc second', { group: 'Angle' });
def('uas', PI / 180 / 3600e6, 'rad', 'micro arc second', { group: 'Angle' });
def('hourangle', PI / 12, 'rad', 'hour angle', { group: 'Angle' });
def('cycle', 2 * PI, 'rad', 'cycle', { group: 'Angle' });
// Time
def('min minute', 60, 's', 'minute', { group: 'Time' });
def('h hour hr', 3600, 's', 'hour', { group: 'Time' });
def('d day', 86400, 's', 'day', { group: 'Time' });
def('sday', 86164.09053, 's', 'sidereal day', { group: 'Time' });
def('wk week', 604800, 's', 'week', { group: 'Time' });
def('fortnight', 1209600, 's', 'fortnight', { group: 'Time' });
def('yr year', JYEAR, 's', 'year (Julian)', { ...P, group: 'Time' });
def('a annum', JYEAR, 's', 'annum (Julian year)', { ...P, group: 'Time' });
// Length, area, volume, mass
def('Angstrom AA angstrom', 1e-10, 'm', 'Angstrom', { group: 'Length' });
def('micron', 1e-6, 'm', 'micron', { group: 'Length' });
def('AU au astronomical_unit', AU, 'm', 'astronomical unit', { group: 'Astro' });
def('pc parsec', AU * 648000 / PI, 'm', 'parsec', { ...P, group: 'Astro' });
def('lyr lightyear', C * JYEAR, 'm', 'light year', { group: 'Astro' });
def('solRad R_sun Rsun', 6.957e8, 'm', 'solar radius', { group: 'Astro' });
def('earthRad R_earth', 6378100, 'm', 'Earth radius', { group: 'Astro' });
def('jupiterRad R_jup', 71492000, 'm', 'Jupiter radius', { group: 'Astro' });
def('solMass M_sun Msun', 1.988409870698051e30, 'kg', 'solar mass', { group: 'Astro' });
def('earthMass M_earth', 5.972167867791379e24, 'kg', 'Earth mass', { group: 'Astro' });
def('jupiterMass M_jup', 1.8981245973360505e27, 'kg', 'Jupiter mass', { group: 'Astro' });
def('solLum L_sun Lsun', 3.828e26, 'kg m2 s-3', 'solar luminosity', { group: 'Astro' });
def('Jy Jansky jansky', 1e-26, 'kg s-2', 'Jansky', { ...P, group: 'Astro' });
def('barn', 1e-28, 'm2', 'barn', { ...P, group: 'Other' });
def('ha', 1e4, 'm2', 'hectare', { group: 'Other' });
def('l L liter', 1e-3, 'm3', 'liter', { ...P, group: 'Other' });
def('t tonne', 1000, 'kg', 'metric tonne', { ...P, group: 'Other' });
def('u Da Dalton', 1.66053906892e-27, 'kg', 'unified atomic mass unit', { ...P, group: 'Other' });
def('M_e', 9.1093837139e-31, 'kg', 'electron mass', { group: 'Other' });
def('M_p', 1.67262192595e-27, 'kg', 'proton mass', { group: 'Other' });
// Energy, pressure
def('eV electronvolt', E_CHG, 'kg m2 s-2', 'electron volt', { ...P, group: 'Other' });
def('Ry rydberg', H * C * 10973731.568157, 'kg m2 s-2', 'Rydberg energy', { group: 'Other' });
def('bar', 1e5, 'kg m-1 s-2', 'bar', { ...P, group: 'Other' });
def('atm', 101325, 'kg m-1 s-2', 'standard atmosphere', { group: 'Other' });
def('Torr', 101325 / 760, 'kg m-1 s-2', 'Torr', { group: 'Other' });
// CGS
def('erg', 1e-7, 'kg m2 s-2', 'erg', { group: 'CGS' });
def('dyn dyne', 1e-5, 'kg m s-2', 'dyne', { group: 'CGS' });
def('Ba Barye barye', 0.1, 'kg m-1 s-2', 'Barye', { group: 'CGS' });
def('P poise', 0.1, 'kg m-1 s-1', 'poise', { group: 'CGS' });
def('St stokes', 1e-4, 'm2 s-1', 'stokes', { group: 'CGS' });
def('Gal gal', 0.01, 'm s-2', 'Gal', { group: 'CGS' });
def('G Gauss gauss', 1e-4, 'kg s-2 A-1', 'Gauss', { ...P, group: 'CGS' });
def('D Debye debye', 1e-21 / C, 'A s m', 'Debye', { group: 'CGS' });
def('k Kayser kayser', 100, 'm-1', 'Kayser', { group: 'CGS' });
// Information, dimensionless
def('bit b', 1, 'bit', 'bit', { prefix: 'bin', group: 'Other' });
def('byte B', 8, 'bit', 'byte', { prefix: 'bin', group: 'Other' });
def('percent pct', 0.01, '', 'percent', { group: 'Other' });
// Temperature scales (offsets apply only when converting with ->)
def('deg_C Celsius', 1, 'K', 'degree Celsius', { offset: 273.15, group: 'Temperature' });
def('deg_F Fahrenheit', 5 / 9, 'K', 'degree Fahrenheit', { offset: 459.67 * 5 / 9, group: 'Temperature' });
def('deg_R Rankine', 5 / 9, 'K', 'degree Rankine', { group: 'Temperature' });
// Imperial (astropy keeps these in u.imperial; here they are also on u)
const IN = 0.0254, FT = 0.3048, LB = 0.45359237, LBF = LB * G0;
const GAL = 231 * IN ** 3;
const imp = { group: 'Imperial' };
def('inch', IN, 'm', 'inch', imp);
def('ft foot', FT, 'm', 'foot', imp);
def('yd yard', 0.9144, 'm', 'yard', imp);
def('mi mile', 1609.344, 'm', 'mile', imp);
def('nmi nauticalmile', 1852, 'm', 'nautical mile', imp);
def('mil thou', IN / 1000, 'm', 'thousandth of an inch', imp);
def('fur furlong', 660 * FT, 'm', 'furlong', imp);
def('ac acre', 43560 * FT * FT, 'm2', 'acre', imp);
def('gallon', GAL, 'm3', 'US gallon', imp);
def('quart', GAL / 4, 'm3', 'US quart', imp);
def('pint', GAL / 8, 'm3', 'US pint', imp);
def('cup', GAL / 16, 'm3', 'US cup', imp);
def('foz fluid_oz fluid_ounce', GAL / 128, 'm3', 'US fluid ounce', imp);
def('tbsp tablespoon', GAL / 256, 'm3', 'US tablespoon', imp);
def('tsp teaspoon', GAL / 768, 'm3', 'US teaspoon', imp);
def('oz ounce', LB / 16, 'kg', 'ounce', imp);
def('lb lbm pound', LB, 'kg', 'pound', imp);
def('st stone', 14 * LB, 'kg', 'stone', imp);
def('ton', 2000 * LB, 'kg', 'short ton', imp);
def('slug', LBF / FT, 'kg', 'slug', imp);
def('kn kt knot NMPH', 1852 / 3600, 'm s-1', 'knot', imp);
def('mph', 1609.344 / 3600, 'm s-1', 'mile per hour (not in astropy)', imp);
def('lbf', LBF, 'kg m s-2', 'pound force', imp);
def('kip kilopound', 1000 * LBF, 'kg m s-2', 'kilopound', imp);
def('psi', LBF / IN ** 2, 'kg m-1 s-2', 'pound per square inch', imp);
def('cal calorie', 4.184, 'kg m2 s-2', 'thermochemical calorie', imp);
def('kcal Cal Calorie kilocal kilocalorie', 4184, 'kg m2 s-2', 'kilocalorie', imp);
def('BTU btu', 1055.05585262, 'kg m2 s-2', 'British thermal unit', imp);
def('hp horsepower', 550 * FT * LBF, 'kg m2 s-3', 'horsepower', imp);
REG.set('kt', REG.get('kn'));

const IMPERIAL = new Set(DEFS.filter((d) => d.group === 'Imperial' || d.name === 'deg_F' || d.name === 'deg_R').flatMap((d) => d.aliases));

const prefixed = new Map();
/** UnitDef for a name such as 'km', 'GHz' or 'mJy', or null. */
export function lookupUnitDef(name) {
  const direct = REG.get(name);
  if (direct) return direct;
  if (prefixed.has(name)) return prefixed.get(name);
  let found = null;
  for (const [list, kind] of [[BIN_PREFIXES, 'bin'], [SI_PREFIXES, 'si']]) {
    for (const [p, f, long] of list) {
      if (!name.startsWith(p) || name.length === p.length) continue;
      const base = REG.get(name.slice(p.length));
      if (!base || !base.prefix || (kind === 'bin' && base.prefix !== 'bin')) continue;
      // Short prefixes go on short names only: km, mL, MB, kDa — not kmeter.
      const rest = name.slice(p.length);
      if (rest !== base.name && rest.length > 2) continue;
      const d = new UnitDef(p + base.name, f * base.scale, base.dims, long + base.long, {});
      d.aliases = [name];
      d.base = base;
      found = d;
      break;
    }
    if (found) break;
  }
  prefixed.set(name, found);
  return found;
}

// ---- composite units -------------------------------------------------------------------

const gcd = (a, b) => (b ? gcd(b, a % b) : a);
function fmtPow(p) {
  if (Number.isInteger(p)) return p === 1 ? '' : String(p);
  for (let den = 2; den <= 12; den++) {
    const num = p * den;
    if (Math.abs(num - Math.round(num)) < 1e-9) {
      const n = Math.round(num), g = gcd(Math.abs(n), den);
      return `(${n / g}/${den / g})`;
    }
  }
  return `(${p})`;
}

/** Python '%g' style with `sig` significant digits. */
export function fmtG(x, sig = 6) {
  if (!Number.isFinite(x)) return Number.isNaN(x) ? 'nan' : (x > 0 ? 'inf' : '-inf');
  if (x === 0) return '0';
  const e = Math.floor(Math.log10(Math.abs(Number(x.toPrecision(sig)))));
  if (e < -4 || e >= sig) {
    const [m, ex] = x.toExponential(sig - 1).split('e');
    const mm = m.includes('.') ? m.replace(/0+$/, '').replace(/\.$/, '') : m;
    const n = Number(ex);
    return `${mm}e${n < 0 ? '-' : '+'}${String(Math.abs(n)).padStart(2, '0')}`;
  }
  const s = x.toFixed(Math.max(0, sig - 1 - e));
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
}

export class Unit {
  /** parts: [[UnitDef, power], ...]; factor: unnamed scale (as from .si). */
  constructor(parts = [], factor = 1) {
    this.parts = parts.filter(([, p]) => Math.abs(p) > 1e-12);
    this.factor = factor;
  }
  static of(def) { return new Unit([[def, 1]]); }
  get scale() {
    return this.parts.reduce((s, [d, p]) => s * d.scale ** p, this.factor);
  }
  get dims() {
    const out = new Array(NB).fill(0);
    for (const [d, p] of this.parts) d.dims.forEach((x, i) => { out[i] += x * p; });
    return out;
  }
  get isUnscaledDimensionless() { return this.parts.length === 0 && this.factor === 1; }
  get isDimensionless() { return this.dims.every((x) => Math.abs(x) < 1e-12); }
  mul(o, sign = 1) {
    const parts = this.parts.map(([d, p]) => [d, p]);
    for (const [d, p] of o.parts) {
      const hit = parts.find(([e]) => e.name === d.name);
      if (hit) hit[1] += sign * p; else parts.push([d, sign * p]);
    }
    return new Unit(parts, sign > 0 ? this.factor * o.factor : this.factor / o.factor);
  }
  div(o) { return this.mul(o, -1); }
  pow(n) { return new Unit(this.parts.map(([d, p]) => [d, p * n]), this.factor ** n); }
  sameDims(o) { return dimKey(this.dims) === dimKey(o.dims); }
  /** Single temperature unit (power 1, e.g. deg_C) — the case where offsets apply. */
  get temperatureScale() {
    return this.parts.length === 1 && this.parts[0][1] === 1 && this.factor === 1 &&
      dimKey(this.parts[0][0].dims) === dimKey(D('K')) ? this.parts[0][0] : null;
  }
  get physicalType() { return physicalType(this.dims); }
  toString() {
    const ps = [...this.parts].sort((a, b) => b[1] - a[1] || (a[0].name < b[0].name ? -1 : a[0].name > b[0].name ? 1 : 0));
    const pos = ps.filter(([, p]) => p > 0).map(([d, p]) => d.name + fmtPow(p));
    const neg = ps.filter(([, p]) => p < 0).map(([d, p]) => d.name + fmtPow(-p));
    let s = pos.join(' ');
    if (neg.length) s = `${s || '1'} / ${neg.length > 1 ? `(${neg.join(' ')})` : neg[0]}`;
    if (this.factor !== 1) {
      const f = fmtG(this.factor, 10);
      s = !s ? f : pos.length ? `${f} ${s}` : `${f}${s.slice(1)}`;  // '1e+09 / s', not '1e+09 1 / s'
    }
    return s;
  }
  repr() {
    if (!this.parts.length) return this.factor === 1 ? 'Unit(dimensionless)' : `Unit(dimensionless with a scale of ${fmtG(this.factor)})`;
    return `Unit("${this}")`;
  }
}

export const ONE = new Unit();
const def1 = (n) => lookupUnitDef(n);

/** Express a unit in a system's bases: unit = factor * bases. */
export function decomposeUnit(unit, system = 'si') {
  const d = unit.dims;
  let factor = unit.scale;
  const base = system === 'cgs'
    ? ['cm', 'g', 's', 'A', 'K', 'mol', 'cd', 'rad', 'bit']
    : ['m', 'kg', 's', 'A', 'K', 'mol', 'cd', 'rad', 'bit'];
  const parts = [];
  d.forEach((p, i) => {
    if (Math.abs(p) < 1e-12) return;
    const bd = def1(base[i]);
    factor /= bd.scale ** p;
    parts.push([bd, p]);
  });
  return { factor, unit: new Unit(parts) };
}

// ---- physical types and conversion ----------------------------------------------------

const TYPES = [
  ['', 'dimensionless'], ['m', 'length'], ['kg', 'mass'], ['s', 'time'], ['A', 'electrical current'],
  ['K', 'temperature'], ['mol', 'amount of substance'], ['cd', 'luminous intensity'], ['rad', 'angle'],
  ['bit', 'data quantity'], ['rad2', 'solid angle'], ['m2', 'area'], ['m3', 'volume'],
  ['m s-1', 'speed/velocity'], ['m s-2', 'acceleration'], ['s-1', 'frequency'], ['m-1', 'wavenumber'],
  ['kg m s-2', 'force'], ['kg m2 s-2', 'energy/torque/work'], ['kg m2 s-3', 'power/radiant flux'],
  ['kg m-1 s-2', 'energy density/pressure/stress'], ['kg m-3', 'mass density'], ['kg s-2', 'spectral flux density'],
  ['kg s-3', 'energy flux/irradiance'], ['kg m s-1', 'momentum/impulse'], ['kg m2 s-1', 'angular momentum/action'],
  ['A s', 'electrical charge'], ['kg m2 s-3 A-1', 'electrical potential'], ['kg m2 s-3 A-2', 'electrical resistance'],
  ['kg-1 m-2 s3 A2', 'electrical conductance'], ['kg-1 m-2 s4 A2', 'electrical capacitance'],
  ['kg m2 s-2 A-2', 'inductance'], ['kg s-2 A-1', 'magnetic flux density'], ['kg m2 s-2 A-1', 'magnetic flux'],
  ['cd rad2', 'luminous flux'], ['cd rad2 m-2', 'illuminance'], ['rad s-1', 'angular speed'],
  ['kg m-1 s-1', 'dynamic viscosity'], ['m2 s-1', 'kinematic viscosity/diffusivity'], ['m2 s-2', 'specific energy/absorbed dose'],
  ['A s m', 'electrical dipole moment'], ['kg m2 s-2 K-1', 'entropy/heat capacity'], ['m3 kg-1 s-2', 'gravitational parameter (G)'],
  ['m3 s-2', 'gravitational parameter (GM)'], ['bit s-1', 'bandwidth'], ['mol-1', 'per amount of substance'],
  ['kg m2 s-2 K-1 mol-1', 'molar heat capacity'], ['kg s-3 K-4', 'Stefan-Boltzmann constant'],
];
const TYPE_MAP = new Map(TYPES.map(([s, n]) => [dimKey(D(s)), n]));
export function physicalType(dims) { return TYPE_MAP.get(dimKey(dims)) ?? 'unknown'; }

export class UnitConversionError extends Error {}

// Temperature scales through Celsius, with the textbook formulas so that round values
// stay round (100 deg_C -> 212 deg_F exactly).
function toCelsius(d) {
  if (d.name === 'deg_C') return (x) => x;
  if (d.name === 'deg_F') return (x) => (x - 32) / 1.8;
  if (d.name === 'deg_R') return (x) => x / 1.8 - 273.15;
  return (x) => x * d.scale - 273.15;
}
function fromCelsius(d) {
  if (d.name === 'deg_C') return (c) => c;
  if (d.name === 'deg_F') return (c) => c * 1.8 + 32;
  if (d.name === 'deg_R') return (c) => (c + 273.15) * 1.8;
  return (c) => (c + 273.15) / d.scale;
}

// Spectral equivalence (astropy u.spectral()), applied automatically by ->.
const SPECTRAL = {
  [dimKey(D('m'))]: { toHz: (x) => C / x, fromHz: (f) => C / f },
  [dimKey(D('s-1'))]: { toHz: (x) => x, fromHz: (f) => f },
  [dimKey(D('kg m2 s-2'))]: { toHz: (x) => x / H, fromHz: (f) => f * H },
  [dimKey(D('m-1'))]: { toHz: (x) => x * C, fromHz: (f) => f / C },
};

/**
 * A function mapping values in `from` to values in `to`, or throws UnitConversionError.
 * `equiv` allows temperature offsets and the spectral equivalency.
 */
export function converter(from, to, equiv = false) {
  if (from.sameDims(to)) {
    const tf = from.temperatureScale, tt = to.temperatureScale;
    if (equiv && tf && tt && (tf.offset || tt.offset)) {
      const a = toCelsius(tf), b = fromCelsius(tt);
      return (x) => b(a(x));
    }
    const k = from.scale / to.scale;
    return k === 1 ? (x) => x : (x) => x * k;
  }
  if (equiv) {
    const a = SPECTRAL[dimKey(from.dims)], b = SPECTRAL[dimKey(to.dims)];
    if (a && b) {
      const sf = from.scale, st = to.scale;
      return (x) => b.fromHz(a.toHz(x * sf)) / st;
    }
  }
  const name = (u) => (u.isUnscaledDimensionless ? '' : `'${u}'`);
  const fn = name(from), tn = name(to);
  throw new UnitConversionError(fn && tn
    ? `${fn} (${from.physicalType}) and ${tn} (${to.physicalType}) are not convertible`
    : `${fn || tn} (${(fn ? from : to).physicalType}) and dimensionless are not convertible`);
}

// ---- constants -------------------------------------------------------------------------

// name: [value, uncertainty, unit, long name, reference]
const CODATA = 'CODATA 2022', IAU = 'IAU 2015 Resolution B 3';
export const CONSTANTS = {
  G: [6.6743e-11, 1.5e-15, 'm3 / (kg s2)', 'Gravitational constant', CODATA],
  N_A: [6.02214076e23, 0, '1 / mol', "Avogadro's number", CODATA],
  R: [8.31446261815324, 0, 'J / (K mol)', 'Gas constant', CODATA],
  Ryd: [10973731.568157, 1.2e-5, '1 / m', 'Rydberg constant', CODATA],
  a0: [5.29177210544e-11, 8.2e-21, 'm', 'Bohr radius', CODATA],
  alpha: [0.0072973525643, 1.1e-12, '', 'Fine-structure constant', CODATA],
  atm: [101325, 0, 'Pa', 'Standard atmosphere', CODATA],
  b_wien: [0.0028977719551851727, 0, 'K m', 'Wien wavelength displacement law constant', CODATA],
  c: [299792458, 0, 'm / s', 'Speed of light in vacuum', CODATA],
  e: [1.602176634e-19, 0, 'C', 'Electron charge', CODATA],
  eps0: [8.8541878188e-12, 1.4e-21, 'F / m', 'Vacuum electric permittivity', CODATA],
  g0: [9.80665, 0, 'm / s2', 'Standard acceleration of gravity', CODATA],
  h: [6.62607015e-34, 0, 'J s', 'Planck constant', CODATA],
  hbar: [1.0545718176461565e-34, 0, 'J s', 'Reduced Planck constant', CODATA],
  k_B: [1.380649e-23, 0, 'J / K', 'Boltzmann constant', CODATA],
  m_e: [9.1093837139e-31, 2.8e-40, 'kg', 'Electron mass', CODATA],
  m_n: [1.67492750056e-27, 8.5e-37, 'kg', 'Neutron mass', CODATA],
  m_p: [1.67262192595e-27, 5.2e-37, 'kg', 'Proton mass', CODATA],
  mu0: [1.25663706127e-6, 2e-16, 'N / A2', 'Vacuum magnetic permeability', CODATA],
  muB: [9.2740100657e-24, 2.9e-33, 'J / T', 'Bohr magneton', CODATA],
  sigma_T: [6.6524587051e-29, 6.2e-38, 'm2', 'Thomson scattering cross-section', CODATA],
  sigma_sb: [5.6703744191844314e-8, 0, 'W / (m2 K4)', 'Stefan-Boltzmann constant', CODATA],
  u: [1.66053906892e-27, 5.2e-37, 'kg', 'Atomic mass', CODATA],
  GM_earth: [3.986004e14, 0, 'm3 / s2', 'Nominal Earth mass parameter', IAU],
  GM_jup: [1.2668653e17, 0, 'm3 / s2', 'Nominal Jupiter mass parameter', IAU],
  GM_sun: [1.3271244e20, 0, 'm3 / s2', 'Nominal solar mass parameter', IAU],
  L_bol0: [3.0128e28, 0, 'W', 'Luminosity for absolute bolometric magnitude 0', 'IAU 2015 Resolution B 2'],
  L_sun: [3.828e26, 0, 'W', 'Nominal solar luminosity', IAU],
  M_earth: [5.972167867791379e24, 1.3422009501651213e20, 'kg', 'Earth mass', `${IAU} + ${CODATA}`],
  M_jup: [1.8981245973360505e27, 4.26589589320839e22, 'kg', 'Jupiter mass', `${IAU} + ${CODATA}`],
  M_sun: [1.988409870698051e30, 4.468805426856864e25, 'kg', 'Solar mass', `${IAU} + ${CODATA}`],
  R_earth: [6378100, 0, 'm', 'Nominal Earth equatorial radius', IAU],
  R_jup: [71492000, 0, 'm', 'Nominal Jupiter equatorial radius', IAU],
  R_sun: [695700000, 0, 'm', 'Nominal solar radius', IAU],
  au: [149597870700, 0, 'm', 'Astronomical Unit', 'IAU 2012 Resolution B2'],
  kpc: [3.0856775814913675e19, 0, 'm', 'Kiloparsec', 'Derived from au + IAU 2015 Resolution B 2 note [4]'],
  pc: [3.085677581491367e16, 0, 'm', 'Parsec', 'Derived from au + IAU 2015 Resolution B 2 note [4]'],
};

/** Parse a unit string like 'm3 / (kg s2)' or 'J s' (only what CONSTANTS uses). */
export function parseUnitString(s) {
  let u = ONE;
  const [num, den = ''] = s.split(' / ');
  const add = (txt, sign) => {
    for (const tok of txt.replace(/[()]/g, '').split(' ').filter(Boolean)) {
      if (tok === '1') continue;
      const [, n, p] = /^([A-Za-z_]+?)(\d*)$/.exec(tok);
      u = u.mul(Unit.of(lookupUnitDef(n)).pow(p ? Number(p) : 1), sign);
    }
  };
  add(num, 1); add(den, -1);
  return u;
}

/** All canonical unit definitions, for listings. */
export const unitDefs = () => DEFS;
export const isImperial = (name) => IMPERIAL.has(name);
/** Names usable after `u.` (without prefixes), for completion. */
export function unitNames() {
  const names = [...REG.keys()].filter((k) => REG.get(k));
  names.push('kg', 'km', 'cm', 'mm', 'um', 'nm', 'kpc', 'Mpc', 'Gpc', 'kyr', 'Myr', 'Gyr', 'ms', 'us', 'ns',
    'kHz', 'MHz', 'GHz', 'THz', 'mJy', 'uJy', 'keV', 'MeV', 'GeV', 'TeV', 'kJ', 'kW', 'MW', 'GW', 'hPa', 'kPa', 'mbar',
    'mL', 'mg', 'kN', 'mK', 'mT', 'uG', 'mrad', 'kB', 'MB', 'GB', 'TB', 'KiB', 'MiB', 'GiB', 'TiB', 'kt');
  return [...new Set(names)].sort();
}
