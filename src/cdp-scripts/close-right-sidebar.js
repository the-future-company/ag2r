// Close AG's right sidebar by clicking the native toggle button.
// Returns 'closed' if the button was found and clicked, null if not found.
// Used when AG2R closes its sidebar — keeps both UIs in sync.

export const CLOSE_RIGHT_SIDEBAR_SCRIPT = `
  (() => {
    const closeBtn = document.querySelector('[data-testid="toggle-aux-sidebar"]');
    if (closeBtn) {
      closeBtn.click();
      return 'closed';
    }
    return null;
  })()
`;
