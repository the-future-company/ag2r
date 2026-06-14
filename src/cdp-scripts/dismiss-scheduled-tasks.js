(() => {
  // Check if we're on the task detail view
  const editBtn = document.querySelector('[aria-label="Edit task title"]');
  const promptTA = document.querySelector('textarea[placeholder*="Prompt to execute"]');
  if (editBtn || promptTA) {
    // We're on the detail view — look for breadcrumb link back to list
    const links = document.querySelectorAll('a');
    for (const a of links) {
      if ((a.textContent || '').trim() === 'Scheduled') {
        a.click();
        return { ok: true, method: 'detail-back' };
      }
    }
    // Fallback: use AG's Go Back toolbar button
    const goBack = document.querySelector('[aria-label="Go Back"]');
    if (goBack) {
      goBack.click();
      return { ok: true, method: 'detail-back' };
    }
  }

  // We're on the list view — navigate away to a conversation
  const sidebar = document.querySelector('[class*="bg-sidebar"]');
  if (sidebar) {
    const row = sidebar.querySelector('[class*="min-h-[32px]"]');
    if (row) {
      row.click();
      return { ok: true, method: 'sidebar-row' };
    }
  }
  // Fallback: use history back
  window.history.back();
  return { ok: true, method: 'history-back' };
})()
