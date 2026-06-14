(async () => {
  // Click the backdrop overlay behind the settings card to close entirely.
  // Don't use 'Go Back' — it navigates through tab history instead of closing.
  const overlay = document.querySelector('.fixed.inset-0[class*="z-[2550]"]');
  if (overlay) {
    // The backdrop is the overlay itself; clicking outside the card closes settings.
    // Dispatch click at the overlay edges (not on the card).
    const rect = overlay.getBoundingClientRect();
    overlay.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 5, clientY: 5 }));
    return { ok: true, method: 'backdrop' };
  }
  // Fallback: press Escape
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  return { ok: true, method: 'escape' };
})()
