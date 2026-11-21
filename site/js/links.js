// Links section, rendered from LINKS in config.js.
import { LINKS } from './config.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function initLinks(root) {
  const groups = new Map();
  for (const l of LINKS) {
    const g = l.group ?? '';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(l);
  }
  root.querySelector('#links-list').innerHTML = [...groups].map(([g, links]) =>
    `<div class="link-group">${g ? `<h3>${esc(g)}</h3>` : ''}<div class="links">` +
    links.map((l) => `<a class="link" href="${esc(l.url)}" rel="noopener">${esc(l.label)}</a>`).join('') +
    `</div></div>`).join('');
}
