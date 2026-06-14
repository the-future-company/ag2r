(() => {
  for (const child of document.body.children) {
    if (child.id || child.tagName === 'SCRIPT' || child.tagName === 'STYLE') continue;
    const text = child.textContent.trim();
    if (!text || text.length > 500) continue;
    // Match popover/context menu patterns:
    // - role="dialog" (Radix popover)
    // - data-side attribute (Radix positioning)
    // - role="menu" or role="listbox"
    const role = child.getAttribute('role');
    const hasSide = child.hasAttribute('data-side') || child.querySelector('[data-side]');
    const isPopover = role === 'dialog' || role === 'menu' || role === 'listbox' || hasSide;
    // Also match plain divs that look like menus (few children, short text, buttons inside)
    const hasButtons = child.querySelectorAll('button, [role="menuitem"], [role="option"]').length > 0;
    if (!isPopover && !hasButtons) continue;
    if (child.getBoundingClientRect().width <= 0) continue;

    let idx = 0;
    const tagged = [];
    child.querySelectorAll('button, [role="menuitem"], [role="option"], a').forEach(el => {
      el.setAttribute('data-ag-click-id', 'scheddlg:' + (100 + idx));
      el.setAttribute('data-ag-click-label', el.textContent.trim().substring(0, 50));
      idx++;
      tagged.push(el);
    });
    if (idx === 0) continue;
    const clone = child.cloneNode(true);
    tagged.forEach(el => {
      el.removeAttribute('data-ag-click-id');
      el.removeAttribute('data-ag-click-label');
    });
    return clone.outerHTML;
  }
  return null;
})()
