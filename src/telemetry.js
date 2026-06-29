// src/telemetry.js — Anonymous usage telemetry for AG2R
// Sends anonymous events to Firebase Firestore via REST API.
// Events are batched in memory and flushed periodically to stay within
// Firestore's 60 req/min REST API quota (Spark plan).
// No PII collected. Opt out: AG2R_TELEMETRY=false in .env
//
// Firestore project config → .env (see .env.example for template)

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { execSync } from 'child_process';
import os from 'os';
import { CONFIG_DIR, ensureConfigDir, getEnv } from './paths.js';
import { loadFirebaseConfig } from './firebase-config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

// ─────────────────────────────────────────────
// Configuration — read lazily so dotenv.config() in server.js runs first
// (ESM hoists imports, so module-scope reads would see empty env vars)
// Firebase project config → src/firebase-config.js
// ─────────────────────────────────────────────

let _configLoaded = false;
let ENABLED = true;
let FIREBASE_PROJECT_ID = '';
let FIREBASE_API_KEY = '';
const COLLECTION = 'telemetry';
const HEARTBEAT_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const FLUSH_INTERVAL_MS = 60 * 1000; // 60s — long enough to batch, short enough to limit crash-loss
const FLUSH_THRESHOLD = 20;          // flush immediately on burst

function loadConfig() {
  if (_configLoaded) return;
  _configLoaded = true;
  ENABLED = process.env.AG2R_TELEMETRY !== 'false';
  const fb = loadFirebaseConfig();
  FIREBASE_PROJECT_ID = fb.projectId;
  FIREBASE_API_KEY = fb.apiKey;
}

// ─────────────────────────────────────────────
// Install ID (persistent, anonymous)
// Stored in ~/.config/ag2r/ (XDG convention) so all worktrees
// and clones on the same machine share a single identity.
// Config dir resolution → src/paths.js
// ─────────────────────────────────────────────

const ID_FILE = path.join(CONFIG_DIR, 'telemetry-id');
const LEGACY_ID_FILE = path.join(PROJECT_ROOT, '.ag2r-telemetry-id');

function getInstallId() {
  // 1. Try the canonical XDG location
  try {
    const existing = fs.readFileSync(ID_FILE, 'utf8').trim();
    if (existing) return existing;
  } catch {
    // Not there yet
  }

  // 2. Migrate from legacy per-repo location if it exists
  try {
    const legacy = fs.readFileSync(LEGACY_ID_FILE, 'utf8').trim();
    if (legacy) {
      writeIdFile(legacy);
      return legacy;
    }
  } catch {
    // No legacy file either
  }

  // 3. Generate a fresh ID
  const id = randomUUID();
  writeIdFile(id);
  return id;
}

function writeIdFile(id) {
  try {
    ensureConfigDir();
    fs.writeFileSync(ID_FILE, id + '\n');
  } catch {
    // Non-critical — use ephemeral ID this session
  }
}


let installId = '';

// ─────────────────────────────────────────────
// App metadata
// ─────────────────────────────────────────────

let appVersion = '0.0.0';
try {
  const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));
  appVersion = pkg.version || '0.0.0';
} catch {}

let commitHash = 'unknown';
try {
  commitHash = execSync('git rev-parse --short HEAD', { cwd: PROJECT_ROOT, encoding: 'utf8' }).trim();
} catch {}

const appMeta = {
  version: appVersion,
  commit: commitHash,
  nodeVersion: process.version,
  os: os.platform(),
  arch: os.arch(),
};

// ─────────────────────────────────────────────
// Firestore REST API
// ─────────────────────────────────────────────

// Converts a JS value to Firestore Value format
function toFirestoreValue(val) {
  if (val === null || val === undefined) return { nullValue: null };
  if (typeof val === 'boolean') return { booleanValue: val };
  if (typeof val === 'number') {
    return Number.isInteger(val) ? { integerValue: String(val) } : { doubleValue: val };
  }
  if (typeof val === 'string') return { stringValue: val };
  if (Array.isArray(val)) {
    return { arrayValue: { values: val.map(toFirestoreValue) } };
  }
  if (typeof val === 'object') {
    const fields = {};
    for (const [k, v] of Object.entries(val)) {
      fields[k] = toFirestoreValue(v);
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(val) };
}

function buildFirestoreDoc(event, payload) {
  const doc = {
    event,
    installId,
    isDev: getEnv() !== 'production',
    ...appMeta,
    ...payload,
    timestamp: new Date().toISOString(),
  };

  const fields = {};
  for (const [k, v] of Object.entries(doc)) {
    fields[k] = toFirestoreValue(v);
  }
  return { fields };
}

// ─────────────────────────────────────────────
// Batch buffer — events accumulate here, flushed periodically
// via documents:commit (single HTTP request for N writes)
// ─────────────────────────────────────────────

const batchBuffer = [];
let flushTimer = null;
let totalFlushes = 0;
let totalEventsFlushed = 0;

async function flushBatch() {
  if (!batchBuffer.length) return;
  if (!FIREBASE_PROJECT_ID || !FIREBASE_API_KEY) return;

  // Drain atomically — if flush fails, events are lost (acceptable for telemetry)
  const docs = batchBuffer.splice(0);

  // Track average batch size
  totalFlushes++;
  totalEventsFlushed += docs.length;
  const avgBatchSize = +(totalEventsFlushed / totalFlushes).toFixed(1);

  const writes = docs.map(doc => ({
    update: {
      name: `projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/${COLLECTION}/${randomUUID()}`,
      fields: doc.fields,
    },
  }));

  // Add batch_flush meta-event to the same commit — no extra HTTP request
  writes.push({
    update: {
      name: `projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/${COLLECTION}/${randomUUID()}`,
      fields: buildFirestoreDoc('batch_flush', {
        batchSize: docs.length,
        avgBatchSize,
        totalFlushes,
        totalEventsFlushed,
      }).fields,
    },
  });

  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents:commit?key=${FIREBASE_API_KEY}`;

  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ writes }),
      signal: AbortSignal.timeout(10000), // 10s for batch (larger payload than single doc)
    });
  } catch {
    // Fire-and-forget — never let telemetry break the app
  }
}

// ─────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────

const startTime = Date.now();
let heartbeatTimer = null;
let eventCounts = {};

/**
 * Track an event. Fire-and-forget — never throws, never blocks.
 * @param {string} event - Event name (e.g., 'message_sent', 'cdp_connect_failed')
 * @param {object} [payload] - Optional metadata (no PII!)
 */
export function track(event, payload = {}) {
  loadConfig();
  if (!ENABLED) return;
  if (!installId) installId = getInstallId();
  eventCounts[event] = (eventCounts[event] || 0) + 1;
  batchBuffer.push(buildFirestoreDoc(event, payload));
  if (batchBuffer.length >= FLUSH_THRESHOLD) {
    flushBatch();
  }
}

/**
 * Send session_start event and begin heartbeat timer.
 * Call once at server startup.
 */
export function startSession() {
  loadConfig();
  if (!ENABLED) return;

  // Generate installId now that we know telemetry is enabled
  if (!installId) installId = getInstallId();

  track('session_start');

  // Heartbeat every 6 hours
  heartbeatTimer = setInterval(() => {
    track('session_heartbeat', {
      uptimeHours: Math.round((Date.now() - startTime) / 3600000),
      eventCounts: { ...eventCounts },
    });
  }, HEARTBEAT_INTERVAL_MS);

  // Batch flush timer — drains the event buffer periodically
  flushTimer = setInterval(() => flushBatch(), FLUSH_INTERVAL_MS);

  // Don't keep the process alive just for timers
  if (heartbeatTimer.unref) heartbeatTimer.unref();
  if (flushTimer.unref) flushTimer.unref();

  // Best-effort flush on crash — starts the async request,
  // process may exit before it completes (acceptable loss for telemetry)
  process.once('uncaughtException', (err) => {
    flushBatch();
    console.error('Uncaught exception:', err);
    setTimeout(() => process.exit(1), 1000).unref();
  });
}

/**
 * Flush remaining events + session_end, stop timers.
 * Call on graceful shutdown.
 */
export function endSession() {
  loadConfig();
  if (!ENABLED) return;
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }

  const uptimeMinutes = Math.round((Date.now() - startTime) / 60000);
  // Bypass track() to avoid incrementing eventCounts for session_end itself
  batchBuffer.push(buildFirestoreDoc('session_end', {
    uptimeMinutes,
    eventCounts: { ...eventCounts },
  }));
  // Fire-and-forget — same as previous sendToFirestore behavior
  flushBatch();
}

/**
 * Whether telemetry is enabled.
 */
export function isEnabled() {
  loadConfig();
  return ENABLED;
}
