// LaTeX names for Tab completion: "\epsilon<Tab>" becomes "ϵ". Names and symbols follow
// IPython/Julia (so \epsilon is the lunate ϵ and \varepsilon is ε, as in LaTeX).
// Only symbols the calculator can read are listed: letters (usable in names; Python's
// NFKC normalisation makes ϵ and ε the same name) and the operators the tokenizer maps.

const GREEK = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ϵ', varepsilon: 'ε', zeta: 'ζ', eta: 'η',
  theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ', varkappa: 'ϰ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ',
  omicron: 'ο', pi: 'π', varpi: 'ϖ', rho: 'ρ', varrho: 'ϱ', sigma: 'σ', varsigma: 'ς', tau: 'τ',
  upsilon: 'υ', phi: 'ϕ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Alpha: 'Α', Beta: 'Β', Gamma: 'Γ', Delta: 'Δ', Epsilon: 'Ε', Zeta: 'Ζ', Eta: 'Η', Theta: 'Θ',
  Iota: 'Ι', Kappa: 'Κ', Lambda: 'Λ', Mu: 'Μ', Nu: 'Ν', Xi: 'Ξ', Omicron: 'Ο', Pi: 'Π', Rho: 'Ρ',
  Sigma: 'Σ', Tau: 'Τ', Upsilon: 'Υ', Phi: 'Φ', Chi: 'Χ', Psi: 'Ψ', Omega: 'Ω',
};
const LETTERS = { hbar: 'ħ', ell: 'ℓ', AA: 'Å', Angstrom: 'Å', micro: 'µ', eth: 'ð', aleph: 'ℵ' };
const OPERATORS = {
  times: '×', cdot: '·', div: '÷', leq: '≤', le: '≤', geq: '≥', ge: '≥', neq: '≠', ne: '≠',
  to: '→', rightarrow: '→', infty: '∞', sqrt: '√', degree: '°',
};
const SUP = { 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹', '-': '⁻', '+': '⁺' };
const SUB = { 0: '₀', 1: '₁', 2: '₂', 3: '₃', 4: '₄', 5: '₅', 6: '₆', 7: '₇', 8: '₈', 9: '₉' };

export const LATEX = {
  ...GREEK, ...LETTERS, ...OPERATORS,
  ...Object.fromEntries(Object.entries(SUP).map(([k, v]) => [`^${k}`, v])),
  ...Object.fromEntries(Object.entries(SUB).map(([k, v]) => [`_${k}`, v])),
};

/**
 * Completion for a backslash name ending the text: null if there is none, else
 * {start, items (symbols to insert), labels ("\alpha  α")}. An exact name gives one item.
 */
export function latexComplete(before) {
  const m = /\\([A-Za-z]*|[\^_][0-9+-]?)$/.exec(before);
  if (!m) return null;
  const start = before.length - m[0].length, name = m[1];
  if (name && LATEX[name]) return { start, items: [LATEX[name]], labels: [`\\${name} ${LATEX[name]}`] };
  const names = Object.keys(LATEX).filter((k) => k.startsWith(name))
    .sort((a, b) => a.length - b.length || a.localeCompare(b));
  return { start, items: names.map((k) => LATEX[k]), labels: names.map((k) => `\\${k} ${LATEX[k]}`) };
}
