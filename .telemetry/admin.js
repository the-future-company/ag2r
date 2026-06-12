#!/usr/bin/env node
// .telemetry/admin.js — Read/delete Firestore telemetry documents
// Uses Firebase CLI's stored auth token (from previous `firebase login`)
//
// Usage:
//   node .telemetry/admin.js list              # List all events
//   node .telemetry/admin.js delete-all        # Delete all events

const PROJECT_ID = 'ag2r-telemetry';
const COLLECTION = 'telemetry';
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

// Get access token from Firebase CLI's stored credentials
async function getToken() {
  const { execSync } = await import('child_process');

  // firebase-tools stores a refresh token — we can use it to get an access token
  const fs = await import('fs');
  const path = await import('path');
  const os = await import('os');

  const configPath = path.join(os.homedir(), '.config', 'configstore', 'firebase-tools.json');
  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    throw new Error('No Firebase CLI credentials found. Run: npx firebase-tools login');
  }

  const refreshToken = config.tokens?.refresh_token;
  if (!refreshToken) throw new Error('No refresh token in Firebase CLI config');

  // Exchange refresh token for access token
  const clientId = config.tokens?.client_id || '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com';
  const clientSecret = config.tokens?.client_secret || 'j9iVZfS8kkCEFUPaAeJV0sAi';

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  if (!res.ok) throw new Error(`Token refresh failed: ${await res.text()}`);
  const data = await res.json();
  return data.access_token;
}

// Parse Firestore value to JS
function parseValue(v) {
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.integerValue !== undefined) return parseInt(v.integerValue);
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.booleanValue !== undefined) return v.booleanValue;
  if (v.nullValue !== undefined) return null;
  if (v.mapValue) {
    const obj = {};
    for (const [k, mv] of Object.entries(v.mapValue.fields || {})) {
      obj[k] = parseValue(mv);
    }
    return obj;
  }
  return JSON.stringify(v);
}

// List all documents
async function listAll(token) {
  let allDocs = [];
  let pageToken = '';

  do {
    const url = `${BASE}/${COLLECTION}?pageSize=300${pageToken ? '&pageToken=' + pageToken : ''}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`List failed: ${await res.text()}`);
    const data = await res.json();

    const docs = (data.documents || []).map(doc => {
      const parsed = {};
      for (const [k, v] of Object.entries(doc.fields || {})) {
        parsed[k] = parseValue(v);
      }
      parsed._path = doc.name;
      return parsed;
    });

    allDocs = allDocs.concat(docs);
    pageToken = data.nextPageToken || '';
  } while (pageToken);

  return allDocs;
}

// Delete a single document by full path
async function deleteDoc(token, fullPath) {
  const url = `https://firestore.googleapis.com/v1/${fullPath}`;
  const res = await fetch(url, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
  return res.ok;
}

// ─────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────

const action = process.argv[2] || 'dashboard';

try {
  const token = await getToken();

  if (action === 'list') {
    const docs = await listAll(token);
    if (docs.length === 0) {
      console.log('\n  No telemetry events found.\n');
      process.exit(0);
    }

    console.log(`\n  ${docs.length} events:\n`);
    for (const doc of docs) {
      const { _path, ...rest } = doc;
      const ts = rest.timestamp || '';
      const event = rest.event || '?';
      console.log(`  ${ts.substring(0, 19)}  ${event.padEnd(22)}  ${JSON.stringify(rest)}`);
    }
    console.log();

  } else if (action === 'dashboard') {
    const docs = await listAll(token);
    if (docs.length === 0) {
      console.log('\n  📊 No telemetry events yet.\n');
      process.exit(0);
    }

    // Sort by timestamp
    docs.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));

    // Time range
    const first = docs[0]?.timestamp?.substring(0, 19) || '?';
    const last = docs[docs.length - 1]?.timestamp?.substring(0, 19) || '?';

    // Count by event type
    const counts = {};
    const byDay = {};
    for (const doc of docs) {
      const event = doc.event || 'unknown';
      counts[event] = (counts[event] || 0) + 1;
      const day = (doc.timestamp || '').substring(0, 10);
      if (day) {
        byDay[day] = byDay[day] || {};
        byDay[day][event] = (byDay[day][event] || 0) + 1;
        byDay[day]._total = (byDay[day]._total || 0) + 1;
      }
    }

    // Sort by count desc
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    const maxName = Math.max(...sorted.map(([k]) => k.length), 5);

    console.log('\n  ╔══════════════════════════════════════════╗');
    console.log('  ║        📊 AG2R Telemetry Dashboard       ║');
    console.log('  ╚══════════════════════════════════════════╝\n');

    console.log(`  Total events: ${docs.length}`);
    console.log(`  Time range:   ${first} → ${last}\n`);

    // Event counts table
    console.log('  ┌─' + '─'.repeat(maxName) + '──┬───────┐');
    console.log('  │ ' + 'Event'.padEnd(maxName) + '  │ Count │');
    console.log('  ├─' + '─'.repeat(maxName) + '──┼───────┤');
    for (const [event, count] of sorted) {
      const bar = '█'.repeat(Math.min(count, 20));
      console.log(`  │ ${event.padEnd(maxName)}  │ ${String(count).padStart(5)} │ ${bar}`);
    }
    console.log('  └─' + '─'.repeat(maxName) + '──┴───────┘\n');

    // Per-day summary
    const days = Object.keys(byDay).sort();
    if (days.length > 0) {
      console.log('  📅 Daily Activity:');
      for (const day of days) {
        const dayData = byDay[day];
        const total = dayData._total;
        const topEvents = Object.entries(dayData)
          .filter(([k]) => k !== '_total')
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([k, v]) => `${k}:${v}`)
          .join(', ');
        console.log(`  ${day}  ${String(total).padStart(4)} events  (${topEvents})`);
      }
      console.log();
    }

    // Last 10 events
    const recent = docs.slice(-10).reverse();
    console.log('  🕐 Recent Events:');
    for (const doc of recent) {
      const ts = (doc.timestamp || '').substring(11, 19);
      const event = doc.event || '?';
      const extras = [];
      if (doc.type) extras.push(`type=${doc.type}`);
      if (doc.label) extras.push(`label=${doc.label}`);
      if (doc.endpoint) extras.push(`endpoint=${doc.endpoint}`);
      if (doc.count) extras.push(`count=${doc.count}`);
      if (doc.message) extras.push(`msg=${doc.message.substring(0, 40)}`);
      const detail = extras.length ? `  (${extras.join(', ')})` : '';
      console.log(`  ${ts}  ${event}${detail}`);
    }
    console.log();

  } else if (action === 'delete-all') {
    const docs = await listAll(token);
    if (docs.length === 0) {
      console.log('\n  Nothing to delete.\n');
      process.exit(0);
    }

    console.log(`\n  Deleting ${docs.length} documents...`);
    let deleted = 0;
    for (const doc of docs) {
      if (await deleteDoc(token, doc._path)) deleted++;
    }
    console.log(`  ✅ Deleted ${deleted}/${docs.length} documents.\n`);

  } else {
    console.error(`Unknown action: ${action}\nUsage: node .telemetry/admin.js [dashboard|list|delete-all]`);
    process.exit(1);
  }
} catch (e) {
  console.error('❌', e.message);
  process.exit(1);
}
