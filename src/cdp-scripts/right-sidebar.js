import { TAG_INTERACTIVES_FN } from './_shared.js';

export const RIGHT_SIDEBAR_SCRIPT = `
(() => {
  ${TAG_INTERACTIVES_FN}

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

  // Tag ALL interactive elements in the sidebar root.
  // Must match click-main.js enumeration for source==='right':
  //   skipVis=true, includeCursorPointer=true, maxTextLength=0
  const rightTagged = tagInteractives(sidebarRoot, 'right', true, true, 0);

  const rightClone = sidebarRoot.cloneNode(true);
  untagAll(rightTagged);
  return rightClone.outerHTML;
})()
`;
