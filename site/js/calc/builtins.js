// Builtin functions for the calculator: Python's math module (applied elementwise to
// arrays, like numpy ufuncs, and unit-aware like astropy), a few Python builtins, and
// numpy-style array helpers. Each has a signature and docstring for `name?` / help().
import {
  NDArray, Quantity, Tuple, Str, Func, err, newArray, isNum, toNum, typeName,
} from './values.js';
import {
  asArray, toFloatValue, unwrap0, broadcast2, mapArray, mapValue, binop, buildArray, simplify, truth,
} from './ops.js';
import { Unit, ONE, converter } from './units.js';

// ---- argument binding --------------------------------------------------------------------

/** 'log(x, base=e)' -> [{name, opt, rest, kwOnly}] */
function parseSig(sig) {
  const inner = sig.slice(sig.indexOf('(') + 1, sig.lastIndexOf(')'));
  let kwOnly = false;
  return inner.split(',').map((s) => s.trim()).filter(Boolean).flatMap((p) => {
    if (p === '*') { kwOnly = true; return []; }
    if (p === '/') return [];
    const rest = p.startsWith('*');
    if (rest) kwOnly = true;
    const name = p.replace(/^\*+/, '').split('=')[0].trim();
    return [{ name, opt: p.includes('=') || rest, rest, kwOnly: kwOnly && !rest }];
  });
}

export function bindArgs(name, params, args, kwargs) {
  const out = new Array(params.length).fill(undefined);
  let ai = 0;
  params.forEach((p, i) => {
    if (p.rest) { out[i] = args.slice(ai); ai = args.length; } else if (!p.kwOnly && ai < args.length) out[i] = args[ai++];
  });
  if (ai < args.length) {
    const max = params.filter((p) => !p.kwOnly && !p.rest).length;
    throw err('TypeError', `${name}() takes ${max === 0 ? 'no' : `at most ${max}`} positional argument${max === 1 ? '' : 's'} (${args.length} given)`);
  }
  for (const [k, v] of Object.entries(kwargs)) {
    const i = params.findIndex((p) => p.name === k && !p.rest);
    if (i < 0) throw err('TypeError', `${name}() got an unexpected keyword argument '${k}'`);
    if (out[i] !== undefined) throw err('TypeError', `${name}() got multiple values for argument '${k}'`);
    out[i] = v;
  }
  params.forEach((p, i) => {
    if (out[i] === undefined && !p.opt) throw err('TypeError', `${name}() missing required argument '${p.name}' (pos ${i + 1})`);
  });
  return out;
}

const REG = new Map();
/** Define a builtin: sig like 'log(x, base=e)', impl receives the bound arguments. */
function F(sig, doc, impl, opts = {}) {
  const name = sig.slice(0, sig.indexOf('('));
  const params = parseSig(sig);
  const fn = new Func(name, sig, doc, (args, kwargs, interp) => impl(...bindArgs(name, params, args, kwargs), interp), { params });
  fn.group = opts.group ?? currentGroup;
  REG.set(name, fn);
  for (const a of opts.aliases ?? []) REG.set(a, fn);
  return fn;
}
let currentGroup = 'math';

// ---- value helpers -----------------------------------------------------------------------

const ANGLE = (u) => { const d = u.dims; return d[7] === 1 && d.every((x, i) => i === 7 || Math.abs(x) < 1e-12); };
const NOT_REAL = (fname, v) => err('TypeError', `${fname}() argument must be a real number or array, not '${typeName(v)}'`);

/** Array-like inputs (tuples) as arrays; leaves numbers, arrays and quantities. */
export function arrayLike(v) {
  if (v instanceof Tuple) return buildArray(v.items);
  return v;
}

/** Plain number/array from v; quantities must be dimensionless (or angles, if allowed). */
function plain(v, fname, { angle = false } = {}) {
  v = arrayLike(v);
  if (v instanceof Quantity) {
    if (v.unit.isDimensionless || (angle && ANGLE(v.unit))) {
      const k = v.unit.scale;
      return mapValue(v.value, (x) => x * k);
    }
    throw err('UnitTypeError', angle
      ? `Can only apply '${fname}' function to quantities with angle units`
      : `Can only apply '${fname}' function to dimensionless quantities`);
  }
  if (isNum(v) || v instanceof NDArray) return v;
  throw NOT_REAL(fname, v);
}

/** Apply f elementwise; scalars get Python's math errors, arrays numpy's nan/inf. */
function apply1(x, f, infErr = 'range') {
  if (x instanceof NDArray) return mapArray(x, f, 'float');
  const xn = toNum(x), r = f(xn);
  if (Number.isNaN(r) && !Number.isNaN(xn)) throw err('ValueError', 'math domain error');
  if (!Number.isFinite(r) && Number.isFinite(xn) && !Number.isNaN(r)) {
    throw infErr === 'domain' ? err('ValueError', 'math domain error') : err('OverflowError', 'math range error');
  }
  return r;
}
function apply2(a, b, f, dtype = 'float') {
  if (a instanceof NDArray || b instanceof NDArray) return unwrap0(broadcast2(asArray(a), asArray(b), f, dtype));
  const r = f(toNum(a), toNum(b));
  if (Number.isNaN(r) && !Number.isNaN(toNum(a)) && !Number.isNaN(toNum(b))) throw err('ValueError', 'math domain error');
  return dtype === 'bool' ? r !== 0 : r;
}
/** Two arguments that must share dimensions: returns [a, b in a's unit, unit|null]. */
function sameUnit(a, b, fname) {
  a = arrayLike(a); b = arrayLike(b);
  if (!(a instanceof Quantity) && !(b instanceof Quantity)) return [plain(a, fname), plain(b, fname), null];
  const qa = a instanceof Quantity ? a : new Quantity(toFloatValue(plain(a, fname)), ONE);
  const qb = b instanceof Quantity ? b : new Quantity(toFloatValue(plain(b, fname)), ONE);
  if (!qa.unit.sameDims(qb.unit)) {
    throw err('UnitConversionError', `Can only apply '${fname}' function to quantities with compatible dimensions`);
  }
  return [qa.value, mapValue(qb.value, converter(qb.unit, qa.unit)), qa.unit];
}
const withUnit = (v, unit) => (unit ? simplify(new Quantity(toFloatValue(v), unit)) : v);

/** Elementwise one-argument function. mode: 'plain' (dimensionless in, plain out),
 *  'trig' (angle or dimensionless in), 'inv' (out in rad for quantity input), 'keep' (keeps unit). */
function U1(sig, doc, f, { mode = 'plain', infErr = 'range', aliases } = {}) {
  const name = sig.slice(0, sig.indexOf('('));
  return F(sig, doc, (x) => {
    x = arrayLike(x);
    if (mode === 'keep' && x instanceof Quantity) return new Quantity(apply1(x.value, f, infErr), x.unit);
    const isQ = x instanceof Quantity;
    const r = apply1(plain(x, name, { angle: mode === 'trig' }), f, infErr);
    return mode === 'inv' && isQ ? new Quantity(r, Unit.of(RAD())) : r;
  }, { aliases });
}
let radDef = null;
const RAD = () => radDef;
export function setRadDef(d) { radDef = d; }

// ---- special functions -------------------------------------------------------------------

const LANCZOS = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
function gamma(x) {
  if (Number.isNaN(x)) return NaN;
  if (x === Infinity) return Infinity;
  if (Number.isInteger(x)) {
    if (x <= 0) return NaN;
    if (x > 171) return Infinity;
    let r = 1;
    for (let i = 2; i < x; i++) r *= i;
    return r;
  }
  if (x < 0.5) return Math.PI / (Math.sin(Math.PI * x) * gamma(1 - x));
  x -= 1;
  let a = LANCZOS[0];
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += LANCZOS[i] / (x + i);
  const h = Math.pow(t, (x + 0.5) / 2);
  return Math.sqrt(2 * Math.PI) * h * Math.exp(-t) * h * a;
}
function lgamma(x) {
  if (Number.isNaN(x)) return NaN;
  if (x === 1 || x === 2) return 0;
  if (Number.isInteger(x) && x <= 0) return Infinity;
  if (x > 0 && x < 170) return Math.log(gamma(x));
  if (x < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - lgamma(1 - x);
  x -= 1;
  let a = LANCZOS[0];
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += LANCZOS[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}
function erfcCF(x) {
  // erfc(x) = exp(-x²)/√π · 1/(x + (1/2)/(x + 1/(x + (3/2)/(x + …)))), modified Lentz.
  const tiny = 1e-300;
  let f = x, C = x, Dd = 0;
  for (let n = 1; n < 5000; n++) {
    const an = n / 2;
    Dd = x + an * Dd; if (Dd === 0) Dd = tiny; Dd = 1 / Dd;
    C = x + an / C; if (C === 0) C = tiny;
    const delta = C * Dd;
    f *= delta;
    if (Math.abs(delta - 1) < 1e-16) break;
  }
  return Math.exp(-x * x) / Math.sqrt(Math.PI) / f;
}
function erf(x) {
  if (Number.isNaN(x)) return NaN;
  const ax = Math.abs(x);
  if (ax < 2.5) {
    // erf(x) = 2/√π · exp(-x²) · Σ 2ⁿ x^(2n+1) / (1·3·…·(2n+1)): all terms positive.
    const x2 = ax * ax;
    let term = ax, sum = ax;
    for (let n = 1; n < 300; n++) {
      term *= (2 * x2) / (2 * n + 1);
      sum += term;
      if (term < sum * 1e-17) break;
    }
    return Math.sign(x) * (2 / Math.sqrt(Math.PI)) * Math.exp(-x2) * sum;
  }
  return Math.sign(x) * (1 - erfcCF(ax));
}
function erfc(x) {
  if (Number.isNaN(x)) return NaN;
  if (x < 0.5) return 1 - erf(x);
  return erfcCF(x);
}
const F64 = new Float64Array(1), I64 = new BigInt64Array(F64.buffer);
function nextafter(x, y) {
  if (Number.isNaN(x) || Number.isNaN(y)) return NaN;
  if (x === y) return y;
  if (x === 0) return y > 0 ? Number.MIN_VALUE : -Number.MIN_VALUE;
  F64[0] = x;
  I64[0] += (y > x) === (x > 0) ? 1n : -1n;
  return F64[0];
}
function msum(xs) {
  // Shewchuk's exact partial sums (Python's fsum).
  const partials = [];
  for (let x of xs) {
    let i = 0;
    for (let y of partials) {
      if (Math.abs(x) < Math.abs(y)) [x, y] = [y, x];
      const hi = x + y, lo = y - (hi - x);
      if (lo) partials[i++] = lo;
      x = hi;
    }
    partials.length = i;
    partials.push(x);
  }
  return partials.reduce((a, b) => a + b, 0);
}
const roundHalfEven = (x) => {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
};
function roundTo(x, n) {
  if (!Number.isFinite(x)) return x;
  if (n >= 0 && n <= 60 && Math.abs(x) < 1e21) {
    // toFixed rounds the exact binary value correctly (2.675 is 2.67499...), except that
    // exact ties go up; Python sends those to even (round(0.125, 2) == 0.12).
    const exact = Math.abs(x).toFixed(Math.min(100, n + 40)), cut = exact.indexOf('.') + 1 + n;
    if (/^50*$/.test(exact.slice(cut))) {
      const p = 10 ** n;
      return Math.sign(x) * roundHalfEven(Math.abs(x) * p) / p;
    }
    return Number(x.toFixed(n));
  }
  const p = 10 ** -n;
  return roundHalfEven(x / p) * p;
}

function needInt(v, fname) {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'boolean') return BigInt(v);
  throw err('TypeError', `'${typeName(v)}' object cannot be interpreted as an integer (in ${fname})`);
}
function isqrt(n) {
  if (n < 0n) throw err('ValueError', 'isqrt() argument must be nonnegative');
  if (n < 2n) return n;
  let x = BigInt(Math.floor(Math.sqrt(Number(n))));
  while (x * x > n) x--;
  while ((x + 1n) * (x + 1n) <= n) x++;
  return x;
}
const gcd2 = (a, b) => { a = a < 0n ? -a : a; b = b < 0n ? -b : b; while (b) [a, b] = [b, a % b]; return a; };

/** Integer function of scalars, elementwise over int arrays. */
function intFn(fname, f) {
  return (...xs) => {
    xs = xs.slice(0, f.length);
    if (xs.some((x) => x instanceof NDArray)) {
      const arrs = xs.map((x) => asArray(x));
      if (arrs.some((a) => a.dtype === 'float')) throw err('TypeError', `${fname}() needs integers`);
      return arrs.reduce((A, B) => broadcast2(A, B, (p, q) => Number(f(BigInt(p), BigInt(q))), 'int'));
    }
    return f(...xs.map((x) => needInt(x, fname)));
  };
}

// ---- math module ---------------------------------------------------------------------------

U1('sin(x)', 'Return the sine of x (measured in radians).\nAngle quantities are converted to radians: sin(30 * u.deg).', Math.sin, { mode: 'trig' });
U1('cos(x)', 'Return the cosine of x (measured in radians).\nAngle quantities are converted to radians.', Math.cos, { mode: 'trig' });
U1('tan(x)', 'Return the tangent of x (measured in radians).\nAngle quantities are converted to radians.', Math.tan, { mode: 'trig' });
U1('asin(x)', 'Return the arc sine (measured in radians) of x.\nThe result is between -pi/2 and pi/2.', Math.asin, { mode: 'inv', aliases: ['arcsin'] });
U1('acos(x)', 'Return the arc cosine (measured in radians) of x.\nThe result is between 0 and pi.', Math.acos, { mode: 'inv', aliases: ['arccos'] });
U1('atan(x)', 'Return the arc tangent (measured in radians) of x.\nThe result is between -pi/2 and pi/2.', Math.atan, { mode: 'inv', aliases: ['arctan'] });
U1('sinh(x)', 'Return the hyperbolic sine of x.', Math.sinh);
U1('cosh(x)', 'Return the hyperbolic cosine of x.', Math.cosh);
U1('tanh(x)', 'Return the hyperbolic tangent of x.', Math.tanh);
U1('asinh(x)', 'Return the inverse hyperbolic sine of x.', Math.asinh, { aliases: ['arcsinh'] });
U1('acosh(x)', 'Return the inverse hyperbolic cosine of x.', Math.acosh, { aliases: ['arccosh'] });
U1('atanh(x)', 'Return the inverse hyperbolic tangent of x.', Math.atanh, { infErr: 'domain', aliases: ['arctanh'] });
F('atan2(y, x)', 'Return the arc tangent (measured in radians) of y/x.\nUnlike atan(y/x), the signs of both x and y are considered.\nQuantities must share dimensions; the result is then in rad.', (y, x) => {
  const [a, b, unit] = sameUnit(y, x, 'atan2');
  const r = apply2(a, b, Math.atan2);
  return unit ? new Quantity(r, Unit.of(RAD())) : r;
}, { aliases: ['arctan2'] });
F('degrees(x)', 'Convert angle x from radians to degrees.\nFor an angle quantity, returns it in u.deg.', (x) => {
  x = arrayLike(x);
  if (x instanceof Quantity && ANGLE(x.unit)) return new Quantity(mapValue(x.value, (v) => v * x.unit.scale * 180 / Math.PI), Unit.of(DEG()));
  return apply1(plain(x, 'degrees'), (v) => v * 180 / Math.PI);
}, { aliases: ['rad2deg'] });
F('radians(x)', 'Convert angle x from degrees to radians.\nFor an angle quantity, returns it in u.rad.', (x) => {
  x = arrayLike(x);
  if (x instanceof Quantity && ANGLE(x.unit)) return new Quantity(mapValue(x.value, (v) => v * x.unit.scale), Unit.of(RAD()));
  return apply1(plain(x, 'radians'), (v) => v * Math.PI / 180);
}, { aliases: ['deg2rad'] });
let degDef = null;
const DEG = () => degDef;
export function setDegDef(d) { degDef = d; }

F('sqrt(x)', 'Return the square root of x.\nQuantities keep their units: sqrt(4 * u.m**2) is 2.0 m.', (x) => {
  x = arrayLike(x);
  if (x instanceof Quantity) return simplify(new Quantity(apply1(x.value, Math.sqrt), x.unit.pow(0.5)));
  return apply1(plain(x, 'sqrt'), Math.sqrt);
});
F('cbrt(x)', 'Return the cube root of x.', (x) => {
  x = arrayLike(x);
  if (x instanceof Quantity) return simplify(new Quantity(apply1(x.value, Math.cbrt), x.unit.pow(1 / 3)));
  return apply1(plain(x, 'cbrt'), Math.cbrt);
});
U1('exp(x)', 'Return e raised to the power of x.', Math.exp);
U1('exp2(x)', 'Return 2 raised to the power of x.', (x) => 2 ** x);
U1('expm1(x)', 'Return exp(x)-1.\nThis function avoids the loss of precision involved in the direct evaluation of exp(x)-1 for small x.', Math.expm1);
F('log(x, base=e)', 'log(x, [base=math.e])\nReturn the logarithm of x to the given base.\nIf the base is not specified, returns the natural logarithm (base e) of x.', (x, base) => {
  const v = plain(x, 'log');
  if (base === undefined) return apply1(v, Math.log, 'domain');
  const lb = Math.log(toNum(plain(base, 'log')));
  return apply1(v, (t) => Math.log(t) / lb, 'domain');
});
U1('log2(x)', 'Return the base 2 logarithm of x.', Math.log2, { infErr: 'domain' });
U1('log10(x)', 'Return the base 10 logarithm of x.', Math.log10, { infErr: 'domain' });
U1('log1p(x)', 'Return the natural logarithm of 1+x (base e).\nThe result is computed in a way which is accurate for x near zero.', Math.log1p, { infErr: 'domain' });
F('pow(x, y)', 'Return x**y (x to the power of y).\nLike math.pow, the result is a float for plain numbers.', (x, y) => {
  if (x instanceof Quantity || x instanceof NDArray || y instanceof NDArray) return binop('**', x, y);
  const a = toNum(plain(x, 'pow')), b = toNum(plain(y, 'pow'));
  if (a === 0 && b < 0) throw err('ValueError', 'math domain error');
  return apply2(a, b, Math.pow);
});
U1('erf(x)', 'Error function at x.', erf);
U1('erfc(x)', 'Complementary error function at x.', erfc);
U1('gamma(x)', 'Gamma function at x.', gamma, { infErr: 'domain' });
U1('lgamma(x)', 'Natural logarithm of absolute value of Gamma function at x.', lgamma, { infErr: 'domain' });
U1('fabs(x)', 'Return the absolute value of the float x.', Math.abs, { mode: 'keep' });

function intRound(fname, f) {
  return (x) => {
    x = arrayLike(x);
    if (x instanceof Quantity) return new Quantity(mapValue(x.value, f), x.unit);
    if (x instanceof NDArray) return x.dtype === 'float' ? mapArray(x, f, 'float') : mapArray(x, (v) => v, x.dtype === 'bool' ? 'int' : x.dtype);
    if (typeof x === 'bigint') return x;
    if (typeof x === 'boolean') return BigInt(x);
    if (typeof x !== 'number') throw NOT_REAL(fname, x);
    if (!Number.isFinite(x)) {
      throw Number.isNaN(x) ? err('ValueError', 'cannot convert float NaN to integer') : err('OverflowError', 'cannot convert float infinity to integer');
    }
    return BigInt(f(x));
  };
}
F('floor(x)', 'Return the floor of x as an Integral.\nThis is the largest integer <= x. Arrays and quantities stay floats.', intRound('floor', Math.floor));
F('ceil(x)', 'Return the ceiling of x as an Integral.\nThis is the smallest integer >= x. Arrays and quantities stay floats.', intRound('ceil', Math.ceil));
F('trunc(x)', 'Truncates the Real x to the nearest Integral toward 0.', intRound('trunc', Math.trunc));
F('copysign(x, y)', 'Return a float with the magnitude (absolute value) of x but the sign of y.', (x, y) => {
  const q = arrayLike(x) instanceof Quantity ? arrayLike(x) : null;
  const r = apply2(q ? q.value : plain(x, 'copysign'), plain(y instanceof Quantity ? y.value : y, 'copysign'),
    (a, b) => (Object.is(b, -0) || b < 0 ? -Math.abs(a) : Math.abs(a)));
  return q ? new Quantity(r, q.unit) : r;
});
F('fmod(x, y)', 'Return fmod(x, y), according to platform C.\nx % y may differ: the result here has the sign of x.', (x, y) => {
  const [a, b, unit] = sameUnit(x, y, 'fmod');
  return withUnit(apply2(a, b, (p, q) => (q === 0 && !Number.isNaN(p) ? NaN : p % q)), unit);
});
F('remainder(x, y)', 'Difference between x and the closest integer multiple of y.\nReturn x - n*y where n*y is the closest integer multiple of y. In the case where x is exactly halfway between two multiples of y, the nearest even value of n is used. The result is always exact.', (x, y) => {
  const [a, b, unit] = sameUnit(x, y, 'remainder');
  return withUnit(apply2(a, b, (p, q) => (q === 0 ? NaN : p - roundHalfEven(p / q) * q)), unit);
});
F('hypot(*coordinates)', 'Multidimensional Euclidean distance from the origin to a point.\nRoughly equivalent to: sqrt(sum(x**2 for x in coordinates)).\nQuantities must share dimensions; the result has the first one\'s unit.', (coords) => {
  if (!coords.length) return 0;
  let unit = null, acc = 0;
  for (const c of coords) {
    let v = arrayLike(c);
    if (v instanceof Quantity || unit) {
      const [, b, u] = sameUnit(unit ? new Quantity(1, unit) : v, v, 'hypot');
      unit = unit ?? u; v = b;
    } else v = plain(v, 'hypot');
    acc = binop('+', acc, binop('*', toFloatValue(v), toFloatValue(v)));
  }
  return withUnit(apply1(acc, Math.sqrt), unit);
});
F('isclose(a, b, *, rel_tol=1e-09, abs_tol=0.0)', 'Determine whether two floating-point numbers are close in value.\n  rel_tol: maximum difference for being considered "close", relative to the magnitude of the input values\n  abs_tol: maximum difference for being considered "close", regardless of the magnitude of the input values\nReturn True if a is close in value to b, and False otherwise.', (a, b, rel, abs) => {
  const [x, y] = sameUnit(a, b, 'isclose');
  const r = rel === undefined ? 1e-9 : toNum(rel), t = abs === undefined ? 0 : toNum(abs);
  return apply2(x, y, (p, q) => +(p === q || Math.abs(p - q) <= Math.max(r * Math.max(Math.abs(p), Math.abs(q)), t)), 'bool');
});
const pred = (f) => (x) => {
  x = arrayLike(x);
  const v = x instanceof Quantity ? x.value : x;
  if (v instanceof NDArray) return mapArray(v, (t) => +f(t), 'bool');
  if (!isNum(v)) throw NOT_REAL('isfinite', v);
  return f(toNum(v));
};
F('isfinite(x)', 'Return True if x is neither an infinity nor a NaN, and False otherwise.', pred(Number.isFinite));
F('isinf(x)', 'Return True if x is a positive or negative infinity, and False otherwise.', pred((t) => t === Infinity || t === -Infinity));
F('isnan(x)', 'Return True if x is a NaN (not a number), and False otherwise.', pred(Number.isNaN));
F('factorial(n)', 'Find n!.\nRaise a ValueError if n is negative or non-integral.', intFn('factorial', (n) => {
  if (n < 0n) throw err('ValueError', 'factorial() not defined for negative values');
  if (n > 20000n) throw err('OverflowError', 'factorial() argument too large for this calculator');
  let r = 1n;
  for (let i = 2n; i <= n; i++) r *= i;
  return r;
}));
F('comb(n, k)', 'Number of ways to choose k items from n items without repetition and without order.\nEvaluates to n! / (k! * (n - k)!) when k <= n and evaluates to zero when k > n.', intFn('comb', (n, k) => {
  if (n < 0n || k < 0n) throw err('ValueError', 'n and k must be non-negative integers');
  if (k > n) return 0n;
  if (k > n - k) k = n - k;
  let r = 1n;
  for (let i = 1n; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
}));
F('perm(n, k=None)', 'Number of ways to choose k items from n items without repetition and with order.\nEvaluates to n! / (n - k)! when k <= n and evaluates to zero when k > n.\nIf k is not specified or is None, then k defaults to n and the function returns n!.', (n, k) => intFn('perm', (a, b) => {
  if (a < 0n || b < 0n) throw err('ValueError', 'n and k must be non-negative integers');
  if (b > a) return 0n;
  let r = 1n;
  for (let i = a - b + 1n; i <= a; i++) r *= i;
  return r;
})(n, k === undefined || k === null ? n : k));
F('gcd(*integers)', 'Greatest Common Divisor.', (xs) => xs.reduce((a, b) => intFn('gcd', gcd2)(a, b), 0n));
F('lcm(*integers)', 'Least Common Multiple.', (xs) => xs.reduce((a, b) => intFn('lcm', (p, q) => { const r = p === 0n || q === 0n ? 0n : (p / gcd2(p, q)) * q; return r < 0n ? -r : r; })(a, b), 1n));
F('isqrt(n)', 'Return the integer part of the square root of the input.', intFn('isqrt', isqrt));
F('frexp(x)', 'Return the mantissa and exponent of x, as pair (m, e).\nm is a float and e is an int, such that x = m * 2.**e.\nIf x is 0, m and e are both 0. Else 0.5 <= abs(m) < 1.0.', (x) => {
  const v = toNum(plain(x, 'frexp'));
  if (v === 0 || !Number.isFinite(v)) return new Tuple([v, 0n]);
  let e = Math.max(-1073, Math.floor(Math.log2(Math.abs(v))) + 1);
  let m = v * 2 ** -e;
  while (Math.abs(m) < 0.5) { m *= 2; e--; }
  while (Math.abs(m) >= 1) { m /= 2; e++; }
  return new Tuple([m, BigInt(e)]);
});
F('ldexp(x, i)', 'Return x * (2**i).\nThis is essentially the inverse of frexp().', (x, i) => apply2(plain(x, 'ldexp'), plain(i, 'ldexp'), (a, b) => a * 2 ** b));
F('modf(x)', 'Return the fractional and integer parts of x.\nBoth results carry the sign of x and are floats.', (x) => {
  const v = toNum(plain(x, 'modf'));
  if (!Number.isFinite(v)) return new Tuple([Number.isNaN(v) ? v : 0 * Math.sign(v), v]);
  return new Tuple([v - Math.trunc(v), Math.trunc(v)]);
});
F('nextafter(x, y)', 'Return the floating-point value the given number of steps after x towards y.', (x, y) => apply2(plain(x, 'nextafter'), plain(y, 'nextafter'), nextafter));
U1('ulp(x)', 'Return the value of the least significant bit of the float x.', (x) => {
  if (!Number.isFinite(x)) return Number.isNaN(x) ? x : Infinity;
  const a = Math.abs(x);
  return nextafter(a, Infinity) - a;
});
F('fma(x, y, z)', 'Fused multiply-add operation.\nCompute (x * y) + z. (Here with an ordinary multiply and add: JavaScript has no fused operation.)', (x, y, z) => binop('+', binop('*', x, y), z));
F('fsum(seq)', 'Return an accurate floating-point sum of values in the iterable seq.\nAssumes IEEE-754 floating-point arithmetic.', (seq) => {
  const v = arrayLike(seq);
  if (v instanceof Quantity) return new Quantity(msum(asArray(v.value).data), v.unit);
  return msum(asArray(plain(v, 'fsum')).data);
});
F('dist(p, q)', 'Return the Euclidean distance between two points p and q.\nThe points should be specified as arrays of coordinates. Both inputs must have the same dimension.', (p, q) => {
  const d = binop('-', arrayLike(p), arrayLike(q));
  return REG.get('norm').impl([d], {});
});
F('sumprod(p, q)', 'Return the sum of products of values from two iterables p and q.\nRoughly equivalent to: sum(p * q).', (p, q) => REG.get('sum').impl([binop('*', arrayLike(p), arrayLike(q))], {}));

// ---- reductions and array helpers --------------------------------------------------------

currentGroup = 'array';

/** Reduce A along axis (or all) with f(values[]) -> number. */
function reduceArr(A, axis, f, dtype = 'float') {
  if (axis === undefined || axis === null) return unwrapScalar(f(Array.from(A.data)), dtype);
  let ax = Number(needInt(axis, 'axis'));
  if (ax < 0) ax += A.ndim;
  if (ax < 0 || ax >= A.ndim) throw err('AxisError', `axis ${axis} is out of bounds for array of dimension ${A.ndim}`);
  const outer = A.shape.slice(0, ax).reduce((a, b) => a * b, 1), n = A.shape[ax];
  const inner = A.shape.slice(ax + 1).reduce((a, b) => a * b, 1);
  const out = newArray([...A.shape.slice(0, ax), ...A.shape.slice(ax + 1)], dtype);
  const buf = new Array(n);
  for (let o = 0; o < outer; o++) {
    for (let i = 0; i < inner; i++) {
      for (let k = 0; k < n; k++) buf[k] = A.data[(o * n + k) * inner + i];
      out.data[o * inner + i] = f(buf);
    }
  }
  return unwrap0(out);
}
const unwrapScalar = (x, dtype) => (dtype === 'int' ? BigInt(Math.trunc(x)) : dtype === 'bool' ? x !== 0 : x);

/** Numeric array input: returns [NDArray, unit|null]. */
function arrIn(v, fname) {
  v = arrayLike(v);
  if (v instanceof Quantity) return [asArray(v.value), v.unit];
  if (isNum(v) || v instanceof NDArray) return [asArray(v), null];
  throw err('TypeError', `${fname}() needs a number or array, not '${typeName(v)}'`);
}
function reduction(sig, doc, f, { dtype = (A) => 'float', unitPow = 1, emptyErr } = {}) {
  const name = sig.slice(0, sig.indexOf('('));
  return F(sig, doc, (a, axis, ...extra) => {
    const [A, unit] = arrIn(a, name);
    if (A.size === 0 && emptyErr) throw err('ValueError', emptyErr);
    const r = reduceArr(A, axis, (xs) => f(xs, ...extra), dtype(A));
    if (!unit || unitPow === 0) return r;
    return simplify(new Quantity(toFloatValue(r), unit.pow(unitPow)));
  });
}
const intish = (A) => (A.dtype === 'float' ? 'float' : 'int');
const sumF = (xs) => xs.reduce((s, x) => s + x, 0);
const meanF = (xs) => sumF(xs) / xs.length;
const varF = (xs, ddof) => {
  const m = meanF(xs), d = ddof === undefined ? 0 : toNum(ddof);
  return xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - d);
};
const medianF = (xs) => {
  const s = [...xs].sort((a, b) => a - b), n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
};
reduction('sum(a, axis=None)', 'Sum of array elements (over all elements, or along axis).\nQuantities keep their unit.', sumF, { dtype: intish });
reduction('mean(a, axis=None)', 'Arithmetic mean of array elements (over all elements, or along axis).', meanF);
reduction('median(a, axis=None)', 'Median of array elements (over all elements, or along axis).', medianF);
reduction('std(a, axis=None, ddof=0)', 'Standard deviation of array elements. ddof is the "delta degrees of freedom": the divisor is N - ddof.', (xs, ddof) => Math.sqrt(varF(xs, ddof)));
reduction('var(a, axis=None, ddof=0)', 'Variance of array elements. ddof is the "delta degrees of freedom": the divisor is N - ddof.\nQuantities give the unit squared.', varF, { unitPow: 2 });
reduction('ptp(a, axis=None)', 'Range of values (maximum - minimum).', (xs) => Math.max(...xs) - Math.min(...xs), { dtype: intish });
reduction('argmin(a, axis=None)', 'Index of the minimum value (in the flattened array unless axis is given).', (xs) => xs.indexOf(Math.min(...xs)), { dtype: () => 'int', unitPow: 0 });
reduction('argmax(a, axis=None)', 'Index of the maximum value (in the flattened array unless axis is given).', (xs) => xs.indexOf(Math.max(...xs)), { dtype: () => 'int', unitPow: 0 });
reduction('any(a, axis=None)', 'True if any element is true (non-zero).', (xs) => +xs.some((x) => x !== 0), { dtype: () => 'bool', unitPow: 0 });
reduction('all(a, axis=None)', 'True if all elements are true (non-zero).', (xs) => +xs.every((x) => x !== 0), { dtype: () => 'bool', unitPow: 0 });
F('prod(a, axis=None, start=1)', 'Product of array elements (over all elements, or along axis), times start.', (a, axis, start) => {
  const [A, unit] = arrIn(a, 'prod');
  if (unit && !unit.isDimensionless) throw err('UnitTypeError', 'prod() of a quantity with units is not supported');
  if (unit) return REG.get('prod').impl([toFloatValue(mapValue(arrayLike(a).value, (x) => x * unit.scale)), axis ?? null, start ?? 1n], {});
  if (axis == null && A.dtype !== 'float' && (start === undefined || typeof start === 'bigint')) {
    return Array.from(A.data).reduce((p, x) => p * BigInt(x), start ?? 1n);
  }
  const r = reduceArr(A, axis, (xs) => xs.reduce((p, x) => p * x, 1), intish(A));
  return start === undefined ? r : binop('*', r, start);
});

function minmax(name, pick) {
  return (args, axis) => {
    if (args.length === 0) throw err('TypeError', `${name} expected at least 1 argument, got 0`);
    if (args.length === 1) {
      const [A, unit] = arrIn(args[0], name);
      if (A.size === 0) throw err('ValueError', `${name}() arg is an empty sequence`);
      const r = reduceArr(A, axis, (xs) => (xs.some(Number.isNaN) ? NaN : pick(...xs)), A.dtype === 'bool' ? 'bool' : intish(A));
      return unit ? new Quantity(toFloatValue(r), unit) : r;
    }
    // Several arguments: elementwise, like numpy.maximum / numpy.minimum.
    return args.reduce((a, b) => {
      const gt = binop(name === 'max' ? '>=' : '<=', a, b);
      if (typeof gt === 'boolean') return gt ? a : b;
      return REG.get('where').impl([gt, a, b], {});
    });
  };
}
F('max(*args, axis=None)', 'With one argument, the largest element of the array (or along axis).\nWith several, the elementwise maximum (like numpy.maximum).', minmax('max', Math.max), { aliases: ['amax'] });
F('min(*args, axis=None)', 'With one argument, the smallest element of the array (or along axis).\nWith several, the elementwise minimum (like numpy.minimum).', minmax('min', Math.min), { aliases: ['amin'] });

function cumulative(name, f) {
  return (a) => {
    const [A, unit] = arrIn(a, name);
    const out = newArray([A.size], intish(A));
    let acc = name === 'cumsum' ? 0 : 1;
    A.data.forEach((x, i) => { acc = f(acc, x); out.data[i] = acc; });
    return unit ? new Quantity(toFloatValue(out), unit) : out;
  };
}
F('cumsum(a)', 'Cumulative sum of the (flattened) elements.', cumulative('cumsum', (s, x) => s + x));
F('cumprod(a)', 'Cumulative product of the (flattened) elements.', cumulative('cumprod', (s, x) => s * x));
F('diff(a, n=1)', 'Differences between consecutive elements of a 1-d array, applied n times.', (a, n) => {
  let [A, unit] = arrIn(a, 'diff');
  if (A.ndim !== 1) throw err('ValueError', 'diff() supports 1-d arrays only');
  for (let k = Number(n ?? 1n); k > 0; k--) {
    const out = newArray([Math.max(0, A.size - 1)], A.dtype === 'float' ? 'float' : 'int');
    for (let i = 0; i < out.size; i++) out.data[i] = A.data[i + 1] - A.data[i];
    A = out;
  }
  return unit ? new Quantity(toFloatValue(A), unit) : A;
});
F('sort(a)', 'Return a sorted copy of an array (along the last axis).', (a) => {
  const [A, unit] = arrIn(a, 'sort');
  const out = newArray(A.shape.slice(), A.dtype), n = A.shape[A.ndim - 1] ?? 1;
  for (let o = 0; o < A.size; o += n) {
    const row = Array.from(A.data.subarray(o, o + n)).sort((x, y) => (Number.isNaN(x) ? 1 : Number.isNaN(y) ? -1 : x - y));
    out.data.set(row, o);
  }
  const r = unwrap0(out);
  return unit ? new Quantity(toFloatValue(r), unit) : r;
}, { aliases: ['sorted'] });
F('where(condition, x, y)', 'Return elements chosen from x or y depending on condition (elementwise, with broadcasting).', (c, x, y) => {
  const C = asArray(arrayLike(c));
  x = arrayLike(x); y = arrayLike(y);
  let unit = null;
  if (x instanceof Quantity || y instanceof Quantity) {
    const [a, b, u] = sameUnit(x, y, 'where');
    x = a; y = b; unit = u;
  }
  const X = asArray(x), Y = asArray(y);
  const shape = [C.shape, X.shape, Y.shape].reduce((s, t) => broadcast2(newArray(s), newArray(t), () => 0, 'float').shape);
  const dt = X.dtype === 'float' || Y.dtype === 'float' ? 'float' : X.dtype === 'int' || Y.dtype === 'int' ? 'int' : 'bool';
  const cx = broadcast2(C, X, (p, q) => (p ? q : NaN), 'float', shape);
  const out = broadcast2(cx, broadcast2(C, Y, (p, q) => (p ? NaN : q), 'float', shape), (p, q) => (Number.isNaN(p) ? q : p), dt, shape);
  // Restore genuine NaNs from x where the condition was true.
  const cs = broadcast2(C, newArray(shape), (p) => p, 'float', shape), xs = broadcast2(X, newArray(shape), (p) => p, 'float', shape);
  for (let i = 0; i < out.size; i++) if (cs.data[i] && Number.isNaN(xs.data[i])) out.data[i] = NaN;
  return withUnit(unwrap0(out), unit);
});
F('dot(a, b)', 'Dot product of two arrays (matrix product for 2-d arrays; same as a @ b).', (a, b) => binop('@', arrayLike(a), arrayLike(b)));
F('cross(a, b)', 'Cross product of two 3-vectors.', (a, b) => {
  const [A, ua] = arrIn(a, 'cross'), [B, ub] = arrIn(b, 'cross');
  if (A.size !== 3 || B.size !== 3) throw err('ValueError', 'cross() needs two 3-element vectors');
  const [x1, y1, z1] = A.data, [x2, y2, z2] = B.data;
  const out = new NDArray([3], Float64Array.of(y1 * z2 - z1 * y2, z1 * x2 - x1 * z2, x1 * y2 - y1 * x2), A.dtype === 'float' || B.dtype === 'float' ? 'float' : 'int');
  const unit = ua && ub ? ua.mul(ub) : ua ?? ub;
  return unit ? simplify(new Quantity(toFloatValue(out), unit)) : out;
});
F('norm(a)', 'Euclidean (2-) norm of the flattened array: sqrt(sum(a**2)).', (a) => {
  const [A, unit] = arrIn(a, 'norm');
  const r = Math.hypot(...A.data);
  return unit ? new Quantity(r, unit) : r;
});
F('outer(a, b)', 'Outer product of two vectors: out[i, j] = a[i] * b[j].', (a, b) => {
  const [A, ua] = arrIn(a, 'outer'), [B, ub] = arrIn(b, 'outer');
  const out = newArray([A.size, B.size], A.dtype === 'float' || B.dtype === 'float' ? 'float' : 'int');
  for (let i = 0; i < A.size; i++) for (let j = 0; j < B.size; j++) out.data[i * B.size + j] = A.data[i] * B.data[j];
  const unit = ua && ub ? ua.mul(ub) : ua ?? ub;
  return unit ? simplify(new Quantity(toFloatValue(out), unit)) : out;
});

const shapeArg = (s, fname) => {
  s = s instanceof NDArray ? new Tuple(Array.from(s.data, (x) => BigInt(x))) : s;
  const items = s instanceof Tuple ? s.items : [s];
  return items.map((x) => Number(needInt(x, fname)));
};
F('reshape(a, shape)', 'Give a new shape to an array without changing its data. One dimension may be -1, to be inferred.', (a, shape) => {
  const [A, unit] = arrIn(a, 'reshape');
  const dims = shapeArg(shape, 'reshape');
  const known = dims.filter((d) => d !== -1).reduce((p, d) => p * d, 1);
  const filled = dims.map((d) => (d === -1 ? A.size / known : d));
  if (filled.reduce((p, d) => p * d, 1) !== A.size || filled.some((d) => !Number.isInteger(d) || d < 0)) {
    throw err('ValueError', `cannot reshape array of size ${A.size} into shape (${dims.join(', ')})`);
  }
  const out = new NDArray(filled, Float64Array.from(A.data), A.dtype);
  return unit ? new Quantity(out, unit) : out;
});
F('ravel(a)', 'Return a flattened (1-d) copy of the array.', (a) => {
  const [A, unit] = arrIn(a, 'ravel');
  const out = new NDArray([A.size], Float64Array.from(A.data), A.dtype);
  return unit ? new Quantity(out, unit) : out;
}, { aliases: ['flatten'] });
export function transpose(A) {
  if (A.ndim < 2) return new NDArray(A.shape.slice(), Float64Array.from(A.data), A.dtype);
  const shape = [...A.shape].reverse(), out = newArray(shape, A.dtype);
  const nd = A.ndim, st = new Array(nd);
  let s = 1;
  for (let i = nd - 1; i >= 0; i--) { st[i] = s; s *= A.shape[i]; }
  const idx = new Array(nd).fill(0);
  for (let k = 0; k < out.size; k++) {
    let src = 0;
    for (let d = 0; d < nd; d++) src += idx[d] * st[nd - 1 - d];
    out.data[k] = A.data[src];
    for (let d = nd - 1; d >= 0; d--) { if (++idx[d] < shape[d]) break; idx[d] = 0; }
  }
  return out;
}
F('transpose(a)', 'Reverse the axes of an array (a.T).', (a) => {
  const [A, unit] = arrIn(a, 'transpose');
  return unit ? new Quantity(transpose(A), unit) : transpose(A);
});
F('concatenate(arrays, axis=0)', 'Join a tuple of arrays along an existing axis (only axis 0 here).', (arrays, axis) => {
  if (axis !== undefined && Number(axis) !== 0) throw err('ValueError', 'concatenate() supports axis=0 only');
  const items = arrays instanceof Tuple ? arrays.items : [arrays];
  const parts = items.map((x) => (isNum(x) ? buildArray([x]) : arrayLike(x)));
  const flat = parts.flatMap((p) => {
    const v = p instanceof Quantity ? p : p;
    const A = v instanceof Quantity ? v.value : v;
    if (!(A instanceof NDArray) || A.ndim === 0) throw err('ValueError', 'zero-dimensional arrays cannot be concatenated');
    return Array.from({ length: A.shape[0] }, (_, i) => (v instanceof Quantity
      ? new Quantity(unwrapRow(A, i), v.unit) : unwrapRow(A, i)));
  });
  return buildArray(flat);
}, { aliases: ['hstack'] });
const unwrapRow = (A, i) => {
  const n = A.size / A.shape[0];
  if (A.ndim === 1) return A.item(i);
  return new NDArray(A.shape.slice(1), A.data.slice(i * n, (i + 1) * n), A.dtype);
};
F('clip(a, a_min, a_max)', 'Limit the values in an array to the interval [a_min, a_max].', (a, lo, hi) => {
  let r = arrayLike(a);
  if (lo !== null && lo !== undefined) r = REG.get('max').impl([r, lo], {});
  if (hi !== null && hi !== undefined) r = REG.get('min').impl([r, hi], {});
  return r;
});
F('interp(x, xp, fp)', 'One-dimensional linear interpolation: the values of the piecewise linear function through (xp, fp) at x. xp must be increasing.', (x, xp, fp) => {
  const [X, ux] = arrIn(x, 'interp'), [XP, uxp] = arrIn(xp, 'interp'), [FP, ufp] = arrIn(fp, 'interp');
  if (XP.size !== FP.size) throw err('ValueError', 'fp and xp are not of the same length');
  let xs = X;
  if (ux || uxp) {
    if (!ux || !uxp || !ux.sameDims(uxp)) throw err('UnitConversionError', "Can only apply 'interp' function to quantities with compatible dimensions");
    xs = mapArray(X, converter(ux, uxp));
  }
  const f = (t) => {
    const n = XP.size;
    if (t <= XP.data[0]) return FP.data[0];
    if (t >= XP.data[n - 1]) return FP.data[n - 1];
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (XP.data[m] <= t) lo = m; else hi = m; }
    const w = (t - XP.data[lo]) / (XP.data[hi] - XP.data[lo]);
    return FP.data[lo] + w * (FP.data[hi] - FP.data[lo]);
  };
  const r = unwrap0(mapArray(xs, f));
  return ufp ? new Quantity(r, ufp) : r;
});

function rangeLike(start, stop, step, fname) {
  // Quantities: take the unit of the first quantity and convert the rest.
  const all = [start, stop, step].filter((v) => v !== undefined && v !== null);
  const q = all.find((v) => v instanceof Quantity);
  if (!q) return [all.map((v) => plain(v, fname)), null];
  return [all.map((v) => {
    if (!(v instanceof Quantity)) throw err('UnitConversionError', `${fname}(): give every argument a unit`);
    if (!v.unit.sameDims(q.unit)) throw err('UnitConversionError', `${fname}(): '${v.unit}' and '${q.unit}' are not convertible`);
    return v.value * converter(v.unit, q.unit)(1);
  }), q.unit];
}
F('arange(start, stop=None, step=1)', 'Evenly spaced values within the half-open interval [start, stop), like numpy.arange.\narange(n) is 0, 1, ..., n-1. Quantities work: arange(0, 10, 2) * u.km or arange(0*u.km, 10*u.km, 2*u.km).', (start, stop, step) => {
  if (stop === undefined || stop === null) { stop = start; start = 0n; }
  const [[a, b, s = 1n], unit] = rangeLike(start, stop, step ?? (start instanceof Quantity ? new Quantity(1, start.unit) : 1n), 'arange');
  const isInt = [a, b, s].every((v) => typeof v === 'bigint' || typeof v === 'boolean');
  const sn = toNum(s);
  if (sn === 0) throw err('ZeroDivisionError', 'step must not be zero');
  const n = Math.max(0, Math.ceil((toNum(b) - toNum(a)) / sn));
  const out = newArray([n], isInt && !unit ? 'int' : 'float');
  for (let i = 0; i < n; i++) out.data[i] = toNum(a) + i * sn;
  return unit ? new Quantity(out, unit) : out;
});
F('range(start, stop=None, step=1)', 'Integers from start (default 0) up to but not including stop, by step. Returns an array here.', (start, stop, step) => {
  if (stop === undefined || stop === null) { stop = start; start = 0n; }
  const [a, b, s] = [start, stop, step ?? 1n].map((v) => Number(needInt(v, 'range')));
  if (s === 0) throw err('ValueError', 'range() arg 3 must not be zero');
  const n = Math.max(0, Math.ceil((b - a) / s));
  const out = newArray([n], 'int');
  for (let i = 0; i < n; i++) out.data[i] = a + i * s;
  return out;
});
F('linspace(start, stop, num=50, endpoint=True)', 'num evenly spaced numbers over [start, stop] (stop excluded if endpoint=False).\nQuantities work: linspace(1*u.GHz, 2*u.GHz, 5).', (start, stop, num, endpoint) => {
  const [[a, b], unit] = rangeLike(start, stop, undefined, 'linspace');
  const n = Number(needInt(num ?? 50n, 'linspace'));
  if (n < 0) throw err('ValueError', `Number of samples, ${n}, must be non-negative.`);
  const ep = endpoint === undefined ? true : truth(endpoint);
  const div = ep ? n - 1 : n, out = newArray([n]);
  const A = toNum(a), B = toNum(b);
  for (let i = 0; i < n; i++) out.data[i] = div > 0 ? A + (i * (B - A)) / div : A;
  if (ep && n > 1) out.data[n - 1] = B;
  return unit ? new Quantity(out, unit) : out;
});
F('logspace(start, stop, num=50, base=10.0)', 'num numbers spaced evenly on a log scale, from base**start to base**stop.', (start, stop, num, base) => {
  const lin = REG.get('linspace').impl([start, stop, num ?? 50n], {});
  return apply1(lin, (x) => toNum(base ?? 10) ** x);
});
F('zeros(shape)', 'A new float array of the given shape (an int or a tuple), filled with zeros.', (shape) => newArray(shapeArg(shape, 'zeros')));
F('ones(shape)', 'A new float array of the given shape (an int or a tuple), filled with ones.', (shape) => {
  const a = newArray(shapeArg(shape, 'ones'));
  a.data.fill(1);
  return a;
});
F('full(shape, fill_value)', 'A new array of the given shape filled with fill_value.', (shape, v) => {
  const s = shapeArg(shape, 'full');
  const r = binop('+', newArray(s, typeof v === 'number' ? 'float' : 'int'), v instanceof Quantity ? v.value : v);
  return v instanceof Quantity ? new Quantity(toFloatValue(r), v.unit) : r;
});
F('array(object)', 'Create an array from a list, tuple or array (a copy).', (o) => {
  o = arrayLike(o);
  if (o instanceof NDArray) return new NDArray(o.shape.slice(), Float64Array.from(o.data), o.dtype);
  if (o instanceof Quantity) return new Quantity(toFloatValue(o.value), o.unit);
  if (isNum(o)) return asArray(o);
  throw err('TypeError', `cannot make an array from '${typeName(o)}'`);
}, { aliases: ['asarray'] });
F('shape(a)', 'Shape of an array, as a tuple.', (a) => {
  const [A] = arrIn(a, 'shape');
  return new Tuple(A.shape.map((n) => BigInt(n)));
});

// ---- Python builtins ---------------------------------------------------------------------

currentGroup = 'builtins';
F('abs(x)', 'Return the absolute value of the argument.', (x) => {
  x = arrayLike(x);
  if (typeof x === 'bigint') return x < 0n ? -x : x;
  if (typeof x === 'boolean') return BigInt(x);
  if (x instanceof Quantity) return new Quantity(mapValue(x.value, Math.abs), x.unit);
  if (x instanceof NDArray) return mapArray(x, Math.abs, x.dtype === 'bool' ? 'int' : x.dtype);
  if (typeof x === 'number') return Math.abs(x);
  throw err('TypeError', `bad operand type for abs(): '${typeName(x)}'`);
}, { aliases: ['absolute'] });
F('round(number, ndigits=None)', 'Round a number to a given precision in decimal digits.\nThe return value is an integer if ndigits is omitted or None. Otherwise the return value has the same type as the number. ndigits may be negative.\nHalves round to even, as in Python: round(2.5) is 2.', (x, nd) => {
  x = arrayLike(x);
  const n = nd === undefined || nd === null ? null : Number(needInt(nd, 'round'));
  if (x instanceof Quantity) return new Quantity(mapValue(x.value, (v) => roundTo(v, n ?? 0)), x.unit);
  if (x instanceof NDArray) return x.dtype === 'float' ? mapArray(x, (v) => roundTo(v, n ?? 0)) : mapArray(x, (v) => (n !== null && n < 0 ? roundTo(v, n) : v), 'int');
  if (typeof x === 'boolean') x = BigInt(x);
  if (typeof x === 'bigint') {
    if (n === null || n >= 0) return x;
    const p = 10n ** BigInt(-n), q = x / p, r = x - q * p, half = p / 2n;
    const ar = r < 0n ? -r : r;
    let res = q;
    if (ar > half || (ar === half && q % 2n !== 0n)) res += x < 0n ? -1n : 1n;
    return res * p;
  }
  if (typeof x !== 'number') throw err('TypeError', `type ${typeName(x)} doesn't define __round__ method`);
  if (n === null) {
    if (!Number.isFinite(x)) throw Number.isNaN(x) ? err('ValueError', 'cannot convert float NaN to integer') : err('OverflowError', 'cannot convert float infinity to integer');
    return BigInt(roundHalfEven(x));
  }
  return roundTo(x, n);
}, { aliases: ['around'] });
F('len(obj)', 'Return the number of items in a container (the first dimension of an array).', (o) => {
  const v = o instanceof Quantity ? o.value : o;
  if (v instanceof NDArray) {
    if (v.ndim === 0) throw err('TypeError', 'len() of unsized object');
    return BigInt(v.shape[0]);
  }
  if (v instanceof Tuple) return BigInt(v.items.length);
  if (v instanceof Str) return BigInt([...v.s].length);
  throw err('TypeError', `object of type '${typeName(o)}' has no len()`);
});
F('int(x=0, base=10)', 'Convert a number or string to an integer (truncating toward zero), or an array to an int array.', (x, base) => {
  if (x === undefined) return 0n;
  if (x instanceof Str) {
    const b = base === undefined ? 10 : Number(base), s = x.s.trim().replace(/_/g, '').toLowerCase();
    const digits = s.replace(/^[-+]/, '').replace(b === 16 ? /^0x/ : b === 8 ? /^0o/ : b === 2 ? /^0b/ : /^$/, '');
    const ok = digits.length && [...digits].every((c) => { const d = parseInt(c, 36); return d < b; });
    if (!ok) throw err('ValueError', `invalid literal for int() with base ${b}: ${JSON.stringify(x.s)}`);
    const v = [...digits].reduce((acc, c) => acc * BigInt(b) + BigInt(parseInt(c, 36)), 0n);
    return s.startsWith('-') ? -v : v;
  }
  if (x instanceof Quantity) {
    if (!x.unit.isDimensionless) throw err('TypeError', 'only dimensionless quantities can be converted to Python scalars');
    x = mapValue(x.value, (v) => v * x.unit.scale);
  }
  if (x instanceof NDArray) return mapArray(x, Math.trunc, 'int');
  return intRound('int', Math.trunc)(x);
});
F('float(x=0.0)', 'Convert a string or number to a floating point number (or an array to a float array).', (x) => {
  if (x === undefined) return 0;
  if (x instanceof Str) {
    const s = x.s.trim().toLowerCase().replace(/_/g, '');
    const v = /^[-+]?(inf|infinity)$/.test(s) ? (s.startsWith('-') ? -Infinity : Infinity) : s === 'nan' ? NaN : (/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/.test(s) ? Number(s) : null);
    if (v === null) throw err('ValueError', `could not convert string to float: ${JSON.stringify(x.s)}`);
    return v;
  }
  if (x instanceof Quantity) {
    if (!x.unit.isDimensionless) throw err('TypeError', 'only dimensionless quantities can be converted to Python scalars');
    return toFloatValue(mapValue(x.value, (v) => v * x.unit.scale));
  }
  if (x instanceof NDArray) return toFloatValue(x);
  if (!isNum(x)) throw err('TypeError', `float() argument must be a string or a real number, not '${typeName(x)}'`);
  return toNum(x);
});
F('bool(x=False)', 'Returns True when the argument is true, False otherwise.', (x) => (x === undefined ? false : truth(x)));
F('str(object=\'\')', 'Return a string version of object.', (o, interp) => new Str(o === undefined ? '' : interp.str(o)));
F('divmod(x, y)', 'Return the tuple (x//y, x%y).', (x, y) => new Tuple([binop('//', x, y), binop('%', x, y)]));
F('type(object)', "Return the object's type.", (o) => new Str(`<class '${typeName(o)}'>`, true));
F('print(*args)', 'Print the values, separated by spaces.', (args, interp) => { interp.print(args.map((a) => interp.str(a)).join(' ')); return null; });
F('help(obj=None)', 'Show help for an object (same as obj? ), or general help with no argument.', (o, interp) => interp.helpFor(o));

// ---- units helpers (astropy compatibility) -------------------------------------------------

currentGroup = 'units';
export const SPECTRAL_FN = new Func('spectral', 'spectral()', 'astropy.units.spectral(): wavelength/frequency/energy/wavenumber equivalency.\nThe -> operator and .to() apply it automatically, so this is only for compatibility.', () => null);
export const TEMPERATURE_FN = new Func('temperature', 'temperature()', 'astropy.units.temperature(): K / deg_C / deg_F equivalency.\nThe -> operator and .to() apply it automatically, so this is only for compatibility.', () => null);

export const BUILTINS = REG;
export const MATH_CONSTANTS = {
  pi: [Math.PI, 'The mathematical constant π = 3.141592…'],
  e: [Math.E, "The mathematical constant e = 2.718281…, Euler's number."],
  tau: [2 * Math.PI, 'The mathematical constant τ = 6.283185…, the circle constant 2π.'],
  π: [Math.PI, 'The mathematical constant π = 3.141592… (same as pi).'],
  τ: [2 * Math.PI, 'The circle constant τ = 2π (same as tau).'],
  inf: [Infinity, 'Floating-point positive infinity.'],
  nan: [NaN, 'A floating-point "not a number" (NaN) value.'],
};
