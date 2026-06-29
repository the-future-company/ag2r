// src/paths.js — Centralized environment detection and persistent config directory.
// Config directory is namespaced by AG2R_ENV to isolate parallel deployments.
// Default ('production') uses ~/.config/ag2r/; other envs use ~/.config/ag2r-{env}/.

import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Returns the environment name for this AG2R instance.
 * Controls config directory namespace and PWA identity.
 * Defaults to 'production' — set AG2R_ENV for parallel deployments.
 */
export function getEnv() {
  return process.env.AG2R_ENV || 'production';
}

/**
 * Resolved path to the persistent config directory.
 * Production: ~/.config/ag2r/
 * Other envs: ~/.config/ag2r-{env}/
 * Respects XDG_CONFIG_HOME on Linux/macOS, %APPDATA% on Windows.
 */
const configBase = os.platform() === 'win32'
  ? (process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'))
  : (process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'));
const env = getEnv();
const configDirName = env === 'production' ? 'ag2r' : `ag2r-${env}`;
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
