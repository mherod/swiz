// Shared utilities for swiz hook scripts.
// Import with: import { denyPreToolUse, isShellTool, isEditTool, ... } from "./hook-utils.ts";

// ─── Cross-agent tool equivalence ──────────────────────────────────────────
// Each set contains all names an agent might use for the same concept.

export const SHELL_TOOLS = new Set(["Bash", "Shell"]);
export const EDIT_TOOLS = new Set(["Edit", "StrReplace"]);
export const WRITE_TOOLS = new Set(["Write"]);
export const READ_TOOLS = new Set(["Read"]);
export const NOTEBOOK_TOOLS = new Set(["NotebookEdit", "EditNotebook"]);
export const TASK_TOOLS = new Set(["Task", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet", "TodoWrite"]);
export const TASK_CREATE_TOOLS = new Set(["TaskCreate", "TodoWrite"]);
export const SEARCH_TOOLS = new Set(["Grep", "Glob"]);

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

/** Emit a PreToolUse denial and exit. */
export function denyPreToolUse(reason: string): never {
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    })
  );
  process.exit(0);
}

/** Emit a PostToolUse block decision and exit. */
export function denyPostToolUse(reason: string): never {
  console.log(JSON.stringify({ decision: "block", reason }));
  process.exit(0);
}
