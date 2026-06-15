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
let userScrolledAway = false;
let debugMode = false;
let featureFlags = {}; // populated from server on WS connect

// Telemetry: previous snapshot values for change detection
let _prevModelName = null;
let _prevBranchName = null;
let _prevEnvironmentName = null;

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
// Settings overlay
const settingsOverlay = document.getElementById('settings-overlay');
const settingsContent = document.getElementById('settings-content');
const settingsBack = document.getElementById('settings-back');
// Restart confirmation modal
const restartConfirm = document.getElementById('restart-confirm');
const restartCancel = document.getElementById('restart-cancel');
const restartGo = document.getElementById('restart-go');
// Header refresh button
const refreshBtn = document.getElementById('refresh-btn');
// Scheduled Tasks overlay
const scheduledTasksOverlay = document.getElementById('scheduled-tasks-overlay');
const scheduledTasksContent = document.getElementById('scheduled-tasks-content');
const scheduledTasksDialog = document.getElementById('scheduled-tasks-dialog');
const scheduledTasksBack = document.getElementById('scheduled-tasks-back');
// Text input modal (for scheduled tasks form fields)
const textInputModal = document.getElementById('text-input-modal');
const textInputBackdrop = document.getElementById('text-input-backdrop');
const textInputLabel = document.getElementById('text-input-label');
const textInputField = document.getElementById('text-input-field');
const textInputArea = document.getElementById('text-input-area');
const textInputCancel = document.getElementById('text-input-cancel');
const textInputSubmit = document.getElementById('text-input-submit');
// Running tasks strip
const runningTasks = document.getElementById('running-tasks');
const runningTasksHeader = document.getElementById('running-tasks-header');
const runningTasksList = document.getElementById('running-tasks-list');
const runningTasksCount = document.getElementById('running-tasks-count');
let runningTasksCollapsed = false;
// Subagent view bar
const subagentBar = document.getElementById('subagent-bar');
const subagentBackBtn = document.getElementById('subagent-back-btn');
const subagentParentName = document.getElementById('subagent-parent-name');
let isInSubagentView = false;   // Synced from server-side detection (inputBox absence)

// Subagent info panel (cannot prompt message + overview button)
const subagentInfo = document.getElementById('subagent-info');
// Deferred sidebar open: set true when user clicks a task name.
// loadSnapshot checks this flag after detecting subagent vs command view.
let pendingTaskClick = false;
// Suppression: ignore stale dialog/dropdown snapshots for a short window after user dismisses
let overlayDismissedAt = 0;

// ─────────────────────────────────────────────
// Dynamic Input Bar Height Tracking
// ─────────────────────────────────────────────
// Updates --input-bar-height CSS variable so quick-actions and scroll-fab
// float above the input bar regardless of its height (future: thumbnails, tasks bar).
if (typeof ResizeObserver !== 'undefined') {
  const inputBarObserver = new ResizeObserver(entries => {
    for (const entry of entries) {
      const h = entry.borderBoxSize?.[0]?.blockSize ?? entry.target.offsetHeight;
      document.documentElement.style.setProperty('--input-bar-height', h + 'px');
    }
  });
  inputBarObserver.observe(inputBar);
}

// ─────────────────────────────────────────────
// Running Tasks — Collapse Toggle
// ─────────────────────────────────────────────
runningTasksHeader.addEventListener('click', () => {
  runningTasksCollapsed = !runningTasksCollapsed;
  runningTasksList.classList.toggle('collapsed', runningTasksCollapsed);
  runningTasks.querySelector('.running-tasks-arrow')
    ?.classList.toggle('rotated', runningTasksCollapsed);
});

// Subagent back button: navigate back to parent conversation
// Clicks the first link/button in AG's breadcrumb bar above the conversation-view
subagentBackBtn.addEventListener('click', async () => {
  subagentBackBtn.style.opacity = '0.5';
  subagentBackBtn.style.pointerEvents = 'none';
  // Reset client-side flag first
  isInSubagentView = false;

  try {
    // Click AG's breadcrumb/back link to navigate back to parent
    await fetchAPI('/eval', {
      method: 'POST',
      body: JSON.stringify({
        script: `(() => {
          // Strategy 1: Click breadcrumb back link above conversation-view
          const cv = document.querySelector('[data-testid="conversation-view"]') ||
                     document.querySelector('.scrollbar-hide[class*="overflow-y-auto"]');
          if (cv && cv.parentElement) {
            for (const child of cv.parentElement.children) {
              if (child === cv) break;
              const link = child.querySelector('a, button, [role="link"], [class*="cursor-pointer"]');
              if (link) { link.click(); return { ok: true, strategy: 'breadcrumb' }; }
            }
          }
          // Strategy 2: Click browser back button equivalent
          window.history.back();
          return { ok: true, strategy: 'history_back' };
        })()`
      }),
    });
  } catch {}
  setTimeout(() => {
    subagentBackBtn.style.opacity = '';
    subagentBackBtn.style.pointerEvents = '';
  }, 500);
  setTimeout(loadSnapshot, 300);
  setTimeout(loadSnapshot, 1000);
});

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
// Client Telemetry — fire-and-forget
// ─────────────────────────────────────────────
function track(event, payload = {}) {
  try {
    fetch('/telemetry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event, ...payload }),
    }).catch(() => {}); // swallow network errors
  } catch {}
}

// Debug log — only active when server has AG2R_DEBUG=1
// Posts events to /debug-log for unified timestamped server output
function debugLog(event, detail) {
  if (!debugMode) return;
  try {
    fetch('/debug-log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event, detail: detail != null ? String(detail) : '' }),
    }).catch(() => {});
  } catch {}
}

// Global error tracking
window.addEventListener('error', (e) => {
  track('client_error', { message: (e.message || '').substring(0, 200) });
});
window.addEventListener('unhandledrejection', (e) => {
  const msg = e.reason?.message || String(e.reason || '');
  track('client_error', { message: msg.substring(0, 200) });
});

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
    debugLog('ws-open');
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
            // Don't show quick actions on new session page or subagent view
            const isOnNewSession = !!document.getElementById('ag2r-new-session-input');
            quickActions?.classList.toggle('hidden', agentRunning || isOnNewSession || isInSubagentView);
          }
          break;

        case 'status':
          if (data.agentRunning !== undefined) {
            agentRunning = data.agentRunning;
            updateActionButton();
            const isOnNewSession = !!document.getElementById('ag2r-new-session-input');
            quickActions?.classList.toggle('hidden', agentRunning || isOnNewSession || isInSubagentView);
          }
          break;

        case 'connection':
          cdpConnected = data.cdpConnected;
          if (data.debugMode !== undefined) debugMode = data.debugMode;
          if (data.featureFlags) featureFlags = data.featureFlags;
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
    debugLog('ws-close');
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

    // Pick up debug mode flag from server
    if (data.debugMode !== undefined) debugMode = data.debugMode;

    // Update agent status
    // agentRunning is set exclusively by WS handlers (snapshot/status messages).
    // Do NOT set it here — the HTTP response can be stale vs the WS push.

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
      // Update project name + model from fresh snapshot (user may have clicked + on a different project)
      const tmpDiv = document.createElement('div');
      tmpDiv.innerHTML = data.html;
      const projectBtn = tmpDiv.querySelector('[aria-haspopup="dialog"] .truncate');
      const freshProject = projectBtn ? projectBtn.textContent.trim() : '';
      const projectEl = chatContent.querySelector('.ag2r-new-session-project span:not(.material-symbols-rounded)');
      if (projectEl && freshProject) projectEl.textContent = freshProject;

      // Update model from server-side extracted name (bottom-row chip only)
      const freshModel = data.modelName || '';
      const nsModelChipText = chatContent.querySelector('.ag2r-ns-model-chip .model-chip-text');
      if (nsModelChipText && freshModel) nsModelChipText.textContent = freshModel;

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

      // Hide bottom input bar + quick actions on new session page or subagent view
      const hideBottomBar = data.isNewSessionPage || data.isSubagentView;
      inputBar.classList.toggle('hidden', hideBottomBar);
      if (hideBottomBar) quickActions.classList.add('hidden');

      // Update client-side flag from server detection (used by WS handlers)
      isInSubagentView = !!data.isSubagentView;

      // Subagent view: show back bar + yellow border indicator + info panel
      if (data.isSubagentView) {
        const displayName = data.parentConversationName || 'Parent';
        subagentParentName.textContent = displayName;
        subagentBar.classList.remove('hidden');
        chatArea.classList.add('subagent-view');
        // Render captured subagent info (cannot prompt + overview button)
        if (data.subagentInfoHtml && data.subagentInfoHtml !== subagentInfo.dataset.lastHtml) {
          subagentInfo.dataset.lastHtml = data.subagentInfoHtml;
          subagentInfo.innerHTML = data.subagentInfoHtml;
          addClickProxyHandlers(subagentInfo);
        }
        subagentInfo.classList.toggle('hidden', !data.subagentInfoHtml);
      } else {
        subagentBar.classList.add('hidden');
        chatArea.classList.remove('subagent-view');
        subagentInfo.classList.add('hidden');
        subagentInfo.dataset.lastHtml = '';
      }

      // Deferred task click: open sidebar only for command tasks (not subagents)
      if (pendingTaskClick) {
        pendingTaskClick = false;
        if (!data.isSubagentView) {
          openRightSidebar();
        }
      }

      // Add mobile copy buttons to code blocks (deferred to avoid forced reflow after innerHTML)
      requestAnimationFrame(() => addMobileCopyButtons());

      // Wire up click proxying for interactive elements
      addClickProxyHandlers(chatContent);
    }

    // Update model chip in input bar from server-extracted name (existing conversations)
    updateModelChip(data.modelName);

    // Render left sidebar with AG's captured content (always, even when skipping chat)
    isRendering = true;
    renderSidebar(leftSidebarContent, data.leftSidebarHtml);
    addClickProxyHandlers(leftSidebarContent);

    // Right sidebar is on-demand — don't render here.
    // Track the sidebarSignature so we know when to re-fetch.
    if (data.sidebarSignature !== undefined) {
      const sigChanged = data.sidebarSignature !== lastSidebarSignature;
      lastSidebarSignature = data.sidebarSignature;
      // Auto-refresh sidebar if it's open and the signature changed
      if (sigChanged && rightSidebar.classList.contains('open')) {
        fetchRightSidebar();
      }
    }

    // Render dropdown overlay if AG has a portal menu open (e.g., three-dots conversation menu)
    // Skip if user just dismissed (prevents stale snapshots from re-opening)
    const suppressOverlay = Date.now() - overlayDismissedAt < 2000;
    if (data.dropdownHtml && !suppressOverlay) {
      const tempDiv = document.createElement('div');
      tempDiv.innerHTML = data.dropdownHtml;
      const allBtns = tempDiv.querySelectorAll('[data-ag-click-id]');
      if (allBtns.length > 0) {
        // Options to hide from dropdown menus (e.g., Rename triggers inline sidebar edit, unusable in AG2R)
        const HIDDEN_DROPDOWN_OPTIONS = /^rename$/i;
        let buttonsHtml = '';
        allBtns.forEach(btn => {
          const text = btn.textContent.trim();
          if (HIDDEN_DROPDOWN_OPTIONS.test(text)) return;
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
    } else if (!data.dropdownHtml && !data.dialogHtml) {
      // Only hide overlay if neither dropdown nor dialog is active
      dropdownOverlay.classList.add('hidden');
    }

    // Render dialog modal if AG has one open (e.g., delete confirmation, environment selector)
    if (data.dialogHtml && !suppressOverlay) {
      // Dedup: skip re-render if dialog HTML hasn't changed (prevents flicker from polling)
      if (data.dialogHtml !== dropdownContent.dataset.lastDialogHtml) {
        dropdownContent.dataset.lastDialogHtml = data.dialogHtml;
      const tempDiv = document.createElement('div');
      tempDiv.innerHTML = data.dialogHtml;
      // Extract buttons with click IDs
      const dialogBtns = tempDiv.querySelectorAll('[data-ag-click-id]');
      // AG's collapsible section headers ("Worked for 35s", "Thought for 27s", etc.)
      // are rendered as <button> elements and get captured alongside actual dialog buttons.
      // Filter them out so only real action buttons (Skip, Submit, options) appear.
      const AG_SECTION_BUTTON = /^(Worked|Thought|Analyzed|Ran) for\b/i;
      if (dialogBtns.length > 0) {
        // Build buttons from tagged interactive elements
        let buttonsHtml = '';
        dialogBtns.forEach(btn => {
          const text = btn.textContent.trim();
          if (!text) return; // Skip empty buttons (e.g., close X icon)
          if (AG_SECTION_BUTTON.test(text)) return; // Skip AG collapsible section headers
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
            // Tagged buttons inside this child — find ALL, not just the first
            const taggedEls = child.querySelectorAll('[data-ag-click-id]');
            const selfTagged = child.dataset?.agClickId ? [child] : [];
            const allTagged = taggedEls.length > 0 ? taggedEls : selfTagged;
            allTagged.forEach(tagged => {
              const text = tagged.textContent.trim();
              if (AG_SECTION_BUTTON.test(text)) return; // Skip AG collapsible section headers
              const id = tagged.dataset.agClickId;
              const label = tagged.dataset.agClickLabel || text;
              const isDestructive = /delete|remove/i.test(text);
              popoverHtml += `<button class="${isDestructive ? 'destructive' : ''}" data-ag-click-id="${id}" data-ag-click-label="${label}">${text}</button>`;
            });
          }
          dropdownContent.innerHTML = popoverHtml || buttonsHtml;
        } else {
          // Modal dialog (undo confirmation, delete, etc.)
          // Render AG's native HTML directly with AG's CSS applied.
          // Find the inner dialog card (the visible panel, not the backdrop).
          const root = tempDiv.firstElementChild;
          let dialogCard = null;
          if (root) {
            // Walk all descendants to find the card — the deepest element
            // with rounded corners that contains the action buttons.
            const candidates = root.querySelectorAll('[class*="rounded"]');
            for (const c of candidates) {
              if (c.querySelector('[data-ag-click-id]')) {
                dialogCard = c;
                // Don't break — keep going deeper to find the most specific card
              }
            }
          }
          const dialogInnerHtml = dialogCard ? dialogCard.outerHTML : (root ? root.innerHTML : data.dialogHtml);
          dropdownContent.innerHTML = `
            <style>${cdpStyles.textContent || ''}</style>
            <div class="ag2r-dialog-native">${dialogInnerHtml}</div>
          `;
        }
        addClickProxyHandlers(dropdownContent);
      }
      }
      // Always keep overlay visible while dialog is active (even on deduped renders)
      dropdownOverlay.classList.remove('hidden');
    } else if (!data.dialogHtml) {
      // Dialog dismissed in AG — clear the cached HTML so it re-renders if it comes back
      delete dropdownContent.dataset.lastDialogHtml;
    }

    // Render permission banner if AG is asking for approval
    if (data.permissionHtml) {
      // Skip re-render if: (a) HTML unchanged, or (b) write-in input is focused (avoids
      // destroying the input and dismissing the keyboard when AG reflects our selection click)
      const writeInFocused = permissionContent.querySelector('.permission-writein:focus');
      if (data.permissionHtml === permissionContent.dataset.lastHtml || writeInFocused) {
        // Already rendered or user is typing — don't rebuild
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
          ? `<input type="search" class="permission-writein" placeholder="tell the agent what to do instead" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" data-form-type="other" data-lpignore="true" enterkeyhint="send" />`
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
        // Stash on DOM node so write-in click handler can proxy the selection
        const clickId = btn.dataset.agClickId;
        const clickLabel = btn.dataset.agClickLabel;
        btn._agClickId = clickId;
        btn._agClickLabel = clickLabel;
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

      // Clicking write-in input: stop bubble but auto-select the parent "No" option
      permissionContent.querySelectorAll('.permission-writein').forEach(input => {
        input.addEventListener('click', (e) => {
          e.stopPropagation();
          const parentOption = input.closest('.permission-option');
          if (parentOption && !parentOption.classList.contains('selected')) {
            // Select this option visually
            permissionContent.querySelectorAll('.permission-option').forEach(b => b.classList.remove('selected'));
            parentOption.classList.add('selected');
            // Proxy the selection click to AG
            const clickId = parentOption._agClickId;
            const clickLabel = parentOption._agClickLabel;
            if (clickId) {
              fetchAPI('/click', {
                method: 'POST',
                body: JSON.stringify({ clickId, label: clickLabel }),
              }).catch(() => {});
            }
          }
        });
        // When write-in is focused (keyboard opens on mobile), ensure actions stay visible
        input.addEventListener('focus', () => {
          setTimeout(() => {
            const actions = permissionContent.querySelector('.permission-actions');
            if (actions) actions.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          }, 300);
        });
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

    // Render running tasks strip if AG has background tasks
    if (data.runningTasksHtml) {
      // Skip re-render if HTML hasn't changed
      if (data.runningTasksHtml !== runningTasks.dataset.lastHtml) {
        runningTasks.dataset.lastHtml = data.runningTasksHtml;
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = data.runningTasksHtml;

        // Extract individual task rows
        const allButtons = tempDiv.querySelectorAll('[data-ag-click-id]');
        const buttonArray = Array.from(allButtons);

        // Defense-in-depth: real task sections have >= 3 tagged buttons
        // (1 header toggle + N name/stop pairs). If AG sends a structural
        // wrapper with no real tasks, treat as "no tasks".
        if (buttonArray.length < 3) {
          runningTasks.classList.add('hidden');
          runningTasks.dataset.lastHtml = '';
        } else {
          // Extract header text (e.g., "1 task running")
          const headerBtn = tempDiv.querySelector('button');
          const headerSpan = headerBtn?.querySelector('span');
          runningTasksCount.textContent = headerSpan ? headerSpan.textContent.trim() : 'Tasks running';

          // Build a map: for each task row, find its name button click ID and stop button click ID
          // Button order in capture: header toggle (task:0), then for each task row:
          //   task name button (task:1, task:3, ...), stop button (task:2, task:4, ...)
          let rowsHtml = '';

          // Skip the first button (header toggle, task:0), then pair remaining buttons
          for (let i = 1; i < buttonArray.length; i += 2) {
            const nameBtn = buttonArray[i];
            const stopBtn = buttonArray[i + 1];
            const nameClickId = nameBtn?.dataset?.agClickId || '';
            const nameLabel = nameBtn?.dataset?.agClickLabel || '';
            const stopClickId = stopBtn?.dataset?.agClickId || '';
            const stopLabel = stopBtn?.dataset?.agClickLabel || '';

            // Extract task name from the font-mono span inside the name button
            const monoSpan = nameBtn?.querySelector('.font-mono');
            const taskName = monoSpan ? monoSpan.textContent.trim() : (nameLabel || 'Task');

            rowsHtml += `
              <div class="running-task-row">
                <button class="running-task-name" data-ag-click-id="${nameClickId}" data-ag-click-label="${nameLabel}">
                  <div class="running-task-spinner"></div>
                  <span>${taskName}</span>
                </button>
                <button class="running-task-stop" data-ag-click-id="${stopClickId}" data-ag-click-label="${stopLabel}" aria-label="Stop task">
                  <span class="material-symbols-rounded" style="font-size:18px">stop_circle</span>
                </button>
              </div>
            `;
          }

          runningTasksList.innerHTML = rowsHtml;

          // Wire click proxying for task name (navigate) and stop (kill)
          runningTasksList.querySelectorAll('[data-ag-click-id]').forEach(btn => {
            const clickId = btn.dataset.agClickId;
            const clickLabel = btn.dataset.agClickLabel;
            const isNameBtn = btn.classList.contains('running-task-name');
            btn.removeAttribute('data-ag-click-id');
            btn.addEventListener('click', async () => {
              btn.style.opacity = '0.5';
              btn.style.pointerEvents = 'none';
              try {
                await fetchAPI('/click', {
                  method: 'POST',
                  body: JSON.stringify({ clickId, label: clickLabel }),
                });
              } catch {}
              // Task name click: the click proxy navigates AG.
              // Subagent detection is handled server-side (inputBox absence).
              // Defer sidebar decision: loadSnapshot will open sidebar only for
              // command tasks (not subagents) after checking isSubagentView.
              if (isNameBtn) {
                pendingTaskClick = true;
              }
              setTimeout(() => {
                btn.style.opacity = '';
                btn.style.pointerEvents = '';
              }, 500);
              // Refresh snapshot to pick up the subagent conversation view
              setTimeout(loadSnapshot, 300);
              setTimeout(loadSnapshot, 1000);
            });
          });

          // Restore collapse state
          runningTasksList.classList.toggle('collapsed', runningTasksCollapsed);
          runningTasks.querySelector('.running-tasks-arrow')
            ?.classList.toggle('rotated', runningTasksCollapsed);
          runningTasks.classList.remove('hidden');
        }
      }
    } else {
      runningTasks.classList.add('hidden');
      runningTasks.dataset.lastHtml = '';
    }

    // Render Settings overlay if AG's settings modal is open
    if (data.settingsHtml) {
      // Only update DOM when content actually changes to preserve scroll position
      if (settingsContent._lastHtml !== data.settingsHtml) {
        settingsContent._lastHtml = data.settingsHtml;
        settingsContent.innerHTML = data.settingsHtml;
        addClickProxyHandlers(settingsContent);
      }
      settingsOverlay.classList.remove('hidden');
    } else {
      settingsOverlay.classList.add('hidden');
      settingsContent._lastHtml = '';
    }

    // Render Scheduled Tasks overlay if AG's scheduled tasks page is open
    if (data.scheduledTasksHtml) {
      if (scheduledTasksContent._lastHtml !== data.scheduledTasksHtml) {
        scheduledTasksContent._lastHtml = data.scheduledTasksHtml;
        scheduledTasksContent.innerHTML = data.scheduledTasksHtml;
        addClickProxyHandlers(scheduledTasksContent);
      }
      scheduledTasksOverlay.classList.remove('hidden');
    } else {
      scheduledTasksOverlay.classList.add('hidden');
      scheduledTasksContent._lastHtml = '';
    }

    // Render Scheduled Tasks dialog (New Scheduled Task form, etc.)
    if (data.scheduledTasksDialogHtml) {
      if (scheduledTasksDialog._lastHtml !== data.scheduledTasksDialogHtml) {
        scheduledTasksDialog._lastHtml = data.scheduledTasksDialogHtml;
        scheduledTasksDialog.innerHTML = data.scheduledTasksDialogHtml;
        addClickProxyHandlers(scheduledTasksDialog);
      }
      scheduledTasksDialog.classList.remove('hidden');
    } else {
      scheduledTasksDialog.classList.add('hidden');
      scheduledTasksDialog._lastHtml = '';
    }

    // Track active artifact URI for commenting
    updateActiveArtifact(data);

    // Telemetry: detect model/branch/worktree changes
    if (data.modelName && _prevModelName && data.modelName !== _prevModelName) {
      track('model_changed');
    }
    if (data.modelName) _prevModelName = data.modelName;

    if (data.branchName && _prevBranchName && data.branchName !== _prevBranchName) {
      track('branch_changed');
    }
    if (data.branchName) _prevBranchName = data.branchName;

    if (data.environmentName && _prevEnvironmentName && data.environmentName !== _prevEnvironmentName) {
      track('worktree_changed');
    }
    if (data.environmentName) _prevEnvironmentName = data.environmentName;

    // Sync scroll position from AG's DOM state.
    // AG handles scroll-to-bottom on send and auto-scroll during streaming.
    // We mirror: if AG is near bottom AND the user hasn't scrolled away, scroll to bottom.
    // If the user has deliberately scrolled up, we leave them there until they
    // scroll back to the bottom, tap the FAB, or send a message.
    requestAnimationFrame(() => {
      if (data.scrollInfo && !userScrolledAway) {
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
  // Always update the scroll FAB visibility regardless of rendering state
  updateScrollFab();
  // Only track user scroll intent when NOT rendering (programmatic scroll shouldn't lock user out)
  if (isRendering) return;
  const nearBottom = chatArea.scrollHeight - chatArea.scrollTop - chatArea.clientHeight < 50;
  userScrolledAway = !nearBottom;
}, { passive: true });

scrollFab.addEventListener('click', () => {
  userScrolledAway = false;
  scrollToBottom();
  requestAnimationFrame(() => updateScrollFab());
});

// ─────────────────────────────────────────────
// Code Block Copy Buttons
// ─────────────────────────────────────────────
function getCodeBlockText(pre) {
  // AG renders code blocks with .code-line > .line-content elements.
  // textContent concatenates without newlines; we must extract line-by-line.
  const code = pre.querySelector('code') || pre;

  // Strategy 1: AG's line-based rendering (.code-line .line-content)
  const lineContents = code.querySelectorAll('.line-content');
  if (lineContents.length > 0) {
    return Array.from(lineContents).map(lc => lc.textContent).join('\n');
  }

  // Strategy 2: Use innerText (layout-aware, preserves visual line breaks)
  // Clone to strip <style> tags and UI elements (copy buttons, etc.)
  const clone = code.cloneNode(true);
  clone.querySelectorAll('style, button, .mobile-copy-btn').forEach(el => el.remove());
  return clone.innerText;
}

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
    btn.addEventListener('mousedown', e => e.preventDefault()); // Keep keyboard open
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        const text = getCodeBlockText(pre);
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
  const hasImages = stagedImages.length > 0;
  if ((!text && !hasImages) || isSending) return;

  debugLog('sendMessage-entry', `isSending=${isSending} text="${text.substring(0, 80)}" images=${stagedImages.length}`);
  isSending = true;

  // Stop any active voice recording so onresult doesn't refill the input
  if (stopMainMic) stopMainMic();

  // Clear and disable input to prevent any re-trigger
  messageInput.value = '';
  messageInput.style.height = 'auto';
  messageInput.disabled = true;
  actionBtn.disabled = true;
  messageInput.blur();
  updateActionButton();

  // Upload staged images first (injects into AG's editor via CDP drop)
  if (hasImages) {
    const uploadOk = await uploadStagedImages();
    if (!uploadOk) {
      console.debug('[Send] Some image uploads failed');
      // Don't clear images on failure — let user retry
      isSending = false;
      messageInput.disabled = false;
      actionBtn.disabled = false;
      return;
    }
    clearStagedImages();
  }

  // Prepend any queued artifact comments to the message
  const commentBlock = drainQueuedComments();
  const fullMessage = commentBlock ? commentBlock + '\n' + text : text;

  try {
    if (hasImages && !fullMessage) {
      // Image-only: server waits for AG to process images, then clicks send
      debugLog('sendMessage-images-only');
      const res = await fetchAPI('/send-images', { method: 'POST' });
      const result = await res.json();
      console.debug('[Send] Image-only result:', result);
    } else if (fullMessage) {
      // Text (possibly with images): inject text and click send
      const res = await fetchAPI('/send', {
        method: 'POST',
        body: JSON.stringify({ message: fullMessage, hasImages }),
      });
      const result = await res.json();
      console.debug('[Send] Result:', result);
      if (!result.ok) {
        console.debug('[Send] Failed:', result.reason);
      }
    }
  } catch (e) {
    console.debug('[Send] Error:', e.message);
  }

  // Reset scroll-away flag so AG's scroll position syncs immediately on next render
  userScrolledAway = false;

  // Schedule snapshot reloads to pick up the sent message
  setTimeout(loadSnapshot, 300);
  setTimeout(loadSnapshot, 800);
  setTimeout(loadSnapshot, 2000);

  isSending = false;
  messageInput.disabled = false;
  actionBtn.disabled = false;
  debugLog('sendMessage-exit');
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
  const hasImages = stagedImages.length > 0;

  if (agentRunning && !hasText && !hasImages) {
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

    if (hasText || hasImages) {
      actionBtn.classList.remove('disabled');
    } else {
      actionBtn.classList.add('disabled');
    }
  }

  // Quick actions visibility is managed at server update points only,
  // not here, to prevent user actions (send, type) from causing flicker.
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
      track('quick_action_used', { label: msg });
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
  requestAnimationFrame(() => {
    messageInput.style.height = Math.min(messageInput.scrollHeight, 120) + 'px';
  });
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

// Shared factory: wires SpeechRecognition on any textarea + mic button pair.
// Returns a stopRecording() function so callers (e.g. sendMessage) can kill
// the mic before clearing input.
//
// Key design decisions:
// - continuous:true — avoids per-utterance browser ding on mobile
// - Idempotent onresult — rebuilds text from ALL results every call instead
//   of accumulating. Mobile browsers re-fire events for already-finalized
//   results (resultIndex doesn't advance), which breaks append-based logic.
// - Null out onresult/onend in stopRecording — recognition.stop() is async;
//   the browser fires one last onresult AFTER the caller clears the input,
//   refilling it. Nulling handlers prevents this.
function createVoiceInput(inputEl, btnEl) {
  if (!SpeechRecognition) {
    btnEl.classList.add('unsupported');
    return null;
  }

  let recognition = null;
  let isRecording = false;

  // baselineText: text in input before recording started, plus finals from
  // any previous recognition sessions within this recording (after restarts).
  // sessionFinals: finals from the current recognition session, rebuilt from
  // ALL results on every onresult (idempotent — immune to resultIndex bugs
  // on mobile where the browser re-fires events for already-finalized results).
  let baselineText = '';
  let sessionFinals = '';

  function wireHandlers() {
    recognition.onresult = (event) => {
      // Use ONLY the last result's transcript. Mobile browsers produce
      // cumulative results: each final contains the full text from session
      // start, not just the new words. Concatenating all results duplicates
      // everything. The last result always has the complete current text.
      const latest = event.results[event.results.length - 1];
      const text = latest[0].transcript.trim();

      if (latest.isFinal) {
        sessionFinals = text;
      }

      inputEl.value = baselineText + (text ? (baselineText ? ' ' : '') + text : '');

      // Trigger auto-resize
      inputEl.style.height = 'auto';
      requestAnimationFrame(() => {
        inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
      });
      updateActionButton();
    };

    recognition.onerror = (event) => {
      console.debug('[Voice] Error:', event.error);
      stopRecording();
    };

    recognition.onend = () => {
      // Auto-restart if still in recording mode (browser may stop after
      // silence). Merge session finals into baseline so the restarted
      // session builds on top of them.
      if (isRecording) {
        if (sessionFinals) {
          baselineText += (baselineText ? ' ' : '') + sessionFinals;
          sessionFinals = '';
        }
        try { recognition.start(); } catch {}
      }
    };
  }

  function startRecording() {
    recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = navigator.language || 'en-US';
    wireHandlers();

    baselineText = inputEl.value;
    sessionFinals = '';
    isRecording = true;
    track('voice_input_used');
    btnEl.classList.add('recording');
    btnEl.setAttribute('aria-label', 'Stop recording');

    try {
      recognition.start();
    } catch (err) {
      console.debug('[Voice] Start error:', err);
      stopRecording();
    }
  }

  function stopRecording() {
    isRecording = false;
    btnEl.classList.remove('recording');
    btnEl.setAttribute('aria-label', 'Voice input');
    if (recognition) {
      // Null out handlers BEFORE stopping — recognition.stop() is async
      // and fires a final onresult that would refill the input after
      // sendMessage() clears it.
      recognition.onresult = null;
      recognition.onend = null;
      recognition.onerror = null;
      try { recognition.stop(); } catch {}
      recognition = null;
    }
  }

  btnEl.addEventListener('click', () => {
    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  });

  return stopRecording;
}

// Wire main input bar mic button
const stopMainMic = createVoiceInput(messageInput, micBtn);

// ─────────────────────────────────────────────
// Model Chip (existing conversation input bar)
// ─────────────────────────────────────────────
function updateModelChip(modelName) {
  const chipText = document.querySelector('#model-chip .model-chip-text');
  if (chipText && modelName) {
    chipText.textContent = modelName;
  }
}

// ─────────────────────────────────────────────
// Photo Upload (staged thumbnails, upload on send)
// ─────────────────────────────────────────────
const attachBtn = document.getElementById('attach-btn');
const photoInput = document.getElementById('photo-input');
const imagePreviewStrip = document.getElementById('image-preview-strip');
const MAX_STAGED_IMAGES = 3;
let stagedImages = []; // { file: File, objectUrl: string }

function renderImagePreviewsInto(strip, btn) {
  strip.innerHTML = '';
  if (stagedImages.length === 0) {
    strip.classList.add('hidden');
    if (btn) btn.classList.remove('at-limit');
    return;
  }
  strip.classList.remove('hidden');

  stagedImages.forEach((item, idx) => {
    const wrapper = document.createElement('div');
    wrapper.className = 'image-preview-item';

    const img = document.createElement('img');
    img.src = item.objectUrl;
    img.alt = item.file.name;
    wrapper.appendChild(img);

    const removeBtn = document.createElement('button');
    removeBtn.className = 'remove-btn';
    removeBtn.textContent = '×';
    removeBtn.setAttribute('aria-label', 'Remove image');
    removeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      URL.revokeObjectURL(stagedImages[idx].objectUrl);
      stagedImages.splice(idx, 1);
      renderImagePreviewsInto(strip, btn);
      updateActionButton();
    });
    wrapper.appendChild(removeBtn);

    strip.appendChild(wrapper);
  });

  // Disable attach when at limit
  if (btn) {
    if (stagedImages.length >= MAX_STAGED_IMAGES) {
      btn.classList.add('at-limit');
    } else {
      btn.classList.remove('at-limit');
    }
  }
}

// Shorthand for the main input bar
function renderImagePreviews() {
  renderImagePreviewsInto(imagePreviewStrip, attachBtn);
}

// ── Attach Context Menu (+) ──
// The + button opens a small menu; "Media" triggers the file picker.
function createAttachMenu(parentEl, fileInput) {
  const menu = document.createElement('div');
  menu.className = 'attach-menu hidden';
  menu.innerHTML = `
    <button type="button" class="attach-menu-item" data-action="media">
      <span class="material-symbols-rounded">image</span>
      <span>Media</span>
    </button>
  `;
  parentEl.appendChild(menu);

  menu.querySelector('[data-action="media"]').addEventListener('click', (e) => {
    e.stopPropagation();
    menu.classList.add('hidden');
    if (stagedImages.length >= MAX_STAGED_IMAGES) return;
    fileInput.click();
  });

  return menu;
}

// Create attach menu for main input bar
const attachMenu = createAttachMenu(
  document.querySelector('.input-left-actions'),
  photoInput
);

attachBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  attachMenu.classList.toggle('hidden');
});

// Close all attach menus when clicking elsewhere
document.addEventListener('click', () => {
  document.querySelectorAll('.attach-menu').forEach(m => m.classList.add('hidden'));
});

photoInput.addEventListener('change', () => {
  const files = Array.from(photoInput.files);
  if (!files.length) return;

  const remaining = MAX_STAGED_IMAGES - stagedImages.length;
  const toAdd = files.slice(0, remaining);

  for (const file of toAdd) {
    stagedImages.push({ file, objectUrl: URL.createObjectURL(file) });
  }
  renderImagePreviews();
  updateActionButton();

  // Reset so the same files can be re-selected
  photoInput.value = '';
});

// Upload all staged images to AG via /upload endpoint.
// Returns true if all succeeded (or no images staged), false if any failed.
async function uploadStagedImages() {
  if (stagedImages.length === 0) return true;

  // Mark thumbnails as uploading
  imagePreviewStrip.querySelectorAll('.image-preview-item').forEach(el => {
    el.classList.add('uploading');
  });

  let allOk = true;
  const items = imagePreviewStrip.querySelectorAll('.image-preview-item');

  for (let i = 0; i < stagedImages.length; i++) {
    try {
      const formData = new FormData();
      formData.append('image', stagedImages[i].file);

      const res = await fetch('/upload', {
        method: 'POST',
        body: formData,
        headers: { 'ngrok-skip-browser-warning': '1' },
      });

      const result = await res.json();
      console.debug('[Upload] Result:', result);

      if (items[i]) items[i].classList.remove('uploading');

      if (!res.ok || !result.ok) {
        console.debug('[Upload] Error:', result.error || 'Unknown');
        if (items[i]) items[i].classList.add('upload-error');
        allOk = false;
      }
    } catch (e) {
      console.debug('[Upload] Network error:', e.message);
      if (items[i]) {
        items[i].classList.remove('uploading');
        items[i].classList.add('upload-error');
      }
      allOk = false;
    }
  }

  return allOk;
}

// Clear staged images (called after successful send)
function clearStagedImages() {
  stagedImages.forEach(item => URL.revokeObjectURL(item.objectUrl));
  stagedImages = [];
  renderImagePreviews();
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

sidebarToggle.addEventListener('click', () => {
  if (leftSidebar.classList.contains('open')) {
    closeLeftSidebar();
  } else {
    openLeftSidebar();
  }
});
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

// Settings back button — dismiss settings
settingsBack.addEventListener('click', () => {
  settingsOverlay.classList.add('hidden');
  fetchAPI('/dismiss-settings', { method: 'POST' }).catch(() => {});
});

// Refresh button — hard reload for PWA (no pull-to-refresh on home screen)
refreshBtn.addEventListener('click', () => {
  track('hard_refresh');
  location.reload();
});

// Restart Antigravity — confirmation modal + API call
function showRestartConfirm() {
  restartGo.disabled = false;
  restartGo.textContent = 'Restart';
  restartConfirm.classList.remove('hidden');
}

restartCancel.addEventListener('click', () => {
  restartConfirm.classList.add('hidden');
});

// Dismiss on backdrop tap
restartConfirm.querySelector('.restart-confirm-backdrop').addEventListener('click', () => {
  restartConfirm.classList.add('hidden');
});

restartGo.addEventListener('click', async () => {
  restartGo.disabled = true;
  restartGo.textContent = 'Restarting...';
  try {
    const res = await fetchAPI('/restart-antigravity', { method: 'POST' });
    const data = await res.json();
    if (data.ok) {
      // Success — AG will die, CDP disconnects, auto-reconnect kicks in
      // Dismiss modal after a moment so the user sees the state change
      setTimeout(() => {
        restartConfirm.classList.add('hidden');
      }, 2000);
    } else {
      restartGo.textContent = 'Failed — try again';
      restartGo.disabled = false;
    }
  } catch {
    restartGo.textContent = 'Failed — try again';
    restartGo.disabled = false;
  }
});

// Scheduled Tasks back button — detail view goes back to list, list view navigates to conversation
scheduledTasksBack.addEventListener('click', async () => {
  try {
    const resp = await fetchAPI('/dismiss-scheduled-tasks', { method: 'POST' });
    const data = await resp.json();
    if (data.method === 'detail-back') {
      // Went from detail view back to list — keep overlay open, clear cached HTML to force re-render
      scheduledTasksContent._lastHtml = '';
      return;
    }
  } catch (e) {
    // Fall through to dismiss
  }
  // Navigated away from scheduled tasks entirely — hide overlay
  scheduledTasksOverlay.classList.add('hidden');
  scheduledTasksContent._lastHtml = '';
});

// ─────────────────────────────────────────────
// Right Sidebar (on-demand fetch from AG)
// ─────────────────────────────────────────────
let lastSidebarSignature = null;
let sidebarFetchInFlight = false;

// Image proxy cache: src → dataUrl (survives sidebar open/close, clears on page reload)
const imageProxyCache = new Map();

// Scan sidebar for images with unresolvable src and proxy them via the server
function proxySidebarImages(container) {
  const imgs = container.querySelectorAll('img');
  for (const img of imgs) {
    const src = img.getAttribute('src') || '';
    if (!src || src.startsWith('data:') || src.startsWith('http')) continue;

    // Only proxy unresolvable sources
    if (src.startsWith('blob:') || src.startsWith('file:') ||
        src.startsWith('vscode-file:') || (src.startsWith('/') && !src.startsWith('/symbols-icons'))) {

      // Check cache first
      const cached = imageProxyCache.get(src);
      if (cached) {
        img.src = cached;
        img.style.display = '';
        continue;
      }

      // Mark as loading
      img.dataset.originalSrc = src;

      // Fetch async — don't block sidebar render
      fetchAPI(`/proxy-image?src=${encodeURIComponent(src)}`)
        .then(r => r.json())
        .then(({ dataUrl }) => {
          if (dataUrl) {
            imageProxyCache.set(src, dataUrl);
            img.src = dataUrl;
            img.style.display = '';
          } else {
            img.style.display = 'none';
          }
        })
        .catch(() => {
          img.style.display = 'none';
        });
    }
  }
}

async function fetchRightSidebar() {
  // Skip if user has active text selection (for commenting)
  if (hasActiveSelectionInRightSidebar()) return;
  if (sidebarFetchInFlight) return;
  sidebarFetchInFlight = true;
  try {
    const res = await fetchAPI('/right-sidebar');
    if (!res.ok) return;
    const data = await res.json();
    if (data.html) {
      renderSidebar(rightSidebarContent, data.html);
      addClickProxyHandlers(rightSidebarContent);
      proxySidebarImages(rightSidebarContent);
    } else if (data.wasOpened) {
      // Server opened the sidebar in AG — re-fetch after it renders
      setTimeout(fetchRightSidebar, 600);
    } else {
      // Sidebar truly unavailable — show empty state
      rightSidebarContent.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:center;height:100%;padding:2rem;text-align:center;opacity:0.5;">
          <p>Sidebar not available.<br>Open it in Antigravity first.</p>
        </div>
      `;
    }
  } catch (e) {
    console.debug('[RightSidebar] Fetch error:', e.message);
  } finally {
    sidebarFetchInFlight = false;
  }
}

function openRightSidebar() {
  rightSidebar.classList.add('open');
  rightSidebar.inert = false;
  rightSidebarOverlay.classList.add('visible');
  // Fetch sidebar content on-demand
  fetchRightSidebar();
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

  // Extract model name from server-extracted data
  const modelName = data.modelName || '';

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
        ${projectName ? `<button type="button" class="ag2r-new-session-project" data-ag-click-id="project:0" data-ag-click-label="${projectName}">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 -960 960 960" fill="currentColor">
            <path d="M172.31-180Q142-180 121-201t-21-51.31V-707.69Q100-738 121-759t51.31-21H391.92l80,80H787.69Q818-700 839-679t21,51.31v375.38Q860-222 839-201t-51.31,21H172.31Z"/>
          </svg>
          <span>${projectName}</span>
          <span class="material-symbols-rounded" style="font-size:14px;opacity:0.6">expand_more</span>
        </button>` : ''}
      </div>
      <form id="ag2r-new-session-form" class="ag2r-new-session-form ${envBarHtml ? 'has-env-bar' : ''}">
        <div class="ag2r-new-session-inner">
          <div id="ag2r-ns-image-preview" class="image-preview-strip hidden"></div>
          <textarea
            id="ag2r-new-session-input"
            placeholder="Ask anything..."
            rows="3"
          ></textarea>
          <div class="ag2r-new-session-controls">
            <div class="ag2r-new-session-left">
              <input type="file" id="ag2r-ns-photo-input" accept="image/*" multiple hidden>
              <button type="button" id="ag2r-ns-attach" class="attach-btn" aria-label="Add context">
                <span class="material-symbols-rounded">add</span>
              </button>
              <button type="button" class="ag2r-ns-model-chip model-chip" data-ag-click-id="model:0" data-ag-click-label="${modelName}">
                <span class="model-chip-text">${modelName}</span>
                <span class="material-symbols-rounded model-chip-chevron">expand_more</span>
              </button>
            </div>
            <div class="ag2r-new-session-right">
              <button type="button" id="ag2r-new-session-mic" class="mic-btn" aria-label="Voice input">
                <span class="material-symbols-rounded mic-icon">mic</span>
              </button>
              <button type="submit" id="ag2r-new-session-send" aria-label="Send">
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 -960 960 960" fill="currentColor">
                  <path d="M120-160v-640l760,320-760,320Zm60-93 544-227-544-230v168l242,62-242,60v167Zm0,0v-457,457Z"/>
                </svg>
              </button>
            </div>
          </div>
        </div>
        ${envBarHtml}
      </form>
    </div>
  `;

  const form = container.querySelector('#ag2r-new-session-form');
  const input = container.querySelector('#ag2r-new-session-input');
  const sendBtn = container.querySelector('#ag2r-new-session-send');

  // Prevent snapshot refresh from wiping the input while user is typing
  let userIsTyping = false;
  input.addEventListener('input', () => { userIsTyping = true; });
  input.addEventListener('blur', () => { userIsTyping = false; });

  // Wire attach button (+ icon) to context menu with Media option
  const nsAttachBtn = container.querySelector('#ag2r-ns-attach');
  const nsPhotoInput = container.querySelector('#ag2r-ns-photo-input');
  const nsPreviewStrip = container.querySelector('#ag2r-ns-image-preview');

  const nsAttachMenu = createAttachMenu(
    container.querySelector('.ag2r-new-session-left'),
    nsPhotoInput
  );

  nsAttachBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    nsAttachMenu.classList.toggle('hidden');
  });

  nsPhotoInput.addEventListener('change', () => {
    const files = Array.from(nsPhotoInput.files);
    if (!files.length) return;
    const remaining = MAX_STAGED_IMAGES - stagedImages.length;
    for (const file of files.slice(0, remaining)) {
      stagedImages.push({ file, objectUrl: URL.createObjectURL(file) });
    }
    // Render into the new session preview strip
    renderImagePreviewsInto(nsPreviewStrip, nsAttachBtn);
    nsPhotoInput.value = '';
  });

  // Handle form submission
  let nsIsSending = false;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    const hasImages = stagedImages.length > 0;
    if ((!text && !hasImages) || nsIsSending) return;
    nsIsSending = true;

    // Stop any active voice recording so onresult doesn't refill the input
    if (stopNsMic) stopNsMic();

    // Disable input
    input.disabled = true;
    sendBtn.disabled = true;
    sendBtn.classList.add('sending');

    // Upload staged images first
    if (hasImages) {
      const uploadOk = await uploadStagedImages();
      if (!uploadOk) {
        console.debug('[NewSession] Some image uploads failed');
        nsIsSending = false;
        input.disabled = false;
        sendBtn.disabled = false;
        sendBtn.classList.remove('sending');
        return;
      }
      clearStagedImages();
      renderImagePreviewsInto(nsPreviewStrip, nsAttachBtn);
      await new Promise(r => setTimeout(r, 300));
    }

    if (text) {
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
      }
    }

    nsIsSending = false;
    input.disabled = false;
    sendBtn.disabled = false;
    sendBtn.classList.remove('sending');
  });

  // Desktop: Enter to submit. Mobile: Enter inserts newline.
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !isMobile) {
      e.preventDefault();
      form.requestSubmit();
    }
  });

  // Wire up mic button for new session page (shared factory)
  const nsMicBtn = container.querySelector('#ag2r-new-session-mic');
  let stopNsMic = null;
  if (nsMicBtn) {
    stopNsMic = createVoiceInput(input, nsMicBtn);
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

    // Remove New Conversation and History buttons (not useful on mobile).
    // Scheduled Tasks stays visible — it's the only action kept from the top 3.
    container.querySelectorAll('[data-ag-click-label="New Conversation"], [data-ag-click-label="Conversation History"]').forEach(el => el.remove());

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

    // ── Inject native AG2R actions after Settings ──
    // Only for the left sidebar — inject our own buttons after AG's Settings button
    if (container === leftSidebarContent) {
      const settingsEl = container.querySelector('[data-ag-click-label="Settings"]');
      const target = settingsEl || container; // fallback: append to bottom
      let injectHtml = `
        <button class="ag2r-restart-btn" id="ag2r-restart-trigger">
          <span class="material-symbols-rounded">restart_alt</span>
          Restart Antigravity
        </button>
      `;
      if (featureFlags.showCoffeeLink) {
        injectHtml += `
          <a class="ag2r-coffee-sidebar-btn" href="https://buymeacoffee.com/omercanyy" target="_blank">
            <span class="material-symbols-rounded">local_cafe</span>
            Buy me a coffee
          </a>
        `;
      }
      if (settingsEl) {
        settingsEl.insertAdjacentHTML('afterend', injectHtml);
      } else {
        container.insertAdjacentHTML('beforeend', injectHtml);
      }
      // Wire the injected button
      const restartTrigger = container.querySelector('#ag2r-restart-trigger');
      if (restartTrigger) {
        restartTrigger.addEventListener('click', () => {
          closeLeftSidebar();
          showRestartConfirm();
        });
      }
      const coffeeLink = container.querySelector('.ag2r-coffee-sidebar-btn');
      if (coffeeLink) {
        coffeeLink.addEventListener('click', () => {
          track('coffee_link_clicked');
        });
      }
    }
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

    // Ensure non-interactive elements (DIVs) are tappable on iOS Safari.
    // iOS only fires click events on elements considered "clickable" —
    // either semantic (button, a, input) or elements with cursor:pointer.
    const tag = el.tagName;
    if (tag !== 'BUTTON' && tag !== 'A' && tag !== 'INPUT' && tag !== 'SELECT' && tag !== 'TEXTAREA') {
      el.style.cursor = 'pointer';
    }

    // Prevent keyboard dismissal: stop mousedown from stealing focus
    el.addEventListener('mousedown', e => e.preventDefault());

    el.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();

      const clickId = el.dataset.agClickId; // e.g. "chat:5", "right:2"
      const label = el.dataset.agClickLabel || '';

      console.debug('[Click] id=' + clickId, 'label="' + label + '"', 'tag=' + el.tagName, 'class=' + (el.className || '').substring(0, 80));
      debugLog('click-proxy', `id=${clickId} label="${label}" tag=${el.tagName}`);

      // Intercept "Edit task title" pencil icon — single-click name editing
      // Proxy the click (AG enters inline edit mode), then auto-open text input modal
      if (clickId.startsWith('sched:') && el.getAttribute('aria-label') === 'Edit task title') {
        // Get current name from nearby truncated span
        const nameContainer = el.closest('[class*="flex"]');
        const currentName = nameContainer?.querySelector('.truncate')?.textContent?.trim() || '';

        // Proxy click to AG (enters inline edit mode)
        fetchAPI('/click', {
          method: 'POST',
          body: JSON.stringify({ clickId, label }),
        });

        // Wait for burst re-capture to render the new input, then auto-open text input
        const tryAutoOpen = () => {
          // After edit mode, AG replaces the name span with an input — find it
          const nameInput = scheduledTasksContent.querySelector(
            'input:not([placeholder*="earch"]):not([type="hidden"]):not([role="switch"])'
          );
          if (nameInput && nameInput.dataset.agClickId) {
            showTextInput('Task name', '', false, nameInput.getAttribute('data-ag-value') || currentName, nameInput.dataset.agClickId);
            return true;
          }
          return false;
        };
        setTimeout(() => { if (!tryAutoOpen()) setTimeout(tryAutoOpen, 600); }, 600);
        return;
      }

      // Intercept scheddlg: and sched: clicks on INPUT/TEXTAREA — show local text input modal
      if (clickId.startsWith('scheddlg:') || clickId.startsWith('sched:')) {
        const origTag = el.tagName;
        const origPlaceholder = el.getAttribute('placeholder') || '';
        // Check if this element is an input/textarea (in the captured DOM)
        if (origTag === 'INPUT' || origTag === 'TEXTAREA') {
          const currentValue = el.getAttribute('data-ag-value') || '';
          showTextInput(
            origPlaceholder || (origTag === 'TEXTAREA' ? 'Enter text' : 'Enter value'),
            origPlaceholder,
            origTag === 'TEXTAREA',
            currentValue,
            clickId
          );
          return; // Don't proxy the click
        }
      }

      // Intercept Copy button — get markdown source from AG and copy to phone clipboard
      if (el.getAttribute('aria-label') === 'Copy') {
        try {
          const res = await fetchAPI('/copy-response', {
            method: 'POST',
            body: JSON.stringify({ clickId }),
          });
          const result = await res.json();
          if (result.ok && result.text) {
            await navigator.clipboard.writeText(result.text);
            // Visual feedback — green checkmark
            const origHTML = el.innerHTML;
            el.innerHTML = '<span style="font-size:12px;color:#4ade80">✓</span>';
            setTimeout(() => { el.innerHTML = origHTML; }, 1500);
          }
        } catch (err) {
          console.debug('[Copy] Error:', err.message);
        }
        return;
      }
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

      // Close sidebar only for conversation row clicks (navigates away).
      // Conversation rows have min-h-[32px] in their class; project headers,
      // "See all/less", and "Settings" do not.
      // Also close for "Scheduled Tasks" since it opens a full-screen overlay.
      if (clickId.startsWith('left:')) {
        const elClass = (el.className || '').toString();
        const isConversationRow = elClass.includes('min-h-[32px]');
        const isScheduledTasks = label === 'Scheduled Tasks';
        if (isConversationRow || isScheduledTasks) {
          closeLeftSidebar();
          // Reset subagent view when navigating to a different conversation
          if (isConversationRow) {
            isInSubagentView = false;

          }
        }
      }

      // Close dropdown overlay after any dropdown/dialog/scheduled-tasks-portal action
      if (clickId.startsWith('dropdown:') || clickId.startsWith('dialog:') || (clickId.startsWith('scheddlg:') && parseInt(clickId.split(':')[1], 10) >= 100)) {
        overlayDismissedAt = Date.now();
        dropdownOverlay.classList.add('hidden');
      }

      // "View Diff" in dialog — close modal + open right sidebar to show the diff
      if (clickId.startsWith('dialog:') && /view\s*diff/i.test(label.trim())) {
        setTimeout(() => openRightSidebar(), 300);
      }

      // Only open right sidebar for explicit "Review" button clicks
      if (/^Review$/i.test(label.trim())) {
        openRightSidebar();
      }

      // Open right sidebar when a file row click navigated to a file tab
      if (result?.navigatedToFile) {
        openRightSidebar();
      }

      // Fallback: if clicking an artifact/file card in chat (cursor-pointer DIV)
      // but AG didn't navigate (panel was already showing it), still open the
      // remote's right sidebar to show what AG already has open.
      // Only for DIVs — buttons (thumbs up/down, etc.) should not trigger this.
      // Skip expandable sections (e.g. "N files changed") — they expand inline.
      if (clickId.startsWith('chat:') && !result?.navigatedToFile) {
        const elClass = (el.className || '').toString();
        const isExpandable = /\d+\s+files?\s+changed/i.test(label);
        if (el.tagName === 'DIV' && elClass.includes('cursor-pointer') && !isExpandable) {
          openRightSidebar();
        }
      }

      // Re-fetch right sidebar after right-sidebar clicks (tab switches, etc.)
      if (clickId.startsWith('right:')) {
        setTimeout(fetchRightSidebar, 300);
        setTimeout(fetchRightSidebar, 800);
      }

      // Subagent info clicks (e.g. "Open overview") → open right sidebar
      if (clickId.startsWith('subinfo:')) {
        setTimeout(() => openRightSidebar(), 400);
      }

      // Refresh snapshots to pick up changes
      setTimeout(loadSnapshot, 300);
      setTimeout(loadSnapshot, 800);
      setTimeout(loadSnapshot, 2000);
    });
  });

}

// Wire click proxies on the static input bar (model chip, etc.)
addClickProxyHandlers(inputBar);

// ─────────────────────────────────────────────
// Text Input Modal (for scheduled tasks form fields)
// ─────────────────────────────────────────────
let pendingTextInputPlaceholder = null;
let pendingTextInputClickId = null;

function showTextInput(label, placeholder, isTextarea, currentValue, clickId) {
  pendingTextInputPlaceholder = placeholder;
  pendingTextInputClickId = clickId || null;
  textInputLabel.textContent = label;

  if (isTextarea) {
    textInputField.classList.add('hidden');
    textInputArea.classList.remove('hidden');
    textInputArea.value = currentValue || '';
    textInputArea.placeholder = placeholder;
  } else {
    textInputArea.classList.add('hidden');
    textInputField.classList.remove('hidden');
    textInputField.value = currentValue || '';
    textInputField.placeholder = placeholder;
  }

  textInputModal.classList.remove('hidden');

  // Auto-focus after a frame (ensures keyboard pops up on mobile)
  requestAnimationFrame(() => {
    (isTextarea ? textInputArea : textInputField).focus();
  });
}

function closeTextInput() {
  textInputModal.classList.add('hidden');
  textInputField.value = '';
  textInputArea.value = '';
  pendingTextInputPlaceholder = null;
  pendingTextInputClickId = null;
}

async function submitTextInput() {
  const isTextarea = !textInputArea.classList.contains('hidden');
  const text = isTextarea ? textInputArea.value : textInputField.value;
  const placeholder = pendingTextInputPlaceholder;
  const clickId = pendingTextInputClickId;

  closeTextInput();

  if (!placeholder && !clickId) return;

  try {
    const res = await fetchAPI('/type-text', {
      method: 'POST',
      body: JSON.stringify({ placeholder, text, clickId }),
    });
    const result = await res.json();
    console.debug('[TypeText] Result:', result);
    // Refresh snapshot to show updated value
    setTimeout(loadSnapshot, 300);
    setTimeout(loadSnapshot, 800);
  } catch (err) {
    console.debug('[TypeText] Error:', err.message);
  }
}

textInputCancel.addEventListener('click', closeTextInput);
textInputBackdrop.addEventListener('click', closeTextInput);
textInputSubmit.addEventListener('click', submitTextInput);

// Submit on Enter for single-line input (not textarea)
textInputField.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    submitTextInput();
  }
});

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
    // Track artifact views — deduplicate by checking if URI changed
    if (data.activeArtifactUri !== activeArtifactUri) {
      const uri = data.activeArtifactUri;
      let type = 'other';
      if (uri.includes('implementation_plan')) type = 'implementation_plan';
      else if (uri.includes('walkthrough')) type = 'walkthrough';
      else if (uri.includes('task')) type = 'task';
      else if (/\.(png|jpg|jpeg|gif|svg|webp)$/i.test(uri)) type = 'image';
      track('artifact_viewed', { type });
    }
    activeArtifactUri = data.activeArtifactUri;
    activeFileUri = null;
  } else if (data.activeFileUri) {
    if (data.activeFileUri !== activeFileUri) {
      track('artifact_viewed', { type: 'code_diff' });
    }
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
  track('comment_added');
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
  // Click badge text → open review modal (use assignment to prevent listener accumulation)
  badge.onclick = openReviewModal;
  // Click send button → send (stop propagation so it doesn't also open modal)
  document.getElementById('comment-send-btn').onclick = (e) => {
    e.stopPropagation();
    sendQueuedComments();
  };
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
    track('comments_sent', { count: fullMessage.split('* >').length - 1 });
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
          track('comment_edited');
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
      track('comment_deleted');
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

// ─────────────────────────────────────────────
// Push Notifications — Auto-Subscribe
// ─────────────────────────────────────────────
function pushDebug(msg) {
  console.debug('[Push]', msg);
}
async function checkVapidKeyMatch(subscription) {
  try {
    const res = await fetch('/push/vapid-public-key');
    const { publicKey } = await res.json();
    const serverKey = urlBase64ToUint8Array(publicKey);
    const subKey = new Uint8Array(subscription.options.applicationServerKey);
    if (serverKey.length !== subKey.length) return false;
    return serverKey.every((b, i) => b === subKey[i]);
  } catch {
    // If we can't fetch the key, assume match to avoid breaking existing subscriptions
    return true;
  }
}
async function initPushNotifications() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    pushDebug('Not supported');
    return;
  }

  try {
    pushDebug('Registering SW...');
    const registration = await navigator.serviceWorker.register('/sw.js');
    pushDebug('SW ok');

    const existing = await registration.pushManager.getSubscription();
    if (existing) {
      // Check if the subscription's VAPID key matches the server's current key
      const keyMatch = await checkVapidKeyMatch(existing);
      if (keyMatch) {
        pushDebug('Already subscribed, re-sending');
        await sendSubscription(existing);
        pushDebug('Done ✓');
        return;
      }
      // VAPID key mismatch — stale subscription from old keys
      pushDebug('VAPID key mismatch, re-subscribing...');
      await existing.unsubscribe();
      await subscribePush(registration);
      pushDebug('Re-subscribed with current keys ✓');
      return;
    }

    pushDebug('perm=' + Notification.permission);
    if (Notification.permission === 'denied') {
      pushDebug('Denied, skip');
      return;
    }

    if (Notification.permission === 'granted') {
      pushDebug('Granted, subscribing...');
      await subscribePush(registration);
      pushDebug('Done ✓');
      return;
    }

    // Only request on genuine user gesture — capture phase fires before
    // any inner stopPropagation() calls. Never request without gesture,
    // as Chrome's "quiet UI" will auto-deny and permanently block the domain.
    pushDebug('Waiting gesture...');
    const handler = async () => {
      document.removeEventListener('touchstart', handler, true);
      document.removeEventListener('mousedown', handler, true);
      pushDebug('Gesture! Requesting...');
      const result = await Notification.requestPermission();
      pushDebug('Result=' + result);
      if (result === 'granted') {
        await subscribePush(registration);
        pushDebug('Done ✓');
      } else if (result === 'default') {
        document.addEventListener('touchstart', handler, { capture: true, once: true });
        document.addEventListener('mousedown', handler, { capture: true, once: true });
      }
    };
    document.addEventListener('touchstart', handler, { capture: true, once: true });
    document.addEventListener('mousedown', handler, { capture: true, once: true });
  } catch (e) {
    pushDebug('Error: ' + e.message);
  }
}

async function subscribePush(registration) {
  try {
    const res = await fetch('/push/vapid-public-key');
    const { publicKey } = await res.json();

    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });

    await sendSubscription(subscription);
  } catch (e) {
    pushDebug('Sub error: ' + e.message);
  }
}

async function sendSubscription(subscription) {
  try {
    await fetch('/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(subscription),
    });
  } catch {}
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

initPushNotifications();
