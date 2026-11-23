// The calculator's interpreter: evaluates parsed input, keeps variables and Out history,
// and implements IPython-style help (name?, help()), magics (%who, %precision, ...) and
// Tab completion. No DOM: site/js/calc.js renders it, tests drive it from Node.
import { parse, tokenize, unitName } from './parse.js';
import { latexComplete } from './latex.js';
import {
  NDArray, Quantity, Tuple, Str, Func, Namespace, Slice, PyError, err, repr, str, typeName, display, isNum, fmtFloat,
} from './values.js';
import {
  binop, unop, truth, getItem, setItem, buildArray, convert, toSystem, sexagesimal, toFloatValue, asArray,
} from './ops.js';
import {
  Unit, ONE, lookupUnitDef, unitDefs, unitNames, CONSTANTS, parseUnitString, fmtG, decomposeUnit, isImperial,
  converter, UnitConversionError,
} from './units.js';
import {
  BUILTINS, MATH_CONSTANTS, bindArgs, transpose, setRadDef, setDegDef,
} from './builtins.js';

setRadDef(lookupUnitDef('rad'));
setDegDef(lookupUnitDef('deg'));

// ---- constants: c ---------------------------------------------------------------------

const CONST_VALUES = Object.fromEntries(Object.entries(CONSTANTS).map(([k, [v, unc, unit, long, ref]]) => {
  const u = parseUnitString(unit);
  return [k, new Quantity(v, u, { name: k, long, unc, ref })];
}));
const CONSTS = new Namespace('c', 'Physical and astronomical constants, as in astropy.constants (CODATA 2022, IAU 2015).\nc.c, c.G * c.M_sun / c.R_sun**2 -> m / s**2\nType %consts to list them, or c.G? for details.', (n) => {
  if (n in CONST_VALUES) return CONST_VALUES[n];
  throw err('AttributeError', `module 'c' has no attribute '${n}' (see %consts)`);
}, () => Object.keys(CONST_VALUES));

const MAGICS = {
  who: 'Print all interactive variables, with some minimal formatting.',
  whos: 'Like %who, but gives some extra information about each variable.',
  reset: 'Delete all variables (and the _ output history).',
  precision: '%precision [n | %.Nf | %.Ne | %.Ng]\nSet how floats are displayed: n decimal places, or a format; no argument restores full precision (repr).',
  history: 'Print the input history of this session, numbered. Alias: %hist.',
  hist: 'Alias for %history.',
  clear: 'Clear the screen (also Ctrl+L).',
  units: '%units [text]\nList the units, optionally only those matching text (a name or a physical type such as "pressure").',
  consts: 'List the constants available as c.<name>.',
  lsmagic: 'List the available magic commands.',
  quickref: 'Show the quick reference (same as ?).',
};
const PYKEYWORDS = ['lambda', 'True', 'False', 'None', 'and', 'or', 'not', 'if', 'else', 'del', 'in', 'is'];
const METHODS = {
  sum: 'sum', mean: 'mean', median: 'median', std: 'std', var: 'var', min: 'min', max: 'max', prod: 'prod',
  argmin: 'argmin', argmax: 'argmax', cumsum: 'cumsum', cumprod: 'cumprod', any: 'any', all: 'all', round: 'round',
  reshape: 'reshape', ravel: 'ravel', flatten: 'ravel', transpose: 'transpose', clip: 'clip', ptp: 'ptp', dot: 'dot',
  copy: 'array',
};
const SPECIAL_TARGETS = ['si', 'cgs', 'hms', 'dms'];

export const HELP = `Calculator: a Python-style REPL with numpy-like arrays and astropy-like units.

  2**10, 7 // 2, 7 / 2        Python arithmetic (ints are exact; ** is power, ^ is xor)
  x = 3; y = x**2             variables; _ is the last result, _3 is Out[3]
  a = [1, 2, 3]               arrays broadcast like numpy: a * 2, a + [[10], [20]]
  a[0], a[1:], a[a > 1]       indexing, slices, masks; a.sum(), mean(a), a.T
  sqrt(2), log(8, 2), pi      Python's math module (elementwise on arrays)
  3 km, 9.8 m / s**2          units go right after a number (or a closing bracket):
  [1, 2] km, (x) m            names there are always units, astropy's names and prefixes
  1 kg m / s^2, 2 m3 / (kg s2) (GHz, Jy, pc, Msun, deg_C, ...); elsewhere they are free
                              for your own variables, so m = 5 and 3 m both work
  c.c, c.G, c.M_sun           constants, as in astropy.constants
  60 mi / h -> m / s          convert with -> (or "to"); everything left of -> is converted
  21 cm -> GHz                spectral (wavelength/frequency/energy) and temperature
  100 deg_C -> deg_F          conversions apply automatically (also 100 °C -> °F)
  x -> si, x -> cgs           SI or CGS base units; x.si, x.value and x.unit also work
  15.5 deg -> dms             sexagesimal: -> hms for hour angles or times
  f = lambda x: x**2          one-line functions

  name?  or  ?name            help on a function, unit, constant or variable (km?, c.G?)
  %who, %whos, %reset         list or clear variables
  %units [text], %consts      list units and constants
  %precision [n]              digits shown for floats; no argument restores full precision
  %history, %clear            past input; clear the screen (Ctrl+L)
  \alpha<Tab> -> α             LaTeX names complete to symbols, as in IPython: Greek letters
                              (usable as names), \hbar, \sqrt √, \le ≤, \times ×, \^2 ², \_0 ₀
  Up/Down recall history (type a prefix to search), Tab completes, Shift+Enter adds a line.`;

/** Levenshtein distance, for "Did you mean" hints. */
function lev(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[a.length][b.length];
}

export class Interp {
  constructor() {
    this.vars = new Map();
    this.outs = new Map();   // _, __, ___, _N
    this.n = 1;
    this.inputs = [];
    this.records = [];
    this.depth = 0;
  }

  // ---- names -----------------------------------------------------------------------------

  builtin(name) {
    if (name === 'c') return CONSTS;
    if (name in MATH_CONSTANTS) return MATH_CONSTANTS[name][0];
    return BUILTINS.get(name);
  }
  lookup(name, env) {
    for (let e = env; e; e = e.parent) if (e.vars.has(name)) return e.vars.get(name);
    if (this.vars.has(name)) return this.vars.get(name);
    if (/^_+$|^_\d+$/.test(name) && this.outs.has(name)) return this.outs.get(name);
    const b = this.builtin(name);
    if (b !== undefined) return b;
    throw this.nameError(name);
  }
  nameError(name) {
    let hint = '';
    if (/^_\d+$/.test(name)) hint = '';
    else if (unitName(name)) hint = `1 ${name}`;
    else if (name in CONST_VALUES) hint = `c.${name}`;
    else if (name === 'np' || name === 'math' || name === 'numpy') hint = '';
    else {
      const cands = [...this.vars.keys(), ...BUILTINS.keys(), ...Object.keys(MATH_CONSTANTS), 'c'];
      let best = null, bd = 3;
      for (const c of name.length >= 3 ? cands : []) {
        const dd = lev(name, c);
        if (dd < bd && dd <= Math.max(1, Math.floor(name.length / 3))) { bd = dd; best = c; }
      }
      hint = best ?? '';
    }
    if (name === 'u' || name === 'const') {
      return err('NameError', `name '${name}' is not defined. Units go right after a number (3 km, not ${name === 'u' ? '3 * u.km' : 'u.km'}); constants are c.<name>, e.g. c.G`);
    }
    if (name === 'np' || name === 'math' || name === 'numpy') {
      return err('NameError', `name '${name}' is not defined. Math and array functions are built in: use sqrt(x), not ${name}.sqrt(x)`);
    }
    return err('NameError', `name '${name}' is not defined${hint ? `. Did you mean: '${hint}'?` : ''}`);
  }

  // ---- evaluation ------------------------------------------------------------------------

  eval(node, env = null) {
    switch (node.type) {
      case 'Num': return node.value;
      case 'Str': return new Str(node.value);
      case 'Const': return node.value;
      case 'Name':
        if (SPECIAL_TARGETS.includes(node.id) && !this.vars.has(node.id) && !(env && this.inEnv(node.id, env))) {
          throw err('NameError', `name '${node.id}' is not defined ('${node.id}' is only a conversion target, as in x -> ${node.id})`);
        }
        return this.lookup(node.id, env);
      case 'Paren': return this.eval(node.value, env);
      case 'Tuple': return new Tuple(node.elts.map((e) => this.eval(e, env)));
      case 'List': return buildArray(node.elts.map((e) => this.eval(e, env)));
      case 'BinOp': return binop(node.op, this.eval(node.l, env), this.eval(node.r, env));
      case 'Unary': return unop(node.op, this.eval(node.v, env));
      case 'BoolOp': {
        const l = this.eval(node.l, env);
        if (node.op === 'and') return truth(l) ? this.eval(node.r, env) : l;
        return truth(l) ? l : this.eval(node.r, env);
      }
      case 'Compare': {
        let l = this.eval(node.operands[0], env), res = true;
        for (let i = 0; i < node.ops.length; i++) {
          const r = this.eval(node.operands[i + 1], env);
          res = this.compare(node.ops[i], l, r);
          if (node.ops.length > 1 && !truth(res)) return res;
          l = r;
        }
        return res;
      }
      case 'IfExp': return truth(this.eval(node.test, env)) ? this.eval(node.body, env) : this.eval(node.orelse, env);
      case 'Lambda': return this.makeLambda(node, env);
      case 'Call': {
        const f = this.eval(node.func, env);
        const args = node.args.map((a) => this.eval(a, env));
        const kwargs = {};
        for (const k of node.kwargs) {
          if (k.name in kwargs) throw err('SyntaxError', `keyword argument repeated: ${k.name}`);
          kwargs[k.name] = this.eval(k.value, env);
        }
        return this.call(f, args, kwargs);
      }
      case 'Subscript': return getItem(this.eval(node.value, env), this.evalIndex(node.index, env));
      case 'SliceN': throw err('SyntaxError', 'slices are only allowed inside [ ]');
      case 'Attr': return this.getAttr(this.eval(node.value, env), node.name);
      case 'Convert': return this.convert(this.eval(node.value, env), node.target, env);
      case 'Unit': return this.evalUnit(node.tree, env);
      default: throw err('SyntaxError', `unsupported syntax (${node.type})`);
    }
  }
  /** A unit chunk. Names are units even if a variable has the same name; when that
   *  variable was probably meant (after * or /), say so. */
  evalUnit(t, env) {
    switch (t.type) {
      case 'UOne': return ONE;
      case 'UName':
        if (t.afterOp && (this.vars.has(t.written) || (env && this.inEnv(t.written, env)))) {
          this.print(`Note: '${t.written}' here is the unit ${lookupUnitDef(t.name).long}, not your variable ${t.written}. ` +
            `To use the variable, close the quantity first: (2 m) ${t.afterOp} ${t.written}.`);
        }
        return Unit.of(lookupUnitDef(t.name));
      case 'UMul': return this.evalUnit(t.l, env).mul(this.evalUnit(t.r, env));
      case 'UDiv': return this.evalUnit(t.l, env).div(this.evalUnit(t.r, env));
      case 'UPow': return this.evalUnit(t.base, env).pow(t.p);
      default: throw err('SyntaxError', 'bad unit');
    }
  }
  inEnv(name, env) { for (let e = env; e; e = e.parent) if (e.vars.has(name)) return true; return false; }

  compare(op, l, r) {
    if (op === 'is') return l === r || (l === null && r === null);
    if (op === 'is not') return !(l === r || (l === null && r === null));
    if (op === 'in' || op === 'not in') {
      let found;
      if (r instanceof Tuple) found = r.items.some((x) => truth(binop('==', x, l)));
      else if (r instanceof Str && l instanceof Str) found = r.s.includes(l.s);
      else if (r instanceof NDArray || r instanceof Quantity) {
        const eq = binop('==', r, l);
        found = eq instanceof NDArray ? eq.data.some((x) => x) : truth(eq);
      } else throw err('TypeError', `argument of type '${typeName(r)}' is not iterable`);
      return op === 'in' ? found : !found;
    }
    return binop(op, l, r);
  }

  evalIndex(node, env) {
    const one = (n) => (n.type === 'SliceN'
      ? new Slice(n.lo && this.eval(n.lo, env), n.hi && this.eval(n.hi, env), n.step && this.eval(n.step, env))
      : this.eval(n, env));
    if (node.type === 'Tuple') return new Tuple(node.elts.map(one));
    return one(node);
  }

  convert(v, targetNode, env) {
    if (targetNode.type === 'Name' && SPECIAL_TARGETS.includes(targetNode.id) &&
        !this.vars.has(targetNode.id) && !(env && this.inEnv(targetNode.id, env))) {
      const k = targetNode.id;
      if (k === 'si' || k === 'cgs') return toSystem(v, k);
      return sexagesimal(v, k);
    }
    let t = this.eval(targetNode, env);
    if (t instanceof Quantity && !t.meta && !(t.value instanceof NDArray) && t.value === 1) t = t.unit;
    if (t instanceof Quantity && !(t.value instanceof NDArray)) {
      // A quantity target such as c.R_sun or (2 km): express v in multiples of it.
      const r = convert(v, t.unit);
      return binop('/', r instanceof Quantity ? r.value : r, t.value);
    }
    return convert(v, t);
  }

  makeLambda(node, env) {
    const defaults = node.params.map((p) => (p.dflt ? this.eval(p.dflt, env) : undefined));
    const params = node.params.map((p, i) => ({ name: p.name, opt: defaults[i] !== undefined }));
    const sig = `<lambda>(${node.params.map((p, i) => (defaults[i] !== undefined ? `${p.name}=${repr(defaults[i])}` : p.name)).join(', ')})`;
    return new Func('<lambda>', sig, null, (args, kwargs) => {
      const vals = bindArgs('<lambda>', params, args, kwargs);
      const local = { vars: new Map(), parent: env };
      params.forEach((p, i) => local.vars.set(p.name, vals[i] === undefined ? defaults[i] : vals[i]));
      return this.eval(node.body, local);
    }, { kind: 'lambda', params });
  }

  call(f, args, kwargs) {
    if (!(f instanceof Func)) {
      if (f instanceof Unit) throw err('TypeError', "'Unit' object is not callable");
      throw err('TypeError', `'${typeName(f)}' object is not callable`);
    }
    if (++this.depth > 200) { this.depth = 0; throw err('RecursionError', 'maximum recursion depth exceeded'); }
    try {
      const r = f.impl(args, kwargs, this);
      return r === undefined ? null : r;
    } finally { this.depth = Math.max(0, this.depth - 1); }
  }

  method(self, name, builtinName) {
    const fn = BUILTINS.get(builtinName);
    return new Func(name, fn.sig.replace(/^\w+\((a|x|number|object)(, )?/, `${name}(`), fn.doc, (args, kwargs) => {
      if (name === 'reshape' && args.length > 1) args = [new Tuple(args)];
      return fn.impl([self, ...args], kwargs, this);
    }, { kind: 'method' });
  }

  getAttr(v, name) {
    if (v instanceof Namespace) return v.get(name);
    if (v instanceof Quantity) {
      switch (name) {
        case 'value': return v.value instanceof NDArray ? toFloatValue(v.value) : v.value;
        case 'unit': return v.unit;
        case 'si': case 'cgs': return toSystem(v, name);
        case 'decompose': return new Func('decompose', 'decompose()', 'Return the quantity in SI base units (like x -> si).', () => toSystem(v, 'si'), { kind: 'method' });
        case 'to': return new Func('to', 'to(unit, equivalencies=None)', 'astropy-style conversion with a unit object, e.g. x.to(y.unit); for named units write x -> km.', (args, kwargs) => {
          const [unit] = bindArgs('to', [{ name: 'unit' }, { name: 'equivalencies', opt: true }], args, kwargs);
          return convert(v, unit instanceof Quantity ? unit.unit : unit);
        }, { kind: 'method' });
        case 'name': if (v.meta) return new Str(v.meta.long); break;
        case 'uncertainty': if (v.meta) return new Quantity(v.meta.unc, v.unit); break;
        case 'reference': if (v.meta) return new Str(v.meta.ref); break;
        case 'physical_type': return new Str(v.unit.physicalType, true);
        default:
          if (v.value instanceof NDArray) {
            if (name === 'T') return new Quantity(transpose(v.value), v.unit);
            if (['shape', 'size', 'ndim'].includes(name)) return this.getAttr(v.value, name);
            if (name in METHODS) return this.method(v, name, METHODS[name]);
          }
      }
      throw err('AttributeError', `'Quantity' object has no attribute '${name}'`);
    }
    if (v instanceof NDArray) {
      switch (name) {
        case 'shape': return new Tuple(v.shape.map((n) => BigInt(n)));
        case 'size': return BigInt(v.size);
        case 'ndim': return BigInt(v.ndim);
        case 'T': return transpose(v);
        case 'dtype': return new Str({ int: 'int64', float: 'float64', bool: 'bool' }[v.dtype], true);
        default: if (name in METHODS) return this.method(v, name, METHODS[name]);
      }
      throw err('AttributeError', `'numpy.ndarray' object has no attribute '${name}'`);
    }
    if (v instanceof Unit) {
      switch (name) {
        case 'si': case 'cgs': return toSystem(v, name);
        case 'physical_type': return new Str(v.physicalType, true);
        case 'decompose': return new Func('decompose', 'decompose()', 'Return the unit in SI base units.', () => toSystem(v, 'si'), { kind: 'method' });
        case 'to': return new Func('to', 'to(other, value=1.0)', 'Return the factor that converts values in this unit to other (another unit object).', (args, kwargs) => {
          const [other, value] = bindArgs('to', [{ name: 'other' }, { name: 'value', opt: true }], args, kwargs);
          const r = convert(new Quantity(value === undefined ? 1 : toFloatValue(value), v), other);
          return r instanceof Quantity ? r.value : r;
        }, { kind: 'method' });
        case 'scale': return v.scale;
        default:
      }
      throw err('AttributeError', `'Unit' object has no attribute '${name}'`);
    }
    if (v instanceof Func) {
      if (name === '__doc__') return v.doc ? new Str(v.doc) : null;
      if (name === '__name__') return new Str(v.name);
    }
    if (typeof v === 'number' && (name === 'real')) return v;
    if (typeof v === 'bigint' && name === 'bit_length') {
      return new Func('bit_length', 'bit_length()', 'Number of bits necessary to represent self in binary.', () => BigInt((v < 0n ? -v : v).toString(2).replace(/^0$/, '').length), { kind: 'method' });
    }
    throw err('AttributeError', `'${typeName(v)}' object has no attribute '${name}'`);
  }

  // ---- statements ------------------------------------------------------------------------

  assign(target, value) {
    switch (target.type) {
      case 'Name':
        this.vars.set(target.id, value);
        return;
      case 'Subscript':
        setItem(this.eval(target.value), this.evalIndex(target.index), value);
        return;
      case 'Tuple': {
        let items;
        if (value instanceof Tuple) items = value.items;
        else if (value instanceof NDArray && value.ndim > 0) items = Array.from({ length: value.shape[0] }, (_, i) => getItem(value, BigInt(i)));
        else if (value instanceof Quantity && value.value instanceof NDArray) items = Array.from({ length: value.value.shape[0] }, (_, i) => getItem(value, BigInt(i)));
        else throw err('TypeError', `cannot unpack non-iterable ${typeName(value)} object`);
        const n = target.elts.length;
        if (items.length > n) throw err('ValueError', `too many values to unpack (expected ${n})`);
        if (items.length < n) throw err('ValueError', `not enough values to unpack (expected ${n}, got ${items.length})`);
        target.elts.forEach((t, i) => this.assign(t, items[i]));
        return;
      }
      default: throw err('SyntaxError', 'cannot assign to expression');
    }
  }

  exec(stmt) {
    switch (stmt.type) {
      case 'Expr': return this.eval(stmt.value);
      case 'Assign': {
        const v = this.eval(stmt.value);
        for (const t of stmt.targets) this.assign(t, v);
        return undefined;
      }
      case 'AugAssign': {
        const cur = this.eval(stmt.target);
        this.assign(stmt.target, binop(stmt.op, cur, this.eval(stmt.value)));
        return undefined;
      }
      case 'Del':
        for (const t of stmt.targets) {
          if (t.type !== 'Name') throw err('TypeError', 'only names can be deleted here');
          if (!this.vars.delete(t.id)) throw this.nameError(t.id);
        }
        return undefined;
      default: throw err('SyntaxError', 'unsupported statement');
    }
  }

  // ---- REPL entry point ------------------------------------------------------------------

  print(text) { this.records.push({ kind: 'text', text }); }
  str(v) { return str(v); }

  /** Run one cell of input. Returns {n, records: [{kind: 'out'|'err'|'text'|'clear', text}]}. */
  run(src) {
    const text = src.replace(/\s+$/, '').replace(/^\n+/, '');
    this.records = [];
    if (!text.trim()) return { n: null, records: [] };
    const n = this.n++;
    this.inputs.push([n, text]);
    this.depth = 0;
    try {
      if (!this.tryHelp(text) && !this.tryMagic(text)) {
        const stmts = parse(text);
        let last;
        stmts.forEach((s, i) => {
          const v = this.exec(s);
          if (i === stmts.length - 1 && s.type === 'Expr' && !s.silent) last = v;
        });
        if (last !== undefined && last !== null) {
          this.records.push({ kind: 'out', n, text: repr(last) });
          this.outs.set('___', this.outs.get('__'));
          this.outs.set('__', this.outs.get('_'));
          this.outs.set('_', last);
          this.outs.set(`_${n}`, last);
          for (const k of ['__', '___']) if (this.outs.get(k) === undefined) this.outs.delete(k);
        }
      }
    } catch (e) {
      this.records.push({ kind: 'err', text: this.formatError(e, text) });
    }
    return { n, records: this.records };
  }

  formatError(e, text) {
    if (!(e instanceof PyError)) {
      if (e instanceof UnitConversionError) return `UnitConversionError: ${e.message}`;
      if (e instanceof RangeError) return `MemoryError: ${e.message}`;
      console.error(e);
      return `InternalError: ${e.message}`;
    }
    if (e.pyType === 'SyntaxError' && e.pos !== undefined) {
      const before = text.slice(0, e.pos), lineNo = before.split('\n').length;
      const line = text.split('\n')[lineNo - 1], col = e.pos - (before.lastIndexOf('\n') + 1);
      return `  Cell In[${this.n - 1}], line ${lineNo}\n    ${line}\n    ${' '.repeat(col)}^\nSyntaxError: ${e.message}`;
    }
    return `${e.pyType}: ${e.message}`;
  }

  // ---- help --------------------------------------------------------------------------------

  tryHelp(text) {
    const t = text.trim();
    if (t === '?' || t === '??' || t === 'help' || t === 'help()') { this.print(HELP); return true; }
    let m = /^\?{1,2}\s*(.+?)$/.exec(t) ?? /^(.+?)\s*\?{1,2}$/.exec(t);
    if (!m || t.includes('\n')) return false;
    const target = m[1];
    if (/^%\w+$/.test(target)) {
      const name = target.slice(1);
      this.print(MAGICS[name] ? `%${name}: ${MAGICS[name]}` : `Object \`${target}\` not found.`);
      return true;
    }
    m = /^[A-Za-z_]\w*(\.[A-Za-z_]\w*)*$/.exec(target);
    if (!m) { this.print(`Object \`${target}\` not found.`); return true; }
    let v;
    try {
      const parts = target.split('.');
      v = parts.slice(1).reduce((o, p) => this.getAttr(o, p), this.lookup(parts[0]));
    } catch (e) {
      if (!(e instanceof PyError)) throw e;
      if (MAGICS[target]) { this.print(`%${target}: ${MAGICS[target]}`); return true; }
      const un = !target.includes('.') && unitName(target);
      if (un) { this.print(this.info(Unit.of(lookupUnitDef(un.name)).pow(un.p), target).s); return true; }
      if (PYKEYWORDS.includes(target) || target === 'to') { this.print(this.keywordHelp(target)); return true; }
      this.print(`Object \`${target}\` not found.`);
      return true;
    }
    this.print(this.info(v, target).s);
    return true;
  }

  keywordHelp(k) {
    if (k === 'to') return '"to" is the same as ->: converts everything on its left to the unit on its right.\n  60 mi / h to km / h';
    if (k === 'lambda') return 'lambda params: expression\nA one-line function, e.g. f = lambda x, n=2: x**n';
    return `"${k}" is a Python keyword.`;
  }

  helpFor(o) {
    if (o === undefined || o === null) return new Str(HELP, true);
    return this.info(o, null);
  }

  /** IPython-style ? output for a value. */
  info(v, name) {
    const lines = [];
    const add = (k, val) => lines.push(`${(`${k}:`).padEnd(15)}${val}`);
    if (v instanceof Func) {
      add('Signature', v.kind === 'lambda' && name ? v.sig.replace('<lambda>', name) : v.sig);
      if (v.doc) lines.push(`Docstring:\n${v.doc}`);
      add('Type', typeName(v));
    } else if (v instanceof Namespace) {
      add('Type', 'module');
      lines.push(`Docstring:\n${v.doc}`);
    } else if (v instanceof Unit) {
      const def = v.parts.length === 1 && v.parts[0][1] === 1 && v.factor === 1 ? v.parts[0][0] : null;
      add('Unit', `${v}${def ? `  (${def.long})` : ''}`);
      add('Physical type', v.physicalType);
      if (!v.isUnscaledDimensionless) {
        const { factor, unit } = decomposeUnit(v, 'si');
        add('In SI', new Unit(unit.parts, factor).toString() || '1');
      }
      if (def?.offset) add('Zero point', `${fmtG(-def.offset / def.scale, 10)} ${def.name} = 0 K (applied by ->)`);
      const base = def?.base ?? def;
      if (base) {
        const names = base.aliases.filter((a) => a !== def?.name);
        if (!def?.base && names.length) add('Aliases', names.join(', '));
        if (base.prefix) add('Prefixes', base.prefix === 'bin' ? 'SI and binary (kB, MiB)' : `SI (k${base.name}, m${base.name}, ...)`);
        if (isImperial(base.name)) add('Note', 'imperial unit (astropy.units.imperial)');
      }
    } else if (v instanceof Quantity && v.meta) {
      lines.push(`  Name   = ${v.meta.long}`, `  Value  = ${fmtFloat(v.value)}`, `  Uncertainty  = ${fmtFloat(v.meta.unc)}`,
        `  Unit  = ${v.unit}`, `  Reference = ${v.meta.ref}`);
    } else {
      add('Type', typeName(v));
      let s = repr(v);
      if (s.length > 400) s = `${s.slice(0, 400)}…`;
      add('String form', s.includes('\n') ? `\n${s}` : s);
      if (v instanceof Quantity) {
        add('Physical type', v.unit.physicalType);
        if (v.value instanceof NDArray) add('Shape', `(${v.value.shape.join(', ')}${v.value.ndim === 1 ? ',' : ''})`);
      }
      if (v instanceof NDArray) {
        add('Shape', `(${v.shape.join(', ')}${v.ndim === 1 ? ',' : ''})`);
        add('dtype', { int: 'int64', float: 'float64', bool: 'bool' }[v.dtype]);
      }
      if (name && name in MATH_CONSTANTS && !this.vars.has(name)) lines.push(`Docstring:\n${MATH_CONSTANTS[name][1]}`);
    }
    return new Str(lines.join('\n'), true);
  }

  // ---- magics ------------------------------------------------------------------------------

  tryMagic(text) {
    const t = text.trim();
    let m = /^%(\w+)\s*(.*)$/s.exec(t);
    if (!m) {
      // Automagic: "who", "precision 3" when no variable has that name.
      const a = /^(\w+)(?:\s+([^=([.+\-*/%<>!&|^,].*))?$/s.exec(t);
      if (a && a[1] in MAGICS && !this.vars.has(a[1]) && a[1] !== 'help') m = a;
      else return false;
    }
    const [, name, arg = ''] = m;
    const fn = this[`magic_${name === 'hist' ? 'history' : name}`];
    if (!fn) {
      this.records.push({ kind: 'err', text: `UsageError: Line magic function \`%${name}\` not found. Try %lsmagic.` });
      return true;
    }
    fn.call(this, arg.trim());
    return true;
  }

  userVars() { return [...this.vars.keys()].sort(); }
  magic_who() {
    const v = this.userVars();
    this.print(v.length ? v.join('\t') : 'Interactive namespace is empty.');
  }
  magic_whos() {
    const v = this.userVars();
    if (!v.length) { this.print('Interactive namespace is empty.'); return; }
    const rows = v.map((k) => {
      const val = this.vars.get(k);
      let info = repr(val).replace(/\s*\n\s*/g, ' ');
      if (val instanceof NDArray) info = `${val.shape.join('x') || 'scalar'}: ${val.size} elems, type \`${{ int: 'int64', float: 'float64', bool: 'bool' }[val.dtype]}\``;
      if (info.length > 60) info = `${info.slice(0, 57)}...`;
      return [k, typeName(val), info];
    });
    const w0 = Math.max(8, ...rows.map((r) => r[0].length)) + 3, w1 = Math.max(4, ...rows.map((r) => r[1].length)) + 3;
    const head = `${'Variable'.padEnd(w0)}${'Type'.padEnd(w1)}Data/Info`;
    this.print([head, '-'.repeat(head.length + 10), ...rows.map(([a, b, c]) => `${a.padEnd(w0)}${b.padEnd(w1)}${c}`)].join('\n'));
  }
  magic_reset() {
    this.vars.clear();
    this.outs.clear();
    this.print('All variables deleted.');
  }
  magic_precision(arg) {
    if (!arg) { display.precision = null; this.print('Float display: full precision (repr)'); return; }
    let m = /^\d+$/.exec(arg);
    if (m) display.precision = { kind: 'f', n: Math.min(17, Number(arg)) };
    else if ((m = /^%\.(\d+)([efg])$/.exec(arg))) display.precision = { kind: m[2], n: Math.min(17, Number(m[1])) };
    else {
      this.records.push({ kind: 'err', text: `ValueError: Precision must be an integer or a format string like %.3e, not ${JSON.stringify(arg)}` });
      return;
    }
    this.print(`Float display: '%.${display.precision.n}${display.precision.kind}'`);
  }
  magic_history() {
    this.print(this.inputs.slice(0, -1).map(([n, t]) => `${String(n).padStart(4)}: ${t.replace(/\n/g, '\n      ')}`).join('\n') || 'No history yet.');
  }
  magic_clear() { this.records.push({ kind: 'clear' }); }
  magic_lsmagic() {
    this.print(`Available line magics:\n${Object.keys(MAGICS).map((k) => `%${k}`).join('  ')}\n\nAutomagic is ON, % prefix IS NOT needed for line magics.`);
  }
  magic_quickref() { this.print(HELP); }
  magic_units(arg) {
    const q = arg.toLowerCase();
    const groups = new Map();
    for (const d of unitDefs()) {
      const type = d.offset || d.name === 'deg_R' ? 'temperature' : Unit.of(d).physicalType;
      const hay = [...d.aliases, d.long, type].join(' ').toLowerCase();
      if (q && !hay.includes(q)) continue;
      const g = groups.get(d.group) ?? [];
      g.push(`  ${d.aliases.join(', ').padEnd(28)} ${d.long}${d.prefix ? ' [prefixes]' : ''} — ${type}`);
      groups.set(d.group, g);
    }
    if (!groups.size) {
      const d = lookupUnitDef(arg);
      this.print(d ? this.info(Unit.of(d), arg).s : `No units match "${arg}".`);
      return;
    }
    const out = [...groups].map(([g, l]) => `${g}:\n${l.join('\n')}`);
    if (!q) out.push('[prefixes]: SI prefixes Q R Y Z E P T G M k h da d c m u n p f a z y r q (GHz, mJy, kpc, Gyr);\nbytes and bits also take Ki Mi Gi Ti Pi Ei (MiB). Powers: m**2, m^2 or m2.');
    this.print(out.join('\n'));
  }
  magic_consts() {
    this.print(Object.values(CONST_VALUES).map((c) => `  ${c.meta.name.padEnd(9)} ${`${fmtG(c.value, 10)} ${c.unit}`.padEnd(30)} ${c.meta.long}`).join('\n'));
  }

  // ---- completion --------------------------------------------------------------------------

  /** Candidates for the word ending at `cursor`: {start, items, labels?}. */
  complete(src, cursor = src.length) {
    const before = src.slice(0, cursor);
    const tex = latexComplete(before);
    if (tex) return tex;
    const m = /(%?)([A-Za-z_][\w]*(?:\.[A-Za-z_]\w*)*\.?|)$/.exec(before);
    const word = m[0], start = cursor - word.length;
    if (m[1] === '%') {
      const p = word.slice(1);
      return { start, items: Object.keys(MAGICS).filter((k) => k.startsWith(p)).map((k) => `%${k}`) };
    }
    if (word.includes('.')) {
      const base = word.slice(0, word.lastIndexOf('.')), part = word.slice(word.lastIndexOf('.') + 1);
      let obj;
      try { obj = base.split('.').slice(1).reduce((o, p) => this.getAttr(o, p), this.lookup(base.split('.')[0])); } catch { return { start, items: [] }; }
      const names = this.attrNames(obj).filter((n) => n.startsWith(part));
      return { start, items: names.map((n) => `${base}.${n}`) };
    }
    if (!word) return { start, items: [] };
    const ctx = this.unitContext(before.slice(0, start));
    if (ctx) {
      const units = unitNames().filter((n) => n.startsWith(word));
      return { start, items: [...(ctx === 'target' ? SPECIAL_TARGETS.filter((n) => n.startsWith(word)) : []), ...units] };
    }
    const pool = new Set([...this.vars.keys(), ...BUILTINS.keys(), ...Object.keys(MATH_CONSTANTS), 'c', ...PYKEYWORDS,
      ...(start === 0 ? Object.keys(MAGICS) : [])]);
    return { start, items: [...pool].filter((n) => n.startsWith(word)).sort() };
  }

  /** Is a word typed after `text` in unit position? 'unit', 'target' (after ->), or null. */
  unitContext(text) {
    let toks;
    try { toks = tokenize(text).filter((k) => k.t !== 'eof' && k.t !== 'nl'); } catch { return null; }
    let i = toks.length - 1;
    const isOp = (k, ...v) => k && k.t === 'op' && v.includes(k.v);
    // Walk back over a unit chunk in progress: km / (kg s2 ...
    let chunk = false;
    while (i >= 0 && ((toks[i].t === 'name' && unitName(toks[i].v)) || isOp(toks[i], '*', '/', '(', '**', '^') ||
      (toks[i].t === 'num' && isOp(toks[i - 1], '**', '^')))) {
      if (toks[i].t === 'num') i--;
      chunk = true;
      i--;
    }
    const k = toks[i];
    if (!k) return null;
    if (isOp(k, '->') || (k.t === 'name' && k.v === 'to')) return 'target';
    if (k.t === 'num' || isOp(k, ')', ']')) {
      // Directly after a number: juxtaposition. Inside a chunk, it must have started with a unit name.
      return !chunk || (toks[i + 1]?.t === 'name') ? 'unit' : null;
    }
    return null;
  }

  attrNames(v) {
    if (v instanceof Namespace) return v.keys();
    const arr = ['shape', 'size', 'ndim', 'T', ...Object.keys(METHODS)];
    if (v instanceof Quantity) {
      return ['value', 'unit', 'si', 'cgs', 'to', 'decompose', 'physical_type', ...(v.meta ? ['name', 'uncertainty', 'reference'] : []),
        ...(v.value instanceof NDArray ? arr : [])];
    }
    if (v instanceof NDArray) return [...arr, 'dtype'];
    if (v instanceof Unit) return ['si', 'cgs', 'to', 'decompose', 'physical_type', 'scale'];
    return [];
  }
}

export { asArray, isNum, converter };
