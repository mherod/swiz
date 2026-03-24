// Shared utilities for bun enforcement PreToolUse hooks.

/** Patterns indicating the file uses Bun's native APIs. */
const BUN_API_RE = /\bBun\.(file|write|spawn|serve|listen|sleep|which|escapeHTML|hash)\s*\(/

/** Patterns indicating the file has a bun shebang. */
const BUN_SHEBANG_RE = /^#!.*\bbun\b/m

/** Check whether file content uses Bun APIs or has a bun shebang. */
export function usesBunApis(content: string): boolean {
  return BUN_SHEBANG_RE.test(content) || BUN_API_RE.test(content)
}

/** Parse tool input and extract file path. Returns null if not a TS/JS file. */
export function parseBunEnforcementInput(input: Record<string, unknown>): {
  toolName: string
  filePath: string
  toolInput: Record<string, unknown>
} | null {
  const toolName: string = (input.tool_name as string) ?? ""
  const ti = (input.tool_input ?? {}) as Record<string, unknown>
  const filePath: string = (ti.file_path as string) ?? (ti.path as string) ?? ""
  if (!filePath || !/\.(ts|tsx|js|jsx|mjs)$/.test(filePath)) return null
  return { toolName, filePath, toolInput: ti }
}
