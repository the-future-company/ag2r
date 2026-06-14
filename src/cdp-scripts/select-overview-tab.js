// Select the Overview tab if no tab is currently active.
// Used by GET /right-sidebar after opening the sidebar.

export const SELECT_OVERVIEW_TAB_SCRIPT = `
  (() => {
    const tabs = document.querySelectorAll('[data-tab-id]');
    const anyActive = [...tabs].some(t => (t.className || '').includes('bg-secondary'));
    if (!anyActive) {
      const overview = document.querySelector('[data-tab-id="overview"]');
      if (overview) overview.click();
    }
  })()
`;
