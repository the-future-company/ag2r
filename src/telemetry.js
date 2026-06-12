// src/telemetry.js — Anonymous usage telemetry for AG2R
// Sends anonymous events to Firebase Firestore via REST API.
// No PII collected. Opt out: AG2R_TELEMETRY=false in .env
//
// Firestore project config → .env (see .env.example for template)

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { execSync } from 'child_process';
import os from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

// ─────────────────────────────────────────────
// Configuration — read lazily so dotenv.config() in server.js runs first
// (ESM hoists imports, so module-scope reads would see empty env vars)
// ─────────────────────────────────────────────

// Default Firebase config for centralized telemetry.
// These are intentionally public — Firebase API keys are project identifiers,
// not secrets. Firestore security rules enforce create-only access with schema
// validation. The Spark (free) plan has hard daily caps preventing abuse.
// Override via .env to send telemetry to your own Firebase project.
const DEFAULT_PROJECT_ID = 'ag2r-telemetry';
const DEFAULT_API_KEY = 'AIzaSyDyV0ywPHpqzuYrk72GYSibxTAd6gKpn4w';

let _configLoaded = false;
let ENABLED = true;
let FIREBASE_PROJECT_ID = '';
let FIREBASE_API_KEY = '';
const COLLECTION = 'telemetry';
const HEARTBEAT_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

function loadConfig() {
  if (_configLoaded) return;
  _configLoaded = true;
  ENABLED = process.env.AG2R_TELEMETRY !== 'false';
  FIREBASE_PROJECT_ID = process.env.TELEMETRY_FIREBASE_PROJECT_ID || DEFAULT_PROJECT_ID;
  FIREBASE_API_KEY = process.env.TELEMETRY_FIREBASE_API_KEY || DEFAULT_API_KEY;
}

// ─────────────────────────────────────────────
// Install ID (persistent, anonymous)
// ─────────────────────────────────────────────

const ID_FILE = path.join(PROJECT_ROOT, '.ag2r-telemetry-id');

function getInstallId() {
  try {
    const existing = fs.readFileSync(ID_FILE, 'utf8').trim();
    if (existing) return existing;
  } catch {
    // File doesn't exist yet
  }
  const id = randomUUID();
  try {
    fs.writeFileSync(ID_FILE, id + '\n');
  } catch {
    // Non-critical — use ephemeral ID this session
  }
  return id;
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

async function sendToFirestore(event, payload = {}) {
  if (!FIREBASE_PROJECT_ID || !FIREBASE_API_KEY) return;

  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/${COLLECTION}?key=${FIREBASE_API_KEY}`;

  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildFirestoreDoc(event, payload)),
      signal: AbortSignal.timeout(5000), // 5s timeout — never block the app
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
 * @param {string} event - Event name (e.g., 'message_sent', 'cdp_disconnected')
 * @param {object} [payload] - Optional metadata (no PII!)
 */
export function track(event, payload = {}) {
  loadConfig();
  if (!ENABLED) return;
  eventCounts[event] = (eventCounts[event] || 0) + 1;
  sendToFirestore(event, payload);
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

  // Don't keep the process alive just for heartbeat
  if (heartbeatTimer.unref) heartbeatTimer.unref();
}

/**
 * Send session_end event and stop heartbeat.
 * Call on graceful shutdown.
 */
export function endSession() {
  loadConfig();
  if (!ENABLED) return;
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  const uptimeMinutes = Math.round((Date.now() - startTime) / 60000);
  // Synchronous-ish — we send and hope it lands before process exits
  sendToFirestore('session_end', {
    uptimeMinutes,
    eventCounts: { ...eventCounts },
  });
}

/**
 * Whether telemetry is enabled.
 */
export function isEnabled() {
  loadConfig();
  return ENABLED;
}

// ─────────────────────────────────────────────
// Read events from Firestore (for dashboard)
// Uses Firebase CLI stored credentials for auth
// ─────────────────────────────────────────────

function parseFirestoreValue(v) {
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.integerValue !== undefined) return parseInt(v.integerValue);
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.booleanValue !== undefined) return v.booleanValue;
  if (v.nullValue !== undefined) return null;
  if (v.mapValue) {
    const obj = {};
    for (const [k, mv] of Object.entries(v.mapValue.fields || {})) {
      obj[k] = parseFirestoreValue(mv);
    }
    return obj;
  }
  return JSON.stringify(v);
}

async function getFirebaseToken() {
  const configPath = path.join(os.homedir(), '.config', 'configstore', 'firebase-tools.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const refreshToken = config.tokens?.refresh_token;
  if (!refreshToken) throw new Error('No Firebase CLI credentials');

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: config.tokens?.client_id || '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com',
      client_secret: config.tokens?.client_secret || 'j9iVZfS8kkCEFUPaAeJV0sAi',
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error('Token refresh failed');
  return (await res.json()).access_token;
}

/**
 * Read all telemetry events from Firestore.
 * @returns {Promise<Array<object>>} Parsed event objects sorted by timestamp
 */
export async function readEvents() {
  loadConfig();
  if (!FIREBASE_PROJECT_ID) return [];

  const token = await getFirebaseToken();
  const base = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;
  let allDocs = [];
  let pageToken = '';

  do {
    const url = `${base}/${COLLECTION}?pageSize=300${pageToken ? '&pageToken=' + pageToken : ''}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`Firestore read failed: ${res.status}`);
    const data = await res.json();

    for (const doc of data.documents || []) {
      const parsed = {};
      for (const [k, v] of Object.entries(doc.fields || {})) {
        parsed[k] = parseFirestoreValue(v);
      }
      allDocs.push(parsed);
    }
    pageToken = data.nextPageToken || '';
  } while (pageToken);

  allDocs.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
  return allDocs;
}
