// hub.js — AG2R Multi-Worktree Hub
// Dev-only proxy that auto-detects running AG2R dev servers via port scanning
// and multiplexes them behind a single port for tunnel access.
// The app (server.js, app.js) has zero awareness of this hub.
// See ONBOARDING.md § "Testing Across Worktrees" for usage.

import { createServer as createHttpsServer } from 'https';
import { request as httpsRequest } from 'https';
import { createHash } from 'crypto';
import tls from 'tls';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import selfsigned from 'selfsigned';
import dotenv from 'dotenv';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────
const HUB_PORT = parseInt(process.env.HUB_PORT || '3100');
const SCAN_MIN = parseInt(process.env.HUB_SCAN_MIN || '3001');
const SCAN_MAX = parseInt(process.env.HUB_SCAN_MAX || '3099');
const SCAN_INTERVAL = parseInt(process.env.HUB_SCAN_INTERVAL || '5000');

// Cache-busting hash for static assets — changes when file content changes
function fileHash(filePath) {
  try {
    return createHash('md5').update(fs.readFileSync(filePath)).digest('hex').slice(0, 8);
  } catch { return Date.now().toString(36); }
}
const ICON_HASH = fileHash(path.join(__dirname, 'public', 'ag2r-icon.png'));

function log(prefix, ...args) {
  console.log(`[${prefix}]`, ...args);
}

// ─────────────────────────────────────────────
// SSL Certificate (same pattern as server.js)
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
      days: 365, keySize: 2048, algorithm: 'sha256',
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
// Port Scanning & Server Detection
// ─────────────────────────────────────────────

// Map<port, { name, port, status }> — only running servers
const activeServers = new Map();

// Probe a single port for an AG2R health endpoint
function probePort(port) {
  return new Promise((resolve) => {
    const req = httpsRequest({
      hostname: '127.0.0.1',
      port,
      path: '/health',
      method: 'GET',
      rejectUnauthorized: false,
      timeout: 500,
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (data.status === 'ok') {
            resolve({ port, health: data });
            return;
          }
        } catch { /* not AG2R */ }
        resolve(null);
      });
    });

    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

// Use lsof to find which worktree a port's process belongs to
function identifyWorktree(port) {
  try {
    // Find PID listening on this port
    const lsofOutput = execSync(
      `lsof -i :${port} -sTCP:LISTEN -t 2>/dev/null`,
      { encoding: 'utf-8', timeout: 2000 }
    ).trim();

    const pid = lsofOutput.split('\n')[0];
    if (!pid) return null;

    // Get the CWD of this process (-a = AND the filters)
    const cwdOutput = execSync(
      `lsof -a -p ${pid} -d cwd -Fn 2>/dev/null`,
      { encoding: 'utf-8', timeout: 2000 }
    ).trim();

    // Parse lsof output: lines starting with 'n/' contain the path
    const cwdLine = cwdOutput.split('\n').find(l => l.startsWith('n/'));
    if (!cwdLine) return null;

    const cwd = cwdLine.slice(1); // remove 'n' prefix
    // Extract the worktree name (last directory component)
    return path.basename(cwd);
  } catch {
    return null;
  }
}

// Scan all ports and update activeServers
async function scanPorts() {
  // Probe all ports in parallel
  const probes = [];
  for (let port = SCAN_MIN; port <= SCAN_MAX; port++) {
    probes.push(probePort(port));
  }

  const results = await Promise.all(probes);
  const foundPorts = new Set();

  for (const result of results) {
    if (!result) continue;
    const { port, health } = result;
    foundPorts.add(port);

    if (!activeServers.has(port)) {
      // New server detected — identify its worktree
      const name = identifyWorktree(port) || `port-${port}`;
      activeServers.set(port, { name, port, cdpConnected: health.cdpConnected });
      log('Scan', `Detected "${name}" on port ${port}`);
    } else {
      // Update health status
      const server = activeServers.get(port);
      server.cdpConnected = health.cdpConnected;
    }
  }

  // Remove servers that are no longer responding
  for (const [port, server] of activeServers) {
    if (!foundPorts.has(port)) {
      log('Scan', `"${server.name}" on port ${port} is gone`);
      activeServers.delete(port);
    }
  }
}

// Find a server entry by worktree name
function findServerByName(name) {
  for (const [port, server] of activeServers) {
    if (server.name === name) return { port, ...server };
  }
  return null;
}

// ─────────────────────────────────────────────
// Cookie Helpers
// ─────────────────────────────────────────────
const COOKIE_NAME = 'ag2r_wt';

function parseCookies(header) {
  const cookies = {};
  if (!header) return cookies;
  header.split(';').forEach(pair => {
    const [name, ...rest] = pair.trim().split('=');
    if (name) cookies[name.trim()] = decodeURIComponent(rest.join('='));
  });
  return cookies;
}

function getServerFromCookie(req) {
  const cookies = parseCookies(req.headers.cookie);
  const name = cookies[COOKIE_NAME];
  if (!name) return null;
  return findServerByName(name);
}

function setWorktreeCookie(res, name) {
  res.setHeader('Set-Cookie',
    `${COOKIE_NAME}=${encodeURIComponent(name)}; Path=/; HttpOnly; SameSite=Lax`
  );
}

function clearWorktreeCookie(res) {
  res.setHeader('Set-Cookie',
    `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
  );
}

// ─────────────────────────────────────────────
// HTTP Reverse Proxy
// ─────────────────────────────────────────────
function proxyRequest(req, res, childPort, wtName) {
  const proxyReq = httpsRequest({
    hostname: '127.0.0.1',
    port: childPort,
    path: req.url,
    method: req.method,
    headers: {
      ...req.headers,
      host: `127.0.0.1:${childPort}`,
      'accept-encoding': 'identity', // disable compression so we can inject
    },
    rejectUnauthorized: false,
  }, (proxyRes) => {
    // Rewrite Location headers to include worktree prefix
    if (wtName && proxyRes.headers.location) {
      const loc = proxyRes.headers.location;
      if (loc.startsWith('/') && !loc.startsWith('/' + wtName)) {
        proxyRes.headers.location = '/' + wtName + loc;
      }
    }

    const contentType = proxyRes.headers['content-type'] || '';
    const isHtml = contentType.includes('text/html');

    if (isHtml && wtName) {
      // Buffer HTML to inject hub banner
      const chunks = [];
      proxyRes.on('data', (chunk) => chunks.push(chunk));
      proxyRes.on('end', () => {
        let body = Buffer.concat(chunks).toString('utf-8');
        const script = `<script>document.addEventListener('DOMContentLoaded',()=>{const t=document.querySelector('.header-title');if(t)t.innerHTML='AG2R <span style="font-size:0.5em;opacity:0.6;font-weight:400">:${childPort} ${wtName}<\/span>';})<\/script>`;
        body = body.replace('</head>', script + '</head>');
        delete proxyRes.headers['content-length'];
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        res.end(body);
      });
    } else {
      // Non-HTML: pipe through unchanged
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    }
  });

  proxyReq.on('error', (err) => {
    console.debug(`[Proxy] Error: ${err.message}`);
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('Bad Gateway — child server not responding');
  });

  req.pipe(proxyReq);
}

// ─────────────────────────────────────────────
// WebSocket Proxy
// ─────────────────────────────────────────────
function proxyWebSocket(req, clientSocket, head, childPort) {
  const proxySocket = tls.connect({
    host: '127.0.0.1',
    port: childPort,
    rejectUnauthorized: false,
  }, () => {
    let upgradeReq = `${req.method} ${req.url} HTTP/1.1\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      if (req.rawHeaders[i].toLowerCase() === 'host') {
        upgradeReq += `Host: 127.0.0.1:${childPort}\r\n`;
      } else {
        upgradeReq += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
      }
    }
    upgradeReq += '\r\n';

    proxySocket.write(upgradeReq);
    if (head.length > 0) proxySocket.write(head);

    proxySocket.pipe(clientSocket);
    clientSocket.pipe(proxySocket);
  });

  proxySocket.on('error', (err) => {
    console.debug(`[WS Proxy] Error: ${err.message}`);
    clientSocket.destroy();
  });

  clientSocket.on('error', () => {
    proxySocket.destroy();
  });
}

// ─────────────────────────────────────────────
// Landing Page
// ─────────────────────────────────────────────
function renderLandingPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <meta name="theme-color" content="#101010">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <title>AG2R Hub</title>
  <link rel="icon" type="image/png" href="/ag2r-icon.png?v=${ICON_HASH}">
  <link rel="apple-touch-icon" href="/ag2r-icon.png?v=${ICON_HASH}">
  <link rel="manifest" href="/manifest.json">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Material+Symbols+Rounded:opsz,wght,FILL,GRAD@24,400,1,0&display=swap">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg: #101010;
      --surface: #1a1a1a;
      --surface-hover: #222;
      --border: #2a2a2a;
      --border-subtle: #1f1f1f;
      --text: #e0e0e0;
      --text-dim: #707070;
      --text-muted: #505050;
      --accent: #007acc;
      --accent-dim: rgba(0, 122, 204, 0.15);
      --accent-glow: rgba(0, 122, 204, 0.3);
      --green: #22c55e;
      --green-dim: rgba(34, 197, 94, 0.15);
      --red: #ef4444;
      --amber: #f59e0b;
      --radius: 14px;
      --radius-sm: 10px;
    }

    body {
      font-family: 'Inter', system-ui, sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100dvh;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 20px 16px;
      -webkit-font-smoothing: antialiased;
    }

    /* ── Header ── */
    .hub-header {
      display: flex;
      align-items: center;
      gap: 14px;
      margin-bottom: 28px;
      width: 100%;
      max-width: 480px;
    }

    .hub-header img {
      width: 48px;
      height: 48px;
      border-radius: 12px;
    }

    .hub-header-text { display: flex; flex-direction: column; }

    .hub-logo {
      font-size: 22px;
      font-weight: 700;
      letter-spacing: -0.5px;
      color: var(--text);
    }

    .hub-subtitle {
      font-size: 12px;
      color: var(--text-dim);
      margin-top: 1px;
      letter-spacing: 0.5px;
      text-transform: uppercase;
    }

    /* ── Section Label ── */
    .section-label {
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 1.2px;
      color: var(--text-muted);
      width: 100%;
      max-width: 480px;
      margin-bottom: 10px;
      padding-left: 2px;
    }

    /* ── Server List ── */
    .server-list {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 8px;
      width: 100%;
      max-width: 480px;
    }

    .server-card {
      align-self: stretch;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 14px 16px;
      display: flex;
      align-items: center;
      gap: 12px;
      transition: border-color 0.2s, background 0.2s;
      text-decoration: none;
      color: inherit;
      cursor: pointer;
    }

    .server-card:hover { background: var(--surface-hover); border-color: var(--accent); }

    .server-dot {
      width: 8px; height: 8px;
      border-radius: 50%;
      background: var(--green);
      flex-shrink: 0;
      box-shadow: 0 0 6px rgba(34, 197, 94, 0.4);
    }

    .server-info { flex: 1; min-width: 0; }

    .server-name {
      font-size: 14px;
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .server-meta {
      font-size: 11px;
      color: var(--text-dim);
      margin-top: 2px;
      font-family: 'Inter', monospace;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .server-arrow {
      color: var(--text-muted);
      font-size: 18px;
      flex-shrink: 0;
    }

    /* ── Empty State ── */
    .empty-state {
      text-align: center;
      color: var(--text-dim);
      padding: 40px 20px;
      max-width: 400px;
    }

    .empty-state .material-symbols-rounded {
      font-size: 40px;
      opacity: 0.2;
      display: block;
      margin-bottom: 14px;
    }

    .empty-title {
      font-size: 15px;
      font-weight: 500;
      color: var(--text);
      margin-bottom: 6px;
    }

    .empty-hint {
      font-size: 12px;
      line-height: 1.5;
    }

    .empty-hint code {
      background: var(--surface);
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 11px;
    }

    .scan-info {
      font-size: 10px;
      color: var(--text-muted);
      margin-top: 24px;
      text-align: center;
      letter-spacing: 0.3px;
    }
  </style>
</head>
<body>
  <div class="hub-header">
    <img src="/ag2r-icon.png?v=${ICON_HASH}" alt="AG2R">
    <div class="hub-header-text">
      <div class="hub-logo">AG2R Hub</div>
      <div class="hub-subtitle">Dev Sessions</div>
    </div>
  </div>

  <div class="section-label">Active Sessions</div>
  <div id="server-list" class="server-list"></div>

  <div class="scan-info">Scanning ports ${SCAN_MIN}\u2013${SCAN_MAX} every ${SCAN_INTERVAL / 1000}s</div>

  <script>
    const list = document.getElementById('server-list');
    let lastData = null;

    async function refresh() {
      try {
        const res = await fetch('/_hub/api/status');
        const data = await res.json();
        const json = JSON.stringify(data);
        if (json === lastData) return;
        lastData = json;
        render(data.servers);
      } catch (e) {
        console.debug('Status fetch error:', e);
      }
    }

    function render(servers) {
      if (servers.length === 0) {
        list.innerHTML = '<div class="empty-state">'
          + '<span class="material-symbols-rounded">dns</span>'
          + '<div class="empty-title">No active dev sessions</div>'
          + '<div class="empty-hint">Start a server in any worktree:<br>'
          + '<code>PORT=3001 node server.js</code><br>'
          + 'It will appear here automatically.</div>'
          + '</div>';
        return;
      }

      list.innerHTML = servers.map(s => {
        let html = '<div class="server-card">';
        html += '<div class="server-dot"></div>';
        html += '<a href="/' + escapeAttr(s.name) + '/" style="flex:1;min-width:0;text-decoration:none;color:inherit">';
        html += '<div class="server-name">' + escapeHtml(s.name) + '</div>';
        html += '<div class="server-meta">';
        html += 'port ' + s.port + (s.cdpConnected ? ' \\u00b7 CDP connected' : ' \\u00b7 CDP off');
        html += '</div></a>';
        html += '<a href="/' + escapeAttr(s.name) + '/" style="text-decoration:none;color:inherit;display:flex"><span class="material-symbols-rounded server-arrow">chevron_right</span></a>';
        html += '</div>';
        return html;
      }).join('');
    }

    function escapeHtml(s) {
      return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }
    function escapeAttr(s) {
      return s.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
    }

    refresh();
    setInterval(refresh, 3000);
  </script>
</body>
</html>`;
}

// ─────────────────────────────────────────────
// Request Handler
// ─────────────────────────────────────────────
function handleRequest(req, res) {
  const url = new URL(req.url, 'https://localhost');
  const pathname = url.pathname;

  // ── Hub API routes ──
  if (pathname.startsWith('/_hub/')) {
    return handleHubApi(req, res, pathname);
  }

  // ── Check for worktree prefix: /<name>/... ──
  const firstSegment = pathname.split('/')[1];
  if (firstSegment) {
    const server = findServerByName(firstSegment);
    if (server) {
      // Set routing cookie and strip prefix
      setWorktreeCookie(res, firstSegment);
      const stripped = pathname.slice(firstSegment.length + 1) || '/';
      req.url = stripped + (url.search || '');
      return proxyRequest(req, res, server.port, firstSegment);
    }
  }

  // ── PWA assets (served directly by hub for landing page) ──
  if (pathname === '/ag2r-icon.png' || pathname === '/manifest.json' || pathname === '/favicon.png') {
    const filePath = path.join(__dirname, 'public', pathname);
    if (fs.existsSync(filePath)) {
      const ext = path.extname(filePath);
      const mimeTypes = { '.png': 'image/png', '.json': 'application/json' };
      res.writeHead(200, {
        'Content-Type': mimeTypes[ext] || 'application/octet-stream',
        'Cache-Control': 'public, max-age=86400',
      });
      res.end(fs.readFileSync(filePath));
      return;
    }
  }

  // ── Root path — always show landing page ──
  if (pathname === '/' || pathname === '') {
    clearWorktreeCookie(res);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderLandingPage());
    return;
  }

  // ── Cookie-routed requests ──
  const server = getServerFromCookie(req);
  if (server) {
    return proxyRequest(req, res, server.port, server.name);
  }

  // ── No routing info — landing page ──
  res.writeHead(302, { Location: '/' });
  res.end();
}

// ─────────────────────────────────────────────
// Hub API
// ─────────────────────────────────────────────
function handleHubApi(req, res, pathname) {
  res.setHeader('Content-Type', 'application/json');

  // GET /_hub/api/status
  if (pathname === '/_hub/api/status' && req.method === 'GET') {
    const servers = [];
    for (const [port, server] of activeServers) {
      servers.push({ name: server.name, port, cdpConnected: server.cdpConnected });
    }
    servers.sort((a, b) => a.name.localeCompare(b.name));
    res.writeHead(200);
    res.end(JSON.stringify({ servers }));
    return;
  }

  // GET /_hub/api/clear-cookie
  if (pathname === '/_hub/api/clear-cookie') {
    clearWorktreeCookie(res);
    res.writeHead(302, { Location: '/', 'Content-Type': 'text/plain' });
    res.end('Redirecting...');
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found' }));
}

// ─────────────────────────────────────────────
// Server Startup
// ─────────────────────────────────────────────
async function start() {
  const sslOpts = ensureCerts();
  const server = createHttpsServer(sslOpts, handleRequest);

  // WebSocket upgrade handler
  server.on('upgrade', (req, socket, head) => {
    const pathname = new URL(req.url, 'https://localhost').pathname;
    const firstSegment = pathname.split('/')[1];

    // Check for worktree prefix
    if (firstSegment) {
      const srv = findServerByName(firstSegment);
      if (srv) {
        const stripped = pathname.slice(firstSegment.length + 1) || '/';
        req.url = stripped;
        return proxyWebSocket(req, socket, head, srv.port);
      }
    }

    // Cookie-based routing
    const srv = getServerFromCookie(req);
    if (srv) {
      return proxyWebSocket(req, socket, head, srv.port);
    }

    socket.destroy();
  });

  server.listen(HUB_PORT, () => {
    log('Hub', `AG2R Hub running on https://localhost:${HUB_PORT}`);
    log('Hub', `Scanning ports ${SCAN_MIN}–${SCAN_MAX} every ${SCAN_INTERVAL / 1000}s`);
  });

  // Initial scan
  await scanPorts();
  if (activeServers.size > 0) {
    log('Hub', `Detected ${activeServers.size} running server(s)`);
  } else {
    log('Hub', 'No running servers detected. Start one with: PORT=3001 node server.js');
  }

  // Periodic scanning
  const scanTimer = setInterval(scanPorts, SCAN_INTERVAL);

  // Graceful shutdown
  const shutdown = () => {
    log('Hub', 'Shutting down...');
    clearInterval(scanTimer);
    server.close(() => {
      log('Hub', 'Goodbye.');
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 3000);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

start().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
