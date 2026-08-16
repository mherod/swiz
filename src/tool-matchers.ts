// ─── Cross-agent tool name matchers ──────────────────────────────────────────
//
// Maps tool names across agents (Claude Code, Cursor, Codex, Gemini) to
// canonical categories. Extracted from hooks/hook-utils.ts (issue #85
// decoupling) so src/ modules can import without reaching into hooks/.
//
// Agent tool-name equivalences:
//   Claude Code  | Cursor       | Codex              | Gemini
//   Bash         | Shell        | run_shell_command  | run_shell_command
//   Edit         | StrReplace   | apply_patch / functions.apply_patch | replace
//   Write        | Write        | apply_patch / functions.apply_patch | write_file
//   Read         | Read         | read_file          | read_file
//   Grep         | Grep         | grep_search        | grep_search
//   Glob         | Glob         | glob               | glob
//   NotebookEdit | EditNotebook | apply_patch / functions.apply_patch | —
//   Task/planning| TodoWrite    | update_plan        | write_todos

export const SHELL_TOOLS = new Set([
  "Bash",
  "Shell",
  "run_shell_command",
  "shell",
  "shell_command",
  "exec_command",
  "functions.exec_command",
])
export const EDIT_TOOLS = new Set([
  "Edit",
  "MultiEdit",
  "StrReplace",
  "replace",
  "apply_patch",
  "functions.apply_patch",
])
export const WRITE_TOOLS = new Set(["Write", "write_file", "apply_patch", "functions.apply_patch"])
export const READ_TOOLS = new Set(["Read", "read_file", "read_many_files", "view_file"])
export const NOTEBOOK_TOOLS = new Set([
  "NotebookEdit",
  "EditNotebook",
  "apply_patch",
  "functions.apply_patch",
])
// Codex has a planning surface via `update_plan`, which is now treated as a task
// surface in agent capability modeling.
export const TASK_TOOLS = new Set([
  "Task",
  "TaskCreate",
  "TaskUpdate",
  "TaskList",
  "TaskGet",
  "TodoWrite",
  "write_todos",
  "update_plan",
  "functions.update_plan",
])
export const TASK_CREATE_TOOLS = new Set(["TaskCreate", "TodoWrite", "write_todos"])
export const TASK_UPDATE_TOOLS = new Set(["TaskUpdate"])
export const TASK_LIST_TOOLS = new Set(["TaskList"])
export const TASK_GET_TOOLS = new Set(["TaskGet"])
export const SEARCH_TOOLS = new Set([
  "Grep",
  "Glob",
  "grep_search",
  "glob",
  "grep_files",
  "list_dir",
])
export const SKILL_TOOLS = new Set(["Skill"])

export function isShellTool(name: string): boolean {
  return SHELL_TOOLS.has(name)
}
export function isEditTool(name: string): boolean {
  return EDIT_TOOLS.has(name)
}
export function isWriteTool(name: string): boolean {
  return WRITE_TOOLS.has(name)
}
export function isNotebookTool(name: string): boolean {
  return NOTEBOOK_TOOLS.has(name)
}
export function isTaskTool(name: string): boolean {
  return TASK_TOOLS.has(name)
}
export function isTaskCreateTool(name: string): boolean {
  return TASK_CREATE_TOOLS.has(name)
}
export function isTaskUpdateTool(name: string): boolean {
  return TASK_UPDATE_TOOLS.has(name)
}
export function isTaskListTool(name: string): boolean {
  return TASK_LIST_TOOLS.has(name)
}
export function isTaskGetTool(name: string): boolean {
  return TASK_GET_TOOLS.has(name)
}
export function isSkillTool(name: string): boolean {
  return SKILL_TOOLS.has(name)
}
export function isFileEditTool(name: string): boolean {
  return EDIT_TOOLS.has(name) || WRITE_TOOLS.has(name)
}
export function isCodeChangeTool(name: string): boolean {
  return EDIT_TOOLS.has(name) || WRITE_TOOLS.has(name) || NOTEBOOK_TOOLS.has(name)
}

const APPLY_PATCH_FILE_PREFIXES = [
  "*** Update File: ",
  "*** Delete File: ",
  "*** Add File: ",
  "*** Move to: ",
]

export type ToolMatcherValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | ToolMatcherValue[]
  | { [key: string]: ToolMatcherValue }

export type ToolMatcherRecord = { [key: string]: ToolMatcherValue }

function isRecord(value: ToolMatcherValue | object): value is ToolMatcherRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function addPath(paths: Set<string>, value: ToolMatcherValue | undefined): void {
  if (typeof value !== "string") return
  const trimmed = value.trim()
  if (trimmed) paths.add(trimmed)
}

function basenameForPath(filePath: string): string {
  const normalized = filePath.trim().replace(/\\/g, "/").replace(/\/+$/, "")
  return normalized.split("/").pop() ?? ""
}

export function isSkillMdPath(filePath: string): boolean {
  return basenameForPath(filePath) === "SKILL.md"
}

export function isMarkdownPath(filePath: string): boolean {
  return basenameForPath(filePath).toLowerCase().endsWith(".md")
}

export function extractApplyPatchFilePaths(command: string): string[] {
  const paths = new Set<string>()
  for (const line of command.split("\n")) {
    const prefix = APPLY_PATCH_FILE_PREFIXES.find((candidate) => line.startsWith(candidate))
    if (!prefix) continue
    addPath(paths, line.slice(prefix.length))
  }
  return [...paths]
}

function addPatchPaths(paths: Set<string>, patch: ToolMatcherValue | undefined): void {
  if (typeof patch !== "string") return
  for (const line of patch.split("\n")) {
    const match = line.match(/^\+\+\+\s+b\/(.+)$/)
    if (match?.[1]) addPath(paths, match[1])
  }
}

function addNestedPathRecords(paths: Set<string>, items: ToolMatcherValue | undefined): void {
  if (!Array.isArray(items)) return
  for (const item of items) {
    if (typeof item === "string") {
      addPath(paths, item)
    } else if (isRecord(item)) {
      addPath(paths, item.file_path)
      addPath(paths, item.filePath)
      addPath(paths, item.path)
    }
  }
}

const COMMON_PATH_KEYS = [
  "file_path",
  "filePath",
  "target_file",
  "TargetFile",
  "path",
  "file",
  "AbsolutePath",
  "notebook_path",
  "notebookPath",
] as const

const COMMON_NESTED_PATH_KEYS = ["files", "paths", "file_paths", "filePaths"] as const

export function extractFileEditTargetPaths(toolInput: ToolMatcherValue | object): string[] {
  if (!isRecord(toolInput)) return []

  const paths = new Set<string>()
  for (const key of COMMON_PATH_KEYS) {
    addPath(paths, toolInput[key])
  }

  addNestedPathRecords(paths, toolInput.edits)
  addNestedPathRecords(paths, toolInput.changes)
  for (const key of COMMON_NESTED_PATH_KEYS) {
    addNestedPathRecords(paths, toolInput[key])
  }

  if (typeof toolInput.command === "string") {
    for (const filePath of extractApplyPatchFilePaths(toolInput.command)) {
      paths.add(filePath)
    }
  }

  addPatchPaths(paths, toolInput.patch)
  return [...paths]
}

export function extractFileReadTargetPaths(toolInput: ToolMatcherValue | object): string[] {
  if (!isRecord(toolInput)) return []

  const paths = new Set<string>()
  for (const key of COMMON_PATH_KEYS) {
    addPath(paths, toolInput[key])
  }

  for (const key of COMMON_NESTED_PATH_KEYS) {
    addNestedPathRecords(paths, toolInput[key])
  }
  return [...paths]
}

export function isSkillMdOnlyFileEditPayload(
  toolName: string | undefined,
  payload: ToolMatcherRecord
): boolean {
  if (!toolName || !isFileEditTool(toolName)) return false
  const toolInput = payload.tool_input ?? payload.toolInput
  const targets = extractFileEditTargetPaths(toolInput)
  return targets.length > 0 && targets.every(isSkillMdPath)
}

export function isMarkdownOnlyFileReadPayload(
  toolName: string | undefined,
  payload: ToolMatcherRecord
): boolean {
  if (!toolName || !READ_TOOLS.has(toolName)) return false
  const toolInput = payload.tool_input ?? payload.toolInput
  const targets = extractFileReadTargetPaths(toolInput)
  return targets.length > 0 && targets.every(isMarkdownPath)
}
