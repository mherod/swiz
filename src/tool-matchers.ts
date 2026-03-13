// ─── Cross-agent tool name matchers ──────────────────────────────────────────
//
// Maps tool names across agents (Claude Code, Cursor, Codex, Gemini) to
// canonical categories. Extracted from hooks/hook-utils.ts (issue #85
// decoupling) so src/ modules can import without reaching into hooks/.
//
// Agent tool-name equivalences:
//   Claude Code  | Cursor       | Codex              | Gemini
//   Bash         | Shell        | run_shell_command  | shell / shell_command / exec_command
//   Edit         | StrReplace   | replace            | apply_patch
//   Write        | Write        | write_file         | apply_patch
//   Read         | Read         | read_file          | read_file
//   Grep         | Grep         | grep_search        | grep_files
//   Glob         | Glob         | glob               | list_dir
//   NotebookEdit | EditNotebook | —                  | apply_patch
//   TaskCreate   | TodoWrite    | write_todos        | update_plan

export const SHELL_TOOLS = new Set([
  "Bash",
  "Shell",
  "run_shell_command",
  "shell",
  "shell_command",
  "exec_command",
])
export const EDIT_TOOLS = new Set(["Edit", "StrReplace", "replace", "apply_patch"])
export const WRITE_TOOLS = new Set(["Write", "write_file", "apply_patch"])
export const READ_TOOLS = new Set(["Read", "read_file", "read_many_files"])
export const NOTEBOOK_TOOLS = new Set(["NotebookEdit", "EditNotebook", "apply_patch"])
export const TASK_TOOLS = new Set([
  "Task",
  "TaskCreate",
  "TaskUpdate",
  "TaskList",
  "TaskGet",
  "TodoWrite",
  "write_todos",
  "update_plan",
])
export const TASK_CREATE_TOOLS = new Set(["TaskCreate", "TodoWrite", "write_todos", "update_plan"])
export const TASK_UPDATE_TOOLS = new Set(["TaskUpdate", "update_plan"])
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
export function isFileEditTool(name: string): boolean {
  return EDIT_TOOLS.has(name) || WRITE_TOOLS.has(name)
}
export function isCodeChangeTool(name: string): boolean {
  return EDIT_TOOLS.has(name) || WRITE_TOOLS.has(name) || NOTEBOOK_TOOLS.has(name)
}
