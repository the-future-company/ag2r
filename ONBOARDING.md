# ONBOARDING.md — Agent Technical Reference

> This file is the technical reference for AI coding agents. For project overview, see [README.md](./README.md). For behavioral rules, see [GEMINI.md](./GEMINI.md).

---

## 📋 File Boundary Framework

| Question | Answer → File |
|----------|---------------|
| "Would a human contributor or visitor need this?" | **README.md** |
| "Is this telling the agent *what exists and how things work*?" | **ONBOARDING.md** (this file) |
| "Is this telling the agent *how to behave*?" | **GEMINI.md** |

**ONBOARDING.md is the manual. GEMINI.md is the manager.**

---

## 🗺 Context Map (Pointers Only)

> **Rule:** This section contains ONE-LINE POINTERS to entry-point files. Never describe behavior here — the agent reads the code for truth. See GEMINI.md § Documentation Philosophy for the full rationale.

<!-- Update this section as files are added. One line per file. -->

| Concern | Entry Point |
|---------|-------------|
| Server (CDP, WebSocket, Express, auth) | `server.js` |
| Click proxying (`POST /click`) + sidebar capture | `server.js` — search `CAPTURE_SCRIPT` and `/click` |
| Sidebar DOM discovery (temporary diagnostic) | `server.js` — search `DISCOVER_SCRIPT` and `/discover` |
| Client rendering, WebSocket, stop/send | `public/js/app.js` |
| Right sidebar toggle, click proxy handlers | `public/js/app.js` — search `openRightSidebar` and `addClickProxyHandlers` |
| Permission banner capture + click proxy (`perm:` prefix) | `server.js` — search `permissionHtml` and `'perm'` |
| Mobile UI structure | `public/index.html` |
| Login page | `public/login.html` |
| Mobile-first styles (minimal CDP overrides) | `public/css/style.css` |
| Environment config template (SSoT for config) | `.env.example` |
| Project dependencies (SSoT for versions) | `package.json` |
| Self-signed SSL certs (auto-generated, gitignored) | `certs/` |

---

## ⚠️ Gotchas & Landmines

> Things you would NOT discover by reading the code alone. Keep this section compact.

- **AG2.0 has no stable DOM IDs.** Unlike Windsurf (`#conversation`, `#chat`, `#cascade`), AG2.0 uses Tailwind classes. Chat container is found via `.scrollbar-hide[class*="overflow-y-auto"]` or `[data-testid="conversation-view"]`. Any selector-based approach is fragile.
- **Two execution contexts.** AG2.0 Electron exposes default + isolated contexts that produce slightly different CSS. `server.js` locks to a `preferredContextId` to prevent hash oscillation. If you see alternating snapshots, this lock is failing.
- **`[object Object]` class names during streaming.** AG2.0 wraps streaming words in `<span class="[object Object]">`. The capture script strips these via regex on the HTML string AFTER extraction (not DOM query — bracket chars break CSS selectors).
- **Sticky user prompts.** User's last prompt has `position: sticky` in AG2.0's CSS. The capture script marks these with `data-ag-sticky` and forces `backgroundColor: #101010` on the clone. AG2R does NOT override sticky — AG2.0's own CSS handles it.
- **`div` inside `span`/`p`.** AG2.0 nests block elements inside inline elements for file-type icons. Browsers auto-close the inline parent, causing line breaks. Capture script converts nested `<div>` to `<span style="display: inline-flex">`.
- **CDP overrides are minimal.** We stripped all CSS overrides (colors, spacing, code blocks, etc.) to let AG2.0's own injected CSS handle styling. Only scrollbar hiding and broken image suppression remain in our CSS.
- **Never wipe cached content.** If snapshot capture returns null (no chat container found), the server keeps the last valid snapshot. The client never clears `chatContent.innerHTML` based on a failed selector check.
- **Local network auth bypass.** Requests from 127.x/192.168.x/10.x are auto-authenticated, but only if no proxy headers (X-Forwarded-For, CF-Connecting-IP) are present.
- **Right sidebar selector is fragile.** The AG right panel is found via position-based heuristic (elements right of viewport midpoint containing "Overview" + "Review" text). There are no stable IDs or data-testids. If AG's layout changes, the sidebar capture may fail silently (returns null). Use `GET /discover` to debug.
- **Click proxy indices are ephemeral.** `data-ag-click-id` is assigned per snapshot by iterating visible `button/a/[role=button]` elements in DOM order. If the DOM changes between snapshot capture and click proxy execution (e.g., streaming content), the index can point to the wrong element. The label validation in `POST /click` catches most mismatches.
- **Focus emulation (fragile).** `Emulation.setFocusEmulationEnabled({enabled: true})` is called on CDP connect to force AG's page to render while in the background. Without this, collapsible sections ("Worked for", "Thought for") expand structurally but React defers rendering their content, producing empty space. This is a CDP-level hack — if Electron or Chrome changes this API's behavior, it could cause side effects (e.g., cursor blinks, focus stealing). If strange behavior appears, disabling this is the first thing to try.
- **Theme CSS variables extracted from DOM, not stylesheets.** AG defines `--foreground`, `--background`, `--sidebar`, etc. on DOM elements (theme provider), not in stylesheets. The capture script reads these via `getComputedStyle(document.documentElement)` and injects them as a `:root{}` rule. If AG changes how/where it sets theme vars, captured content text could become invisible.
- **Sidebar elements hidden for mobile.** The top 3 actions (New Conversation, History, Scheduled Tasks), the add-project button, and back/forward nav are hidden via CSS attribute selectors in `style.css` (search "Hidden Sidebar Elements") + DOM removal in `app.js` `renderSidebar()`. To re-enable, remove/comment those CSS rules and JS cleanup code.
- **Permission banner lives OUTSIDE the scroll container.** AG renders the permission/approval radiogroup in a `flex-shrink-0` section below the scrollable chat area. Both capture and click proxy must search `document`-wide, not inside `container`. The `input[checked]` HTML attribute is the initial default, not current state — use `bg-secondary` class to detect the selected option.

---

## 🔄 Development Lifecycle

Every workstream follows this exact lifecycle. No exceptions, no shortcuts.

### Phase 1: Branch & Environment Setup (BEFORE any code changes)

**Step 1 — Sync:**
```bash
git fetch origin main && git rebase origin/main
```

**Step 2 — Sanity check:**
- Branch name makes sense for the task → ✅ move on
- **Wrong setup?** → **STOP.** Report to user.

**Step 3 — Install dependencies:**
```bash
npm ci
```

### Phase 2: Implement
1. Agree on the task with the USER.
2. Implement on the feature branch.
3. Verify the server starts cleanly.
4. USER manually tests. Agent does NOT open browsers.

### Phase 3: Commit & PR (when USER says "commit")
```bash
git add -A && git commit -m "feat: description"
git fetch origin main && git rebase origin/main
git push origin feat/<branch-name>

gh pr create --title "feat: description" --base main --head feat/<branch-name> --body "$(cat <<'PRBODY'
## Summary
<1-2 sentences>

## What Changed
- <mechanical change>
- <behavioral change>

## Manual Test Steps
- [ ] Start server with `node server.js`
- [ ] Connect from phone
- [ ] Verify ...
---
PRBODY
)"

gh pr checks <PR#> --watch
gh pr merge <PR#> --squash --admin
```

### Phase 4: Sync main
```bash
git checkout main && git pull --rebase origin main
```

**Session ends ONLY when:** PR is `MERGED` or user says stop.

### Session Handover Prompt

````markdown
# [Title]

Worktree: /path/to/worktree
Branch: feat/branch-name

## What's Done
Current state — what works.

## What's Next
- Task 1
- Task 2

## Context
Gotchas or decisions the next session should know.
````

---

## 🚫 Git Safety

### Banned Operations
| Operation | Why banned |
|-----------|-----------|
| `git reset --hard` / `--soft` | Destroys commits |
| `git checkout -f` / `git checkout -- .` | Discards all changes |
| `git clean -fd` | Deletes untracked files |
| `git push --force` / `--force-with-lease` | Rewrites remote history |
| `git rebase -i` | Rewrites commits |
| `git commit --amend` (after push) | Rewrites pushed history |
| `cherry-pick` | Duplicate commits |

### Safe Alternatives
| Need | Do this |
|------|---------|
| Undo a file | `git checkout -- <file>` |
| Add missed changes | New commit on same branch |
| PR stale | `git fetch origin main && git merge origin/main` |
| Before first push | `git rebase origin/main` is fine |
| After pushing | Merge, never rebase |
| User instructs force-push | Fine — user-directed |

---

## 📝 GitHub Issues

```bash
gh issue create --title "Title" --label "bug,ai agent" --body "..."
gh issue close <number> --comment "Fixed in commit abc123."
gh issue list --label "bug" --state open
```

**Always include `ai agent` label.**
