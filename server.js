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
import multer from 'multer';
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
const AUTH_ENABLED = process.env.AUTH_ENABLED === 'true';
const TUNNEL_ENABLED = process.env.TUNNEL_ENABLED === 'true';
const TUNNEL_URL = process.env.TUNNEL_URL || '';
const MAX_UPLOAD_SIZE = 10 * 1024 * 1024; // 10MB

// === Multer (file upload) ===
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_SIZE },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files are allowed'));
  },
});

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

// Like evaluateInBrowser but returns the first NON-NULL result across all contexts.
// Used for captures that may only be visible in one of AG's execution contexts.
async function evaluateAcrossContexts(expression, opts = {}) {
  if (!cdpClient) throw new Error('CDP not connected');

  for (const ctx of cdpContexts) {
    try {
      const result = await cdpClient.Runtime.evaluate({
        expression,
        contextId: ctx.id,
        awaitPromise: true,
        returnByValue: true,
        ...opts,
      });

      if (result.exceptionDetails) continue;

      const val = result.result?.value ?? null;
      if (val !== null) return val;
    } catch {
      continue;
    }
  }

  return null;
}

// ─────────────────────────────────────────────
// Snapshot Capture
// ─────────────────────────────────────────────

// The capture script runs IN the Antigravity browser context.
// Captures: chat container (with cleanup) + left sidebar (raw clone)
// Tags interactive elements across chat and left sidebar for click proxying
// Click IDs are prefixed: chat:N, left:N
// Right sidebar is captured ON-DEMAND via GET /right-sidebar (not here)
// Only a lightweight sidebarSignature is extracted here for change detection
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
    // Exception: elements with a direct onclick handler are definitively interactive
    // (e.g. AG artifact cards), so they bypass the text-length filter.
    if (includeCursorPointer) {
      root.querySelectorAll('[class*="cursor-pointer"]').forEach(el => {
        if ((skipVisibilityCheck || el.offsetParent !== null) && !el.hasAttribute('data-ag-click-id')) {
          const text = (el.textContent || '').trim();
          const hasHandler = typeof el.onclick === 'function';
          if (maxTextLength && text.length > maxTextLength && !hasHandler) return;
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

      // Popover dialog (role="dialog" portal, e.g. environment selector, context menus)
      if (!dialogHtml && child.getAttribute('role') === 'dialog') {
        const tagged = tagInteractives(child, 'dialog', true, false);
        const clone = child.cloneNode(true);
        untagAll(tagged);
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

  return { html, css, agentRunning, scrollInfo, leftSidebarHtml, sidebarSignature, isNewSessionPage, dropdownHtml, dialogHtml, settingsHtml, activeArtifactUri, activeFileUri, permissionHtml, environmentName, branchName, modelName };
})()
`;

// Separate script for running tasks — must run outside the main capture's context lock
// because AG's two execution contexts may render the task section in only one context.
const RUNNING_TASKS_SCRIPT = `
(() => {
  const inputBox = document.getElementById('antigravity.agentSidePanelInputBox');
  if (!inputBox) return null;
  const taskSection = inputBox.querySelector('.rounded-t-2xl');
  if (!taskSection || taskSection.getBoundingClientRect().height <= 0) return null;
  let taskIdx = 0;
  const taskTagged = [];
  taskSection.querySelectorAll('button').forEach(btn => {
    btn.setAttribute('data-ag-click-id', 'task:' + taskIdx);
    btn.setAttribute('data-ag-click-label', (btn.textContent || '').trim().substring(0, 80));
    taskIdx++;
    taskTagged.push(btn);
  });
  const taskClone = taskSection.cloneNode(true);
  taskTagged.forEach(el => {
    el.removeAttribute('data-ag-click-id');
    el.removeAttribute('data-ag-click-label');
  });
  return taskClone.outerHTML;
})()
`;

// Separate script for Scheduled Tasks page — must run via evaluateAcrossContexts
// because AG renders the scheduled tasks view in the isolated execution context.
// Detects the page via the unique "Add scheduled task" button.
// Returns just the page HTML string (dialog is captured separately — different context).
const SCHEDULED_TASKS_SCRIPT = `
(() => {
  const newBtn = document.querySelector('[aria-label="Add scheduled task"]');
  if (!newBtn) return null;

  // Walk up from the New button to find the content panel (stops before sidebar)
  let container = newBtn;
  for (let i = 0; i < 15; i++) {
    if (!container.parentElement) break;
    const p = container.parentElement;
    if (p.getBoundingClientRect().x < 10) break;
    container = p;
  }

  // Find the inner panel that has the scheduled tasks content
  const inner = container.querySelector('.flex-1.flex.flex-col.min-w-0.h-full') || container;

  // Tag interactive elements on the page
  let idx = 0;
  const tagged = [];
  inner.querySelectorAll('button, a, [role="button"], input, select, textarea').forEach(el => {
    el.setAttribute('data-ag-click-id', 'sched:' + idx);
    el.setAttribute('data-ag-click-label', (el.textContent || el.getAttribute('placeholder') || '').trim().substring(0, 50));
    idx++;
    tagged.push(el);
  });
  const pageClone = inner.cloneNode(true);
  tagged.forEach(el => {
    el.removeAttribute('data-ag-click-id');
    el.removeAttribute('data-ag-click-label');
  });

  return pageClone.outerHTML;
})()
`;

// Separate script for the Scheduled Tasks dialog (New Scheduled Task form, etc.)
// This is a DIFFERENT execution context from the page, so it must run independently.
// Detects the z-[2550] overlay that AG uses for modal dialogs.
const SCHEDULED_TASKS_DIALOG_SCRIPT = `
(() => {
  const overlay = document.querySelector('.fixed.inset-0[class*="z-[2550]"]');
  if (!overlay || overlay.getBoundingClientRect().width <= 0) return null;
  // Only capture if this looks like a scheduled task dialog (not settings)
  const text = overlay.textContent || '';
  if (!text.includes('Scheduled Task') && !text.includes('task name')) return null;

  let idx = 0;
  const tagged = [];
  // Tag standard interactive elements
  overlay.querySelectorAll('button, a, [role="button"], input, select, textarea, [role="combobox"], [role="switch"]').forEach(el => {
    el.setAttribute('data-ag-click-id', 'scheddlg:' + idx);
    el.setAttribute('data-ag-click-label', (el.textContent || el.getAttribute('placeholder') || '').trim().substring(0, 50));
    idx++;
    tagged.push(el);
  });
  // Also tag cursor-pointer divs (Schedule dropdowns) — these have onclick but no role
  overlay.querySelectorAll('div.cursor-pointer[aria-expanded]').forEach(el => {
    if (el.getAttribute('data-ag-click-id')) return; // Already tagged
    el.setAttribute('data-ag-click-id', 'scheddlg:' + idx);
    el.setAttribute('data-ag-click-label', (el.textContent || '').trim().substring(0, 50));
    idx++;
    tagged.push(el);
  });
  // Sync live input/textarea values into attributes before cloning
  // (cloneNode copies HTML attributes but not live .value properties)
  const valuedEls = [];
  overlay.querySelectorAll('input, textarea').forEach(el => {
    const liveVal = el.value || '';
    if (el.tagName === 'TEXTAREA') {
      el.setAttribute('data-ag-value', liveVal);
    } else {
      el.setAttribute('data-ag-value', liveVal);
    }
    valuedEls.push(el);
  });
  // Clone only the inner card (skip the outer overlay wrapper with fixed/inset/z-index)
  const card = overlay.querySelector('[class*="shadow-xl"]') || overlay.firstElementChild || overlay;
  const clone = card.cloneNode(true);
  tagged.forEach(el => {
    el.removeAttribute('data-ag-click-id');
    el.removeAttribute('data-ag-click-label');
  });
  valuedEls.forEach(el => el.removeAttribute('data-ag-value'));
  return clone.outerHTML;
})()
`;

// Separate script for right sidebar — runs ON-DEMAND only (not every poll).
// Reuses the same sidebar-finding strategies from the original capture.
// Returns outerHTML with click-proxy tags for interactive elements.
const RIGHT_SIDEBAR_SCRIPT = `
(() => {
  // -- Helper: tag interactive elements for click proxying --
  function tagInteractives(root, prefix, skipVisibilityCheck, includeCursorPointer, maxTextLength) {
    let idx = 0;
    const tagged = [];
    root.querySelectorAll('button, a, [role="button"]').forEach(el => {
      if (skipVisibilityCheck || el.offsetParent !== null) {
        const text = (el.textContent || '').trim();
        el.setAttribute('data-ag-click-id', prefix + ':' + idx);
        el.setAttribute('data-ag-click-label', text.substring(0, 50));
        idx++;
        tagged.push(el);
      }
    });
    if (includeCursorPointer) {
      root.querySelectorAll('[class*="cursor-pointer"]').forEach(el => {
        if ((skipVisibilityCheck || el.offsetParent !== null) && !el.hasAttribute('data-ag-click-id')) {
          const text = (el.textContent || '').trim();
          const hasHandler = typeof el.onclick === 'function';
          if (maxTextLength && text.length > maxTextLength && !hasHandler) return;
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

  let sidebarRoot = null;

  // Strategy 1: Find via tab-id buttons
  const tabBtn = document.querySelector('[data-tab-id="overview"], [data-tab-id="review"]');
  if (tabBtn) {
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

  if (!sidebarRoot) return null;

  const rightTagged = tagInteractives(sidebarRoot, 'right', true, true);
  const rightClone = sidebarRoot.cloneNode(true);
  untagAll(rightTagged);
  return rightClone.outerHTML;
})()
`;


async function captureSnapshot() {
  try {
    let result = await evaluateInBrowser(CAPTURE_SCRIPT);
    // When CAPTURE_SCRIPT returns null (e.g. Scheduled Tasks page has no chat container),
    // create a minimal result so cross-context captures (running tasks, scheduled tasks) still run.
    if (!result) {
      result = { html: '', css: '', agentRunning: false, scrollInfo: null };
    }

    // Running tasks: separate eval that tries all contexts (first non-null wins)
    // because the task section may only be visible in a context different from
    // the one the main capture script locked to.
    try {
      result.runningTasksHtml = await evaluateAcrossContexts(RUNNING_TASKS_SCRIPT);
    } catch (e) {
      console.debug('[Snapshot] Running tasks eval failed:', e.message);
    }

    // Scheduled Tasks page: in the isolated context, returns HTML string
    try {
      result.scheduledTasksHtml = await evaluateAcrossContexts(SCHEDULED_TASKS_SCRIPT);
    } catch (e) {
      console.debug('[Snapshot] Scheduled tasks eval failed:', e.message);
    }

    // Scheduled Tasks dialog (New Scheduled Task form): may be in a DIFFERENT
    // context than the page, so we run a separate capture independently.
    // Only runs when the page is detected (to avoid false positives from settings dialog).
    if (result.scheduledTasksHtml) {
      try {
        result.scheduledTasksDialogHtml = await evaluateAcrossContexts(SCHEDULED_TASKS_DIALOG_SCRIPT);
      } catch (e) {
        console.debug('[Snapshot] Scheduled tasks dialog eval failed:', e.message);
      }

      // Also capture body-level dropdowns (Schedule selectors open listboxes as React portals)
      // These are in the preferred context, not the isolated one.
      if (!result.dropdownHtml) {
        try {
          result.dropdownHtml = await evaluateInBrowser(`
            (() => {
              for (const child of document.body.children) {
                if (child.getAttribute('role') === 'listbox' && child.getBoundingClientRect().width > 0) {
                  let idx = 0;
                  const tagged = [];
                  child.querySelectorAll('[role="option"], button, a').forEach(el => {
                    el.setAttribute('data-ag-click-id', 'scheddlg:' + (100 + idx));
                    el.setAttribute('data-ag-click-label', el.textContent.trim().substring(0, 50));
                    idx++;
                    tagged.push(el);
                  });
                  const clone = child.cloneNode(true);
                  tagged.forEach(el => {
                    el.removeAttribute('data-ag-click-id');
                    el.removeAttribute('data-ag-click-label');
                  });
                  return clone.outerHTML;
                }
              }
              return null;
            })()
          `);
        } catch (e) {
          console.debug('[Snapshot] Scheduled tasks dropdown eval failed:', e.message);
        }
      }
    }

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
          (snapshot.sidebarSignature || '') +
          (snapshot.dropdownHtml || '') +
          (snapshot.dialogHtml || '') +
          (snapshot.settingsHtml || '') +
          (snapshot.permissionHtml || '') +
          (snapshot.runningTasksHtml || '') +
          (snapshot.scheduledTasksHtml || '') +
          (snapshot.scheduledTasksDialogHtml || '')
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
  // Auth disabled — skip entirely (feature branch testing)
  if (!AUTH_ENABLED) return next();

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
    sidebarSignature: cachedSnapshot.sidebarSignature || null,
    isNewSessionPage: cachedSnapshot.isNewSessionPage || false,
    dropdownHtml: cachedSnapshot.dropdownHtml || null,
    dialogHtml: cachedSnapshot.dialogHtml || null,
    settingsHtml: cachedSnapshot.settingsHtml || null,
    activeArtifactUri: cachedSnapshot.activeArtifactUri || null,
    activeFileUri: cachedSnapshot.activeFileUri || null,
    permissionHtml: cachedSnapshot.permissionHtml || null,
    environmentName: cachedSnapshot.environmentName || null,
    branchName: cachedSnapshot.branchName || null,
    modelName: cachedSnapshot.modelName || null,
    runningTasksHtml: cachedSnapshot.runningTasksHtml || null,
    scheduledTasksHtml: cachedSnapshot.scheduledTasksHtml || null,
    scheduledTasksDialogHtml: cachedSnapshot.scheduledTasksDialogHtml || null,
  });
});

// --- Right Sidebar Endpoint (on-demand) ---
app.get('/right-sidebar', async (req, res) => {
  try {
    const html = await evaluateInBrowser(RIGHT_SIDEBAR_SCRIPT);
    res.json({ html: html || null });
  } catch (e) {
    console.debug('[RightSidebar] Error:', e.message);
    res.json({ html: null, error: e.message });
  }
});

// --- Image Proxy Endpoint (on-demand, for right sidebar images) ---
// Proxies images that use blob:/file:/vscode-file: URLs (unresolvable from remote client).
// Finds the <img> in AG's DOM, draws to canvas, returns base64 data URL.
app.get('/proxy-image', async (req, res) => {
  const src = req.query.src;
  if (!src) return res.status(400).json({ error: 'Missing src parameter' });

  try {
    const script = `
    (() => {
      const targetSrc = ${JSON.stringify(src)};
      const imgs = document.querySelectorAll('img');
      for (const img of imgs) {
        if (img.src !== targetSrc && img.getAttribute('src') !== targetSrc) continue;
        if (!img.complete || img.naturalWidth === 0) continue;

        try {
          const MAX_WIDTH = 800;
          let w = img.naturalWidth;
          let h = img.naturalHeight;
          if (w > MAX_WIDTH) {
            h = Math.round(h * (MAX_WIDTH / w));
            w = MAX_WIDTH;
          }
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, w, h);
          return canvas.toDataURL('image/png');
        } catch (e) {
          // CORS / tainted canvas
          return null;
        }
      }
      return null;
    })()
    `;

    const dataUrl = await evaluateInBrowser(script);
    res.json({ dataUrl: dataUrl || null });
  } catch (e) {
    console.debug('[ProxyImage] Error:', e.message);
    res.json({ dataUrl: null, error: e.message });
  }
});

// --- Expand Left Sidebar (click AG's toggle when sidebar is collapsed) ---
app.post('/expand-left-sidebar', async (req, res) => {
  if (!cdpClient) {
    return res.status(503).json({ error: 'CDP not connected' });
  }
  try {
    const result = await evaluateInBrowser(`
      (async () => {
        const leftRoot = document.querySelector('[class*="bg-sidebar"]');
        const isCollapsed = !leftRoot || leftRoot.offsetParent === null;
        if (!isCollapsed) return { ok: true, wasCollapsed: false };
        // Click the sidebar toggle button to expand
        const toggleBtn = document.querySelector('[data-testid="sidebar-toggle"]');
        if (!toggleBtn) return { ok: false, error: 'Toggle button not found' };
        toggleBtn.click();
        return { ok: true, wasCollapsed: true };
      })()
    `);
    log('ExpandLeftSidebar', JSON.stringify(result));
    res.json(result || { ok: false });
  } catch (e) {
    console.debug('[ExpandLeftSidebar] Error:', e.message);
    res.json({ ok: false, error: e.message });
  }
});

// --- Copy Response (intercept AG's clipboard.writeText, return markdown) ---
app.post('/copy-response', async (req, res) => {
  const { clickId } = req.body || {};
  if (!clickId || !cdpClient) {
    return res.status(400).json({ error: 'Missing clickId or CDP not connected' });
  }
  try {
    // Use the exact same element lookup as /click handler to avoid index mismatch
    const script = `
    (async () => {
      const clickId = ${JSON.stringify(String(clickId))};
      const colonIdx = clickId.indexOf(':');
      if (colonIdx === -1) return { ok: false, reason: 'invalid_click_id' };
      const source = clickId.substring(0, colonIdx);
      const idx = parseInt(clickId.substring(colonIdx + 1), 10);

      // Find root — same logic as /click
      let root = null;
      if (source === 'chat') {
        root =
          document.querySelector('.scrollbar-hide[class*="overflow-y-auto"]') ||
          document.querySelector('[data-testid="conversation-view"]') ||
          document.getElementById('conversation') ||
          document.getElementById('chat') ||
          document.getElementById('cascade');
      }
      if (!root) return { ok: false, reason: 'no_root' };

      // Build same element list as /click
      const maxLen = (source === 'chat') ? 80 : 0;
      const visible = [];
      root.querySelectorAll('button, a, [role="button"]').forEach(el => {
        if (el.offsetParent !== null) visible.push(el);
      });
      root.querySelectorAll('[class*="cursor-pointer"]').forEach(el => {
        if (el.offsetParent !== null && !visible.includes(el)) {
          const hasHandler = typeof el.onclick === 'function';
          if (maxLen && (el.textContent || '').trim().length > maxLen && !hasHandler) return;
          visible.push(el);
        }
      });

      const target = visible[idx];
      if (!target) return { ok: false, reason: 'element_not_found', idx, total: visible.length };

      // Intercept clipboard.writeText to capture markdown
      let captured = null;
      const orig = navigator.clipboard.writeText.bind(navigator.clipboard);
      navigator.clipboard.writeText = (text) => {
        captured = text;
        return orig(text);
      };
      try {
        target.click();
        await new Promise(r => setTimeout(r, 300));
      } finally {
        navigator.clipboard.writeText = orig;
      }
      return { ok: true, text: captured || '' };
    })()
    `;
    const result = await evaluateInBrowser(script);
    log('CopyResponse', `clickId=${clickId} text=${(result?.text || '').length} chars`);
    res.json(result || { ok: false });
  } catch (e) {
    log('CopyResponse', `Error: ${e.message}`);
    res.json({ ok: false, error: e.message });
  }
});

// --- Dismiss Portal (close dropdowns/dialogs in AG via Escape key) ---
app.post('/dismiss-portal', async (req, res) => {
  try {
    await evaluateInBrowser(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }))`);
    res.json({ ok: true });
  } catch (e) {
    console.debug('[DismissPortal] Error:', e.message);
    res.json({ ok: false, error: e.message });
  }
});

// --- Dismiss Scheduled Tasks (navigate back to conversation) ---
app.post('/dismiss-scheduled-tasks', async (req, res) => {
  if (!cdpClient) return res.status(503).json({ error: 'CDP not connected' });
  try {
    // Click the active conversation in the sidebar to navigate back,
    // or click the back button. Simplest: use browser history back.
    const result = await evaluateAcrossContexts(`
    (() => {
      // Find a conversation row to click in the sidebar
      const sidebar = document.querySelector('[class*="bg-sidebar"]');
      if (sidebar) {
        // Click the first conversation row (min-h-[32px] identifies them)
        const row = sidebar.querySelector('[class*="min-h-[32px]"]');
        if (row) {
          row.click();
          return { ok: true, method: 'sidebar-row' };
        }
      }
      // Fallback: use history back
      window.history.back();
      return { ok: true, method: 'history-back' };
    })()
    `);
    log('DismissScheduledTasks', JSON.stringify(result));
    res.json(result || { ok: true });
  } catch (e) {
    console.debug('[DismissScheduledTasks] Error:', e.message);
    res.json({ ok: false, error: e.message });
  }
});

// --- Dismiss Settings (click AG's Go Back button) ---
app.post('/dismiss-settings', async (req, res) => {
  if (!cdpClient) {
    return res.status(503).json({ error: 'CDP not connected' });
  }
  try {
    const result = await evaluateInBrowser(`
      (async () => {
        // Click the backdrop overlay behind the settings card to close entirely.
        // Don't use 'Go Back' — it navigates through tab history instead of closing.
        const overlay = document.querySelector('.fixed.inset-0[class*="z-[2550]"]');
        if (overlay) {
          // The backdrop is the overlay itself; clicking outside the card closes settings.
          // Dispatch click at the overlay edges (not on the card).
          const rect = overlay.getBoundingClientRect();
          overlay.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 5, clientY: 5 }));
          return { ok: true, method: 'backdrop' };
        }
        // Fallback: press Escape
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        return { ok: true, method: 'escape' };
      })()
    `);
    log('DismissSettings', JSON.stringify(result));
    res.json(result || { ok: false });
  } catch (e) {
    console.debug('[DismissSettings] Error:', e.message);
    res.json({ ok: false, error: e.message });
  }
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
    // Task clicks need evaluateAcrossContexts (task section may be in a different context)
    if (String(clickId).startsWith('task:')) {
      const taskIdx = parseInt(String(clickId).split(':')[1], 10);
      const taskClickScript = `
      (() => {
        const inputBox = document.getElementById('antigravity.agentSidePanelInputBox');
        if (!inputBox) return { ok: false, reason: 'no_input_box' };
        const taskSection = inputBox.querySelector('.rounded-t-2xl');
        if (!taskSection) return { ok: false, reason: 'no_task_section' };
        const btns = taskSection.querySelectorAll('button');
        const idx = ${taskIdx};
        if (idx < 0 || idx >= btns.length) return { ok: false, reason: 'task_index_out_of_range', total: btns.length };
        const target = btns[idx];
        const actualLabel = (target.textContent || '').trim().substring(0, 80);
        target.click();
        return { ok: true, label: actualLabel, source: 'task' };
      })()
      `;
      const result = await evaluateAcrossContexts(taskClickScript);
      log('Click', `Task result: ${JSON.stringify(result)}`);
      return res.json(result || { ok: false, reason: 'null_result' });
    }

    // Scheduled Tasks page clicks need evaluateAcrossContexts (isolated context)
    if (String(clickId).startsWith('sched:')) {
      const schedIdx = parseInt(String(clickId).split(':')[1], 10);
      const schedClickScript = `
      (() => {
        const newBtn = document.querySelector('[aria-label="Add scheduled task"]');
        if (!newBtn) return { ok: false, reason: 'no_scheduled_tasks_page' };
        // Walk up to find the content panel
        let container = newBtn;
        for (let i = 0; i < 15; i++) {
          if (!container.parentElement) break;
          const p = container.parentElement;
          if (p.getBoundingClientRect().x < 10) break;
          container = p;
        }
        const inner = container.querySelector('.flex-1.flex.flex-col.min-w-0.h-full') || container;
        const elements = inner.querySelectorAll('button, a, [role="button"], input, select, textarea');
        const idx = ${schedIdx};
        if (idx < 0 || idx >= elements.length) return { ok: false, reason: 'sched_index_out_of_range', total: elements.length };
        const target = elements[idx];
        const actualLabel = (target.textContent || target.getAttribute('placeholder') || '').trim().substring(0, 80);
        // For inputs/textareas, focus instead of click
        if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
          target.focus();
        } else {
          target.click();
        }
        return { ok: true, label: actualLabel, source: 'sched' };
      })()
      `;
      const result = await evaluateAcrossContexts(schedClickScript);
      log('Click', `Sched result: ${JSON.stringify(result)}`);
      return res.json(result || { ok: false, reason: 'null_result' });
    }

    // Scheduled Tasks dialog clicks (New Scheduled Task form) — different context from page
    if (String(clickId).startsWith('scheddlg:')) {
      const dlgIdx = parseInt(String(clickId).split(':')[1], 10);

      // scheddlg:100+ → body-level listbox options (Schedule dropdown, in preferred context)
      if (dlgIdx >= 100) {
        const optIdx = dlgIdx - 100;
        const listboxClickScript = `
        (() => {
          for (const child of document.body.children) {
            if (child.getAttribute('role') === 'listbox' && child.getBoundingClientRect().width > 0) {
              const options = child.querySelectorAll('[role="option"], button, a');
              const idx = ${optIdx};
              if (idx < 0 || idx >= options.length) return { ok: false, reason: 'option_index_out_of_range', total: options.length };
              const target = options[idx];
              target.click();
              return { ok: true, label: target.textContent.trim().substring(0, 50), source: 'scheddlg_listbox' };
            }
          }
          return { ok: false, reason: 'no_listbox' };
        })()
        `;
        const result = await evaluateInBrowser(listboxClickScript);
        log('Click', `SchedDlgListbox result: ${JSON.stringify(result)}`);
        return res.json(result || { ok: false, reason: 'null_result' });
      }

      // scheddlg:0-99 → elements inside the z-[2550] dialog overlay
      const safeLabel = JSON.stringify(label || '');
      const dlgClickScript = `
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
      const result = await evaluateAcrossContexts(dlgClickScript);
      log('Click', `SchedDlg result: ${JSON.stringify(result)}`);
      return res.json(result || { ok: false, reason: 'null_result' });
    }

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

    // After portal-opening clicks, schedule rapid re-captures to catch the
    // dialog/dropdown DOM appearing (React render takes 50-200ms)
    if (result?.ok) {
      const source = result.source || '';
      if (['env', 'model', 'project', 'dropdown', 'dialog', 'left'].includes(source)) {
        const burstCapture = async (delay) => {
          await new Promise(r => setTimeout(r, delay));
          try {
            const snapshot = await captureSnapshot();
            if (snapshot) {
              const hash = hashString(
                snapshot.html +
                (snapshot.leftSidebarHtml || '') +
                (snapshot.sidebarSignature || '') +
                (snapshot.dropdownHtml || '') +
                (snapshot.dialogHtml || '') +
                (snapshot.settingsHtml || '') +
                (snapshot.permissionHtml || '') +
                (snapshot.scheduledTasksHtml || '') +
                (snapshot.scheduledTasksDialogHtml || '')
              );
              if (hash !== lastSnapshotHash) {
                cachedSnapshot = snapshot;
                cachedSnapshot.hash = hash;
                lastSnapshotHash = hash;
                broadcast({ type: 'snapshot', hash, agentRunning: snapshot.agentRunning, timestamp: new Date().toISOString() });
              }
            }
          } catch (e) {
            console.debug('[BurstCapture] Error:', e.message);
          }
        };
        // Fire 3 rapid captures at 150ms, 400ms, 700ms
        burstCapture(150);
        burstCapture(400);
        burstCapture(700);
      }
    }
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

// --- Type Text into input/textarea (React-compatible) ---
// Targets element by placeholder text within the z-[2550] dialog overlay.
// Uses React's nativeInputValueSetter trick to trigger onChange handlers.
app.post('/type-text', async (req, res) => {
  const { placeholder, text } = req.body;
  if (!placeholder || text === undefined) {
    return res.status(400).json({ error: 'placeholder and text are required' });
  }
  if (!cdpClient) {
    return res.status(503).json({ error: 'CDP not connected' });
  }

  const safeText = JSON.stringify(text);
  const safePlaceholder = JSON.stringify(placeholder);
  const typeScript = `
  (() => {
    // Find the target input/textarea by placeholder within the dialog
    const overlay = document.querySelector('.fixed.inset-0[class*="z-[2550]"]');
    const scope = overlay || document;
    const el = scope.querySelector('input[placeholder=' + ${JSON.stringify(JSON.stringify(placeholder))} + '], textarea[placeholder=' + ${JSON.stringify(JSON.stringify(placeholder))} + ']');
    if (!el) return { ok: false, reason: 'element_not_found', placeholder: ${safePlaceholder} };

    // Focus the element
    el.focus();

    // Use React's native value setter to bypass synthetic events
    const nativeSetter = el.tagName === 'TEXTAREA'
      ? Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
      : Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;

    nativeSetter.call(el, ${safeText});

    // Dispatch input and change events to trigger React's onChange
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));

    return { ok: true, tag: el.tagName, placeholder: ${safePlaceholder}, valueLength: el.value.length };
  })()
  `;

  try {
    const result = await evaluateAcrossContexts(typeScript);
    log('TypeText', `Result: ${JSON.stringify(result)}`);
    res.json(result || { ok: false, reason: 'null_result' });
  } catch (e) {
    log('TypeText', `Error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});



// --- Upload Image ---
app.post('/upload', upload.single('image'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No image file provided' });
  }

  if (!cdpClient) {
    return res.status(503).json({ error: 'CDP not connected' });
  }

  const { buffer, mimetype, originalname } = req.file;
  const base64 = buffer.toString('base64');
  const fileName = originalname || 'photo.png';

  log('Upload', `Received ${fileName} (${mimetype}, ${(buffer.length / 1024).toFixed(1)}KB)`);

  try {
    const result = await evaluateInBrowser(`
    (async () => {
      // Decode base64 to binary
      const base64 = ${JSON.stringify(base64)};
      const mimetype = ${JSON.stringify(mimetype)};
      const fileName = ${JSON.stringify(fileName)};

      const binaryStr = atob(base64);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
      }

      const file = new File([bytes], fileName, { type: mimetype });

      // Find the drop target — the editor or the chat area
      const editorCandidates = document.querySelectorAll(
        '[data-lexical-editor="true"], [contenteditable="true"][role="textbox"], [contenteditable="true"]'
      );
      let editor = null;
      for (const el of editorCandidates) {
        if (el.offsetParent !== null) editor = el;
      }
      if (!editor) return { ok: false, reason: 'no_editor' };

      // Build DataTransfer with the file
      const dt = new DataTransfer();
      dt.items.add(file);

      // Dispatch full drag sequence — React needs dragenter/dragover before drop
      editor.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true }));
      editor.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
      editor.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));

      return { ok: true, method: 'drop', fileName, size: bytes.length };
    })()
    `);

    log('Upload', `Injection result: ${JSON.stringify(result)}`);

    if (!result?.ok) {
      return res.status(500).json({ error: result?.reason || 'Injection failed' });
    }

    res.json(result);
  } catch (e) {
    log('Upload', `Error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// Multer error handler (file too large, wrong type)
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: `File too large (max ${MAX_UPLOAD_SIZE / 1024 / 1024}MB)` });
    }
    return res.status(400).json({ error: err.message });
  }
  if (err.message === 'Only image files are allowed') {
    return res.status(400).json({ error: err.message });
  }
  next(err);
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
    if (AUTH_ENABLED) {
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
