<a href="https://buymeacoffee.com/omercanyy" target="_blank"><img src="https://img.shields.io/badge/Buy%20Me%20a%20Coffee-ffdd00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black" align="right" alt="Buy Me A Coffee" /></a>

# AG2R — Antigravity 2.0 Remote

[![Antigravity Compatibility](https://img.shields.io/badge/Last_tested_with_Antigravity-v2.2.1-blue?style=for-the-badge&logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxNiIgaGVpZ2h0PSIxNiIgdmlld0JveD0iMCAwIDE2IDE2Ij48dGV4dCB4PSIyIiB5PSIxMyIgZm9udC1zaXplPSIxMyI+8J+aqDwvdGV4dD48L3N2Zz4=)](https://antigravity.google/releases) <sub>Not working? See [Branching Strategy](#-branching-strategy)</sub>

A lightweight mobile remote interface for monitoring and interacting with [Antigravity](https://antigravity.dev) AI coding sessions from your phone — on Wi-Fi, hotspot, or anywhere in the world.

<table align="center">
  <tr>
    <td align="center"><img src="docs/hero-mobile.png" alt="AG2R Chat" width="180" /><br><sub>Live Chat</sub></td>
    <td align="center"><img src="docs/review-diff.png" alt="AG2R Code Review" width="180" /><br><sub>Code Review</sub></td>
    <td align="center"><img src="docs/comment-queued.png" alt="AG2R Comments" width="180" /><br><sub>Commenting</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="docs/overview-panel.png" alt="AG2R Overview" width="180" /><br><sub>Overview</sub></td>
    <td align="center"><img src="docs/notification-push.jpg" alt="AG2R Push Notifications" width="180" /><br><sub>Notifications</sub></td>
    <td align="center"><img src="docs/subagent-view.jpg" alt="AG2R Subagent View" width="180" /><br><sub>Subagents</sub></td>
  </tr>
</table>

---

## 🚀 Getting Started

### Prerequisites

- Node.js 18+
- Antigravity launched with CDP enabled: `open -a Antigravity --args --remote-debugging-port=9000`

### Quick Start

```bash
git clone git@github.com:the-future-company/ag2r.git
cd ag2r
npm install
cp .env.example .env
node server.js
```

That's it — AG2R is running on `https://localhost:3000`. On first run, a self-signed SSL cert is generated in `certs/`.

By default **auth is off** — no login needed. This is fine for local use. If you're exposing AG2R to the internet (see below), you **must** set a password first.

---

## 🌐 How to Connect

### Option 1: Local Network (Same Wi-Fi)

No extra setup — just start the server and open it on your phone.

1. `node server.js`
2. Open `https://<your-computer-ip>:3000` on your phone
3. Accept the self-signed certificate warning

No password needed for local-only use. Your phone must be on the same Wi-Fi as the computer.

---

### Option 2: Remote Access (Any Network)

Use a [Cloudflare tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) or preferred tunneling setup to access AG2R from anywhere — no port forwarding needed.

> [!WARNING]
> **Set a strong password before exposing AG2R to the internet.** Edit `.env`:
>
> ```bash
> AUTH_ENABLED=true
> APP_PASSWORD=your-strong-password-here
> ```

**Step 1 — Start the tunnel** (gets you a public URL):

```bash
brew install cloudflared
cloudflared tunnel --url https://localhost:3000 --no-tls-verify
```

Cloudflared prints a URL like `https://random-words.trycloudflare.com`.

**Step 2 — Add the URL to `.env`** so push notifications work:

```bash
TUNNEL_ENABLED=true
TUNNEL_URL=https://random-words.trycloudflare.com   # ← paste your URL here
```

**Step 3 — Start AG2R:**

```bash
node server.js
```

Open the tunnel URL on your phone. The URL changes each time you restart the tunnel.
---

### Option 3: Stable URL with your own domain

If you have a domain on Cloudflare, you can set up a permanent tunnel so the URL never changes:

```bash
cloudflared tunnel login
cloudflared tunnel create ag2r
cloudflared tunnel route dns ag2r ag2r.yourdomain.com
```

Create `~/.cloudflared/config.yml`:

```yaml
tunnel: <TUNNEL_ID>
credentials-file: ~/.cloudflared/<TUNNEL_ID>.json

ingress:
  - hostname: ag2r.yourdomain.com
    service: https://localhost:3000
    originRequest:
      noTLSVerify: true
  - service: http_status:404
```

Set `TUNNEL_URL=https://ag2r.yourdomain.com` in `.env`, then run `node server.js` and `cloudflared tunnel run ag2r` in separate terminals.

## 📱 Features

### Real-time Chat Monitoring

See Antigravity's responses as they stream in real time. Code blocks, markdown, and all formatting render on your phone exactly as they appear on desktop.

<p align="center">
  <img src="docs/hero-mobile.png" alt="Real-time chat monitoring" width="320" />
</p>

---

### Permission Handling

Approve, deny, or skip permission requests remotely. Select an option, hit Submit, and the agent continues — no need to walk back to your computer.

<p align="center">
  <img src="docs/permission-banner.png" alt="Permission banner on mobile" width="320" />
  &nbsp;&nbsp;&nbsp;
  <img src="docs/overview-with-permission.png" alt="Permission dialog on mobile" width="320" />
</p>

---

### Code Review

Review file changes directly on your phone. See diffs, browse modified files, and navigate between Overview and Review tabs.

<p align="center">
  <img src="docs/review-file-list.png" alt="Review changes file list" width="320" />
  &nbsp;&nbsp;&nbsp;
  <img src="docs/review-diff.png" alt="Code diff view" width="320" />
</p>
---

### Commenting

Select text on any document, leave comments with context, and queue them for batch sending. Comments capture the selected text as a quote and your annotation.

<p align="center">
  <img src="docs/comment-add.png" alt="Add Comment dialog" width="320" />
  &nbsp;&nbsp;&nbsp;
  <img src="docs/comment-queued.png" alt="Queued Comments modal" width="320" />
</p>

---

### Sidebar Navigation & Overview

Switch between conversations, browse files changed, artifacts, and background tasks — all from the sidebar and overview panel.

<p align="center">
  <img src="docs/sidebar-conversations.png" alt="Sidebar conversation list" width="300" />
  &nbsp;&nbsp;&nbsp;
  <img src="docs/overview-panel.png" alt="Overview panel" width="320" />
</p>

---

### Desktop & Tablet Support

<p align="center">
  <img src="docs/hero-desktop.png" alt="AG2R Review Changes — Desktop" width="700" />
</p>
<p align="center">
  <img src="docs/chat-monitoring.png" alt="AG2R Chat — Desktop" width="700" />
</p>
<p align="center">
  <img src="docs/permission-save-rule.png" alt="AG2R Permission Dialog — Desktop" width="700" />
</p>
<p align="center">
  <em>Compatible with tablets or desktops as well</em>
</p>

---

### Push Notifications

Get notified on your phone when the session needs permission approval — even with the app in the background. Tap the notification to jump straight to the pending request.

<p align="center">
  <img src="docs/notification-push.jpg" alt="Push notification on Android" width="320" />
</p>

> [!NOTE]
> **iOS:** Push notifications require the PWA to be installed to your home screen (iOS 16.4+). Open AG2R in Safari, tap Share → "Add to Home Screen."
>
> **Android:** If Chrome doesn't prompt for notifications, go to Chrome **Settings → Site settings → Notifications** and set "How to show requests" to **"Expand all requests"**. Then reload the page and tap anywhere to trigger the prompt.

---

### More Features

- **Send messages** — type and send messages to the AI from your phone
- **Voice input** — dictate messages using your phone's microphone
- **Stop generation** — cancel a running generation with the stop button
- **Auto-reconnect** — seamless reconnection when connection drops
- **Cookie-based auth** — enter passcode once, stays logged in for 30 days

---

## 🔄 Keep It Running (Optional)

A watchdog script can keep AG2R running and auto-update from the branch you're on. It detects the current branch, pulls new commits, and restarts the server when code changes.

```bash
# Run once to start (or add to cron for auto-recovery)
AG2R_PORT=3000 ./scripts/watchdog.sh
```

**Cron setup** (checks every 5 minutes):

```bash
crontab -e
# Add this line:
*/5 * * * * cd ~/ag2r && AG2R_PORT=3000 ./scripts/watchdog.sh >> /tmp/ag2r-watchdog.log 2>&1
```

The watchdog auto-detects branch changes. If you switch branches (`git checkout next`), the next watchdog cycle restarts the server with the correct code — no manual restart needed. Your `.env` is gitignored and persists across branch switches.

The `tunnel-watchdog.sh` script can similarly keep a Cloudflare tunnel alive.

---

## 🌿 Branching Strategy

| Branch | Purpose | Stability |
|--------|---------|----------|
| `main` | Current stable version — works with the AG version shown in the badge above | ✅ Stable |
| `prev-stable` | Previous stable version — frozen snapshot of `main` before the latest merge | ✅ Stable |
| `next` | Bleeding edge — being tested against an upcoming AG version | ⚠️ May break |

### How it works

When a new Antigravity version ships, the developer's workflow is:

1. Work on `next` to adapt AG2R to the new AG version
2. Once `next` is working, snapshot `main` → `prev-stable` and merge `next` → `main`
3. Continue fixing bugs on `next` and merging to `main` until stable
4. When things settle, `main` and `next` converge to the same state

### Which branch should I use?

**Start with `main`.** It works with the AG version shown in the badge at the top.

If `main` is broken (typically right after a new AG release), use `prev-stable` — it's a frozen snapshot that works with the previous AG version. Install that AG version and use `prev-stable` until `main` is updated.

```bash
# Fall back to the previous stable version
git checkout prev-stable
git pull origin prev-stable
```

If you want the absolute latest (and don't mind occasional breakage):

```bash
git checkout next
git pull origin next
```

> [!WARNING]
> The `next` branch may be unstable. Use `main` for a reliable experience, or `prev-stable` as a fallback.

---

## 📊 Telemetry

AG2R collects anonymous usage metrics (feature counts, crash reports — no personal data) to help improve the project. Set `AG2R_TELEMETRY=false` in your `.env` to disable.

## License

MIT — see [LICENSE](./LICENSE) for details.
