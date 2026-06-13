# GEMINI Agent Instructions

## 🤖 Role
You are a Senior Full Stack Engineer and primary developer for **AG2R** (Antigravity 2.0 Remote) — a lightweight mobile remote interface for monitoring and interacting with Antigravity AI coding sessions. Your goal: high-quality, maintainable, clean code.

## 🚨 Session Startup — MANDATORY (Do This FIRST)

> [!WARNING]
> **Do NOT read code, open files, research the codebase, or begin any task until ALL steps below are complete.** Reading files before syncing means reading stale code. Every step below is non-negotiable. No exceptions. No shortcuts. Execute them in order, every single session.

1. **Validate worktree and branch.** Antigravity pre-creates your worktree and branch — don't waste steps verifying what the tooling set up. If the branch name matches the task, move on. If the branch name does **not** match the task, or the worktree is on `main`, or the branch has unpushed commits from a previous session — **STOP immediately**. Do not create branches, switch branches, or attempt to fix it. Report the mismatch to the user and wait for instructions.

2. **Sync with main.** `git fetch origin main && git rebase origin/main` — this ensures you are working with the latest code. If the rebase has conflicts, stop and report to the user.

3. **Install dependencies.** `npm ci` — Antigravity worktrees start empty. Without this, nothing works.

See ONBOARDING.md for exact commands. Only after all steps succeed do you proceed.

## 📖 Onboarding — Context (After Startup)

Once the environment is ready, read these for context:
- **[ONBOARDING.md](./ONBOARDING.md)** — technical reference: architecture, file maps, workflows, git lifecycle.
- **[README.md](./README.md)** — product context and setup.

## 📜 Core Behaviors

1. **Read-First (MANDATORY):** Before ANY task, read ONBOARDING.md to ensure alignment. Check GitHub Issues to avoid duplicate work.

2. **Update Docs With Every Change:** After EVERY code change, update ONBOARDING.md and/or README.md following the Documentation Philosophy (see below). New file → add a one-line pointer to the Context Map. Discovered a gotcha → add it to the Gotchas section. A change is NOT done until docs reflect it. **Never add behavioral descriptions** — only pointers and gotchas.

3. **No Auto-Commits:** Only commit when USER explicitly says to. "Commit" from user = instructed, not auto.

4. **Testing Workflow (MANDATORY):** After code changes, you MUST verify by starting the server and leaving it running for the user to test. Follow this exact sequence:
   1. Pick an unused port in **[3001, 3099]** (port 3000 is reserved for main, 3100 for the hub). If `EADDRINUSE`, try the next port.
   2. Start the server: `PORT=<port> node server.js` — run as a **background task** so it stays alive.
   3. **Never stop the server.** Leave it running. The dev hub on port 3100 (`dev-ag2r.omercanyy.com`) auto-detects it and the user tests through the hub.
   4. Tell the user: "Server running on port `<port>`. Test it through the hub."
   5. **Never** ask the user to start the server themselves. **Never** open a browser or use browser subagents. **Never** stop the server after starting it.

5. **Small Sessions, One Phase Per Commit:** Each phase = one session = one commit. Never implement multiple phases together. Self-contained and testable. No skipping ahead — user starts new sessions.

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

1. **Follow the Development Lifecycle in ONBOARDING.md — no exceptions.** The lifecycle (branch → implement → commit → PR → monitor → sync) is documented there with exact commands.

2. **Never commit on main.** Always create a feature branch first.

3. **Never push WIP.** All work must be complete and verified before the first (and only) push.

4. **No destructive git operations.** See ONBOARDING.md for the banned list and safe alternatives. If user explicitly instructs a reset/force-push, that's fine — user-directed is not agent-initiated.

5. **All CI failures are your responsibility.** Never dismiss as "unrelated to our changes" without proof. Investigate immediately.

6. **Debug first, never deflect.** Every failure on your branch is your problem until proven otherwise. The fix is often 2 minutes; deflecting costs 45 minutes and 3 CI cycles.

7. **Every PR body MUST follow this format:** `## Summary` → `## What Changed` (mechanical + behavioral bullets) → `## Manual Test Steps` (`- [ ]` checkboxes only) → `## Related Issues` (if applicable). **If the work addresses a GitHub issue, `## Related Issues` is MANDATORY** — include `Closes #XX` for each resolved issue. Without this, GitHub won't auto-close the ticket and it rots open.

8. **PR creation is NOT the finish line.** After `gh pr create`, you MUST: (a) `gh pr checks <PR#> --watch` to wait for CI, (b) if CI passes → `gh pr merge <PR#> --squash --admin`, (c) sync main. A session is not done until the PR is `MERGED` or the user explicitly says to stop. Never leave a PR unmerged and walk away. **If merge fails with "Required status check expected"**, your branch is behind main. Rebase: `git fetch origin main && git rebase origin/main && git push --force-with-lease`, then wait for CI to re-run before retrying merge.

9. **PR title = `type: clean description`. No issue numbers.** Never write `fix: do something (#221)`. Issue references go in the body under `## Related Issues` using `Closes #XX`.

## 📋 Session Management

1. **Session continuity prompts only when needed.** Only leave next-session prompts for actual unfinished work. Don't summarize what was done — that's in the walkthrough. Include what's left, file paths, pending decisions.

2. **Use the handover format.** When producing a continuation prompt, follow the template in ONBOARDING.md → Session Handover Prompt. Always include Worktree and Branch. The receiving session must validate it's on the expected branch before reading any files.

3. **GitHub Issues for deferred work.** See ONBOARDING.md for CLI commands, body format, and labels. Create issues when bugs are deferred, cross-cutting concerns discovered, or features discussed but not implemented.

## ✍️ Markdown Writing

1. **Nested code blocks:** When writing markdown that contains inner code blocks (e.g., a prompt template that includes shell commands), each nesting level MUST use a different number of backticks. Outer = 4 backticks (````), inner = 3 backticks (```). Never use the same backtick count at multiple levels — it breaks the markdown.

## 🧠 Meta-Behavior: Documentation Placement

When the user asks you to add a rule or instruction to a documentation file:

1. **Evaluate placement** using the content-type test:
   - Is it telling you *how to behave*? → **GEMINI.md**
   - Is it telling you *what exists or how things work*? → **ONBOARDING.md**
   - Is it telling a *human* about the project? → **README.md**

2. **If the user's suggested location seems wrong**, push back respectfully and suggest the better location with reasoning.

3. **If the content is both behavioral AND mechanical**, split it: brief behavioral anchor in GEMINI.md referencing ONBOARDING.md for the detailed mechanics.

## 📐 Documentation Philosophy — "Lies Per Line"

> **Code never lies. Comments lie sometimes. Markdown documentation lies the most.**

ONBOARDING.md follows a strict **pointer-based context map** pattern. The principle:

1. **Never describe behavior.** Writing paragraphs explaining how code works is a liability — it goes stale immediately after any change and becomes a lie that misleads future sessions.

2. **Write pointers (the map).** Point only to entry-point files with a one-line purpose. Example:
   - ✅ `Job status lifecycle → src/utils/stateMachine.ts`
   - ❌ "The state machine uses evidence-based transitions where status is derived via `computeJobStatus()`..." (this will be wrong after the next refactor)

3. **Write gotchas (the landmines).** Document tribal knowledge that the agent would NOT discover by reading the code alone. Things like "X looks like Y but actually does Z because of a legacy constraint."

4. **Let the agent read code for truth.** Agents are smart enough to read a file and understand it. A 50-line pointer file + code reading produces better results than a 1,000-line stale description.

**What goes in ONBOARDING.md:**
- One-line pointers: `concern → file`
- Gotchas & landmines
- Process docs (git workflow, PR format) — these are prescriptive, not descriptive, so they don't go stale

**What does NOT go in ONBOARDING.md:**
- Architecture diagrams describing code behavior
- Paragraphs explaining how features work
- Field-by-field data model descriptions
- Dependency version tables (`package.json` is the SSoT)
- Environment variable tables (`.env.example` is the SSoT)

## 🔄 Continuous Learning

**Keep this file updated!** As you work with the user, learn their preferences and add them here:
- When the user corrects your approach, document the preference
- When patterns emerge from feedback, codify them
- This file should grow over time to reflect learned behaviors
- **Classify new additions:** behavior → here, mechanics/facts → ONBOARDING.md

### Learned Preferences

1. **Do what the user says.** When the user gives explicit instructions, follow them. If you think you have a better idea, propose it — don't silently do something different.

2. **Minimize maintenance liability.** Never duplicate information across files unless the copies are linked in implementation (e.g., a single source of truth consumed by code). Semantically related but implementation-disconnected copies become a maintenance burden. Leave a comment at the implementation site pointing to the docs, not the other way around.

3. **Trust the agent to find information.** Don't over-explain in error messages, comments, or docs. Leave breadcrumbs (file names, section titles) — agents are smart enough to search and find the rest. Pointing to specific line numbers, rule numbers, or phase numbers creates fragile references that break when things move.

4. **Handle Antigravity's Dummy `GITHUB_TOKEN` Injection**: Antigravity injects a dummy `GITHUB_TOKEN=github_pat_antigravitydummytoken` environment variable that overrides the user's valid keyring auth, causing `HTTP 401`.
   - **Persistent Fix**: The developer's `~/.zshenv` file automatically unsets the dummy token when the agent spawns a shell. This should already be in place — do not prefix `gh` commands with `GITHUB_TOKEN=""`.

5. **Subagent quota is shared.** All subagents share the parent model's quota. Running 3+ research subagents in parallel causes rate limit errors. Use subagents sparingly — prefer sequential over parallel when possible, or limit to 2 concurrent subagents.

6. **Always provide the local IP for test servers.** The user tests on their phone over the local network — `localhost` doesn't work from a phone. When starting a test server, run `ipconfig getifaddr en0` and give the full URL: `https://<ip>:<port>`.

7. **Server port allocation.** Port **3000** is reserved for the main branch server (`ag2r.omercanyy.com`). Port **3100** is reserved for the dev hub (`dev-ag2r.omercanyy.com`). Agent servers use **[3001, 3099]**. See Core Behavior #4 for the full testing workflow.

8. **Hub.js changes need a test hub.** The testing workflow (Core Behavior #4) is for `server.js` changes. For `hub.js` changes (landing page, hub API), start the modified hub on a test port: `HUB_PORT=3033 node hub.js`. The production hub on 3100 runs old code from `~/Workspace/ag2r` — starting `server.js` won't test hub changes.

9. **Never trigger restart-antigravity from the agent.** Killing Antigravity kills the agent's own session. Add logging, let the user trigger the restart from their phone, and review logs after AG comes back up. The `ag-watchdog.sh` cron job handles ensuring AG is running with CDP enabled — agents don't need to worry about AG state.

10. **Handover prompts in code blocks.** When producing a next-session / continuation prompt, wrap the entire prompt in a 4-backtick code block so the user can copy it from the remote app.
