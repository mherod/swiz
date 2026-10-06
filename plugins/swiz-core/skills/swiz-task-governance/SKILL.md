---
name: swiz-task-governance
description: Plan real work with available task tools and recover from Swiz task-governance blocks in Claude Code or Codex.
---

Follow explicit user instructions and the repository's applicable guidance.

## Choose available tools

Use the current host's native task tools when available. Otherwise use the
Swiz MCP tools: TaskCreate, TaskUpdate and TaskList (their displayed
names may have a plugin/server prefix). Discover the actual callable names;
do not invent Claude-only tools in Codex. The `swiz tasks` CLI is for
diagnostics and explicit CLI requests, not a substitute for available task tools.

If neither task surface is available, keep an honest numbered checklist and
report the missing integration rather than claiming tasks were created.

## Plan and track work

1. List current tasks before starting or resuming work.
2. Create a task for each real remaining outcome, with one imperative action
   in its subject. Keep task creation in the parent session.
3. Mark the current task in progress before implementation.
4. Update status and evidence as work progresses. Follow the actual task
   requirements reported by the active Swiz configuration.
5. Complete a task only when its requirements are met. Include concrete
   evidence prefixed by `file:`, `test:`, `commit:`, `pr:`, or `note:`.
   Never invent a commit, successful test, or deployment.
6. Cancel obsolete work with the supported cancelled status; do not delete
   unfinished tasks to satisfy a gate.

Use the actual runtime session identifier for session-specific actions.
A newest-transcript lookup is not proof of the current session.

## Recover from a block

Read the requested action, refresh tasks, and perform the missing real step:
claim existing work, describe remaining work, or attach completion evidence.
Do not create phantom tasks merely to keep a buffer populated. Do not spawn
another agent to evade a task gate.

If a skill gate applies, use that skill when available. Plugin installation
does not supply every repository-specific skill or change user authorization.
