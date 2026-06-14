// server.js — AG2R Server
// CDP connection, snapshot capture, WebSocket broadcasting, Express, auth
import express from 'express';
import { createServer as createHttpsServer } from 'https';
import { createServer as createHttpServer } from 'http';
import { WebSocketServer } from 'ws';
import CDP from 'chrome-remote-interface';
import fs from 'fs';
import { execSync, exec } from 'child_process';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import cookieParser from 'cookie-parser';
import compression from 'compression';
import selfsigned from 'selfsigned';
import multer from 'multer';
import dotenv from 'dotenv';
import webpush from 'web-push';
import { track, startSession, endSession } from './src/telemetry.js';
import { getConfigPath, ensureConfigDir, isDev, MAIN_PORT } from './src/paths.js';

// CDP scripts — browser-side JS evaluated via Runtime.evaluate
// See src/cdp-scripts/ for the actual script content
import { CAPTURE_SCRIPT } from './src/cdp-scripts/capture.js';
import { RIGHT_SIDEBAR_SCRIPT } from './src/cdp-scripts/right-sidebar.js';
import { RUNNING_TASKS_SCRIPT } from './src/cdp-scripts/running-tasks.js';
import { SCHEDULED_TASKS_SCRIPT } from './src/cdp-scripts/scheduled-tasks.js';
import { SCHEDULED_TASKS_DIALOG_SCRIPT } from './src/cdp-scripts/scheduled-tasks-dialog.js';
import { STOP_SCRIPT } from './src/cdp-scripts/stop.js';
import { DISCOVER_SCRIPT } from './src/cdp-scripts/discover.js';
import { buildInjectScript } from './src/cdp-scripts/inject-message.js';
import { CHECK_EDITOR_IMAGE_SCRIPT } from './src/cdp-scripts/check-editor-image.js';
import { buildCaptureListboxScript, buildCaptureKebabMenuScript } from './src/cdp-scripts/capture-dropdown.js';
import { buildTaskClickScript } from './src/cdp-scripts/click-task.js';
import { buildSchedClickScript } from './src/cdp-scripts/click-sched.js';
import { buildSchedPortalClickScript } from './src/cdp-scripts/click-sched-portal.js';
import { buildSchedDialogClickScript } from './src/cdp-scripts/click-sched-dialog.js';
import { buildMainClickScript } from './src/cdp-scripts/click-main.js';
import { buildTypeTextScript } from './src/cdp-scripts/type-text.js';
import { buildUploadImageScript } from './src/cdp-scripts/upload-image.js';
import { CLICK_SEND_BUTTON_SCRIPT } from './src/cdp-scripts/click-send-button.js';
import { EXPAND_LEFT_SIDEBAR_SCRIPT } from './src/cdp-scripts/expand-left-sidebar.js';
import { buildCopyResponseScript } from './src/cdp-scripts/copy-response.js';
import { DISMISS_SCHEDULED_TASKS_SCRIPT } from './src/cdp-scripts/dismiss-scheduled-tasks.js';
import { DISMISS_SETTINGS_SCRIPT } from './src/cdp-scripts/dismiss-settings.js';
import { OPEN_RIGHT_SIDEBAR_SCRIPT } from './src/cdp-scripts/open-right-sidebar.js';
import { SELECT_OVERVIEW_TAB_SCRIPT } from './src/cdp-scripts/select-overview-tab.js';
import { buildProxyImageScript } from './src/cdp-scripts/proxy-image.js';
import { HAS_VISIBLE_EDITOR_SCRIPT } from './src/cdp-scripts/has-visible-editor.js';

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
const DEBUG_MODE = process.env.AG2R_DEBUG === '1';

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

// === Push Notifications ===
const VAPID_KEYS_PATH = getConfigPath('vapid-keys.json');
const LEGACY_VAPID_KEYS_PATH = path.join(__dirname, 'vapid-keys.json');
const PUSH_SUBS_PATH = getConfigPath('push-subscriptions.json');
const pushSubscriptions = new Map(); // endpoint → PushSubscription
let lastPermissionState = false; // tracks whether permission banner was showing
let publicOrigin = ''; // set from subscribe request's origin header

// Load or generate VAPID keys on startup
function initVapid() {
  ensureConfigDir();
  let keys;
  try {
    keys = JSON.parse(fs.readFileSync(VAPID_KEYS_PATH, 'utf-8'));
  } catch {
    // Migrate from legacy repo-local path if it exists
    try {
      keys = JSON.parse(fs.readFileSync(LEGACY_VAPID_KEYS_PATH, 'utf-8'));
      fs.writeFileSync(VAPID_KEYS_PATH, JSON.stringify(keys, null, 2));
      log('Push', 'Migrated VAPID keys to ~/.config/ag2r/');
    } catch {
      keys = webpush.generateVAPIDKeys();
      fs.writeFileSync(VAPID_KEYS_PATH, JSON.stringify(keys, null, 2));
      log('Push', 'Generated new VAPID keys');
    }
  }
  const email = process.env.VAPID_EMAIL || 'mailto:ag2r@omercanyy.com';
  webpush.setVapidDetails(email, keys.publicKey, keys.privateKey);
  return keys;
}

// Load push subscriptions from disk
function loadSubscriptions() {
  try {
    const raw = JSON.parse(fs.readFileSync(PUSH_SUBS_PATH, 'utf-8'));
    for (const [endpoint, sub] of raw) {
      pushSubscriptions.set(endpoint, sub);
    }
    log('Push', `Loaded ${pushSubscriptions.size} subscription(s) from disk`);
  } catch {
    // No file yet or corrupt — start empty
  }
}

// Persist push subscriptions to disk
function saveSubscriptions() {
  try {
    ensureConfigDir();
    const data = JSON.stringify([...pushSubscriptions], null, 2);
    fs.writeFileSync(PUSH_SUBS_PATH, data);
  } catch (e) {
    console.debug('[Push] Failed to save subscriptions:', e.message);
  }
}

const vapidKeys = initVapid();
loadSubscriptions();

// Send push notification to all subscribers (production only — dev servers skip)
async function sendPushToAll(payload) {
  if (isDev()) return;
  if (pushSubscriptions.size === 0) return;
  const body = JSON.stringify(payload);
  const stale = [];
  for (const [endpoint, sub] of pushSubscriptions) {
    try {
      await webpush.sendNotification(sub, body);
    } catch (err) {
      if (err.statusCode === 410 || err.statusCode === 404 || err.statusCode === 403) {
        stale.push(endpoint);
      } else {
        console.debug(`[Push] Send error: ${err.statusCode || 'N/A'} — ${err.body || err.message}`);
      }
    }
  }
  stale.forEach(ep => pushSubscriptions.delete(ep));
  if (stale.length > 0) saveSubscriptions();
  log('Push', `Sent to ${pushSubscriptions.size} subscriber(s), removed ${stale.length} stale`);
}

// Check permission state and send push on transition
function checkAttentionState(snapshot) {
  const hasPermission = !!snapshot.permissionHtml;
  if (hasPermission && !lastPermissionState) {
    // Transition: no permission → permission needed
    const url = publicOrigin || (TUNNEL_ENABLED && TUNNEL_URL ? TUNNEL_URL : `https://localhost:${PORT}`);
    sendPushToAll({
      title: 'AG2R — Permission needed',
      body: 'Session is waiting for your approval',
      url,
      tag: 'ag2r-permission',
    });
    track('push_notification_sent', { reason: 'permission' });
  }
  lastPermissionState = hasPermission;
}

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

// Timestamped debug log — only prints when AG2R_DEBUG=1
function debugLog(source, event, detail = '') {
  if (!DEBUG_MODE) return;
  const ts = new Date().toISOString();
  console.log(`[${ts} ${source}] ${event}${detail ? ' ' + detail : ''}`);
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

// Read CDP port from AG's DevToolsActivePort file (written when --remote-debugging-port=0)
function readDevToolsPort() {
  const dtpPath = path.join(
    os.homedir(), 'Library', 'Application Support', 'Antigravity', 'DevToolsActivePort'
  );
  try {
    const content = fs.readFileSync(dtpPath, 'utf-8').trim();
    const port = parseInt(content.split('\n')[0], 10);
    if (port > 0 && port < 65536) return port;
  } catch {
    // File doesn't exist or unreadable — AG may not be running
  }
  return null;
}

async function tryPortForTarget(port) {
  try {
    const targets = await CDP.List({ host: CDP_HOST, port });
    if (!targets || targets.length === 0) return null;

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
    // Port not available
  }
  return null;
}

async function discoverTarget() {
  // Build candidate port list: DevToolsActivePort first (most likely after AG update),
  // then configured CDP_PORT range as fallback for older AG versions
  const dtpPort = readDevToolsPort();
  const ports = new Set();
  if (dtpPort) ports.add(dtpPort);
  ports.add(CDP_PORT);
  ports.add(CDP_PORT + 1);
  ports.add(CDP_PORT + 2);
  ports.add(CDP_PORT + 3);

  for (const port of ports) {
    const result = await tryPortForTarget(port);
    if (result) return result;
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
    track('cdp_disconnected');
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
      track('cdp_reconnected');
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

// Run an expression in a specific CDP context (no fallthrough).
// Used for side-effect scripts (inject, stop, click-send) that must only
// execute once — even if the promise gets GC'd in one context.
async function evaluateInContext(contextId, expression) {
  if (!cdpClient) throw new Error('CDP not connected');
  const result = await cdpClient.Runtime.evaluate({
    expression,
    contextId,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || 'CDP eval exception');
  }
  return result.result?.value ?? null;
}

// Find which CDP execution context has a visible editor.
// Uses a synchronous (no async promise → no GC risk) side-effect-free probe.
// Returns the contextId, or null if no context has a visible editor.
async function findEditorContext() {
  if (!cdpClient) return null;
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
        expression: HAS_VISIBLE_EDITOR_SCRIPT,
        contextId: ctx.id,
        returnByValue: true,
        // No awaitPromise — script is synchronous
      });
      if (!result.exceptionDetails && result.result?.value === true) {
        return ctx.id;
      }
    } catch { continue; }
  }
  return null;
}

// ─────────────────────────────────────────────
// Snapshot Capture
// ─────────────────────────────────────────────

// CAPTURE_SCRIPT, RUNNING_TASKS_SCRIPT, SCHEDULED_TASKS_SCRIPT, etc.
// are imported from src/cdp-scripts/*.js — see imports at top of file.

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

      // Also capture body-level dropdowns/popovers (React portals for schedule selectors, kebab menus).
      // Try preferred context first (listbox for schedule dropdowns), then across all contexts
      // for kebab menu context menus (popover-style portals in the isolated context).
      if (!result.dropdownHtml) {
        try {
          result.dropdownHtml = await evaluateInBrowser(buildCaptureListboxScript());
        } catch (e) {
          console.debug('[Snapshot] Scheduled tasks dropdown eval failed:', e.message);
        }
      }

      // Capture kebab context menus (popover/dialog portals) from the isolated context.
      // These are body-level children with role="dialog", data-side attribute (Radix popover),
      // or short text content indicating a context menu.
      if (!result.dropdownHtml) {
        try {
          result.dropdownHtml = await evaluateAcrossContexts(buildCaptureKebabMenuScript());
        } catch (e) {
          console.debug('[Snapshot] Kebab context menu eval failed:', e.message);
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

// buildInjectScript is imported from src/cdp-scripts/inject-message.js

// Detect-then-execute: find the context with a visible editor first (read-only,
// safe to retry across contexts), then run the inject script in that one context
// only (no fallthrough). Prevents double-send when a context's async promise
// gets garbage collected after the inject has already pasted text + clicked send.
async function injectMessage(text, opts = {}) {
  const ctxId = await findEditorContext();
  if (!ctxId) throw new Error('No editor found in any context');

  // JSON.stringify safely escapes quotes, newlines, backticks, unicode
  const safeText = JSON.stringify(text);
  const appendMode = opts.appendMode || false;
  const script = buildInjectScript(safeText, appendMode);
  return await evaluateInContext(ctxId, script);
}

// Poll AG's editor until it contains image content (img, decorator nodes).
// Returns true if image found within timeout, false otherwise.
async function waitForEditorImage(maxWaitMs = 3000) {
  const interval = 100;
  const attempts = Math.ceil(maxWaitMs / interval);
  for (let i = 0; i < attempts; i++) {
    try {
      const hasImage = await evaluateInBrowser(CHECK_EDITOR_IMAGE_SCRIPT);
      if (hasImage) {
        log('WaitImage', `Found after ${i * interval}ms`);
        return true;
      }
    } catch { /* ignore eval errors during polling */ }
    await new Promise(r => setTimeout(r, interval));
  }
  return false;
}

// ─────────────────────────────────────────────
// Stop Generation (via CDP)
// ─────────────────────────────────────────────

// STOP_SCRIPT is imported from src/cdp-scripts/stop.js
// Uses detect-then-execute (same as injectMessage) to prevent double-clicks
// when a context's promise gets GC'd after the stop button was already clicked.

async function stopGeneration() {
  const ctxId = await findEditorContext();
  if (!ctxId) {
    // No editor context — fall back to evaluateInBrowser for stop button
    // (stop button might be visible even without an editor)
    return await evaluateInBrowser(STOP_SCRIPT);
  }
  return await evaluateInContext(ctxId, STOP_SCRIPT);
}

// ─────────────────────────────────────────────
// Burst Re-Capture (shared utility)
// ─────────────────────────────────────────────

// Fires rapid re-captures at specified delays to catch DOM changes
// (e.g., portal opens, dialog appears) after a click.
// Previously copy-pasted 4× in the /click handler.
function fireBurstCaptures(delays) {
  for (const delay of delays) {
    (async () => {
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
            (snapshot.runningTasksHtml || '') +
            (snapshot.scheduledTasksHtml || '') +
            (snapshot.scheduledTasksDialogHtml || '') +
            (snapshot.subagentInfoHtml || '')
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
    })();
  }
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
          (snapshot.scheduledTasksDialogHtml || '') +
          (snapshot.subagentInfoHtml || '')
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

        // Check if session needs attention (permission state transition)
        checkAttentionState(snapshot);

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

// --- Centralized API Error Tracking ---
// Wraps res.json before routes run to intercept 5xx responses
app.use((req, res, next) => {
  const _json = res.json.bind(res);
  res.json = function (body) {
    if (res.statusCode >= 500) {
      track('api_error', { endpoint: req.path, status: res.statusCode });
    }
    return _json(body);
  };
  next();
});

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


// --- Login ---
app.post('/login', (req, res) => {
  const { password } = req.body;
  if (password === APP_PASSWORD) {
    res.cookie('ag2r_token', authToken(), {
      signed: true,
      httpOnly: true,
      maxAge: 30 * 24 * 60 * 60 * 1000,
      sameSite: 'lax',
    });
    track('login');
    return res.json({ ok: true });
  }
  res.status(401).json({ error: 'Wrong password' });
});

app.post('/logout', (req, res) => {
  res.clearCookie('ag2r_token');
  res.json({ ok: true });
});

// --- Snapshot (HTTP fallback for initial load) ---
app.get('/snapshot', (req, res) => {
  if (!cachedSnapshot) {
    return res.json({
      html: '<div style="color:#888;text-align:center;padding:40px">Waiting for Antigravity connection...</div>',
      css: '',
      agentRunning: false,
    });
  }

  // Strip scroll info from HTTP response (only useful for WS real-time)
  const { scrollInfo, ...data } = cachedSnapshot;
  res.json(data);
});

// --- Right Sidebar (on-demand capture) ---
app.get('/right-sidebar', async (req, res) => {
  try {
    let html = await evaluateInBrowser(RIGHT_SIDEBAR_SCRIPT);
    if (html) {
      return res.json({ html });
    }

    // Sidebar is closed in AG — try to open it
    log('RightSidebar', 'Sidebar closed in AG, attempting to open...');
    const opened = await evaluateInBrowser(OPEN_RIGHT_SIDEBAR_SCRIPT);

    if (!opened) {
      // Strategy 2: Keyboard shortcut — Cmd+Option+B (VS Code Toggle Auxiliary Bar)
      try {
        await cdpClient.Input.dispatchKeyEvent({
          type: 'keyDown',
          key: 'b',
          code: 'KeyB',
          modifiers: 8 + 1, // Meta(8) + Alt(1) = Cmd+Option
          windowsVirtualKeyCode: 66,
        });
        await cdpClient.Input.dispatchKeyEvent({
          type: 'keyUp',
          key: 'b',
          code: 'KeyB',
          modifiers: 8 + 1,
          windowsVirtualKeyCode: 66,
        });
        log('RightSidebar', 'Sent Cmd+Option+B keyboard shortcut');
      } catch (e) {
        log('RightSidebar', 'Keyboard shortcut failed:', e.message);
      }
    } else {
      log('RightSidebar', 'Clicked toggle button');
    }

    // Wait for sidebar to render
    await new Promise(r => setTimeout(r, 500));

    // Select the Overview tab if no tab is active
    await evaluateInBrowser(SELECT_OVERVIEW_TAB_SCRIPT);
    await new Promise(r => setTimeout(r, 200));

    // Re-try capture
    html = await evaluateInBrowser(RIGHT_SIDEBAR_SCRIPT);
    res.json({ html: html || null, wasOpened: true });
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
    const script = buildProxyImageScript(JSON.stringify(src));
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
    const result = await evaluateInBrowser(EXPAND_LEFT_SIDEBAR_SCRIPT);
    log('ExpandLeftSidebar', JSON.stringify(result));
    res.json(result || { ok: false });
  } catch (e) {
    console.debug('[ExpandLeftSidebar] Error:', e.message);
    res.json({ ok: false, error: e.message });
  }
});

// --- Copy Response (intercept AG's clipboard.writeText, return markdown) ---
app.post('/copy-response', async (req, res) => {
  track('code_copied');
  const { clickId } = req.body || {};
  if (!clickId || !cdpClient) {
    return res.status(400).json({ error: 'Missing clickId or CDP not connected' });
  }
  try {
    // Use the exact same element lookup as /click handler to avoid index mismatch
    const script = buildCopyResponseScript(JSON.stringify(String(clickId)));
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

// --- Dismiss Scheduled Tasks (navigate back: detail→list, list→conversation) ---
app.post('/dismiss-scheduled-tasks', async (req, res) => {
  if (!cdpClient) return res.status(503).json({ error: 'CDP not connected' });
  try {
    const result = await evaluateAcrossContexts(DISMISS_SCHEDULED_TASKS_SCRIPT);
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
    const result = await evaluateInBrowser(DISMISS_SETTINGS_SCRIPT);
    log('DismissSettings', JSON.stringify(result));
    res.json(result || { ok: false });
  } catch (e) {
    console.debug('[DismissSettings] Error:', e.message);
    res.json({ ok: false, error: e.message });
  }
});

// --- Restart Antigravity (kill + relaunch the desktop app) ---
app.post('/restart-antigravity', async (req, res) => {
  try {
    // Find the Antigravity Electron process PID
    // pgrep doesn't work on macOS Electron — must use ps aux (see ONBOARDING.md gotcha)
    let pid = null;
    try {
      const psOutput = execSync('ps aux', { encoding: 'utf8' });
      for (const line of psOutput.split('\n')) {
        if (line.includes('Antigravity.app/Contents/MacOS/Antigravity') && !line.includes('grep')) {
          pid = parseInt(line.trim().split(/\s+/)[1], 10);
          break;
        }
      }
    } catch (e) {
      log('Restart', 'Failed to find Antigravity process:', e.message);
      return res.json({ ok: false, reason: 'process_not_found' });
    }

    if (!pid) {
      log('Restart', 'Antigravity process not found');
      return res.json({ ok: false, reason: 'process_not_found' });
    }

    log('Restart', `Killing Antigravity (PID ${pid})...`);
    track('restart_antigravity');

    // Graceful kill
    try { process.kill(pid, 'SIGTERM'); } catch (e) {
      log('Restart', 'Kill failed:', e.message);
      return res.json({ ok: false, reason: 'kill_failed' });
    }

    // Wait for process to die, then relaunch
    setTimeout(() => {
      log('Restart', 'Relaunching Antigravity...');
      exec('open -a Antigravity --args --remote-debugging-port=9000', (err) => {
        if (err) log('Restart', 'Relaunch error:', err.message);
        else log('Restart', 'Relaunch command sent');
      });
    }, 1500);

    res.json({ ok: true });
  } catch (e) {
    log('Restart', 'Unexpected error:', e.message);
    res.status(500).json({ ok: false, reason: e.message });
  }
});

// --- Click Proxy (forward clicks to real AG DOM) ---
// Click IDs are prefixed: chat:N, left:N, right:N
// --- Client Telemetry Endpoint ---
// Receives events from the client-side track() function and forwards to Firestore
app.post('/telemetry', (req, res) => {
  const { event, ...payload } = req.body || {};
  if (!event || typeof event !== 'string') {
    return res.status(400).json({ error: 'event is required' });
  }
  // Whitelist client events to prevent abuse
  const allowed = new Set([
    'comment_added', 'comment_edited', 'comment_deleted', 'comments_sent',
    'voice_input_used', 'artifact_viewed', 'client_error',
    'model_changed', 'branch_changed', 'worktree_changed',
    'quick_action_used',
    'hard_refresh',
  ]);
  if (!allowed.has(event)) {
    return res.status(400).json({ error: 'unknown event' });
  }
  track(event, payload);
  res.json({ ok: true });
});

// --- Debug Log Endpoint (AG2R_DEBUG=1 only) ---
app.post('/debug-log', (req, res) => {
  if (!DEBUG_MODE) return res.status(404).json({ error: 'Not found' });
  const { event, detail } = req.body || {};
  if (!event || typeof event !== 'string') {
    return res.status(400).json({ error: 'event is required' });
  }
  debugLog('CLIENT', event, typeof detail === 'string' ? detail : JSON.stringify(detail));
  res.json({ ok: true });
});

app.post('/click', async (req, res) => {
  const { clickId, label } = req.body;
  log('Click', `Proxying click id=${clickId} label="${label}"`);  

  // Telemetry: detect meaningful clicks by prefix/label
  const cid = String(clickId || '');
  if (cid.startsWith('left:')) {
    track('conversation_switched');
  } else if (cid.startsWith('sched:')) {
    track('scheduled_task_viewed');
  }
  const trimmedLabel = String(label || '').trim();
  if (/^(Proceed|Approve)/i.test(trimmedLabel)) {
    track('plan_approved');
  }
  if (/^Run$/i.test(trimmedLabel) || /^Accept$/i.test(trimmedLabel)) {
    track('command_accepted');
  }

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
      const taskClickScript = buildTaskClickScript(taskIdx);
      const result = await evaluateAcrossContexts(taskClickScript);
      log('Click', `Task result: ${JSON.stringify(result)}`);
      return res.json(result || { ok: false, reason: 'null_result' });
    }

    // Subagent info panel clicks (e.g. "Open Overview" button)
    if (String(clickId).startsWith('subinfo:')) {
      const clickScript = buildMainClickScript(JSON.stringify(String(clickId)), JSON.stringify(label || ''));
      const result = await evaluateAcrossContexts(clickScript);
      log('Click', `SubagentInfo result: ${JSON.stringify(result)}`);
      return res.json(result || { ok: false, reason: 'null_result' });
    }

    // Scheduled Tasks page clicks need evaluateAcrossContexts (isolated context)
    if (String(clickId).startsWith('sched:')) {
      const schedIdx = parseInt(String(clickId).split(':')[1], 10);
      const schedClickScript = buildSchedClickScript(schedIdx);
      const result = await evaluateAcrossContexts(schedClickScript);
      log('Click', `Sched result: ${JSON.stringify(result)}`);
      res.json(result || { ok: false, reason: 'null_result' });

      // After sched: clicks (especially kebab menu ⋮), fire burst re-captures
      // to pick up the newly-opened context menu / dialog portal
      if (result?.ok) {
        fireBurstCaptures([150, 400, 700]);
      }
      return;
    }

    // Scheduled Tasks dialog clicks (New Scheduled Task form) — different context from page
    if (String(clickId).startsWith('scheddlg:')) {
      const dlgIdx = parseInt(String(clickId).split(':')[1], 10);

      // scheddlg:100+ → body-level portal options (listbox for schedule dropdowns,
      // or popover/context menu for kebab actions). Try preferred context first,
      // then fall back to cross-context for isolated context portals.
      if (dlgIdx >= 100) {
        const optIdx = dlgIdx - 100;
        const portalClickScript = buildSchedPortalClickScript(optIdx);
        // Try preferred context first
        let result = await evaluateInBrowser(portalClickScript);
        // If not found in preferred context, try across all contexts (kebab menu in isolated context)
        if (!result) {
          result = await evaluateAcrossContexts(portalClickScript);
        }
        log('Click', `SchedDlgPortal result: ${JSON.stringify(result)}`);
        res.json(result || { ok: false, reason: 'no_portal' });

        // Burst re-captures: clicking a kebab menu option (e.g. Delete Task)
        // may open a confirmation dialog or update the page
        if (result?.ok) {
          fireBurstCaptures([150, 400, 800]);
        }
        return;
      }

      // scheddlg:0-99 → elements inside the z-[2550] dialog overlay
      const safeLabel = JSON.stringify(label || '');
      const dlgClickScript = buildSchedDialogClickScript(dlgIdx, safeLabel);
      const result = await evaluateAcrossContexts(dlgClickScript);
      log('Click', `SchedDlg result: ${JSON.stringify(result)}`);
      res.json(result || { ok: false, reason: 'null_result' });

      // Burst re-captures: dialog button clicks may close dialog, update the page,
      // or open a new dialog (e.g. delete confirmation)
      if (result?.ok) {
        fireBurstCaptures([150, 400, 800]);
      }
      return;
    }

    const clickScript = buildMainClickScript(JSON.stringify(String(clickId)), JSON.stringify(label || ''));
    const result = await evaluateInBrowser(clickScript);
    log('Click', `Result: ${JSON.stringify(result)}`);
    res.json(result || { ok: false, reason: 'null_result' });

    // After portal-opening clicks, schedule rapid re-captures to catch the
    // dialog/dropdown DOM appearing (React render takes 50-200ms)
    if (result?.ok) {
      const source = result.source || '';
      if (['env', 'model', 'project', 'dropdown', 'dialog', 'left'].includes(source)) {
        // Fire 3 rapid captures at 150ms, 400ms, 700ms
        fireBurstCaptures([150, 400, 700]);
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
// Targets element by placeholder text or by clickId (sched:N / scheddlg:N).
// Uses React's nativeInputValueSetter trick to trigger onChange handlers.
app.post('/type-text', async (req, res) => {
  const { placeholder, text, clickId } = req.body;
  if (text === undefined) {
    return res.status(400).json({ error: 'text is required' });
  }
  if (!placeholder && !clickId) {
    return res.status(400).json({ error: 'placeholder or clickId is required' });
  }
  if (!cdpClient) {
    return res.status(503).json({ error: 'CDP not connected' });
  }

  const safeText = JSON.stringify(text);
  const safePlaceholder = JSON.stringify(placeholder || '');
  const safeClickId = JSON.stringify(clickId || '');

  const typeScript = buildTypeTextScript(safePlaceholder, safeClickId, safeText);

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
  track('image_uploaded');

  log('Upload', `Received ${fileName} (${mimetype}, ${(buffer.length / 1024).toFixed(1)}KB)`);

  try {
    const script = buildUploadImageScript(
      JSON.stringify(base64),
      JSON.stringify(mimetype),
      JSON.stringify(fileName)
    );
    const result = await evaluateInBrowser(script);

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
  const { message, hasImages } = req.body;
  log('Send', `Received: "${message?.substring(0, 50)}"${hasImages ? ' (with images)' : ''}`);

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
    // When images were just uploaded, wait for AG to process them before injecting text
    if (hasImages) {
      log('Send', 'Waiting for AG to process dropped images...');
      await waitForEditorImage();
    }

    log('Send', 'Injecting via CDP...');
    // When images were just uploaded, use append mode to preserve them in the editor
    const result = await injectMessage(message, { appendMode: !!hasImages });
    log('Send', `Injection result: ${JSON.stringify(result)}`);
    track('message_sent');
    res.json(result || { ok: true });
  } catch (e) {
    log('Send', `Injection error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// --- Send Images Only (no text) ---
// Waits for AG's editor to process dropped images, then clicks the send button.
app.post('/send-images', async (req, res) => {
  if (!cdpClient) {
    return res.status(503).json({ error: 'CDP not connected' });
  }

  try {
    // Give AG time to process the dropped image before clicking send.
    // The image drop already succeeded via CDP — this delay lets AG's
    // React/Lexical editor finish updating the DOM.
    log('SendImages', 'Waiting 500ms for AG to process dropped images...');
    await new Promise(r => setTimeout(r, 500));

    log('SendImages', 'Clicking send...');
    const ctxId = await findEditorContext();
    if (!ctxId) throw new Error('No editor found in any context');
    const result = await evaluateInContext(ctxId, CLICK_SEND_BUTTON_SCRIPT);

    log('SendImages', `Result: ${JSON.stringify(result)}`);
    track('message_sent');
    res.json(result || { ok: false });
  } catch (e) {
    log('SendImages', `Error: ${e.message}`);
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
    track('generation_stopped');
    res.json(result || { ok: false });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Sidebar Discovery (temporary diagnostic) ---
// DISCOVER_SCRIPT is imported from src/cdp-scripts/discover.js

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

// --- Push Notification Endpoints ---
app.get('/push/vapid-public-key', (req, res) => {
  res.json({ publicKey: vapidKeys.publicKey });
});

app.post('/push/subscribe', (req, res) => {
  const subscription = req.body;
  if (!subscription?.endpoint) {
    return res.status(400).json({ error: 'Invalid subscription' });
  }
  pushSubscriptions.set(subscription.endpoint, subscription);
  saveSubscriptions();
  // Track the public origin for notification click URLs
  const origin = req.get('origin') || req.get('referer');
  if (origin) publicOrigin = origin.replace(/\/$/, '');
  log('Push', `Subscribed (${pushSubscriptions.size} total)`);
  res.json({ ok: true });
});

app.post('/push/unsubscribe', (req, res) => {
  const { endpoint } = req.body;
  if (endpoint) {
    pushSubscriptions.delete(endpoint);
    saveSubscriptions();
  }
  log('Push', `Unsubscribed (${pushSubscriptions.size} total)`);
  res.json({ ok: true });
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
// Icon Workshop (dev tool, untracked)
// ─────────────────────────────────────────────

app.get('/icon-workshop', (req, res) => {
  const toolPath = path.join(__dirname, '_tools', 'icon-workshop.html');
  if (!fs.existsSync(toolPath)) return res.status(404).send('Icon workshop not found');
  res.sendFile(toolPath);
});

app.post('/icon-workshop/save', (req, res) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    try {
      const buf = Buffer.concat(chunks);
      // Parse multipart to extract the PNG blob
      const boundary = req.headers['content-type']?.split('boundary=')[1];
      if (!boundary) return res.json({ ok: false, error: 'No boundary' });
      const parts = buf.toString('binary').split('--' + boundary);
      for (const part of parts) {
        if (part.includes('name="icon"')) {
          const headerEnd = part.indexOf('\r\n\r\n');
          if (headerEnd < 0) continue;
          const body = Buffer.from(part.substring(headerEnd + 4).replace(/\r\n$/, ''), 'binary');
          fs.writeFileSync(path.join(__dirname, 'public', 'ag2r-icon.png'), body);
          return res.json({ ok: true });
        }
      }
      res.json({ ok: false, error: 'No icon part found' });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });
});

// Browse files on the laptop
app.get('/icon-workshop/browse', (req, res) => {
  let dir = req.query.dir || path.join(__dirname, 'public');
  if (dir.startsWith('~')) dir = dir.replace('~', os.homedir());
  const IMG_EXT = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico'];
  try {
    const resolved = path.resolve(dir);
    const entries = fs.readdirSync(resolved, { withFileTypes: true });
    const items = [];
    // Parent directory
    const parent = path.dirname(resolved);
    if (parent !== resolved) {
      items.push({ name: '..', path: parent, type: 'dir' });
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(resolved, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === '.git') continue;
        items.push({ name: e.name + '/', path: full, type: 'dir' });
      } else if (IMG_EXT.includes(path.extname(e.name).toLowerCase())) {
        const stat = fs.statSync(full);
        items.push({ name: e.name, path: full, type: 'file', size: stat.size });
      }
    }
    items.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    res.json({ ok: true, dir: resolved, items });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.get('/icon-workshop/file', (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return res.status(400).send('No path');
  try {
    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) return res.status(404).send('Not found');
    res.sendFile(resolved);
  } catch (e) { res.status(500).send(e.message); }
});


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
      debugMode: DEBUG_MODE,
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
    startSession();
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
    endSession();
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
