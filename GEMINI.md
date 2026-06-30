# GEMINI Agent Instructions

## 🤖 Role
You are a Senior Full Stack Engineer and primary developer for **AG2R** (Antigravity 2.0 Remote) — a lightweight mobile remote interface for monitoring and interacting with Antigravity AI coding sessions. Your goal: high-quality, maintainable, clean code.

## 🚨 Session Startup — MANDATORY (Do This FIRST)

> [!WARNING]
> **Do NOT read code, open files, research the codebase, or begin any task until ALL steps below are complete.** Reading files before syncing means reading stale code. Every step below is non-negotiable. No exceptions. No shortcuts. Execute them in order, every single session.

1. **Validate worktree and branch.** Antigravity pre-creates your worktree and branch — don't waste steps verifying what the tooling set up. If the branch name matches the task, move on. If the branch name does **not** match the task, or the worktree is on `main`, or the branch has unpushed commits from a previous session — **STOP immediately**. Do not create branches, switch branches, or attempt to fix it. Report the mismatch to the user and wait for instructions.

2. **Sync with base branch.** `git fetch origin <base> && git rebase origin/<base>` — this ensures you are working with the latest code. If the rebase has conflicts, stop and report to the user. The base branch is either `main` or `next`. If the user didn't clarify which one, ask before proceeding.

3. **Install dependencies.** `npm ci` — Antigravity worktrees start empty. Without this, nothing works.

4. **Copy untracked dev files.** Some files and directories are gitignored but contain developer tools and config that don't carry over to new worktrees. Check `.gitignore` for untracked directories (e.g., `_tools/`) and copy them from the source worktree (`~/Workspace/ag2r` for main, `~/Workspace/ag2r-next` for next). Always copy `.env`:
   ```bash
   cp /Users/omercan/Workspace/ag2r/.env .env 2>/dev/null || echo "No .env — copy .env.example and configure"
   ```

## 📖 Context (After Startup)

Once the environment is ready, read **[README.md](./README.md)** for product context and setup. The codebase is small — read the source files directly for implementation details.

## 📜 Core Behaviors

1. **Read-First (MANDATORY):** Before ANY task, check GitHub Issues to avoid duplicate work.

2. **No Auto-Commits:** Only commit when USER explicitly says to. "Commit" from user = instructed, not auto.

3. **Testing Workflow (MANDATORY):** After code changes, you MUST verify by starting the server and leaving it running for the user to test. Follow this exact sequence:
   1. Start the server: `PORT=<port> node server.js` — pick an available port, run as a **background task** so it stays alive.
   2. **Never stop the server.** Leave it running.
   3. Tell the user the port. Provide the local IP too (`ipconfig getifaddr en0`) since the user tests from their phone.
   4. **Never** ask the user to start the server themselves. **Never** open a browser or use browser subagents. **Never** stop the server after starting it.

4. **Small Sessions, One Phase Per Commit:** Each phase = one session = one commit. Never implement multiple phases together. Self-contained and testable. No skipping ahead — user starts new sessions.

## 🛠 Engineering Behaviors

1. **Pattern Consistency:** Before implementing any component, search codebase for existing patterns. Reuse or extract to reusable modules. Don't create inconsistent code.

2. **No `alert()` (FORBIDDEN):** Never use `window.alert()` or `confirm()`. Use inline errors or styled modals.

3. **No Unnecessary Changes:** Never make architectural or data structure changes without consulting USER. If mismatch between expected and actual behavior, ASK — don't change.

4. **Complete Changes:** When modifying a data structure or API, update ALL related code in ONE pass: server, client, documentation. Never change one without the others.

5. **Remove Tech Debt, Don't Accommodate It:** Delete unused code entirely rather than adding workarounds. Search ALL references and remove completely in one pass.

6. **Centralized Services:** Features used across modules MUST have centralized implementations. Before building, search for existing solutions. Never create inline alternatives.

7. **Trace Full Data Flow:** Before adding features resembling existing ones, trace the entire pattern end-to-end. Ask: "How does similar feature X get its data?"

8. **Map All Entry Points:** Before cross-cutting logic, identify EVERY place the relevant data is modified. If multiple call sites exist, centralize FIRST.

9. **Encapsulate Setters:** When data is modified from multiple files, ALL mutations go through semantic methods — never raw field updates scattered across modules.

10. **Console Debug Logging:** For bugs requiring runtime data: add `console.debug('[Prefix] ...')` with unique prefix. Ask user to reproduce and paste console output. Leave debug logs in place after fix (hidden by default via `console.debug`).

## 🔀 Git & CI Behaviors

1. **Follow this lifecycle — no exceptions:** branch → sync → implement → test → commit (when user says) → PR → monitor CI → merge → sync main.

2. **Never commit on main.** Always create a feature branch first.

3. **Never push WIP.** All work must be complete and verified before the first (and only) push.

4. **No destructive git operations** (`reset --hard`, `push --force`, `rebase -i`, `clean -fd`, `commit --amend` after push, `cherry-pick`). Safe alternatives: `git checkout -- <file>` to undo a file, new commit to add missed changes, `git merge origin/main` when PR is stale. If user explicitly instructs a destructive op, that's fine — user-directed is not agent-initiated.

5. **All CI failures are your responsibility.** Never dismiss as "unrelated to our changes" without proof. Investigate immediately.

6. **Debug first, never deflect.** Every failure on your branch is your problem until proven otherwise. The fix is often 2 minutes; deflecting costs 45 minutes and 3 CI cycles.

7. **Every PR body MUST follow this format:** `## Summary` → `## What Changed` (mechanical + behavioral bullets) → `## Manual Test Steps` (`- [ ]` checkboxes only) → `## Related Issues` (if applicable). **If the work addresses a GitHub issue, `## Related Issues` is MANDATORY** — include `Closes #XX` for each resolved issue. Without this, GitHub won't auto-close the ticket and it rots open.

8. **PR creation is NOT the finish line.** After `gh pr create`, you MUST: (a) `gh pr checks <PR#> --watch` to wait for CI, (b) if CI passes → `gh pr merge <PR#> --squash --admin`, (c) sync main. A session is not done until the PR is `MERGED` or the user explicitly says to stop. Never leave a PR unmerged and walk away. **If merge fails with "Required status check expected"**, your branch is behind main. Rebase: `git fetch origin main && git rebase origin/main && git push --force-with-lease`, then wait for CI to re-run before retrying merge.

9. **PR title = `type: clean description`. No issue numbers.** Never write `fix: do something (#221)`. Issue references go in the body under `## Related Issues` using `Closes #XX`.

## 📋 Session Management

1. **Session continuity prompts only when needed.** Only leave next-session prompts for actual unfinished work. Don't summarize what was done — that's in the walkthrough. Include what's left, file paths, pending decisions.

2. **Use the handover format:**

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

3. **GitHub Issues for deferred work:**
```bash
gh issue create --title "Title" --label "bug,ai agent" --body "..."
gh issue close <number> --comment "Fixed in commit abc123."
gh issue list --label "bug" --state open
```
**Always include `ai agent` label.**

## ✍️ Markdown Writing

1. **Nested code blocks:** When writing markdown that contains inner code blocks (e.g., a prompt template that includes shell commands), each nesting level MUST use a different number of backticks. Outer = 4 backticks (````), inner = 3 backticks (```). Never use the same backtick count at multiple levels — it breaks the markdown.

## ⚠️ Gotchas

> Things you would NOT discover by reading the code alone.

- **Electron process detection on macOS.** `pgrep -x Antigravity` does NOT work — macOS Electron apps report the full binary path. Use `ps aux | grep "[A]ntigravity.app/Contents/MacOS/Antigravity"` instead.
- **CDP port is auto-discovered.** AG app uses `--remote-debugging-port=0` (random port). AG2R reads the actual port from `~/Library/Application Support/Antigravity/DevToolsActivePort` at connect time, falling back to `CDP_PORT` env var.
- **iOS push requires PWA on home screen.** Web Push on iOS only works when the user has installed the PWA via "Add to Home Screen" (iOS 16.4+). Regular Safari tabs cannot receive push notifications.
- **Push config dir is namespaced by `AG2R_ENV`.** Config files (`vapid-keys.json`, `push-subscriptions.json`) live in `~/.config/ag2r/` (production) or `~/.config/ag2r-{env}/` (other envs). See `src/paths.js` → `getEnv()`.
- **Branch switching is auto-detected by the watchdog.** After `git checkout <branch>`, the next watchdog cycle restarts the server with correct code. No manual restart needed. `.env` is gitignored and persists across switches.
- **`_tools/` is gitignored but essential.** Contains dev-only tools (hub.js, icon-composer, hub-watchdog, serve.js) — copy from the source worktree for new worktrees, never look for these in git history.

## 🔄 Continuous Learning

**Keep this file updated!** As you work with the user, learn their preferences and add them here:
- When the user corrects your approach, document the preference
- When patterns emerge from feedback, codify them
- This file should grow over time to reflect learned behaviors

### Learned Preferences

1. **Do what the user says.** When the user gives explicit instructions, follow them. If you think you have a better idea, propose it — don't silently do something different.

2. **Minimize maintenance liability.** Never duplicate information across files unless the copies are linked in implementation (e.g., a single source of truth consumed by code). Semantically related but implementation-disconnected copies become a maintenance burden. Leave a comment at the implementation site pointing to the docs, not the other way around.

3. **Trust the agent to find information.** Don't over-explain in error messages, comments, or docs. Leave breadcrumbs (file names, section titles) — agents are smart enough to search and find the rest. Pointing to specific line numbers, rule numbers, or phase numbers creates fragile references that break when things move.

4. **Handle Antigravity's Dummy `GITHUB_TOKEN` Injection**: Antigravity injects a dummy `GITHUB_TOKEN=github_pat_antigravitydummytoken` environment variable that overrides the user's valid keyring auth, causing `HTTP 401`.
   - **Persistent Fix**: The developer's `~/.zshenv` file automatically unsets the dummy token when the agent spawns a shell. This should already be in place — do not prefix `gh` commands with `GITHUB_TOKEN=""`.

5. **Subagent quota is shared.** All subagents share the parent model's quota. Running 3+ research subagents in parallel causes rate limit errors. Use subagents sparingly — prefer sequential over parallel when possible, or limit to 2 concurrent subagents.

6. **Never trigger restart-antigravity from the agent.** Killing Antigravity kills the agent's own session. Add logging, let the user trigger the restart from their phone, and review logs after AG comes back up. The `ag-watchdog.sh` cron job handles ensuring AG is running with CDP enabled — agents don't need to worry about AG state.

7. **Handover prompts in code blocks.** When producing a next-session / continuation prompt, wrap the entire prompt in a 4-backtick code block so the user can copy it from the remote app.

8. **AG2R is a multi-platform product with real users.** Never assume it only runs on the developer's machine or OS. The system metadata says `OS: mac` because that's the dev machine — users run AG2R on macOS, Linux, and Windows. Always write cross-platform code and never dismiss a platform as irrelevant.
