export const STOP_SCRIPT = `
(async () => {
  // Primary: tooltip-based cancel button
  const cancelBtn = document.querySelector('[data-tooltip-id="input-send-button-cancel-tooltip"]');
  if (cancelBtn && cancelBtn.offsetParent !== null) {
    cancelBtn.click();
    return { ok: true, method: 'cancel-tooltip' };
  }

  // Fallback: square stop icon
  const squareIcon = document.querySelector('button svg.lucide-square');
  if (squareIcon) {
    const btn = squareIcon.closest('button');
    if (btn && btn.offsetParent !== null) {
      btn.click();
      return { ok: true, method: 'square-icon' };
    }
  }

  return { ok: false, reason: 'no_stop_button' };
})()
`;
