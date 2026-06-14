// CDP script: inject text into AG's editor and submit
// Extracted from server.js buildInjectScript()

export function buildInjectScript(safeText, appendMode) {
  return `
(async () => {
  // Find the editor (Lexical or generic contenteditable)
  const editorCandidates = document.querySelectorAll(
    '[data-lexical-editor="true"], [contenteditable="true"][role="textbox"], [contenteditable="true"]'
  );

  // Filter to visible editors, take the last one (usually the input at bottom)
  let editor = null;
  for (const el of editorCandidates) {
    if (el.offsetParent !== null) editor = el;
  }
  if (!editor) return { ok: false, reason: 'no_editor' };

  editor.focus();
  if (${appendMode}) {
    // Append mode: move cursor to end (preserve images/existing content)
    const sel = window.getSelection();
    sel.selectAllChildren(editor);
    sel.collapseToEnd();
  } else {
    // Normal mode: clear editor first
    document.execCommand('selectAll', false, null);
    document.execCommand('delete', false, null);
  }

  // Insert text via clipboard paste to preserve newlines in Lexical editor
  const textVal = ${safeText};
  const dt = new DataTransfer();
  dt.setData('text/plain', textVal);
  const pasteEvent = new ClipboardEvent('paste', {
    clipboardData: dt, bubbles: true, cancelable: true,
  });
  // dispatchEvent returns false if a handler called preventDefault (= paste was handled).
  // Returns true if no handler caught it (= need fallback).
  const notHandled = editor.dispatchEvent(pasteEvent);
  if (notHandled) {
    // No paste handler caught it — fall back to insertText (single-line only)
    document.execCommand('insertText', false, textVal);
  }

  // Brief delay for editor to process
  await new Promise(r => setTimeout(r, 100));

  // Find and click submit button
  const submitSelectors = [
    'button[data-testid="send-button"]',
    'button[aria-label*="send" i]',
    'button[aria-label*="submit" i]',
  ];

  let submitBtn = null;
  for (const sel of submitSelectors) {
    submitBtn = document.querySelector(sel);
    if (submitBtn && submitBtn.offsetParent !== null) break;
    submitBtn = null;
  }

  // Fallback: look for arrow icon button near the editor
  if (!submitBtn) {
    const arrow = document.querySelector('svg.lucide-arrow-right, svg.lucide-arrow-up');
    if (arrow) submitBtn = arrow.closest('button');
  }

  // Fallback: form submit or sibling button
  if (!submitBtn) {
    const form = editor.closest('form');
    if (form) submitBtn = form.querySelector('button[type="submit"], button:last-of-type');
  }
  if (!submitBtn) {
    const parent = editor.parentElement;
    if (parent) submitBtn = parent.querySelector('button');
  }

  if (submitBtn) {
    submitBtn.click();
    return { ok: true, method: 'button' };
  }

  // Last resort: dispatch Enter key
  const enterEvent = new KeyboardEvent('keydown', {
    key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true,
  });
  editor.dispatchEvent(enterEvent);
  return { ok: true, method: 'enter' };
})()
`;
}
