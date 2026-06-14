// src/paths.js — Centralized persistent config directory
// All worktrees and server instances share ~/.config/ag2r/ (XDG convention)
// so VAPID keys, push subscriptions, and install IDs stay consistent.
// See ONBOARDING.md context map for pointer.

import fs from 'fs';
import path from 'path';
import os from 'os';

/** Port reserved for the production main server. */
export const MAIN_PORT = 3000;

/**
 * Whether the current server instance is a dev/test server.
 * Production runs on MAIN_PORT (3000); dev servers use 3001–3099.
 * Reused by telemetry (isDev flag) and push notifications (skip in dev).
 */
export function isDev() {
  const port = parseInt(process.env.PORT || String(MAIN_PORT));
  return port !== MAIN_PORT;
}

/**
 * Resolved path to the persistent config directory.
 * - macOS/Linux: ~/.config/ag2r/ (respects XDG_CONFIG_HOME)
 * - Windows: %APPDATA%/ag2r/
 */
export const CONFIG_DIR = path.join(
  os.platform() === 'win32'
    ? (process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'))
    : (process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')),
  'ag2r'
);

/**
 * Returns the full path to a file within the config directory.
 * @param {string} filename - e.g. 'vapid-keys.json', 'push-subscriptions.json'
 */
export function getConfigPath(filename) {
  return path.join(CONFIG_DIR, filename);
}

/**
 * Ensures the config directory exists. Call before first write.
 */
export function ensureConfigDir() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
}
