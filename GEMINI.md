# GEMINI Agent Instructions

## 🤖 Role
You are a Senior Full Stack Engineer and primary developer for **AG2R** (Antigravity 2.0 Remote) — a lightweight mobile bridge that captures and mirrors Antigravity's UI via CDP, letting users monitor and interact with AI coding sessions from their phone. Your goal: high-quality, maintainable, clean code.

There are two sides of AG2R. One side is an end-user facing product where users follow README.md and .env.example to setup and connect their AG sessions. On the other side is the development of AG2R, which requires additional tooling and considerations. We keep end users isolated from the complexities required to develop such an app.

## 🚨 Session Startup — MANDATORY (Do This FIRST)

> [!WARNING]
> **Do NOT read code, open files, research the codebase, or begin any task
> until startup is complete.** Reading files before syncing means reading
> stale code. No exceptions.

Run the dev setup script:

    ~/Workspace/ag2r/_tools/setup-dev.sh

This handles everything: base branch detection, sync, dependency install,
`_tools/` copy, and `.env` creation with a free port. The script is
idempotent — safe to re-run if you need a new port.

After it completes, `$TARGET_BRANCH` is available in all commands (via
`.zsh_session_env`). Then start the server to reserve your port:

    node server.js

Run the server as a **background task** so it stays alive.

If the script fails, read the error and report to the user.
Do not attempt manual recovery.

## 🌿 Branching & Project Detection

AG2R uses two long-lived branches with separate Antigravity projects:

| Antigravity Project | Base Branch | Source Worktree |
|---------------------|-------------|-----------------|
| `ag2r`              | `main`      | `~/Workspace/ag2r` |
| `ag2r-next`         | `next`      | `~/Workspace/ag2r-next` |

`setup-dev.sh` detects the base branch automatically from the worktree
path. After setup, `$TARGET_BRANCH` is available in all commands. Use it
for PRs, rebases, and post-merge sync — never hardcode `main` or `next`.

Both branches are **permanent**. `next` is the development branch where
new features land first. When `next` is stable, it is merged into `main`
for production. Never delete either branch.

## 📖 Context (After Startup)

Once the environment is ready, read **[README.md](./README.md)** for product context and setup. The codebase is small — read the source files directly for implementation details.

## 🏗 Architecture Principle

> AG2R is a **bridge**, not a reconstruction. Every design decision should reinforce this.

1. **Capture views, don't construct them.** When AG shows something (chat, new conversation, dialogs, sidebars), detect it via CDP and capture the DOM faithfully. Never rebuild AG's views from scratch — AG's UI changes frequently and reconstructions become stale.
2. **Proxy clicks, don't manage state.** User taps on AG2R → proxy the click to AG via CDP → AG updates its state → next capture cycle picks up the change. AG2R doesn't need to track AG's internal state.
3. **Use index-based click dispatch.** Interactive elements are tagged `chat:N`, `left:N`, `dialog:N` etc. during capture. Clicks are dispatched by finding the Nth element in the same container — no fragile CSS selectors needed.
4. **Use CDP for discovery during development.** Connect to AG via Chrome Remote Debugging to inspect the real DOM. Simulate states in AG and check what you receive — don't guess at selectors.
5. **AG2R-native elements are exceptions, not the rule.** The only elements AG2R creates from scratch are things that can't come from AG: the text input (mobile keyboard), voice input, image attachment, and push notifications. Everything else mirrors AG.

## 🔌 Port Map

Ports are assigned per-process.

| Port  | Process | Managed By |
|-------|---------|------------|
| 3000  | AG2R production (`main` branch) | `scripts/watchdog.sh` |
| 3001–3099 | Dev/test servers (agent sessions) | `_tools/setup-dev.sh` |
| 3100  | Dev Hub (multi-worktree proxy, scans 3001–3099) | `_tools/hub-watchdog.sh` |
| 3101  | AG2R production (`next` branch) | `scripts/watchdog.sh` (PORT from `.env`) |
| 9000  | CDP (Chrome DevTools Protocol) | `ag-watchdog.sh` |

## ⏰ Watchdog Infrastructure

Cron jobs run every 5 minutes to keep services alive and auto-updated:

| Cron Entry | What It Does |
|------------|-------------|
| `ag-watchdog.sh` | Ensures Antigravity (Electron app) runs with CDP on port 9000 |
| `./scripts/watchdog.sh` (in `~/Workspace/ag2r-next`) | Keeps `next` server alive, auto-pulls on new commits |
| `tunnel-watchdog.sh` | Keeps Cloudflare tunnel alive for remote access |
| `_tools/hub-watchdog.sh` | Keeps dev hub alive on 3100, discovers dev servers on 3001–3099 |

**Agents don't manage watchdogs.** Never start, stop, or modify
watchdog-managed processes. If something seems wrong with a production
service, report it to the user.

## 🔄 Developer Workflow

Unless the user says otherwise, every session follows this flow:

1. **Startup** — Run `setup-dev.sh` then `node server.js` (see § Session Startup).
2. **Research** — Read relevant code, check GitHub Issues, understand the problem.
3. **Plan** — Create an implementation plan and request user approval. **Do NOT start coding.**
4. **Implement** — After approval, make the changes.
5. **Test** — Restart the server if needed. Wait for user feedback.
6. **Commit & merge** — When the user says "commit" or "merge", follow § Git & CI.

> [!IMPORTANT]
> **Steps 2–3 are not optional.** The most common pain point across sessions
> is jumping straight to coding without understanding the problem.

## 📜 Behaviors

1. **Read-First.** Before ANY task, check GitHub Issues to avoid duplicate work.

2. **No Auto-Commits.** Only commit when USER explicitly says to.

3. **If unsure, ask.** Use the ask_question tool — it triggers a push notification. Never guess at architectural decisions.

4. **Pattern Consistency.** Before implementing any component, search codebase for existing patterns. Reuse or extract to reusable modules.

5. **Remove Tech Debt, Don't Accommodate It.** Delete unused code entirely rather than adding workarounds. Search ALL references and remove in one pass.

6. **Centralized Services.** Features used across modules MUST have centralized implementations. Search for existing solutions before building.

7. **Trace Full Data Flow.** Before adding features resembling existing ones, trace the entire pattern end-to-end.

8. **Console Debug Logging.** For bugs requiring runtime data: add `console.debug('[Prefix] ...')` with unique prefix. Ask user to reproduce and paste console output.

9. **Avoid duplicate code and stale comments.** Code is the source of truth. Leave breadcrumbs, not essays.

10. **No `alert()` or `confirm()`.** Use inline errors or styled modals instead.

> [!CAUTION]
> **🚫 NEVER use `>`, `>>`, `2>`, or `2>&1` shell redirection.** These operators
> trigger a blocking permission modal that breaks the development flow.
> Use `tee` to save output, pipes (`|`) for chaining, and `write_to_file`
> for creating files. There are ZERO exceptions to this rule.
>
> **`2>&1` is the #1 most common violation.** The `run_command` tool already
> captures both stdout AND stderr — `2>&1` does NOTHING useful. It is
> banned AND completely pointless. If you are about to type `2>&1`, STOP.

## 🔀 Git & CI

### Feature Branch → `$TARGET_BRANCH`

**Committing** (only when user says "commit"):
```bash
git add -A && git commit -m "type: description"
```

**Amending** (additional changes before PR — always amend to keep 1 commit):
```bash
git add -A && git commit --amend --no-edit
```

**Push & PR:**
```bash
git push origin HEAD
gh pr create --base $TARGET_BRANCH
```

**Merge & sync:**
```bash
gh pr merge <PR#> --squash --admin
git fetch origin $TARGET_BRANCH && git rebase origin/$TARGET_BRANCH
```
Also `git pull --rebase origin $TARGET_BRANCH` on the source worktree
(`~/Workspace/ag2r` or `ag2r-next`) so the watchdog picks up the change.

**If amending after push** (e.g., fixing CI issues):
```bash
git add -A && git commit --amend --no-edit
git push --force-with-lease
```

---

### Production Release: `next` → `main`

When `next` is stable and ready for production:

```bash
gh pr create --base main --head next --title "chore: merge next into main"
gh pr merge <PR#> --merge --admin
```

After merge, GitHub may auto-delete `next`. Recreate it immediately:

```bash
git push origin origin/main:refs/heads/next
```

Then sync both source worktrees:

```bash
cd ~/Workspace/ag2r && git pull --rebase origin main
cd ~/Workspace/ag2r-next && git pull --rebase origin next
```

> [!IMPORTANT]
> Use `--merge` (not `--squash`) for next→main so commit history is
> preserved. Always verify `next` still exists on the remote after merge.

---

### Rules
- Never commit on `$TARGET_BRANCH` directly.
- All CI failures are your responsibility. Debug first, never deflect.
- PR title = `type: clean description`. No issue numbers in title.
- PR body: `## What Changed` + `## Related Issues` (with `Closes #XX` if applicable).

## ⚠️ Gotchas

> Things you would NOT discover by reading the code alone.

- **`_tools/` is gitignored but essential.** Contains dev-only tools (hub.js, setup-dev.sh, etc.) — `setup-dev.sh` copies these automatically, never look for them in git history.
- **`.env.example` and `README.md` are end-user documents.** Dev-only vars (`AG2R_ENV`, `AG2R_DEBUG`, `TARGET_BRANCH`) are not exposed there — they're managed by `_tools/setup-dev.sh`.
- **New conversation page has different DOM structure.** AG removes/hides the chat scroll container and renders a separate `animate-fade-in` root with the input box, project selector, model picker, and environment bar. The capture script detects this (via `container.clientHeight === 0` or missing container) and switches to the new session root.
- **Never kill/restart Antigravity.** Killing Antigravity kills you. You are only accessible from within Antigravity.
- **Nested code blocks.** When writing markdown with inner code blocks, use different backtick counts for each nesting level so rendering properly understands the structure.
- **🚫 Shell redirection (`>`, `>>`, `2>`, `2>&1`) is BANNED.** Every use triggers a permission modal that blocks development. Use `tee`, pipes, or `write_to_file`. No exceptions. No workarounds. No "just this once." **`2>&1` is the most common violation — and it's USELESS because `run_command` already captures stderr.**
- **Don't stop the dev server.** It reserves your assigned port. If you lose the port, re-run `setup-dev.sh` and start `node server.js` again.
- **Lexical Typeahead requires active editor focus.** Lexical's typeahead options dropdown (rendered inside the main application `#root`) only registers selection events if the editor element itself has focus (`lexicalEditor.focus()`) at the moment mouse/pointer events are dispatched.
- **CDP event dispatch requires element hit-testing.** Interactive child elements and Radix items may ignore click events sent directly to their parent if clicked on empty coordinates (e.g., center of wide container). Use `document.elementFromPoint(x, y)` to obtain the exact target element at left-aligned text coordinates and dispatch events directly to it.
- **Single-macro action design.** To avoid complex macro removal synchronization, AG2R strictly enforces a single active macro chip. Clicking the "Actions" button always clears the AG editor input box first before inserting the new slash command.
- **Lexical `$` functions are unavailable via CDP.** `$getRoot()`, `$getSelection()`, etc. are module-scoped imports, not window globals. They silently return `undefined` when called inside `editor.update()` via CDP `Runtime.evaluate`. Use `lex.getEditorState()._nodeMap.get('root')` to access the root node directly. This is the only way to clear decorator nodes (slash command chips) from outside the Lexical bundle.
