# Claude lifecycle event coverage

This document records, for every Claude Code lifecycle event, whether swiz maps it
into a dispatch route or intentionally leaves it **reserved**, and why. It exists so
each lifecycle-coverage audit does not have to re-derive the same analysis.

**Source of truth:** the event list is `HookEventNameSchema` in
[`agent-hook-schemas/claude`](../node_modules/agent-hook-schemas/claude.ts) (the
vendored Claude hook schema package). The *mapped* set is derived from Claude's
`eventMap` in [`src/agents.ts`](../src/agents.ts); the *reserved* set is everything
in the schema that `eventMap` does not list. `src/lifecycle-event-coverage.test.ts`
fails if this table drifts from those two sources, so it stays in sync whenever the
Claude `eventMap` or the upstream schema changes.

"Mapped" means swiz accepts the event (it is in `PUBLIC_HOOK_EVENTS_BY_AGENT.claude`),
routes it through `DISPATCH_ROUTES`, and has at least one manifest entry or active hook
for it. "Reserved" means the event is known to exist but swiz deliberately does not
install against it yet.

## Coverage table

| Claude event | Status | swiz event | Rationale |
|--------------|--------|------------|-----------|
| `SessionStart` | Mapped | `sessionStart` | Session bootstrap context (self-heal, environment detect, state context). |
| `Setup` | Reserved | — | One-time environment setup; swiz has no setup-time behaviour to install. |
| `InstructionsLoaded` | Reserved | — | Fires when CLAUDE.md/instructions load; no swiz action distinct from SessionStart. |
| `UserPromptSubmit` | Mapped | `userPromptSubmit` | Injects git/task context and skill-step tasks on each prompt. |
| `UserPromptExpansion` | Reserved | — | Prompt macro/expansion phase; no swiz transformation needed. |
| `PreToolUse` | Mapped | `preToolUse` | The primary gate surface (banned commands, task governance, branch gates). |
| `PermissionRequest` | Mapped | `permissionRequest` | Records permission-gated attempts into the infraction layer. |
| `PostToolUse` | Mapped | `postToolUse` | Post-edit/format, task sync, state transitions, narration. |
| `PostToolUseFailure` | Mapped | `postToolUseFailure` | Direct tool-failure signal for the retry advisor. |
| `PostToolBatch` | Reserved | — | Batched tool-result phase; PostToolUse already covers per-call needs. |
| `PermissionDenied` | Reserved | — | Hard denial after PermissionRequest; the request phase is where swiz records friction. Revisit if denial-only telemetry is needed. |
| `Notification` | Mapped | `notification` | Daemon-driven TTS for watched-session messages. |
| `SubagentStart` | Mapped | `subagentStart` | Subagent lifecycle context. |
| `SubagentStop` | Mapped | `subagentStop` | Subagent completion handling. |
| `TaskCreated` | Reserved | — | Background-task lifecycle; mapping tracked in issue #691. |
| `TaskCompleted` | Reserved | — | Background-task lifecycle; mapping tracked in issue #691. |
| `Stop` | Mapped | `stop` | The main stop-gate surface (ship checklist, incomplete tasks, quality checks). |
| `StopFailure` | Reserved | — | Fires when a Stop hook itself errors; swiz has no recovery behaviour to attach. |
| `TeammateIdle` | Reserved | — | Multi-agent teammate idleness; outside swiz's single-session scope. |
| `ConfigChange` | Reserved | — | Settings mutation event; swiz reads settings on demand rather than reacting. |
| `CwdChanged` | Reserved | — | Working-directory change; dispatch already resolves cwd per payload. |
| `FileChanged` | Reserved | — | External file-watch event; swiz acts on tool edits, not ambient file changes. |
| `WorktreeCreate` | Reserved | — | Git worktree lifecycle; no swiz worktree-time behaviour. |
| `WorktreeRemove` | Reserved | — | Git worktree lifecycle; no swiz worktree-time behaviour. |
| `PreCompact` | Mapped | `preCompact` | Snapshots task state before compaction. |
| `PostCompact` | Mapped | `postCompact` | Restores the task snapshot and injects recovery guidance after compaction. |
| `SessionEnd` | Mapped | `sessionEnd` | Session teardown handling. |
| `Elicitation` | Reserved | — | Interactive elicitation prompt; no swiz interception. |
| `ElicitationResult` | Reserved | — | Result of an elicitation prompt; no swiz interception. |

## Keeping this in sync

When Claude adds a lifecycle event, the upstream `HookEventNameSchema` gains an entry
and `src/lifecycle-event-coverage.test.ts` fails until this table lists it. When swiz
maps a previously-reserved event, move its row from Reserved to Mapped and fill in the
swiz event name — the same test verifies the status matches Claude's `eventMap`.
