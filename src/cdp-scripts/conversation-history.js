export const CONVERSATION_HISTORY_SCRIPT = `
(() => {
  // The Conversation History page is at AG route /history.
  // Container: div.h-full.w-full.overflow-y-auto positioned right of sidebar (x > 200px).
  // Verified by heading text "Conversation History".

  const container = Array.from(
    document.querySelectorAll('.h-full.w-full.overflow-y-auto')
  ).find(el => {
    const r = el.getBoundingClientRect();
    return r.x > 200 && r.height > 300;
  });

  if (!container) return null;

  // Verify we are on the history page by checking for known heading text.
  const heading = container.querySelector('.text-lg.font-medium');
  if (!heading || heading.textContent.trim() !== 'Conversation History') return null;

  // Inner content panel (max-w-2xl centred card)
  const inner = container.querySelector('.w-full.max-w-2xl') || container;

  // Tag interactive elements (same order as click-history.js)
  let idx = 0;
  const tagged = [];
  inner.querySelectorAll('button, a, [role="button"], input').forEach(el => {
    el.setAttribute('data-ag-click-id', 'history:' + idx);
    el.setAttribute('data-ag-click-label', (el.textContent || el.getAttribute('placeholder') || '').trim().substring(0, 50));
    idx++;
    tagged.push(el);
  });
  // Conversation row cards (cursor-pointer divs — not buttons)
  inner.querySelectorAll('[class*="cursor-pointer"]').forEach(el => {
    if (el.hasAttribute('data-ag-click-id')) return;
    const text = (el.textContent || '').trim();
    if (text.length > 200) return;
    el.setAttribute('data-ag-click-id', 'history:' + idx);
    el.setAttribute('data-ag-click-label', text.substring(0, 50));
    idx++;
    tagged.push(el);
  });

  // Sync live input values into attributes before cloning
  // (cloneNode copies HTML attributes but not live .value properties)
  const valuedEls = [];
  inner.querySelectorAll('input').forEach(el => {
    valuedEls.push(el);
    el.setAttribute('data-ag-value', el.value || '');
  });

  const clone = inner.cloneNode(true);

  tagged.forEach(el => {
    el.removeAttribute('data-ag-click-id');
    el.removeAttribute('data-ag-click-label');
  });
  valuedEls.forEach(el => el.removeAttribute('data-ag-value'));

  // Strip inline <style> tags — AG's styles conflict with AG2R's CSS
  clone.querySelectorAll('style').forEach(s => s.remove());

  return clone.outerHTML;
})()
`;
