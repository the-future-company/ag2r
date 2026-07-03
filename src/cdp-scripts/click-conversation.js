// Click a conversation in AG's left sidebar by its UUID.
// Finds the convo-pill-<id> test ID and clicks the parent role="button".
// Used by POST /navigate-conversation (notification click → open correct conversation).

export function buildClickConversationScript(safeConversationId) {
  return `
    (async () => {
      const conversationId = ${safeConversationId};

      // First ensure the sidebar is visible (expand if collapsed)
      const leftRoot = document.querySelector('.bg-sidebar');
      if (!leftRoot || leftRoot.offsetParent === null) {
        const toggleBtn = document.querySelector('[data-testid="sidebar-toggle"]');
        if (toggleBtn) toggleBtn.click();
        // Wait for sidebar to render
        await new Promise(r => setTimeout(r, 300));
      }

      // Find the conversation pill by data-testid
      const pill = document.querySelector('[data-testid="convo-pill-' + conversationId + '"]');
      if (!pill) return { ok: false, reason: 'pill_not_found', conversationId };

      // Walk up to the clickable role="button" ancestor
      let target = pill;
      for (let i = 0; i < 10 && target; i++) {
        if (target.getAttribute('role') === 'button') {
          target.click();
          const name = (target.textContent || '').trim().substring(0, 80);
          return { ok: true, conversationId, name };
        }
        target = target.parentElement;
      }

      // Fallback: click the pill's closest interactive ancestor
      const fallback = pill.closest('[role="button"], button, a');
      if (fallback) {
        fallback.click();
        return { ok: true, conversationId, fallback: true };
      }

      return { ok: false, reason: 'no_clickable_ancestor', conversationId };
    })()
  `;
}
