#!/usr/bin/env bun
// PreToolUse hook: Block `cp` and recommend `ditto` for copy operations.

import { denyPreToolUse, isShellTool } from "./hook-utils.ts"
import { shellSegmentCommandRe } from "./utils/shell-patterns.ts"

const input = await Bun.stdin.json().catch(() => null)
if (!input) process.exit(0)
if (!isShellTool(input.tool_name ?? "")) process.exit(0)

const command: string = input.tool_input?.command ?? ""

// Match standalone cp invocations at command boundaries.
if (!shellSegmentCommandRe("cp(?:\\s|$)").test(command)) process.exit(0)

denyPreToolUse(
  [
    "Do not use `cp` for file copying in this workflow.",
    "",
    "Use `ditto` instead (preserves metadata and handles directories cleanly):",
    "  ditto <source> <destination>",
    "  ditto -V <source> <destination>   # verbose copy",
  ].join("\n")
)
