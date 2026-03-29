/**
 * Shared Zod schemas for hook input/output envelopes.
 *
 * All schemas use `z.looseObject()` (Zod v4 equivalent of `.passthrough()`) for
 * forward compatibility — unknown fields are preserved rather than rejected,
 * keeping hooks resilient as tool payloads evolve.
 *
 * Consumers should call `.safeParse()` for non-critical validation and `.parse()`
 * only where strict enforcement is intentional.
 */

import { z } from "zod"

// ─── Tool hook input schemas ─────────────────────────────────────────────────

/**
 * File-edit tool_input payload — used by hooks that inspect file content.
 * Covers Edit, Write, StrReplace and equivalent cross-agent tools.
 */
/** NFKC-normalize a string field if present, preventing homoglyph bypasses. */
function nfkc(s: string | undefined): string | undefined {
  return s?.normalize("NFKC")
}

/** Recursively NFKC-normalize all string values in a JSON-like structure. */
function nfkcDeep(val: unknown): unknown {
  if (typeof val === "string") return val.normalize("NFKC")
  if (Array.isArray(val)) return val.map(nfkcDeep)
  if (val !== null && typeof val === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(val)) {
      out[k] = nfkcDeep(v)
    }
    return out
  }
  return val
}

export const fileEditHookInputSchema = z
  .looseObject({
    cwd: z.string().optional(),
    session_id: z.string().optional(),
    tool_name: z.string().optional(),
    tool_input: z
      .looseObject({
        file_path: z.string().optional(),
        old_string: z.string().optional(),
        new_string: z.string().optional(),
        content: z.string().optional(),
      })
      .optional(),
    transcript_path: z.string().optional(),
  })
  .transform((val) => {
    if (val.tool_input) {
      val.tool_input.old_string = nfkc(val.tool_input.old_string)
      val.tool_input.new_string = nfkc(val.tool_input.new_string)
      val.tool_input.content = nfkc(val.tool_input.content)
    }
    return val
  })

export type FileEditHookInput = z.infer<typeof fileEditHookInputSchema>

/**
 * Shell tool_input payload — used by hooks that inspect shell commands.
 * Covers Bash, Shell, run_shell_command and equivalent cross-agent tools.
 */
export const shellHookInputSchema = z
  .looseObject({
    cwd: z.string().optional(),
    session_id: z.string().optional(),
    tool_name: z.string().optional(),
    tool_input: z
      .looseObject({
        command: z.string().optional(),
      })
      .optional(),
    transcript_path: z.string().optional(),
  })
  .transform((val) => {
    if (val.tool_input) {
      val.tool_input.command = nfkc(val.tool_input.command)
    }
    return val
  })

export type ShellHookInput = z.infer<typeof shellHookInputSchema>

/**
 * Base PreToolUse / PostToolUse hook input envelope.
 * Mirrors the `ToolHookInput` interface in hook-utils.ts with runtime validation.
 */
export const toolHookInputSchema = z
  .looseObject({
    cwd: z.string().optional(),
    session_id: z.string().optional(),
    tool_name: z.string().optional(),
    tool_input: z.record(z.string(), z.unknown()).optional(),
    transcript_path: z.string().optional(),
  })
  .transform((val) => {
    if (val.tool_input) {
      val.tool_input = nfkcDeep(val.tool_input) as Record<string, unknown>
    }
    return val
  })

export type ToolHookInput = z.infer<typeof toolHookInputSchema>

/** PostToolUse input — extends ToolHookInput with the tool's response payload. */
export interface PostToolHookInput extends ToolHookInput {
  tool_response?: unknown
}

/**
 * Stop / SubagentStop hook input envelope.
 * Mirrors the `StopHookInput` interface in hook-utils.ts with runtime validation.
 */
export const stopHookInputSchema = z.looseObject({
  cwd: z.string().optional(),
  session_id: z.string().optional(),
  stop_hook_active: z.boolean().optional(),
  transcript_path: z.string().optional(),
})

export type StopHookInput = z.infer<typeof stopHookInputSchema>

/**
 * SessionStart / UserPromptSubmit / PreCompact hook input envelope.
 * Mirrors the `SessionHookInput` interface in hook-utils.ts with runtime validation.
 */
export const sessionHookInputSchema = z.looseObject({
  cwd: z.string().optional(),
  session_id: z.string().optional(),
  trigger: z.string().optional(),
  matcher: z.string().optional(),
  hook_event_name: z.string().optional(),
})

export type SessionHookInput = z.infer<typeof sessionHookInputSchema>

/**
 * PreCommit hook input envelope.
 * Dispatched by lefthook pre-commit via `swiz dispatch preCommit`.
 * Contains cwd and optionally the list of staged files.
 */
export const preCommitHookInputSchema = z.looseObject({
  cwd: z.string().optional(),
  staged_files: z.array(z.string()).optional(),
})

export type PreCommitHookInput = z.infer<typeof preCommitHookInputSchema>

// ─── Updated existing schemas with missing fields ───────────────────────────

/**
 * Stop / SubagentStop hook input envelope (extended).
 * Adds `last_assistant_message` per the hooks reference.
 */
export const stopHookExtendedInputSchema = z.looseObject({
  cwd: z.string().optional(),
  session_id: z.string().optional(),
  stop_hook_active: z.boolean().optional(),
  transcript_path: z.string().optional(),
  last_assistant_message: z.string().optional(),
  // SubagentStop-specific fields
  agent_id: z.string().optional(),
  agent_type: z.string().optional(),
  agent_transcript_path: z.string().optional(),
})

export type StopHookExtendedInput = z.infer<typeof stopHookExtendedInputSchema>

/**
 * SessionStart hook input envelope.
 * Extends the base session schema with `source`, `model`, and `agent_type`.
 */
export const sessionStartHookInputSchema = z.looseObject({
  cwd: z.string().optional(),
  session_id: z.string().optional(),
  trigger: z.string().optional(),
  matcher: z.string().optional(),
  hook_event_name: z.string().optional(),
  source: z.enum(["startup", "resume", "clear", "compact"]).optional(),
  model: z.string().optional(),
  agent_type: z.string().optional(),
})

export type SessionStartHookInput = z.infer<typeof sessionStartHookInputSchema>

/**
 * UserPromptSubmit hook input envelope.
 * Adds the `prompt` field containing the user's submitted text.
 */
export const userPromptSubmitHookInputSchema = z.looseObject({
  cwd: z.string().optional(),
  session_id: z.string().optional(),
  hook_event_name: z.string().optional(),
  transcript_path: z.string().optional(),
  permission_mode: z.string().optional(),
  prompt: z.string().optional(),
})

export type UserPromptSubmitHookInput = z.infer<typeof userPromptSubmitHookInputSchema>

// ─── New hook event input schemas ───────────────────────────────────────────

/**
 * Notification hook input envelope.
 * Fires when Claude Code sends a notification (permission_prompt, idle_prompt, etc.).
 */
export const notificationHookInputSchema = z.looseObject({
  cwd: z.string().optional(),
  session_id: z.string().optional(),
  hook_event_name: z.string().optional(),
  transcript_path: z.string().optional(),
  message: z.string().optional(),
  title: z.string().optional(),
  notification_type: z.string().optional(),
})

export type NotificationHookInput = z.infer<typeof notificationHookInputSchema>

/**
 * PermissionRequest hook input envelope.
 * Fires when a permission dialog is shown to the user.
 */
export const permissionRequestHookInputSchema = z.looseObject({
  cwd: z.string().optional(),
  session_id: z.string().optional(),
  hook_event_name: z.string().optional(),
  transcript_path: z.string().optional(),
  permission_mode: z.string().optional(),
  tool_name: z.string().optional(),
  tool_input: z.record(z.string(), z.unknown()).optional(),
  permission_suggestions: z.array(z.unknown()).optional(),
})

export type PermissionRequestHookInput = z.infer<typeof permissionRequestHookInputSchema>

/**
 * PostToolUseFailure hook input envelope.
 * Fires when a tool execution fails.
 */
export const postToolUseFailureHookInputSchema = z.looseObject({
  cwd: z.string().optional(),
  session_id: z.string().optional(),
  hook_event_name: z.string().optional(),
  transcript_path: z.string().optional(),
  permission_mode: z.string().optional(),
  tool_name: z.string().optional(),
  tool_input: z.record(z.string(), z.unknown()).optional(),
  tool_use_id: z.string().optional(),
  error: z.string().optional(),
  is_interrupt: z.boolean().optional(),
})

export type PostToolUseFailureHookInput = z.infer<typeof postToolUseFailureHookInputSchema>

/**
 * SubagentStart hook input envelope.
 * Fires when a subagent is spawned.
 */
export const subagentStartHookInputSchema = z.looseObject({
  cwd: z.string().optional(),
  session_id: z.string().optional(),
  hook_event_name: z.string().optional(),
  transcript_path: z.string().optional(),
  agent_id: z.string().optional(),
  agent_type: z.string().optional(),
})

export type SubagentStartHookInput = z.infer<typeof subagentStartHookInputSchema>

/**
 * TaskCreated / TaskCompleted hook input envelope.
 * Fires when a task is being created or completed.
 */
export const taskEventHookInputSchema = z.looseObject({
  cwd: z.string().optional(),
  session_id: z.string().optional(),
  hook_event_name: z.string().optional(),
  transcript_path: z.string().optional(),
  permission_mode: z.string().optional(),
  task_id: z.string().optional(),
  task_subject: z.string().optional(),
  task_description: z.string().optional(),
  teammate_name: z.string().optional(),
  team_name: z.string().optional(),
})

export type TaskEventHookInput = z.infer<typeof taskEventHookInputSchema>

/**
 * TeammateIdle hook input envelope.
 * Fires when an agent team teammate is about to go idle.
 */
export const teammateIdleHookInputSchema = z.looseObject({
  cwd: z.string().optional(),
  session_id: z.string().optional(),
  hook_event_name: z.string().optional(),
  transcript_path: z.string().optional(),
  permission_mode: z.string().optional(),
  teammate_name: z.string().optional(),
  team_name: z.string().optional(),
})

export type TeammateIdleHookInput = z.infer<typeof teammateIdleHookInputSchema>

/**
 * StopFailure hook input envelope.
 * Fires when the turn ends due to an API error.
 */
export const stopFailureHookInputSchema = z.looseObject({
  cwd: z.string().optional(),
  session_id: z.string().optional(),
  hook_event_name: z.string().optional(),
  transcript_path: z.string().optional(),
  error: z.string().optional(),
  error_details: z.string().optional(),
  last_assistant_message: z.string().optional(),
})

export type StopFailureHookInput = z.infer<typeof stopFailureHookInputSchema>

/**
 * InstructionsLoaded hook input envelope.
 * Fires when a CLAUDE.md or .claude/rules/*.md file is loaded.
 */
export const instructionsLoadedHookInputSchema = z.looseObject({
  cwd: z.string().optional(),
  session_id: z.string().optional(),
  hook_event_name: z.string().optional(),
  transcript_path: z.string().optional(),
  file_path: z.string().optional(),
  memory_type: z.enum(["User", "Project", "Local", "Managed"]).optional(),
  load_reason: z
    .enum(["session_start", "nested_traversal", "path_glob_match", "include", "compact"])
    .optional(),
  globs: z.array(z.string()).optional(),
  trigger_file_path: z.string().optional(),
  parent_file_path: z.string().optional(),
})

export type InstructionsLoadedHookInput = z.infer<typeof instructionsLoadedHookInputSchema>

/**
 * ConfigChange hook input envelope.
 * Fires when a configuration file changes during a session.
 */
export const configChangeHookInputSchema = z.looseObject({
  cwd: z.string().optional(),
  session_id: z.string().optional(),
  hook_event_name: z.string().optional(),
  transcript_path: z.string().optional(),
  source: z
    .enum(["user_settings", "project_settings", "local_settings", "policy_settings", "skills"])
    .optional(),
  file_path: z.string().optional(),
})

export type ConfigChangeHookInput = z.infer<typeof configChangeHookInputSchema>

/**
 * CwdChanged hook input envelope.
 * Fires when the working directory changes during a session.
 */
export const cwdChangedHookInputSchema = z.looseObject({
  cwd: z.string().optional(),
  session_id: z.string().optional(),
  hook_event_name: z.string().optional(),
  transcript_path: z.string().optional(),
  old_cwd: z.string().optional(),
  new_cwd: z.string().optional(),
})

export type CwdChangedHookInput = z.infer<typeof cwdChangedHookInputSchema>

/**
 * FileChanged hook input envelope.
 * Fires when a watched file changes on disk.
 */
export const fileChangedHookInputSchema = z.looseObject({
  cwd: z.string().optional(),
  session_id: z.string().optional(),
  hook_event_name: z.string().optional(),
  transcript_path: z.string().optional(),
  file_path: z.string().optional(),
  event: z.enum(["change", "add", "unlink"]).optional(),
})

export type FileChangedHookInput = z.infer<typeof fileChangedHookInputSchema>

/**
 * WorktreeCreate hook input envelope.
 * Fires when a worktree is being created.
 */
export const worktreeCreateHookInputSchema = z.looseObject({
  cwd: z.string().optional(),
  session_id: z.string().optional(),
  hook_event_name: z.string().optional(),
  transcript_path: z.string().optional(),
  name: z.string().optional(),
})

export type WorktreeCreateHookInput = z.infer<typeof worktreeCreateHookInputSchema>

/**
 * WorktreeRemove hook input envelope.
 * Fires when a worktree is being removed.
 */
export const worktreeRemoveHookInputSchema = z.looseObject({
  cwd: z.string().optional(),
  session_id: z.string().optional(),
  hook_event_name: z.string().optional(),
  transcript_path: z.string().optional(),
  worktree_path: z.string().optional(),
})

export type WorktreeRemoveHookInput = z.infer<typeof worktreeRemoveHookInputSchema>

/**
 * PostCompact hook input envelope.
 * Fires after a compact operation completes.
 */
export const postCompactHookInputSchema = z.looseObject({
  cwd: z.string().optional(),
  session_id: z.string().optional(),
  hook_event_name: z.string().optional(),
  transcript_path: z.string().optional(),
  trigger: z.enum(["manual", "auto"]).optional(),
  compact_summary: z.string().optional(),
})

export type PostCompactHookInput = z.infer<typeof postCompactHookInputSchema>

/**
 * Elicitation hook input envelope.
 * Fires when an MCP server requests user input during a tool call.
 */
export const elicitationHookInputSchema = z.looseObject({
  cwd: z.string().optional(),
  session_id: z.string().optional(),
  hook_event_name: z.string().optional(),
  transcript_path: z.string().optional(),
  permission_mode: z.string().optional(),
  mcp_server_name: z.string().optional(),
  message: z.string().optional(),
  mode: z.enum(["form", "url"]).optional(),
  url: z.string().optional(),
  elicitation_id: z.string().optional(),
  requested_schema: z.record(z.string(), z.unknown()).optional(),
})

export type ElicitationHookInput = z.infer<typeof elicitationHookInputSchema>

/**
 * ElicitationResult hook input envelope.
 * Fires after a user responds to an MCP elicitation.
 */
export const elicitationResultHookInputSchema = z.looseObject({
  cwd: z.string().optional(),
  session_id: z.string().optional(),
  hook_event_name: z.string().optional(),
  transcript_path: z.string().optional(),
  permission_mode: z.string().optional(),
  mcp_server_name: z.string().optional(),
  action: z.enum(["accept", "decline", "cancel"]).optional(),
  content: z.record(z.string(), z.unknown()).optional(),
  mode: z.enum(["form", "url"]).optional(),
  elicitation_id: z.string().optional(),
})

export type ElicitationResultHookInput = z.infer<typeof elicitationResultHookInputSchema>

/**
 * SessionEnd hook input envelope.
 * Fires when a session terminates.
 */
export const sessionEndHookInputSchema = z.looseObject({
  cwd: z.string().optional(),
  session_id: z.string().optional(),
  hook_event_name: z.string().optional(),
  transcript_path: z.string().optional(),
  reason: z
    .enum([
      "clear",
      "resume",
      "logout",
      "prompt_input_exit",
      "bypass_permissions_disabled",
      "other",
    ])
    .optional(),
})

export type SessionEndHookInput = z.infer<typeof sessionEndHookInputSchema>

// ─── Hook output envelope schema ─────────────────────────────────────────────

/**
 * Shape of any output emitted by hooks in this repository.
 * Used by contract tests to validate output envelopes via safeParse.
 */
export const hookOutputSchema = z
  .looseObject({
    decision: z.enum(["approve", "block"]).optional(),
    /** When decision is "block", signals the resolution type.
     *  "human-required" means the agent cannot resolve this autonomously — a human must act. */
    resolution: z.enum(["human-required"]).optional(),
    hookSpecificOutput: z.looseObject({ hookEventName: z.string().optional() }).optional(),
    ok: z.boolean().optional(),
    continue: z.unknown().optional(),
    systemMessage: z.unknown().optional(),
  })
  .refine(
    (o) =>
      "decision" in o ||
      "hookSpecificOutput" in o ||
      "ok" in o ||
      "continue" in o ||
      "systemMessage" in o,
    { message: "Hook output must contain at least one known control field" }
  )

// ─── TaskUpdate schema ────────────────────────────────────────────────────────

/**
 * TaskUpdate tool_input schema — single source of truth for allowed fields.
 * `TASK_UPDATE_ALLOWED_FIELDS` is derived from this schema so the set stays
 * in sync automatically when fields are added or removed.
 */
export const taskUpdateInputSchema = z.looseObject({
  taskId: z.string(),
  status: z.string().optional(),
  subject: z.string().optional(),
  description: z.string().optional(),
  activeForm: z.string().optional(),
  owner: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  addBlocks: z.array(z.string()).optional(),
  addBlockedBy: z.array(z.string()).optional(),
})

/** Allowed fields for TaskUpdate — derived from `taskUpdateInputSchema.shape`. */
export const TASK_UPDATE_ALLOWED_FIELDS: ReadonlySet<string> = new Set(
  Object.keys(taskUpdateInputSchema.shape)
)
