# Hook Messaging Methodology

Swiz hooks communicate with AI agents through structured messages that range from ambient guidance to hard blocks. This document formalizes the 4-tier messaging model that has emerged across the hook system, providing templates, vocabulary, and conformance rules for new and existing hooks.

---

## Design Principle

Enforcement intensity scales with the agent's deviation from expected behavior. The exit condition is always human intervention (interrupting the session) or full compliance. Hooks never negotiate — they inform, reinforce, escalate, or block.

---

## The 4-Tier Model

| Tier | Name | Blocking? | Events | Purpose |
|------|------|-----------|--------|---------|
| 1 | Ambient Context | No | SessionStart, UserPromptSubmit, PostToolUse | Neutral guidance without blocking |
| 2 | Positive Reinforcement | No | PostToolUse | Confirm correct behavior patterns |
| 3 | Escalating Advisory | No | PostToolUse | Progressive pressure as state degrades |
| 4 | Hard Block | Yes | PreToolUse, Stop | Binary gate — comply or remain blocked |

### Escalation Ladder

```
Session start ──► Ambient context (tier 1)
                    │
Each prompt ──────► Task advisory (tier 1)
                    │
After task tools ──► Reinforcement or urgency (tier 2/3)
                    │
Before Edit/Write/Bash ──► Hard block if non-compliant (tier 4)
                    │
Before stop ──────► Chain of stop gates (tier 4)
```

---

## Tier 1: Ambient Context

**Purpose:** Orient the agent at session start and between turns. State facts and suggest actions without blocking.

**Events:** `SessionStart`, `UserPromptSubmit`, `PostToolUse` (via `additionalContext`)

**Output helper:** `emitContext(eventName, context)` or `buildContextHookOutput(eventName, context)`

**Tone:** Neutral, informational. No urgency markers.

**Template:**
```
[factual observation]. [suggested action].
```

**Examples:**
| Hook | Message |
|------|---------|
| `userpromptsubmit-task-advisor` | `No pending tasks in this session. Use TaskCreate to create a task for this prompt before starting work.` |
| `sessionstart-health-snapshot` | `Daemon status: running on port 7943. 3 active sessions.` |
| `userpromptsubmit-git-context` | `On branch main tracking origin/main. The working tree is clean. 1 commit not yet pushed. We should push these commits.` |

**Hooks in this tier:**
- `sessionstart-compact-context.ts`
- `sessionstart-environment-detects.ts`
- `sessionstart-health-snapshot.ts`
- `sessionstart-self-heal.ts`
- `sessionstart-state-context.ts`
- `userpromptsubmit-git-context.ts`
- `userpromptsubmit-skill-steps.ts`
- `userpromptsubmit-task-advisor.ts`
- `posttooluse-git-context.ts`
- `posttooluse-pr-context.ts`
- `posttooluse-skill-steps.ts`

---

## Tier 2: Positive Reinforcement

**Purpose:** Affirm that the agent is on track. Reinforcement stabilizes correct behavior and reduces unnecessary course corrections.

**Events:** `PostToolUse` (via `additionalContext`)

**Tone:** Affirming. Cites specific evidence.

**Template:**
```
[positive observation]: [specific evidence]. [continuation guidance].
```

**Example:**
```
Good task hygiene: you have a planning buffer (multiple pending tasks) and a
single clear in_progress focus. That matches workflow expectations — keep updating
status as you complete work and add pending tasks before the queue runs low.
```

**Source:** `src/tasks/task-count-summary.ts` — the `buildCountSummary` function emits this when `pending >= 2` and `inProgress >= 1`.

**Convention:** For every new enforcement hook (tier 4), consider adding a corresponding tier 2 reinforcement path that fires when the agent is in compliance. The ratio of blocks-to-praise should not be heavily skewed toward punishment.

**Hooks in this tier:**
- `posttooluse-task-count-context.ts` (via `task-count-summary.ts`)
- `posttooluse-task-list-sync.ts` (via `task-count-summary.ts`)

---

## Tier 3: Escalating Advisory

**Purpose:** Apply progressive pressure as the agent drifts from compliance thresholds. Non-blocking but increasingly urgent.

**Events:** `PostToolUse` (via `additionalContext`)

**Tone:** Urgent but not blocking. Uses progressive language prefixes.

**Escalation levels:**
1. `Proactive task planning needed:` — mild advisory
2. `URGENT:` — strong advisory, next tool call may trigger tier 4 block

**Template:**
```
[urgency prefix]: [specific deficit]. [concrete remediation with tool names].
```

**Examples:**
```
Proactive task planning needed: only 1 pending task remains. Create 1 more
pending task to maintain the planning buffer.
```

```
URGENT: Zero pending tasks. Task governance requires ≥2 pending tasks at all
times. Use TaskCreate to add two pending tasks now.
```

**Source:** `src/tasks/task-count-summary.ts` — `buildCountSummary` emits `URGENT:` when `pending === 0`, `Proactive task planning needed:` when `pending === 1`.

**Hooks in this tier:**
- `posttooluse-task-count-context.ts` (via `task-count-summary.ts`)
- `posttooluse-task-list-sync.ts` (via `task-count-summary.ts`)

---

## Tier 4: Hard Block

**Purpose:** Binary gate. The tool call or session stop is denied until the agent complies. There is no negotiation — the agent must perform the specified remediation action.

**Events:** `PreToolUse` (via `preToolUseDeny`), `Stop` (via `blockStop`)

### Required elements

Every tier 4 message **must** include:

1. **Reason** — What specifically is wrong, citing counts, thresholds, or file paths.
2. **Action plan** — Concrete numbered steps the agent must take to unblock, using `formatActionPlan()` where possible.
3. **ACTION REQUIRED footer** — Automatically appended by `preToolUseDeny()` and `blockStop()`. Do not use raw `console.log(JSON.stringify(...))` — always use the output helpers.

### PreToolUse denial template

For governance/enforcement hooks that use the `STOP.` prefix:
```
STOP. ${toolName} is BLOCKED because [specific reason].

[formatActionPlan steps]

[ACTION REQUIRED footer — auto-appended by preToolUseDeny()]
```

For simpler constraint hooks (file guards, command bans):
```
[Descriptive block reason]: [specific details].

[Remediation options or commands]

[ACTION REQUIRED footer — auto-appended by preToolUseDeny()]
```

### Stop block template

```
[Descriptive reason with evidence].

[formatActionPlan steps or specific commands]

[ACTION REQUIRED footer — auto-appended by blockStop()]
```

### When to use `STOP.` prefix

The `STOP.` prefix is reserved for **governance enforcement hooks** — hooks that manage task lifecycle, workflow compliance, and agent behavioral constraints. These hooks regulate the agent's meta-behavior (how it plans and tracks work), not just specific tool inputs.

Hooks using `STOP.` prefix:
- `pretooluse-task-governance.ts` — task lifecycle enforcement
- `pretooluse-git-index-lock.ts` — git state safety
- `pretooluse-read-grep-stall-guard.ts` — agent behavior pattern detection

Hooks that block without `STOP.` (correct — they enforce specific constraints, not governance):
- `pretooluse-large-files.ts` — file size limits
- `pretooluse-banned-commands.ts` — dangerous command prevention
- `pretooluse-push-checks-gate.ts` — pre-push validation
- `pretooluse-no-eslint-disable.ts` (via `pretooluse-ts-quality.ts`) — lint rule enforcement

### When to use `formatActionPlan()`

Use `formatActionPlan()` when the remediation requires multiple ordered steps. For single-action remediations (e.g., "use `bun` instead of `npm`"), inline text is sufficient.

### `blockStop()` vs `blockStopRaw()`

- **`blockStop(reason)`** — Appends the ACTION REQUIRED footer. Use for all standard stop blocks.
- **`blockStopRaw(reason)`** — No footer appended. Use only when the caller controls the full reason text and the footer would be inappropriate (e.g., `stop-auto-continue.ts` which blocks to trigger continuation, not to demand remediation).
- **`blockStopHumanRequired(reason)`** — Adds `resolution: "human-required"` to signal the agent cannot resolve autonomously.

### Hooks in this tier

**PreToolUse denial hooks (50 files):**

Governance enforcement (use `STOP.` prefix + `formatActionPlan()`):
- `pretooluse-task-governance.ts` — 9 block paths
- `pretooluse-git-index-lock.ts` — git lock detection
- `pretooluse-read-grep-stall-guard.ts` — read/search stall detection
- `pretooluse-no-phantom-task-completion.ts` — phantom completion prevention
- `pretooluse-skill-invocation-gate.ts` — skill gate enforcement
- `pretooluse-update-memory-enforcement.ts` — memory update enforcement

Constraint enforcement (descriptive reason, no `STOP.` prefix):
- `pretooluse-large-files.ts` — file size limits
- `pretooluse-banned-commands.ts` — dangerous command prevention
- `pretooluse-push-checks-gate.ts` — pre-push checks
- `pretooluse-ts-quality.ts` — TypeScript quality (eslint-disable, ts-ignore, as any)
- `pretooluse-no-npm.ts` — package manager enforcement
- `pretooluse-no-lockfile-edit.ts` — lockfile protection
- `pretooluse-no-node-modules-edit.ts` — node_modules protection
- `pretooluse-no-direct-deps.ts` — dependency management
- `pretooluse-eslint-config-strength.ts` — lint config ratchet
- `pretooluse-long-sleep.ts` — sleep duration limits
- `pretooluse-no-cp.ts` — cp command prevention
- `pretooluse-block-commit-to-main.ts` — branch protection
- `pretooluse-no-secrets.ts` — secret detection
- `pretooluse-no-issue-close.ts` — issue close prevention
- `pretooluse-no-merge-conflict-comments.ts` — merge conflict marker detection
- `pretooluse-no-mixed-tool-calls.ts` — tool call ordering
- `pretooluse-dirty-worktree-gate.ts` — worktree state
- `pretooluse-no-push-when-instructed.ts` — push instruction compliance
- `pretooluse-manifest-order-validation.ts` — manifest ordering
- `pretooluse-json-validation.ts` — JSON syntax validation
- `pretooluse-bun-api-enforce.ts` — Bun API usage
- `pretooluse-bun-test-concurrent.ts` — test concurrency
- `pretooluse-block-preexisting-dismissals.ts` — dismissal prevention
- `pretooluse-no-task-delegation.ts` — task delegation prevention
- `pretooluse-task-subject-validation.ts` — compound subject detection
- `pretooluse-pr-age-gate.ts` — PR age limits
- `pretooluse-pr-changes-branch-guard.ts` — PR branch protection
- `pretooluse-stale-approval-gate.ts` — stale approval detection
- `pretooluse-offensive-language.ts` — language standards
- `pretooluse-push-cooldown.ts` — push rate limiting
- `pretooluse-protect-sandbox.ts` — sandbox protection
- `pretooluse-protect-strict-main.ts` — strict main protection
- `pretooluse-main-branch-scope-gate.ts` — main branch scope
- `pretooluse-trunk-mode-branch-gate.ts` — trunk mode enforcement
- `pretooluse-state-gate.ts` — workflow state gates
- `pretooluse-ts-edit-state-gate.ts` — TypeScript edit state
- `pretooluse-sandbox-guidance-consolidation.ts` — sandbox guidance
- `pretooluse-taskoutput-timeout.ts` — TaskOutput timeout limits
- `pretooluse-repeated-lint-test.ts` — repeated lint/test detection
- `pretooluse-workflow-permissions-gate.ts` — workflow permissions
- `pretooluse-claude-md-word-limit.ts` — CLAUDE.md word count
- `pretooluse-claude-word-limit.ts` — general word count

**Stop block hooks (25+ files):**
- `stop-git-status.ts` — uncommitted changes
- `stop-completion-auditor.ts` — task completion enforcement
- `stop-incomplete-tasks.ts` — incomplete task detection
- `stop-todo-tracker.ts` — TODO comment detection
- `stop-secret-scanner.ts` — secret detection
- `stop-large-files.ts` — large file detection
- `stop-lockfile-drift.ts` — lockfile consistency
- `stop-lint-staged.ts` — lint-staged checks
- `stop-quality-checks.ts` — quality check enforcement
- `stop-reflect-on-session-mistakes.ts` — reflection enforcement
- `stop-ship-checklist.ts` — ship readiness
- `stop-pr-description.ts` — PR description quality
- `stop-pr-changes-requested.ts` — outstanding review feedback
- `stop-pr-feedback.ts` — PR feedback resolution
- `stop-branch-conflicts.ts` — branch conflict detection
- `stop-personal-repo-issues.ts` — repo issue management
- `stop-non-default-branch.ts` — branch cleanup
- `stop-memory-size.ts` — memory file size
- `stop-memory-update-reminder.ts` — memory update reminders
- `stop-offensive-language.ts` — language standards
- `stop-dependabot-prs.ts` — Dependabot PR management
- `stop-upstream-branch-count.ts` — branch count limits
- `stop-workflow-permissions.ts` — workflow permissions
- `stop-suppression-patterns.ts` — suppression pattern detection
- `stop-gdpr-data-models.ts` — GDPR compliance
- `stop-auto-continue.ts` — continuation trigger (uses `blockStopRaw`)

---

## Vocabulary Glossary

| Term | Definition | Context |
|------|-----------|---------|
| **Governance** | The set of enforcement rules that regulate agent meta-behavior — how it plans, tracks, and completes work. Governance hooks manage the task lifecycle and workflow compliance. | `pretooluse-task-governance.ts`, task count thresholds |
| **Hygiene** | The health state of the task queue, measured by counts of pending, in-progress, and completed tasks. "Good hygiene" = planning buffer exists. | `task-count-summary.ts`, tier 2 reinforcement |
| **Compliance** | Meeting specific thresholds or requirements set by enforcement hooks. Binary: compliant or non-compliant. | All tier 4 hooks |
| **Planning buffer** | The minimum count of pending tasks (≥2) required for healthy task hygiene. Ensures the agent always has planned next steps. | `task-count-summary.ts`, `pretooluse-task-governance.ts` |
| **Escalation** | The progression from ambient context (tier 1) through advisory (tier 3) to hard block (tier 4) as the agent's state degrades. | The 4-tier model |
| **Enforcement** | A hook that blocks tool calls or session stops when the agent violates a constraint. All tier 4 hooks are enforcement hooks. | All `pretooluse-*` denial paths, all `stop-*` block paths |
| **Remediation** | The specific action(s) the agent must take to satisfy an enforcement hook and unblock. Every tier 4 message must include remediation steps. | `formatActionPlan()` steps, inline commands |
| **Action plan** | A numbered list of remediation steps formatted by `formatActionPlan()`. Supports nested sub-steps and agent-specific tool name translation. | `src/action-plan.ts` |
| **Escape hatch** | The specific tool call or command that unblocks a tier 4 gate. Every hard block must document its escape hatch. | Tier 4 action plans |
| **Ratchet** | A quality constraint that can only be tightened, never loosened. Used for lint rules (errors/warnings can increase but not decrease). | `pretooluse-eslint-config-strength.ts` |

---

## Conformance Rules

### For new hooks

1. **Choose the correct tier.** Context injection → tier 1. Task health feedback → tier 2/3. Tool/stop blocking → tier 4.
2. **Use output helpers.** Never write raw `console.log(JSON.stringify(...))`. Use `emitContext()`, `preToolUseDeny()`, `blockStop()`, or their inline equivalents (`buildContextHookOutput`, `preToolUseDeny` from `SwizHook.ts`).
3. **Include remediation.** Every tier 4 message must include at least one concrete action the agent can take to unblock.
4. **Use `formatActionPlan()`** for multi-step remediations. Single-action remediations can use inline text.
5. **Do not negotiate.** Tier 4 messages are imperatives. The agent has no option to dismiss, defer, or negotiate.
6. **Cite evidence.** Include specific counts, thresholds, file paths, or error messages. Vague blocks ("something is wrong") are not actionable.

### For existing hooks

Hooks are being incrementally aligned to this methodology. Priority areas:
- Hooks with ad-hoc string concatenation for multi-step remediations should adopt `formatActionPlan()`.
- Governance hooks without `STOP.` prefix should evaluate whether they belong in the governance category.
- Enforcement-only hooks (all tier 4, no tier 2) should evaluate whether a corresponding reinforcement path is appropriate.

### Regression testing

Two test suites enforce tier 4 footer conformance:
- `hooks/pretooluse-action-required-footer.test.ts` — verifies `preToolUseDeny()` output includes the ACTION REQUIRED footer for every PreToolUse denial path.
- `hooks/stop-action-required-footer.test.ts` — verifies `blockStop()` output includes the ACTION REQUIRED footer for every Stop block path.

New tier 4 hooks must add a corresponding test case to the appropriate suite.

### Static analysis

The `pretooluse-action-required-footer.test.ts` and `stop-action-required-footer.test.ts` suites serve as the conformance gate. Every hook that calls `preToolUseDeny()` or `blockStop()` should have a corresponding test case verifying the footer is present in the output.

---

## Output Helper Reference

| Helper | Event | Blocking? | Footer? | Use case |
|--------|-------|-----------|---------|----------|
| `emitContext(event, ctx)` | SessionStart, UserPromptSubmit, PostToolUse | No | No | Tier 1 ambient context |
| `buildContextHookOutput(event, ctx)` | Same | No | No | Tier 1 (inline SwizHook) |
| `preToolUseAllow(reason)` | PreToolUse | No | No | Allow with advisory hint |
| `preToolUseAllowWithContext(reason, ctx)` | PreToolUse | No | No | Allow with additionalContext |
| `preToolUseDeny(reason)` | PreToolUse | Yes | Yes | Tier 4 PreToolUse block |
| `blockStop(reason)` | Stop | Yes | Yes | Tier 4 Stop block |
| `blockStopRaw(reason)` | Stop | Yes | No | Stop block without footer |
| `blockStopHumanRequired(reason)` | Stop | Yes | Custom | Stop block requiring human intervention |
| `denyPostToolUse(reason)` | PostToolUse | Yes | No | Feed errors back to agent |
| `formatActionPlan(steps, opts?)` | Any | N/A | N/A | Format numbered remediation steps |
