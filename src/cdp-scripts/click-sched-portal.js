// CDP script: click a body-level portal option (listbox/popover/context menu)
// Extracted from server.js POST /click (scheddlg: branch, idx >= 100)

export function buildSchedPortalClickScript(optIdx) {
  return `
        (() => {
          for (const child of document.body.children) {
            if (child.id || child.tagName === 'SCRIPT' || child.tagName === 'STYLE') continue;
            if (child.getBoundingClientRect().width <= 0) continue;
            // Match listbox (schedule dropdowns) or popover/menu (kebab context menus)
            const role = child.getAttribute('role');
            const hasSide = child.hasAttribute('data-side') || child.querySelector('[data-side]');
            const isPortal = role === 'listbox' || role === 'dialog' || role === 'menu' || hasSide;
            const hasButtons = child.querySelectorAll('button, [role="menuitem"], [role="option"]').length > 0;
            if (!isPortal && !hasButtons) continue;

            const options = child.querySelectorAll('[role="option"], [role="menuitem"], button, a');
            const idx = ${optIdx};
            if (idx < 0 || idx >= options.length) return { ok: false, reason: 'option_index_out_of_range', total: options.length };
            const target = options[idx];
            target.click();
            return { ok: true, label: target.textContent.trim().substring(0, 50), source: 'scheddlg_portal' };
          }
          return null;
        })()
`;
}
