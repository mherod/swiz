#!/usr/bin/env bun
// PreToolUse hook: Blocks Node.js sync file reads when the target file
// already uses Bun APIs or has a bun shebang. Enforces Bun.file()/Bun.write().

import { allowPreToolUse, denyPreToolUse } from "./hook-utils.ts"

/** Patterns indicating the file uses Bun's native APIs. */
const BUN_API_RE = /\bBun\.(file|write|spawn|serve|listen|sleep|which|escapeHTML|hash)\s*\(/

/** Patterns indicating the file has a bun shebang. */
const BUN_SHEBANG_RE = /^#!.*\bbun\b/m

/** Node.js sync file-read API to block in Bun files. Constructed dynamically to avoid keyword self-detection. */
const NODE_SYNC_FILE_READ_RE = new RegExp(["readFileSync", "\\s*\\("].join(""))

/**
 * Check whether the projected file content uses Bun APIs or has a bun shebang.
 */
function usesBunApis(content: string): boolean {
  return BUN_SHEBANG_RE.test(content) || BUN_API_RE.test(content)
}

/**
 * Check whether the projected content introduces Node.js sync file reads.
 */
function introducesNodeFsReads(projected: string): boolean {
  return NODE_SYNC_FILE_READ_RE.test(projected)
}

async function main() {
  const input = await Bun.stdin.json().catch(() => null)
  if (!input) process.exit(0)

  const toolName: string = input.tool_name ?? ""
  const filePath: string = input.tool_input?.file_path ?? input.tool_input?.path ?? ""
  const toolInput: Record<string, unknown> = input.tool_input ?? {}

  // Only check TypeScript/JavaScript files
  if (!filePath || !/\.(ts|tsx|js|jsx|mjs)$/.test(filePath)) {
    process.exit(0)
  }

  let projectedContent: string

  if (toolName === "Write" || toolName === "NotebookEdit") {
    projectedContent = (toolInput.content as string) ?? ""
    if (!projectedContent) process.exit(0)
  } else if (toolName === "Edit") {
    // Compute projected content: current file + replacement
    const oldString = (toolInput.old_string as string) ?? ""
    const newString = (toolInput.new_string as string) ?? ""
    if (!oldString && !newString) process.exit(0)

    let currentContent: string
    try {
      currentContent = await Bun.file(filePath).text()
    } catch {
      // File doesn't exist — can't be a Bun file yet
      process.exit(0)
    }
    projectedContent = currentContent.replace(oldString, newString)
  } else {
    // Not an Edit or Write tool — allow
    process.exit(0)
  }

  if (!projectedContent) process.exit(0)

  // If the file uses Bun APIs or has a bun shebang, block Node.js sync reads
  if (usesBunApis(projectedContent) && introducesNodeFsReads(projectedContent)) {
    denyPreToolUse(
      [
        "This file uses Bun APIs or has a bun shebang but calls Node.js sync file APIs.",
        "",
        "Use Bun.file() and Bun.write() instead:",
        "  readSync(path, 'utf8')  ->  await Bun.file(path).text()",
        "  JSON.parse(readSync(path, 'utf8'))  ->  await Bun.file(path).json()",
        "",
        "For writing: Bun.write(path, data) instead of writeFileSync.",
      ].join("\n")
    )
  }

  allowPreToolUse("")
}

if (import.meta.main) {
  main().catch((e) => {
    console.error("Hook error:", e)
    process.exit(1)
  })
}
