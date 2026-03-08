#!/usr/bin/env bun

// PreToolUse hook: Block git commands when .git/index.lock exists.
// Prevents wasting agent turns on git operations that will fail because
// another git process is running or a stale lock was left behind.

import { GIT_DIR_NAME, GIT_INDEX_LOCK, joinGitPath } from "../src/git-helpers.ts"
import {
  denyPreToolUse,
  formatActionPlan,
  GIT_ANY_CMD_RE,
  git,
  isShellTool,
  type ToolHookInput,
} from "./hook-utils.ts"

const input: ToolHookInput = await Bun.stdin.json()

// Only applies to shell tools running git commands.
if (!isShellTool(input.tool_name ?? "")) process.exit(0)

const command: string = (input.tool_input?.command as string) ?? ""
if (!GIT_ANY_CMD_RE.test(command)) process.exit(0)

const cwd = input.cwd || process.cwd()
const LOCK_RELATIVE_PATH = `${GIT_DIR_NAME}/${GIT_INDEX_LOCK}`

// Find the repo root — handles subdirectories and worktrees.
const repoRoot = await git(["rev-parse", "--show-toplevel"], cwd)
if (!repoRoot) process.exit(0) // Not in a git repo; let git itself report the error.

const lockPath = joinGitPath(repoRoot, GIT_INDEX_LOCK)
if (!(await Bun.file(lockPath).exists())) process.exit(0)

denyPreToolUse(
  [
    `\`${LOCK_RELATIVE_PATH}\` exists — another git process may be running, or a previous one crashed.`,
    "",
    "This lock will cause your git command to fail with:",
    `  "fatal: Unable to create '.../${LOCK_RELATIVE_PATH}': File exists."`,
    "",
    formatActionPlan(
      [
        "Check if another git process is still running: `ps aux | grep git`",
        `If no git process is active, remove the stale lock: \`trash ${lockPath}\``,
        "Retry your git command after the lock is cleared.",
      ],
      { header: "To resolve:" }
    ).trimEnd(),
  ].join("\n")
)
