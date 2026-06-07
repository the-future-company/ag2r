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


    // Don't re-render if the user is actively using the new session input
    const newSessionInput = document.getElementById('ag2r-new-session-input');
    const newSessionMic = document.getElementById('ag2r-new-session-mic');
    const micRecording = newSessionMic && newSessionMic.classList.contains('recording');
    const inputHasText = newSessionInput && newSessionInput.value.trim().length > 0;
    if (data.isNewSessionPage && newSessionInput && (document.activeElement === newSessionInput || micRecording || inputHasText)) {
      // Still update sidebars, just don't wipe the chat area
      isRendering = true;
      renderSidebar(leftSidebarContent, data.leftSidebarHtml);
      renderSidebar(rightSidebarContent, data.rightSidebarHtml);
      addClickProxyHandlers(leftSidebarContent);
      addClickProxyHandlers(rightSidebarContent);
      isRendering = false;
      return;
    }

    // Render HTML
    isRendering = true;
    chatContent.innerHTML = data.html;
    hideEmptyState();

    // If this is the new session page, replace captured content with a functional input
    if (data.isNewSessionPage) {
      renderNewSessionPage(chatContent, data.html);
    }

    // Add mobile copy buttons to code blocks
    addMobileCopyButtons();

    // Wire up click proxying for interactive elements across all areas
    addClickProxyHandlers(chatContent);

    // Render both sidebars with AG's captured content
    renderSidebar(leftSidebarContent, data.leftSidebarHtml);
    renderSidebar(rightSidebarContent, data.rightSidebarHtml);
    addClickProxyHandlers(leftSidebarContent);
    addClickProxyHandlers(rightSidebarContent);

    // Render dropdown overlay if AG has a portal menu open
    if (data.dropdownHtml) {
      // Parse the dropdown to find the Delete button's click ID
      const tempDiv = document.createElement('div');
      tempDiv.innerHTML = data.dropdownHtml;
      const deleteBtn = Array.from(tempDiv.querySelectorAll('[data-ag-click-id]')).find(
        el => el.textContent.trim() === 'Delete Conversation'
      );
      if (deleteBtn) {
        const deleteClickId = deleteBtn.dataset.agClickId;
        dropdownContent.innerHTML = `
          <button class="destructive" data-ag-click-id="${deleteClickId}" data-ag-click-label="Delete Conversation">
            <span class="material-symbols-rounded" style="font-size:20px">delete</span>
            Delete Conversation
          </button>
        `;
        addClickProxyHandlers(dropdownContent);
        dropdownOverlay.classList.remove('hidden');
      }
    } else {
      dropdownOverlay.classList.add('hidden');
    }

    // Render dialog modal if AG has one open (e.g., delete confirmation)
    if (data.dialogHtml) {
      const tempDiv = document.createElement('div');
      tempDiv.innerHTML = data.dialogHtml;
      // Extract buttons with click IDs
      const dialogBtns = tempDiv.querySelectorAll('[data-ag-click-id]');
      if (dialogBtns.length > 0) {
        // Extract title and message from the dialog text
        const allText = tempDiv.textContent.trim();
        // Build our own confirmation modal
        let buttonsHtml = '';
        dialogBtns.forEach(btn => {
          const text = btn.textContent.trim();
          const id = btn.dataset.agClickId;
          const label = btn.dataset.agClickLabel || text;
          const isDestructive = text.toLowerCase().includes('delete');
          const isCancel = text.toLowerCase().includes('cancel');
          const cls = isDestructive ? 'destructive' : (isCancel ? 'cancel' : '');
          buttonsHtml += `<button class="${cls}" data-ag-click-id="${id}" data-ag-click-label="${label}">${text}</button>`;
        });
        dropdownContent.innerHTML = `
          <div class="dialog-title">Delete Conversation</div>
          <div class="dialog-message">Are you sure? This action cannot be undone.</div>
          <div class="dialog-buttons">${buttonsHtml}</div>
        `;
        addClickProxyHandlers(dropdownContent);
        dropdownOverlay.classList.remove('hidden');
      }
    }

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
  dropdownOverlay.classList.add('hidden');
  // Clicking body in AG should dismiss the dropdown
  loadSnapshot();
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
function renderNewSessionPage(container, capturedHtml) {
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
          autofocus
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

  // Also submit on Enter (without Shift)
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
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

  // Focus the input
  requestAnimationFrame(() => input.focus());
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

      // Auto-close left sidebar on session/action clicks.
      // Don't close for menu buttons (aria-haspopup) — they open dropdowns
      // that need the sidebar to stay visible.
      if (clickId.startsWith('left:') && !el.hasAttribute('aria-haspopup')) {
        closeLeftSidebar();
      }

      // Close dropdown overlay after any dropdown/dialog action
      if (clickId.startsWith('dropdown:') || clickId.startsWith('dialog:')) {
        dropdownOverlay.classList.add('hidden');
        closeLeftSidebar();
      }

      // Only open right sidebar for explicit "Review" button clicks
      if (/^Review$/i.test(label.trim())) {
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
// Initialization
// ─────────────────────────────────────────────
connectWebSocket();
loadSnapshot();
updateActionButton();
