export const SCHEDULED_TASKS_SCRIPT = `
(() => {
  // Try list view first (has "Add scheduled task" button)
  let anchor = document.querySelector('[aria-label="Add scheduled task"]');

  // Fallback: task detail/edit view — has "Edit task title" button
  if (!anchor) {
    anchor = document.querySelector('[aria-label="Edit task title"]');
  }

  // Fallback: task detail with name editing active — "Edit task title" button is replaced
  // by an inline input, but the prompt textarea is always present
  if (!anchor) {
    anchor = document.querySelector('textarea[placeholder*="Prompt to execute"]');
  }

  if (!anchor) return null;

  // Walk up from the anchor to find the content panel (stops before sidebar)
  let container = anchor;
  for (let i = 0; i < 15; i++) {
    if (!container.parentElement) break;
    const p = container.parentElement;
    if (p.getBoundingClientRect().x < 10) break;
    container = p;
  }

  // Find the inner panel that has the scheduled tasks content
  const inner = container.querySelector('.flex-1.flex.flex-col.min-w-0.h-full') || container;

  // Tag interactive elements on the page
  let idx = 0;
  const tagged = [];
  inner.querySelectorAll('button, a, [role="button"], input, select, textarea').forEach(el => {
    el.setAttribute('data-ag-click-id', 'sched:' + idx);
    el.setAttribute('data-ag-click-label', (el.textContent || el.getAttribute('placeholder') || '').trim().substring(0, 50));
    idx++;
    tagged.push(el);
  });
  // Also tag cursor-pointer divs (task cards are DIVs, not buttons)
  inner.querySelectorAll('[class*="cursor-pointer"]').forEach(el => {
    if (el.hasAttribute('data-ag-click-id')) return; // Already tagged
    const text = (el.textContent || '').trim();
    // Skip very long text containers (likely not interactive cards)
    if (text.length > 200) return;
    el.setAttribute('data-ag-click-id', 'sched:' + idx);
    el.setAttribute('data-ag-click-label', text.substring(0, 50));
    idx++;
    tagged.push(el);
  });
  // Sync live input/textarea values into attributes before cloning
  // (cloneNode copies HTML attributes but not live .value properties)
  const valuedEls = [];
  inner.querySelectorAll('input, textarea').forEach(el => {
    valuedEls.push(el);
    el.setAttribute('data-ag-value', el.value || '');
  });
  const pageClone = inner.cloneNode(true);
  tagged.forEach(el => {
    el.removeAttribute('data-ag-click-id');
    el.removeAttribute('data-ag-click-label');
  });
  valuedEls.forEach(el => el.removeAttribute('data-ag-value'));

  // Strip <style> tags from captured HTML — AG's inline styles interfere
  // with the remote app's CSS when injected via innerHTML
  pageClone.querySelectorAll('style').forEach(s => s.remove());

  return pageClone.outerHTML;
})()
`;
