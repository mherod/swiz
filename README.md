# swiz

AI coding agents are capable of impressive things. They're also capable of forgetting to commit, shipping debug statements, ignoring failing CI, losing track of what they were supposed to do, and declaring "task complete" the moment they want to stop. **swiz** is a hook framework that doesn't let them get away with any of it.

One manifest of TypeScript hook scripts gets installed across Claude Code, Cursor, Gemini CLI, and Codex CLI — translating tool names, event names, and config formats automatically so every agent plays by the same rules. The hooks enforce discipline at every stage of the agent loop: before tools run, after they complete, and before the session is allowed to stop.

When `swiz idea` and `swiz continue` are used together, the system can enter a **self-directed loop** — a closed-loop state where the agent's own outputs become the next inputs, expanding the project without external prompts. See [docs/ai-providers.md](docs/ai-providers.md#self-directed-loop) for the canonical terminology.

**116 hooks. 12 event types. Every agent. Zero compromises.**

## Install

```bash
bun install
bun link
```

Then use `swiz` from anywhere.

## How It Works

Every agent exposes hook events at key moments in the loop. swiz intercepts those moments:

```
User prompt submitted  →  userpromptsubmit-* hooks inject context (git state, active tasks)
                                        ↓
Agent calls a tool     →  pretooluse-* hooks can block the call before it executes
                                        ↓
Tool completes         →  posttooluse-* hooks validate results, remind about tests
                                        ↓
Agent tries to stop    →  stop-* hooks audit the full session state and block if anything is unresolved
```

Hooks communicate back using **polyglot JSON** — a single output format that all four agents understand. A hook script written once works identically whether it was triggered by Claude, Cursor, Gemini, or Codex.

```json
{
  "decision": "block",
  "reason": "Uncommitted changes detected: 2 modified (3 file(s))...",
  "hookSpecificOutput": { "permissionDecision": "deny" }
}
```

## The Agent Ecosystem

swiz supports every agent that has a hook system, with automatic translation of tool names and event names from a single canonical manifest:

| Agent       | Config Path               | Status                                                                                                                                                                                                    |
|-------------|---------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Claude Code | `~/.claude/settings.json` | Full support — nested matcher groups, all 5 event types                                                                                                                                                   |
| Cursor IDE  | `~/.cursor/hooks.json`    | Full support — flat list (`version: 1`), all events                                                                                                                                                       |
| Cursor CLI  | `~/.cursor/hooks.json`    | Limited — only `beforeShellExecution`/`afterShellExecution` fire ([tracking issue](https://forum.cursor.com/t/cursor-cli-doesnt-send-all-events-defined-in-hooks/148316)). Use `swiz shim` as workaround. |
| Gemini CLI  | `~/.gemini/settings.json` | Full support — nested matcher groups, all 5 event types                                                                                                                                                   |
| Codex CLI   | `~/.codex/hooks.json`     | Full support — nested matcher groups, shipped event types (`SessionStart`, `Stop`, `UserPromptSubmit`)                                                                                                    |

### Cross-Agent Translation

The canonical manifest uses neutral names. At install time, `agents.ts` translates everything per-agent so hook scripts never need to know which agent ran them:

**Tool Names**

| Concept  | Claude Code    | Cursor         | Gemini CLI          | Codex CLI                        |
|----------|----------------|----------------|---------------------|----------------------------------|
| Shell    | `Bash`         | `Shell`        | `run_shell_command` | `shell_command` / `exec_command` |
| Edit     | `Edit`         | `StrReplace`   | `replace`           | `apply_patch`                    |
| Write    | `Write`        | `Write`        | `write_file`        | `apply_patch`                    |
| Read     | `Read`         | `Read`         | `read_file`         | `read_file`                      |
| Grep     | `Grep`         | `Grep`         | `grep_search`       | `grep_files`                     |
| Glob     | `Glob`         | `Glob`         | `glob`              | `list_dir`                       |
| Notebook | `NotebookEdit` | `EditNotebook` | —                   | `apply_patch`                    |
| Tasks    | `TaskCreate`   | `TodoWrite`    | `write_todos`       | `spawn_agent`                    |

**Event Names**

| Event             | Claude Code        | Cursor               | Gemini CLI     | Codex CLI                  |
|-------------------|--------------------|----------------------|----------------|----------------------------|
| Before tool use   | `PreToolUse`       | `preToolUse`         | `BeforeTool`   | `BeforeToolUse` (internal) |
| After tool use    | `PostToolUse`      | `postToolUse`        | `AfterTool`    | `AfterToolUse` (internal)  |
| Stop / completion | `Stop`             | `stop`               | `AfterAgent`   | `Stop`                     |
| Session start     | `SessionStart`     | `sessionStart`       | `SessionStart` | `SessionStart`             |
| User prompt       | `UserPromptSubmit` | `beforeSubmitPrompt` | `BeforeAgent`  | `UserPromptSubmit`         |

Hook scripts use equivalence sets from `hook-utils.ts` (`isShellTool("run_shell_command")` returns `true`) so they work regardless of which agent's name lands in the payload.

## Bundled Hooks

114 hook scripts across 10 event types. All TypeScript. All sharing utilities from `hooks/hook-utils.ts`.

The bundled hooks cover seven events: Stop, PreToolUse, PostToolUse, SessionStart, PreCompact, UserPromptSubmit, and Notification. Three additional events — **SubagentStart**, **SubagentStop**, and **SessionEnd** — are formally registered in the dispatch system. Claude and Cursor support all three; Gemini currently supports `SessionEnd` but not subagent lifecycle events. These events ship with no bundled hooks; any custom hooks added for supported events will be dispatched automatically.

### Stop (27)

Stop hooks run before the agent is allowed to end a session. They're the last line of defense — and the most powerful. A blocking stop hook keeps the agent working until the problem is resolved.

| Hook                             | What it does                                                                                                                                                                                                                                                                                                                                                                                             |
|----------------------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `stop-secret-scanner.ts`         | Scans staged diffs for API keys, tokens, and credentials. Blocks stop if any are found — because secrets in git history are permanent.                                                                                                                                                                                                                                                                   |
| `stop-offensive-language.ts`     | Defense-in-depth backstop for the PreToolUse offensive-language hook. Scans the last assistant message for lazy behavior patterns (hedging, deferral, compliance gaming, etc.) and blocks stop if the agent's final message contains avoidance language. Shares detection logic with `pretooluse-offensive-language.ts`.                                                                                 |
| `stop-workflow-permissions.ts`   | Defense-in-depth backstop for workflow permission changes. Scans committed diffs on non-default branches for `permissions:` additions in `.github/workflows/*.yml` files. Catches changes that bypass the PreToolUse gate (shell edits, amends, cherry-picks). Allows permission changes on the default branch where they are intentional.                                                               |
| `stop-suppression-patterns.ts`   | Defense-in-depth backstop for type and lint suppression patterns. Scans committed diffs on non-default branches for newly added `@ts-ignore`, `@ts-nocheck`, bare `@ts-expect-error`, lint-disable comments, and `as any` casts in TypeScript/JavaScript files. Catches suppressions that bypass the PreToolUse gates via shell edits, amends, or cherry-picks.                                          |
| `stop-large-files.ts`            | Blocks stop if any uncommitted file exceeds the size threshold — preventing accidental binary or generated-file commits.                                                                                                                                                                                                                                                                                 |
| `stop-ship-checklist.ts`         | **Unified ship gate** — modular orchestration of three independent workflows: git sync (commit/pull/push), GitHub CI on feature branches (polls up to 30s), and actionable issues/PRs. Each concern is isolated in its own module (git-workflow, ci-workflow, issues-workflow) for testability and reusability. Respects `gitStatusGate`, `githubCiGate`, `personalRepoIssuesGate` independently. Emits one preamble and one ordered action plan (git → CI → issues) so the agent sees a single checklist, not three separate blocks. See [hook-extraction-pattern.md](docs/hook-extraction-pattern.md) for modular architecture details. |
| `stop-lockfile-drift.ts`         | Detects when `package.json` has been modified but the lockfile hasn't been updated. Agents forget to run `bun install` — this doesn't let them forget.                                                                                                                                                                                                                                                   |
| `stop-lint-staged.ts`            | Runs lint-staged on the current working tree before allowing stop. Catches lint and format issues that would block CI.                                                                                                                                                                                                                                                                                   |
| `stop-quality-checks.ts`         | Discovers and runs the project's lint and typecheck scripts from `package.json` (e.g. `lint`, `typecheck`) before allowing stop. Covers issues in already-committed code that lint-staged misses.                                                                                                                                                                                                        |
| `stop-branch-conflicts.ts`       | Checks for potential merge conflicts with the base branch before the session ends, while there's still time to resolve them cleanly.                                                                                                                                                                                                                                                                     |
| `stop-pr-description.ts`         | Validates that open PRs have a real description, not an empty template. Forces the agent to document what it built.                                                                                                                                                                                                                                                                                      |
| `stop-pr-feedback.ts`            | Blocks stop if open PRs have pending feedback (CHANGES_REQUESTED or REVIEW_REQUIRED) or merge conflicts. Separates PR feedback handling from issue triage, focusing on review feedback and conflict resolution.                                                                                          |
| `stop-pr-changes-requested.ts`   | Blocks stop if the current PR has unresolved change requests from reviewers. The agent doesn't get to declare done while reviewers are waiting.                                                                                                                                                                                                                                                          |
| `stop-todo-tracker.ts`           | Scans git diffs for newly introduced `TODO`, `FIXME`, or `HACK` comments. Technical debt accumulates fast — this keeps the bar high.                                                                                                                                                                                                                                                                     |
| `stop-non-default-branch.ts`     | Blocks stop when the session is on a non-default branch (not `main` or `master`). Even a clean feature branch signals unfinished workflow — this keeps the agent from declaring done while still on it.                                                                                                                                                                                                  |
| `stop-incomplete-tasks.ts`       | Blocks stop when any session task is still pending or in-progress. Deduplicates stale tasks against completed ones first, then blocks with a task list if any remain incomplete. Fast, focused, and first in line.                                                                                                                                                                                       |
| `stop-completion-auditor.ts`     | Verifies task creation thresholds and CI evidence after all tasks are complete. If a push happened but no task carries CI-green evidence, blocks until the agent proves CI passed.                                                                                                                                                                                                                       |
| `stop-upstream-branch-count.ts`  | Blocks stop when the remote has more than 40 branches. Stale branches accumulate silently — this surfaces the cleanup work before it becomes unmanageable. Runs with a 2-hour cooldown so it doesn't interrupt every session.                                                                                                                                                                            |
| `stop-memory-size.ts`            | Scans `CLAUDE.md` and `MEMORY.md` files against the configured line and word thresholds. Blocks stop with file-level details and `/compact-memory` guidance when any file is over threshold.                                                                                                                                                                                                             |
| `stop-dependabot-prs.ts`         | Surfaces open Dependabot PRs and blocks stop when any are older than 7 days. Lists PR numbers, titles, ages, and provides next steps for merging, closing, or inspecting each PR. Uses `isAutomationLogin()` from `collaboration-policy.ts` for bot detection. Runs with a 1-hour cooldown.                                                                                                              |
| `stop-gdpr-data-models.ts`       | When uncommitted changes touch files matching user-data model patterns (user, account, profile, PII, consent, erasure), suggests the /gdpr-analysis skill via `additionalContext`. Non-blocking advisory — conservative file-name heuristics to minimize false positives.                                                                                                                                |
| `stop-reflect-on-session-mistakes.ts` | Blocks stop until the `/reflect-on-session-mistakes` skill has been invoked in the current session. Fails open when the skill is unavailable on the machine, but when it is installed this hook keeps the session from ending before the reflection pass happens.                                                                                                                              |
| `stop-memory-update-reminder.ts` | Checks whether CLAUDE.md or MEMORY.md was recently updated. If not, blocks with a suggestion to reflect on session learnings and update memory. 30-minute cooldown prevents nagging.                                                                                                                                                                                                                     |
| `stop-auto-continue.ts`          | Blocks stop with an AI-generated "what should you do next?" suggestion. Instead of ending, the agent gets a concrete next step. Combined with `swiz continue`, this creates an autonomous work loop.                                                                                                                                                                                                     |
| `posttooluse-speak-narrator.ts`  | Speaks new assistant text aloud using platform-native TTS (macOS `say`, Linux `espeak-ng`/`espeak`/`spd-say`, Windows PowerShell). Tracks position per session so only incremental text is spoken. Uses PID-aware file locking with heartbeats to queue speech in order. Runs async so it never blocks the session.                                                                                      |
| `stop-git-status.ts` | Modular git workflow validation — detects uncommitted changes, unpushed commits, branch divergence. Blocks stop until git state is clean. Separated into independent validators (context, uncommitted-changes, remote-state, push-cooldown, background-push-detector, action-plan, evaluate) for testability and reusability. See [hook-extraction-pattern.md](docs/hook-extraction-pattern.md) for modular architecture details. |
| `stop-personal-repo-issues.ts` | Blocks stop if there are unassigned issues on a personal repository. |

### PreToolUse (55)

PreToolUse hooks intercept tool calls *before* they execute. A blocking hook here prevents the action entirely — the agent has to find another way.

| Hook                                           | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
|------------------------------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `pretooluse-no-mixed-tool-calls.ts`            | Blocks Bash commands that are actually tool invocations (e.g. `TaskCreate ...` or `WebFetch ...` in a shell). These are agent tool names, not executables — they must be called as tools, not shell commands.                                                                                                                                                                                                                                                                                                                                                                                                      |
| `pretooluse-banned-commands.ts`                | Blocks `grep` (use `rg`), file-writing `sed`/`awk` (use Edit; read-only usage is allowed), `rm` (use trash), `cd`, and raw `python`. Redirects to safer, more auditable alternatives.                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `pretooluse-no-merge-conflict-comments.ts`     | Blocks `gh pr comment` and `gh pr review --comment` calls whose body consists only of merge-conflict or rebase-request noise. The project already has local remediation paths (stop-branch-conflicts, /rebase-onto-main) — low-signal public comments add notification noise without value.                                                                                                                                                                                                                                                                                                                        |
| `pretooluse-no-cp.ts`                          | Blocks `cp` usage and redirects to `ditto` for reliable file and directory copying with metadata preservation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `pretooluse-git-index-lock.ts`                 | Blocks git commands when `.git/index.lock` exists. Prevents wasting turns on operations that will fail because another git process is running or a stale lock was left behind.                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `pretooluse-no-npm.ts`                         | Intercepts `npm` and `yarn` commands and redirects to the project's actual package manager. No more lock file corruption from the wrong tool.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `pretooluse-bun-test-concurrent.ts`            | Blocks `bun test` invocations that do not include `--concurrent`. Ensures test runs follow the enforced concurrent execution policy.                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `pretooluse-protect-sandbox.ts`                | Blocks Bash commands that attempt to disable the sandboxed-edits setting. The sandbox can only be disabled by the user at the terminal — agents cannot opt out.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `pretooluse-protect-strict-main.ts`            | Blocks Bash commands that attempt to disable the strict-no-direct-main setting. The feature-branch enforcement can only be disabled by the user at the terminal — agents cannot opt out.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `pretooluse-long-sleep.ts`                     | Blocks `sleep` commands over a threshold. Agents shouldn't be waiting in loops — if they are, something is wrong.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `pretooluse-ts-quality.ts`                     | Blocks edits that weaken TypeScript quality: `as any` casts, `eslint-disable` comments, and `@ts-ignore`/`@ts-expect-error`/`@ts-nocheck` directives. The type system and linter are authority.                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `pretooluse-ts-edit-state-gate.ts`             | Blocks edits to `.ts` / `.tsx` files unless project state is `developing`, `reviewing`, or `addressing-feedback`. In `planning`, use triage and design work first — transition state before writing TypeScript.                                                                                                                                                                                                                                                                                                                                                                                                    |
| `pretooluse-no-node-modules-edit.ts`           | Blocks any edit to files inside `node_modules/`. Manual edits there are overwritten on the next install — use version upgrades, upstream PRs, or patch-package instead.                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `pretooluse-no-lockfile-edit.ts`               | Blocks direct edits to lockfiles (`pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`, `bun.lock`, etc.). Lockfiles are machine-generated — use the package manager command to regenerate them.                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `pretooluse-eslint-config-strength.ts`         | Prevents weakening ESLint configs — rules can only be added or escalated, never removed or downgraded. Enforces a quality ratchet.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `pretooluse-json-validation.ts`                | Validates JSON syntax before any write to a `.json` file. Catches malformed JSON before it breaks the project.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `pretooluse-no-direct-deps.ts`                 | Blocks direct edits to dependency blocks in `package.json`. Dependencies must go through the package manager, not hand-edited.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `pretooluse-update-memory-enforcement.ts`      | If a prior hook explicitly told the agent to record an `/update-memory` DO/DON'T rule, blocks normal work until the agent reads that skill and writes the rule into a markdown file.                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `pretooluse-state-gate.ts`                     | Blocks disallowed tool categories based on current project state. In `released` state, code-change and shell tools are blocked — the project is done.                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `pretooluse-task-governance.ts`                | Comprehensive task lifecycle enforcement — blocks tools when tasks are missing, stale, exceed the in-progress cap, or violate governance thresholds. Nine block paths covering no-task, stale-task, over-cap, prior-session incomplete, missing-pending, and deletion-guard scenarios. Uses `STOP.` prefix and `formatActionPlan()` for all denial messages.                                                                                                                                                                                                                                                          |
| `pretooluse-require-tasks.ts`                  | Blocks Edit, Write, and Shell tools unless the agent has active tasks. No more undisciplined free-form editing — work must be tracked.                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `pretooluse-no-task-delegation.ts`             | Prevents agents from creating sub-tasks to delegate work instead of doing it. Task creation is for tracking, not avoidance.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `pretooluse-task-subject-validation.ts`        | Validates task subjects meet quality standards before they're created — no vague "fix stuff" tasks.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `pretooluse-stale-approval-gate.ts`            | Warns before `git commit` would invalidate an existing PR approval when branch protection dismisses stale reviews. Fires once per 5 minutes (cooldown), then allows subsequent commits. Fails open when `gh` is unavailable or branch is unprotected.                                                                                                                                                                                                                                                                                                                                                              |
| `pretooluse-push-checks-gate.ts`               | Blocks `git push` unless branch and open-PR checks have already been run in the current session. Prevents pushing without verifying context and avoiding duplicate PRs.                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `pretooluse-push-cooldown.ts`                  | Enforces a 60-second cooldown between `git push` commands for the same repository. Prevents accidental rapid-fire pushes. Bypass with `--force`, `--force-with-lease`, `--force-with-lease=<ref>`, `--force-if-includes`, or `-f`.                                                                                                                                                                                                                                                                                                                                                                                 |
| `pretooluse-main-branch-scope-gate.ts`         | Enforces scope-based push policy for main branch: trivial changes (≤3 files, ≤20 lines, docs-only) can push to main in solo repos; non-trivial work (features, refactors, multi-file changes) in collaborative repos must use feature branch + PR. Blocks push with actionable guidance.                                                                                                                                                                                                                                                                                                                           |
| `pretooluse-block-commit-to-main.ts`           | Blocks `git commit` when on the default branch in a collaborative repository. Solo repos are allowed to commit directly to main; collaborative repos must use a feature branch and PR workflow.                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `pretooluse-pr-changes-branch-guard.ts`        | Blocks `git checkout` and `git switch` when the current branch has an open PR with CHANGES_REQUESTED reviews. Forces the agent to address all reviewer feedback before moving to other work.                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `pretooluse-trunk-mode-branch-gate.ts`         | When project trunk mode is enabled, blocks creating or checking out any branch other than the default branch, blocks `gh pr checkout`, and blocks `gh pr create`. Keeps work on the trunk only.                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `pretooluse-skill-invocation-gate.ts`          | Blocks `git commit` and `git push` unless the corresponding `/commit` or `/push` skill has been invoked in the current session. Only enforced when the skill is installed on the machine.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `pretooluse-no-push-when-instructed.ts`        | Blocks `git push` when the transcript contains an explicit "do not push" instruction (e.g. from the `/commit` skill) without a subsequent push-approval signal. Push requires explicit user authorisation.                                                                                                                                                                                                                                                                                                                                                                                                         |
| `pretooluse-taskupdate-schema.ts`              | Blocks TaskUpdate calls that include unsupported fields (e.g. `notes`). Lists the allowed schema fields; use only those keys (e.g. put completion evidence in `description`).                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `pretooluse-dirty-worktree-gate.ts`            | Blocks task updates when the worktree has more than 15 dirty files. Forces a commit boundary before the task plan can be reshaped further. Covers Claude `TaskUpdate` and Codex `update_plan`.                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `pretooluse-no-phantom-task-completion.ts`     | Blocks `TaskUpdate` with `status=completed` when the transcript shows zero non-task tool calls after the task's last `in_progress` transition. Phantom task completion — creating tasks solely to satisfy enforcement gates and immediately marking them done without doing the work — produces this exact signature. Fail-open: if no `in_progress` transition is found in the session transcript the completion is allowed (task may have been worked on in a prior session). Bypassed when the completion description contains traceable evidence prefixes (`commit:`, `pr:`, `file:`, `test:`, `ci_green:`).   |
| `pretooluse-taskoutput-timeout.ts`             | Blocks TaskOutput calls that are missing a `timeout` parameter or have a timeout exceeding 120 seconds. Missing timeouts block the session indefinitely; excessive timeouts waste time.                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `pretooluse-pr-age-gate.ts`                    | Blocks `gh pr merge` if the PR has been open for less than the configured grace period (default: 10 minutes; configurable via `swiz settings set pr-age-gate <minutes>`; set to 0 to disable). Enforces a minimum visibility period so team members have time to review. Redirects the agent to other work instead of waiting.                                                                                                                                                                                                                                                                                     |
| `pretooluse-no-ready-to-backlog.ts`            | Blocks `gh issue edit` commands that demote issues from `ready` to `backlog`. Prevents agents from gaming readiness hooks by downgrading triaged work they want to avoid.                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `pretooluse-no-issue-close.ts`                 | Blocks closing issues via CLI (`gh issue close`, `swiz issue close`, `swiz issue resolve`, `gh api ... state=closed`). Issues must only be closed by pushing commits with `Fixes #N` in the message, ensuring every closure is backed by a code change.                                                                                                                                                                                                                                                                                                                                                            |
| `pretooluse-repeated-lint-test.ts`             | Blocks consecutive same-kind `bun test` / `bun run lint` / `bun run build` calls when no file edit (Edit, Write, or NotebookEdit) occurred between them. Also handles parallel tool-call dispatch correctly by tracking the JSONL source line. Prevents the wasteful pattern of re-running the same command with different output filters instead of reading the full output. When blocking, the denial message includes a concrete transcript file reference (path and source line index) so agents can locate the prior output directly; if the output could not be extracted, guidance is softened accordingly. |
| `pretooluse-block-preexisting-dismissals.ts`   | Blocks follow-up work when the assistant dismisses lint/test/typecheck/build warnings as "pre-existing" or "unrelated" without proving the claim. Scans the transcript for dismissal language after diagnostic-bearing output, and blocks unless the agent has fixed the issues, run a scoped verification, or provided baseline evidence (e.g. git diff) that the diagnostics predate the current changes.                                                                                                                                                                                                        |
| `pretooluse-no-secrets.ts`                     | Blocks Edit/Write/NotebookEdit operations when the proposed content contains likely secret material — private keys, API tokens (AWS, GitHub, Slack, OpenAI, Stripe), or generic credential assignments. Eager counterpart to `stop-secret-scanner.ts`: prevents secrets from landing on disk rather than catching them at commit time. Test files are excluded to allow fixture credentials.                                                                                                                                                                                                                       |
| `pretooluse-bun-api-enforce.ts`                | Blocks Node.js sync file operations (`readFileSync`, `writeFileSync`, `appendFileSync`, `unlinkSync`, `rmSync`) and sync child_process operations (`execSync`, `spawnSync`, `execFileSync`) when the file already uses Bun APIs or has a bun shebang. Enforces Bun-native replacements (`Bun.file()`, `Bun.write()`, `Bun.spawn()`, `Bun.$\`\``). Directory operations (`mkdir`,`readdir`,`stat`) and async spawn/exec remain allowed.                                                                                                                                                                             |
| `pretooluse-todo-tracker.ts`                   | Blocks Edit/Write/NotebookEdit when the write introduces net-new TODO/FIXME/HACK/XXX/WORKAROUND debt markers in comment contexts. Uses a delta check (new count vs old count) to avoid false positives when editing files that already contain such markers. Excludes regex literals, non-comment contexts, hook source files, test files, and generated files — mirroring `stop-todo-tracker.ts` semantics. The stop hook remains as a backstop for bypassed paths.                                                                                                                                               |
| `pretooluse-large-files.ts`                    | Blocks Edit/Write operations that would create or update a file exceeding the configured large-file size threshold (default 500KB) when the path is not covered by a Git LFS rule in `.gitattributes`. Reads `.gitattributes` from disk so uncommitted LFS rules added in the same session are respected. For Edit, projects the result of old→new replacement before measuring. For NotebookEdit, size is not determinable pre-write and is skipped. Threshold is configurable via `swiz settings set large-file-size-kb <value>` at global or project scope.                                                     |
| `pretooluse-workflow-permissions-gate.ts`      | Blocks changes to `permissions:` blocks in `.github/workflows/*.yml` files on non-default branches. GitHub Actions permission changes don't take effect until merged — this prevents accidental privilege escalation that silently activates upon merge.                                                                                                                                                                                                                                                                                                                                                           |
| `pretooluse-manifest-order-validation.ts`      | Blocks edits to `src/manifest.ts` that change stop hook order without updating `src/manifest.test.ts`. Compares projected manifest order against test expectations and shows divergences, preventing failed pre-push test cycles.                                                                                                                                                                                                                                                                                                                                                                                  |
| `pretooluse-sandboxed-edits.ts`                | Blocks Edit, Write, and NotebookEdit calls targeting paths outside the session's working directory and temporary directories. Enabled by default; disable with `swiz settings disable sandboxed-edits`.                                                                                                                                                                                                                                                                                                                                                                                                            |
| `pretooluse-sandbox-guidance-consolidation.ts` | Blocks edits that introduce inline issue-guidance patterns. Enforces the use of `buildIssueGuidance()` from hook-utils.ts instead, keeping issue-guidance messages consistent and preventing duplicate patterns across hooks.                                                                                                                                                                                                                                                                                                                                                                                      |
| `pretooluse-claude-md-word-limit.ts`           | Prevents CLAUDE.md edits from exceeding 5000 words. Calculates projected word count before each Edit/Write and blocks if the result would exceed the limit, directing the agent to use the `/compact-memory` skill.                                                                                                                                                                                                                                                                                                                                                                                                |
| `pretooluse-claude-word-limit.ts`              | Blocks `git push` when CLAUDE.md exceeds 5000 words, enforcing the limit at release time. Provides actionable error showing current word count, overage, and required reduction. Integrates with word-counting utility in hook-utils.                                                                                                                                                                                                                                                                                                                                                                              |
| `pretooluse-offensive-language.ts`             | Scans the last assistant message for two categories of bad behavior: (1) **hedging/deferring** — asking permission instead of acting ("Would you like me to…", "Shall I proceed?", "Let me know if you'd like…"), and (2) **dismissing responsibility** — deflecting issues as "pre-existing", "unrelated to our changes", or "safely ignored". Each pattern triggers a tailored scolding. The agent must produce a new message acknowledging the feedback before the hook allows tool calls to proceed.                                                                                                           |
| `pretooluse-read-grep-stall-guard.ts`          | Blocks Read/Grep/Glob when 15+ consecutive read/search tool calls have occurred without any Edit or Write. Detects stall patterns where the model endlessly reads files without producing output. After any Edit or Write, the counter resets and reads are unblocked.                                                                                                                                                                                                                                                                                                                                             |
| `pretooluse-enforce-taskupdate.ts`             | Blocks all `swiz tasks` CLI usage in Claude Code except `swiz tasks adopt` (orphan recovery). Requires native task tools (TaskCreate, TaskUpdate, TaskGet, TaskList) for every other task operation.                                                                                                                                                                                                                                                                                                                                                                                                               |
| `posttooluse-speak-narrator.ts`                | Catches up on unspoken assistant text before each tool call. Shares the same incremental position tracker as the PostToolUse and Stop narrator hooks — ensures no text is missed between tool calls. Runs async.                                                                                                                                                                                                                                                                                                                                                                                                   |

### PostToolUse (23)

PostToolUse hooks run after a tool completes. They can feed error context back to the agent or inject advisory information.

| Hook | What it does |
|------|-------------|
| `posttooluse-git-context.ts` | Injects current git status context after every tool use (branch, upstream, uncommitted count, ahead/behind). After git Bash commands, also injects active swiz settings (trunk mode, push gate, collab mode) and synced branch protection rules. Keeps the agent informed of repo state and policy without repeated status/settings queries. |
| `posttooluse-time-context.ts` | Injects the current wall-clock time after every tool use so the agent always has an absolute timestamp in merged additionalContext. |
| `posttooluse-git-task-autocomplete.ts` | After a successful `git commit` or `git push`, automatically marks any matching "Commit" or "Push" tasks as completed. After a push, reminds the agent to create a CI-wait task. |
| `posttooluse-json-validation.ts` | Re-validates JSON files after any edit or write. Catches any JSON that got corrupted during a tool call. |
| `posttooluse-test-pairing.ts` | Detects when source files were edited without corresponding test updates and reminds the agent. Tests aren't optional. |
| `posttooluse-task-advisor.ts` | Issues a countdown warning as the agent approaches the task enforcement threshold — before it gets blocked. |
| `posttooluse-pr-context.ts` | Injects PR context (description, review status, CI state) when the agent checks out a branch. Instant situational awareness. |
| `posttooluse-pr-create-refine.ts` | After `gh pr create`, checks if the new PR has a thin or empty description and suggests the /refine-pr skill via `additionalContext`. Non-blocking — advisory only. |
| `posttooluse-prettier-ts.ts` | Auto-formats TypeScript files after edits. Runs async so it never slows the agent down. |
| `posttooluse-task-subject-validation.ts` | Validates task subjects after creation, catching issues that the pre-creation hook might have missed. |
| `posttooluse-task-list-sync.ts` | After TaskList, synchronizes the internal task model (tool_response) into the file-based task store. Idempotent — only writes when subject or status have changed. Emits a sync summary when tasks are created or updated. |
| `posttooluse-speak-narrator.ts` | Speaks new assistant text aloud using platform-native TTS. Incremental — only speaks text added since the last invocation. Runs async so it never slows the agent down. |
| `posttooluse-memory-size.ts` | Checks CLAUDE.md and memory files after edits — if they exceed line/word thresholds, advises compaction using the /compact-memory skill. Keeps guidance files lean. |
| `posttooluse-task-output.ts` | Parses TaskOutput results: blocks on non-zero exits with actionable error context; on successful git push, injects the CI run ID and watch commands so the agent can verify CI without extra plumbing. |
| `posttooluse-push-cooldown.ts` | After any `git push` executes, writes the cooldown sentinel. Pairs with `pretooluse-push-cooldown.ts` — by writing *after* the push runs, only successful pushes arm the cooldown, so blocked pushes no longer trigger a false 60-second wait. |
| `posttooluse-verify-push.ts` | After any `git push`, verifies the local HEAD SHA matches the remote tracking branch SHA. Blocks with a hard error if they diverge — prevents the agent from declaring push success when the commit didn't land on the remote. |
| `posttooluse-state-transition.ts` | Auto-transitions project state based on PR lifecycle: `gh pr create` moves `in-development` → `awaiting-feedback`; `gh pr merge` moves `awaiting-feedback` → `in-development`. |
| `posttooluse-task-audit-sync.ts` | After TaskCreate or TaskUpdate, writes the task subject and status to the swiz audit log. Ensures `recoverSubjectFromAuditLogs` can recover original task subjects after context compaction orphans the native task files. |
| `posttooluse-task-count-context.ts` | After TaskCreate or TaskUpdate, reads session task state and injects a context message with incomplete/pending/in_progress counts. Warns urgently when pending tasks drop to ≤1. |
| `posttooluse-upstream-sync-on-push.ts` | After `git push` or any `gh pr`/`gh issue` mutation command, fires a non-blocking sync request to the daemon so the IssueStore reflects the new GitHub state immediately — without waiting for the next 2-minute sync interval. |
| `posttooluse-skill-steps.ts` | After a Skill tool call, extracts numbered steps from the skill's `## Steps` section and creates pending tasks for each step that doesn't already exist as a pending/in_progress task. Uses subject fingerprinting and overlap detection to avoid duplicates. |
| `posttooluse-task-sync.ts` | Consolidated task synchronization dispatcher: routes TaskList calls to task-list-sync and TaskCreate/TaskUpdate/TodoWrite calls to task-audit-sync. Registered in the unmatched PostToolUse group so it fires on every tool call without a dedicated matcher. |
| `posttooluse-auto-steer.ts` | Types "Continue" into the active terminal session after every tool call using AppleScript automation. Supports iTerm2 (`write text`) and Terminal.app (`do script`). Runs async. |

### SessionStart (6)

| Hook | What it does |
|------|-------------|
| `sessionstart-self-heal.ts` | Detects manifest drift by hashing `src/manifest.ts` and comparing to a stored hash. Automatically runs `swiz install` if they differ, keeping agent configs in sync after `git pull`. After a **full** `swiz install --uninstall` or `swiz uninstall` (all agents), self-heal pauses until you run `swiz install` again so manifest drift cannot undo an intentional removal. |
| `sessionstart-environment-detects.ts` | Injects a structured snapshot of swiz detections at session start: process-level agent guess, SessionStart payload fields (`agent_type`, `model`, `source`, …), project stacks, frameworks/ecosystems, CI config signals, terminal/shell, and `isRunningInAgent()`. |
| `sessionstart-health-snapshot.ts` | Captures a baseline of project health (lint state, test state, git state) at session start so the agent knows what it's walking into. |
| `sessionstart-state-context.ts` | Injects the current project state (e.g., `in-development`, `awaiting-feedback`) and allowed transitions into the session context so the agent always knows its lifecycle position. |
| `posttooluse-speak-narrator.ts` | Speaks any assistant text generated during session startup. Catches up on the transcript before the first tool call. Runs async. |
| `sessionstart-compact-context.ts` | Re-injects core project conventions after context compaction events. The agent keeps its bearings even in long sessions. |

### PreCompact (2)

| Hook                          | What it does                                                                                                                                                                                                                      |
|-------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `precompact-task-snapshot.ts` | Snapshots all current-session task IDs and statuses to disk before context compaction rewrites the transcript. The sessionstart-compact-context hook reads this snapshot on resume to verify and recreate any missing task files. |
| `precompact-speak.ts`         | Speaks "Just a moment while I gather my thoughts" before context compaction begins, giving audible feedback that the agent is about to pause for compaction.                                                                      |

### UserPromptSubmit (4)

| Hook | What it does |
|------|-------------|
| `userpromptsubmit-git-context.ts` | Injects current git branch and status into every prompt. The agent always knows where it is in the repo. |
| `userpromptsubmit-task-advisor.ts` | Surfaces active tasks before each prompt so the agent stays focused on what it was supposed to be doing. |
| `userpromptsubmit-skill-steps.ts` | When the user's message starts with a `/skill-name` invocation, extracts steps from the skill's SKILL.md and creates pending tasks. Renders content before extraction and applies quality filtering. |
| `posttooluse-speak-narrator.ts` | Catches up on any unspoken assistant text when the user submits a prompt. Ensures narration stays current even during idle periods. Runs async. |

### Notification (1)

Notification hooks are triggered by the daemon when it detects events such as new assistant messages in watched sessions.

| Hook | What it does |
|------|-------------|
| `notification-speak.ts` | Speaks daemon-detected assistant messages via platform-native TTS when `speak` is enabled. Triggered by the daemon's monitoring loop; fire-and-forget so it never blocks the notification path. |

## Plugin Marketplace

swiz ships a Claude Code plugin with a marketplace catalog:

```bash
# Install from the public marketplace
/plugin marketplace add mherod/swiz
/plugin install swiz-core@swiz-marketplace

# Or test locally during development
/plugin marketplace add .
/plugin install swiz-core@swiz-marketplace
```

The `swiz-core` plugin provides:

- **Command**: `install` — runs `swiz install` with optional flags
- **Skills**: `swiz-skill`, `swiz-hooks`, `swiz-install`, `swiz-uninstall`, `swiz-status`, `swiz-settings`, `swiz-tasks`, `swiz-shim`, `swiz-dispatch`, `swiz-transcript`, `swiz-continue`, `swiz-cleanup`, `swiz-session`
- **Skills**: `enable-auto-continue`, `disable-auto-continue` — toggle the autonomous work loop per-session or globally

## Commands

### `swiz install`

Deploy all 112 hooks to agent settings from the canonical manifest. **Merge-based** — swiz hooks are added alongside your existing hooks, never replacing them.

```bash
swiz install              # all agents with configurable hooks
swiz install --claude     # Claude Code only
swiz install --cursor     # Cursor only
swiz install --gemini     # Gemini CLI only
swiz install --codex      # shows Codex status (not yet configurable)
swiz install --dry-run    # line-by-line unified diff, no writes
```

- **Merge, not replace** — user-defined hooks (sound effects, agent hooks, inline scripts, etc.) are preserved. Only swiz-managed hooks are touched.
- **Legacy replacement** — if you previously had hooks at `~/.claude/hooks/`, swiz detects and replaces them with the portable versions from the swiz project.
- **Idempotent** — running install twice produces the same result. Old swiz hooks are stripped before new ones are added.
- Dry run shows an LCS-based unified diff of exactly what would change, plus counts of hooks added/replaced/preserved.
- Creates a `.bak` backup before writing.
- If a running agent process (e.g. Claude Code) reverts the write within 1.5s, swiz detects and warns you to close sessions first.

### `swiz uninstall`

Remove only swiz-managed hooks from agent settings while preserving any user-defined hooks.

```bash
swiz uninstall              # all agents
swiz uninstall --cursor     # Cursor only
swiz uninstall --dry-run    # preview removals
```

### `swiz status`

Show installation state for every agent — binary location, settings file, hook counts (swiz vs other), and active event names.

```bash
swiz status
```

### `swiz settings [show | enable | disable]`

View and modify global swiz behavior flags stored at `~/.swiz/settings.json`.

```bash
swiz settings                         # show effective settings
swiz settings disable auto-continue  # disable stop auto-continue blocker
swiz settings enable auto-continue   # re-enable it
swiz settings show --session --dir <path>                    # show effective setting for latest session in dir
swiz settings disable auto-continue --session --dir <path>   # set override for latest session in dir
swiz settings enable auto-continue --session <id> --dir <path> # set override for matching session
```

Session overrides are keyed by session ID. If no override exists, that session inherits the global setting.

### `swiz memory`

Inspect rule and memory/context files for the detected agent (or force one with flags). Optionally validate against configured thresholds.

```bash
swiz memory                 # detected agent, or all agents if no context is detected
swiz memory --strict        # fail if any memory file exceeds its threshold
swiz memory --all           # always show all agents
swiz memory --codex         # inspect Codex-specific memory/context paths
swiz memory --codex --dir /path/to/project
```

| Flag               | Description                                                                                            |
|--------------------|--------------------------------------------------------------------------------------------------------|
| `--strict`         | Exit with error if any memory file exceeds its line/word threshold (useful in CI and pre-commit hooks) |
| `--all`            | Show memory hierarchy for all agents (default when no agent context is detected)                       |
| `--claude`         | Force Claude Code agent                                                                                |
| `--cursor`         | Force Cursor agent                                                                                     |
| `--gemini`         | Force Gemini CLI agent                                                                                 |
| `--codex`          | Force Codex agent                                                                                      |
| `--dir, -d <path>` | Target project directory (default: cwd)                                                                |

For Codex, `swiz memory --codex` surfaces:

- project rules: `<project>/AGENTS.md`
- global rules: `~/.codex/AGENTS.md`
- global instructions: `~/.codex/instructions.md`

### `swiz hooks [event] [script]`

Inspect hook configurations across all agents.

```bash
swiz hooks                         # list all events from all agents
swiz hooks Stop                    # show hooks registered for Stop
swiz hooks Stop secret-scanner     # print the full source of a hook script
```

### `swiz skill [name]`

Read and expand skill definitions used by Claude Code, Codex, and other AI agents.

```bash
swiz skill              # list all available skills
swiz skill commit       # print skill with inline commands expanded
swiz skill --raw commit # raw SKILL.md without expansion

# Copy Gemini skills to Claude (copy-only — no tool name remapping)
swiz skill --sync-gemini                     # sync ~/.gemini/skills -> ~/.claude/skills
swiz skill --sync-gemini --dry-run           # preview sync actions only
swiz skill --sync-gemini --overwrite         # allow replacing existing target skills

# Convert skills between agents (copies + rewrites tool references)
swiz skill --convert --from gemini --to claude            # convert all Gemini skills to Claude
swiz skill --convert --from claude --to cursor --dry-run  # preview remapping without writing
swiz skill --convert --from codex  --to claude --overwrite
```

Skills are discovered from `.skills/` (project-local) plus provider globals (`~/.claude/skills/`, `~/.cursor/skills/`, `~/.gemini/skills/`, `~/.gemini/antigravity/skills/`, `~/.gemini/antigravity/global_skills/`, `~/.codex/skills/`). Duplicate skill names use deterministic first-found precedence in that exact order (project-local first).

`--sync-gemini` copies Gemini skill directories into `~/.claude/skills/` without transforming content — direct tool references in SKILL.md body or frontmatter are preserved as-is. Use `--convert` for automatic tool name remapping.

`--convert` performs a content-aware conversion: it builds a reverse alias map for the source agent, composes it with the target agent's alias table, and rewrites both the frontmatter `allowed-tools` list and whole-word tool references in the body. Tool names with no target-side equivalent are preserved as-is and reported as warnings — no silent data loss. Supported agent IDs: `claude`, `cursor`, `gemini`, `codex`.

The `` !`command` `` inline syntax is expanded by default — shell commands inside skill content are executed and their output is inlined.

### `swiz shim`

Shell-level command interception that works with **any** agent — no hook event support required. Installs wrapper functions into your shell profile that intercept commands like `grep`, `npm`, `sed`, `node`, and `rm` before they execute.

```bash
swiz shim                 # show installation status
swiz shim install         # add to ~/.zshenv (default for zsh)
swiz shim install .zshrc  # add to ~/.zshrc instead
swiz shim install --dry-run
swiz shim uninstall       # remove from all profiles
```

**How it works:**

- In **non-interactive shells** (agent context): commands are **blocked** with a clear error message explaining the correct alternative. The agent sees exit code 1 and adapts.
- In **interactive shells** (human typing): a yellow **warning** is printed but the command proceeds normally.
- **Bypass**: `SWIZ_BYPASS=1 grep ...` or `command grep ...` to skip the shim.
- **Force strict mode**: `SWIZ_SHIM=strict` to block even in interactive shells.

Shimmed commands: `grep`, `egrep`, `fgrep`, `find`, `sed`, `awk`, `npm`, `npx`, `yarn`, `pnpm`, `node`, `ts-node`, `python`, `python3`, `rm`.

This is the primary workaround for **Cursor CLI**, where only `beforeShellExecution`/`afterShellExecution` events fire — the shim catches everything else at the shell layer.

### `swiz continue`

Generate an AI next-step suggestion from the most recent project session, then continue in Claude. Session discovery covers Claude, Gemini, Antigravity, and Codex IDs for `--session` selection.

```bash
swiz continue             # generate suggestion and resume most recent session
swiz continue --print     # dry run — print the suggestion without resuming
swiz continue --session <id>  # select a specific session (Claude/Gemini/Antigravity/Codex) by ID prefix
```

Uses the same AI backend detection as `stop-auto-continue` (`agent` → `claude` → `gemini`). Exits gracefully if no backend is available.

Notes:

- Antigravity conversations are stored as protobuf (`.pb`). `swiz continue --session` can resolve these IDs, but currently prints a clear unsupported-format diagnostic instead of attempting to decode protobuf conversation content.
- Codex sessions are readable for suggestion generation but are not resumable by Claude session ID, so `swiz continue --session <codex-id>` automatically falls back to `claude --continue`.

**The autonomous loop**: `stop-auto-continue` blocks the agent from stopping, injecting an AI-generated next step suggestion → user runs `swiz continue` → session resumes with that suggestion as the opening prompt → agent works → loop repeats. The agent keeps going until the work is actually done.

### `swiz tasks [subcommand]`

Session-scoped task management with audit logging.

```bash
swiz tasks                                  # list tasks for current project
swiz tasks --all-projects                   # list across all projects
swiz tasks create "subject" "description"   # create a task
swiz tasks complete <id> --evidence "text"  # complete with evidence (required, auto-verifies subject)
swiz tasks status <id> in_progress          # update status
swiz tasks complete-all                     # bulk-complete remaining
```

**Auto-verify**: When completing a task, the subject is automatically verified against the task's actual subject to prevent accidental completion of the wrong task. You can override this with `--verify <custom-text>` if needed.

### `swiz dispatch`

Fan out a hook event to all matching scripts in the manifest. This is the command that agent configs invoke — it reads a JSON payload from stdin and calls every hook registered for the event.

```bash
swiz dispatch <event>                       # dispatch an event, reading payload from stdin
swiz dispatch <event> --replay <file>       # replay a captured payload for debugging
swiz dispatch <event> --replay <file> --json  # replay with machine-readable trace output
```

| Flag              | Description                                                     |
|-------------------|-----------------------------------------------------------------|
| `--replay <file>` | Replay a captured payload file instead of reading stdin         |
| `--json`          | Output trace in machine-readable JSON format (replay mode only) |

### `swiz transcript`

Display Agent-User chat history for the current project. Supports Claude JSONL, Gemini session JSON, and Codex session JSONL event formats, and surfaces Antigravity protobuf sessions with explicit unsupported-format diagnostics when selected.

```bash
swiz transcript                             # detected agent provider, or all providers if no context
swiz transcript --list                      # list all sessions for the project
swiz transcript --all --list                # force listing sessions from all providers
swiz transcript --session <id>              # show a specific session (prefix match)
swiz transcript --tail 10                   # show last 10 turns
swiz transcript --auto-reply                # generate an AI-suggested follow-up
swiz transcript --include-debug             # interleave debug log events inline with turns
swiz transcript --session <id> --include-debug --tail 20  # last 20 turns + debug events
```

| Flag | Description |
|------|-------------|
| `--session, -s <id>` | Show a specific session (prefix match) |
| `--dir, -d <path>` | Target project directory (default: cwd) |
| `--list, -l` | List available sessions without displaying content |
| `--head, -H <n>` | Show only the first N conversation turns |
| `--tail, -T <n>` | Show only the last N conversation turns |
| `--auto-reply` | Generate an AI-suggested follow-up message |
| `--include-debug` | Read `~/.claude/debug/<sessionId>.txt` and interleave debug events inline with turns, ordered by ISO timestamp. Each line renders as a dimmed `│ HH:MM` entry between the turns it falls between. `--head`/`--tail` apply to debug events too. |
| `--all` | Show sessions from all providers (default when no agent context is detected) |
| `--claude` | Show Claude sessions only |
| `--cursor` | Show Cursor sessions only (currently unsupported) |
| `--gemini` | Show Gemini and Antigravity sessions only |
| `--codex` | Show Codex sessions only |

Session discovery paths:

- Claude: `~/.claude/projects/<project-key>/*.jsonl`
- Gemini: `~/.gemini/tmp/*/chats/session-*.json` (mapped via `.project_root`)
- Antigravity: `~/.gemini/antigravity/conversations/*.pb` (mapped via `~/.gemini/antigravity/brain/<id>/...`)
- Codex: `~/.codex/sessions/<year>/<month>/<day>/*.jsonl` (mapped via `session_meta.payload.cwd`)

Provider precedence is deterministic when timestamps tie: Claude → Gemini → Antigravity → Codex.

### `swiz cleanup`

Remove old Claude Code session data from `~/.claude/projects/` and Gemini backup artifacts from `~/.gemini/`. Keeps disk usage under control for long-running projects.

```bash
swiz cleanup                                # remove sessions older than 30 days (+ Gemini backups)
swiz cleanup --older-than 7d               # remove sessions older than 7 days (+ Gemini backups)
swiz cleanup --task-older-than 30d         # also remove old task files (any status)
swiz cleanup --dry-run                     # preview what would be removed
swiz cleanup --project myrepo              # limit Claude cleanup to a specific project
```

**Claude cleanup scope:** `~/.claude/projects/` and `~/.claude/tasks/`

**Gemini backup scope:** `~/.gemini/settings.json.bak` and `~/.gemini/tmp/**/*.bak` (automatically cleaned without additional flags)

| Flag                       | Description                                                                                                                             |
|----------------------------|-----------------------------------------------------------------------------------------------------------------------------------------|
| `--older-than <time>`      | Remove Claude sessions older than this time: days (`30`, `7d`) or hours (`48h`). Default: 30 (Gemini backups removed regardless of age) |
| `--task-older-than <time>` | Also remove task files older than this time (days/hours), regardless of status. Disabled by default.                                    |
| `--dry-run`                | Show what would be removed without deleting                                                                                             |
| `--project <name>`         | Limit Claude cleanup to a specific project directory name                                                                               |

### `swiz issue`

Interact with GitHub issues with guards against accidentally operating on already-closed issues.

```bash
swiz issue close 42                         # close an issue (skips if already closed)
swiz issue comment 42 --body "text"        # comment on an issue (skips if closed)
swiz issue resolve 42 --body "text"        # comment + close in one idempotent call
swiz issue sync                             # sync local issue store from upstream
swiz issue cache-bust                       # clear local issue store cache for repo
swiz issue list                             # list open issues and pull requests
```

| Flag                | Description                                   |
|---------------------|-----------------------------------------------|
| `close <number>`    | Close an issue (skips if already closed)      |
| `comment <number>`  | Comment on an issue (skips if already closed) |
| `resolve <number>`  | Comment and close in one idempotent operation |
| `sync [<repo>]`      | Manually sync local store from upstream GitHub |
| `cache-bust`         | Clear cached issue/PR/CI data for repo        |
| `list [<repo>]`      | List open issues and pull requests from store |
| `--body, -b <text>` | Comment body (for `comment` and `resolve`)    |

### `swiz sentiment`

Score text for approval/rejection sentiment using heuristic regex clusters. Useful for parsing hook feedback, user confirmations, or any text where positive/negative intent matters.

```bash
swiz sentiment "looks good to me"          # score text from arg
echo "LGTM" | swiz sentiment               # score text from stdin
swiz sentiment --json "ship it"            # output result as JSON
swiz sentiment --score-only "no thanks"    # print only the numeric score
```

| Flag           | Description                  |
|----------------|------------------------------|
| `--json`       | Output result as JSON        |
| `--score-only` | Print only the numeric score |

### `swiz session`

Show or list session identifiers for the current project across supported providers.

```bash
swiz session                                # print the current session ID
swiz session --list                        # list all sessions with timestamps
swiz session --dir /path/to/project        # target a specific project directory
```

| Flag               | Description                                       |
|--------------------|---------------------------------------------------|
| `--list, -l`       | List all sessions for the project with timestamps |
| `--dir, -d <path>` | Target project directory (default: cwd)           |

Session ordering is newest-first by modification time. If timestamps tie, the same deterministic provider precedence is used: Claude → Gemini → Antigravity → Codex.

### `swiz ci-wait`

Poll GitHub Actions run status for a specific commit until the run completes. More reliable than `gh run watch` for scripted workflows because it ties polling to an exact commit SHA rather than the latest run.

```bash
swiz ci-wait <commit-sha>                  # poll until CI completes (5 min timeout)
swiz ci-wait <commit-sha> --timeout 600   # custom timeout in seconds
```

| Flag                      | Description                       |
|---------------------------|-----------------------------------|
| `--timeout, -t <seconds>` | Timeout in seconds (default: 300) |

Exit code is `0` on CI success, `1` on failure or timeout.

### `swiz mergetool`

AI-powered Git merge conflict resolver. Resolves conflicts in a file using an AI agent and writes the result to the merged output path. Designed to be used as a `git mergetool` backend.

```bash
# One-time git config setup:
git config merge.tool swiz
git config mergetool.swiz.cmd 'swiz mergetool "$BASE" "$LOCAL" "$REMOTE" "$MERGED"'
git config mergetool.swiz.trustExitCode true

# Then use normally:
git mergetool
```

### `swiz push-wait`

Wait for the push cooldown to expire, then push. The cooldown (configured in `swiz settings`) prevents rapid successive pushes that could race with CI. Use this instead of manual `sleep` + `git push` sequences.

```bash
swiz push-wait                              # wait for cooldown, then push to origin main
swiz push-wait origin feat/my-branch       # specify remote and branch
swiz push-wait --timeout 180               # custom max wait in seconds
```

| Flag | Description |
|------|-------------|
| `--timeout, -t <seconds>` | Max wait for cooldown to expire (default: 120) |

### `swiz doctor`

Check environment health and prerequisites. Reports the status of each detected agent (Claude Code, Cursor, Gemini CLI, Codex), whether its hook configuration is up to date, and whether duplicate skill names exist across skill directories.

```bash
swiz doctor                                 # show health report
swiz doctor --fix                          # auto-fix stale configs + move lower-priority duplicate skills aside
```

| Flag | Description |
|------|-------------|
| `--fix` | Auto-fix stale agent configs by running `swiz install`, fix invalid skill entries, and report skill conflicts |

Skill conflict warnings include both skill file paths, the currently active (winning) path, and the deterministic precedence order used to choose it.

### `swiz help`

Display usage information for all registered commands. Automatically available — no explicit registration required.

```bash
swiz help                                   # list all commands
swiz help <command>                        # show usage for a specific command
```

## Architecture

```
swiz/
├── index.ts                  # CLI entry point
├── src/
│   ├── cli.ts                # Command registration and dispatch
│   ├── types.ts              # Command interface
│   ├── manifest.ts           # Canonical hook manifest (events, matchers, scripts)
│   ├── agents.ts             # Agent definitions, tool/event translation
│   ├── agent.ts              # AI backend detection and prompting (agent/claude/gemini)
│   └── commands/
│       ├── install.ts        # Deploy hooks with per-agent config generation
│       ├── uninstall.ts      # Remove swiz hooks, preserve others
│       ├── status.ts         # Installation state overview
│       ├── hooks.ts          # Inspect hook configs across agents
│       ├── skill.ts          # Read and expand skill definitions
│       ├── tasks.ts          # Session-scoped task management
│       ├── shim.ts           # Shell shim install/uninstall/status
│       ├── transcript.ts     # Display session chat history with head/tail/auto-reply
│       ├── continue.ts       # Resume session with AI-generated next step
│       └── help.ts           # Usage information
└── hooks/
    ├── hook-utils.ts         # Shared utilities: tool equivalence, polyglot output, git/gh, skill checking
    ├── shim.sh               # Shell wrapper functions (sourced from profile)
    ├── task-subject-validation.ts  # Shared validation logic
    └── *.ts                  # 78 hook scripts (all TypeScript)
```

The canonical hook manifest lives in `src/manifest.ts`. Each hook group specifies an event, an optional tool matcher, and a list of scripts. At install time, `agents.ts` translates matchers (`Bash` → `Shell` for Cursor, `Bash` → `run_shell_command` for Gemini) and events (`Stop` → `stop` for Cursor, `Stop` → `AfterAgent` for Gemini, `Stop` → `Stop` for Codex user hooks), then generates the correct config structure per agent.

Hook scripts use the equivalence sets from `hook-utils.ts` (e.g. `isShellTool("run_shell_command")` returns `true`) so they work regardless of which agent's tool name is in the payload.

## Known Limitations

**Cursor CLI** — only `beforeShellExecution` and `afterShellExecution` events fire. All other hook events (`preToolUse`, `postToolUse`, `stop`, `sessionStart`, `beforeSubmitPrompt`, etc.) are silently ignored. This means swiz event hooks only work in the **Cursor IDE**, not when running `cursor` in the terminal. **Workaround**: `swiz shim install` adds shell-level interception that catches banned commands regardless of which agent runs them. Full CLI hook parity is on Cursor's roadmap with no ETA. [Forum thread](https://forum.cursor.com/t/cursor-cli-doesnt-send-all-events-defined-in-hooks/148316).

**Codex CLI** — fully configurable via `~/.codex/hooks.json` (global) and `<cwd>/.codex/hooks.json` (per-project). Hooks.json (v0.116.0+) ships `SessionStart`, `Stop`, and `UserPromptSubmit` user-facing events. Tool-use hook types still use internal Rust names (`BeforeToolUse`, `AfterToolUse`) internally but are mapped to canonical names for hook discovery and display.

**Claude Code settings revert** — a running Claude Code process watches `~/.claude/settings.json` and may revert writes within ~1.5 seconds. Close all Claude Code sessions before running `swiz install`, or the changes won't persist.

## License

`swiz` is licensed under PolyForm Noncommercial 1.0.0. You may use, modify, and share it for noncommercial purposes under [LICENSE](LICENSE). Commercial use, resale, and commercial repurposing require separate permission from Matthew Herod.
