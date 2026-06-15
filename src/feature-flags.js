// src/feature-flags.js — Read-only feature flags from Firestore
// Fetched once on server boot. Cached for the session lifetime.
// Security: Firestore rules enforce read-only for public API key.
// Admin writes happen via Firebase Console or Admin SDK (bypasses rules).
// Firebase project config → src/firebase-config.js

import { loadFirebaseConfig } from './firebase-config.js';

const DEFAULTS = {
  showCoffeeLink: true,
};

let _cachedFlags = { ...DEFAULTS };

/**
 * Parses a Firestore REST API document response into a plain JS object.
 * Firestore returns typed values like { booleanValue: true }, { stringValue: "x" }.
 */
function parseFirestoreFields(fields) {
  const result = {};
  for (const [key, typedVal] of Object.entries(fields)) {
    if ('booleanValue' in typedVal) result[key] = typedVal.booleanValue;
    else if ('stringValue' in typedVal) result[key] = typedVal.stringValue;
    else if ('integerValue' in typedVal) result[key] = parseInt(typedVal.integerValue);
    else if ('doubleValue' in typedVal) result[key] = typedVal.doubleValue;
    else if ('nullValue' in typedVal) result[key] = null;
    // Skip complex types (maps, arrays) — flags should be simple primitives
  }
  return result;
}

/**
 * Fetches feature flags from Firestore REST API.
 * Updates the cached flags on success. On failure, keeps previous cache (defaults on first run).
 * Fire-and-forget — never throws, never blocks server startup.
 */
export async function fetchFlags() {
  const { projectId, apiKey } = loadFirebaseConfig();
  if (!projectId || !apiKey) return;

  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/config/features?key=${apiKey}`;

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      // 404 = document doesn't exist yet → use defaults (showCoffeeLink: true)
      if (res.status === 404) {
        console.debug('[Flags] No /config/features document in Firestore, using defaults');
        return;
      }
      console.debug(`[Flags] Firestore responded ${res.status}, using cached values`);
      return;
    }

    const doc = await res.json();
    if (doc.fields) {
      const parsed = parseFirestoreFields(doc.fields);
      // Merge with defaults so new flags get their default values
      _cachedFlags = { ...DEFAULTS, ...parsed };
      console.debug('[Flags] Loaded:', JSON.stringify(_cachedFlags));
    }
  } catch (e) {
    // Network error, timeout, etc. — use cached/default values
    console.debug('[Flags] Fetch failed, using cached values:', e.message);
  }
}

/**
 * Returns the current cached feature flags (synchronous).
 * @returns {object} e.g. { showCoffeeLink: true }
 */
export function getFlags() {
  return { ..._cachedFlags };
}
