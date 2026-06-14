(() => {
  let sidebarRoot = null;

  // Strategy 1: Find via tab-id buttons
  const tabBtn = document.querySelector('[data-tab-id="overview"], [data-tab-id="review"]');
  if (tabBtn) {
    let el = tabBtn;
    for (let i = 0; i < 10 && el; i++) {
      el = el.parentElement;
      const cls = el?.className?.toString?.() || '';
      if (cls.includes('flex') && cls.includes('flex-col') && el.children.length >= 2) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 100 && rect.height > 200) {
          sidebarRoot = el;
          break;
        }
      }
    }
  }

  // Strategy 2: Find via close-aux-pane button
  if (!sidebarRoot) {
    const closeBtn = document.querySelector('[data-testid="close-aux-pane"]');
    if (closeBtn) {
      let el = closeBtn;
      for (let i = 0; i < 10 && el; i++) {
        el = el.parentElement;
        const cls = el?.className?.toString?.() || '';
        if (cls.includes('flex') && cls.includes('flex-col') && el.children.length >= 2) {
          sidebarRoot = el;
          break;
        }
      }
    }
  }

  if (!sidebarRoot) return null;

  // Only tag control elements (tab bar, action buttons), NOT content body.
  // Content body must remain untagged so text selection works for commenting.
  // Strategy: find the tab bar row (contains [data-tab-id] buttons) and tag
  // only that row + any sibling control rows above the content panel.
  const rightTagged = [];
  let rightIdx = 0;

  // Find the tab bar — the closest ancestor of [data-tab-id] buttons that is
  // a direct child of sidebarRoot
  const tabBtns = sidebarRoot.querySelectorAll('[data-tab-id]');
  const controlBars = new Set();
  tabBtns.forEach(btn => {
    let el = btn;
    while (el.parentElement && el.parentElement !== sidebarRoot) {
      el = el.parentElement;
    }
    if (el.parentElement === sidebarRoot) controlBars.add(el);
  });

  // Also find the close button's bar
  const closeBtn = sidebarRoot.querySelector('[data-testid="close-aux-pane"]');
  if (closeBtn) {
    let el = closeBtn;
    while (el.parentElement && el.parentElement !== sidebarRoot) {
      el = el.parentElement;
    }
    if (el.parentElement === sidebarRoot) controlBars.add(el);
  }

  // Tag interactive elements only inside control bars
  controlBars.forEach(bar => {
    bar.querySelectorAll('button, a, [role="button"]').forEach(el => {
      const text = (el.textContent || '').trim();
      el.setAttribute('data-ag-click-id', 'right:' + rightIdx);
      el.setAttribute('data-ag-click-label', text.substring(0, 50));
      rightIdx++;
      rightTagged.push(el);
    });
  });

  // If no control bars found (layout changed), fall back to tagging only
  // [data-tab-id] buttons and close button directly
  if (controlBars.size === 0) {
    sidebarRoot.querySelectorAll('[data-tab-id], [data-testid="close-aux-pane"]').forEach(el => {
      if (el.hasAttribute('data-ag-click-id')) return;
      const text = (el.textContent || '').trim();
      el.setAttribute('data-ag-click-id', 'right:' + rightIdx);
      el.setAttribute('data-ag-click-label', text.substring(0, 50));
      rightIdx++;
      rightTagged.push(el);
    });
  }

  const rightClone = sidebarRoot.cloneNode(true);
  untagAll(rightTagged);
  return rightClone.outerHTML;
})()
