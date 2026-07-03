// ─── Cross-agent tool name matchers ──────────────────────────────────────────
//
// Maps tool names across agents (Claude Code, Cursor, Codex, Gemini) to
// canonical categories. Extracted from hooks/hook-utils.ts (issue #85
// decoupling) so src/ modules can import without reaching into hooks/.
//
// Agent tool-name equivalences:
//   Claude Code  | Cursor       | Codex              | Gemini
//   Bash         | Shell        | run_shell_command  | run_shell_command
//   Edit         | StrReplace   | replace            | replace
//   Write        | Write        | write_file         | write_file
//   Read         | Read         | read_file          | read_file
//   Grep         | Grep         | grep_search        | grep_search
//   Glob         | Glob         | glob               | glob
//   NotebookEdit | EditNotebook | —                  | —
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
  "StrReplace",
  "replace",
  "apply_patch",
  "functions.apply_patch",
])
export const WRITE_TOOLS = new Set(["Write", "write_file", "apply_patch", "functions.apply_patch"])
export const READ_TOOLS = new Set(["Read", "read_file", "read_many_files"])
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

type ToolMatcherValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | ToolMatcherValue[]
  | { [key: string]: ToolMatcherValue }

type ToolMatcherRecord = { [key: string]: ToolMatcherValue }

function isRecord(value: ToolMatcherValue): value is ToolMatcherRecord {
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

export function extractApplyPatchFilePaths(command: string): string[] {
  const paths = new Set<string>()
  for (const line of command.split("\n")) {
    const prefix = APPLY_PATCH_FILE_PREFIXES.find((candidate) => line.startsWith(candidate))
    if (!prefix) continue
    addPath(paths, line.slice(prefix.length))
  }
  return [...paths]
}

export function extractFileEditTargetPaths(toolInput: ToolMatcherValue | undefined): string[] {
  if (!isRecord(toolInput)) return []

  const paths = new Set<string>()
  addPath(paths, toolInput.file_path)
  addPath(paths, toolInput.filePath)
  addPath(paths, toolInput.notebook_path)
  addPath(paths, toolInput.notebookPath)

  if (typeof toolInput.command === "string") {
    for (const filePath of extractApplyPatchFilePaths(toolInput.command)) {
      paths.add(filePath)
    }
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
