# Changelog

## 2026-03-02

### Bug Fixes

- Fixed `createSessionTask` in `hook-utils.ts` writing its sentinel file
  even when the underlying `tasks-list.ts` subprocess failed. A non-zero
  exit no longer leaves an orphaned sentinel, so a failed task-creation
  attempt is retried on the next stop rather than silently skipped. (#15)
- Fixed `stop-auto-continue` path encoding so project directories with
  dots in their names (e.g. `/Users/jane.doe/project`) are found
  correctly. The encoding now replaces both `/` and `.` with `-`,
  matching Claude Code's own project-directory scheme. (#16)
- Fixed `swiz dispatch` routing `subagentStart` and `subagentStop` events
  through `runBlocking` instead of `runContext`. Context output emitted by
  hooks on those events is now forwarded to the agent instead of being
  discarded. (#17)
- Fixed a potential deadlock in `agent.ts` where large stderr output could
  fill the OS pipe buffer and stall the subprocess before it exited. Both
  stdout and stderr are now drained concurrently via `Promise.all`. (#18)

## 2026-03-01

### New Features

- Added a hook that blocks `git push` unless the required branch and
  open-PR checks have already been run in the current session. Before
  any push, `git branch --show-current` and
  `gh pr list --state open --head <branch>` must have been executed.
  This prevents accidentally pushing large work directly to a shared
  branch or creating duplicate pull requests, by enforcing the
  verification steps as a mandatory gate rather than an optional
  reminder. (#13)

## 2026-02-28

### New Features

- Added a hook that blocks `@ts-ignore` comments in TypeScript files.
  The TypeScript compiler's type errors must be fixed rather than
  silenced. If suppression is genuinely unavoidable (e.g. broken
  third-party types), `@ts-expect-error` is permitted as a last resort
  — but only when accompanied by a description explaining why. Bare
  `@ts-expect-error` with no reason is also rejected.

## 2026-02-27

### Bug Fixes

- Fixed ESLint config-strength hook to recognise the modern flat config
  format (`eslint.config.js`). Projects using ESLint 9's flat config now
  have their rule-strength correctly enforced.
- Fixed Ruby debug-statement detection producing false positives on
  identifiers that contain "byebug" as a substring (e.g. helper method
  names). Only bare `byebug` and `binding.pry` calls are now flagged.

### Improvements

- Auto-continue suggestions now reference whichever skills are actually
  installed (e.g. `/changelog`, `/update-memory`) rather than showing
  generic advice, making autonomous next-step hints more actionable.
- Auto-continue analysis now incorporates changelog staleness awareness,
  prompting agents to update `CHANGELOG.md` when it has fallen behind.
- Session learnings are now written to persistent memory as part of the
  auto-continue workflow, so useful patterns are retained across sessions.
