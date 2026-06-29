// src/paths.js — Centralized persistent config directory
// All worktrees and server instances share ~/.config/ag2r/ (XDG convention)
// so VAPID keys, push subscriptions, and install IDs stay consistent.
// Shared config directory: ~/.config/ag2r/ — persists across server restarts

import fs from 'fs';
import path from 'path';
import os from 'os';

/** Port reserved for the production main server. */
export const MAIN_PORT = 3000;

/**
 * Named environment for config namespacing and PWA identity.
 * 'production' (default) uses ~/.config/ag2r/, others use ~/.config/ag2r-{env}/.
 */
export const AG2R_ENV = process.env.AG2R_ENV || 'production';

/**
 * Whether the given origin is a dev/test environment.
 * Checks the actual URL the user accesses (from HTTP Origin header).
 * Dev origins get notifications and subscription persistence skipped.
 */
export function isDev(origin) {
  if (!origin) return true;
  return /localhost|dev-ag2r/i.test(origin);
}

/**
 * Resolved path to the persistent config directory.
 * Production: ~/.config/ag2r/ (backward compatible)
 * Other envs: ~/.config/ag2r-{env}/ (e.g., ~/.config/ag2r-next/)
 * Windows: %APPDATA%/ag2r[-env]/
 */
const configBase = os.platform() === 'win32'
  ? (process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'))
  : (process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'));
const configDirName = AG2R_ENV === 'production' ? 'ag2r' : `ag2r-${AG2R_ENV}`;
export const CONFIG_DIR = path.join(configBase, configDirName);

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
