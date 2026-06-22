// CDP script: main click dispatcher for all source types
// Extracted from server.js POST /click (general handler)
// This is the largest inline script — handles chat, left, right, dropdown,
// dialog, settings, perm, env, model, project, task sources.

export function buildMainClickScript(safeClickId, safeLabel) {
  return `
    (async () => {
      const clickId = ${safeClickId};
      const expectedLabel = ${safeLabel};

      // Parse prefix:index
      const colonIdx = clickId.indexOf(':');
      if (colonIdx === -1) return { ok: false, reason: 'invalid_click_id' };
      const source = clickId.substring(0, colonIdx);
      const idx = parseInt(clickId.substring(colonIdx + 1), 10);

      // Find the root element based on source
      let root = null;
      if (source === 'chat') {
        root =
          document.querySelector('.scrollbar-hide[class*="overflow-y-auto"]') ||
          document.querySelector('[data-testid="conversation-view"]') ||
          document.getElementById('conversation') ||
          document.getElementById('chat') ||
          document.getElementById('cascade');
      } else if (source === 'left') {
        root = document.querySelector('.bg-sidebar');
      } else if (source === 'right') {
        // Anchor-based: find via tab-id buttons or close-aux-pane
        const tabBtn = document.querySelector('[data-tab-id="overview"], [data-tab-id="review"]');
        const anchor = tabBtn || document.querySelector('[data-testid="close-aux-pane"]');
        if (anchor) {
          let el = anchor;
          for (let i = 0; i < 10 && el; i++) {
            el = el.parentElement;
            const cls = el?.className?.toString?.() || '';
            if (cls.includes('flex') && cls.includes('flex-col') && el.children.length >= 2) {
              root = el;
              break;
            }
          }
        }
      } else if (source === 'dropdown') {
        // Portal dropdown: body > div[role="listbox"]
        for (const child of document.body.children) {
          if (child.getAttribute('role') === 'listbox' && child.textContent.trim()) {
            root = child;
            break;
          }
        }
      } else if (source === 'dialog') {
        // Portal dialog: body > div.fixed.inset-0 (modal) or body > div[role="dialog"] (popover)
        for (const child of document.body.children) {
          const cls = child.className || '';
          if (cls.includes('fixed') && cls.includes('inset-0')) {
            root = child;
            break;
          }
          if (!root && child.getAttribute('role') === 'dialog') {
            root = child;
          }
        }
      } else if (source === 'settings') {
        // Settings overlay: same selector as capture
        const settingsOverlay = document.querySelector('#root .fixed.inset-0[class*="z-[2550]"]');
        if (settingsOverlay) {
          root = settingsOverlay.querySelector('[class*="max-w-5xl"]') ||
                 settingsOverlay.querySelector('[class*="rounded-2xl"]') ||
                 settingsOverlay;
        }
      } else if (source === 'perm') {
        // Permission banner: find radiogroup document-wide (it's outside the scroll container)
        const radioGroup = document.querySelector('[role="radiogroup"]');
        if (radioGroup) {
          let banner = radioGroup;
          for (let i = 0; i < 10; i++) {
            if (!banner.parentElement || banner.parentElement === document.body) break;
            banner = banner.parentElement;
            if (/allow|permission/i.test(banner.textContent) && banner.querySelectorAll('button').length >= 1) break;
          }
          // Build list: labels first, then buttons (same order as capture tagging)
          const permEls = [];
          banner.querySelectorAll('[role="radiogroup"] label').forEach(el => permEls.push(el));
          banner.querySelectorAll('button').forEach(el => permEls.push(el));
          if (idx >= 0 && idx < permEls.length) {
            const target = permEls[idx];
            const actualLabel = (target.textContent || '').trim().substring(0, 50);
            target.click();
            return { ok: true, label: actualLabel, source: 'perm' };
          }
          return { ok: false, reason: 'perm_index_out_of_range', total: permEls.length };
        }
        return { ok: false, reason: 'no_permission_banner' };
      } else if (source === 'env') {
        // Environment/branch buttons on new session page bottom bar
        const selectors = [
          '[aria-label="Select Environment"]',   // env:0
          '[aria-label="Select Default Branch"]', // env:1
        ];
        if (idx >= 0 && idx < selectors.length) {
          const target = document.querySelector(selectors[idx]);
          if (target) {
            const actualLabel = (target.textContent || '').trim().substring(0, 50);
            target.click();
            return { ok: true, label: actualLabel, source: 'env' };
          }
          return { ok: false, reason: 'env_button_not_found', idx };
        }
        return { ok: false, reason: 'env_index_out_of_range' };
      } else if (source === 'model') {
        // Model selector button — opens AG's model picker dialog
        const target = document.querySelector('[aria-label*="Select model"]');
        if (target) {
          const actualLabel = (target.textContent || '').trim().substring(0, 50);
          target.click();
          return { ok: true, label: actualLabel, source: 'model' };
        }
        return { ok: false, reason: 'model_button_not_found' };
      } else if (source === 'project') {
        // Project dropdown button — opens AG's project picker dialog
        const target = document.querySelector('[aria-haspopup="dialog"]');
        if (target) {
          const actualLabel = (target.textContent || '').trim().substring(0, 50);
          target.click();
          return { ok: true, label: actualLabel, source: 'project' };
        }
        return { ok: false, reason: 'project_button_not_found' };
      } else if (source === 'task') {
        // Running tasks: find task section and click the Nth button
        const inputBox = document.getElementById('antigravity.agentSidePanelInputBox');
        if (inputBox) {
          const taskSection = inputBox.querySelector('.rounded-t-2xl');
          if (taskSection) {
            const btns = taskSection.querySelectorAll('button');
            if (idx >= 0 && idx < btns.length) {
              const target = btns[idx];
              const actualLabel = (target.textContent || '').trim().substring(0, 80);
              target.click();
              return { ok: true, label: actualLabel, source: 'task' };
            }
            return { ok: false, reason: 'task_index_out_of_range', total: btns.length };
          }
          return { ok: false, reason: 'no_task_section' };
        }
        return { ok: false, reason: 'no_input_box' };
      } else if (source === 'subinfo') {
        // Subagent info panel: find by text content (same approach as capture)
        const allDivs = document.querySelectorAll('div');
        let infoPanel = null;
        for (const div of allDivs) {
          const txt = div.textContent.trim().toLowerCase();
          if ((txt.includes('cannot') && txt.includes('prompt')) ||
              (txt.includes('open') && txt.includes('overview'))) {
            if (!infoPanel || (infoPanel.contains(div) && div !== infoPanel)) {
              infoPanel = div;
            }
          }
        }
        if (infoPanel) {
          const btns = infoPanel.querySelectorAll('button, a, [role="button"]');
          if (idx >= 0 && idx < btns.length) {
            const target = btns[idx];
            const actualLabel = (target.textContent || '').trim().substring(0, 80);
            target.click();
            return { ok: true, label: actualLabel, source: 'subinfo' };
          }
          return { ok: false, reason: 'subinfo_index_out_of_range', total: btns.length };
        }
        return { ok: false, reason: 'no_subinfo_panel' };
      }

      if (!root) return { ok: false, reason: 'no_root_for_' + source };

      // Settings: inline the same logic as tagInteractives(root, 'settings', true, false)
      // to guarantee identical enumeration between capture and click.
      // tagInteractives isn't available here (it's in the capture closure),
      // so we reproduce its logic: tag buttons/links with skipVisibilityCheck=true,
      // includeCursorPointer=false.
      if (source === 'settings') {
        let sIdx = 0;
        root.querySelectorAll('button, a, [role="button"]').forEach(el => {
          el.setAttribute('data-ag-click-id', 'settings:' + sIdx);
          sIdx++;
        });
        const target = root.querySelector('[data-ag-click-id="' + clickId + '"]');
        // Clean up tags
        root.querySelectorAll('[data-ag-click-id]').forEach(el => el.removeAttribute('data-ag-click-id'));
        if (!target) return { ok: false, reason: 'settings_element_not_found', clickId, total: sIdx };
        const actualLabel = (target.textContent || '').trim().substring(0, 50);
        target.click();
        return { ok: true, label: actualLabel, source: 'settings' };
      }

      // Build the same interactive element list as capture
      const skipVis = (source === 'right' || source === 'left' || source === 'settings');
      // maxTextLength only applies to cursor-pointer elements (content vs action ambiguity)
      const maxLen = (source === 'chat') ? 80 : 0;
      const visible = [];
      // Semantic interactive elements — always include, no text-length filter
      root.querySelectorAll('button, a, [role="button"]').forEach(el => {
        if (skipVis || el.offsetParent !== null) {
          visible.push(el);
        }
      });
      // cursor-pointer elements — filter by text length to skip content containers
      // Exception: elements with onclick handler are definitively interactive
      root.querySelectorAll('[class*="cursor-pointer"]').forEach(el => {
        if ((skipVis || el.offsetParent !== null) && !visible.includes(el)) {
          const hasHandler = typeof el.onclick === 'function';
          if (maxLen && (el.textContent || '').trim().length > maxLen && !hasHandler) return;
          visible.push(el);
        }
      });

      if (idx < 0 || idx >= visible.length) {
        return { ok: false, reason: 'index_out_of_range', total: visible.length };
      }

      const target = visible[idx];
      const actualLabel = (target.textContent || '').trim().substring(0, 50);

      // Debug: dump elements around the target index to diagnose index drift
      const debugNearby = [];
      for (let d = Math.max(0, idx - 3); d <= Math.min(visible.length - 1, idx + 3); d++) {
        const el = visible[d];
        const txt = (el.textContent || '').trim().substring(0, 60);
        debugNearby.push(d + ':' + el.tagName + ' "' + txt + '"');
      }

      // Validate label matches (if provided) to prevent stale clicks
      if (expectedLabel && actualLabel !== expectedLabel) {
        return { ok: false, reason: 'label_mismatch', expected: expectedLabel, actual: actualLabel, total: visible.length, debugNearby };
      }

      target.click();

      return { ok: true, label: actualLabel, source, debugNearby };
    })()
`;
}
