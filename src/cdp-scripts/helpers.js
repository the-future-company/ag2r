// helpers.js — Shared browser-side helpers for CDP eval scripts
// These functions are PREPENDED to scripts that need them at load time.
// They run inside the Antigravity browser, NOT on the Node.js server.

/**
 * Tag interactive elements in a DOM subtree for click proxying.
 * Assigns data-ag-click-id and data-ag-click-label attributes.
 * Returns the tagged elements so they can be untagged after cloning.
 */
function tagInteractives(root, prefix, skipVisibilityCheck, includeCursorPointer, maxTextLength) {
  let idx = 0;
  const tagged = [];
  // Semantic interactive elements — always tag, no text-length filter
  root.querySelectorAll('button, a, [role="button"]').forEach(el => {
    if (skipVisibilityCheck || el.offsetParent !== null) {
      const text = (el.textContent || '').trim();
      el.setAttribute('data-ag-click-id', prefix + ':' + idx);
      el.setAttribute('data-ag-click-label', text.substring(0, 50));
      idx++;
      tagged.push(el);
    }
  });
  // cursor-pointer elements are ambiguous — could be content containers.
  // Apply maxTextLength to skip large content blocks (code blocks, paragraphs).
  // Exception: elements with a direct onclick handler are definitively interactive
  // (e.g. AG artifact cards), so they bypass the text-length filter.
  if (includeCursorPointer) {
    root.querySelectorAll('[class*="cursor-pointer"]').forEach(el => {
      if ((skipVisibilityCheck || el.offsetParent !== null) && !el.hasAttribute('data-ag-click-id')) {
        const text = (el.textContent || '').trim();
        const hasHandler = typeof el.onclick === 'function';
        if (maxTextLength && text.length > maxTextLength && !hasHandler) return;
        el.setAttribute('data-ag-click-id', prefix + ':' + idx);
        el.setAttribute('data-ag-click-label', text.substring(0, 50));
        idx++;
        tagged.push(el);
      }
    });
  }
  return tagged;
}

/**
 * Remove click-proxy tags from previously tagged elements.
 */
function untagAll(tagged) {
  tagged.forEach(el => {
    el.removeAttribute('data-ag-click-id');
    el.removeAttribute('data-ag-click-label');
  });
}

/**
 * Find the AG chat container using multiple fallback selectors.
 * Returns null if no container found.
 */
function findChatContainer() {
  return document.querySelector('.scrollbar-hide[class*="overflow-y-auto"]') ||
    document.querySelector('[data-testid="conversation-view"]') ||
    document.getElementById('conversation') ||
    document.getElementById('chat') ||
    document.getElementById('cascade');
}

/**
 * Find the Scheduled Tasks page anchor element.
 * Tries list view, detail view, and editing view in order.
 * Returns null if not on a scheduled tasks page.
 */
function findScheduledTasksAnchor() {
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
  return anchor;
}

/**
 * Walk up from an anchor element to find the scheduled tasks content container.
 * Stops when the parent's x-position is near the left edge (sidebar boundary).
 * Returns the inner content panel.
 */
function findScheduledTasksContainer(anchor) {
  let container = anchor;
  for (let i = 0; i < 15; i++) {
    if (!container.parentElement) break;
    const p = container.parentElement;
    if (p.getBoundingClientRect().x < 10) break;
    container = p;
  }
  return container.querySelector('.flex-1.flex.flex-col.min-w-0.h-full') || container;
}

/**
 * Build an ordered list of interactive elements in a DOM subtree.
 * Same enumeration logic as tagInteractives but returns an array without tagging.
 * Used by click proxy and copy-response to match the same element order as capture.
 */
function buildInteractiveList(root, skipVisibilityCheck, maxTextLength) {
  const visible = [];
  // Semantic interactive elements — always include, no text-length filter
  root.querySelectorAll('button, a, [role="button"]').forEach(el => {
    if (skipVisibilityCheck || el.offsetParent !== null) {
      visible.push(el);
    }
  });
  // cursor-pointer elements — filter by text length to skip content containers
  // Exception: elements with onclick handler are definitively interactive
  root.querySelectorAll('[class*="cursor-pointer"]').forEach(el => {
    if ((skipVisibilityCheck || el.offsetParent !== null) && !visible.includes(el)) {
      const hasHandler = typeof el.onclick === 'function';
      if (maxTextLength && (el.textContent || '').trim().length > maxTextLength && !hasHandler) return;
      visible.push(el);
    }
  });
  return visible;
}
