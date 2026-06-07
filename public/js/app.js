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
const reviewBadge = document.getElementById('review-badge');
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

    // Check if near bottom before rendering (for auto-scroll decision)
    const wasNearBottom = isNearBottom();

    // Render HTML
    isRendering = true;
    chatContent.innerHTML = data.html;
    hideEmptyState();

    // Add mobile copy buttons to code blocks
    addMobileCopyButtons();

    // Wire up click proxying for interactive elements across all areas
    addClickProxyHandlers(chatContent);

    // Render both sidebars with AG's captured content
    renderSidebar(leftSidebarContent, data.leftSidebarHtml);
    renderSidebar(rightSidebarContent, data.rightSidebarHtml);
    addClickProxyHandlers(leftSidebarContent);
    addClickProxyHandlers(rightSidebarContent);

    // Update review badge
    reviewBadge.classList.toggle('hidden', !data.rightSidebarHtml);

    // Auto-scroll: only if user was already near the bottom
    requestAnimationFrame(() => {
      isRendering = false;
      if (wasNearBottom && Date.now() > userScrollLockUntil) {
        scrollToBottom();
      }
      updateScrollFab();
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

  try {
    const res = await fetchAPI('/send', {
      method: 'POST',
      body: JSON.stringify({ message: text }),
    });

    const result = await res.json();
    console.debug('[Send] Result:', result);

    if (!result.ok) {
      console.debug('[Send] Failed:', result.reason);
    }

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
// Input Handling
// ─────────────────────────────────────────────

// Auto-resize textarea
messageInput.addEventListener('input', () => {
  messageInput.style.height = 'auto';
  messageInput.style.height = Math.min(messageInput.scrollHeight, 120) + 'px';
  updateActionButton();
});

// Enter to send (Shift+Enter for newline)
// Mobile keyboards can fire Enter twice rapidly — debounce to prevent double-send
let lastEnterSend = 0;
messageInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
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
// Left Sidebar (AG's captured chat list)
// ─────────────────────────────────────────────
function openLeftSidebar() {
  leftSidebar.classList.add('open');
  leftSidebar.inert = false;
  leftSidebarOverlay.classList.add('visible');
}

function closeLeftSidebar() {
  leftSidebar.classList.remove('open');
  leftSidebar.inert = true;
  leftSidebarOverlay.classList.remove('visible');
}

sidebarToggle.addEventListener('click', openLeftSidebar);
leftSidebarOverlay.addEventListener('click', closeLeftSidebar);

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


      el.classList.add('ag-clicking');
      try {
        const res = await fetchAPI('/click', {
          method: 'POST',
          body: JSON.stringify({ clickId, label }),
        });
        const result = await res.json();

      } catch (err) {
        console.debug('[Click] Error:', err.message);
      }
      el.classList.remove('ag-clicking');

      // If this was a Review or artifact-related click, also open right sidebar
      if (/^Review$/i.test(label.trim()) || clickId.startsWith('chat:')) {
        // Artifact cards and Review buttons in chat should open the review panel
        const isReview = /^Review$/i.test(label.trim());
        const isArtifact = el.closest('[class*="cursor-pointer"]') && !el.matches('button, a');
        if (isReview || isArtifact) {
          openRightSidebar();
        }
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
// Initialization
// ─────────────────────────────────────────────
connectWebSocket();
loadSnapshot();
updateActionButton();
