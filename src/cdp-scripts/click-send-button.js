// Click the send/submit button in AG's editor.
// Used by POST /send-images (image-only sends).

export const CLICK_SEND_BUTTON_SCRIPT = `
  (() => {
    // Find and click the send/submit button
    const selectors = [
      'button[data-testid="send-button"]',
      'button[aria-label*="send" i]',
      'button[aria-label*="submit" i]',
    ];
    let btn = null;
    for (const sel of selectors) {
      btn = document.querySelector(sel);
      if (btn && btn.offsetParent !== null) break;
      btn = null;
    }
    if (!btn) {
      const arrow = document.querySelector('svg.lucide-arrow-right, svg.lucide-arrow-up');
      if (arrow) btn = arrow.closest('button');
    }
    if (btn) {
      btn.click();
      return { ok: true, method: 'button' };
    }
    return { ok: false, reason: 'no_send_button' };
  })()
`;
