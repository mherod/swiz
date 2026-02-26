// Shared utilities for swiz hook scripts.
// Import with: import { denyPreToolUse, isShellTool, isEditTool, ... } from "./hook-utils.ts";

// ─── Cross-agent tool equivalence ──────────────────────────────────────────
// Each set contains all names an agent might use for the same concept.
// Claude Code | Cursor       | Gemini CLI
// Bash        | Shell        | run_shell_command
// Edit        | StrReplace   | replace
// Write       | Write        | write_file
// Read        | Read         | read_file
// Grep        | Grep         | grep_search
// Glob        | Glob         | glob
// NotebookEdit| EditNotebook | —
// TaskCreate  | TodoWrite    | write_todos

export const SHELL_TOOLS = new Set(["Bash", "Shell", "run_shell_command"]);
export const EDIT_TOOLS = new Set(["Edit", "StrReplace", "replace"]);
export const WRITE_TOOLS = new Set(["Write", "write_file"]);
export const READ_TOOLS = new Set(["Read", "read_file", "read_many_files"]);
export const NOTEBOOK_TOOLS = new Set(["NotebookEdit", "EditNotebook"]);
export const TASK_TOOLS = new Set(["Task", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet", "TodoWrite", "write_todos"]);
export const TASK_CREATE_TOOLS = new Set(["TaskCreate", "TodoWrite", "write_todos"]);
export const SEARCH_TOOLS = new Set(["Grep", "Glob", "grep_search", "glob"]);

export function isShellTool(name: string): boolean {
  return SHELL_TOOLS.has(name);
}
export function isEditTool(name: string): boolean {
  return EDIT_TOOLS.has(name);
}
export function isWriteTool(name: string): boolean {
  return WRITE_TOOLS.has(name);
}
export function isNotebookTool(name: string): boolean {
  return NOTEBOOK_TOOLS.has(name);
}
export function isTaskTool(name: string): boolean {
  return TASK_TOOLS.has(name);
}
export function isTaskCreateTool(name: string): boolean {
  return TASK_CREATE_TOOLS.has(name);
}
export function isFileEditTool(name: string): boolean {
  return EDIT_TOOLS.has(name) || WRITE_TOOLS.has(name);
}
export function isCodeChangeTool(name: string): boolean {
  return EDIT_TOOLS.has(name) || WRITE_TOOLS.has(name) || NOTEBOOK_TOOLS.has(name);
}

// ─── Hook response helpers ─────────────────────────────────────────────────
// Outputs polyglot JSON understood by Claude Code, Cursor, and Gemini CLI.

/** Emit a PreToolUse denial and exit. Works across all agents. */
export function denyPreToolUse(reason: string): never {
  console.log(
    JSON.stringify({
      decision: "deny",
      reason,
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    })
  );
  process.exit(0);
}

/** Emit a PostToolUse block decision and exit. Works across all agents. */
export function denyPostToolUse(reason: string): never {
  console.log(
    JSON.stringify({
      decision: "block",
      reason,
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: reason,
      },
    })
  );
  process.exit(0);
}

/** Emit additional context for a hook event. Works across all agents. */
export function emitContext(eventName: string, context: string): void {
  console.log(
    JSON.stringify({
      systemMessage: context,
      hookSpecificOutput: {
        hookEventName: eventName,
        additionalContext: context,
      },
    })
  );
}
