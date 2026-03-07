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

// ─── Hook output envelope schema ─────────────────────────────────────────────

/**
 * Shape of any output emitted by hooks in this repository.
 * Used by contract tests to validate output envelopes via safeParse.
 */
export const hookOutputSchema = z
  .looseObject({
    decision: z.enum(["approve", "block"]).optional(),
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
