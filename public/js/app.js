// app.js — AG2R Client
// WebSocket connection, snapshot rendering, stop/send logic, scroll management

// ─────────────────────────────────────────────
// State
// ─────────────────────────────────────────────
let ws = null;
let lastHash = null;
let agentRunning = false;
let cdpConnected = false;
let isRendering = false;
let isSending = false;
let userScrollLockUntil = 0;

// Mobile detection: coarse pointer = touchscreen (phone/tablet)
// On mobile, Enter inserts a newline; the send button sends.
// On desktop, Enter sends; Shift+Enter inserts a newline.
const isMobile = window.matchMedia('(pointer: coarse)').matches;

// ─────────────────────────────────────────────
// DOM References
// ─────────────────────────────────────────────
const chatArea = document.getElementById('chat-area');
const chatContent = document.getElementById('chat-content');
const cdpStyles = document.getElementById('cdp-styles');
const emptyState = document.getElementById('empty-state');
const scrollFab = document.getElementById('scroll-fab');
const messageInput = document.getElementById('message-input');
const actionBtn = document.getElementById('action-btn');
const actionIcon = document.getElementById('action-icon');
const connectionDot = document.getElementById('connection-status');
const sidebarToggle = document.getElementById('sidebar-toggle');
const reviewToggle = document.getElementById('review-toggle');

// Left sidebar (AG's chat list)
const leftSidebar = document.getElementById('left-sidebar');
const leftSidebarContent = document.getElementById('left-sidebar-content');
const leftSidebarCdpStyles = document.getElementById('left-sidebar-cdp-styles');
const leftSidebarOverlay = document.getElementById('left-sidebar-overlay');
// Right sidebar (AG's review panel)
const rightSidebar = document.getElementById('right-sidebar');
const rightSidebarContent = document.getElementById('right-sidebar-content');
const rightSidebarCdpStyles = document.getElementById('right-sidebar-cdp-styles');
const rightSidebarOverlay = document.getElementById('right-sidebar-overlay');
// Dropdown overlay (AG portal menus)
const dropdownOverlay = document.getElementById('dropdown-overlay');
const dropdownBackdrop = document.getElementById('dropdown-backdrop');
const dropdownContent = document.getElementById('dropdown-content');
// Comment UI
const commentFab = document.getElementById('comment-fab');
const commentModal = document.getElementById('comment-modal');
const commentModalBackdrop = document.getElementById('comment-modal-backdrop');
const commentSelectionPreview = document.getElementById('comment-selection-preview');
const commentInput = document.getElementById('comment-input');
const commentCancel = document.getElementById('comment-cancel');
const commentSubmit = document.getElementById('comment-submit');
// Input bar + quick actions
const inputBar = document.getElementById('input-bar');
const quickActions = document.getElementById('quick-actions');
// Permission overlay
const permissionOverlay = document.getElementById('permission-overlay');
const permissionBackdrop = document.getElementById('permission-backdrop');
const permissionContent = document.getElementById('permission-content');
// Suppression: ignore stale dialog/dropdown snapshots for a short window after user dismisses
let overlayDismissedAt = 0;

// ─────────────────────────────────────────────
// Fetch Wrapper (redirects to login on 401)
// ─────────────────────────────────────────────
async function fetchAPI(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      // Skip ngrok browser warning if tunneled
      'ngrok-skip-browser-warning': '1',
      ...opts.headers,
    },
  });

  if (res.status === 401) {
    window.location.href = '/login.html';
    throw new Error('Unauthorized');
  }

  return res;
}

// ─────────────────────────────────────────────
// WebSocket Connection
// ─────────────────────────────────────────────
let wsReconnectDelay = 1000;

function connectWebSocket() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${location.host}`;

  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    console.debug('[WS] Connected');
    wsReconnectDelay = 1000;
    updateConnectionStatus('connected');
  };

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);

      switch (data.type) {
        case 'snapshot':
          // Only reload if content actually changed
          if (data.hash !== lastHash) {
            loadSnapshot();
          }
          if (data.agentRunning !== undefined) {
            agentRunning = data.agentRunning;
            updateActionButton();
          }
          break;

        case 'status':
          if (data.agentRunning !== undefined) {
            agentRunning = data.agentRunning;
            updateActionButton();
          }
          break;

        case 'connection':
          cdpConnected = data.cdpConnected;
          updateConnectionStatus(cdpConnected ? 'connected' : 'reconnecting');
          if (!cdpConnected) {
            updateEmptyState('Waiting for Antigravity connection...');
          }
          break;

        case 'error':
          if (data.message === 'Unauthorized') {
            window.location.href = '/login.html';
          }
          break;
      }
    } catch (e) {
      console.debug('[WS] Parse error:', e);
    }
  };

  ws.onclose = () => {
    console.debug('[WS] Disconnected, reconnecting in', wsReconnectDelay, 'ms');
    updateConnectionStatus('disconnected');
    ws = null;
    setTimeout(connectWebSocket, wsReconnectDelay);
    wsReconnectDelay = Math.min(wsReconnectDelay * 1.5, 10000);
  };

  ws.onerror = () => {
    // onclose will fire after this
  };
}

// ─────────────────────────────────────────────
// Snapshot Loading & Rendering
// ─────────────────────────────────────────────
async function loadSnapshot() {
  try {
    const res = await fetchAPI(`/snapshot?t=${Date.now()}`);

    if (res.status === 503) {
      // No snapshot yet — show empty state but DON'T wipe existing content
      if (!chatContent.innerHTML.trim()) {
        showEmptyState();
      }
      return;
    }

    if (!res.ok) return;

    const data = await res.json();

    // Update hash
    lastHash = data.hash;

    // Update agent status
    if (data.agentRunning !== undefined) {
      agentRunning = data.agentRunning;
      updateActionButton();
    }

    // Inject CSS (Antigravity's stylesheets) into all panels
    if (data.css) {
      cdpStyles.textContent = data.css;
      leftSidebarCdpStyles.textContent = data.css;
      rightSidebarCdpStyles.textContent = data.css;
    }


    // Don't re-render the chat area if already on the new session page — our custom
    // form is already rendered and re-rendering would destroy the textarea (keyboard pop-up).
    const newSessionInput = document.getElementById('ag2r-new-session-input');
    const skipChatRender = data.isNewSessionPage && newSessionInput;

    if (skipChatRender) {
      // Still update env chips with fresh data (user may have changed worktree/branch)
      const envBar = chatContent.querySelector('.ag2r-new-session-env-bar');
      if (envBar && (data.environmentName || data.branchName)) {
        const environmentName = data.environmentName || '';
        const branchName = data.branchName || '';
        const envIcon = environmentName === 'Local'
          ? '<span class="material-symbols-rounded" style="font-size:14px">desktop_windows</span>'
          : '<span class="material-symbols-rounded" style="font-size:14px">account_tree</span>';
        let newEnvHtml = '';
        if (environmentName) {
          newEnvHtml = `
            <button type="button" class="ag2r-env-chip" data-ag-click-id="env:0" data-ag-click-label="${environmentName}">
              ${envIcon}
              <span>${environmentName}</span>
              <span class="material-symbols-rounded" style="font-size:12px">expand_more</span>
            </button>
            ${branchName ? `
            <button type="button" class="ag2r-env-chip" data-ag-click-id="env:1" data-ag-click-label="${branchName}">
              <span class="material-symbols-rounded" style="font-size:14px">fork_right</span>
              <span>${branchName}</span>
              <span class="material-symbols-rounded" style="font-size:12px">expand_more</span>
            </button>` : ''}
          `;
        }
        envBar.innerHTML = newEnvHtml;
        addClickProxyHandlers(envBar);
      }
    } else {
      // Render HTML
      chatContent.innerHTML = data.html;
      hideEmptyState();

      // If this is the new session page, replace captured content with a functional input
      if (data.isNewSessionPage) {
        renderNewSessionPage(chatContent, data);
        // Close sidebar when transitioning to new session page (+ button)
        closeLeftSidebar();
      }

      // Hide bottom input bar + quick actions on new session page (it has its own input)
      const hideBottomBar = data.isNewSessionPage;
      inputBar.classList.toggle('hidden', hideBottomBar);
      quickActions.classList.toggle('hidden', hideBottomBar);

      // Add mobile copy buttons to code blocks
      addMobileCopyButtons();

      // Wire up click proxying for interactive elements
      addClickProxyHandlers(chatContent);
    }

    // Render both sidebars with AG's captured content (always, even when skipping chat)
    isRendering = true;
    renderSidebar(leftSidebarContent, data.leftSidebarHtml);
    addClickProxyHandlers(leftSidebarContent);
    // Skip right sidebar re-render if user has active text selection (for commenting)
    if (!hasActiveSelectionInRightSidebar()) {
      renderSidebar(rightSidebarContent, data.rightSidebarHtml);
      addClickProxyHandlers(rightSidebarContent);
    }

    // Render dropdown overlay if AG has a portal menu open (e.g., three-dots conversation menu)
    // Skip if user just dismissed (prevents stale snapshots from re-opening)
    const suppressOverlay = Date.now() - overlayDismissedAt < 2000;
    if (data.dropdownHtml && !suppressOverlay) {
      const tempDiv = document.createElement('div');
      tempDiv.innerHTML = data.dropdownHtml;
      const allBtns = tempDiv.querySelectorAll('[data-ag-click-id]');
      if (allBtns.length > 0) {
        let buttonsHtml = '';
        allBtns.forEach(btn => {
          const text = btn.textContent.trim();
          const id = btn.dataset.agClickId;
          const label = btn.dataset.agClickLabel || text;
          const isDestructive = /delete|remove/i.test(text);
          const cls = isDestructive ? 'destructive' : '';
          buttonsHtml += `<button class="${cls}" data-ag-click-id="${id}" data-ag-click-label="${label}">${text}</button>`;
        });
        dropdownContent.innerHTML = buttonsHtml;
        addClickProxyHandlers(dropdownContent);
        dropdownOverlay.classList.remove('hidden');
      }
    } else if (!data.dropdownHtml) {
      dropdownOverlay.classList.add('hidden');
    }

    // Render dialog modal if AG has one open (e.g., delete confirmation, environment selector)
    if (data.dialogHtml && !suppressOverlay) {
      const tempDiv = document.createElement('div');
      tempDiv.innerHTML = data.dialogHtml;
      // Extract buttons with click IDs
      const dialogBtns = tempDiv.querySelectorAll('[data-ag-click-id]');
      if (dialogBtns.length > 0) {
        // Build buttons from tagged interactive elements
        let buttonsHtml = '';
        dialogBtns.forEach(btn => {
          const text = btn.textContent.trim();
          if (!text) return; // Skip empty buttons (e.g., close X icon)
          const id = btn.dataset.agClickId;
          const label = btn.dataset.agClickLabel || text;
          const isDestructive = text.toLowerCase().includes('delete');
          const isCancel = text.toLowerCase().includes('cancel');
          const cls = isDestructive ? 'destructive' : (isCancel ? 'cancel' : '');
          buttonsHtml += `<button class="${cls}" data-ag-click-id="${id}" data-ag-click-label="${label}">${text}</button>`;
        });

        // Extract title/message from the dialog — look for section headers or short text nodes
        const root = tempDiv.firstElementChild;
        const isPopover = root && root.getAttribute('role') === 'dialog';

        if (isPopover) {
          // Popover dialog (environment selector, context menus)
          // Rebuild with section headers and separators from the original HTML
          let popoverHtml = '';
          const walker = root.querySelector('[class*="overflow-y-auto"]') || root;
          for (const child of walker.children) {
            // Separator
            if (child.classList.contains('border-t') || child.tagName === 'HR') {
              popoverHtml += '<div class="dropdown-separator"></div>';
              continue;
            }
            // Section header (e.g. "Previous Worktrees")
            const isHeader = child.classList.contains('text-muted-foreground') &&
              child.classList.contains('text-xs') && !child.querySelector('button');
            if (isHeader) {
              popoverHtml += `<div class="dropdown-header">${child.textContent.trim()}</div>`;
              continue;
            }
            // Tagged button inside this child
            const tagged = child.querySelector('[data-ag-click-id]') || (child.dataset.agClickId ? child : null);
            if (tagged) {
              const text = tagged.textContent.trim();
              const id = tagged.dataset.agClickId;
              const label = tagged.dataset.agClickLabel || text;
              const isDestructive = /delete|remove/i.test(text);
              popoverHtml += `<button class="${isDestructive ? 'destructive' : ''}" data-ag-click-id="${id}" data-ag-click-label="${label}">${text}</button>`;
            }
          }
          dropdownContent.innerHTML = popoverHtml || buttonsHtml;
        } else {
          // Modal dialog (delete confirmation, etc.) — extract title + message
          // Remove tagged buttons from text extraction to get the description
          const cloneForText = tempDiv.cloneNode(true);
          cloneForText.querySelectorAll('[data-ag-click-id]').forEach(el => el.remove());
          const msgText = cloneForText.textContent.trim();
          // Split into title (first line/sentence) and message (rest)
          const lines = msgText.split(/\n/).map(l => l.trim()).filter(Boolean);
          const title = lines[0] || 'Confirm';
          const message = lines.slice(1).join(' ') || '';

          dropdownContent.innerHTML = `
            <div class="dialog-title">${title}</div>
            ${message ? `<div class="dialog-message">${message}</div>` : ''}
            <div class="dialog-buttons">${buttonsHtml}</div>
          `;
        }
        addClickProxyHandlers(dropdownContent);
        dropdownOverlay.classList.remove('hidden');
      }
    }

    // Render permission banner if AG is asking for approval
    if (data.permissionHtml) {
      // Skip re-render if permission HTML hasn't changed (preserves selected option)
      if (data.permissionHtml === permissionContent.dataset.lastHtml) {
        // Already rendered, don't rebuild
      } else {
      permissionContent.dataset.lastHtml = data.permissionHtml;
      const tempDiv = document.createElement('div');
      tempDiv.innerHTML = data.permissionHtml;

      // Extract command text from textarea
      const commandEl = tempDiv.querySelector('textarea[aria-label]');
      const commandText = commandEl ? commandEl.value || commandEl.textContent : '';

      // Extract title
      const titleEl = tempDiv.querySelector('.text-foreground');
      const title = titleEl ? titleEl.textContent.trim() : 'Permission Required';

      // Extract radio options
       const labels = tempDiv.querySelectorAll('[data-ag-click-id]');
      const options = [];
      const buttons = [];
      labels.forEach(el => {
        const clickId = el.dataset.agClickId;
        const text = el.textContent.trim();
        if (el.tagName === 'LABEL') {
          const numEl = el.querySelector('.font-mono');
          const num = numEl ? numEl.textContent.trim() : '';
          const labelText = text.replace(/^\d+/, '').trim();
          const isSelected = el.classList.contains('bg-secondary');
          const hasWriteIn = !!el.querySelector('textarea');
          // Clean up labelText for write-in (remove placeholder text)
          const cleanLabel = hasWriteIn ? 'No' : labelText;
          options.push({ clickId, num, labelText: cleanLabel, isSelected, hasWriteIn });
        } else if (el.tagName === 'BUTTON') {
          buttons.push({ clickId, text: text.replace('↵', '').trim() });
        }
      });

      let optionsHtml = options.map(o => {
        const writeInHtml = o.hasWriteIn
          ? `<input type="text" class="permission-writein" placeholder="tell the agent what to do instead" />`
          : '';
        return `
        <button class="permission-option${o.isSelected ? ' selected' : ''}${o.hasWriteIn ? ' has-writein' : ''}"
                data-ag-click-id="${o.clickId}" data-ag-click-label="${o.num}${o.labelText}">
          <span class="permission-option-num">${o.num}</span>
          <span>${o.labelText}</span>
          ${writeInHtml}
        </button>
        `;
      }).join('');

      let actionsHtml = buttons.map(b => {
        const cls = b.text === 'Skip' ? 'perm-skip' : 'perm-submit';
        return `<button class="${cls}" data-ag-click-id="${b.clickId}" data-ag-click-label="${b.text}">${b.text}</button>`;
      }).join('');

      permissionContent.innerHTML = `
        <div class="permission-header">
          <span class="material-symbols-rounded" style="font-size:20px;color:var(--accent)">terminal</span>
          ${title}
        </div>
        <code class="permission-command">${commandText.replace(/</g, '&lt;')}</code>
        <div class="permission-options">${optionsHtml}</div>
        <div class="permission-actions">${actionsHtml}</div>
      `;

      // Wire option clicks: select visually + proxy to AG
      permissionContent.querySelectorAll('.permission-option').forEach(btn => {
        // Remove data-ag-click-id so addClickProxyHandlers won't double-wire these
        const clickId = btn.dataset.agClickId;
        const clickLabel = btn.dataset.agClickLabel;
        btn.removeAttribute('data-ag-click-id');
        btn.addEventListener('click', async (e) => {
          // Don't trigger option select when clicking inside the write-in input
          if (e.target.classList.contains('permission-writein')) return;
          permissionContent.querySelectorAll('.permission-option').forEach(b => b.classList.remove('selected'));
          btn.classList.add('selected');
          // Focus write-in input if this is the No option
          const writeIn = btn.querySelector('.permission-writein');
          if (writeIn) setTimeout(() => writeIn.focus(), 100);
          try {
            await fetchAPI('/click', {
              method: 'POST',
              body: JSON.stringify({ clickId, label: clickLabel }),
            });
          } catch {}
        });
      });

      // Prevent write-in input clicks from bubbling to option button
      permissionContent.querySelectorAll('.permission-writein').forEach(input => {
        input.addEventListener('click', (e) => e.stopPropagation());
      });

      // Wire action buttons (Submit/Skip) manually — NOT via addClickProxyHandlers
      // so we can inject write-in text BEFORE sending the Submit click
      permissionContent.querySelectorAll('.permission-actions button').forEach(btn => {
        const clickId = btn.dataset.agClickId;
        const clickLabel = btn.dataset.agClickLabel;
        btn.addEventListener('click', async () => {
          // If submitting with No/write-in selected, inject text first
          if (clickLabel !== 'Skip') {
            const selectedOption = permissionContent.querySelector('.permission-option.selected');
            const writeIn = selectedOption?.querySelector('.permission-writein');
            if (writeIn && writeIn.value.trim()) {
              try {
                await fetchAPI('/eval', {
                  method: 'POST',
                  body: JSON.stringify({
                    script: `(() => {
                      const rg = document.querySelector('[role="radiogroup"]');
                      if (!rg) return { ok: false, reason: 'no_radiogroup' };
                      const ta = rg.querySelector('textarea');
                      if (!ta) return { ok: false, reason: 'no_textarea' };
                      ta.focus();
                      // React-compatible: use native setter to bypass React's synthetic value tracking
                      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
                      nativeSetter.call(ta, ${JSON.stringify(writeIn.value)});
                      ta.dispatchEvent(new Event('input', { bubbles: true }));
                      ta.dispatchEvent(new Event('change', { bubbles: true }));
                      return { ok: true, text: ta.value };
                    })()`
                  }),
                });
              } catch {}
              // Small delay to let AG process the text
              await new Promise(r => setTimeout(r, 200));
            }
          }
          // Now send the actual Submit/Skip click to AG
          try {
            await fetchAPI('/click', {
              method: 'POST',
              body: JSON.stringify({ clickId, label: clickLabel }),
            });
          } catch {}
          permissionOverlay.classList.add('hidden');
          permissionContent.dataset.lastHtml = '';
        });
      });

      } // end cache-check else
      permissionOverlay.classList.remove('hidden');
    } else {
      permissionOverlay.classList.add('hidden');
      permissionContent.dataset.lastHtml = '';
    }

    // Track active artifact URI for commenting
    updateActiveArtifact(data);

    // Sync scroll position from AG's DOM state.
    // AG handles scroll-to-bottom on send and auto-scroll during streaming.
    // We mirror: if AG is near bottom, scroll our container to bottom too.
    requestAnimationFrame(() => {
      if (data.scrollInfo && Date.now() > userScrollLockUntil) {
        const agAtBottom = data.scrollInfo.scrollHeight - data.scrollInfo.scrollTop - data.scrollInfo.clientHeight < 50;
        if (agAtBottom) {
          chatArea.scrollTop = chatArea.scrollHeight;
        }
      }
      // Clear isRendering AFTER scroll is set — the scroll listener skips
      // events while isRendering is true, preventing our programmatic scroll
      // from triggering the 3-second user lock.
      requestAnimationFrame(() => {
        isRendering = false;
        updateScrollFab();
      });
    });

  } catch (e) {
    console.debug('[Snapshot] Load error:', e.message);
  }
}

// ─────────────────────────────────────────────
// Scroll Management
// ─────────────────────────────────────────────
const SCROLL_THRESHOLD = 10; // px from bottom to count as "near bottom"

function isNearBottom() {
  const { scrollTop, scrollHeight, clientHeight } = chatArea;
  return scrollHeight - scrollTop - clientHeight < SCROLL_THRESHOLD;
}

function scrollToBottom() {
  chatArea.scrollTop = chatArea.scrollHeight;
}

function updateScrollFab() {
  const distFromBottom = chatArea.scrollHeight - chatArea.scrollTop - chatArea.clientHeight;
  if (distFromBottom > 100) {
    scrollFab.classList.add('visible');
  } else {
    scrollFab.classList.remove('visible');
  }
}

chatArea.addEventListener('scroll', () => {
  if (isRendering) return;
  userScrollLockUntil = Date.now() + 3000;
  updateScrollFab();
}, { passive: true });

scrollFab.addEventListener('click', () => {
  userScrollLockUntil = 0;
  scrollToBottom();
  updateScrollFab();
});

// ─────────────────────────────────────────────
// Code Block Copy Buttons
// ─────────────────────────────────────────────
function addMobileCopyButtons() {
  chatContent.querySelectorAll('pre').forEach(pre => {
    // Skip if already has copy button
    if (pre.querySelector('.mobile-copy-btn')) return;

    // Single-line code blocks get different styling
    const lines = pre.textContent.trim().split('\n');
    if (lines.length <= 1) {
      pre.classList.add('single-line-pre');
      return;
    }

    // Multi-line: add copy button
    pre.style.position = 'relative';
    const btn = document.createElement('button');
    btn.className = 'mobile-copy-btn';
    btn.textContent = 'Copy';
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        // Get code text (prefer <code> child if present)
        const code = pre.querySelector('code');
        const text = (code || pre).textContent;
        await navigator.clipboard.writeText(text);
        btn.textContent = 'Copied!';
        btn.classList.add('copied');
        setTimeout(() => {
          btn.textContent = 'Copy';
          btn.classList.remove('copied');
        }, 2000);
      } catch {
        btn.textContent = 'Failed';
        setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
      }
    });
    pre.appendChild(btn);
  });
}

// ─────────────────────────────────────────────
// Message Sending
// ─────────────────────────────────────────────
async function sendMessage() {
  const text = messageInput.value.trim();
  if (!text || isSending) return;

  isSending = true;

  // Clear and disable input to prevent any re-trigger
  messageInput.value = '';
  messageInput.style.height = 'auto';
  messageInput.disabled = true;
  actionBtn.disabled = true;
  messageInput.blur();
  updateActionButton();

  // Prepend any queued artifact comments to the message
  const commentBlock = drainQueuedComments();
  const fullMessage = commentBlock ? commentBlock + '\n' + text : text;

  try {
    const res = await fetchAPI('/send', {
      method: 'POST',
      body: JSON.stringify({ message: fullMessage }),
    });

    const result = await res.json();
    console.debug('[Send] Result:', result);

    if (!result.ok) {
      console.debug('[Send] Failed:', result.reason);
    }

    // Reset scroll lock so AG's scroll position syncs immediately on next render
    userScrollLockUntil = 0;

    // Schedule snapshot reloads to pick up the sent message
    setTimeout(loadSnapshot, 300);
    setTimeout(loadSnapshot, 800);
    setTimeout(loadSnapshot, 2000);

  } catch (e) {
    console.debug('[Send] Error:', e.message);
  } finally {
    isSending = false;
    messageInput.disabled = false;
    actionBtn.disabled = false;
  }
}



// ─────────────────────────────────────────────
// Stop Generation
// ─────────────────────────────────────────────
async function stopGeneration() {
  try {
    const res = await fetchAPI('/stop', { method: 'POST' });
    const result = await res.json();

    if (!result.ok) {
      console.debug('[Stop] No active generation found');
    }

    // Refresh snapshot to show updated state
    setTimeout(loadSnapshot, 300);
    setTimeout(loadSnapshot, 1000);
  } catch (e) {
    console.debug('[Stop] Error:', e.message);
  }
}

// ─────────────────────────────────────────────
// Action Button (Send / Stop toggle)
// ─────────────────────────────────────────────
function updateActionButton() {
  const hasText = messageInput.value.trim().length > 0;

  if (agentRunning && !hasText) {
    // Agent is running and input is empty → show Stop
    actionBtn.setAttribute('data-action', 'stop');
    actionBtn.setAttribute('aria-label', 'Stop generation');
    actionIcon.textContent = 'stop';
    actionBtn.classList.remove('disabled');
  } else {
    // User is typing or agent is idle → show Send
    actionBtn.setAttribute('data-action', 'send');
    actionBtn.setAttribute('aria-label', 'Send message');
    actionIcon.textContent = 'arrow_upward';

    if (hasText) {
      actionBtn.classList.remove('disabled');
    } else {
      actionBtn.classList.add('disabled');
    }
  }

  // Show quick-action chips only when agent is idle
  // Only toggle quick-actions for agent running state when NOT on new session page
  // (new session page hides quick-actions entirely via loadSnapshot)
  if (quickActions && !document.getElementById('ag2r-new-session-input')) {
    quickActions.classList.toggle('hidden', agentRunning);
  }
}

actionBtn.addEventListener('click', () => {
  const action = actionBtn.getAttribute('data-action');
  if (action === 'stop') {
    stopGeneration();
  } else if (action === 'send') {
    sendMessage();
  }
});

// ─────────────────────────────────────────────
// Quick Action Chips
// ─────────────────────────────────────────────
document.querySelectorAll('.quick-action-chip').forEach(chip => {
  chip.addEventListener('click', () => {
    const msg = chip.dataset.message;
    if (msg) {
      messageInput.value = msg;
      sendMessage();
    }
  });
});

// ─────────────────────────────────────────────
// Input Handling
// ─────────────────────────────────────────────

// Auto-resize textarea
messageInput.addEventListener('input', () => {
  messageInput.style.height = 'auto';
  messageInput.style.height = Math.min(messageInput.scrollHeight, 120) + 'px';
  updateActionButton();
});

// Desktop: Enter to send (Shift+Enter for newline)
// Mobile: Enter inserts newline (user taps send button)
let lastEnterSend = 0;
messageInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !isMobile) {
    e.preventDefault();
    const now = Date.now();
    if (now - lastEnterSend < 500) return;
    lastEnterSend = now;
    if (messageInput.value.trim()) {
      sendMessage();
    }
  }
});

// ─────────────────────────────────────────────
// Voice Input (Web Speech API)
// ─────────────────────────────────────────────
const micBtn = document.getElementById('mic-btn');
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

if (!SpeechRecognition) {
  micBtn.classList.add('unsupported');
} else {
  let recognition = null;
  let isRecording = false;
  // Text that was in the input before recording started
  let preRecordingText = '';

  function startRecording() {
    recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = navigator.language || 'en-US';

    preRecordingText = messageInput.value;
    isRecording = true;
    micBtn.classList.add('recording');
    micBtn.setAttribute('aria-label', 'Stop recording');

    recognition.onresult = (event) => {
      let interimTranscript = '';
      let finalTranscript = '';

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          finalTranscript += transcript;
        } else {
          interimTranscript += transcript;
        }
      }

      // Append finalized text permanently, show interim as preview
      if (finalTranscript) {
        preRecordingText += (preRecordingText ? ' ' : '') + finalTranscript.trim();
      }
      messageInput.value = preRecordingText + (interimTranscript ? ' ' + interimTranscript : '');

      // Trigger auto-resize
      messageInput.style.height = 'auto';
      messageInput.style.height = Math.min(messageInput.scrollHeight, 120) + 'px';
      updateActionButton();
    };

    recognition.onerror = (event) => {
      console.debug('[Voice] Error:', event.error);
      stopRecording();
    };

    recognition.onend = () => {
      // Auto-restart if still in recording mode (browser may stop after silence)
      if (isRecording) {
        try { recognition.start(); } catch {}
      }
    };

    try {
      recognition.start();
    } catch (err) {
      console.debug('[Voice] Start error:', err);
      stopRecording();
    }
  }

  function stopRecording() {
    isRecording = false;
    micBtn.classList.remove('recording');
    micBtn.setAttribute('aria-label', 'Voice input');
    if (recognition) {
      try { recognition.stop(); } catch {}
      recognition = null;
    }
  }

  micBtn.addEventListener('click', () => {
    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  });
}

// ─────────────────────────────────────────────
// Left Sidebar (AG's captured chat list)
// ─────────────────────────────────────────────
function openLeftSidebar() {
  leftSidebar.classList.add('open');
  leftSidebar.inert = false;
  leftSidebarOverlay.classList.add('visible');
  // If sidebar content is empty (AG's sidebar is collapsed), expand it
  if (!leftSidebarContent.innerHTML.trim()) {
    fetchAPI('/expand-left-sidebar', { method: 'POST' }).catch(() => {});
  }
}

function closeLeftSidebar() {
  leftSidebar.classList.remove('open');
  leftSidebar.inert = true;
  leftSidebarOverlay.classList.remove('visible');
}

sidebarToggle.addEventListener('click', openLeftSidebar);
leftSidebarOverlay.addEventListener('click', closeLeftSidebar);

// Dropdown backdrop dismiss — also close the dropdown in AG
dropdownBackdrop.addEventListener('click', () => {
  overlayDismissedAt = Date.now();
  dropdownOverlay.classList.add('hidden');
  // Dismiss AG's native portal by pressing Escape
  fetchAPI('/dismiss-portal', { method: 'POST' }).catch(() => {});
});

// Permission backdrop: click Skip when dismissing
permissionBackdrop.addEventListener('click', async () => {
  // Find and click the Skip button in AG
  const skipBtn = permissionContent.querySelector('.perm-skip');
  if (skipBtn) skipBtn.click();
  else permissionOverlay.classList.add('hidden');
});

// ─────────────────────────────────────────────
// Right Sidebar (AG's captured review panel)
// ─────────────────────────────────────────────
function openRightSidebar() {
  rightSidebar.classList.add('open');
  rightSidebar.inert = false;
  rightSidebarOverlay.classList.add('visible');
}

function closeRightSidebar() {
  rightSidebar.classList.remove('open');
  rightSidebar.inert = true;
  rightSidebarOverlay.classList.remove('visible');
}

function toggleRightSidebar() {
  if (rightSidebar.classList.contains('open')) closeRightSidebar();
  else openRightSidebar();
}

reviewToggle.addEventListener('click', toggleRightSidebar);
rightSidebarOverlay.addEventListener('click', closeRightSidebar);

// ─────────────────────────────────────────────
// Sidebar Content Rendering
// ─────────────────────────────────────────────
// ─────────────────────────────────────────────
// New Session Page — functional input overlay
// ─────────────────────────────────────────────
function renderNewSessionPage(container, data) {
  const capturedHtml = data.html;
  // Extract project name from the captured HTML (look for the project dropdown button label)
  let projectName = '';
  const tmpDiv = document.createElement('div');
  tmpDiv.innerHTML = capturedHtml;
  const projectBtn = tmpDiv.querySelector('[aria-haspopup="dialog"] .truncate');
  if (projectBtn) projectName = projectBtn.textContent.trim();

  // Extract model name
  let modelName = '';
  const modelBtn = tmpDiv.querySelector('[aria-label*="Select model"]');
  if (modelBtn) {
    const span = modelBtn.querySelector('span');
    if (span) modelName = span.textContent.trim();
  }

  // Environment and branch from snapshot data
  const environmentName = data.environmentName || '';
  const branchName = data.branchName || '';
  const isWorktreeMode = environmentName && environmentName !== 'Local';

  // Build environment/branch settings bar
  let envBarHtml = '';
  if (environmentName) {
    // Environment/worktree icon: monitor for Local, fork-tree for worktree
    const envIcon = environmentName === 'Local'
      ? '<span class="material-symbols-rounded" style="font-size:14px">desktop_windows</span>'
      : '<span class="material-symbols-rounded" style="font-size:14px">account_tree</span>';
    envBarHtml = `
      <div class="ag2r-new-session-env-bar">
        <button type="button" class="ag2r-env-chip" data-ag-click-id="env:0" data-ag-click-label="${environmentName}">
          ${envIcon}
          <span>${environmentName}</span>
          <span class="material-symbols-rounded" style="font-size:12px">expand_more</span>
        </button>
        ${branchName ? `
        <button type="button" class="ag2r-env-chip" data-ag-click-id="env:1" data-ag-click-label="${branchName}">
          <span class="material-symbols-rounded" style="font-size:14px">fork_right</span>
          <span>${branchName}</span>
          <span class="material-symbols-rounded" style="font-size:12px">expand_more</span>
        </button>
        ` : ''}
      </div>
    `;
  }

  // Build our own functional UI
  container.innerHTML = `
    <div class="ag2r-new-session">
      <div class="ag2r-new-session-header">
        ${projectName ? `<div class="ag2r-new-session-project">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 -960 960 960" fill="currentColor">
            <path d="M172.31-180Q142-180 121-201t-21-51.31V-707.69Q100-738 121-759t51.31-21H391.92l80,80H787.69Q818-700 839-679t21,51.31v375.38Q860-222 839-201t-51.31,21H172.31Z"/>
          </svg>
          <span>${projectName}</span>
        </div>` : ''}
        ${modelName ? `<div class="ag2r-new-session-model">${modelName}</div>` : ''}
      </div>
      <form id="ag2r-new-session-form" class="ag2r-new-session-form">
        <textarea
          id="ag2r-new-session-input"
          placeholder="Ask anything, @ to mention, / for actions"
          rows="3"
        ></textarea>
        <div class="ag2r-new-session-buttons">
          <button type="button" id="ag2r-new-session-mic" class="mic-btn" aria-label="Voice input">
            <span class="material-symbols-rounded mic-icon">mic</span>
          </button>
          <button type="submit" id="ag2r-new-session-send" aria-label="Send">
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 -960 960 960" fill="currentColor">
              <path d="M120-160v-640l760,320-760,320Zm60-93 544-227-544-230v168l242,62-242,60v167Zm0,0v-457,457Z"/>
            </svg>
          </button>
        </div>
      </form>
      ${envBarHtml}
    </div>
  `;

  const form = container.querySelector('#ag2r-new-session-form');
  const input = container.querySelector('#ag2r-new-session-input');
  const sendBtn = container.querySelector('#ag2r-new-session-send');

  // Prevent snapshot refresh from wiping the input while user is typing
  let userIsTyping = false;
  input.addEventListener('input', () => { userIsTyping = true; });
  input.addEventListener('blur', () => { userIsTyping = false; });

  // Handle form submission
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;

    // Disable input
    input.disabled = true;
    sendBtn.disabled = true;
    sendBtn.classList.add('sending');

    try {
      const res = await fetchAPI('/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text }),
      });
      const result = await res.json();
      console.debug('[NewSession] Send result:', result);
      if (result.ok) {
        input.value = '';
        // AG will navigate to the new session — next snapshot refresh will pick it up
      }
    } catch (err) {
      console.debug('[NewSession] Send error:', err);
    } finally {
      input.disabled = false;
      sendBtn.disabled = false;
      sendBtn.classList.remove('sending');
    }
  });

  // Desktop: Enter to submit. Mobile: Enter inserts newline.
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !isMobile) {
      e.preventDefault();
      form.requestSubmit();
    }
  });

  // Wire up mic button for new session page
  const nsMicBtn = container.querySelector('#ag2r-new-session-mic');
  if (nsMicBtn && SpeechRecognition) {
    let nsRecognition = null;
    let nsIsRecording = false;
    let nsPreText = '';

    function nsStartRecording() {
      nsRecognition = new SpeechRecognition();
      nsRecognition.continuous = true;
      nsRecognition.interimResults = true;
      nsRecognition.lang = navigator.language || 'en-US';

      nsPreText = input.value;
      nsIsRecording = true;
      nsMicBtn.classList.add('recording');

      nsRecognition.onresult = (event) => {
        let interim = '', final = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const t = event.results[i][0].transcript;
          if (event.results[i].isFinal) final += t;
          else interim += t;
        }
        if (final) nsPreText += (nsPreText ? ' ' : '') + final.trim();
        input.value = nsPreText + (interim ? ' ' + interim : '');
      };

      nsRecognition.onerror = () => nsStopRecording();
      nsRecognition.onend = () => {
        if (nsIsRecording) try { nsRecognition.start(); } catch {}
      };

      try { nsRecognition.start(); } catch { nsStopRecording(); }
    }

    function nsStopRecording() {
      nsIsRecording = false;
      nsMicBtn.classList.remove('recording');
      if (nsRecognition) { try { nsRecognition.stop(); } catch {} nsRecognition = null; }
    }

    nsMicBtn.addEventListener('click', () => {
      if (nsIsRecording) nsStopRecording();
      else nsStartRecording();
    });
  } else if (nsMicBtn) {
    nsMicBtn.classList.add('unsupported');
  }

  // Don't auto-focus — let the user tap the input to bring up keyboard
}

// ─────────────────────────────────────────────
// Sidebar Rendering
// ─────────────────────────────────────────────
function renderSidebar(container, html) {
  if (html) {
    // Fix invalid nested <button> elements: AG nests close-buttons inside tab buttons.
    // Browsers reject nested <button> in innerHTML, breaking the DOM structure.
    // Convert inner close buttons (hidden group-hover:flex) to <span> to preserve nesting.
    html = html.replace(
      /<button(\s+(?:type="button"\s+)?class="hidden group-hover:flex[^"]*"[^>]*)>([\s\S]*?)<\/button>/g,
      '<span$1>$2</span>'
    );
    container.innerHTML = html;
    // Strip all h-full classes — they create percentage-height chains that
    // collapse to zero. Let content size intrinsically so overflow scrolls.
    container.querySelectorAll('.h-full').forEach(el => {
      el.classList.remove('h-full');
    });

    // Fix tab bar: ensure tab buttons show text and bar scrolls horizontally
    container.querySelectorAll('button[data-tab-id]').forEach(btn => {
      btn.classList.remove('overflow-hidden');
    });
    // The scrollable tab bar container has overflow-x-auto but may lack nowrap
    const scrollableBar = container.querySelector('.overflow-x-auto');
    if (scrollableBar) {
      scrollableBar.style.flexWrap = 'nowrap';
    }

    // ── Sidebar cleanup: remove desktop-only structural elements ──
    // The top header bar (sidebar toggle + back/forward nav) — AG2R has its own
    const topBar = container.querySelector('[style*="app-region: drag"]');
    if (topBar) topBar.remove();

    // The wrapper div for the 3 hidden actions (New Conversation, History, Scheduled)
    // It's a div.px-2 that is a direct child of the sidebar nav, containing the action buttons
    const actionBtns = container.querySelectorAll('[data-ag-click-label="New Conversation"], [data-ag-click-label="Conversation History"], [data-ag-click-label="Scheduled Tasks"]');
    if (actionBtns.length > 0) {
      // Walk up to the px-2 wrapper and remove it entirely
      const wrapper = actionBtns[0].closest('.px-2');
      if (wrapper) wrapper.remove();
    }

    // The separator line between actions and project list
    // It's a div with mt-3 mx-2 h-px (transparent background divider)
    container.querySelectorAll('.mt-3.mx-2.h-px').forEach(el => el.remove());

    // ── Force hover-only action buttons visible on mobile ──
    // AG uses Tailwind hover patterns to show action buttons only on hover.
    // Mobile has no hover, so force them visible.
    container.querySelectorAll('*').forEach(el => {
      const cls = el.className;
      if (typeof cls !== 'string') return;

      // Project-level: "hidden group-hover/section:flex" → force flex
      if (cls.includes('hidden') && cls.includes('group-hover/section:flex')) {
        el.classList.remove('hidden');
        el.style.display = 'flex';
      }

      // Per-session: "invisible group-hover:visible" → force visible
      if (cls.includes('invisible') && cls.includes('group-hover:visible')) {
        el.classList.remove('invisible');
        el.style.visibility = 'visible';
      }
    });
  }
}

// ─────────────────────────────────────────────
// Click Proxying — generic for any container
// ─────────────────────────────────────────────
function addClickProxyHandlers(container) {
  let wiredCount = 0;
  container.querySelectorAll('[data-ag-click-id]').forEach(el => {
    if (el.dataset.agClickWired) return;
    el.dataset.agClickWired = '1';
    wiredCount++;

    el.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();

      const clickId = el.dataset.agClickId; // e.g. "chat:5", "right:2"
      const label = el.dataset.agClickLabel || '';

      console.debug('[Click] id=' + clickId, 'label="' + label + '"', 'tag=' + el.tagName, 'class=' + (el.className || '').substring(0, 80));
      el.classList.add('ag-clicking');
      let result = null;
      try {
        const res = await fetchAPI('/click', {
          method: 'POST',
          body: JSON.stringify({ clickId, label }),
        });
        result = await res.json();

      } catch (err) {
        console.debug('[Click] Error:', err.message);
      }
      el.classList.remove('ag-clicking');

      // Close sidebar when navigating away (conversation click or new session)
      // Conversation rows have non-empty labels (title text); icon buttons (three-dots, +) have empty labels
      if (clickId.startsWith('left:')) {
        const hasLabel = label && label.length > 0;
        if (hasLabel) closeLeftSidebar();
      }

      // Close dropdown overlay after any dropdown/dialog action
      if (clickId.startsWith('dropdown:') || clickId.startsWith('dialog:')) {
        overlayDismissedAt = Date.now();
        dropdownOverlay.classList.add('hidden');
        closeLeftSidebar();
      }

      // Only open right sidebar for explicit "Review" button clicks
      if (/^Review$/i.test(label.trim())) {
        openRightSidebar();
      }

      // Open right sidebar when a file row click navigated to a file tab
      if (result?.navigatedToFile) {
        openRightSidebar();
      }

      // Refresh snapshots to pick up changes
      setTimeout(loadSnapshot, 300);
      setTimeout(loadSnapshot, 800);
      setTimeout(loadSnapshot, 2000);
    });
  });

}

// ─────────────────────────────────────────────
// Connection Status
// ─────────────────────────────────────────────
function updateConnectionStatus(status) {
  connectionDot.setAttribute('data-status', status);
  const titles = {
    connected: 'Connected',
    reconnecting: 'Reconnecting...',
    disconnected: 'Disconnected',
  };
  connectionDot.title = titles[status] || status;
}

// ─────────────────────────────────────────────
// Empty State
// ─────────────────────────────────────────────
function showEmptyState() {
  emptyState.classList.remove('hidden');
}

function hideEmptyState() {
  emptyState.classList.add('hidden');
}

function updateEmptyState(subtitle) {
  const el = emptyState.querySelector('.empty-subtitle');
  if (el) el.textContent = subtitle;
}

// ─────────────────────────────────────────────
// Virtual Keyboard Handling
// ─────────────────────────────────────────────
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', () => {
    // Adjust body height when keyboard opens/closes
    document.body.style.height = window.visualViewport.height + 'px';
  });

  window.visualViewport.addEventListener('scroll', () => {
    document.body.style.height = window.visualViewport.height + 'px';
  });
}

// ─────────────────────────────────────────────
// Visibility Change — refresh on tab re-entry
// ─────────────────────────────────────────────
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    loadSnapshot();
  }
});

// ─────────────────────────────────────────────
// Fallback Polling (Chrome throttles WS when tab inactive)
// ─────────────────────────────────────────────
setInterval(() => {
  if (document.visibilityState === 'visible') {
    loadSnapshot();
  }
}, 5000);

// ─────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}



// ─────────────────────────────────────────────
// Artifact Commenting
// ─────────────────────────────────────────────
// Check if user has an active text selection inside the right sidebar
function hasActiveSelectionInRightSidebar() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.toString().trim()) return false;
  const anchor = sel.anchorNode;
  return anchor && rightSidebarContent.contains(anchor);
}

let activeArtifactUri = null;
let activeFileUri = null;
let pendingCommentSelection = '';
let pendingCommentUri = '';
let queuedComments = JSON.parse(localStorage.getItem('ag2r_queued_comments') || '[]');

function saveComments() {
  localStorage.setItem('ag2r_queued_comments', JSON.stringify(queuedComments));
}

// Track active artifact URI from snapshots
function updateActiveArtifact(data) {
  if (data.activeArtifactUri) {
    activeArtifactUri = data.activeArtifactUri;
    activeFileUri = null;
  } else if (data.activeFileUri) {
    activeFileUri = data.activeFileUri;
    activeArtifactUri = null;
  }
}


// ── Selection Detection (Android-optimized) ──
// Android's native selection toolbar appears on long-press. We coexist with it
// by using `selectionchange` (fires AFTER Android finalizes selection) instead
// of `touchend` (fires BEFORE selection is ready). Desktop uses `mouseup` for
// fast response. See ONBOARDING.md gotcha: "Android selection coexistence".

// Show/position FAB for the current selection, if valid
function showCommentFabForSelection() {
  const sel = window.getSelection();
  const text = sel ? sel.toString().trim() : '';

  if (!text || text.length < 2) {
    commentFab.classList.add('hidden');
    return;
  }

  // Selection must be inside the right sidebar
  const anchor = sel.anchorNode;
  if (!anchor || !rightSidebarContent.contains(anchor)) {
    commentFab.classList.add('hidden');
    return;
  }

  const activeUri = activeArtifactUri || activeFileUri;
  if (!activeUri) {
    commentFab.classList.add('hidden');
    return;
  }

  pendingCommentSelection = text;
  pendingCommentUri = activeUri;

  // Position FAB near the selection
  const range = sel.getRangeAt(0);
  const rect = range.getBoundingClientRect();
  commentFab.style.top = `${rect.bottom + window.scrollY + 8}px`;
  commentFab.style.left = `${rect.left + window.scrollX + rect.width / 2}px`;
  commentFab.classList.remove('hidden');
}

// Desktop: mouseup gives instant feedback
rightSidebarContent.addEventListener('mouseup', () => {
  setTimeout(showCommentFabForSelection, 50);
});

// Mobile (Android/iOS): selectionchange fires when the OS finalizes selection.
// Debounced to avoid rapid-fire calls while the user drags selection handles.
let selectionChangeTimer = null;
document.addEventListener('selectionchange', () => {
  clearTimeout(selectionChangeTimer);
  selectionChangeTimer = setTimeout(showCommentFabForSelection, 300);
});

// Suppress secondary context menu on right sidebar (prevents the extra
// long-press menu on some Android browsers while keeping the primary
// selection toolbar intact).
rightSidebarContent.addEventListener('contextmenu', (e) => {
  e.preventDefault();
});

// Dismiss FAB on pointerdown — but only when the tap is inside the right
// sidebar content area (not on the FAB/modal themselves). This prevents
// Android's native toolbar interactions (which are OUTSIDE our DOM) from
// accidentally dismissing the FAB.
rightSidebarContent.addEventListener('pointerdown', (e) => {
  if (!commentFab.contains(e.target) && !commentModal.contains(e.target)) {
    commentFab.classList.add('hidden');
  }
});

// Open comment modal when FAB is clicked
commentFab.addEventListener('click', () => {
  commentFab.classList.add('hidden');
  commentSelectionPreview.textContent = pendingCommentSelection;
  commentInput.value = '';
  commentModal.classList.remove('hidden');
  commentInput.focus();
});

// Close comment modal
function closeCommentModal() {
  commentModal.classList.add('hidden');
  commentInput.value = '';
  pendingCommentSelection = '';
}

commentCancel.addEventListener('click', closeCommentModal);
commentModalBackdrop.addEventListener('click', closeCommentModal);

// Submit comment — queue it as a structured object, don't send immediately
commentSubmit.addEventListener('click', () => {
  const commentText = commentInput.value.trim();
  if (!commentText) return;
  if (!(activeArtifactUri || activeFileUri) || !pendingCommentSelection) return;

  queuedComments.push({
    uri: pendingCommentUri || activeArtifactUri || activeFileUri,
    selection: pendingCommentSelection,
    comment: commentText,
  });
  saveComments();
  console.debug('[Comment] Queued:', queuedComments[queuedComments.length - 1]);
  closeCommentModal();

  // Clear the text selection to prevent stale selection state
  window.getSelection()?.removeAllRanges();

  // Show badge to indicate pending comments
  updateCommentBadge();
});

// Format queued comments grouped by artifact URI
function formatQueuedComments() {
  if (queuedComments.length === 0) return '';

  // Group by URI
  const grouped = {};
  for (const c of queuedComments) {
    if (!grouped[c.uri]) grouped[c.uri] = [];
    grouped[c.uri].push(c);
  }

  // Build nested bullet format
  const lines = ['Review my comments:'];
  for (const [uri, comments] of Object.entries(grouped)) {
    lines.push(`* Comments on artifact URI: ${uri}`);
    for (const c of comments) {
      lines.push(`  * > ${c.selection}`);
      lines.push(`    * Comment: ${c.comment}`);
    }
  }
  return lines.join('\n');
}

// Drain queued comments — returns formatted string and clears queue
function drainQueuedComments() {
  if (queuedComments.length === 0) return '';
  const block = formatQueuedComments();
  queuedComments = [];
  saveComments();
  updateCommentBadge();
  return block;
}

// Comment badge — shows pending comment count as a fixed banner with send shortcut
function updateCommentBadge() {
  let badge = document.getElementById('comment-badge');
  if (queuedComments.length === 0) {
    if (badge) badge.remove();
    return;
  }
  if (!badge) {
    badge = document.createElement('div');
    badge.id = 'comment-badge';
    document.getElementById('app').appendChild(badge);
  }
  const count = queuedComments.length;
  badge.innerHTML = `<span>💬 ${count} comment${count > 1 ? 's' : ''} queued</span><button id="comment-send-btn">Send</button>`;
  // Click badge text → open review modal
  badge.addEventListener('click', openReviewModal);
  // Click send button → send (stop propagation so it doesn't also open modal)
  document.getElementById('comment-send-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    sendQueuedComments();
  });
}

async function sendQueuedComments() {
  const fullMessage = drainQueuedComments();
  if (!fullMessage) return;
  try {
    const resp = await fetchAPI('/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: fullMessage }),
    });
    const result = await resp.json();
    console.debug('[Comment] Send result:', result);
  } catch (e) {
    console.error('[Comment] Send failed:', e);
  }
}

// ── Comment Review Modal ──
const reviewModal = document.getElementById('comment-review-modal');
const reviewList = document.getElementById('comment-review-list');
const reviewBackdrop = document.getElementById('comment-review-backdrop');
const reviewClose = document.getElementById('comment-review-close');
const reviewClear = document.getElementById('comment-review-clear');
const reviewSend = document.getElementById('comment-review-send');

function openReviewModal() {
  renderReviewList();
  reviewModal.classList.remove('hidden');
}

function closeReviewModal() {
  reviewModal.classList.add('hidden');
}


function renderReviewList() {
  if (queuedComments.length === 0) {
    reviewList.innerHTML = '<div style="color:#888;text-align:center;padding:20px">No comments queued</div>';
    return;
  }

  // Group by URI preserving order
  const grouped = {};
  const uriOrder = [];
  for (const [i, c] of queuedComments.entries()) {
    if (!grouped[c.uri]) { grouped[c.uri] = []; uriOrder.push(c.uri); }
    grouped[c.uri].push({ ...c, index: i });
  }

  let html = '';
  for (const uri of uriOrder) {
    const basename = uri.split('/').pop();
    html += `<div class="comment-review-file">📄 ${basename}</div>`;
    for (const c of grouped[uri]) {
      html += `
        <div class="comment-review-item" data-idx="${c.index}">
          <div class="comment-review-selection">» ${escapeHtml(c.selection)}</div>
          <div class="comment-review-text">${escapeHtml(c.comment)}</div>
          <div class="comment-review-actions">
            <button class="edit" title="Edit" data-idx="${c.index}"><span class="material-symbols-rounded" style="font-size:16px">edit</span></button>
            <button class="delete" title="Delete" data-idx="${c.index}"><span class="material-symbols-rounded" style="font-size:16px">delete</span></button>
          </div>
        </div>`;
    }
  }
  reviewList.innerHTML = html;

  // Wire edit/delete
  reviewList.querySelectorAll('.edit').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.idx);
      const item = btn.closest('.comment-review-item');
      const textEl = item.querySelector('.comment-review-text');
      // Inline edit: replace text with a textarea
      const textarea = document.createElement('textarea');
      textarea.className = 'comment-input';
      textarea.value = queuedComments[idx].comment;
      textarea.rows = 2;
      textEl.replaceWith(textarea);
      textarea.focus();
      // Save on blur or Enter
      const save = () => {
        const val = textarea.value.trim();
        if (val) {
          queuedComments[idx].comment = val;
          saveComments();
        }
        renderReviewList();
        updateCommentBadge();
      };
      textarea.addEventListener('blur', save);
      textarea.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(); }
      });
    });
  });
  reviewList.querySelectorAll('.delete').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.idx);
      queuedComments.splice(idx, 1);
      saveComments();
      renderReviewList();
      updateCommentBadge();
      if (queuedComments.length === 0) closeReviewModal();
    });
  });
}

reviewBackdrop.addEventListener('click', closeReviewModal);
reviewClose.addEventListener('click', closeReviewModal);
reviewClear.addEventListener('click', () => {
  queuedComments = [];
  saveComments();
  updateCommentBadge();
  closeReviewModal();
});
reviewSend.addEventListener('click', () => {
  closeReviewModal();
  sendQueuedComments();
});

// Show badge on load if there are persisted comments
if (queuedComments.length > 0) updateCommentBadge();


// ─────────────────────────────────────────────
// Initialization
// ─────────────────────────────────────────────
connectWebSocket();
loadSnapshot();
updateActionButton();
