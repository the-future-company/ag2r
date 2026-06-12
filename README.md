# AG2R — Antigravity 2.0 Remote

A lightweight mobile remote interface for monitoring and interacting with [Antigravity](https://antigravity.dev) AI coding sessions from your phone — on Wi-Fi, hotspot, or anywhere in the world.

<p align="center">
  <img src="docs/hero-mobile.png" alt="AG2R Chat" width="180" />
  &nbsp;&nbsp;
  <img src="docs/review-diff.png" alt="AG2R Code Review" width="180" />
  &nbsp;&nbsp;
  <img src="docs/comment-queued.png" alt="AG2R Comments" width="180" />
  &nbsp;&nbsp;
  <img src="docs/overview-panel.png" alt="AG2R Overview" width="180" />
</p>

---

## 🚀 Getting Started

### Prerequisites

- Node.js 18+
- Antigravity running with CDP enabled:
  ```bash
  antigravity . --remote-debugging-port=9000
  ```

### Setup

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

Use a [Cloudflare tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) to access AG2R from anywhere.

> [!WARNING]
> **Set a strong password before exposing AG2R to the internet.**
>
> ```bash
> # In .env — change these:
> AUTH_ENABLED=true
> APP_PASSWORD=your-strong-password-here
> SESSION_SECRET=$(openssl rand -hex 24)
> TUNNEL_ENABLED=true
> TUNNEL_URL=https://ag2r.yourdomain.com
> ```

**Quick tunnel** (temporary URL, no account needed):

```bash
brew install cloudflared
node server.js
# In a second terminal:
cloudflared tunnel --url https://localhost:3000 --no-tls-verify
```

**Dedicated tunnel** (stable URL with your own domain):

```bash
# One-time setup
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

Run both:

```bash
node server.js                    # Terminal 1
cloudflared tunnel run ag2r       # Terminal 2
```

---

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

### More Features

- **Push notifications** — get notified on your phone when the session needs permission approval, even with the app in the background
- **Send messages** — type and send messages to the AI from your phone
- **Voice input** — dictate messages using your phone's microphone
- **Stop generation** — cancel a running generation with the stop button
- **Auto-reconnect** — seamless reconnection when connection drops
- **Cookie-based auth** — enter passcode once, stays logged in for 30 days

> [!NOTE]
> **iOS users:** Push notifications require the PWA to be installed to your home screen (iOS 16.4+). Open AG2R in Safari, tap the Share button, then "Add to Home Screen".

---

## 🔄 Keep It Running (Optional)

For always-on setups, use the included watchdog scripts. They auto-start AG2R if it crashes and auto-update from `origin/main` when code changes.

```bash
crontab -e

# Add these lines:
*/5 * * * * ~/Workspace/ag2r/scripts/main-watchdog.sh >> /tmp/ag2r-main-watchdog.log 2>&1
*/5 * * * * ~/Workspace/ag2r/scripts/tunnel-watchdog.sh >> /tmp/ag2r-tunnel-watchdog.log 2>&1
```

See `scripts/` for what's available. The dev hub (`hub.js`) has its own watchdog for multi-worktree development — see [ONBOARDING.md](./ONBOARDING.md).

---

## 🤖 For AI Agents

> Start with **[ONBOARDING.md](./ONBOARDING.md)** for the full technical reference (architecture, file maps, workflows). Your behavioral rules are in **[GEMINI.md](./GEMINI.md)**.

## 📊 Telemetry

AG2R collects anonymous usage metrics (feature counts, crash reports — no personal data) to help improve the project. Set `AG2R_TELEMETRY=false` in your `.env` to disable.

## License

MIT — see [LICENSE](./LICENSE) for details.
