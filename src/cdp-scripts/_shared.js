// Shared browser-side helpers for CDP scripts.
// These are raw JS function definitions (not Node.js code) that get
// interpolated into template literals evaluated via CDP Runtime.evaluate.

export const TAG_INTERACTIVES_FN = `
  // -- Helper: tag interactive elements for click proxying --
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

  function untagAll(tagged) {
    tagged.forEach(el => {
      el.removeAttribute('data-ag-click-id');
      el.removeAttribute('data-ag-click-label');
    });
  }
`;
