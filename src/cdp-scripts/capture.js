import { TAG_INTERACTIVES_FN } from './_shared.js';

export const CAPTURE_SCRIPT = `
(async () => {
  ${TAG_INTERACTIVES_FN}

  // -- 1. Find the chat container --
  // First try the normal chat container
  let container =
    document.querySelector('.scrollbar-hide[class*="overflow-y-auto"]') ||
    document.querySelector('[data-testid="conversation-view"]') ||
    document.getElementById('conversation') ||
    document.getElementById('chat') ||
    document.getElementById('cascade');

  // Detect "new session" page: either the scrollbar-hide container has zero height,
  // or no container was found at all (AG removes it from DOM when switching views).
  // In both cases, capture the new session page content area instead.
  let isNewSessionPage = false;
  if (!container || container.clientHeight === 0) {
    const inputBox = document.getElementById('antigravity.agentSidePanelInputBox');
    if (inputBox) {
      // Walk up from inputBox to find the new session page root.
      // It has class "animate-fade-in" and contains the full session setup UI.
      let newSessionRoot = inputBox;
      for (let i = 0; i < 10; i++) {
        if (!newSessionRoot.parentElement) break;
        newSessionRoot = newSessionRoot.parentElement;
        const cls = newSessionRoot.className?.toString() || '';
        if (cls.includes('animate-fade-in')) break;
      }
      container = newSessionRoot;
      isNewSessionPage = true;
    }
  }

  if (!container) return null;

  // -- 2. Detect if agent is generating --
  const stopBtn =
    document.querySelector('[data-tooltip-id="input-send-button-cancel-tooltip"]') ||
    document.querySelector('button svg.lucide-square')?.closest('button');
  const agentRunning = !!(stopBtn && stopBtn.offsetParent !== null);

  // -- 3. Scroll info --
  const scrollInfo = {
    scrollTop: container.scrollTop,
    scrollHeight: container.scrollHeight,
    clientHeight: container.clientHeight,
  };

  // -- 4. Mark positioned elements + tag chat interactives --
  const marked = [];
  container.querySelectorAll('*').forEach(el => {
    try {
      const cs = getComputedStyle(el);
      if (cs.position === 'fixed' || cs.position === 'absolute') {
        el.setAttribute('data-ag-remove', '1');
        marked.push(el);
      }
      if (cs.position === 'sticky') {
        el.setAttribute('data-ag-sticky', '1');
        marked.push(el);
      }
    } catch {}
  });
  const chatTagged = tagInteractives(container, 'chat', false, true, 80);

  // -- 5. Clone chat container --
  const clone = container.cloneNode(true);

  // -- 6. Unmark originals --
  marked.forEach(el => {
    el.removeAttribute('data-ag-remove');
    el.removeAttribute('data-ag-sticky');
  });
  untagAll(chatTagged);

  // -- 7. Clean clone: remove editor/input (skip on new session page — it IS the input) --
  if (!isNewSessionPage) {
    ['[contenteditable="true"]', '[data-lexical-editor]', '[role="textbox"]', 'form'].forEach(sel => {
      clone.querySelectorAll(sel).forEach(el => {
        let target = el;
        while (target.parentElement && target.parentElement !== clone) {
          const btn = target.parentElement.querySelector('button, [role="button"]');
          if (/^(Allow|Deny|Review|Run|Confirm|Accept|Reject)/i.test(btn?.textContent?.trim() || '')) break;
          target = target.parentElement;
        }
        if (target.parentElement === clone) target.remove();
        else el.remove();
      });
    });
  }

  // -- 8. Remove fixed/absolute overlays (protect action bars) --
  clone.querySelectorAll('[data-ag-remove]').forEach(el => {
    let isActionBar = false;
    el.querySelectorAll('button, [role="button"]').forEach(b => {
      const label = b.textContent?.trim() || b.getAttribute('aria-label') || '';
      if (/^(Allow|Deny|Review|Run|Confirm|Undo)/i.test(label)) isActionBar = true;
    });
    if (!isActionBar) el.remove();
    else el.removeAttribute('data-ag-remove');
  });

  // -- 9. Force sticky backgrounds --
  clone.querySelectorAll('[data-ag-sticky]').forEach(el => {
    el.style.backgroundColor = '#101010';
  });

  // -- 10. Fix inline div-inside-span/p --
  clone.querySelectorAll('span > div, p > div').forEach(div => {
    const span = document.createElement('span');
    span.innerHTML = div.innerHTML;
    span.style.display = 'inline-flex';
    span.style.alignItems = 'center';
    for (const attr of div.attributes) {
      if (attr.name !== 'style') span.setAttribute(attr.name, attr.value);
    }
    div.replaceWith(span);
  });

  // -- 11. Force paragraph display block --
  clone.querySelectorAll('p').forEach(p => { p.style.display = 'block'; });

  // -- 12. Get chat HTML + strip [object Object] --
  let html = clone.innerHTML;
  html = html.replace(/class="([^"]*)"/g, (match, classes) => {
    if (!classes.includes('[object Object]')) return match;
    const cleaned = classes.replace(/\\[object Object\\]/g, '').replace(/\\s+/g, ' ').trim();
    return 'class="' + cleaned + '"';
  });

  // -- 13. Collect CSS --
  let css = '';
  for (const sheet of document.styleSheets) {
    try {
      for (const rule of sheet.cssRules) { css += rule.cssText + '\\n'; }
    } catch {}
  }

  // -- 13b. Extract ALL CSS custom properties from DOM --
  // AG defines theme vars on DOM elements (not in stylesheets). Instead of a
  // hardcoded list, enumerate every --* property so diff colors, chart colors,
  // and any future vars are captured automatically.
  const rootStyle = getComputedStyle(document.documentElement);
  const bodyStyle = document.body ? getComputedStyle(document.body) : null;
  const themeRules = [];
  const seen = new Set();
  for (const source of [rootStyle, bodyStyle]) {
    if (!source) continue;
    for (const name of source) {
      if (name.startsWith('--') && !seen.has(name)) {
        const val = source.getPropertyValue(name).trim();
        if (val) {
          themeRules.push(name + ':' + val);
          seen.add(name);
        }
      }
    }
  }
  if (themeRules.length > 0) {
    css = ':root{' + themeRules.join(';') + '}\\n' + css;
  }

  // -- 14. Capture LEFT sidebar (bg-sidebar) --
  let leftSidebarHtml = null;
  try {
    const leftRoot = document.querySelector('.bg-sidebar');
    if (leftRoot && leftRoot.offsetParent !== null) {
      const leftTagged = tagInteractives(leftRoot, 'left', true, true);
      const leftClone = leftRoot.cloneNode(true);
      untagAll(leftTagged);
      leftSidebarHtml = leftClone.outerHTML;
    }
  } catch (e) {
    console.debug('[AG2R] Left sidebar capture error:', e.message);
  }

  // -- 15. Sidebar signature (lightweight change detection for right sidebar) --
  // Instead of cloning the entire right sidebar DOM every poll (can be 100KB+),
  // capture a ~50 byte signature: tab IDs + which tab is active.
  // The full sidebar HTML is fetched on-demand via GET /right-sidebar.
  let sidebarSignature = null;
  try {
    const tabBtns = document.querySelectorAll('[data-tab-id]');
    if (tabBtns.length > 0) {
      const tabs = [];
      for (const b of tabBtns) {
        const id = b.getAttribute('data-tab-id');
        const active = (b.className || '').includes('bg-secondary') ? '*' : '';
        tabs.push(id + active);
      }
      sidebarSignature = tabs.join(',');
    }
  } catch (e) {
    console.debug('[AG2R] Sidebar signature error:', e.message);
  }
  // Sidebar open state: true when AG's right sidebar panel is visible.
  // AG keeps close-aux-pane in the DOM even when sidebar is hidden —
  // check if it's actually visible (has layout dimensions).
  const closePaneBtn = document.querySelector('[data-testid="close-aux-pane"]');
  const isSidebarOpen = closePaneBtn ? closePaneBtn.offsetParent !== null && closePaneBtn.getBoundingClientRect().width > 0 : false;
  console.debug('[SidebarMirror:capture] isSidebarOpen:', isSidebarOpen, 'btn:', closePaneBtn ? 'exists' : 'null', 'offsetParent:', closePaneBtn?.offsetParent?.tagName || 'null', 'width:', closePaneBtn?.getBoundingClientRect().width);
  // -- 8. Capture portal elements (dropdowns, dialogs) from body --
  // AG renders these outside #root as direct body children.
  let dropdownHtml = null;
  let dialogHtml = null;
  try {
    for (const child of document.body.children) {
      if (child.id || child.tagName === 'SCRIPT' || child.tagName === 'STYLE') continue;
      const text = child.textContent.trim();
      if (!text) continue;

      // Dropdown menu (role="listbox")
      if (!dropdownHtml && child.getAttribute('role') === 'listbox') {
        const tagged = tagInteractives(child, 'dropdown', true, false);
        const clone = child.cloneNode(true);
        untagAll(tagged);
        dropdownHtml = clone.outerHTML;
      }

      // Dialog/modal (fixed overlay with buttons)
      const cls = child.className || '';
      if (!dialogHtml && cls.includes('fixed') && cls.includes('inset-0')) {
        const tagged = tagInteractives(child, 'dialog', true, false);
        const clone = child.cloneNode(true);
        untagAll(tagged);
        clone.querySelectorAll('style').forEach(s => s.remove());
        dialogHtml = clone.outerHTML;
      }

      // Popover dialog (role="dialog" portal, e.g. environment selector, context menus)
      if (!dialogHtml && child.getAttribute('role') === 'dialog') {
        const tagged = tagInteractives(child, 'dialog', true, false);
        const clone = child.cloneNode(true);
        untagAll(tagged);
        clone.querySelectorAll('style').forEach(s => s.remove());
        dialogHtml = clone.outerHTML;
      }
    }
  } catch (e) {
    console.debug('[AG2R] Portal capture error:', e.message);
  }

  // -- 8b. Capture Settings modal (rendered inside #root, not body) --
  let settingsHtml = null;
  try {
    const settingsOverlay = document.querySelector('#root .fixed.inset-0[class*="z-[2550]"]');
    if (settingsOverlay && settingsOverlay.getBoundingClientRect().width > 0) {
      // Find the settings content container inside the overlay
      const settingsCard = settingsOverlay.querySelector('[class*="max-w-5xl"]') ||
                           settingsOverlay.querySelector('[class*="rounded-2xl"]');
      if (settingsCard) {
        const tagged = tagInteractives(settingsCard, 'settings', true, false);
        const clone = settingsCard.cloneNode(true);
        untagAll(tagged);
        clone.querySelectorAll('style').forEach(s => s.remove());
        settingsHtml = clone.outerHTML;
      }
    }
  } catch (e) {
    console.debug('[AG2R] Settings capture error:', e.message);
  }

  // -- 9. Detect active tab URI for commenting --
  // Active tab has 'bg-secondary' class; inactive tabs don't.
  // Supports both artifact tabs (artifact__xxx) and code diff file tabs.
  let activeArtifactUri = null;
  let activeFileUri = null;
  try {
    const activeTab = document.querySelector('[data-tab-id].bg-secondary');
    if (activeTab) {
      const tabId = activeTab.getAttribute('data-tab-id');
      // Skip structural tabs — not commentable content
      if (tabId !== 'overview' && tabId !== 'review') {
        if (tabId.startsWith('artifact__')) {
          activeArtifactUri = tabId.replace('artifact__', '');
        } else {
          activeFileUri = tabId;
        }
      }
    }
  } catch (e) {
    console.debug('[AG2R] Active tab detection error:', e.message);
  }

  // -- 10. Detect and capture permission/approval banner --
  let permissionHtml = null;
  try {
    const radioGroup = document.querySelector('[role="radiogroup"]');
    if (radioGroup) {
      // Walk up to find the full banner container
      let banner = radioGroup;
      for (let i = 0; i < 10; i++) {
        if (!banner.parentElement || banner.parentElement === document.body) break;
        banner = banner.parentElement;
        if (/allow|permission/i.test(banner.textContent) && banner.querySelectorAll('button').length >= 1) break;
      }
      // Tag interactive elements: radio labels and buttons
      let permIdx = 0;
      const permTagged = [];
      banner.querySelectorAll('[role="radiogroup"] label').forEach(el => {
        el.setAttribute('data-ag-click-id', 'perm:' + permIdx);
        el.setAttribute('data-ag-click-label', (el.textContent || '').trim().substring(0, 50));
        permIdx++;
        permTagged.push(el);
      });
      banner.querySelectorAll('button').forEach(el => {
        el.setAttribute('data-ag-click-id', 'perm:' + permIdx);
        el.setAttribute('data-ag-click-label', (el.textContent || '').trim().substring(0, 50));
        permIdx++;
        permTagged.push(el);
      });
      const permClone = banner.cloneNode(true);
      permTagged.forEach(el => {
        el.removeAttribute('data-ag-click-id');
        el.removeAttribute('data-ag-click-label');
      });
      permissionHtml = permClone.outerHTML;
    }
  } catch (e) {
    console.debug('[AG2R] Permission banner capture error:', e.message);
  }

  // -- 11. Extract environment/worktree and branch from new session bottom bar --
  // The environment button (aria-label="Select Environment") shows "Local" or "New Worktree" or a worktree name.
  // The branch button (aria-label="Select Default Branch") shows the branch name and only appears in worktree mode.
  let environmentName = null;
  let branchName = null;
  try {
    const envBtn = document.querySelector('[aria-label="Select Environment"]');
    if (envBtn) {
      const span = envBtn.querySelector('span');
      environmentName = span ? span.textContent.trim() : (envBtn.textContent || '').trim();
    }
    const branchBtn = document.querySelector('[aria-label="Select Default Branch"]');
    if (branchBtn) {
      const span = branchBtn.querySelector('span');
      branchName = span ? span.textContent.trim() : (branchBtn.textContent || '').trim();
    }
  } catch (e) {
    console.debug('[AG2R] Environment/branch extraction error:', e.message);
  }

  // -- 12. Extract model name from model selector button --
  let modelName = null;
  try {
    const modelBtn = document.querySelector('[aria-label*="Select model"]');
    if (modelBtn) {
      const span = modelBtn.querySelector('span');
      modelName = span ? span.textContent.trim() : (modelBtn.textContent || '').trim();
    }
  } catch (e) {
    console.debug('[AG2R] Model name extraction error:', e.message);
  }

  // -- 13. Detect subagent view --
  // Two independent signals, both required to confirm subagent view:
  //   1. AG removes the inputBox entirely when viewing a subagent conversation.
  //   2. A breadcrumb navigation bar appears above the conversation container.
  // Requiring both prevents false positives during transient states (e.g., permission
  // prompt submission briefly removes the inputBox).
  let isSubagentView = false;
  let parentConversationName = '';
  try {
    const inputBox = document.getElementById('antigravity.agentSidePanelInputBox');
    const noInputBox = !inputBox && !isNewSessionPage && !!container;

    // Breadcrumb detection: extract parent conversation name from navigation bar
    let hasBreadcrumb = false;
    if (!isNewSessionPage && container) {
      const cvParent = container.parentElement;
      if (cvParent) {
        for (const child of cvParent.children) {
          if (child === container) break; // Only check siblings BEFORE the container
          const rect = child.getBoundingClientRect();
          // Look for a small visible bar (breadcrumb height ~24-48px)
          if (rect.height > 8 && rect.height < 80) {
            const links = child.querySelectorAll('a, button, [role="link"], [class*="cursor-pointer"]');
            const text = child.textContent.trim();
            if (links.length > 0 && text.length > 0 && text.length < 300) {
              hasBreadcrumb = true;
              // Extract parent name from breadcrumb segments (separated by / or > or ›)
              const parts = text.split(/[/›>]/).map(s => s.trim()).filter(Boolean);
              if (parts.length >= 2) {
                parentConversationName = parts[parts.length - 2];
              } else {
                parentConversationName = parts[0] || text;
              }
              break;
            }
          }
        }
      }
    }

    // Both signals required to confirm subagent view
    isSubagentView = noInputBox && hasBreadcrumb;
  } catch (e) {
    console.debug('[AG2R] Subagent detection error:', e.message);
  }

  // -- 13b. Capture subagent info panel --
  // When in subagent view, AG renders a "cannot prompt subagents" message and
  // "Open overview" button somewhere in the page. Search for it and capture.
  let subagentInfoHtml = null;
  if (isSubagentView) {
    try {
      // Find the narrowest container with "cannot prompt" or "open overview" text
      const allDivs = document.querySelectorAll('div');
      let infoPanel = null;
      for (const div of allDivs) {
        const txt = div.textContent.trim().toLowerCase();
        if ((txt.includes('cannot') && txt.includes('prompt')) || 
            (txt.includes('open') && txt.includes('overview'))) {
          // Prefer the narrowest (most specific) container
          if (!infoPanel || (infoPanel.contains(div) && div !== infoPanel)) {
            infoPanel = div;
          }
        }
      }
      if (infoPanel) {
        // Tag interactive elements for click proxying
        let subIdx = 0;
        const subTagged = [];
        infoPanel.querySelectorAll('button, a, [role="button"]').forEach(el => {
          el.setAttribute('data-ag-click-id', 'subinfo:' + subIdx);
          el.setAttribute('data-ag-click-label', (el.textContent || '').trim().substring(0, 80));
          subIdx++;
          subTagged.push(el);
        });
        const subClone = infoPanel.cloneNode(true);
        subTagged.forEach(el => {
          el.removeAttribute('data-ag-click-id');
          el.removeAttribute('data-ag-click-label');
        });
        subagentInfoHtml = subClone.outerHTML;
      }
    } catch (e) {
      console.debug('[AG2R] Subagent info capture error:', e.message);
    }
  }

  return { html, css, agentRunning, scrollInfo, leftSidebarHtml, sidebarSignature, isSidebarOpen, isNewSessionPage, isSubagentView, parentConversationName, subagentInfoHtml, dropdownHtml, dialogHtml, settingsHtml, activeArtifactUri, activeFileUri, permissionHtml, environmentName, branchName, modelName };
})()
`;
