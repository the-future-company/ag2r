(async () => {
  // Decode base64 to binary
  const base64 = __BASE64__;
  const mimetype = __MIMETYPE__;
  const fileName = __FILENAME__;

  const binaryStr = atob(base64);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }

  const file = new File([bytes], fileName, { type: mimetype });

  // Find the drop target — the editor or the chat area
  const editorCandidates = document.querySelectorAll(
    '[data-lexical-editor="true"], [contenteditable="true"][role="textbox"], [contenteditable="true"]'
  );
  let editor = null;
  for (const el of editorCandidates) {
    if (el.offsetParent !== null) editor = el;
  }
  if (!editor) return { ok: false, reason: 'no_editor' };

  // Build DataTransfer with the file
  const dt = new DataTransfer();
  dt.items.add(file);

  // Dispatch full drag sequence — React needs dragenter/dragover before drop
  editor.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true }));
  editor.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
  editor.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));

  return { ok: true, method: 'drop', fileName, size: bytes.length };
})()
