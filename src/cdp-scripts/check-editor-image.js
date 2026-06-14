// CDP script: check if AG's editor contains image content
// Extracted from server.js waitForEditorImage()

export const CHECK_EDITOR_IMAGE_SCRIPT = `
    (() => {
      const editors = document.querySelectorAll(
        '[data-lexical-editor="true"], [contenteditable="true"][role="textbox"]'
      );
      for (const ed of editors) {
        if (ed.offsetParent === null) continue;
        if (ed.querySelector('img, [data-lexical-decorator]')) return true;
        const text = ed.textContent.trim();
        if (text && !ed.querySelector('[data-placeholder]')?.textContent?.includes(text)) return true;
      }
      return false;
    })()
`;
