# Finish-by deadlines

Swiz exposes one persistent clock through the `Deadline` MCP tool and the optional
`deadline` field on `TaskCreate` and `TaskUpdate`. Use these when a user gives an
explicit finish-by time. Deadlines are advisory: they never deny a tool, shorten
its timeout, or mark work complete just because time has expired.

```js
Deadline({
  action: "set",
  sessionId: "<your actual hook session_id>",
  requestId: "release-deadline-1",
  label: "Reporting Hub release",
  dueAt: "2026-10-15T15:00:00+01:00",
  timeZone: "Europe/London",
  completionCriteria: "Fresh data, headlines and Lead drilldown live",
  reserveMinutes: 10
})
```

The result includes the generated deadline ID, revision, resolved UTC instant,
local date/time and timezone. Supply an absolute ISO timestamp with `Z` or a
numeric offset, or `durationMinutes`, never both. A timezone is a display choice;
the timestamp's explicit offset determines the instant, including during DST
transitions. Ambiguous times such as `4:55` or timestamps without offsets are
rejected. `durationMinutes` is resolved once when first accepted.

Use the same `requestId` **and arguments** when retrying an uncertain mutation.
Retries return the existing deadline's current state and cannot restart the
clock. Use a new key for each intentional change. Reusing a key with different
arguments is an error. Every revision is retained, including the original due
time and misses observed before a late extension or completion.

## Sessions and shared deliveries

`sessionId` must match the session's hook payload. Subagents must also supply their
actual hook `agentId`. Swiz does not infer a session from the working directory.
Directory aliases are canonicalised, but distinct worktrees and sessions stay
separate. An agent shares a deadline by explicitly attaching its ID:

```js
Deadline({ action: "attach", sessionId: "<my session>", requestId: "share-1", deadlineId: "<returned ID>" })
Deadline({ action: "list", sessionId: "<my session>" })
Deadline({ action: "get", sessionId: "<my session>", deadlineId: "<returned ID>" })
```

`get` includes the latest 50 revision snapshots and reasons. `list` shows up to 20
attached deadlines with a count of omitted entries. `detach` removes only this
session's reminders; it does not cancel the shared deadline.

Extensions require an explicit reason and the current `expectedRevision`. Two
writers cannot overwrite the same revision: the stale writer must reread the
deadline and reconcile the change. Tools do not authorise an extension on the
user's behalf; record an extension only when the user or agreed plan permits it.

```js
Deadline({
  action: "revise", sessionId: "<my session>", requestId: "extension-1",
  deadlineId: "<returned ID>", expectedRevision: 1,
  dueAt: "2026-10-15T15:05:00+01:00",
  reason: "User approved five additional minutes"
})
```

`complete` and `cancel` also require a new request key, current revision and
reason. A completion reason should cite delivery evidence. Closed deadlines
cannot be reopened or revised; their history remains available.

## Task deadlines

```js
TaskCreate({
  subject: "Hand off headline changes",
  description: "Provide the complete integration-ready patch.",
  deadline: {
    sessionId: "<my session>", requestId: "headline-handoff-1",
    dueAt: "2026-10-15T14:40:00+01:00",
    timeZone: "Europe/London",
    parentDeadlineId: "<delivery deadline ID>"
  }
})
```

Naming a parent attaches that delivery deadline to this session too. A task's
deadline is independent of its parent's: revising one does not shift the other.
The task stores a stable deadline reference; changing its status or description
does not reset the clock. Completing or cancelling a task through the Swiz task
tools closes only its own deadline, never its parent delivery goal. Native task
completion also suppresses its hook reminder; use `Deadline complete` to close
the ledger when a task was completed outside Swiz.

`TaskUpdate({ taskId, deadline: { ... } })` sets or revises the deadline. Revisions
need `expectedRevision` and `reason`. Make deadline changes separately from
status, description or dependency changes, so a revision conflict cannot leave a
partially applied task update. `TaskList` includes a bounded deadline summary.
Use the `Deadline` tool with the task's deadline ID for full history or explicit
cancellation. Task creation retries with the same deadline request recover the
original task.

## Hook context

Before tools, after tools, and after tool failures, dispatch reads the current
clock. It emits context even when no other hook matches, MCP advisory hooks are
ignored, subagent governance is relaxed, or a skill suppresses ordinary advice.
It appends the clock after humanisation and preserves it through repeated-message
suppression. Existing permissions and denials remain intact.

Each response includes at most the earliest active delivery deadline and earliest
open task deadline attached to this session, with the sample time, due time,
remaining or overdue duration, revision and delivery reserve. The fixed phases
are: active; due within 15 minutes; inside the configured reserve (default five
minutes); final minute; overdue. Reserve and final-minute phases take precedence
over the 15-minute phase. Guidance narrows optional scope without skipping required
checks. It makes no prediction that the work is on track.

For recognised wait/sleep tools, an explicit wait allowance that exceeds the
remaining time produces an advisory. Arguments are not rewritten. Clocks refresh
only at hook boundaries: a tool or reasoning step can cross the deadline without
an interruption, and the next hook reports the overrun. There is no background
alarm or automatic agent wakeup.

State lives in `~/.swiz/deadlines.db`, separate from settings and task elapsed-time
fields. SQLite transactions atomically persist retry receipts and revisions
across daemon and local fallback processes. No file is created until a deadline
is set. Restarting, compaction, and task pauses do not move an absolute deadline.
If the store cannot be read, hooks fail open and report that remaining time is
unavailable. Tool mutations report storage errors instead of pretending to succeed.

After upgrading Swiz, restart the daemon and reconnect long-lived MCP clients so
they advertise the new tool and task fields. Existing pre/post dispatch entries
provide the clock; no additional manifest hook is required.
