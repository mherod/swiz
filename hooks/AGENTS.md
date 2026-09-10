## Hook System
- Hooks live in `hooks/`; `manifest` lives in `src/manifest.ts`.
- CamelCase events: `stop`, `preToolUse`, `postToolUse`, `sessionStart`, `userPromptSubmit`, `preCommit`.
- `EVENT_MAP` maps events; `TOOL_ALIASES` maps agent tools. Claude uses nested `settings.json` matchers; Cursor uses flat `hooks.json` lists.
- Add hook flow (agent events):
  1. Add `hooks/<name>.ts`.
  2. Add entry to `manifest` in `src/manifest.ts`.
  3. If new event: update `DISPATCH_ROUTES` in `src/dispatch/index.ts` and each agent `eventMap` in `src/agents.ts`.
  4. Run `swiz install --dry-run`.
  5. Run `swiz install` to write dispatch entries.
- Add hook flow (non-agent/scheduled events like `preCommit`, `prePush`):
  1. Add `hooks/<name>.ts`.
  2. Add entry to `manifest` with `scheduled: true` — skips agent eventMap validation and `swiz install`.
  3. Add `DISPATCH_ROUTES` entry in `src/dispatch/index.ts`.
  4. Add event to `TOOL_NAME_OPTIONAL_EVENTS` in `src/dispatch/execute.ts`.
  5. Add `DISPATCH_TIMEOUTS` entry in `src/manifest.ts`.
  6. Wire into `lefthook.yml` with `SWIZ_DIRECT=1 bun run index.ts dispatch <event>`.
- Synchronize `DISPATCH_ROUTES`, `manifest`, and agent `eventMap`.
- `validateDispatchRoutes()` in `src/manifest.ts` must pass from both `swiz dispatch` and `swiz install`.
- Keep `src/dispatch-routing.test.ts` passing.
- Add hooks to existing preToolUse matcher groups; duplicates are shadowed because `manifest.find()` returns the first match.
- DO NOT add sync hooks to unmatchered preToolUse groups — `manifest.test.ts` requires `matcher` for groups with sync hooks; async-only groups are exempt.
- DON'T hard-code agent event or tool names in hook scripts.
- `classifyHookOutput` (`src/dispatch/worker-types.ts`) validates subprocess stdout with `hookOutputSchema`; failures return `"invalid-schema"`. Rejected silent output requires `systemMessage`, `reason`, `stopReason`, or `additionalContext`; `{}` is valid. **Stop/SubagentStop** responses use `stopHookOutputSchema` (`src/dispatch/stop-response.ts`); see `hooks/schemas.ts` for event stdout fields.
- In `lefthook.yml`, use `SWIZ_DIRECT=1 bun run index.ts dispatch <event>`; omitting triggers the global-link check.
- Hooks scanning staged diffs for code patterns (`.only`, `fdescribe`, etc.) must exclude `hooks/` and test files via `FOCUSED_TEST_EXCLUDE_RE` — regex definitions in hook source trigger false positives on themselves.
- **Inline SwizHook imports**: Hooks imported by `manifest.ts` must NOT import from `hook-utils.ts` (circular dep via `skill-utils.ts` → `agents.ts`) or `git-utils.ts` (circular dep via `settings.ts` → `settings/persistence.ts` → `manifest.ts`). Safe: `tool-matchers.ts`, `git-helpers.ts`, `shell-patterns.ts`, `skill-utils.ts`, `node-modules-path.ts`, `command-utils.ts`, `utils/edit-projection.ts`, `utils/inline-hook-helpers.ts`, `utils/package-detection.ts`, `hooks/schemas.ts`.
- **Inline SwizHook migration unit**: Helper extraction and dependent hook migration ship as one commit — run `bun run typecheck` after extraction, then migrate and commit together.
- **Inline SwizHook output**: Use `preToolUseAllow()`/`preToolUseDeny()` from `SwizHook.ts` — return objects instead of calling `process.exit`. Use `runSwizHookAsMain()` for standalone `import.meta.main` compatibility.
- **Inline SwizHook import.meta.main**: Replace the old standalone block with `if (import.meta.main) await runSwizHookAsMain(hook)`. DON'T keep a `Bun.stdin.json()` read alongside it — `runSwizHookAsMain` owns stdin; double-read causes null input, silent exit 0, empty subprocess stdout (`JSON.parse(stdout)` throws `Unexpected EOF`).
- **Debt marker self-detection**: Hook files containing keywords in `//` comments trigger `pretooluse-todo-tracker`. Use JSDoc `/** */` format for headers or dynamic regex construction (`"TO" + "DO"`) to avoid self-detection.
## Writing Hooks
- Update `README.md` whenever `src/manifest.ts` changes.
- `src/readme-hook-counts.test.ts` invariants:
  1. `### <EventName> (N)` heading count matches section rows.
  2. README intro `**N hooks**` (line 7) matches manifest total.
  3. Every README hook filename exists on disk.
- Per hook: increment section count, add table row, increment `**N hooks**`, run `bun test src/readme-hook-counts.test.ts`.
- Hooks are TypeScript, use `hooks/hook-utils.ts`, read JSON stdin, exit 0.
- Output helpers (call `process.exit(0)`; no stdout after):
  - PreToolUse: `denyPreToolUse(reason)` — block with footer; `allowPreToolUse(reason)` — allow with hint; `allowPreToolUseWithUpdatedInput(updatedInput, reason?)` — allow with modified input.
  - PostToolUse: `denyPostToolUse(reason)` — feed error back to Claude.
  - Context injection: `emitContext(eventName, context, cwd?)` — use for SessionStart, UserPromptSubmit, PostToolUse `additionalContext`; handles `systemMessage` wrapper and state-line injection automatically.
  - Stop: `blockStop(reason, opts?)` — block with footer; `blockStopRaw(reason)` — block without footer.
- **DO NOT** write raw `console.log(JSON.stringify(...))` — use output helpers: `allowPreToolUse`, `denyPreToolUse`, `emitContext`, `blockStop`/`blockStopRaw`.
- **Subprocess timeout**: Use `spawnWithTimeout(cmd, { cwd, timeoutMs })` from `hook-utils.ts`. DON'T use raw `Bun.spawn()` with manual timers.
- **Dispatch abort**: Strategies with `AbortController` must listen on `ctx.signal` (from `DispatchRequest.signal` or `HookStrategyContext.signal`).
- **Dispatch payload enrichment**: `performDispatch` injects `_effectiveSettings` and `_terminal` into payload. Read from payload; don't call `detectTerminal()` in daemon code.
- **Cursor cwd + captures**: `normalizeAgentHookPayload` uses `workspace_roots` if cwd empty/outside; strips `…/.cursor` (not `…/projects/`). `swiz dispatch` injects `process.cwd()` if missing. Captured in `/tmp/swiz-incoming/` via `incoming-capture.ts`, `src/commands/dispatch.ts` for CLI dispatch and `src/SwizHook.ts` `runSwizHookAsMain` for standalone hook subprocesses. Each dispatch also appends a sanitized raw payload line to `/tmp/swiz-incoming/{canonicalEventName}.jsonl` (via `schedulePayloadJsonlAppend`; wired in CLI dispatch and daemon). See `_envKeys`, `SWIZ_CAPTURE_INCOMING=0` (~10m retention).
- **File-path guard**: `filePathGuardHook(predicate, denyReason, allowMsg?)` for file-path PreToolUse hooks.
- **Git utilities**: Import canonical helpers; never define local copies. `src/utils/hook-utils.ts`: regexes, extractors, runtime helpers (`git`, `gh`, `ghJson`). `src/git-helpers.ts`: classifiers (`isDocsOrConfig`, `parseCommitType`), status types, queries; its `git()` strips `GIT_*` env vars.
- **PR merge detection**: Use `isPullRequestMergeCommand()` from `src/utils/git-utils.ts` in behavioral gates; `GH_PR_MERGE_RE` matches only native `gh pr merge`. It detects REST `PUT .../pulls/{number}/merge` and GraphQL `mergePullRequest`, `enablePullRequestAutoMerge`, and `enqueuePullRequest`.
- **DON'T** run `stripQuotedShellStrings()` before detection; GraphQL bodies are quoted CLI arguments. Hooks using `extractPrNumber()` must handle `null` for GraphQL node-ID mutations.
- **GitHub API throttle** (`src/gh-rate-limit.ts`): call `await acquireGhSlot()` before each `gh` request; `gh()` does so. Direct `Bun.spawn(["gh"...` must too. Limit: 4500/hour. Exempt: `gh auth status`, `gh run watch`.
- Skill helpers: `skillExists` (checks `.skills/` and `~/.claude/skills/` for `SKILL.md`), `skillAdvice`.
- Cross-agent tool checks: `isShellTool`, `isEditTool`, `isFileEditTool`, `isCodeChangeTool`, `isTaskTool`, `isTaskCreateTool`.
- Task-tracking exemptions: `isTaskTrackingExemptShellCommand()` exempts read-only git, `gh`, `swiz`, setup, recovery (`RECOVERY_CMD_RE`: `ps`, `lsof`, `trash`, `wc`). **DON'T** add broad patterns to `RECOVERY_CMD_RE`.
- **DO** align `hooks/shim.sh` package-manager decisions with `src/utils/package-detection.ts`: honour `package.json#packageManager`, allow npm when npm and non-npm lockfiles coexist, resolve npm/npx `--prefix` targets, and test sourced-shell behaviour in `src/commands/shim.test.ts`. **DON'T** let an ancestor `pnpm-lock.yaml` override nearer explicit npm signals.
- Typed inputs: `StopHookInput`, `ToolHookInput`, `SessionHookInput` — parse with `stopHookInputSchema`, `toolHookInputSchema`, `fileEditHookInputSchema`, `shellHookInputSchema`, or `sessionHookInputSchema`, or annotate directly; **DO NOT** cast stdin with `as { ... }`.
- Hook schemas (`hooks/schemas.ts`, `z.looseObject`): `fileEditHookInputSchema`, `shellHookInputSchema`, `toolHookInputSchema`, `stopHookInputSchema`, `sessionHookInputSchema`, `hookOutputSchema`, `stopHookOutputSchema`, `taskUpdateInputSchema` — module doc = stdout fields by event. Settings (`src/settings.ts`): `swizSettingsSchema`, `projectSettingsSchema`, `sessionSwizSettingsSchema`, `projectStateSchema`. State (`src/state-machine.ts`): `workflowIntentSchema`, `statePrioritySchema`, `stateMetadataSchema`.
- **DO**: Inspect runtime type predicate definitions (e.g. `isCurrentSessionUsageEvent` in `src/transcript-summary.ts`) before constructing mock test event objects to ensure correct property types (e.g. `timestamp` ISO string).
- **Hook cooldowns**: `cooldownSeconds` skips re-runs within the window (per hook+cwd).
- **Auto-steer**: `scheduleAutoSteer(sessionId, message, trigger?, cwd?)` (`hook-utils.ts`); pass `cwd`, branch on return (allow vs deny PreToolUse), `store.consumeOne()`. `requiredSettings: ["autoSteer"]`. Triggers: `next_turn`, `after_commit`, `after_all_tasks_complete`, `on_session_stop`.
- **DO**: Memory-threshold checkpoints use `resolveThresholds(cwd)` (project > global > default 5000). Never hardcode.
- **DO**: Use `computeProjectedContent()` from `hook-utils.ts` — suppresses `$&`/`$'`/`` $` `` interpolation. DON'T call `.replace()` directly. Fail-open on errors.
- NFKC-normalize `new_string`/`content`/`old_string` before pattern matching in content-inspecting hooks: `.normalize("NFKC")`. Enforced by `src/nfkc-enforcement.test.ts`. Exempt hooks must be listed in `EXEMPT_HOOKS`.
- Use `TEST_FILE_RE` (`.test.ts`, `.spec.ts`, `__tests__/`, `/test/`) for test-file exclusions.
- DO NOT test external repo code here; file issue in owning repo.
- Track current diff file from `+++ b/<path>` headers; apply file-level exclusions via that path.
- Use `sanitizeSessionId()` for `/tmp` names.
- DO: Use `src/temp-paths.ts` for `/tmp` paths; no `/tmp/*` literals.
- DO NOT hardcode `/tmp` sentinel session IDs in tests; use unique IDs or `mtime` checks.
- For `pgrep` checks, use ancestry (`process.ppid`) and scope (`lsof -p <pid> -d cwd -Fn`).
- Reference implementation: `hooks/stop-ship-checklist.ts` (git + CI + issues). `hooks/stop-git-status.ts` exports `collectGitWorkflowStop` / `evaluateStopGitStatus` for tests.
- For `~/.claude/projects/` lookups, import `projectKeyFromCwd` from `src/transcript-utils.ts` — DO NOT reimplement.
- In `hook-utils.ts`, lazy `await import(...)` for `projectKeyFromCwd` (circular import avoidance).
- Workflow enforcement: scan `transcript_path` for evidence — no extra state files.
- `pretooluse-update-memory-enforcement.ts` requires reading `update-memory/SKILL.md` and writing `.md` before unblocking.
- Cross-repo issue guidance: `buildIssueGuidance()` in `hook-utils.ts`. Generic: `buildIssueGuidance(null)`; cross-repo: `buildIssueGuidance(repo, {crossRepo:true, hostname})`.
- **DO**: When extracting from a shared module, re-export all types downstream consumers import. Verify `pnpm typecheck` before committing.
