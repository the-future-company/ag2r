// CDP script: check if a visible Lexical/contenteditable editor exists.
// Synchronous (no async) — safe for cross-context probing with no GC risk.
// Used by findEditorContext() to detect which execution context has the editor
// before running side-effect scripts (inject, send, stop) in that context only.

export const HAS_VISIBLE_EDITOR_SCRIPT = `
  (() => {
    const candidates = document.querySelectorAll(
      '[data-lexical-editor="true"], [contenteditable="true"][role="textbox"], [contenteditable="true"]'
    );
    for (const el of candidates) {
      if (el.offsetParent !== null) return true;
    }
    return false;
  })()
`;
