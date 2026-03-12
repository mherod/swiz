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

async function computeProjectedContent(
  toolName: string,
  filePath: string,
  toolInput: Record<string, unknown>
): Promise<string | null> {
  if (toolName === "Write" || toolName === "NotebookEdit") {
    return ((toolInput.content as string) ?? "") || null
  }
  if (toolName === "Edit") {
    const oldString = (toolInput.old_string as string) ?? ""
    const newString = (toolInput.new_string as string) ?? ""
    if (!oldString && !newString) return null

    let currentContent: string
    try {
      currentContent = await Bun.file(filePath).text()
    } catch {
      return null
    }
    return currentContent.replace(oldString, newString)
  }
  return null
}

async function main() {
  const input = await Bun.stdin.json().catch(() => null)
  if (!input) process.exit(0)

  const toolName: string = input.tool_name ?? ""
  const filePath: string = input.tool_input?.file_path ?? input.tool_input?.path ?? ""
  const toolInput: Record<string, unknown> = input.tool_input ?? {}

  if (!filePath || !/\.(ts|tsx|js|jsx|mjs)$/.test(filePath)) {
    process.exit(0)
  }

  const projectedContent = await computeProjectedContent(toolName, filePath, toolInput)
  if (!projectedContent) process.exit(0)

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
