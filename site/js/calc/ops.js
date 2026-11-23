// Operators for calculator values: Python scalar semantics (int/float/bool), numpy-style
// broadcasting for arrays, astropy-style units, indexing, and unit conversion (->).
import { NDArray, Quantity, Tuple, Str, Slice, PyError, err, newArray, isNum, toNum, typeName } from './values.js';
import { Unit, ONE, converter, decomposeUnit, UnitConversionError } from './units.js';

export const isArr = (v) => v instanceof NDArray;
const dtypeOf = (v) => (typeof v === 'bigint' ? 'int' : typeof v === 'boolean' ? 'bool' : 'float');

/** Scalar or NDArray as an NDArray (0-d for scalars). */
export function asArray(v) {
  if (v instanceof NDArray) return v;
  if (isNum(v)) return new NDArray([], Float64Array.of(toNum(v)), dtypeOf(v));
  throw err('TypeError', `expected a number or array, got '${typeName(v)}'`);
}
/** Number or float NDArray (copied), for Quantity values. */
export function toFloatValue(v) {
  if (v instanceof NDArray) return new NDArray(v.shape.slice(), Float64Array.from(v.data), 'float');
  if (isNum(v)) return toNum(v);
  throw err('TypeError', `expected a number or array, got '${typeName(v)}'`);
}
/** 0-d arrays back to Python scalars. */
export const unwrap0 = (a) => (a instanceof NDArray && a.ndim === 0 ? a.item(0) : a);

// ---- broadcasting ------------------------------------------------------------------------

const fmtShape = (s) => `(${s.join(',')}${s.length === 1 ? ',' : ''})`;
export function broadcastShapes(a, b) {
  const n = Math.max(a.length, b.length), out = new Array(n);
  for (let i = 0; i < n; i++) {
    const x = a[a.length - n + i] ?? 1, y = b[b.length - n + i] ?? 1;
    if (x !== y && x !== 1 && y !== 1) {
      throw err('ValueError', `operands could not be broadcast together with shapes ${fmtShape(a)} ${fmtShape(b)}`);
    }
    out[i] = x === 1 ? y : x;
  }
  return out;
}
function bstrides(shape, out) {
  const nd = out.length, st = new Array(nd).fill(0);
  let s = 1;
  for (let i = shape.length - 1; i >= 0; i--) {
    const j = nd - shape.length + i;
    st[j] = shape[i] === 1 && out[j] !== 1 ? 0 : s;
    s *= shape[i];
  }
  return st;
}
/** Apply f(x, y) over broadcast A, B into a new array of `dtype`. */
export function broadcast2(A, B, f, dtype, shape = broadcastShapes(A.shape, B.shape)) {
  const out = newArray(shape, dtype), od = out.data, ad = A.data, bd = B.data, n = od.length;
  if (A.size === n && B.size === n && A.ndim === B.ndim) {
    for (let k = 0; k < n; k++) od[k] = f(ad[k], bd[k]);
  } else {
    const sa = bstrides(A.shape, shape), sb = bstrides(B.shape, shape), nd = shape.length;
    const idx = new Array(nd).fill(0);
    let ia = 0, ib = 0;
    for (let k = 0; k < n; k++) {
      od[k] = f(ad[ia], bd[ib]);
      for (let d = nd - 1; d >= 0; d--) {
        idx[d]++; ia += sa[d]; ib += sb[d];
        if (idx[d] < shape[d]) break;
        ia -= sa[d] * shape[d]; ib -= sb[d] * shape[d]; idx[d] = 0;
      }
    }
  }
  if (dtype === 'int') for (let k = 0; k < n; k++) if (!Number.isFinite(od[k])) od[k] = 0;
  return out;
}
export const broadcastTo = (A, shape) => broadcast2(A, asArray(0), (x) => x, A.dtype, broadcastShapes(A.shape, shape));
export function mapArray(A, f, dtype = 'float') {
  const out = newArray(A.shape.slice(), dtype);
  for (let i = 0; i < A.size; i++) out.data[i] = f(A.data[i]);
  return out;
}

// ---- numeric operators -------------------------------------------------------------------

const pyMod = (x, y) => { const r = x % y; return r !== 0 && (r < 0) !== (y < 0) ? r + y : r; };
const CMP = new Set(['<', '<=', '>', '>=', '==', '!=']);
const BIT = new Set(['&', '|', '^', '<<', '>>']);
const AOPS = {
  '+': (x, y) => x + y, '-': (x, y) => x - y, '*': (x, y) => x * y, '/': (x, y) => x / y,
  '//': (x, y) => Math.floor(x / y), '%': pyMod, '**': Math.pow,
  '<': (x, y) => +(x < y), '<=': (x, y) => +(x <= y), '>': (x, y) => +(x > y), '>=': (x, y) => +(x >= y),
  '==': (x, y) => +(x === y), '!=': (x, y) => +(x !== y),
  '&': (x, y) => Number(BigInt(x) & BigInt(y)), '|': (x, y) => Number(BigInt(x) | BigInt(y)),
  '^': (x, y) => Number(BigInt(x) ^ BigInt(y)),
  '<<': (x, y) => Number(BigInt(x) << BigInt(y)), '>>': (x, y) => Number(BigInt(x) >> BigInt(y)),
};
const UFUNC = { '&': 'bitwise_and', '|': 'bitwise_or', '^': 'bitwise_xor', '<<': 'left_shift', '>>': 'right_shift' };

export function arrayBinop(op, A, B) {
  if (op === '@') return matmul(A, B);
  let dtype;
  if (CMP.has(op)) dtype = 'bool';
  else if (BIT.has(op)) {
    if (A.dtype === 'float' || B.dtype === 'float') {
      throw err('TypeError', `ufunc '${UFUNC[op]}' not supported for the input types`);
    }
    dtype = A.dtype === 'bool' && B.dtype === 'bool' && !op.includes('<') && !op.includes('>') ? 'bool' : 'int';
  } else if (op === '/') dtype = 'float';
  else if (A.dtype === 'float' || B.dtype === 'float') dtype = 'float';
  else if (op === '**' && B.data.some((x) => x < 0)) dtype = 'float';
  else dtype = 'int';
  const f = AOPS[op];
  if (!f) throw err('TypeError', `unsupported operand type(s) for ${op}: 'ndarray' and 'ndarray'`);
  return unwrap0(broadcast2(A, B, f, dtype));
}

function floorDivBig(a, b) {
  const q = a / b;
  return (a % b !== 0n) && ((a < 0n) !== (b < 0n)) ? q - 1n : q;
}

export function scalarBinop(op, a, b) {
  if (typeof a === 'boolean' && typeof b === 'boolean' && (op === '&' || op === '|' || op === '^')) {
    return op === '&' ? a && b : op === '|' ? a || b : a !== b;
  }
  if (CMP.has(op)) {
    const x = typeof a === 'boolean' ? Number(a) : a, y = typeof b === 'boolean' ? Number(b) : b;
    switch (op) {
      case '<': return x < y; case '<=': return x <= y; case '>': return x > y; case '>=': return x >= y;
      // eslint-disable-next-line eqeqeq
      case '==': return x == y; default: return x != y; // loose: 1n == 1.0
    }
  }
  if (typeof a === 'boolean') a = BigInt(a);
  if (typeof b === 'boolean') b = BigInt(b);
  if (typeof a === 'bigint' && typeof b === 'bigint') {
    switch (op) {
      case '+': return a + b; case '-': return a - b; case '*': return a * b;
      case '/':
        if (b === 0n) throw err('ZeroDivisionError', 'division by zero');
        return Number(a) / Number(b);
      case '//':
        if (b === 0n) throw err('ZeroDivisionError', 'integer division or modulo by zero');
        return floorDivBig(a, b);
      case '%':
        if (b === 0n) throw err('ZeroDivisionError', 'integer modulo by zero');
        return ((a % b) + b) % b;
      case '**':
        if (b < 0n) {
          if (a === 0n) throw err('ZeroDivisionError', '0.0 cannot be raised to a negative power');
          return Number(a) ** Number(b);
        }
        if (b > 100000n && a !== 0n && a !== 1n && a !== -1n) throw err('OverflowError', 'exponent too large');
        return a ** b;
      case '&': return a & b; case '|': return a | b; case '^': return a ^ b;
      case '<<':
        if (b < 0n) throw err('ValueError', 'negative shift count');
        return a << b;
      case '>>':
        if (b < 0n) throw err('ValueError', 'negative shift count');
        return a >> b;
      default:
    }
  }
  if (BIT.has(op)) {
    throw err('TypeError', `unsupported operand type(s) for ${op}: '${typeName(a)}' and '${typeName(b)}'`);
  }
  const x = Number(a), y = Number(b);
  switch (op) {
    case '+': return x + y; case '-': return x - y; case '*': return x * y;
    case '/':
      if (y === 0) throw err('ZeroDivisionError', 'float division by zero');
      return x / y;
    case '//':
      if (y === 0) throw err('ZeroDivisionError', 'float floor division by zero');
      return Math.floor(x / y);
    case '%':
      if (y === 0) throw err('ZeroDivisionError', 'float modulo by zero');
      return pyMod(x, y);
    case '**':
      if (x === 0 && y < 0) throw err('ZeroDivisionError', 'zero to a negative power');
      if (x < 0 && !Number.isInteger(y)) throw err('ValueError', 'negative number to a fractional power (complex numbers are not supported)');
      return x ** y;
    default:
  }
  throw err('TypeError', `unsupported operand type(s) for ${op}: '${typeName(a)}' and '${typeName(b)}'`);
}

/** Float-valued (Quantity value) op with numpy semantics: division by zero gives inf/nan. */
function valueOp(op, x, y) {
  if (typeof x === 'number' && typeof y === 'number') {
    const r = AOPS[op](x, y);
    return CMP.has(op) ? r === 1 : r;
  }
  return arrayBinop(op, asArray(x), asArray(y));
}

export function matmul(A, B) {
  A = asArray(A); B = asArray(B);
  if (A.ndim === 0 || B.ndim === 0) throw err('ValueError', 'matmul: Input operand does not have enough dimensions');
  if (A.ndim > 2 || B.ndim > 2) throw err('ValueError', 'matmul: only 1-d and 2-d arrays are supported');
  const a2 = A.ndim === 1 ? [1, A.shape[0]] : A.shape, b2 = B.ndim === 1 ? [B.shape[0], 1] : B.shape;
  const [n, k] = a2, [k2, m] = b2;
  if (k !== k2) throw err('ValueError', `matmul: Input operand 1 has a mismatch in its core dimension 0 (size ${k2} is different from ${k})`);
  const dtype = A.dtype === 'float' || B.dtype === 'float' ? 'float' : 'int';
  const shape = [...(A.ndim === 2 ? [n] : []), ...(B.ndim === 2 ? [m] : [])];
  const out = newArray(shape, dtype);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < m; j++) {
      let s = 0;
      for (let t = 0; t < k; t++) s += A.data[i * k + t] * B.data[t * m + j];
      out.data[i * m + j] = s;
    }
  }
  return unwrap0(out);
}

// ---- units and quantities ----------------------------------------------------------------

/** Collapse a Quantity with no unit back to a plain number/array. */
export const simplify = (q) => (q instanceof Quantity && q.unit.isUnscaledDimensionless ? unwrap0(q.value) : q);

const OPNAME = {
  '+': 'add', '-': 'subtract', '<': 'less', '<=': 'less_equal', '>': 'greater', '>=': 'greater_equal',
  '==': 'equal', '!=': 'not_equal', '//': 'floor_divide', '%': 'remainder',
};
const arbitrary = (v) => (typeof v === 'number' ? v === 0 || !Number.isFinite(v)
  : v instanceof NDArray && v.data.every((x) => x === 0 || !Number.isFinite(x)));

function unitBinop(op, a, b) {
  const ua = a instanceof Unit, ub = b instanceof Unit;
  if (ua && ub) {
    if (op === '*') return a.mul(b);
    if (op === '/') return a.div(b);
    if (op === '==' || op === '!=') {
      const eq = a.sameDims(b) && Math.abs(a.scale / b.scale - 1) < 1e-12;
      return op === '==' ? eq : !eq;
    }
  } else if (ua && op === '**') {
    if (!isNum(b)) throw err('TypeError', `unit exponent must be a number, got '${typeName(b)}'`);
    return a.pow(toNum(b));
  } else if (ua || ub) {
    const u = ua ? a : b, o = ua ? b : a;
    if (o instanceof Quantity) {
      if (op === '*') return simplify(new Quantity(o.value, ua ? u.mul(o.unit) : o.unit.mul(u)));
      if (op === '/') {
        return ua ? simplify(new Quantity(valueOp('/', 1, o.value), u.div(o.unit))) : simplify(new Quantity(o.value, o.unit.div(u)));
      }
    } else if (isNum(o) || isArr(o)) {
      const v = toFloatValue(o);
      if (op === '*') return new Quantity(v, u);
      if (op === '/') return ua ? new Quantity(valueOp('/', 1, v), u) : new Quantity(v, u.pow(-1));
    }
    if (op === '==') return false;
    if (op === '!=') return true;
  }
  throw err('TypeError', `unsupported operand type(s) for ${op}: '${typeName(a)}' and '${typeName(b)}'`);
}

function quantityBinop(op, a, b) {
  const wrap = (v) => {
    if (v instanceof Quantity) return v;
    if (isNum(v) || isArr(v)) return new Quantity(toFloatValue(v), ONE);
    throw err('TypeError', `unsupported operand type(s) for ${op}: '${typeName(a)}' and '${typeName(b)}'`);
  };
  const qa = wrap(a), qb = wrap(b);
  switch (op) {
    case '*': return simplify(new Quantity(valueOp('*', qa.value, qb.value), qa.unit.mul(qb.unit)));
    case '/': return simplify(new Quantity(valueOp('/', qa.value, qb.value), qa.unit.div(qb.unit)));
    case '@': return simplify(new Quantity(toFloatValue(matmul(qa.value, qb.value)), qa.unit.mul(qb.unit)));
    case '**': {
      if (b instanceof Quantity) {
        if (!b.unit.isDimensionless) throw err('TypeError', 'can only raise something to a dimensionless quantity');
        b = qb.value * qb.unit.scale;
      }
      if (!isNum(b)) throw err('ValueError', 'Quantities can only be raised to a scalar power');
      const p = toNum(b);
      return simplify(new Quantity(valueOp('**', qa.value, p), qa.unit.pow(p)));
    }
    default:
  }
  if (!(op in OPNAME)) {
    throw err('TypeError', `unsupported operand type(s) for ${op}: '${typeName(a)}' and '${typeName(b)}'`);
  }
  let vb;
  if (qa.unit.sameDims(qb.unit)) vb = mapValue(qb.value, converter(qb.unit, qa.unit));
  else if (CMP.has(op) && !(b instanceof Quantity) && arbitrary(qb.value)) vb = qb.value;
  else if (CMP.has(op) && !(a instanceof Quantity) && arbitrary(qa.value)) {
    return valueOp(op, qa.value, qb.value);
  } else {
    throw err('UnitConversionError', `Can only apply '${OPNAME[op]}' function to quantities with compatible dimensions`);
  }
  const r = valueOp(op, qa.value, vb);
  if (CMP.has(op)) return r;
  if (op === '//') return unwrap0(r);
  return simplify(new Quantity(r, qa.unit));
}

export const mapValue = (v, f) => (v instanceof NDArray ? mapArray(v, f) : f(v));

// ---- dispatch ------------------------------------------------------------------------------

export function binop(op, a, b) {
  if (a instanceof Unit || b instanceof Unit) return unitBinop(op, a, b);
  if (a instanceof Quantity || b instanceof Quantity) return quantityBinop(op, a, b);
  if (isNum(a) && isNum(b)) {
    if (op === '@') throw err('TypeError', `unsupported operand type(s) for @: '${typeName(a)}' and '${typeName(b)}'`);
    return scalarBinop(op, a, b);
  }
  if ((isNum(a) || isArr(a)) && (isNum(b) || isArr(b))) return arrayBinop(op, asArray(a), asArray(b));
  if (a instanceof Str && b instanceof Str) {
    if (op === '+') return new Str(a.s + b.s);
    if (CMP.has(op)) return scalarBinop(op, a.s < b.s ? -1 : a.s > b.s ? 1 : 0, 0);
  }
  if (a instanceof Str && typeof b === 'bigint' && op === '*') return new Str(a.s.repeat(Math.max(0, Number(b))));
  if (a instanceof Tuple && b instanceof Tuple) {
    if (op === '+') return new Tuple([...a.items, ...b.items]);
    if (op === '==' || op === '!=') {
      const eq = a.items.length === b.items.length && a.items.every((x, i) => truth(binop('==', x, b.items[i])));
      return op === '==' ? eq : !eq;
    }
  }
  if (op === '==') return a === b;
  if (op === '!=') return a !== b;
  if (CMP.has(op)) throw err('TypeError', `'${op}' not supported between instances of '${typeName(a)}' and '${typeName(b)}'`);
  throw err('TypeError', `unsupported operand type(s) for ${op}: '${typeName(a)}' and '${typeName(b)}'`);
}

export function unop(op, v) {
  if (op === 'not') return !truth(v);
  if (v instanceof Quantity) {
    if (op === '-') return new Quantity(mapValue(v.value, (x) => -x), v.unit);
    if (op === '+') return new Quantity(v.value, v.unit);
  }
  if (typeof v === 'boolean') v = BigInt(v);
  if (typeof v === 'bigint') return op === '-' ? -v : op === '~' ? ~v : v;
  if (typeof v === 'number') {
    if (op === '~') throw err('TypeError', "bad operand type for unary ~: 'float'");
    return op === '-' ? -v : v;
  }
  if (v instanceof NDArray) {
    if (op === '~') {
      if (v.dtype === 'float') throw err('TypeError', "ufunc 'invert' not supported for the input types");
      return v.dtype === 'bool' ? mapArray(v, (x) => +!x, 'bool') : mapArray(v, (x) => ~x, 'int');
    }
    const dt = v.dtype === 'bool' ? 'int' : v.dtype;
    return op === '-' ? mapArray(v, (x) => -x, dt) : mapArray(v, (x) => x, dt);
  }
  throw err('TypeError', `bad operand type for unary ${op}: '${typeName(v)}'`);
}

export function truth(v) {
  if (v === null || v === undefined) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'bigint') return v !== 0n;
  if (typeof v === 'number') return v !== 0;
  if (v instanceof NDArray) {
    if (v.size === 1) return v.data[0] !== 0;
    if (v.size === 0) return false;
    throw err('ValueError', 'The truth value of an array with more than one element is ambiguous. Use a.any() or a.all()');
  }
  if (v instanceof Quantity) return truth(v.value);
  if (v instanceof Str) return v.s.length > 0;
  if (v instanceof Tuple) return v.items.length > 0;
  return true;
}

// ---- indexing ----------------------------------------------------------------------------

const BAD_INDEX = 'only integers, slices (`:`), ellipsis (`...`), numpy.newaxis (`None`) and integer or boolean arrays are valid indices';

export function sliceIndices(sl, n) {
  const int = (v, name) => {
    if (v === null || v === undefined) return null;
    if (typeof v === 'bigint' || typeof v === 'boolean') return Number(v);
    throw err('TypeError', `slice indices must be integers or None, not ${typeName(v)} (${name})`);
  };
  const step = int(sl.step, 'step') ?? 1;
  if (step === 0) throw err('ValueError', 'slice step cannot be zero');
  const fix = (v, dflt, lo, hi) => {
    if (v === null) return dflt;
    if (v < 0) v += n;
    return Math.min(Math.max(v, lo), hi);
  };
  const start = step > 0 ? fix(int(sl.start, 'start'), 0, 0, n) : fix(int(sl.start, 'start'), n - 1, -1, n - 1);
  const stop = step > 0 ? fix(int(sl.stop, 'stop'), n, 0, n) : fix(int(sl.stop, 'stop'), -1, -1, n - 1);
  const out = [];
  for (let i = start; step > 0 ? i < stop : i > stop; i += step) out.push(i);
  return out;
}

function normIndex(i, n, axis) {
  let k = Number(i);
  if (k < 0) k += n;
  if (k < 0 || k >= n) throw err('IndexError', `index ${i} is out of bounds for axis ${axis} with size ${n}`);
  return k;
}

/** Flat source indices and result shape for a[idx]; scalar=true when every axis is dropped. */
function selection(a, idx) {
  const items = idx instanceof Tuple ? idx.items : [idx];
  if (items.length === 1 && items[0] instanceof NDArray && items[0].dtype === 'bool' &&
      items[0].ndim === a.ndim && items[0].ndim > 1) {
    const m = items[0];
    if (m.shape.some((s, i) => s !== a.shape[i])) throw err('IndexError', 'boolean index did not match indexed array');
    const flat = [];
    m.data.forEach((x, i) => { if (x) flat.push(i); });
    return { flat, shape: [flat.length], scalar: false };
  }
  if (items.length > a.ndim) {
    throw err('IndexError', `too many indices for array: array is ${a.ndim}-dimensional, but ${items.length} were indexed`);
  }
  const lists = [], shape = [];
  for (let ax = 0; ax < a.ndim; ax++) {
    const n = a.shape[ax], it = items[ax];
    if (it === undefined || (it instanceof Slice)) {
      const l = sliceIndices(it ?? new Slice(null, null, null), n);
      lists.push(l); shape.push(l.length);
    } else if (typeof it === 'bigint') {
      lists.push([normIndex(it, n, ax)]);
    } else if (it instanceof NDArray && it.ndim === 1 && it.dtype === 'bool') {
      if (it.size !== n) throw err('IndexError', `boolean index did not match indexed array along axis ${ax}; size of axis is ${n} but size of corresponding boolean axis is ${it.size}`);
      const l = [];
      it.data.forEach((x, i) => { if (x) l.push(i); });
      lists.push(l); shape.push(l.length);
    } else if (it instanceof NDArray && it.ndim === 1 && it.dtype === 'int') {
      const l = Array.from(it.data, (x) => normIndex(x, n, ax));
      lists.push(l); shape.push(l.length);
    } else {
      throw err('IndexError', BAD_INDEX);
    }
  }
  const strides = new Array(a.ndim);
  let s = 1;
  for (let i = a.ndim - 1; i >= 0; i--) { strides[i] = s; s *= a.shape[i]; }
  let flat = [0];
  lists.forEach((l, ax) => {
    const next = [];
    for (const base of flat) for (const i of l) next.push(base + i * strides[ax]);
    flat = next;
  });
  return { flat, shape, scalar: shape.length === 0 };
}

export function getItem(v, idx) {
  if (v instanceof Quantity) {
    if (!(v.value instanceof NDArray)) throw err('TypeError', "'Quantity' object with a scalar value does not support indexing");
    const r = getItem(v.value, idx);
    return new Quantity(r instanceof NDArray ? r : toNum(r), v.unit);
  }
  if (v instanceof NDArray) {
    if (v.ndim === 0) throw err('IndexError', 'too many indices for array: array is 0-dimensional');
    const sel = selection(v, idx);
    if (sel.scalar) return v.item(sel.flat[0]);
    const out = newArray(sel.shape, v.dtype);
    sel.flat.forEach((k, i) => { out.data[i] = v.data[k]; });
    return out;
  }
  if (v instanceof Tuple || v instanceof Str) {
    const seq = v instanceof Tuple ? v.items : [...v.s];
    if (idx instanceof Slice) {
      const l = sliceIndices(idx, seq.length).map((i) => seq[i]);
      return v instanceof Tuple ? new Tuple(l) : new Str(l.join(''));
    }
    if (typeof idx !== 'bigint') throw err('TypeError', `${typeName(v)} indices must be integers or slices, not ${typeName(idx)}`);
    let k = Number(idx);
    if (k < 0) k += seq.length;
    if (k < 0 || k >= seq.length) throw err('IndexError', `${typeName(v)} index out of range`);
    return v instanceof Tuple ? seq[k] : new Str(seq[k]);
  }
  throw err('TypeError', `'${typeName(v)}' object is not subscriptable`);
}

export function setItem(target, idx, value) {
  let arr = target, val = value;
  if (target instanceof Quantity) {
    if (!(target.value instanceof NDArray)) throw err('TypeError', "'Quantity' object with a scalar value does not support item assignment");
    arr = target.value;
    const q = value instanceof Quantity ? value : new Quantity(toFloatValue(value), ONE);
    if (!q.unit.sameDims(target.unit) && !arbitrary(q.value)) {
      throw err('UnitConversionError', `'${q.unit}' (${q.unit.physicalType}) and '${target.unit}' (${target.unit.physicalType}) are not convertible`);
    }
    val = q.unit.sameDims(target.unit) ? mapValue(q.value, converter(q.unit, target.unit)) : q.value;
  } else if (!(target instanceof NDArray)) {
    throw err('TypeError', `'${typeName(target)}' object does not support item assignment`);
  } else if (value instanceof Quantity) {
    throw err('TypeError', 'cannot assign a Quantity into a plain array; multiply the array by a unit first');
  }
  const sel = selection(arr, idx);
  const src = broadcastTo(asArray(val), sel.shape);
  const cast = arr.dtype === 'int' ? Math.trunc : arr.dtype === 'bool' ? (x) => +(x !== 0) : (x) => x;
  sel.flat.forEach((k, i) => { arr.data[k] = cast(src.data[i]); });
}

// ---- array literals ----------------------------------------------------------------------

/** Build an array from the values of a [ ... ] literal. */
export function buildArray(items) {
  const qs = items.filter((x) => x instanceof Quantity);
  if (qs.length && qs.length !== items.length) {
    throw err('TypeError', 'cannot mix quantities and plain numbers in an array; give every element a unit');
  }
  let unit = null;
  if (qs.length) {
    unit = qs[0].unit;
    items = items.map((q) => {
      if (!q.unit.sameDims(unit)) throw err('UnitConversionError', `'${q.unit}' (${q.unit.physicalType}) and '${unit}' (${unit.physicalType}) are not convertible`);
      return mapValue(q.value, converter(q.unit, unit));
    });
  }
  if (!items.length) return newArray([0]);
  const arrs = items.map((x) => {
    if (x instanceof NDArray || isNum(x)) return asArray(x);
    throw err('TypeError', `array elements must be numbers, arrays or quantities, not '${typeName(x)}'`);
  });
  const inner = arrs[0].shape;
  if (arrs.some((a) => a.shape.length !== inner.length || a.shape.some((s, i) => s !== inner[i]))) {
    throw err('ValueError', 'setting an array element with a sequence. The requested array has an inhomogeneous shape');
  }
  const dt = arrs.some((a) => a.dtype === 'float') ? 'float' : arrs.some((a) => a.dtype === 'int') ? 'int' : 'bool';
  const out = newArray([arrs.length, ...inner], unit ? 'float' : dt);
  const n = arrs[0].size;
  arrs.forEach((a, i) => out.data.set(a.data, i * n));
  return unit ? new Quantity(out, unit) : out;
}

// ---- conversion (->) -----------------------------------------------------------------------

const wrapConv = (fn) => {
  try { return fn(); } catch (e) {
    if (e instanceof UnitConversionError) throw err('UnitConversionError', e.message);
    throw e;
  }
};

/** value -> unit, with temperature offsets and the spectral equivalency. */
export function convert(v, target) {
  if (!(target instanceof Unit)) {
    throw err('TypeError', `can only convert to a unit (e.g. u.km), si, cgs, hms or dms, not '${typeName(target)}'`);
  }
  let q;
  if (v instanceof Quantity) q = v;
  else if (isNum(v) || isArr(v)) q = new Quantity(toFloatValue(v), ONE);
  else throw err('TypeError', `cannot convert '${typeName(v)}' to a unit`);
  const f = wrapConv(() => converter(q.unit, target, true));
  return simplify(new Quantity(mapValue(q.value, f), target));
}

/** .si / .cgs: express in the system's base units. */
export function toSystem(v, system) {
  if (v instanceof Unit) {
    const { factor, unit } = decomposeUnit(v, system);
    return new Unit(unit.parts, factor);
  }
  if (!(v instanceof Quantity)) return v;
  if (v.unit.temperatureScale?.offset) {
    // astropy refuses; treat deg_C/deg_F as absolute temperatures here.
    return convert(v, decomposeUnit(v.unit, system).unit);
  }
  const { factor, unit } = decomposeUnit(v.unit, system);
  return simplify(new Quantity(mapValue(v.value, (x) => x * factor), unit));
}

/** -> hms / dms: sexagesimal text for angles (and times, for hms). */
export function sexagesimal(v, kind) {
  if (!(v instanceof Quantity)) throw err('TypeError', `-> ${kind} needs an angle${kind === 'hms' ? ' or a time' : ''} quantity, e.g. 15.5 * u.deg`);
  const d = v.unit.dims, isTime = d[2] === 1 && d.every((x, i) => i === 2 || x === 0);
  const isAngle = d[7] === 1 && d.every((x, i) => i === 7 || x === 0);
  if (!isAngle && !(isTime && kind === 'hms')) {
    throw err('UnitConversionError', `'${v.unit}' (${v.unit.physicalType}) cannot be shown as ${kind}`);
  }
  const perUnit = kind === 'dms' ? Math.PI / 180 : isTime ? 3600 : Math.PI / 12;
  const k = v.unit.scale / perUnit;
  const labels = kind === 'dms' ? ['d', 'm', 's'] : ['h', 'm', 's'];
  const one = (x) => {
    x *= k;
    if (!Number.isFinite(x)) return String(x);
    const sign = x < 0 ? '-' : '';
    const ms = Math.round(Math.abs(x) * 3600e4);  // 0.1 ms of arc/time resolution
    const a = Math.floor(ms / 3600e4), b = Math.floor((ms % 3600e4) / 60e4), c = (ms % 60e4) / 1e4;
    let cs = c.toFixed(4).replace(/\.?0+$/, '');
    if (c < 10) cs = `0${cs}`;
    return `${sign}${a}${labels[0]}${String(b).padStart(2, '0')}${labels[1]}${cs}${labels[2]}`;
  };
  if (v.value instanceof NDArray) {
    const parts = Array.from(v.value.data, one);
    return new Str(v.value.ndim === 1 ? `[${parts.join(', ')}]` : parts.join(', '), true);
  }
  return new Str(one(v.value), true);
}

export { PyError };
