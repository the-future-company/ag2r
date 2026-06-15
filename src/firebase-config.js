// src/firebase-config.js — Shared Firebase project configuration
// Used by telemetry.js (writes) and feature-flags.js (reads).
// These are intentionally public — Firebase API keys are project identifiers,
// not secrets. Firestore security rules enforce access control.
// Override via .env to point to your own Firebase project.

const DEFAULT_PROJECT_ID = 'ag2r-telemetry';
const DEFAULT_API_KEY = 'AIzaSyDyV0ywPHpqzuYrk72GYSibxTAd6gKpn4w';

let _loaded = false;
let _projectId = '';
let _apiKey = '';

/**
 * Lazy-load Firebase config from env vars (falls back to defaults).
 * Must be called after dotenv.config() in server.js has run.
 * @returns {{ projectId: string, apiKey: string }}
 */
export function loadFirebaseConfig() {
  if (!_loaded) {
    _loaded = true;
    _projectId = process.env.TELEMETRY_FIREBASE_PROJECT_ID || DEFAULT_PROJECT_ID;
    _apiKey = process.env.TELEMETRY_FIREBASE_API_KEY || DEFAULT_API_KEY;
  }
  return { projectId: _projectId, apiKey: _apiKey };
}
