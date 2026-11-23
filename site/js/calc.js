// Calculator section: an IPython-style text REPL. The engine (js/calc/) is loaded on
// first use; this file only draws the transcript and handles the keyboard.
//
// Keys: Enter runs (or continues an unclosed bracket), Shift+Enter adds a line,
// Up/Down walk the history (filtered by what is typed before the cursor), Tab completes
// (names, units, and LaTeX symbols: \alpha<Tab> gives α),
// Esc clears, Ctrl+L clears the screen. Input history is kept in localStorage.

const HIST_KEY = 'calc:history:v1';
const HIST_MAX = 500;
const BANNER = 'Python-style calculator with arrays and units. Type ? for help.';

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

function loadHistory() {
  try {
    const h = JSON.parse(localStorage.getItem(HIST_KEY));
    return Array.isArray(h) ? h.filter((x) => typeof x === 'string') : [];
  } catch { return []; }
}
function saveHistory(h) {
  try { localStorage.setItem(HIST_KEY, JSON.stringify(h.slice(-HIST_MAX))); } catch { /* ignore */ }
}

/** Net count of open brackets outside strings and comments (for Enter-to-continue). */
function openBrackets(src) {
  let depth = 0, q = null;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === '\\') i++;
      else if (c === q || c === '\n') q = null;
    } else if (c === '"' || c === "'") q = c;
    else if (c === '#') { while (i < src.length && src[i] !== '\n') i++; } else if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
  }
  return depth;
}

export function initCalc(root) {
  const term = root.querySelector('#calc-term');
  const log = root.querySelector('#calc-log');
  const input = root.querySelector('#calc-input');
  const prompt = root.querySelector('#calc-prompt');
  const menu = root.querySelector('#calc-complete');

  let interp = null, loading = null;
  const load = () => (loading ??= import('./calc/repl.js').then((m) => { interp = new m.Interp(); return interp; }));

  const history = loadHistory();
  let hpos = null, hprefix = '', draft = '';
  let comp = null;   // {start, end, items, labels, index}

  const promptText = (n) => `In [${n}]:`;
  const setPrompt = () => { prompt.textContent = promptText(interp ? interp.n : 1); };
  const resize = () => { input.style.height = 'auto'; input.style.height = `${input.scrollHeight}px`; };
  const scrollDown = () => { term.scrollTop = term.scrollHeight; };

  const banner = () => log.append(el('p', 'calc-text calc-banner', BANNER));
  banner();

  /** One transcript row: prompt + content, or full width when prompt is null. */
  function row(cls, promptStr, text) {
    const r = el('div', `calc-row ${cls}`);
    if (promptStr === null) {
      r.append(el('pre', 'calc-body calc-full', text));
    } else if (text.includes('\n') && cls === 'calc-out') {
      // Like IPython: a multi-line result starts on its own line, keeping columns aligned.
      r.append(el('span', 'calc-prompt', promptStr), el('pre', 'calc-body calc-full', text));
    } else {
      r.append(el('span', 'calc-prompt', promptStr), el('pre', 'calc-body', text));
    }
    return r;
  }

  function echoInput(cell, n, src) {
    const p = promptText(n);
    src.split('\n').forEach((line, i) => {
      cell.append(row('calc-in', i === 0 ? p : `${'...:'.padStart(p.length)}`, line));
    });
  }

  // Runs are queued so input typed while the engine loads is not lost or reordered.
  let queue = Promise.resolve();
  function run() {
    const src = input.value;
    hideMenu();
    const t = src.replace(/\s+$/, '');
    if (t.trim() && history[history.length - 1] !== t) {
      history.push(t);
      if (history.length > HIST_MAX) history.splice(0, history.length - HIST_MAX);
      saveHistory(history);
    }
    hpos = null;
    input.value = '';
    resize();
    queue = queue.then(() => execute(src)).catch((e) => console.error(e));
  }
  async function execute(src) {
    const it = await load();
    const n = it.n;
    const cell = el('div', 'calc-cell');
    echoInput(cell, n, src.replace(/\s+$/, ''));
    const { records } = it.run(src);
    let cleared = false;
    for (const r of records) {
      if (r.kind === 'clear') { log.replaceChildren(); cleared = true; continue; }
      if (r.kind === 'out') cell.append(row('calc-out', `Out[${n}]:`, r.text));
      else if (r.kind === 'err') cell.append(row('calc-err', null, r.text));
      else cell.append(row('calc-text', null, r.text));
    }
    if (!cleared) log.append(cell);
    setPrompt(); scrollDown();
  }

  // ---- history ---------------------------------------------------------------------------
  function historyStep(dir) {
    if (hpos === null) {
      draft = input.value;
      hprefix = input.value.slice(0, input.selectionStart);
      hpos = history.length;
    }
    let i = hpos;
    do { i += dir; } while (i >= 0 && i < history.length && !history[i].startsWith(hprefix));
    if (i < 0) return;
    if (i >= history.length) { hpos = null; input.value = draft; } else { hpos = i; input.value = history[i]; }
    resize();
    const end = input.value.length;
    input.setSelectionRange(end, end);
  }

  // ---- completion --------------------------------------------------------------------------
  function hideMenu() { comp = null; menu.hidden = true; menu.replaceChildren(); }
  function applyCompletion(text) {
    const { start, end } = comp;
    input.value = input.value.slice(0, start) + text + input.value.slice(end);
    const pos = start + text.length;
    input.setSelectionRange(pos, pos);
    comp.end = pos;
    resize();
  }
  function showMenu() {
    menu.replaceChildren(...comp.items.slice(0, 60).map((s, i) => {
      const b = el('button', 'calc-cand', comp.labels?.[i] ?? s);
      b.type = 'button';
      b.tabIndex = -1;
      if (i === comp.index) b.setAttribute('aria-selected', 'true');
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', () => { applyCompletion(s); hideMenu(); input.focus(); });
      return b;
    }));
    if (comp.items.length > 60) menu.append(el('span', 'calc-more', `… ${comp.items.length - 60} more`));
    menu.hidden = false;
    scrollDown();
  }
  /** Returns false when there is nothing to complete (so Tab can move focus as usual). */
  function complete(backwards) {
    if (comp && comp.items.length > 1) {
      comp.index = (comp.index + (backwards ? -1 : 1) + comp.items.length) % comp.items.length;
      applyCompletion(comp.items[comp.index]);
      showMenu();
      return true;
    }
    if (!interp) { load(); return true; }
    const cursor = input.selectionStart;
    const { start, items, labels } = interp.complete(input.value, cursor);
    if (!items.length) return start !== cursor;  // nothing typed: let Tab move focus on
    comp = { start, end: cursor, items, labels, index: -1 };
    if (items.length === 1) { applyCompletion(items[0]); hideMenu(); return true; }
    // Fill the common prefix, then list the candidates; Tab again cycles through them.
    let pre = items[0];
    for (const s of items) while (!s.startsWith(pre)) pre = pre.slice(0, -1);
    if (pre.length > cursor - start) applyCompletion(pre);
    showMenu();
    return true;
  }

  // ---- events ------------------------------------------------------------------------------
  input.addEventListener('focus', () => { load().then(setPrompt); });
  input.addEventListener('input', () => { resize(); hideMenu(); hpos = null; });
  input.addEventListener('keydown', (e) => {
    const v = input.value, caret = input.selectionStart;
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      if (openBrackets(v) > 0 && caret === v.length) return;   // newline inside ( [ {
      e.preventDefault();
      if (comp && comp.index >= 0) { hideMenu(); return; }
      run();
    } else if (e.key === 'Tab' && !e.ctrlKey && !e.altKey && !e.metaKey) {
      if (complete(e.shiftKey)) e.preventDefault();
    } else if (e.key === 'ArrowUp' && !v.slice(0, caret).includes('\n') && !e.shiftKey) {
      e.preventDefault(); hideMenu(); historyStep(-1);
    } else if (e.key === 'ArrowDown' && !v.slice(caret).includes('\n') && !e.shiftKey && hpos !== null) {
      e.preventDefault(); hideMenu(); historyStep(1);
    } else if (e.key === 'Escape') {
      if (comp) hideMenu();
      else { input.value = ''; hpos = null; resize(); }
    } else if ((e.key === 'l' || e.key === 'L') && e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      log.replaceChildren();
    }
  });
  // Tapping or clicking the terminal focuses the input, unless text is being selected.
  term.addEventListener('mouseup', (e) => {
    if (e.target.closest('button, a') || !window.getSelection()?.isCollapsed) return;
    input.focus({ preventScroll: true });
  });
  resize();
}
