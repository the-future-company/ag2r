// Close AG's right sidebar by clicking the native close button.
// Returns 'closed' if the button was found and clicked, null if sidebar was already closed.
// Used when AG2R closes its sidebar — keeps both UIs in sync.

export const CLOSE_RIGHT_SIDEBAR_SCRIPT = `
  (() => {
    const closeBtn = document.querySelector('[data-testid="close-aux-pane"]');
    if (closeBtn) {
      closeBtn.click();
      return 'closed';
    }
    return null;
  })()
`;
