// server.js — AG2R Server
// CDP connection, snapshot capture, WebSocket broadcasting, Express, auth
import express from 'express';
import { createServer as createHttpsServer } from 'https';
import { createServer as createHttpServer } from 'http';
import { WebSocketServer } from 'ws';
import CDP from 'chrome-remote-interface';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import cookieParser from 'cookie-parser';
import compression from 'compression';
import selfsigned from 'selfsigned';
import dotenv from 'dotenv';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// === Configuration (SSoT: .env.example) ===
const PORT = parseInt(process.env.PORT || '3000');
const CDP_HOST = process.env.CDP_HOST || '127.0.0.1';
const CDP_PORT = parseInt(process.env.CDP_PORT || '9000');
const APP_PASSWORD = process.env.APP_PASSWORD || 'antigravity';
const SESSION_SECRET = process.env.SESSION_SECRET || 'ag2r-default-secret';
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL_MS || '500');
const TUNNEL_ENABLED = process.env.TUNNEL_ENABLED === 'true';
const TUNNEL_URL = process.env.TUNNEL_URL || '';

// === Mutable State ===
let cdpClient = null;
let cdpContexts = [];
let preferredContextId = null;
let cachedSnapshot = null;
let lastSnapshotHash = null;
let pollTimer = null;
let reconnectTimer = null;
const wsClients = new Set();

// ─────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────

function hashString(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}

function authToken() {
  return hashString(APP_PASSWORD + ':ag2r-salt');
}

function isLocalRequest(req) {
  // Local network requests bypass auth (no proxy headers)
  if (req.headers['x-forwarded-for'] || req.headers['cf-connecting-ip']) {
    return false;
  }
  const ip = req.ip || req.connection?.remoteAddress || '';
  return /^(127\.|::1|::ffff:127\.|localhost|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
}

function log(prefix, ...args) {
  console.log(`[${prefix}]`, ...args);
}

// ─────────────────────────────────────────────
// SSL Certificate Generation
// ─────────────────────────────────────────────

function ensureCerts() {
  const certDir = path.join(__dirname, 'certs');
  const keyPath = path.join(certDir, 'server.key');
  const certPath = path.join(certDir, 'server.cert');

  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
  }

  log('SSL', 'Generating self-signed certificate...');
  fs.mkdirSync(certDir, { recursive: true });

  const pems = selfsigned.generate(
    [{ name: 'commonName', value: 'localhost' }],
    {
      days: 365,
      keySize: 2048,
      algorithm: 'sha256',
      extensions: [
        { name: 'subjectAltName', altNames: [
          { type: 2, value: 'localhost' },
          { type: 7, ip: '127.0.0.1' },
        ]},
      ],
    }
  );

  fs.writeFileSync(keyPath, pems.private);
  fs.writeFileSync(certPath, pems.cert);
  log('SSL', 'Certificate saved to certs/');

  return { key: pems.private, cert: pems.cert };
}

// ─────────────────────────────────────────────
// CDP Connection
// ─────────────────────────────────────────────

async function discoverTarget() {
  const ports = [CDP_PORT, CDP_PORT + 1, CDP_PORT + 2, CDP_PORT + 3];

  for (const port of ports) {
    try {
      const targets = await CDP.List({ host: CDP_HOST, port });
      if (!targets || targets.length === 0) continue;

      // Priority 1: Workbench target
      const workbench = targets.find(t =>
        t.url?.includes('workbench.html') || t.title?.includes('workbench')
      );
      if (workbench) return { port, target: workbench };

      // Priority 2: Jetski/Launchpad target
      const jetski = targets.find(t =>
        t.url?.includes('jetski') || t.title === 'Launchpad'
      );
      if (jetski) return { port, target: jetski };

      // Priority 3: Any page target (AG2.0 fallback)
      const page = targets.find(t => t.type === 'page');
      if (page) return { port, target: page };
    } catch {
      // Port not available, try next
    }
  }
  return null;
}

async function connectCDP() {
  const discovery = await discoverTarget();
  if (!discovery) {
    throw new Error(`No CDP target found on ${CDP_HOST}:${CDP_PORT}`);
  }

  log('CDP', `Connecting to "${discovery.target.title}" on port ${discovery.port}`);

  const client = await CDP({
    host: CDP_HOST,
    port: discovery.port,
    target: discovery.target,
  });

  // Track execution contexts
  cdpContexts = [];
  preferredContextId = null;

  client.Runtime.executionContextCreated(({ context }) => {
    cdpContexts.push(context);
    console.debug('[CDP] Context created:', context.id, context.origin);
  });

  client.Runtime.executionContextDestroyed(({ executionContextId }) => {
    cdpContexts = cdpContexts.filter(c => c.id !== executionContextId);
    if (preferredContextId === executionContextId) {
      preferredContextId = null;
    }
  });

  client.Runtime.executionContextsCleared(() => {
    cdpContexts = [];
    preferredContextId = null;
  });

  await client.Runtime.enable();

  // Wait briefly for context events to arrive
  await new Promise(r => setTimeout(r, 500));

  client.on('disconnect', () => {
    log('CDP', 'Disconnected');
    cdpClient = null;
    cdpContexts = [];
    preferredContextId = null;
    broadcastStatus();
    scheduleReconnect();
  });

  cdpClient = client;

  // Force AG's page to think it's focused even when in background.
  // Without this, the browser defers rendering and React batches updates,
  // causing expanded sections to appear empty until the user focuses the window.
  try { await client.Emulation.setFocusEmulationEnabled({ enabled: true }); } catch {}

  log('CDP', `Connected. ${cdpContexts.length} execution context(s) available.`);
  broadcastStatus();
  return client;
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    try {
      await connectCDP();
      log('CDP', 'Reconnected successfully');
    } catch (e) {
      console.debug('[CDP] Reconnect failed:', e.message);
      scheduleReconnect();
    }
  }, 3000);
}

// Evaluate JS in the browser, trying contexts in priority order
// Locks to a preferred context to avoid hash oscillation between contexts
async function evaluateInBrowser(expression, opts = {}) {
  if (!cdpClient) throw new Error('CDP not connected');

  const sorted = [...cdpContexts].sort((a, b) => {
    if (a.id === preferredContextId) return -1;
    if (b.id === preferredContextId) return 1;
    const aDefault = a.auxData?.isDefault ? 1 : 0;
    const bDefault = b.auxData?.isDefault ? 1 : 0;
    return bDefault - aDefault;
  });

  for (const ctx of sorted) {
    try {
      const result = await cdpClient.Runtime.evaluate({
        expression,
        contextId: ctx.id,
        awaitPromise: true,
        returnByValue: true,
        ...opts,
      });

      if (result.exceptionDetails) {
        console.debug('[CDP] Eval exception in context', ctx.id, result.exceptionDetails.text, JSON.stringify(result.exceptionDetails.exception || {}).substring(0, 200));
        continue;
      }

      // Lock to this context on success
      preferredContextId = ctx.id;
      return result.result?.value ?? null;
    } catch (e) {
      console.debug('[CDP] Eval failed in context', ctx.id, e.message);
      continue;
    }
  }

  throw new Error('No valid execution context');
}

// ─────────────────────────────────────────────
// Snapshot Capture
// ─────────────────────────────────────────────

// The capture script runs IN the Antigravity browser context.
// Captures: chat container (with cleanup) + left sidebar + right sidebar (raw clones)
// Tags interactive elements across all three areas for click proxying
// Click IDs are prefixed: chat:N, left:N, right:N
const CAPTURE_SCRIPT = `
(async () => {
  // -- Helper: tag interactive elements for click proxying --
  function tagInteractives(root, prefix, skipVisibilityCheck, includeCursorPointer, maxTextLength) {
    let idx = 0;
    const tagged = [];
    // Semantic interactive elements — always tag, no text-length filter
    root.querySelectorAll('button, a, [role="button"]').forEach(el => {
      if (skipVisibilityCheck || el.offsetParent !== null) {
        const text = (el.textContent || '').trim();
        el.setAttribute('data-ag-click-id', prefix + ':' + idx);
        el.setAttribute('data-ag-click-label', text.substring(0, 50));
        idx++;
        tagged.push(el);
      }
    });
    // cursor-pointer elements are ambiguous — could be content containers.
    // Apply maxTextLength to skip large content blocks (code blocks, paragraphs).
    if (includeCursorPointer) {
      root.querySelectorAll('[class*="cursor-pointer"]').forEach(el => {
        if ((skipVisibilityCheck || el.offsetParent !== null) && !el.hasAttribute('data-ag-click-id')) {
          const text = (el.textContent || '').trim();
          if (maxTextLength && text.length > maxTextLength) return;
          el.setAttribute('data-ag-click-id', prefix + ':' + idx);
          el.setAttribute('data-ag-click-label', text.substring(0, 50));
          idx++;
          tagged.push(el);
        }
      });
    }
    return tagged;
  }

  function untagAll(tagged) {
    tagged.forEach(el => {
      el.removeAttribute('data-ag-click-id');
      el.removeAttribute('data-ag-click-label');
    });
  }

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
      if (/^(Allow|Deny|Review|Run|Confirm)/i.test(b.textContent?.trim())) isActionBar = true;
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

  // -- 13b. Extract theme CSS variables from DOM --
  // AG defines critical vars (--foreground, --background, etc.) on DOM elements,
  // not in stylesheets. Extract them so they resolve in our context.
  const themeVars = [
    'foreground', 'background', 'border', 'muted', 'muted-foreground',
    'primary', 'primary-foreground', 'secondary', 'secondary-foreground',
    'accent', 'accent-foreground', 'card', 'card-foreground', 'card-border',
    'popover', 'popover-foreground', 'destructive', 'destructive-foreground',
    'input', 'ring', 'code-background', 'code-foreground',
    'sidebar', 'sidebar-background', 'sidebar-foreground', 'sidebar-border',
    'sidebar-muted', 'sidebar-muted-foreground', 'sidebar-accent',
    'sidebar-secondary', 'sidebar-ring',
    // VS Code diff editor colors — AG's diff viewer references these
    'vscode-diffEditor-insertedLineBackground', 'vscode-diffEditor-insertedTextBackground',
    'vscode-diffEditor-removedLineBackground', 'vscode-diffEditor-removedTextBackground',
  ];
  const rootStyle = getComputedStyle(document.documentElement);
  const bodyStyle = document.body ? getComputedStyle(document.body) : null;
  const themeRules = [];
  for (const v of themeVars) {
    const val = rootStyle.getPropertyValue('--' + v).trim()
              || (bodyStyle ? bodyStyle.getPropertyValue('--' + v).trim() : '');
    if (val) themeRules.push('--' + v + ':' + val);
  }
  if (themeRules.length > 0) {
    css = ':root{' + themeRules.join(';') + '}\\n' + css;
  }

  // -- 14. Capture LEFT sidebar (bg-sidebar) --
  let leftSidebarHtml = null;
  try {
    const leftRoot = document.querySelector('[class*="bg-sidebar"]');
    if (leftRoot && leftRoot.offsetParent !== null) {
      const leftTagged = tagInteractives(leftRoot, 'left', true, true);
      const leftClone = leftRoot.cloneNode(true);
      untagAll(leftTagged);
      leftSidebarHtml = leftClone.outerHTML;
    }
  } catch (e) {
    console.debug('[AG2R] Left sidebar capture error:', e.message);
  }

  // -- 15. Capture RIGHT sidebar (Overview/Review panel) --
  // Use stable anchors: data-tab-id, close-aux-pane button
  let rightSidebarHtml = null;
  try {
    let sidebarRoot = null;

    // Strategy 1: Find via tab-id buttons (always present in the panel)
    const tabBtn = document.querySelector('[data-tab-id="overview"], [data-tab-id="review"]');
    if (tabBtn) {
      // Walk up to find the flex-col root container
      let el = tabBtn;
      for (let i = 0; i < 10 && el; i++) {
        el = el.parentElement;
        const cls = el?.className?.toString?.() || '';
        if (cls.includes('flex') && cls.includes('flex-col') && el.children.length >= 2) {
          const rect = el.getBoundingClientRect();
          if (rect.width > 100 && rect.height > 200) {
            sidebarRoot = el;
            break;
          }
        }
      }
    }

    // Strategy 2: Find via close-aux-pane button
    if (!sidebarRoot) {
      const closeBtn = document.querySelector('[data-testid="close-aux-pane"]');
      if (closeBtn) {
        let el = closeBtn;
        for (let i = 0; i < 10 && el; i++) {
          el = el.parentElement;
          const cls = el?.className?.toString?.() || '';
          if (cls.includes('flex') && cls.includes('flex-col') && el.children.length >= 2) {
            sidebarRoot = el;
            break;
          }
        }
      }
    }

    if (sidebarRoot) {
      const rightTagged = tagInteractives(sidebarRoot, 'right', true, true);
      const rightClone = sidebarRoot.cloneNode(true);
      untagAll(rightTagged);
      rightSidebarHtml = rightClone.outerHTML;
    }
  } catch (e) {
    console.debug('[AG2R] Right sidebar capture error:', e.message);
  }
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
        dialogHtml = clone.outerHTML;
      }
    }
  } catch (e) {
    console.debug('[AG2R] Portal capture error:', e.message);
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

  return { html, css, agentRunning, scrollInfo, leftSidebarHtml, rightSidebarHtml, isNewSessionPage, dropdownHtml, dialogHtml, activeArtifactUri, activeFileUri, permissionHtml };
})()
`;



async function captureSnapshot() {
  try {
    const result = await evaluateInBrowser(CAPTURE_SCRIPT);
    if (!result) return null;
    return result;
  } catch (e) {
    console.debug('[Snapshot] Capture failed:', e.message);
    return null;
  }
}

// ─────────────────────────────────────────────
// Message Injection (via CDP into Lexical editor)
// ─────────────────────────────────────────────

function buildInjectScript(text) {
  // JSON.stringify safely escapes quotes, newlines, backticks, unicode
  const safeText = JSON.stringify(text);

  return `
(async () => {
  // Find the editor (Lexical or generic contenteditable)
  const editorCandidates = document.querySelectorAll(
    '[data-lexical-editor="true"], [contenteditable="true"][role="textbox"], [contenteditable="true"]'
  );

  // Filter to visible editors, take the last one (usually the input at bottom)
  let editor = null;
  for (const el of editorCandidates) {
    if (el.offsetParent !== null) editor = el;
  }
  if (!editor) return { ok: false, reason: 'no_editor' };

  // Focus and clear
  editor.focus();
  document.execCommand('selectAll', false, null);
  document.execCommand('delete', false, null);

  // Insert text via clipboard paste to preserve newlines in Lexical editor
  const textVal = ${safeText};
  const dt = new DataTransfer();
  dt.setData('text/plain', textVal);
  const pasteEvent = new ClipboardEvent('paste', {
    clipboardData: dt, bubbles: true, cancelable: true,
  });
  // dispatchEvent returns false if a handler called preventDefault (= paste was handled).
  // Returns true if no handler caught it (= need fallback).
  const notHandled = editor.dispatchEvent(pasteEvent);
  if (notHandled) {
    // No paste handler caught it — fall back to insertText (single-line only)
    document.execCommand('insertText', false, textVal);
  }

  // Brief delay for editor to process
  await new Promise(r => setTimeout(r, 100));

  // Find and click submit button
  const submitSelectors = [
    'button[data-testid="send-button"]',
    'button[aria-label*="send" i]',
    'button[aria-label*="submit" i]',
  ];

  let submitBtn = null;
  for (const sel of submitSelectors) {
    submitBtn = document.querySelector(sel);
    if (submitBtn && submitBtn.offsetParent !== null) break;
    submitBtn = null;
  }

  // Fallback: look for arrow icon button near the editor
  if (!submitBtn) {
    const arrow = document.querySelector('svg.lucide-arrow-right, svg.lucide-arrow-up');
    if (arrow) submitBtn = arrow.closest('button');
  }

  // Fallback: form submit or sibling button
  if (!submitBtn) {
    const form = editor.closest('form');
    if (form) submitBtn = form.querySelector('button[type="submit"], button:last-of-type');
  }
  if (!submitBtn) {
    const parent = editor.parentElement;
    if (parent) submitBtn = parent.querySelector('button');
  }

  if (submitBtn) {
    submitBtn.click();
    return { ok: true, method: 'button' };
  }

  // Last resort: dispatch Enter key
  const enterEvent = new KeyboardEvent('keydown', {
    key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true,
  });
  editor.dispatchEvent(enterEvent);
  return { ok: true, method: 'enter' };
})()
`;
}

async function injectMessage(text) {
  const script = buildInjectScript(text);
  return await evaluateInBrowser(script);
}

// ─────────────────────────────────────────────
// Stop Generation (via CDP)
// ─────────────────────────────────────────────

const STOP_SCRIPT = `
(async () => {
  // Primary: tooltip-based cancel button
  const cancelBtn = document.querySelector('[data-tooltip-id="input-send-button-cancel-tooltip"]');
  if (cancelBtn && cancelBtn.offsetParent !== null) {
    cancelBtn.click();
    return { ok: true, method: 'cancel-tooltip' };
  }

  // Fallback: square stop icon
  const squareIcon = document.querySelector('button svg.lucide-square');
  if (squareIcon) {
    const btn = squareIcon.closest('button');
    if (btn && btn.offsetParent !== null) {
      btn.click();
      return { ok: true, method: 'square-icon' };
    }
  }

  return { ok: false, reason: 'no_stop_button' };
})()
`;

async function stopGeneration() {
  return await evaluateInBrowser(STOP_SCRIPT);
}

// ─────────────────────────────────────────────
// Polling Loop
// ─────────────────────────────────────────────

let errorLogThrottle = 0;

function startPolling() {
  if (pollTimer) return;

  async function poll() {
    if (!cdpClient) {
      pollTimer = setTimeout(poll, POLL_INTERVAL);
      return;
    }

    try {
      const snapshot = await captureSnapshot();

      if (snapshot) {
        const hash = hashString(
          snapshot.html +
          (snapshot.leftSidebarHtml || '') +
          (snapshot.rightSidebarHtml || '') +
          (snapshot.dropdownHtml || '') +
          (snapshot.dialogHtml || '') +
          (snapshot.permissionHtml || '')
        );

        // Only broadcast and update cache when content actually changes
        if (hash !== lastSnapshotHash) {
          cachedSnapshot = snapshot;
          cachedSnapshot.hash = hash;
          lastSnapshotHash = hash;
          broadcast({
            type: 'snapshot',
            hash,
            agentRunning: snapshot.agentRunning,
            timestamp: new Date().toISOString(),
          });
        } else if (snapshot.agentRunning !== cachedSnapshot?.agentRunning) {
          // Agent status changed but content didn't — still notify
          cachedSnapshot.agentRunning = snapshot.agentRunning;
          broadcast({
            type: 'status',
            agentRunning: snapshot.agentRunning,
          });
        }

        errorLogThrottle = 0;
      }
      // null snapshot = no chat container found. Keep displaying last known content.
      // Never wipe cached content on selector failure.
    } catch (e) {
      const now = Date.now();
      if (now - errorLogThrottle > 10000) {
        console.debug('[Poll] Error:', e.message);
        errorLogThrottle = now;
      }
    }

    pollTimer = setTimeout(poll, POLL_INTERVAL);
  }

  poll();
}

function stopPolling() {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

// ─────────────────────────────────────────────
// WebSocket Broadcasting
// ─────────────────────────────────────────────

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const ws of wsClients) {
    if (ws.readyState === 1) {
      ws.send(msg);
    }
  }
}

function broadcastStatus() {
  broadcast({
    type: 'connection',
    cdpConnected: !!cdpClient,
  });
}

// ─────────────────────────────────────────────
// Express App
// ─────────────────────────────────────────────

const app = express();
app.use(compression());
app.use(express.json());
app.use(cookieParser(SESSION_SECRET));

// Trust proxy for Cloudflare Tunnel
if (TUNNEL_ENABLED) {
  app.set('trust proxy', true);
}

// --- Auth Middleware ---
const PUBLIC_PATHS = ['/login', '/login.html', '/favicon.ico'];

app.use((req, res, next) => {
  // Public paths bypass auth
  if (PUBLIC_PATHS.some(p => req.path === p) || req.path.startsWith('/css/')) {
    return next();
  }

  // Magic link: ?key=password auto-logs in
  if (req.query.key === APP_PASSWORD) {
    res.cookie('ag2r_token', authToken(), {
      signed: true,
      httpOnly: true,
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
      sameSite: 'lax',
    });
    // Redirect to strip the key from URL
    const cleanUrl = req.path;
    return res.redirect(cleanUrl);
  }

  // Local network requests bypass auth
  if (isLocalRequest(req)) return next();

  // Check auth cookie
  const token = req.signedCookies?.ag2r_token;
  if (token === authToken()) return next();

  // Unauthorized
  if (req.headers.accept?.includes('text/html')) {
    return res.redirect('/login.html');
  }
  return res.status(401).json({ error: 'Unauthorized' });
});

// --- Static Files (no cache during development) ---
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  lastModified: false,
  setHeaders: (res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  },
}));

// --- Catch-all for AG2.0 local asset paths (symbols-icons, etc.) ---
const EMPTY_SVG = '<svg xmlns="http://www.w3.org/2000/svg"/>';
app.get('/symbols-icons/*', (req, res) => {
  res.type('svg').send(EMPTY_SVG);
});

// --- Auth Endpoints ---
app.post('/login', (req, res) => {
  const { password } = req.body;
  if (password !== APP_PASSWORD) {
    return res.status(401).json({ error: 'Invalid password' });
  }

  res.cookie('ag2r_token', authToken(), {
    signed: true,
    httpOnly: true,
    maxAge: 30 * 24 * 60 * 60 * 1000,
    sameSite: 'lax',
  });

  res.json({ ok: true });
});

app.post('/logout', (req, res) => {
  res.clearCookie('ag2r_token');
  res.json({ ok: true });
});

// --- Snapshot Endpoint ---
app.get('/snapshot', (req, res) => {
  if (!cachedSnapshot) {
    return res.status(503).json({ error: 'No snapshot available' });
  }

  res.json({
    html: cachedSnapshot.html,
    css: cachedSnapshot.css,
    hash: cachedSnapshot.hash,
    agentRunning: cachedSnapshot.agentRunning,
    scrollInfo: cachedSnapshot.scrollInfo,
    leftSidebarHtml: cachedSnapshot.leftSidebarHtml || null,
    rightSidebarHtml: cachedSnapshot.rightSidebarHtml || null,
    isNewSessionPage: cachedSnapshot.isNewSessionPage || false,
    dropdownHtml: cachedSnapshot.dropdownHtml || null,
    dialogHtml: cachedSnapshot.dialogHtml || null,
    activeArtifactUri: cachedSnapshot.activeArtifactUri || null,
    activeFileUri: cachedSnapshot.activeFileUri || null,
    permissionHtml: cachedSnapshot.permissionHtml || null,
  });
});

// --- Click Proxy (forward clicks to real AG DOM) ---
// Click IDs are prefixed: chat:N, left:N, right:N
app.post('/click', async (req, res) => {
  const { clickId, label } = req.body;
  log('Click', `Proxying click id=${clickId} label="${label}"`);

  if (!clickId && clickId !== 0) {
    return res.status(400).json({ error: 'clickId is required' });
  }

  if (!cdpClient) {
    return res.status(503).json({ error: 'CDP not connected' });
  }

  try {
    const clickScript = `
    (async () => {
      const clickId = ${JSON.stringify(String(clickId))};
      const expectedLabel = ${JSON.stringify(label || '')};

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
        root = document.querySelector('[class*="bg-sidebar"]');
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
        // Portal dialog: body > div.fixed.inset-0
        for (const child of document.body.children) {
          const cls = child.className || '';
          if (cls.includes('fixed') && cls.includes('inset-0')) {
            root = child;
            break;
          }
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
      }

      if (!root) return { ok: false, reason: 'no_root_for_' + source };

      // Build the same interactive element list as capture
      const skipVis = (source === 'right' || source === 'left');
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
      root.querySelectorAll('[class*="cursor-pointer"]').forEach(el => {
        if ((skipVis || el.offsetParent !== null) && !visible.includes(el)) {
          if (maxLen && (el.textContent || '').trim().length > maxLen) return;
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

      // Track active right-sidebar tab before click
      const getActiveTab = () => {
        for (const t of document.querySelectorAll('[data-tab-id]')) {
          if ((t.className || '').includes('bg-secondary')) return t.getAttribute('data-tab-id');
        }
        return null;
      };
      const tabBefore = getActiveTab();

      target.click();

      // Detect if this click navigated to a file view.
      // Let AG handle all navigation natively — we just detect it happened.
      let navigatedToFile = false;
      if (source === 'chat') {
        // Wait for React state updates from target.click()
        await new Promise(r => setTimeout(r, 300));
        const tabAfter = getActiveTab();
        if (tabAfter && tabAfter !== tabBefore) {
          // AG switched tabs (e.g. "Edited file.js" buttons)
          navigatedToFile = true;
        } else {
          // Check if element looks file-related — AG may update Review panel content
          // without switching tabs (e.g. file rows in expanded dropdown, stat spans)
          const text = (target.textContent || '').trim();
          const dotIdx = text.indexOf('.');
          if (dotIdx > 0 && dotIdx < text.length - 1) {
            // Has "word.ext" pattern — likely a file reference
            const beforeDot = text.substring(0, dotIdx);
            if (beforeDot.length < 30 && !beforeDot.includes(' ')) {
              navigatedToFile = true;
            }
          }
          // Diff stat pattern: "+N-M" (e.g. "+18-27") — opens turn-scoped diff
          if (!navigatedToFile && text.charAt(0) === '+' && text.includes('-')) {
            var isDiffStat = true;
            for (var ci = 0; ci < text.length; ci++) {
              var ch = text.charAt(ci);
              if (ch !== '+' && ch !== '-' && (ch < '0' || ch > '9')) { isDiffStat = false; break; }
            }
            if (isDiffStat) navigatedToFile = true;
          }
        }
      }

      return { ok: true, label: actualLabel, source, navigatedToFile, debugNearby };
    })()
    `;

    const result = await evaluateInBrowser(clickScript);
    log('Click', `Result: ${JSON.stringify(result)}`);
    res.json(result || { ok: false, reason: 'null_result' });
  } catch (e) {
    log('Click', `Error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// --- Temp eval for debugging ---
app.post('/eval', async (req, res) => {
  try {
    const result = await evaluateInBrowser(`${req.body.script}`);
    res.json({ result });
  } catch (e) { res.json({ error: e.message }); }
});

// --- Send Message ---
let lastSentMessage = { text: '', time: 0 };

app.post('/send', async (req, res) => {
  const { message } = req.body;
  log('Send', `Received: "${message?.substring(0, 50)}"`);

  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'Message is required' });
  }

  if (!cdpClient) {
    return res.status(503).json({ error: 'CDP not connected' });
  }

  // Server-side dedup — reject identical message within 2 seconds
  const now = Date.now();
  if (message === lastSentMessage.text && now - lastSentMessage.time < 2000) {
    log('Send', 'Duplicate suppressed (same text within 2s)');
    return res.json({ ok: true, method: 'dedup' });
  }
  lastSentMessage = { text: message, time: now };

  try {
    log('Send', 'Injecting via CDP...');
    const result = await injectMessage(message);
    log('Send', `Injection result: ${JSON.stringify(result)}`);
    res.json(result || { ok: true });
  } catch (e) {
    log('Send', `Injection error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// --- Stop Generation ---
app.post('/stop', async (req, res) => {
  if (!cdpClient) {
    return res.status(503).json({ error: 'CDP not connected' });
  }

  try {
    const result = await stopGeneration();
    res.json(result || { ok: false });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Sidebar Discovery (temporary diagnostic) ---
const DISCOVER_SCRIPT = `
(async () => {
  const results = {
    // Search for elements containing sidebar-related text
    textMatches: [],
    // Search for aside elements
    asides: [],
    // Search for panel/sidebar class/id patterns
    panels: [],
    // Search for tab-like structures
    tabs: [],
    // Search for elements near the right edge of the viewport
    rightEdgeElements: [],
    // The chat container we already know about
    chatContainer: null,
    // All top-level structural elements
    topLevel: [],
  };

  // 1. Find elements with sidebar-related text
  const textTargets = ['Overview', 'Review', 'Review Changes', 'No changes to review'];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const text = walker.currentNode.textContent.trim();
    for (const target of textTargets) {
      if (text === target || text.includes(target)) {
        const el = walker.currentNode.parentElement;
        if (el) {
          results.textMatches.push({
            text: target,
            tag: el.tagName,
            id: el.id || null,
            className: el.className?.toString?.()?.substring(0, 200) || null,
            role: el.getAttribute('role'),
            parentTag: el.parentElement?.tagName,
            parentId: el.parentElement?.id || null,
            parentClass: el.parentElement?.className?.toString?.()?.substring(0, 200) || null,
            // Walk up 5 levels to find structural ancestor
            ancestors: (() => {
              const anc = [];
              let p = el;
              for (let i = 0; i < 5 && p; i++) {
                anc.push({
                  tag: p.tagName,
                  id: p.id || null,
                  class: p.className?.toString?.()?.substring(0, 100) || null,
                  role: p.getAttribute?.('role') || null,
                  'data-testid': p.getAttribute?.('data-testid') || null,
                });
                p = p.parentElement;
              }
              return anc;
            })(),
          });
        }
      }
    }
  }

  // 2. Find aside elements
  document.querySelectorAll('aside').forEach(el => {
    results.asides.push({
      id: el.id || null,
      className: el.className?.toString?.()?.substring(0, 200) || null,
      role: el.getAttribute('role'),
      childCount: el.children.length,
      textPreview: el.textContent?.substring(0, 100)?.trim(),
      rect: el.getBoundingClientRect(),
    });
  });

  // 3. Find panel/sidebar patterns
  const panelSelectors = [
    '[class*="sidebar" i]', '[class*="panel" i]', '[class*="drawer" i]',
    '[class*="aside" i]', '[class*="review" i]', '[class*="overview" i]',
    '[id*="sidebar" i]', '[id*="panel" i]', '[id*="drawer" i]',
    '[id*="review" i]', '[id*="overview" i]',
    '[data-testid*="sidebar" i]', '[data-testid*="panel" i]',
    '[data-testid*="review" i]', '[data-testid*="overview" i]',
    '[role="complementary"]', '[role="tabpanel"]',
  ];
  for (const sel of panelSelectors) {
    try {
      document.querySelectorAll(sel).forEach(el => {
        results.panels.push({
          selector: sel,
          tag: el.tagName,
          id: el.id || null,
          className: el.className?.toString?.()?.substring(0, 200) || null,
          role: el.getAttribute('role'),
          'data-testid': el.getAttribute('data-testid'),
          childCount: el.children.length,
          textPreview: el.textContent?.substring(0, 100)?.trim(),
          rect: el.getBoundingClientRect(),
          visible: el.offsetParent !== null,
        });
      });
    } catch {}
  }

  // 4. Find tab structures
  document.querySelectorAll('[role="tab"], [role="tablist"], [role="tabpanel"]').forEach(el => {
    results.tabs.push({
      tag: el.tagName,
      role: el.getAttribute('role'),
      id: el.id || null,
      className: el.className?.toString?.()?.substring(0, 200) || null,
      'aria-selected': el.getAttribute('aria-selected'),
      'aria-controls': el.getAttribute('aria-controls'),
      textContent: el.textContent?.substring(0, 50)?.trim(),
      rect: el.getBoundingClientRect(),
    });
  });

  // 5. Find elements positioned on the right side of the viewport
  const vw = window.innerWidth;
  document.querySelectorAll('div, section, aside, nav').forEach(el => {
    const rect = el.getBoundingClientRect();
    if (rect.left > vw * 0.5 && rect.width > 100 && rect.height > 200) {
      results.rightEdgeElements.push({
        tag: el.tagName,
        id: el.id || null,
        className: el.className?.toString?.()?.substring(0, 150) || null,
        role: el.getAttribute('role'),
        'data-testid': el.getAttribute('data-testid'),
        rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
        childCount: el.children.length,
        textPreview: el.textContent?.substring(0, 80)?.trim(),
      });
    }
  });

  // 6. Chat container (for reference)
  const container =
    document.querySelector('.scrollbar-hide[class*="overflow-y-auto"]') ||
    document.querySelector('[data-testid="conversation-view"]') ||
    document.getElementById('conversation');
  if (container) {
    results.chatContainer = {
      tag: container.tagName,
      id: container.id || null,
      className: container.className?.toString?.()?.substring(0, 200) || null,
      rect: container.getBoundingClientRect(),
      // Sibling info — sidebar is likely a sibling
      siblings: Array.from(container.parentElement?.children || []).map(s => ({
        tag: s.tagName,
        id: s.id || null,
        className: s.className?.toString?.()?.substring(0, 100) || null,
        role: s.getAttribute('role'),
        rect: s.getBoundingClientRect(),
      })),
    };
  }

  // 7. Top-level children of body
  Array.from(document.body.children).forEach(el => {
    results.topLevel.push({
      tag: el.tagName,
      id: el.id || null,
      className: el.className?.toString?.()?.substring(0, 150) || null,
      childCount: el.children.length,
      rect: el.getBoundingClientRect(),
    });
  });

  return results;
})()
`;

app.get('/discover', async (req, res) => {
  if (!cdpClient) {
    return res.status(503).json({ error: 'CDP not connected' });
  }

  try {
    const result = await evaluateInBrowser(DISCOVER_SCRIPT);
    log('Discovery', JSON.stringify(result, null, 2));
    res.json(result);
  } catch (e) {
    log('Discovery', `Error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// --- Health ---
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    cdpConnected: !!cdpClient,
    snapshotAvailable: !!cachedSnapshot,
    wsClients: wsClients.size,
  });
});

// ─────────────────────────────────────────────
// Server Startup
// ─────────────────────────────────────────────

async function start() {
  // Generate/load SSL certs
  const sslOpts = ensureCerts();

  // Create HTTPS server
  const server = createHttpsServer(sslOpts, app);

  // WebSocket server on the same HTTPS server
  const wss = new WebSocketServer({ server });

  wss.on('connection', (ws, req) => {
    // Authenticate WebSocket connections
    if (!isLocalWsRequest(req)) {
      const cookies = parseCookiesFromHeader(req.headers.cookie || '');
      const signed = cookieParser.signedCookie(cookies.ag2r_token || '', SESSION_SECRET);
      if (signed !== authToken()) {
        ws.send(JSON.stringify({ type: 'error', message: 'Unauthorized' }));
        setTimeout(() => ws.close(), 100);
        return;
      }
    }

    wsClients.add(ws);
    log('WS', `Client connected (${wsClients.size} total)`);

    // Send current state immediately
    ws.send(JSON.stringify({
      type: 'connection',
      cdpConnected: !!cdpClient,
    }));

    if (cachedSnapshot) {
      ws.send(JSON.stringify({
        type: 'snapshot',
        hash: cachedSnapshot.hash,
        agentRunning: cachedSnapshot.agentRunning,
        timestamp: new Date().toISOString(),
      }));
    }

    ws.on('close', () => {
      wsClients.delete(ws);
      log('WS', `Client disconnected (${wsClients.size} total)`);
    });

    ws.on('error', () => {
      wsClients.delete(ws);
    });
  });

  // Start listening
  server.listen(PORT, () => {
    log('Server', `AG2R running on https://localhost:${PORT}`);
    if (TUNNEL_ENABLED && TUNNEL_URL) {
      log('Server', `Tunnel URL: ${TUNNEL_URL}`);
    }
  });

  // Connect to CDP
  try {
    await connectCDP();
  } catch (e) {
    log('CDP', `Initial connection failed: ${e.message}`);
    log('CDP', 'Will retry every 3 seconds...');
    scheduleReconnect();
  }

  // Start polling
  startPolling();

  // Graceful shutdown
  const shutdown = () => {
    log('Server', 'Shutting down...');
    stopPolling();
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (cdpClient) cdpClient.close();
    for (const ws of wsClients) ws.close();
    wss.close();
    server.close(() => process.exit(0));
    // Force exit after 3s
    setTimeout(() => process.exit(1), 3000);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// ─────────────────────────────────────────────
// WebSocket Auth Helpers
// ─────────────────────────────────────────────

function isLocalWsRequest(req) {
  if (req.headers['x-forwarded-for'] || req.headers['cf-connecting-ip']) {
    return false;
  }
  const ip = req.socket?.remoteAddress || '';
  return /^(127\.|::1|::ffff:127\.|localhost|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
}

function parseCookiesFromHeader(header) {
  const cookies = {};
  header.split(';').forEach(pair => {
    const [name, ...rest] = pair.trim().split('=');
    if (name) cookies[name.trim()] = decodeURIComponent(rest.join('='));
  });
  return cookies;
}

// ─────────────────────────────────────────────
// Go
// ─────────────────────────────────────────────

start().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
