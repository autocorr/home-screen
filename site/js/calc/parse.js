// Tokenizer and parser for the calculator's Python subset, plus units:
//
// - A unit chunk follows a number, `)` or `]` directly: `3 km`, `9.8 m / s**2`,
//   `1 kg m / s^2`, `[1, 2] km`, `(x) m`. It runs over unit names joined by spaces,
//   `*` and `/`, with powers (`**`, `^`, or astropy's `s2`), and `/ (kg s2)` groups.
//   Inside a chunk, names are always units; anywhere else they are ordinary names.
// - `expr -> unit` (or `expr to unit`) converts; the target is a unit chunk too.
//   It binds more loosely than anything else.
import { err } from './values.js';
import { lookupUnitDef } from './units.js';

/** {name, p} if `name` is a unit, or a unit with an astropy-style power suffix (s2, m3). */
export function unitName(name) {
  if (/^[μµ]./.test(name)) name = `u${name.slice(1)}`;  // μm, µs: the micro prefix
  if (lookupUnitDef(name)) return { name, p: 1 };
  const m = /^(.*?[A-Za-z_])([2-9])$/.exec(name);
  if (m && lookupUnitDef(m[1])) return { name: m[1], p: Number(m[2]) };
  return null;
}

const KEYWORDS = new Set(['and', 'or', 'not', 'if', 'else', 'lambda', 'True', 'False', 'None', 'del', 'in', 'is',
  'for', 'while', 'def', 'class', 'import', 'from', 'return', 'pass', 'with', 'try', 'except', 'global', 'yield']);
const OPS = ['**=', '//=', '>>=', '<<=', '->', '**', '//', '==', '!=', '<=', '>=', '<<', '>>', '+=', '-=', '*=', '/=',
  '%=', '@=', '&=', '|=', '^=', '+', '-', '*', '/', '%', '@', '<', '>', '=', '(', ')', '[', ']', '{', '}', ',', ':',
  '.', ';', '~', '&', '|', '^', '√'];
const NUM_RE = /^(?:0[xX][0-9a-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?)[jJ]?/;
const NAME_RE = /^[\p{L}_][\p{L}\p{N}_]*/u;
const SUPERSCRIPT = { '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9', '⁻': '-', '⁺': '+' };

export function syntaxError(msg, pos) {
  const e = err('SyntaxError', msg);
  e.pos = pos;
  return e;
}

export function tokenize(src) {
  // Typographic operators that tend to arrive by paste.
  src = src.replace(/[×·]/g, '*').replace(/÷/g, '/').replace(/[−–]/g, '-').replace(/→/g, '->')
    .replace(/°\s*C\b/g, ' deg_C').replace(/°\s*F\b/g, ' deg_F').replace(/°/g, ' deg')
    .replace(/[ÅÅ]/g, ' Angstrom').replace(/≤/g, '<=').replace(/≥/g, '>=').replace(/≠/g, '!=')
    .replace(/∞/g, 'inf').replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹⁻⁺]+/g, (s) => `**${[...s].map((ch) => SUPERSCRIPT[ch]).join('')}`);
  const toks = [];
  let i = 0, depth = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
    if (c === '\\' && src[i + 1] === '\n') { i += 2; continue; }
    if (c === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '\n') {
      if (depth === 0) toks.push({ t: 'nl', v: '\n', pos: i });
      i++; continue;
    }
    const rest = src.slice(i);
    let m = NUM_RE.exec(rest);
    if (m && /[\d.]/.test(c) && !(c === '.' && !/\d/.test(src[i + 1] ?? ''))) {
      const text = m[0];
      if (/[jJ]$/.test(text)) throw syntaxError('complex numbers are not supported', i);
      const clean = text.replace(/_/g, '');
      const isFloat = !/^0[xXoObB]/.test(clean) && /[.eE]/.test(clean);
      toks.push({ t: 'num', v: isFloat ? Number(clean) : BigInt(clean), pos: i, text });
      i += text.length; continue;
    }
    m = NAME_RE.exec(rest);
    if (m) {
      // Python normalises identifiers (NFKC): ϵ and ε, x₁ and x1, µ and μ are the same name.
      const v = m[0].normalize('NFKC');
      toks.push({ t: KEYWORDS.has(v) ? 'kw' : 'name', v, pos: i });
      i += m[0].length; continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1, s = '';
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\' && j + 1 < src.length) {
          const e = src[j + 1];
          s += { n: '\n', t: '\t', '\\': '\\', "'": "'", '"': '"' }[e] ?? `\\${e}`;
          j += 2;
        } else if (src[j] === '\n') break;
        else s += src[j++];
      }
      if (src[j] !== c) throw syntaxError('unterminated string literal', i);
      toks.push({ t: 'str', v: s, pos: i });
      i = j + 1; continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (op) {
      if ('([{'.includes(op)) depth++;
      if (')]}'.includes(op)) depth = Math.max(0, depth - 1);
      toks.push({ t: 'op', v: op, pos: i });
      i += op.length; continue;
    }
    if (c === '?') throw syntaxError("'?' is only for help: put it before or after a name, e.g. sin? or ?u.km", i);
    if (c === '!') throw syntaxError("invalid syntax ('!' shell commands are not available)", i);
    throw syntaxError(`invalid character '${c}'`, i);
  }
  toks.push({ t: 'eof', v: '', pos: src.length });
  return toks;
}

const AUG = new Set(['+=', '-=', '*=', '/=', '//=', '%=', '**=', '@=', '&=', '|=', '^=', '<<=', '>>=']);
const COMP = new Set(['<', '>', '==', '>=', '<=', '!=']);
const UNSUPPORTED_KW = new Set(['for', 'while', 'def', 'class', 'import', 'from', 'return', 'pass', 'with', 'try', 'except', 'global', 'yield']);

class Parser {
  constructor(src) { this.toks = tokenize(src); this.i = 0; }
  get peek() { return this.toks[this.i]; }
  next() { return this.toks[this.i++]; }
  is(t, v) { const k = this.peek; return k.t === t && (v === undefined || k.v === v); }
  isOp(v) { return this.is('op', v); }
  isKw(v) { return this.is('kw', v); }
  accept(t, v) { if (this.is(t, v)) return this.next(); return null; }
  expect(t, v, what) {
    if (this.is(t, v)) return this.next();
    const k = this.peek;
    if (k.t === 'eof') throw syntaxError(`incomplete input: expected ${what ?? `'${v}'`}`, k.pos);
    throw syntaxError(`invalid syntax: expected ${what ?? `'${v}'`}`, k.pos);
  }
  fail(k = this.peek) {
    if (k.t === 'eof') throw syntaxError('incomplete input', k.pos);
    if (k.t === 'kw' && UNSUPPORTED_KW.has(k.v)) throw syntaxError(`'${k.v}' statements are not supported in this calculator`, k.pos);
    if (k.t === 'op' && k.v === '{') throw syntaxError('dicts and sets are not supported', k.pos);
    throw syntaxError('invalid syntax', k.pos);
  }

  // program: statement ((';' | NEWLINE) statement)*
  program() {
    const stmts = [];
    while (!this.is('eof')) {
      if (this.accept('nl') || this.accept('op', ';')) continue;
      const s = this.statement();
      s.silent = this.isOp(';') && this.toks.slice(this.i + 1).every((k) => k.t === 'nl' || k.t === 'eof' || (k.t === 'op' && k.v === ';'));
      stmts.push(s);
      if (!this.is('eof') && !this.is('nl') && !this.isOp(';')) {
        if (this.is('name') && unitName(this.peek.v)) {
          throw syntaxError(`a unit goes right after a number or a closing bracket: write 1 ${this.peek.v}, or (x) ${this.peek.v} for a variable x`, this.peek.pos);
        }
        this.fail();
      }
    }
    return stmts;
  }

  statement() {
    const start = this.peek.pos;
    if (this.accept('kw', 'del')) {
      const targets = [this.postfix()];
      while (this.accept('op', ',')) targets.push(this.postfix());
      targets.forEach((t) => this.checkTarget(t, 'delete'));
      return { type: 'Del', targets, pos: start };
    }
    const first = this.exprList();
    if (this.isOp('=')) {
      const targets = [first];
      let value;
      while (this.accept('op', '=')) {
        value = this.exprList();
        if (this.isOp('=')) targets.push(value);
      }
      targets.forEach((t) => this.checkTarget(t, 'assign to'));
      return { type: 'Assign', targets, value, pos: start };
    }
    if (this.is('op') && AUG.has(this.peek.v)) {
      const op = this.next().v.slice(0, -1);
      if (first.type !== 'Name' && first.type !== 'Subscript') throw syntaxError(`'${describe(first)}' is an illegal expression for augmented assignment`, first.pos);
      return { type: 'AugAssign', target: first, op, value: this.exprList(), pos: start };
    }
    return { type: 'Expr', value: first, pos: start };
  }

  checkTarget(t, verb) {
    if (t.type === 'Name' || t.type === 'Subscript') return;
    if (t.type === 'Tuple' && verb !== 'delete') { t.elts.forEach((e) => this.checkTarget(e, verb)); return; }
    if (t.type === 'Attr') throw syntaxError(`cannot ${verb} attribute '${t.name}' here`, t.pos);
    throw syntaxError(`cannot ${verb} ${describe(t)}`, t.pos);
  }

  // exprList: conv (',' conv)* [','] -> Tuple when there is a comma
  exprList() {
    const pos = this.peek.pos;
    const first = this.conv();
    if (!this.isOp(',')) return first;
    const elts = [first];
    while (this.accept('op', ',')) {
      if (this.atExprEnd()) break;
      elts.push(this.conv());
    }
    return { type: 'Tuple', elts, pos };
  }
  atExprEnd() {
    const k = this.peek;
    return k.t === 'eof' || k.t === 'nl' || (k.t === 'op' && [')', ']', ';', '='].includes(k.v)) || (k.t === 'op' && AUG.has(k.v));
  }

  // conv: lambda | test (('->' | 'to') test)*
  conv() {
    if (this.isKw('lambda')) return this.lambda();
    let left = this.test();
    for (;;) {
      const k = this.peek;
      if ((k.t === 'op' && k.v === '->') || (k.t === 'name' && k.v === 'to')) {
        this.next();
        if (this.atExprEnd() || this.isOp(',')) throw syntaxError(`expected a unit after '${k.v}'`, this.peek.pos);
        left = { type: 'Convert', value: left, target: this.target(), pos: k.pos };
      } else return left;
    }
  }

  lambda() {
    const pos = this.next().pos;
    const params = [];
    while (!this.isOp(':')) {
      const name = this.expect('name', undefined, 'a parameter name').v;
      let dflt = null;
      if (this.accept('op', '=')) dflt = this.test();
      params.push({ name, dflt });
      if (!this.accept('op', ',')) break;
    }
    this.expect('op', ':');
    return { type: 'Lambda', params, body: this.conv(), pos };
  }

  test() {
    const pos = this.peek.pos;
    const body = this.orTest();
    if (this.isKw('if')) {
      this.next();
      const cond = this.orTest();
      this.expect('kw', 'else', "'else'");
      return { type: 'IfExp', test: cond, body, orelse: this.isKw('lambda') ? this.lambda() : this.test(), pos };
    }
    return body;
  }
  orTest() {
    let l = this.andTest();
    while (this.isKw('or')) { const pos = this.next().pos; l = { type: 'BoolOp', op: 'or', l, r: this.andTest(), pos }; }
    return l;
  }
  andTest() {
    let l = this.notTest();
    while (this.isKw('and')) { const pos = this.next().pos; l = { type: 'BoolOp', op: 'and', l, r: this.notTest(), pos }; }
    return l;
  }
  notTest() {
    if (this.isKw('not')) { const pos = this.next().pos; return { type: 'Unary', op: 'not', v: this.notTest(), pos }; }
    return this.comparison();
  }
  comparison() {
    const pos = this.peek.pos;
    const first = this.bitOr();
    const ops = [], operands = [first];
    for (;;) {
      const k = this.peek;
      let op = null;
      if (k.t === 'op' && COMP.has(k.v)) { this.next(); op = k.v; } else if (k.t === 'kw' && k.v === 'in') { this.next(); op = 'in'; } else if (k.t === 'kw' && k.v === 'not' && this.toks[this.i + 1].t === 'kw' && this.toks[this.i + 1].v === 'in') {
        this.i += 2; op = 'not in';
      } else if (k.t === 'kw' && k.v === 'is') {
        this.next(); op = this.accept('kw', 'not') ? 'is not' : 'is';
      }
      if (!op) break;
      ops.push(op); operands.push(this.bitOr());
    }
    return ops.length ? { type: 'Compare', ops, operands, pos } : first;
  }
  binLevel(next, ops) {
    let l = next();
    while (this.is('op') && ops.includes(this.peek.v)) {
      const k = this.next();
      l = { type: 'BinOp', op: k.v, l, r: next(), pos: k.pos };
    }
    return l;
  }
  bitOr() { return this.binLevel(() => this.bitXor(), ['|']); }
  bitXor() { return this.binLevel(() => this.bitAnd(), ['^']); }
  bitAnd() { return this.binLevel(() => this.shift(), ['&']); }
  shift() { return this.binLevel(() => this.arith(), ['<<', '>>']); }
  arith() { return this.binLevel(() => this.term(), ['+', '-']); }
  term() { return this.binLevel(() => this.withUnit(this.factor()), ['*', '/', '//', '%', '@']); }

  // ---- units ---------------------------------------------------------------------------

  /** Is the token at i a unit name usable in a chunk (not a call, attribute or index)? */
  unitAt(i = this.i) {
    const k = this.toks[i], n = this.toks[i + 1];
    if (k.t !== 'name' || !unitName(k.v)) return false;
    return !(n.t === 'op' && ['(', '.', '['].includes(n.v));
  }
  /** Attach a unit chunk to a number-like operand: 3 km, (x) m, [1, 2] km, 2**3 m. */
  withUnit(node) {
    if (!this.unitAt() || !numberLike(node)) return node;
    const unit = this.unitChunk();
    return { type: 'BinOp', op: '*', l: node, r: unit, pos: unit.pos };
  }
  /** Conversion target: a unit chunk, `1 / unit`, or an ordinary expression (si, c.R_sun, x.unit). */
  target() {
    this.inTarget = true;
    try { return this.targetInner(); } finally { this.inTarget = false; }
  }
  targetInner() {
    if (this.unitAt()) return this.unitChunk();
    if (this.is('num') && this.peek.v == 1 && this.toks[this.i + 1].t === 'op' && this.toks[this.i + 1].v === '/' && (this.unitAt(this.i + 2) || this.unitGroupAt(this.i + 2))) {
      const pos = this.next().pos;
      this.next();
      return { type: 'Unit', tree: { type: 'UDiv', l: { type: 'UOne' }, r: this.unitFactorAfterSlash() }, pos };
    }
    return this.test();
  }
  unitGroupAt(i) {
    const save = this.i;
    this.i = i;
    try {
      if (!this.accept('op', '(')) return false;
      this.unitTree();
      return this.isOp(')');
    } catch (e) {
      if (e.pyType === 'SyntaxError') return false;
      throw e;
    } finally { this.i = save; }
  }
  unitChunk() {
    const pos = this.peek.pos;
    return { type: 'Unit', tree: this.unitTree(), pos };
  }
  // tree: power ((juxtaposition | '*' power | '/' power-or-group))*
  unitTree() {
    let l = this.unitPower(false);
    for (;;) {
      if (this.unitAt()) { l = { type: 'UMul', l, r: this.unitPower(false) }; continue; }
      if (this.isOp('*') && this.unitAt(this.i + 1)) { this.next(); l = { type: 'UMul', l, r: this.unitPower('*') }; continue; }
      if (this.isOp('/') && (this.unitAt(this.i + 1) || this.unitGroupAt(this.i + 1))) {
        this.next();
        l = { type: 'UDiv', l, r: this.unitFactorAfterSlash() };
        continue;
      }
      return l;
    }
  }
  unitFactorAfterSlash() {
    if (this.accept('op', '(')) {
      const t = this.unitTree();
      this.expect('op', ')');
      return this.unitExponent(t);
    }
    return this.unitPower('/');
  }
  /** One unit with an optional power. afterOp: written after * or /, where a variable
   *  of the same name is easy to mean instead (the interpreter adds a note). */
  unitPower(afterOp) {
    const k = this.next();
    const un = k.t === 'name' && unitName(k.v);
    if (!un) throw syntaxError('expected a unit', k.pos);
    const { name, p } = un;
    let t = { type: 'UName', name, written: k.v, afterOp: this.inTarget ? false : afterOp, pos: k.pos };
    if (p !== 1) t = { type: 'UPow', base: t, p };
    return this.unitExponent(t);
  }
  unitExponent(t) {
    if (!(this.isOp('**') || this.isOp('^'))) return t;
    this.next();
    let sign = 1, p;
    if (this.accept('op', '-')) sign = -1; else this.accept('op', '+');
    if (this.is('num')) p = Number(this.next().v);
    else if (this.accept('op', '(')) {
      let s2 = 1;
      if (this.accept('op', '-')) s2 = -1;
      const a = Number(this.expect('num', undefined, 'a number').v);
      p = a;
      if (this.accept('op', '/')) p = a / Number(this.expect('num', undefined, 'a number').v);
      p *= s2;
      this.expect('op', ')');
    } else throw syntaxError('a unit power must be a number, e.g. s**2 or m**(1/2)', this.peek.pos);
    return { type: 'UPow', base: t, p: sign * p };
  }
  factor() {
    const k = this.peek;
    if (k.t === 'op' && k.v === '√') {
      this.next();
      return { type: 'Call', func: { type: 'Name', id: 'sqrt', pos: k.pos }, args: [this.factor()], kwargs: [], pos: k.pos };
    }
    if (k.t === 'op' && (k.v === '-' || k.v === '+' || k.v === '~')) {
      this.next();
      return { type: 'Unary', op: k.v, v: this.factor(), pos: k.pos };
    }
    return this.power();
  }
  power() {
    const base = this.postfix();
    if (this.isOp('**')) {
      const k = this.next();
      return { type: 'BinOp', op: '**', l: base, r: this.factor(), pos: k.pos };
    }
    return base;
  }
  postfix() {
    let e = this.atom();
    for (;;) {
      const k = this.peek;
      if (k.t !== 'op') return e;
      if (k.v === '(') { this.next(); e = this.call(e, k.pos); } else if (k.v === '[') { this.next(); e = { type: 'Subscript', value: e, index: this.subscripts(), pos: k.pos }; this.expect('op', ']'); } else if (k.v === '.') {
        this.next();
        const n = this.peek;
        if (n.t !== 'name' && n.t !== 'kw') throw syntaxError('invalid syntax: expected a name after "."', n.pos);
        this.next();
        e = { type: 'Attr', value: e, name: n.v, pos: n.pos };
      } else return e;
    }
  }
  call(func, pos) {
    const args = [], kwargs = [];
    while (!this.isOp(')')) {
      if (this.isOp('*') || this.isOp('**')) throw syntaxError('*args and **kwargs are not supported', this.peek.pos);
      if (this.is('name') && this.toks[this.i + 1].t === 'op' && this.toks[this.i + 1].v === '=') {
        const name = this.next().v;
        this.next();
        kwargs.push({ name, value: this.conv() });
      } else {
        if (kwargs.length) throw syntaxError('positional argument follows keyword argument', this.peek.pos);
        args.push(this.conv());
      }
      if (this.isKw('for')) throw syntaxError('comprehensions are not supported; use array arithmetic instead', this.peek.pos);
      if (!this.accept('op', ',')) break;
    }
    this.expect('op', ')');
    return { type: 'Call', func, args, kwargs, pos };
  }
  subscripts() {
    const pos = this.peek.pos;
    const items = [this.subscript()];
    let tuple = false;
    while (this.accept('op', ',')) {
      tuple = true;
      if (this.isOp(']')) break;
      items.push(this.subscript());
    }
    return tuple ? { type: 'Tuple', elts: items, pos } : items[0];
  }
  subscript() {
    const pos = this.peek.pos;
    const part = () => (this.isOp(':') || this.isOp(']') || this.isOp(',') ? null : this.test());
    const lo = part();
    if (!this.accept('op', ':')) {
      if (lo === null) this.fail();
      return lo;
    }
    const hi = part();
    let step = null;
    if (this.accept('op', ':')) step = part();
    return { type: 'SliceN', lo, hi, step, pos };
  }
  atom() {
    const k = this.peek;
    if (k.t === 'num') { this.next(); return { type: 'Num', value: k.v, pos: k.pos }; }
    if (k.t === 'str') {
      this.next();
      let s = k.v;
      while (this.is('str')) s += this.next().v;  // implicit concatenation
      return { type: 'Str', value: s, pos: k.pos };
    }
    if (k.t === 'name') { this.next(); return { type: 'Name', id: k.v, pos: k.pos }; }
    if (k.t === 'kw') {
      if (k.v === 'True' || k.v === 'False' || k.v === 'None') {
        this.next();
        return { type: 'Const', value: k.v === 'None' ? null : k.v === 'True', pos: k.pos };
      }
      if (k.v === 'lambda') return this.lambda();
      this.fail();
    }
    if (k.t === 'op' && k.v === '(') {
      this.next();
      if (this.accept('op', ')')) return { type: 'Tuple', elts: [], pos: k.pos };
      const e = this.exprList();
      if (this.isKw('for')) throw syntaxError('generator expressions are not supported', this.peek.pos);
      this.expect('op', ')');
      if (e.type === 'Tuple') return e;
      return { type: 'Paren', value: e, pos: k.pos };
    }
    if (k.t === 'op' && k.v === '[') {
      this.next();
      const elts = [];
      while (!this.isOp(']')) {
        elts.push(this.conv());
        if (this.isKw('for')) throw syntaxError('list comprehensions are not supported; use array arithmetic instead (e.g. x**2 for an array x)', this.peek.pos);
        if (!this.accept('op', ',')) break;
      }
      this.expect('op', ']');
      return { type: 'List', elts, pos: k.pos };
    }
    this.fail();
  }
}

function describe(n) {
  return {
    Num: 'literal', Str: 'literal', Const: 'constant', Call: 'function call', BinOp: 'expression', Unary: 'expression',
    Compare: 'comparison', BoolOp: 'expression', Lambda: 'lambda', List: 'list literal', Convert: 'conversion',
    IfExp: 'conditional expression', Paren: 'expression', Attr: 'attribute',
  }[n.type] ?? 'expression';
}

export function parse(src) { return new Parser(src).program(); }

/** Can a unit follow this node directly? Numbers, (...), [...], calls, indexing, and
 *  powers/negations of them; not a bare name (x m is more likely a typo for x * m). */
function numberLike(n) {
  switch (n.type) {
    case 'Num': case 'Paren': case 'List': case 'Call': case 'Subscript': return true;
    case 'Unary': return n.op !== 'not' && numberLike(n.v);
    case 'BinOp': return n.op === '**' && numberLike(n.r) && numberLike(n.l);
    default: return false;
  }
}
