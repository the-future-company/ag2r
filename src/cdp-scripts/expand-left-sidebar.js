// Expand the left sidebar when it's collapsed.
// Used by POST /expand-left-sidebar.

export const EXPAND_LEFT_SIDEBAR_SCRIPT = `
  (async () => {
    const leftRoot = document.querySelector('.bg-sidebar');
    const isCollapsed = !leftRoot || leftRoot.offsetParent === null;
    if (!isCollapsed) return { ok: true, wasCollapsed: false };
    // Click the sidebar toggle button to expand
    const toggleBtn = document.querySelector('[data-testid="sidebar-toggle"]');
    if (!toggleBtn) return { ok: false, error: 'Toggle button not found' };
    toggleBtn.click();
    return { ok: true, wasCollapsed: true };
  })()
`;
