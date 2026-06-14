(() => {
  const anchor = findScheduledTasksAnchor();
  if (!anchor) return { ok: false, reason: 'no_scheduled_tasks_page' };
  const inner = findScheduledTasksContainer(anchor);
  const elements = [];
  inner.querySelectorAll('button, a, [role="button"], input, select, textarea').forEach(el => elements.push(el));
  // Also include cursor-pointer divs (task cards are DIVs, not buttons)
  inner.querySelectorAll('[class*="cursor-pointer"]').forEach(el => {
    if (elements.includes(el)) return;
    const text = (el.textContent || '').trim();
    if (text.length > 200) return;
    elements.push(el);
  });
  const idx = __SCHED_IDX__;
  if (idx < 0 || idx >= elements.length) return { ok: false, reason: 'sched_index_out_of_range', total: elements.length };
  const target = elements[idx];
  const actualLabel = (target.textContent || target.getAttribute('placeholder') || '').trim().substring(0, 80);
  // For inputs/textareas, focus instead of click
  if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
    target.focus();
  } else {
    target.click();
  }
  return { ok: true, label: actualLabel, source: 'sched' };
})()
