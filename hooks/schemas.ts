// noinspection JSUnusedGlobalSymbols

/**
 * Shared Zod schemas for hook input/output envelopes.
 *
 * All schemas use `z.looseObject()` (Zod v4 equivalent of `.passthrough()`) for
 * forward compatibility — unknown fields are preserved rather than rejected,
 * keeping hooks resilient as tool payloads evolve.
 *
 * Consumers should call `.safeParse()` for non-critical validation and `.parse()`
 * only where strict enforcement is intentional.
 *
 * ## Claude Code hooks (authoritative reference)
 *
 * Official hook behavior, event list, and JSON I/O are documented at
 * [Claude Code — Hooks reference](https://code.claude.com/docs/en/hooks) (see also the
 * documentation index at `https://code.claude.com/docs/llms.txt`). Swiz mirrors those shapes
 * for subprocess stdout; merged **Stop** / **SubagentStop** dispatch responses are stricter
 * ({@link stopHookOutputSchema}).
 *
 * ### Universal JSON output (exit 0 + stdout JSON)
 *
 * | Field | Default | Description |
 * | ----- | ------- | ----------- |
 * | `continue` | `true` | If `false`, Claude stops processing after the hook (pair with `stopReason`). |
 * | `stopReason` | none | Message shown to the user when `continue` is `false` (not necessarily shown to Claude). |
 * | `suppressOutput` | `false` | Hide hook stdout from verbose output. |
 * | `systemMessage` | none | Warning shown to the user. |
 *
 * **Top-level `decision` + `reason`** — used by **UserPromptSubmit**, **PostToolUse**,
 * **PostToolUseFailure**, **Stop**, **SubagentStop**, **ConfigChange** for blocking: the only
 * decision value is `"block"`. To allow, omit `decision` or emit no JSON.
 *
 * ### Stop / SubagentStop (Claude Code)
 *
 * Blocking Claude from stopping uses **`decision: "block"`** and a **`reason`** (required when
 * blocking). Example:
 *
 * ```json
 * { "decision": "block", "reason": "Test suite must pass before proceeding" }
 * ```
 *
 * Do not emit **`hookSpecificOutput`** on Stop (Claude only allows it for PreToolUse,
 * UserPromptSubmit, and PostToolUse). Use top-level **`reason`** and **`systemMessage`**.
 *
 * **PreToolUse** uses **`hookSpecificOutput.permissionDecision`** / **`permissionDecisionReason`**
 * (not top-level `decision` / `reason` as the primary control).
 *
 * ### Swiz validation layers
 *
 * - **Per-hook subprocess stdout** — {@link hookOutputSchema} via `classifyHookOutput` in
 *   `src/dispatch/worker-types.ts` (empty `{}` is valid).
 * - **Dispatch stdin (entry)** — `assertDispatchInboundNotParseError` (fatal parse / non-object),
 *   then `dispatchInboundObjectSchema` and per-route schemas in
 *   `src/dispatch/dispatch-zod-surfaces.ts` (`DISPATCH_CANONICAL_INBOUND_SCHEMAS`) after
 *   `normalizeAgentHookPayload` and cwd/session backfill (`executeDispatch`, replay).
 * - **Enriched hook stdin** — `assertEnrichedDispatchPayloadRecord` before stringifying to hook subprocesses.
 * - **Subprocess hook stdout** — {@link hookOutputSchema} via `hookOutputSchema.parse` in
 *   `classifyHookOutput` (`src/dispatch/worker-types.ts`) and inline hook output (`engine.ts`).
 * - **Merged agent-visible dispatch (exit)** — `coerceDispatchAgentEnvelopeInPlace` and
 *   `parseValidatedAgentDispatchWireJson` (also run before `executeDispatch` returns and in the
 *   daemon) call `.parse()` on {@link hookOutputSchema} / {@link stopHookOutputSchema}; internal
 *   keys such as `hookExecutions` are stripped in `src/dispatch/dispatch-wire.ts`.
 */

import { z } from "zod"
import { isJsonLikeRecord } from "../src/utils/hook-json-helpers.ts"
import { getHookSpecificOutput } from "../src/utils/hook-specific-output.ts"

// ─── Primitive field schemas ──────────────────────────────────────────────────
// Single-field building blocks reused across every hook envelope.
// Use as `CwdSchema.optional()` inside `z.looseObject({})`.

/** Absolute path of the working directory when the hook fires. */
export const CwdSchema = z.string()
export type Cwd = z.infer<typeof CwdSchema>

/** Opaque session identifier assigned by the agent runtime. */
export const SessionIdSchema = z.string()
export type SessionId = z.infer<typeof SessionIdSchema>

/** Absolute path to the session transcript JSONL file. */
export const TranscriptPathSchema = z.string()
export type TranscriptPath = z.infer<typeof TranscriptPathSchema>

/** Name of the hook event that fired (e.g. `"PreToolUse"`, `"Stop"`). */
export const HookEventNameSchema = z.string()
export type HookEventName = z.infer<typeof HookEventNameSchema>

/** Agent permission mode active at hook time (e.g. `"default"`, `"auto"`). */
export const PermissionModeSchema = z.string()
export type PermissionMode = z.infer<typeof PermissionModeSchema>

/** Tool name as reported by the agent (e.g. `"Bash"`, `"Edit"`). */
export const ToolNameSchema = z.string()
export type ToolName = z.infer<typeof ToolNameSchema>

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
  if (isJsonLikeRecord(val)) {
    const out: Record<string, any> = {}
    for (const [k, v] of Object.entries(val)) {
      out[k] = nfkcDeep(v)
    }
    return out
  }
  return val
}

/**
 * Minimal common fields present on every hook envelope.
 * All hook input schemas extend this base.
 */
export const hookBaseSchema = z.looseObject({
  cwd: CwdSchema.optional(),
  session_id: SessionIdSchema.optional(),
  hook_event_name: HookEventNameSchema.optional(),
  transcript_path: TranscriptPathSchema.optional(),
})
export type HookBase = z.infer<typeof hookBaseSchema>

/**
 * Shared envelope fields present on every tool-use hook event.
 * Extended by `fileEditHookInputSchema`, `shellHookInputSchema`,
 * `toolHookInputSchema`, and `skillToolInputSchema`.
 */
const toolHookBaseObjectSchema = hookBaseSchema.extend({
  tool_name: ToolNameSchema.optional(),
  tool_input: z.record(z.string(), z.unknown()).optional(),
  permission_mode: PermissionModeSchema.optional(),
})

export const fileEditHookInputSchema = toolHookBaseObjectSchema
  .extend({
    tool_input: z
      .looseObject({
        file_path: z.string().optional(),
        old_string: z.string().optional(),
        new_string: z.string().optional(),
        content: z.string().optional(),
      })
      .optional(),
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
export const shellHookInputSchema = toolHookBaseObjectSchema
  .extend({
    tool_input: z
      .looseObject({
        command: z.string().optional(),
      })
      .optional(),
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
export const toolHookInputSchema = toolHookBaseObjectSchema.transform((val) => {
  if (val.tool_input) {
    val.tool_input = nfkcDeep(val.tool_input) as Record<string, any>
  }
  return val
})

export type ToolHookInput = z.infer<typeof toolHookInputSchema>

/**
 * Skill tool_input payload — used by hooks that process Skill tool invocations.
 * Validates skill name and optional arguments with NFKC normalization.
 */
export const skillToolInputSchema = toolHookBaseObjectSchema
  .extend({
    tool_input: z
      .looseObject({
        skill: z.string().optional(),
        args: z.string().optional(),
      })
      .optional(),
  })
  .transform((val) => {
    if (val.tool_input) {
      val.tool_input.skill = nfkc(val.tool_input.skill)
      val.tool_input.args = nfkc(val.tool_input.args)
    }
    return val
  })

export type SkillToolInput = z.infer<typeof skillToolInputSchema>

/** PostToolUse input — extends ToolHookInput with the tool's response payload. */
export interface PostToolHookInput extends ToolHookInput {
  tool_response?: unknown
}

/**
 * PostToolUse stdin envelope — tool hook fields plus optional `tool_response` from the runtime.
 */
export const postToolUseHookInputSchema = toolHookBaseObjectSchema
  .extend({
    tool_response: z.unknown().optional(),
  })
  .transform((val) => {
    if (val.tool_input) {
      val.tool_input = nfkcDeep(val.tool_input) as Record<string, any>
    }
    return val
  })

export type PostToolUseHookInput = z.infer<typeof postToolUseHookInputSchema>

/**
 * Stop / SubagentStop hook input envelope.
 * Mirrors the `StopHookInput` interface in hook-utils.ts with runtime validation.
 */
export const stopHookInputSchema = hookBaseSchema.extend({
  stop_hook_active: z.boolean().optional(),
  permission_mode: PermissionModeSchema.optional(),
})

export type StopHookInput = z.infer<typeof stopHookInputSchema>

/**
 * PreCompact hook input envelope (and legacy session-shaped events).
 * For SessionStart, prefer {@link sessionStartHookInputSchema}.
 * For UserPromptSubmit, prefer {@link userPromptSubmitHookInputSchema}.
 */
export const sessionHookInputSchema = hookBaseSchema.extend({
  trigger: z.string().optional(),
  matcher: z.string().optional(),
  permission_mode: PermissionModeSchema.optional(),
})

export type SessionHookInput = z.infer<typeof sessionHookInputSchema>

/**
 * PreCommit hook input envelope.
 * Dispatched by lefthook pre-commit via `swiz dispatch preCommit`.
 * Contains cwd and optionally the list of staged files.
 */
export const preCommitHookInputSchema = z.looseObject({
  cwd: CwdSchema.optional(),
  staged_files: z.array(z.string()).optional(),
})

export type PreCommitHookInput = z.infer<typeof preCommitHookInputSchema>

/**
 * PrePush hook input envelope.
 */
export const prePushHookInputSchema = z.looseObject({
  cwd: CwdSchema.optional(),
})

export type PrePushHookInput = z.infer<typeof prePushHookInputSchema>

/**
 * PrPoll scheduled hook input. Dispatcher sends hook base fields (typically `cwd`).
 */
export const prPollHookInputSchema = hookBaseSchema

export type PrPollHookInput = z.infer<typeof prPollHookInputSchema>

// ─── Updated existing schemas with missing fields ───────────────────────────

/**
 * Stop / SubagentStop hook input envelope (extended).
 * Adds `last_assistant_message` per the hooks reference.
 */
export const stopHookExtendedInputSchema = hookBaseSchema.extend({
  stop_hook_active: z.boolean().optional(),
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
export const sessionStartHookInputSchema = hookBaseSchema.extend({
  trigger: z.string().optional(),
  matcher: z.string().optional(),
  source: z.enum(["startup", "resume", "clear", "compact"]).optional(),
  model: z.string().optional(),
  agent_type: z.string().optional(),
})

export type SessionStartHookInput = z.infer<typeof sessionStartHookInputSchema>

/**
 * UserPromptSubmit hook input envelope.
 * Adds the `prompt` field containing the user's submitted text.
 */
export const userPromptSubmitHookInputSchema = hookBaseSchema.extend({
  permission_mode: PermissionModeSchema.optional(),
  prompt: z.string().optional(),
})

export type UserPromptSubmitHookInput = z.infer<typeof userPromptSubmitHookInputSchema>

// ─── New hook event input schemas ───────────────────────────────────────────

/**
 * Notification hook input envelope.
 * Fires when Claude Code sends a notification (permission_prompt, idle_prompt, etc.).
 */
export const notificationHookInputSchema = hookBaseSchema.extend({
  message: z.string().optional(),
  title: z.string().optional(),
  notification_type: z.string().optional(),
})

export type NotificationHookInput = z.infer<typeof notificationHookInputSchema>

/**
 * PermissionRequest hook input envelope.
 * Fires when a permission dialog is shown to the user.
 */
export const permissionRequestHookInputSchema = toolHookBaseObjectSchema.extend({
  permission_suggestions: z.array(z.unknown()).optional(),
})

export type PermissionRequestHookInput = z.infer<typeof permissionRequestHookInputSchema>

/**
 * PostToolUseFailure hook input envelope.
 * Fires when a tool execution fails.
 */
export const postToolUseFailureHookInputSchema = toolHookBaseObjectSchema.extend({
  tool_use_id: z.string().optional(),
  error: z.string().optional(),
  is_interrupt: z.boolean().optional(),
})

export type PostToolUseFailureHookInput = z.infer<typeof postToolUseFailureHookInputSchema>

/**
 * SubagentStart hook input envelope.
 * Fires when a subagent is spawned.
 */
export const subagentStartHookInputSchema = hookBaseSchema.extend({
  agent_id: z.string().optional(),
  agent_type: z.string().optional(),
})

export type SubagentStartHookInput = z.infer<typeof subagentStartHookInputSchema>

/**
 * TaskCreated / TaskCompleted hook input envelope.
 * Fires when a task is being created or completed.
 */
export const taskEventHookInputSchema = hookBaseSchema.extend({
  permission_mode: PermissionModeSchema.optional(),
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
export const teammateIdleHookInputSchema = hookBaseSchema.extend({
  permission_mode: PermissionModeSchema.optional(),
  teammate_name: z.string().optional(),
  team_name: z.string().optional(),
})

export type TeammateIdleHookInput = z.infer<typeof teammateIdleHookInputSchema>

/**
 * StopFailure hook input envelope.
 * Fires when the turn ends due to an API error.
 */
export const stopFailureHookInputSchema = hookBaseSchema.extend({
  error: z.string().optional(),
  error_details: z.string().optional(),
  last_assistant_message: z.string().optional(),
})

export type StopFailureHookInput = z.infer<typeof stopFailureHookInputSchema>

/**
 * InstructionsLoaded hook input envelope.
 * Fires when a CLAUDE.md or .claude/rules/*.md file is loaded.
 */
export const instructionsLoadedHookInputSchema = hookBaseSchema.extend({
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
export const configChangeHookInputSchema = hookBaseSchema.extend({
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
export const cwdChangedHookInputSchema = hookBaseSchema.extend({
  old_cwd: z.string().optional(),
  new_cwd: z.string().optional(),
})

export type CwdChangedHookInput = z.infer<typeof cwdChangedHookInputSchema>

/**
 * FileChanged hook input envelope.
 * Fires when a watched file changes on disk.
 */
export const fileChangedHookInputSchema = hookBaseSchema.extend({
  file_path: z.string().optional(),
  event: z.enum(["change", "add", "unlink"]).optional(),
})

export type FileChangedHookInput = z.infer<typeof fileChangedHookInputSchema>

/**
 * WorktreeCreate hook input envelope.
 * Fires when a worktree is being created.
 */
export const worktreeCreateHookInputSchema = hookBaseSchema.extend({
  name: z.string().optional(),
})

export type WorktreeCreateHookInput = z.infer<typeof worktreeCreateHookInputSchema>

/**
 * WorktreeRemove hook input envelope.
 * Fires when a worktree is being removed.
 */
export const worktreeRemoveHookInputSchema = hookBaseSchema.extend({
  worktree_path: z.string().optional(),
})

export type WorktreeRemoveHookInput = z.infer<typeof worktreeRemoveHookInputSchema>

/**
 * PostCompact hook input envelope.
 * Fires after a compact operation completes.
 */
export const postCompactHookInputSchema = hookBaseSchema.extend({
  trigger: z.enum(["manual", "auto"]).optional(),
  compact_summary: z.string().optional(),
})

export type PostCompactHookInput = z.infer<typeof postCompactHookInputSchema>

/**
 * Elicitation hook input envelope.
 * Fires when an MCP server requests user input during a tool call.
 */
export const elicitationHookInputSchema = hookBaseSchema.extend({
  permission_mode: PermissionModeSchema.optional(),
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
export const elicitationResultHookInputSchema = hookBaseSchema.extend({
  permission_mode: PermissionModeSchema.optional(),
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
export const sessionEndHookInputSchema = hookBaseSchema.extend({
  permission_mode: PermissionModeSchema.optional(),
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

// ─── Gemini CLI hook input schemas ──────────────────────────────────────────

/**
 * Gemini common input fields — present on every Gemini hook event.
 * Gemini injects `GEMINI_PROJECT_DIR`, `GEMINI_SESSION_ID`, `GEMINI_CWD`
 * as env vars; hooks also receive a JSON payload on stdin.
 */
export const geminiCommonInputSchema = hookBaseSchema

export type GeminiCommonInput = z.infer<typeof geminiCommonInputSchema>

/**
 * Gemini SessionStart hook input envelope.
 * `source` matches: `startup`, `resume`, `clear`.
 */
export const geminiSessionStartInputSchema = hookBaseSchema.extend({
  source: z.enum(["startup", "resume", "clear"]).optional(),
})

export type GeminiSessionStartInput = z.infer<typeof geminiSessionStartInputSchema>

/**
 * Gemini SessionEnd hook input envelope.
 * Fires when a session ends (exit, clear).
 */
export const geminiSessionEndInputSchema = hookBaseSchema.extend({
  reason: z.string().optional(),
})

export type GeminiSessionEndInput = z.infer<typeof geminiSessionEndInputSchema>

/**
 * Gemini BeforeAgent hook input envelope.
 * Fires after user submits prompt, before planning. Can block the turn.
 */
export const geminiBeforeAgentInputSchema = hookBaseSchema.extend({
  prompt: z.string().optional(),
})

export type GeminiBeforeAgentInput = z.infer<typeof geminiBeforeAgentInputSchema>

/**
 * Gemini AfterAgent hook input envelope.
 * Fires when the agent loop ends. Can force retry or halt.
 */
export const geminiAfterAgentInputSchema = hookBaseSchema.extend({
  stop_hook_active: z.boolean().optional(),
  last_assistant_message: z.string().optional(),
})

export type GeminiAfterAgentInput = z.infer<typeof geminiAfterAgentInputSchema>

/**
 * Gemini BeforeModel hook input envelope.
 * Fires before sending request to LLM. Can block turn or mock response.
 */
export const geminiBeforeModelInputSchema = hookBaseSchema.extend({
  model: z.string().optional(),
  prompt: z.string().optional(),
})

export type GeminiBeforeModelInput = z.infer<typeof geminiBeforeModelInputSchema>

/**
 * Gemini AfterModel hook input envelope.
 * Fires after receiving LLM response. Can block turn or redact.
 */
export const geminiAfterModelInputSchema = hookBaseSchema.extend({
  model: z.string().optional(),
  response: z.unknown().optional(),
})

export type GeminiAfterModelInput = z.infer<typeof geminiAfterModelInputSchema>

/**
 * Gemini BeforeToolSelection hook input envelope.
 * Fires before LLM selects tools. Can filter available tools.
 */
export const geminiBeforeToolSelectionInputSchema = hookBaseSchema.extend({
  available_tools: z.array(z.string()).optional(),
})

export type GeminiBeforeToolSelectionInput = z.infer<typeof geminiBeforeToolSelectionInputSchema>

/**
 * Gemini BeforeTool hook input envelope.
 * Fires before a tool executes. `matcher` is regex against tool name.
 * Can block tool or rewrite arguments.
 */
export const geminiBeforeToolInputSchema = toolHookBaseObjectSchema.transform((val) => {
  if (val.tool_input) {
    val.tool_input = nfkcDeep(val.tool_input) as Record<string, any>
  }
  return val
})

export type GeminiBeforeToolInput = z.infer<typeof geminiBeforeToolInputSchema>

/**
 * Gemini AfterTool hook input envelope.
 * Fires after a tool executes. Can block result or add context.
 * `matcher` is regex against tool name.
 */
export const geminiAfterToolInputSchema = toolHookBaseObjectSchema
  .extend({
    tool_response: z.unknown().optional(),
  })
  .transform((val) => {
    if (val.tool_input) {
      val.tool_input = nfkcDeep(val.tool_input) as Record<string, any>
    }
    return val
  })

export type GeminiAfterToolInput = z.infer<typeof geminiAfterToolInputSchema>

/**
 * Gemini PreCompress hook input envelope.
 * Advisory event — fires before context compression.
 */
export const geminiPreCompressInputSchema = hookBaseSchema

export type GeminiPreCompressInput = z.infer<typeof geminiPreCompressInputSchema>

/**
 * Gemini Notification hook input envelope.
 * Advisory event — fires when a system notification occurs.
 */
export const geminiNotificationInputSchema = hookBaseSchema.extend({
  message: z.string().optional(),
  title: z.string().optional(),
  notification_type: z.string().optional(),
})

export type GeminiNotificationInput = z.infer<typeof geminiNotificationInputSchema>

export const hookSpecificOutputSchema = z.looseObject({
  hookEventName: z.string().optional(),
  additionalContext: z.string().optional(),
  permissionDecision: z.enum(["allow", "deny"]).optional(),
  permissionDecisionReason: z.string().optional(),
})

export type HookSpecificOutput = z.infer<typeof hookSpecificOutputSchema>

/**
 * Gemini hook output envelope.
 * Decision uses `"allow"/"deny"` (not `"approve"/"block"` like Claude).
 * Exit code 2 = system block (stderr as reason). Other non-zero = warning.
 * Silence on stdout (exit 0) = allow.
 */
export const geminiHookOutputSchema = z
  .looseObject({
    decision: z.enum(["allow", "deny"]).optional(),
    reason: z.string().optional(),
    systemMessage: z.string().optional(),
    additionalContext: z.string().optional(),
    /** AfterAgent: force retry of the agent loop. */
    retry: z.boolean().optional(),
    /** AfterAgent: halt execution entirely. */
    halt: z.boolean().optional(),
    /** BeforeToolSelection: filtered list of allowed tool names. */
    filteredTools: z.array(z.string()).optional(),
    /** BeforeTool: rewritten tool arguments. */
    updatedInput: z.record(z.string(), z.unknown()).optional(),
    /** BeforeModel: mock response to use instead of calling LLM. */
    mockResponse: z.string().optional(),
    hookSpecificOutput: hookSpecificOutputSchema.optional(),
  })
  .refine(
    (o) =>
      "decision" in o ||
      "hookSpecificOutput" in o ||
      "systemMessage" in o ||
      "additionalContext" in o ||
      "retry" in o ||
      "halt" in o ||
      "filteredTools" in o ||
      "updatedInput" in o ||
      "mockResponse" in o,
    { message: "Gemini hook output must contain at least one known control field" }
  )

export type GeminiHookOutput = z.infer<typeof geminiHookOutputSchema>

// ─── Codex hook input schemas ───────────────────────────────────────────────

/**
 * Codex common input fields — present on every Codex hook event.
 * Extends the base envelope with `model` and `hook_event_name`.
 * `transcript_path` is nullable in Codex (null when no transcript exists).
 */
/**
 * Base input fields for Codex hook envelopes.
 * Extends `hookBaseSchema` with nullable `transcript_path` (null when no
 * transcript exists) and `model`.
 */
const codexHookBaseSchema = hookBaseSchema.extend({
  transcript_path: TranscriptPathSchema.nullable().optional(),
  model: z.string().optional(),
})

export const codexCommonInputSchema = codexHookBaseSchema

export type CodexCommonInput = z.infer<typeof codexCommonInputSchema>

/**
 * Codex SessionStart hook input envelope.
 * `source` is limited to `startup` | `resume` in current Codex runtime.
 * `matcher` filters on `source`.
 */
export const codexSessionStartInputSchema = codexHookBaseSchema.extend({
  source: z.enum(["startup", "resume"]).optional(),
})

export type CodexSessionStartInput = z.infer<typeof codexSessionStartInputSchema>

/**
 * Codex PreToolUse hook input envelope.
 * Currently only fires for `Bash` tool. Includes `turn_id` and `tool_use_id`.
 * `matcher` filters on `tool_name`.
 */
export const codexPreToolUseInputSchema = codexHookBaseSchema
  .extend({
    turn_id: z.string().optional(),
    tool_name: ToolNameSchema.optional(),
    tool_use_id: z.string().optional(),
    tool_input: z
      .looseObject({
        command: z.string().optional(),
      })
      .optional(),
  })
  .transform((val) => {
    if (val.tool_input) {
      val.tool_input.command = nfkc(val.tool_input.command)
    }
    return val
  })

export type CodexPreToolUseInput = z.infer<typeof codexPreToolUseInputSchema>

/**
 * Codex PostToolUse hook input envelope.
 * Currently only fires for `Bash` tool. Includes `tool_response` with the
 * command output payload (usually a JSON string).
 * `matcher` filters on `tool_name`.
 */
export const codexPostToolUseInputSchema = codexHookBaseSchema
  .extend({
    turn_id: z.string().optional(),
    tool_name: ToolNameSchema.optional(),
    tool_use_id: z.string().optional(),
    tool_input: z
      .looseObject({
        command: z.string().optional(),
      })
      .optional(),
    tool_response: z.unknown().optional(),
  })
  .transform((val) => {
    if (val.tool_input) {
      val.tool_input.command = nfkc(val.tool_input.command)
    }
    return val
  })

export type CodexPostToolUseInput = z.infer<typeof codexPostToolUseInputSchema>

/**
 * Codex UserPromptSubmit hook input envelope.
 * `matcher` is not used for this event in Codex.
 */
export const codexUserPromptSubmitInputSchema = codexHookBaseSchema.extend({
  turn_id: z.string().optional(),
  prompt: z.string().optional(),
})

export type CodexUserPromptSubmitInput = z.infer<typeof codexUserPromptSubmitInputSchema>

/**
 * Codex Stop hook input envelope.
 * `matcher` is not used for this event in Codex.
 * `stop_hook_active` indicates whether this turn was already continued by Stop.
 * Expects JSON on stdout (plain text is invalid for this event).
 */
export const codexStopInputSchema = codexHookBaseSchema.extend({
  turn_id: z.string().optional(),
  stop_hook_active: z.boolean().optional(),
  last_assistant_message: z.string().nullable().optional(),
})

export type CodexStopInput = z.infer<typeof codexStopInputSchema>

/**
 * Codex hook output envelope.
 * Supports common output fields (`continue`, `stopReason`, `systemMessage`,
 * `suppressOutput`) plus `decision`/`reason` and `hookSpecificOutput`.
 * Alternative blocking: exit code 2 + reason on stderr.
 */
export const codexHookOutputSchema = z
  .looseObject({
    decision: z.enum(["approve", "block"]).optional(),
    reason: z.string().optional(),
    continue: z.boolean().optional(),
    stopReason: z.string().optional(),
    systemMessage: z.string().optional(),
    suppressOutput: z.boolean().optional(),
    hookSpecificOutput: z
      .looseObject({
        hookEventName: z.string().optional(),
        additionalContext: z.string().optional(),
        permissionDecision: z.enum(["allow", "deny", "ask"]).optional(),
        permissionDecisionReason: z.string().optional(),
      })
      .optional(),
  })
  .refine(
    (o) =>
      "decision" in o ||
      "hookSpecificOutput" in o ||
      "continue" in o ||
      "systemMessage" in o ||
      "stopReason" in o ||
      "suppressOutput" in o,
    { message: "Codex hook output must contain at least one known control field" }
  )

export type CodexHookOutput = z.infer<typeof codexHookOutputSchema>

// ─── Hook output envelope schema ─────────────────────────────────────────────

/**
 * Per-hook subprocess stdout JSON (all events). See module doc for which fields the
 * agent honors per event (SessionStart / UserPromptSubmit / Stop vs PreToolUse vs PostToolUse).
 *
 * Empty `{}` is valid (exit 0, no output). Explicit `continue: true` requires accompanying
 * context (`systemMessage`, `reason`, `stopReason`, or `hookSpecificOutput.additionalContext`).
 */
const hookOutputRefinedSchema = z
  .looseObject({
    decision: z.enum(["approve", "block"]).optional(),
    /** When decision is "block", signals the resolution type.
     *  "human-required" means the agent cannot resolve this autonomously — a human must act. */
    resolution: z.enum(["human-required"]).optional(),
    hookSpecificOutput: z
      .looseObject({
        hookEventName: z.string().optional(),
        additionalContext: z.string().optional(),
        /** PreToolUse: required when emitting permission decisions; omit for PostToolUse context-only payloads. */
        permissionDecision: z.enum(["allow", "deny", "ask"]).optional(),
        permissionDecisionReason: z.string().optional(),
        /** PreToolUse: rewritten tool input fields. */
        modifiedInput: z.record(z.string(), z.unknown()).optional(),
        updatedInput: z.record(z.string(), z.unknown()).optional(),
      })
      .optional(),
    ok: z.boolean().optional(),
    /**
     * SessionStart / UserPromptSubmit / Stop / PostToolUse: whether the hook run continues.
     * PreToolUse: not supported in runtime; prefer `hookSpecificOutput` / `decision` patterns.
     */
    continue: z.boolean().optional(),
    /** Alias for stopReason — message shown when continue is false. */
    reason: z.string().optional(),
    /** SessionStart / UserPromptSubmit / Stop / PostToolUse: reason recorded when stopping. */
    stopReason: z.string().optional(),
    /** PreToolUse / PostToolUse / session events: warning surfaced in UI or stream. */
    systemMessage: z.string().optional(),
    /** Parsed on stdout; runtime support varies by event (see module doc). */
    suppressOutput: z.boolean().optional(),
  })
  .refine(
    (o) => {
      // Empty output {} is valid — no opinion, proceed with defaults
      const hasAnyControlField =
        "decision" in o ||
        "hookSpecificOutput" in o ||
        "ok" in o ||
        "continue" in o ||
        "systemMessage" in o

      if (hasAnyControlField) return true // Has control field, may need further validation below

      // No control fields = empty output, which is valid
      return true
    },
    { message: "Hook output must contain at least one known control field" }
  )
  .refine(
    (o) => {
      // Silent allows (continue: true without any context) are invalid
      // Only reject when continue is EXPLICITLY true AND there's no explanation
      if (o.continue === true) {
        const hasSystemMsg = typeof o.systemMessage === "string" && o.systemMessage.trim()
        const hasReason = typeof o.reason === "string" && o.reason.trim()
        const hasStopReason = typeof o.stopReason === "string" && o.stopReason.trim()
        const hso = getHookSpecificOutput(o as Record<string, any>)
        const hasHsoContext =
          hso && typeof hso.additionalContext === "string" && hso.additionalContext.trim()

        // continue: true requires at least one context field
        if (!hasSystemMsg && !hasReason && !hasStopReason && !hasHsoContext) {
          return false
        }
      }

      return true
    },
    {
      message:
        "Hook output with continue: true must include context (systemMessage, reason, stopReason, or hookSpecificOutput.additionalContext). Omitting continue: true (empty output {}) is valid.",
    }
  )

/**
 * Shape of any output emitted by hooks in this repository.
 * Used by contract tests to validate output envelopes via safeParse.
 */
export const hookOutputSchema = hookOutputRefinedSchema

export type HookOutput = z.infer<typeof hookOutputSchema>

/** Merged stop dispatch must carry an agent-visible stop narrative — not context-only. */
function stopHookOutputHasReasonOrStopReason(o: Record<string, any>): boolean {
  const r = typeof o.reason === "string" && o.reason.trim()
  const s = typeof o.stopReason === "string" && o.stopReason.trim()
  return Boolean(r || s)
}

function stopHookOutputHasBlockDecision(o: Record<string, any>): boolean {
  if (o.decision === "block" || o.decision === "deny") return true
  const hso = getHookSpecificOutput(o)
  if (!hso) return false
  const d = hso.decision
  return d === "block" || d === "deny"
}

/**
 * `continue: true`; or **`continue: false`** with non-empty **`stopReason`** (Claude universal
 * output); or top-level **`decision: "block"` / `"deny"`** (may omit `continue`).
 */
function stopHookOutputContinueValid(o: Record<string, any>): boolean {
  if (o.continue === false) {
    return typeof o.stopReason === "string" && o.stopReason.trim().length > 0
  }
  if (o.continue === true) return true
  return stopHookOutputHasBlockDecision(o)
}

/** Stop / SubagentStop: `decision: "block"` / `"deny"` requires **`reason`** (not `stopReason` alone). */
function stopHookOutputBlockDecisionRequiresReason(o: Record<string, any>): boolean {
  if (o.decision === "block" || o.decision === "deny") {
    return typeof o.reason === "string" && o.reason.trim().length > 0
  }
  return true
}

/**
 * Stop / SubagentStop **dispatch** merged JSON (after `normalizeStopDispatchResponseInPlace`).
 *
 * Aligns with [Claude Code — Hooks](https://code.claude.com/docs/en/hooks): **Stop** blocking uses
 * **`decision: "block"`** and **`reason`**. Universal fields allow **`continue: false`** with
 * **`stopReason`** (stops Claude entirely — distinct from the Stop-hook block pattern). At least one
 * of **`reason`** or **`stopReason`** must be non-empty; **`hookSpecificOutput.additionalContext`**
 * alone is invalid. After normalization, Stop-style **`hookSpecificOutput`** is stripped so the
 * agent-visible JSON matches Claude’s allowed **`hookSpecificOutput`** events.
 *
 * Individual subprocess hooks still validate with {@link hookOutputSchema} (`{}` is valid).
 */
const stopHookOutputRefinedSchema = z
  .looseObject({
    decision: z.enum(["approve", "block", "deny"]).optional(),
    resolution: z.enum(["human-required"]).optional(),
    hookSpecificOutput: z
      .looseObject({
        hookEventName: z.string().optional(),
        additionalContext: z.string().optional(),
        permissionDecision: z.enum(["allow", "deny", "ask"]).optional(),
        permissionDecisionReason: z.string().optional(),
        modifiedInput: z.record(z.string(), z.unknown()).optional(),
        updatedInput: z.record(z.string(), z.unknown()).optional(),
        decision: z.string().optional(),
      })
      .optional(),
    ok: z.boolean().optional(),
    continue: z.boolean().optional(),
    reason: z.string().optional(),
    stopReason: z.string().optional(),
    systemMessage: z.string().optional(),
    suppressOutput: z.boolean().optional(),
  })
  .refine((o) => stopHookOutputContinueValid(o), {
    message:
      "Stop dispatch output must set continue: true, or continue: false with stopReason, or decision block/deny",
  })
  .refine((o) => stopHookOutputBlockDecisionRequiresReason(o), {
    message:
      'When decision is "block" or "deny", reason is required (Claude Code Stop / SubagentStop)',
  })
  .refine((o) => stopHookOutputHasReasonOrStopReason(o), {
    message:
      "Stop dispatch output must include a non-empty reason or stopReason (additionalContext alone is not sufficient)",
  })

export const stopHookOutputSchema = stopHookOutputRefinedSchema

export type StopHookOutput = z.infer<typeof stopHookOutputSchema>

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
