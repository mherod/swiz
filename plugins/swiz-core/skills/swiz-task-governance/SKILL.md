---
description: Understand and comply with swiz task governance enforcement
allowed-tools: TaskCreate, TaskUpdate, TaskList, TaskGet, Bash, Read, Edit, Write
argument-hint: "[optional: reason you were blocked]"
---

> **Note on task tools**: This skill uses canonical task tool names (`TaskCreate`, `TaskUpdate`, `TaskList`, `TaskGet`). If your environment uses different names, consult the Tool Equivalence table in CLAUDE.md. If no task tool is available, maintain an internal numbered checklist and skip task status calls.

## Purpose

Invoke this skill when:
- A PreToolUse hook blocked your Bash/Edit/Write with a task governance violation
- You need to recover from a "no in_progress task" block
- Your task buffer dropped below the required minimum
- You are starting a new session and need to orient your task state

## Current Task State

!`swiz tasks list 2>/dev/null || echo "swiz tasks unavailable"`

## The State Machine

Tasks follow a strict one-way state machine:

```
pending → in_progress → completed
```

- **NEVER** skip `in_progress`. `pending → completed` is blocked by the `pretooluse-task-transition-validator` hook.
- **NEVER** complete a task you just created without doing substantive work (no phantom completion).
- Use `deleted` only to remove tasks that are genuinely obsolete — never to clean up governance violations.

## Buffer Requirements (enforced by `pretooluse-require-tasks`)

The hook blocks **Bash, Edit, Write, and Skill** tool calls unless:

1. **≥ 1 task is `in_progress`**
2. **≥ 2 tasks are incomplete** (pending + in_progress combined)

Maintain the buffer proactively — do not wait for a block to appear:
- When pending count drops below 2: immediately call `TaskCreate` for the next logical unit of work.
- Before every Bash/Edit/Write: confirm an `in_progress` task covers the action you are about to take.

## Before Every Tool Call

### Startup sequence (session start or post-compaction)

```
1. TaskList                          — read current state
2. TaskUpdate pending→in_progress    — claim a task that covers your next action
3. Proceed with Bash/Edit/Write
```

### Mid-session sequence

```
1. Check: is there an in_progress task? (last TaskList < 5 min ago)
2. If no in_progress: TaskUpdate a pending task → in_progress
3. If no pending tasks exist: TaskCreate at least 2 pending tasks first
4. Proceed
```

### Staleness gate

If your last `TaskList` call was **more than 5 minutes ago**, run `TaskList` again before any Bash/Edit/Write to refresh canonical state. The hook enforces this.

## Creating Good Tasks

**Subject rules** (enforced by `pretooluse-task-subject-validation`):
- One verb, imperative form: "Fix auth bug" ✓ — "Fix auth bug and update tests" ✗
- No compound subjects. If you need to do two things, make two tasks.
- Under ~60 characters.

**Description**: Describe the outcome and approach, not a transcript of your plan.

**activeForm**: Present continuous shown in the spinner — e.g., `"Fixing auth bug"`.

```
TaskCreate
  subject:    "Fix authentication token expiry"
  description: "Token validation doesn't handle clock skew..."
  activeForm: "Fixing auth token expiry"
```

## Completing Tasks

### Evidence is required

Every `TaskUpdate status:completed` **must** include evidence in the `description` field.
Use these prefixes:

| Prefix | Example |
|--------|---------|
| `commit:<sha>` | `commit:abc1234` |
| `file:<path>` | `file:src/skill-utils.ts` |
| `test:<result>` | `test:74 passed` |
| `pr:<url>` | `pr:https://github.com/...` |
| `note:<text>` | `note:no code change needed, config updated` |

Combine as needed: `commit:abc1234 test:74 passed`

### Rate limit

The `pretooluse-task-completion-rate-limit` hook allows a maximum of **2 completions per 5 seconds**.
If you need to close several tasks, pause briefly between the second and third completion.

### Phantom completion guard

`pretooluse-no-phantom-task-completion` blocks completing a task that has no substantive tool calls (Edit/Write/Bash/Read) since it was set `in_progress`. You must do real work before completing.

### Last-task-standing

You cannot complete the last remaining `in_progress` task if no `pending` tasks exist to replace it.
Before completing your final task: `TaskCreate` at least one new pending task (or confirm the session is genuinely wrapping up).

## Exempt Commands (no task requirement)

These Bash commands are exempt from the `pretooluse-require-tasks` gate — you can run them without an `in_progress` task:

- Read-only git: `git log`, `git status`, `git diff`, `git show`, `git branch`, `git remote`, `git rev-parse`
- Network git: `git push`, `git pull`, `git fetch`
- All `gh` commands
- `ls`, `rg`, `grep`
- `swiz issue close`, `swiz issue comment`
- `curl`, `wget`

Non-exempt examples (always need `in_progress`): `git commit`, any file edit, `bun test`, `bun run`, `pnpm ...`

## Skill Gates Layered On Top

### `/commit` before `git commit`

The `pretooluse-skill-invocation-gate` requires `/commit` to have been invoked in the current session before any `git commit` shell command runs. After invoking `/commit`, a recent `TaskList` is also required before the actual commit.

### `/push` before `git push`

Similarly, `/push` must be invoked before `git push`.

### Other gated commands

| Command | Required skill |
|---------|---------------|
| `gh pr create` | `/pr-open` |
| `gh issue edit` (label changes) | `/refine-issue` |
| `gh issue edit` (adding `triaged`) | `/triage-issues` |
| Dismiss PR review | `/pr-comments-address` |

## Stop Gate

The `stop-incomplete-tasks` hook **blocks session stop** if any tasks are `pending` or `in_progress`.

Before stopping:
1. Complete all `in_progress` tasks with evidence.
2. Complete or delete all `pending` tasks (or ensure they are genuine carry-forward items handled by `/end-of-day`).
3. The stop hook also requires `/end-of-day` if there are unpushed commits.

## Recovery When Blocked

### "No in_progress task" block

```
1. TaskList                           — see what exists
2. TaskUpdate <id> status:in_progress — pick a relevant pending task
3. Retry your tool call
```

### "Buffer too low" block (< 2 incomplete tasks)

```
1. TaskCreate <next logical task>     — add pending work
2. TaskCreate <follow-on task>        — add a second if needed
3. TaskUpdate <one of them> in_progress
4. Retry your tool call
```

### "Stale task state" block

```
1. TaskList                           — refresh canonical state
2. Verify in_progress task exists
3. Retry your tool call
```

### "Phantom completion" block

You tried to complete a task without any tool calls since setting it `in_progress`. Do the actual work first, then complete with evidence.

### "Compound subject" block

Your task subject contains "and", "then", or multiple verbs. Use `TaskUpdate` to rewrite the subject as a single imperative phrase.

## Native Task File Lifecycle

Tasks are stored as JSON files in `~/.claude/tasks/<session_id>/`. Completed tasks have their JSON files **deleted** — `readSessionTasksFresh` returns `[]` for a fully clean session. Do not treat an empty task list as "no tasks were ever created"; it may mean all tasks completed cleanly.

## Quick Reference

```
Session start:   TaskList → TaskUpdate pending→in_progress → work
Mid-session:     keep ≥2 incomplete, ≥1 in_progress at all times
Before commit:   /commit skill → TaskList → git commit
Completing:      TaskUpdate status:completed description:"commit:<sha>"
Stopping:        all tasks complete + /end-of-day if unpushed commits
```
