// CDP script: click a Conversation History page element by index
// Mirrors the same selection logic as CONVERSATION_HISTORY_SCRIPT in conversation-history.js

export function buildHistoryClickScript(histIdx) {
  return `
    (() => {
      // Find the main history container (x > 200px, height > 300)
      const container = Array.from(
        document.querySelectorAll('.h-full.w-full.overflow-y-auto')
      ).find(el => {
        const r = el.getBoundingClientRect();
        return r.x > 200 && r.height > 300;
      });
      if (!container) return { ok: false, reason: 'no_history_page' };

      const heading = container.querySelector('.text-lg.font-medium');
      if (!heading || heading.textContent.trim() !== 'Conversation History') {
        return { ok: false, reason: 'not_history_page' };
      }

      const inner = container.querySelector('.w-full.max-w-2xl') || container;

      // Rebuild the same ordered element list as the capture script
      const elements = [];
      inner.querySelectorAll('button, a, [role="button"], input').forEach(el => elements.push(el));
      inner.querySelectorAll('[class*="cursor-pointer"]').forEach(el => {
        if (elements.includes(el)) return;
        const text = (el.textContent || '').trim();
        if (text.length > 200) return;
        elements.push(el);
      });

      const idx = ${histIdx};
      if (idx < 0 || idx >= elements.length) {
        return { ok: false, reason: 'history_index_out_of_range', total: elements.length };
      }

      const target = elements[idx];
      const actualLabel = (target.textContent || target.getAttribute('placeholder') || '').trim().substring(0, 80);

      // For inputs, focus instead of click (opens keyboard)
      if (target.tagName === 'INPUT') {
        target.focus();
      } else {
        target.click();
      }

      return { ok: true, label: actualLabel, source: 'history' };
    })()
  `;
}
