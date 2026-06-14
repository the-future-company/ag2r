// Click a button and intercept clipboard.writeText to capture markdown.
// Used by POST /copy-response.
// Parameters: safeClickId — JSON.stringify'd clickId string

export function buildCopyResponseScript(safeClickId) {
  return `
    (async () => {
      const clickId = ${safeClickId};
      const colonIdx = clickId.indexOf(':');
      if (colonIdx === -1) return { ok: false, reason: 'invalid_click_id' };
      const source = clickId.substring(0, colonIdx);
      const idx = parseInt(clickId.substring(colonIdx + 1), 10);

      // Find root — same logic as /click
      let root = null;
      if (source === 'chat') {
        root =
          document.querySelector('.scrollbar-hide[class*="overflow-y-auto"]') ||
          document.querySelector('[data-testid="conversation-view"]') ||
          document.getElementById('conversation') ||
          document.getElementById('chat') ||
          document.getElementById('cascade');
      }
      if (!root) return { ok: false, reason: 'no_root' };

      // Build same element list as /click
      const maxLen = (source === 'chat') ? 80 : 0;
      const visible = [];
      root.querySelectorAll('button, a, [role="button"]').forEach(el => {
        if (el.offsetParent !== null) visible.push(el);
      });
      root.querySelectorAll('[class*="cursor-pointer"]').forEach(el => {
        if (el.offsetParent !== null && !visible.includes(el)) {
          const hasHandler = typeof el.onclick === 'function';
          if (maxLen && (el.textContent || '').trim().length > maxLen && !hasHandler) return;
          visible.push(el);
        }
      });

      const target = visible[idx];
      if (!target) return { ok: false, reason: 'element_not_found', idx, total: visible.length };

      // Intercept clipboard.writeText to capture markdown
      let captured = null;
      const orig = navigator.clipboard.writeText.bind(navigator.clipboard);
      navigator.clipboard.writeText = (text) => {
        captured = text;
        return orig(text);
      };
      try {
        target.click();
        await new Promise(r => setTimeout(r, 300));
      } finally {
        navigator.clipboard.writeText = orig;
      }
      return { ok: true, text: captured || '' };
    })()
  `;
}
