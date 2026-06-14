(() => {
  const overlay = document.querySelector('.fixed.inset-0[class*="z-[2550]"]');
  if (!overlay || overlay.getBoundingClientRect().width <= 0) return null;
  // Only capture if this looks like a scheduled task dialog (not settings)
  // Matches: new/edit task form ("Scheduled Task", "task name") and delete confirmation ("delete")
  const text = overlay.textContent || '';
  if (!text.includes('Scheduled Task') && !text.includes('task name') && !/delete/i.test(text)) return null;

  let idx = 0;
  const tagged = [];
  // Tag standard interactive elements
  overlay.querySelectorAll('button, a, [role="button"], input, select, textarea, [role="combobox"], [role="switch"]').forEach(el => {
    el.setAttribute('data-ag-click-id', 'scheddlg:' + idx);
    el.setAttribute('data-ag-click-label', (el.textContent || el.getAttribute('placeholder') || '').trim().substring(0, 50));
    idx++;
    tagged.push(el);
  });
  // Also tag cursor-pointer divs (Schedule dropdowns) — these have onclick but no role
  overlay.querySelectorAll('div.cursor-pointer[aria-expanded]').forEach(el => {
    if (el.getAttribute('data-ag-click-id')) return; // Already tagged
    el.setAttribute('data-ag-click-id', 'scheddlg:' + idx);
    el.setAttribute('data-ag-click-label', (el.textContent || '').trim().substring(0, 50));
    idx++;
    tagged.push(el);
  });
  // Sync live input/textarea values into attributes before cloning
  // (cloneNode copies HTML attributes but not live .value properties)
  const valuedEls = [];
  overlay.querySelectorAll('input, textarea').forEach(el => {
    const liveVal = el.value || '';
    if (el.tagName === 'TEXTAREA') {
      el.setAttribute('data-ag-value', liveVal);
    } else {
      el.setAttribute('data-ag-value', liveVal);
    }
    valuedEls.push(el);
  });
  // Clone only the inner card (skip the outer overlay wrapper with fixed/inset/z-index)
  const card = overlay.querySelector('[class*="shadow-xl"]') || overlay.firstElementChild || overlay;
  const clone = card.cloneNode(true);
  tagged.forEach(el => {
    el.removeAttribute('data-ag-click-id');
    el.removeAttribute('data-ag-click-label');
  });
  valuedEls.forEach(el => el.removeAttribute('data-ag-value'));
  clone.querySelectorAll('style').forEach(s => s.remove());
  return clone.outerHTML;
})()
