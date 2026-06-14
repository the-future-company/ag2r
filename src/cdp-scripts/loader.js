// loader.js — CDP script loader and parameterizer
// Reads browser-side JS scripts from disk at startup.
// Prepends shared helpers to scripts that need them.
// Exports: loadScripts(), parameterize()

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Replace placeholder tokens in a script string with runtime values.
 * @param {string} script - The script template string
 * @param {Object<string, string>} replacements - Map of __TOKEN__ → value
 * @returns {string} The parameterized script
 */
export function parameterize(script, replacements) {
  let result = script;
  for (const [token, value] of Object.entries(replacements)) {
    result = result.replaceAll(token, value);
  }
  return result;
}

/**
 * Load all CDP scripts from disk and prepend shared helpers where needed.
 * Called once at server startup — all reads are synchronous for simplicity.
 * @returns {Object} Map of script names → script strings (ready for Runtime.evaluate)
 */
export function loadScripts() {
  const read = (filename) => fs.readFileSync(path.join(__dirname, filename), 'utf8');

  const helpers = read('helpers.js');
  const withHelpers = (script) => helpers + '\n' + script;

  return {
    // ── Capture scripts ──
    capture: withHelpers(read('capture.js')),
    captureRunningTasks: read('capture-running-tasks.js'),
    captureScheduledTasks: withHelpers(read('capture-scheduled-tasks.js')),
    captureScheduledTasksDialog: read('capture-scheduled-tasks-dialog.js'),
    captureRightSidebar: withHelpers(read('capture-right-sidebar.js')),
    captureDropdown: read('capture-dropdown.js'),
    captureKebabMenu: read('capture-kebab-menu.js'),

    // ── Action scripts ──
    stop: read('stop.js'),
    inject: read('inject.js'),

    // ── Click scripts ──
    click: withHelpers(read('click.js')),
    clickTask: read('click-task.js'),
    clickSched: withHelpers(read('click-sched.js')),
    clickScheddlg: read('click-scheddlg.js'),
    clickScheddlgPortal: read('click-scheddlg-portal.js'),

    // ── Route-specific scripts ──
    copyResponse: withHelpers(read('copy-response.js')),
    typeText: withHelpers(read('type-text.js')),
    upload: read('upload.js'),
    proxyImage: read('proxy-image.js'),
    expandLeftSidebar: read('expand-left-sidebar.js'),
    dismissSettings: read('dismiss-settings.js'),
    dismissScheduledTasks: read('dismiss-scheduled-tasks.js'),

    // ── Diagnostic ──
    discover: read('discover.js'),
  };
}
