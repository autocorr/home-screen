// Calculator value types and their Python/numpy/astropy-style display.
//
// Scalars are plain JS values: bigint = Python int (arbitrary precision), number = float,
// boolean = bool, null = None. Everything else is one of the classes below.
import { Unit } from './units.js';

export class PyError extends Error {
  constructor(type, msg) { super(msg); this.pyType = type; }
}
export const err = (type, msg) => new PyError(type, msg);

/** n-d array of float64 storage with a dtype of 'int' | 'float' | 'bool' (numpy-like). */
export class NDArray {
  constructor(shape, data, dtype = 'float') {
    this.shape = shape;
    this.data = data;
    this.dtype = dtype;
  }
  get size() { return this.data.length; }
  get ndim() { return this.shape.length; }
  /** Element i of the flat data as a Python scalar. */
  item(i) {
    const x = this.data[i];
    return this.dtype === 'int' ? BigInt(Math.trunc(x)) : this.dtype === 'bool' ? x !== 0 : x;
  }
}
export const MAX_SIZE = 10_000_000;
export function newArray(shape, dtype = 'float') {
  const n = shape.reduce((a, b) => a * b, 1);
  if (n > MAX_SIZE) throw err('MemoryError', `array of ${n} elements is too large (limit ${MAX_SIZE})`);
  return new NDArray(shape, new Float64Array(n), dtype);
}

/** A number or NDArray with a unit (astropy Quantity). `meta` marks constants. */
export class Quantity {
  constructor(value, unit, meta = null) {
    this.value = value;
    this.unit = unit;
    this.meta = meta;
  }
}
export class Tuple { constructor(items) { this.items = items; } }
export class Str {
  /** raw: shown without quotes (e.g. sexagesimal output). */
  constructor(s, raw = false) { this.s = s; this.raw = raw; }
}
export class Slice { constructor(start, stop, step) { this.start = start; this.stop = stop; this.step = step; } }
export class Func {
  /** impl(args, kwargs, interp) -> value. sig like 'log(x, base=e)'. */
  constructor(name, sig, doc, impl, opts = {}) {
    this.name = name; this.sig = sig; this.doc = doc; this.impl = impl;
    this.kind = opts.kind || 'builtin';  // 'builtin' | 'lambda' | 'method'
    this.params = opts.params || null;
    this.self = opts.self;
  }
}
export class Namespace {
  constructor(name, doc, get, keys) { this.name = name; this.doc = doc; this.get = get; this.keys = keys; }
}

export const isNum = (v) => typeof v === 'number' || typeof v === 'bigint' || typeof v === 'boolean';
export const toNum = (v) => (typeof v === 'number' ? v : Number(v));

export function typeName(v) {
  if (v === null || v === undefined) return 'NoneType';
  switch (typeof v) {
    case 'bigint': return 'int';
    case 'number': return 'float';
    case 'boolean': return 'bool';
    default:
  }
  if (v instanceof NDArray) return 'ndarray';
  if (v instanceof Quantity) return v.meta ? 'Constant' : 'Quantity';
  if (v instanceof Unit) return 'Unit';
  if (v instanceof Tuple) return 'tuple';
  if (v instanceof Str) return 'str';
  if (v instanceof Func) return v.kind === 'lambda' ? 'function' : 'builtin_function_or_method';
  if (v instanceof Namespace) return 'module';
  if (v instanceof Slice) return 'slice';
  return 'object';
}

// ---- number formatting -------------------------------------------------------------------

/** Display precision (IPython %precision): null = repr, else {kind: 'f'|'e'|'g', n}. */
export const display = { precision: null };

const pad2 = (n) => String(n).padStart(2, '0');

/** Python float repr: shortest round-trip digits, scientific below 1e-4 or from 1e16. */
export function floatRepr(x) {
  if (Number.isNaN(x)) return 'nan';
  if (!Number.isFinite(x)) return x > 0 ? 'inf' : '-inf';
  if (x === 0) return Object.is(x, -0) ? '-0.0' : '0.0';
  const [mant, es] = x.toExponential().split('e');
  const exp = Number(es);
  const sign = mant.startsWith('-') ? '-' : '';
  const digits = mant.replace('-', '').replace('.', '');
  if (exp < -4 || exp >= 16) {
    const m = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
    return `${sign}${m}e${exp < 0 ? '-' : '+'}${pad2(Math.abs(exp))}`;
  }
  if (exp >= 0) {
    const ip = digits.slice(0, exp + 1).padEnd(exp + 1, '0');
    return `${sign}${ip}.${digits.slice(exp + 1) || '0'}`;
  }
  return `${sign}0.${'0'.repeat(-exp - 1)}${digits}`;
}

function expFmt(x, n) {
  const [m, e] = x.toExponential(n).split('e');
  const k = Number(e);
  return `${m}e${k < 0 ? '-' : '+'}${pad2(Math.abs(k))}`;
}

export function fmtFloat(x) {
  const p = display.precision;
  if (!p || !Number.isFinite(x)) return floatRepr(x);
  if (p.kind === 'e') return expFmt(x, p.n);
  if (p.kind === 'g') {
    if (x === 0) return '0';
    const e = Math.floor(Math.log10(Math.abs(Number(x.toPrecision(Math.max(1, p.n))))));
    if (e < -4 || e >= Math.max(1, p.n)) return expFmt(x, Math.max(0, p.n - 1)).replace(/\.?0+e/, 'e');
    return x.toFixed(Math.max(0, p.n - 1 - e)).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  }
  // 'f': fixed decimals, but switch to exponent where fixed would hide or bloat the value.
  const a = Math.abs(x);
  if (a >= 1e16 || (a !== 0 && a < 0.5 * 10 ** -p.n)) return expFmt(x, p.n);
  return x.toFixed(p.n);
}

function scalarRepr(v) {
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  if (typeof v === 'bigint') return v.toString();
  return fmtFloat(v);
}

// ---- array formatting (Python list look, numpy alignment and summarising) --------------

const EDGE = 3, THRESHOLD = 1000;

function elemStr(a, i) {
  const x = a.data[i];
  if (a.dtype === 'bool') return x ? 'True' : 'False';
  if (a.dtype === 'int') return Number.isFinite(x) ? BigInt(Math.trunc(x)).toString() : String(x);
  return fmtFloat(x);
}

export function arrayRepr(a, indentExtra = 0) {
  if (a.ndim === 0) return elemStr(a, 0);
  const summarise = a.size > THRESHOLD;
  // Strides for flat indexing.
  const strides = new Array(a.ndim);
  let s = 1;
  for (let i = a.ndim - 1; i >= 0; i--) { strides[i] = s; s *= a.shape[i]; }
  const axisIdx = (n) => (summarise && n > 2 * EDGE
    ? [...Array(EDGE).keys(), null, ...Array.from({ length: EDGE }, (_, k) => n - EDGE + k)]
    : [...Array(n).keys()]);
  // First pass: collect element strings to find a common width.
  const shown = [];
  const collect = (ax, off) => {
    for (const i of axisIdx(a.shape[ax])) {
      if (i === null) continue;
      if (ax === a.ndim - 1) shown.push(elemStr(a, off + i * strides[ax]));
      else collect(ax + 1, off + i * strides[ax]);
    }
  };
  collect(0, 0);
  const w = a.ndim > 1 ? Math.max(...shown.map((x) => x.length)) : 0;
  const build = (ax, off, indent) => {
    if (a.shape[ax] === 0) return '[]';
    const items = axisIdx(a.shape[ax]).map((i) => {
      if (i === null) return '...';
      return ax === a.ndim - 1 ? elemStr(a, off + i * strides[ax]).padStart(w) : build(ax + 1, off + i * strides[ax], indent + 1);
    });
    if (ax === a.ndim - 1) return `[${items.join(', ')}]`;
    const sep = `,${'\n'.repeat(a.ndim - 1 - ax)}${' '.repeat(indent + 1 + indentExtra)}`;
    return `[${items.join(sep)}]`;
  };
  return build(0, 0, 0);
}

// ---- repr ------------------------------------------------------------------------------

export function strRepr(s) {
  const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  return q + s.replace(/\\/g, '\\\\').replace(new RegExp(q, 'g'), `\\${q}`).replace(/\n/g, '\\n') + q;
}

export function repr(v) {
  if (v === null || v === undefined) return 'None';
  if (isNum(v)) return scalarRepr(v);
  if (v instanceof NDArray) return arrayRepr(v);
  if (v instanceof Quantity) {
    const u = v.unit.toString();
    const val = v.value instanceof NDArray ? arrayRepr(v.value) : fmtFloat(v.value);
    return u ? `${val} ${u}` : val;
  }
  if (v instanceof Unit) return v.repr();
  if (v instanceof Tuple) {
    return v.items.length === 1 ? `(${repr(v.items[0])},)` : `(${v.items.map(repr).join(', ')})`;
  }
  if (v instanceof Str) return v.raw ? v.s : strRepr(v.s);
  if (v instanceof Func) return v.kind === 'lambda' ? `<function ${v.name}>` : `<built-in function ${v.name}>`;
  if (v instanceof Namespace) return `<module '${v.name}'>`;
  if (v instanceof Slice) return `slice(${[v.start, v.stop, v.step].map(repr).join(', ')})`;
  return String(v);
}

/** str(): like repr but strings without quotes. */
export const str = (v) => (v instanceof Str ? v.s : v instanceof Unit ? v.toString() : repr(v));
