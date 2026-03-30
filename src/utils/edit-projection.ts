/**
 * Edit projection utilities for PreToolUse hooks.
 *
 * Extracted from hook-utils.ts to break circular dependencies when inline
 * SwizHook files (imported by manifest.ts) need these functions. All deps
 * resolve to tool-matchers.ts and git-utils.ts — no path back to manifest.ts.
 */

import { isEditTool, isNotebookTool, isWriteTool } from "../tool-matchers.ts"
import { SOURCE_EXT_RE } from "./git-utils.ts"

// ─── Projected content ──────────────────────────────────────────────────────

export interface ProjectedContentInput {
  old_string?: string
  new_string?: string
  content?: string
}

/**
 * Compute what a file's content will be after a tool applies its edit.
 * Used by PreToolUse hooks to validate file content before the write happens.
 *
 * Returns null if the projected content cannot be determined (e.g. file unreadable
 * on an Edit where both old/new are empty).
 */
async function computeEditToolContent(
  filePath: string,
  oldString: string,
  newString: string
): Promise<string | null> {
  if (!oldString && !newString) return null
  try {
    const currentContent = await Bun.file(filePath).text()
    return currentContent.replace(oldString, () => newString)
  } catch {
    return null
  }
}

export async function computeProjectedContent(
  toolName: string,
  filePath: string,
  toolInput: ProjectedContentInput
): Promise<string | null> {
  if (isNotebookTool(toolName)) {
    return (toolInput.content ?? "") || null
  }

  if (isEditTool(toolName)) {
    const oldString = toolInput.old_string ?? ""
    const newString = toolInput.new_string ?? ""
    return computeEditToolContent(filePath, oldString, newString)
  }

  // Write tool — content is the full file
  return (toolInput.content ?? "") || null
}

// ─── File path helpers ──────────────────────────────────────────────────────

/**
 * Returns true if the hook input represents an Edit/Write targeting a file
 * whose path ends with the given suffix (e.g. "CLAUDE.md", "settings.json").
 */
export function isFileEditForPath(
  input: { tool_name?: string; tool_input?: { file_path?: string } },
  pathSuffix: string
): boolean {
  const filePath = input.tool_input?.file_path ?? ""
  const toolName = input.tool_name ?? ""
  return filePath.endsWith(pathSuffix) && (isEditTool(toolName) || isWriteTool(toolName))
}

// ─── Edit delta resolution ──────────────────────────────────────────────────

export interface EditDelta {
  oldString: string
  newString: string
}

/**
 * Returns true if the file path has no recognised source extension or matches
 * any of the provided exclusion patterns.
 */
export function isExcludedSourcePath(filePath: string, ...extras: RegExp[]): boolean {
  if (!SOURCE_EXT_RE.test(filePath)) return true
  return extras.some((re) => re.test(filePath))
}

/**
 * Extract old/new strings from a file-edit hook input, returning null if the
 * file path matches any exclusion pattern. Common extraction shared across
 * hooks that inspect edit content (debug statements, TODO tracker, etc.).
 */
export function resolveEditDelta(
  input: {
    tool_input?: { file_path?: string; old_string?: string; new_string?: string; content?: string }
  },
  ...excludePatterns: RegExp[]
): EditDelta | null {
  const filePath = input.tool_input?.file_path ?? ""
  if (isExcludedSourcePath(filePath, ...excludePatterns)) return null
  return {
    oldString: input.tool_input?.old_string ?? "",
    newString: input.tool_input?.new_string ?? input.tool_input?.content ?? "",
  }
}
