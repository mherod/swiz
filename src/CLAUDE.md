## Daemon
- `src/commands/daemon.ts`: long-lived `Bun.serve` on port 7943; scope per-project state by `cwd`.
- Endpoints: `/health`, `/dispatch` (POST), `/status-line/snapshot` (POST), `/metrics` (GET), `/ci-watch` (POST), `/ci-watches` (GET).
- `swiz daemon status` fetches `/metrics`; metrics are in-memory, global and per-project.
- Bare `swiz status-line` reads no stdin JSON: `session_id` is null, so tasks/ctx segments vanish (expected). Test by piping a real payload into `SWIZ_DIRECT=1 bun index.ts status-line`.
- LaunchAgent: `~/Library/LaunchAgents/com.swiz.daemon.plist`; `swiz daemon --install` / `--uninstall`.
- **DO**: In daemon-served `src/web/**` modules, use browser-resolvable imports only (`./`, `../`, `/web/...`). **DON'T** use bare package imports unless daemon adds import-map/bundling support.
- **DO**: Restart daemon after `src/web/**`, hook, or dispatch changes. If live `swiz dispatch` contradicts current code, replay raw payload with `bun hooks/<hook>.ts < /tmp/swiz-incoming/<file>.raw.json`; if standalone passes, restart port 7943 and confirm fresh `swiz daemon status`.
- **DO**: Use `IssueStore` (`src/issue-store.ts`) for issues/PRs/CI. Daemon `syncUpstreamState` keeps it fresh. **DON'T** use per-project file caches — `~/.swiz/issues.db` replaces them.
- **DO**: Add consumer-needed fields (`mergeable`, `url`) to `syncUpstreamState` in `src/issue-store.ts`.
- **DO**: Prefer `gh api repos/{owner}/{repo}/...` (REST) over `gh issue view`/`gh pr list` (GraphQL) — higher rate limits. Close: `gh api repos/:owner/:repo/issues/{number} -X PATCH -f state=closed`.
## Settings Configuration
- Separate state files for runtime data (`.swiz/context-stats.json`); never mix into config (`.swiz/config.json`).
- **DO**: Use `recordExecutionDuration()` in `src/utils/execution-timing.ts` for lint/test/typecheck timings. Preserve legacy `totalTimeMs`/`count`, the 50-sample `recentRuns` limit, source/outcome metadata, file locks, and atomic writes. Keep the stop-hook lock-acquisition timeout parameter at 250ms to leave cleanup headroom; this is not a cap on total recording time. Recording failures must not change verification results. Measure subprocesses individually with `performance.now()` and preserve parallel execution; whole-hook duration cannot substitute for individual check times.
- 3-tier resolution: `project > user > default`. Track source per value, not per group. Label with `(project)`, `(user)`, `(default)`.
- Show all effective values; never hide user/default. No shared `source` for multiple settings.
- Adding a boolean setting (global scope) requires updating `src/settings/{types,registry,persistence,resolution}.ts`, `src/commands/settings{.ts,.test.ts}`, and `src/web/components/settings-panel.tsx`.
## CLI Error Handling
- Throw errors in `src/commands/` instead of `process.exit(1)`. `src/cli.ts` and `src/commands/continue.ts` handle errors via `process.exitCode = 1`. Hook scripts (`hooks/*.ts`) use `process.exit(0)`.
- Use `console.error` (not `console.log`) in CI/hook scripts. Use `debugLog` from `./debug.ts` elsewhere. `console.*` is blocked except where allowlisted in `src/debug-logging.test.ts` with a justification.
- Reference implementations: `src/issue-store.ts`, `src/manifest.ts`, `src/commands/tasks.ts`.
- **DO**: Keep guardian retry budgets command-scoped until a matching successful attempt; never expire unresolved denials on a rolling timer. In `src/guardian-review.ts`, require exactly one literal attributable `tools.exec_command` invocation within `functions.exec` wrappers and reject ambiguous wrappers; preserve support for direct command calls. Preserve `swiz:guardian-git-add-denial`; exhausting the finite retry budget permits normal approval review, never bypasses it.
## AI Generation
- **DO**: Keep `idea`, each `streamAutoReply` pass, and the entire `humaniseAutoSteerMessage` fallback chain at a 15,000ms default. Preserve explicit overrides; report cancellation cleanup separately from generation latency.
- **DO**: Enforce native CLI tool controls in `src/ai-providers.ts`. Claude uses `tools: []`, `settingSources: []`, and `strictMcpConfig: true`; Codex uses disabled native features plus `src/utils/codex-generation-cli.ts` with an isolated cwd and `--ignore-user-config --ephemeral`, retaining authentication. **DON'T** rely on AI SDK `toolChoice`/step limits or Codex `mcp_servers={}` to disable inherited native tools.
- **DO**: Preserve idea's bounded README context, low reasoning, and `structuredOutput: "prompt"` path; parse JSON and validate with Zod before printing. Native structured output remains the default elsewhere. **DON'T** increase timeouts to hide additional structured-output agent turns.
- **DO**: Compare providers sequentially with matching inputs, fresh caches, explicit provider selection, and no timeout overrides when verifying defaults. Preview without scheduling messages; confirm steering's model-response cache to distinguish AI output from local fallback. Treat individual timings as samples, not guarantees. Reference: `docs/ai-providers.md`.
