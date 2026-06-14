// Try to open AG's right sidebar by clicking a toggle button.
// Returns 'button' if found and clicked, null if no toggle found.
// Used by GET /right-sidebar when the sidebar is closed.

export const OPEN_RIGHT_SIDEBAR_SCRIPT = `
  (() => {
    // Strategy 1: Find a button whose tooltip or aria-label suggests it opens the review/aux panel.
    // AG has data-tooltip-id attributes on toolbar buttons.
    const candidates = [
      ...document.querySelectorAll('[aria-label*="Review" i]'),
      ...document.querySelectorAll('[aria-label*="Auxiliary" i]'),
      ...document.querySelectorAll('[aria-label*="Secondary Side Bar" i]'),
      ...document.querySelectorAll('[data-tooltip-id*="review" i]'),
    ];
    for (const btn of candidates) {
      // Only click buttons/clickable elements, not content
      if (btn.tagName === 'BUTTON' || btn.getAttribute('role') === 'button' || btn.closest('button')) {
        (btn.closest('button') || btn).click();
        return 'button';
      }
    }
    return null;
  })()
`;
