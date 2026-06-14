export const DISCOVER_SCRIPT = `
(async () => {
  const results = {
    // Search for elements containing sidebar-related text
    textMatches: [],
    // Search for aside elements
    asides: [],
    // Search for panel/sidebar class/id patterns
    panels: [],
    // Search for tab-like structures
    tabs: [],
    // Search for elements near the right edge of the viewport
    rightEdgeElements: [],
    // The chat container we already know about
    chatContainer: null,
    // All top-level structural elements
    topLevel: [],
  };

  // 1. Find elements with sidebar-related text
  const textTargets = ['Overview', 'Review', 'Review Changes', 'No changes to review'];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const text = walker.currentNode.textContent.trim();
    for (const target of textTargets) {
      if (text === target || text.includes(target)) {
        const el = walker.currentNode.parentElement;
        if (el) {
          results.textMatches.push({
            text: target,
            tag: el.tagName,
            id: el.id || null,
            className: el.className?.toString?.()?.substring(0, 200) || null,
            role: el.getAttribute('role'),
            parentTag: el.parentElement?.tagName,
            parentId: el.parentElement?.id || null,
            parentClass: el.parentElement?.className?.toString?.()?.substring(0, 200) || null,
            // Walk up 5 levels to find structural ancestor
            ancestors: (() => {
              const anc = [];
              let p = el;
              for (let i = 0; i < 5 && p; i++) {
                anc.push({
                  tag: p.tagName,
                  id: p.id || null,
                  class: p.className?.toString?.()?.substring(0, 100) || null,
                  role: p.getAttribute?.('role') || null,
                  'data-testid': p.getAttribute?.('data-testid') || null,
                });
                p = p.parentElement;
              }
              return anc;
            })(),
          });
        }
      }
    }
  }

  // 2. Find aside elements
  document.querySelectorAll('aside').forEach(el => {
    results.asides.push({
      id: el.id || null,
      className: el.className?.toString?.()?.substring(0, 200) || null,
      role: el.getAttribute('role'),
      childCount: el.children.length,
      textPreview: el.textContent?.substring(0, 100)?.trim(),
      rect: el.getBoundingClientRect(),
    });
  });

  // 3. Find panel/sidebar patterns
  const panelSelectors = [
    '[class*="sidebar" i]', '[class*="panel" i]', '[class*="drawer" i]',
    '[class*="aside" i]', '[class*="review" i]', '[class*="overview" i]',
    '[id*="sidebar" i]', '[id*="panel" i]', '[id*="drawer" i]',
    '[id*="review" i]', '[id*="overview" i]',
    '[data-testid*="sidebar" i]', '[data-testid*="panel" i]',
    '[data-testid*="review" i]', '[data-testid*="overview" i]',
    '[role="complementary"]', '[role="tabpanel"]',
  ];
  for (const sel of panelSelectors) {
    try {
      document.querySelectorAll(sel).forEach(el => {
        results.panels.push({
          selector: sel,
          tag: el.tagName,
          id: el.id || null,
          className: el.className?.toString?.()?.substring(0, 200) || null,
          role: el.getAttribute('role'),
          'data-testid': el.getAttribute('data-testid'),
          childCount: el.children.length,
          textPreview: el.textContent?.substring(0, 100)?.trim(),
          rect: el.getBoundingClientRect(),
          visible: el.offsetParent !== null,
        });
      });
    } catch {}
  }

  // 4. Find tab structures
  document.querySelectorAll('[role="tab"], [role="tablist"], [role="tabpanel"]').forEach(el => {
    results.tabs.push({
      tag: el.tagName,
      role: el.getAttribute('role'),
      id: el.id || null,
      className: el.className?.toString?.()?.substring(0, 200) || null,
      'aria-selected': el.getAttribute('aria-selected'),
      'aria-controls': el.getAttribute('aria-controls'),
      textContent: el.textContent?.substring(0, 50)?.trim(),
      rect: el.getBoundingClientRect(),
    });
  });

  // 5. Find elements positioned on the right side of the viewport
  const vw = window.innerWidth;
  document.querySelectorAll('div, section, aside, nav').forEach(el => {
    const rect = el.getBoundingClientRect();
    if (rect.left > vw * 0.5 && rect.width > 100 && rect.height > 200) {
      results.rightEdgeElements.push({
        tag: el.tagName,
        id: el.id || null,
        className: el.className?.toString?.()?.substring(0, 150) || null,
        role: el.getAttribute('role'),
        'data-testid': el.getAttribute('data-testid'),
        rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
        childCount: el.children.length,
        textPreview: el.textContent?.substring(0, 80)?.trim(),
      });
    }
  });

  // 6. Chat container (for reference)
  const container =
    document.querySelector('.scrollbar-hide[class*="overflow-y-auto"]') ||
    document.querySelector('[data-testid="conversation-view"]') ||
    document.getElementById('conversation');
  if (container) {
    results.chatContainer = {
      tag: container.tagName,
      id: container.id || null,
      className: container.className?.toString?.()?.substring(0, 200) || null,
      rect: container.getBoundingClientRect(),
      // Sibling info — sidebar is likely a sibling
      siblings: Array.from(container.parentElement?.children || []).map(s => ({
        tag: s.tagName,
        id: s.id || null,
        className: s.className?.toString?.()?.substring(0, 100) || null,
        role: s.getAttribute('role'),
        rect: s.getBoundingClientRect(),
      })),
    };
  }

  // 7. Top-level children of body
  Array.from(document.body.children).forEach(el => {
    results.topLevel.push({
      tag: el.tagName,
      id: el.id || null,
      className: el.className?.toString?.()?.substring(0, 150) || null,
      childCount: el.children.length,
      rect: el.getBoundingClientRect(),
    });
  });

  return results;
})()
`;
