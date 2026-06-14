(() => {
  let el = null;

  // Strategy 1: find by placeholder
  const placeholder = __PLACEHOLDER__;
  if (placeholder) {
    const overlay = document.querySelector('.fixed.inset-0[class*="z-[2550]"]');
    const mainContent = document.querySelector('.flex-1.flex.flex-col.min-w-0.h-full');
    const scope = overlay || mainContent || document;
    el = scope.querySelector('input[placeholder=' + JSON.stringify(placeholder) + '], textarea[placeholder=' + JSON.stringify(placeholder) + ']');
  }

  // Strategy 2: find by clickId (sched:N or scheddlg:N)
  if (!el) {
    const clickId = __CLICK_ID__;
    if (clickId) {
      const parts = clickId.split(':');
      const prefix = parts[0];
      const idx = parseInt(parts[1], 10);

      if (prefix === 'sched') {
        // Use same anchor + element-finding logic as capture/click handler
        const anchor = findScheduledTasksAnchor();
        if (anchor) {
          const inner = findScheduledTasksContainer(anchor);
          const elements = inner.querySelectorAll('button, a, [role="button"], input, select, textarea');
          const cursorPointerDivs = inner.querySelectorAll('[class*="cursor-pointer"]');
          // Merge into ordered list (same order as capture)
          const allEls = [...elements];
          cursorPointerDivs.forEach(cpEl => {
            if (!allEls.includes(cpEl)) allEls.push(cpEl);
          });
          if (idx < allEls.length) el = allEls[idx];
        }
      } else if (prefix === 'scheddlg') {
        const overlay = document.querySelector('.fixed.inset-0[class*="z-[2550]"]');
        if (overlay) {
          const elements = overlay.querySelectorAll('button, a, [role="button"], input, select, textarea');
          if (idx < elements.length) el = elements[idx];
        }
      }
    }
  }

  if (!el) return { ok: false, reason: 'element_not_found', placeholder: __PLACEHOLDER__, clickId: __CLICK_ID__ };
  if (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') {
    return { ok: false, reason: 'not_input', tag: el.tagName };
  }

  // Focus the element
  el.focus();

  // Use React's native value setter to bypass synthetic events
  const nativeSetter = el.tagName === 'TEXTAREA'
    ? Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    : Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;

  nativeSetter.call(el, __TEXT__);

  // Dispatch input and change events to trigger React's onChange
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));

  return { ok: true, tag: el.tagName, placeholder: __PLACEHOLDER__, valueLength: el.value.length };
})()
