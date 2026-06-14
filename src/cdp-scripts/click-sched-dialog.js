// CDP script: click an element inside the z-[2550] dialog overlay
// Extracted from server.js POST /click (scheddlg: branch, idx < 100)

export function buildSchedDialogClickScript(dlgIdx, safeLabel) {
  return `
      (() => {
        const overlay = document.querySelector('.fixed.inset-0[class*="z-[2550]"]');
        if (!overlay || overlay.getBoundingClientRect().width <= 0) return { ok: false, reason: 'no_dialog' };
        // Must match the same selector order as SCHEDULED_TASKS_DIALOG_SCRIPT
        const elements = [];
        overlay.querySelectorAll('button, a, [role="button"], input, select, textarea, [role="combobox"], [role="switch"]').forEach(el => elements.push(el));
        overlay.querySelectorAll('div.cursor-pointer[aria-expanded]').forEach(el => {
          if (!elements.includes(el)) elements.push(el);
        });

        const idx = ${dlgIdx};
        const expectedLabel = ${safeLabel};

        // Try index-based match first
        let target = (idx >= 0 && idx < elements.length) ? elements[idx] : null;

        // Verify label matches; if not, fall back to label-based search
        if (target && expectedLabel) {
          const actualLabel = (target.textContent || target.getAttribute('placeholder') || '').trim().substring(0, 50);
          if (actualLabel !== expectedLabel) {
            // Index mismatch — search by label
            target = null;
            for (const el of elements) {
              const elLabel = (el.textContent || el.getAttribute('placeholder') || '').trim().substring(0, 50);
              if (elLabel === expectedLabel) { target = el; break; }
            }
          }
        }

        if (!target) return { ok: false, reason: 'element_not_found', idx: idx, label: expectedLabel, total: elements.length };
        const actualLabel = (target.textContent || target.getAttribute('placeholder') || '').trim().substring(0, 80);
        if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
          target.focus();
        } else {
          target.click();
        }
        return { ok: true, label: actualLabel, source: 'scheddlg' };
      })()
`;
}
