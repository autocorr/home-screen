// Settings: section order/visibility/collapsed state and theme, stored in localStorage.
import { SECTIONS } from './config.js';

const KEY = 'settings:v1';
const defaults = () => ({ order: SECTIONS.map((s) => s.id), hidden: [], collapsed: [], theme: 'auto' });

function load() {
  let s;
  try { s = JSON.parse(localStorage.getItem(KEY)); } catch { s = null; }
  const d = defaults();
  if (!s) return d;
  // Keep known sections in saved order; append any new ones from config.
  const known = new Set(d.order);
  const order = (s.order || []).filter((id) => known.has(id));
  d.order.forEach((id) => { if (!order.includes(id)) order.push(id); });
  const keep = (a) => (a || []).filter((id) => known.has(id));
  return { order, hidden: keep(s.hidden), collapsed: keep(s.collapsed), theme: s.theme || 'auto' };
}

let state = load();
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* ignore */ } };

export function applyTheme(theme = state.theme) {
  if (theme === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}

function applySections() {
  state.order.forEach((id, i) => {
    const el = document.querySelector(`[data-section="${id}"]`);
    if (!el) return;
    el.style.order = String(i);
    el.hidden = state.hidden.includes(id);
    const collapsed = state.collapsed.includes(id);
    el.classList.toggle('collapsed', collapsed);
    el.querySelector('.section-toggle')?.setAttribute('aria-expanded', String(!collapsed));
  });
}

function toggleCollapsed(id) {
  state.collapsed = state.collapsed.includes(id)
    ? state.collapsed.filter((x) => x !== id) : [...state.collapsed, id];
  save(); applySections();
}

/** onThemeChange is called whenever the effective colour scheme may have changed. */
export function initSettings(onThemeChange) {
  applyTheme();
  applySections();
  document.querySelectorAll('[data-section] .section-toggle').forEach((btn) => {
    btn.addEventListener('click', () => toggleCollapsed(btn.closest('[data-section]').dataset.section));
  });
  const dlg = document.getElementById('settings');
  const list = dlg.querySelector('#set-sections');
  const label = (id) => SECTIONS.find((s) => s.id === id)?.label ?? id;

  const renderList = () => {
    list.innerHTML = state.order.map((id, i) =>
      `<li data-id="${id}"><label><input type="checkbox" ${state.hidden.includes(id) ? '' : 'checked'}> ${label(id)}</label>` +
      `<span class="move"><button type="button" data-move="-1" aria-label="Move ${label(id)} up" ${i === 0 ? 'disabled' : ''}>↑</button>` +
      `<button type="button" data-move="1" aria-label="Move ${label(id)} down" ${i === state.order.length - 1 ? 'disabled' : ''}>↓</button></span></li>`).join('');
    dlg.querySelectorAll('#set-theme button').forEach((b) =>
      b.setAttribute('aria-pressed', String(b.dataset.theme === state.theme)));
  };

  list.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-move]');
    if (!b) return;
    const id = b.closest('li').dataset.id;
    const i = state.order.indexOf(id), j = i + Number(b.dataset.move);
    if (j < 0 || j >= state.order.length) return;
    [state.order[i], state.order[j]] = [state.order[j], state.order[i]];
    save(); applySections(); renderList();
    list.querySelector(`li[data-id="${id}"] button[data-move="${b.dataset.move}"]`)?.focus();
  });
  list.addEventListener('change', (e) => {
    const id = e.target.closest('li').dataset.id;
    state.hidden = e.target.checked ? state.hidden.filter((x) => x !== id) : [...state.hidden, id];
    save(); applySections();
  });
  dlg.querySelector('#set-theme').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-theme]');
    if (!b) return;
    state.theme = b.dataset.theme;
    save(); applyTheme(); renderList(); onThemeChange();
  });
  dlg.querySelector('#set-reset').addEventListener('click', () => {
    state = defaults();
    save(); applyTheme(); applySections(); renderList(); onThemeChange();
  });
  dlg.querySelector('#set-expand-all').addEventListener('click', () => {
    state.collapsed = [];
    save(); applySections();
  });
  dlg.querySelector('#set-clear-cache').addEventListener('click', (e) => {
    try {
      Object.keys(localStorage).filter((k) => /^wx:v\d+$/.test(k)).forEach((k) => localStorage.removeItem(k));
    } catch { /* ignore */ }
    e.target.textContent = 'Cleared — reload to refetch';
  });
  document.getElementById('open-settings').addEventListener('click', () => {
    renderList();
    dlg.showModal();
  });
  // Click on the backdrop closes the dialog.
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
}
