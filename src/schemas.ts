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

// ─── agent-hook-schemas package imports ─────────────────────────────────────
// Canonical upstream Zod schemas for hook stdin/stdout across Claude, Codex,
// Gemini, and Cursor. Local schemas that need NFKC transforms or custom
// refinements extend or wrap these; pure-validation schemas re-export directly.
import {
  ParseEditToolInput,
  ParseWriteToolInput,
  ConfigChangeInputSchema as PkgConfigChangeInputSchema,
  CwdChangedInputSchema as PkgCwdChangedInputSchema,
  ElicitationInputSchema as PkgElicitationInputSchema,
  ElicitationResultInputSchema as PkgElicitationResultInputSchema,
  FileChangedInputSchema as PkgFileChangedInputSchema,
  HookInputBaseSchema as PkgHookInputBaseSchema,
  InstructionsLoadedInputSchema as PkgInstructionsLoadedInputSchema,
  NotificationInputSchema as PkgNotificationInputSchema,
  PermissionRequestInputSchema as PkgPermissionRequestInputSchema,
  PostCompactInputSchema as PkgPostCompactInputSchema,
  PostToolUseFailureInputSchema as PkgPostToolUseFailureInputSchema,
  PostToolUseInputSchema as PkgPostToolUseInputSchema,
  PreCompactInputSchema as PkgPreCompactInputSchema,
  SessionEndInputSchema as PkgSessionEndInputSchema,
  SessionStartInputSchema as PkgSessionStartInputSchema,
  StopFailureInputSchema as PkgStopFailureInputSchema,
  StopInputSchema as PkgStopInputSchema,
  SubagentStartInputSchema as PkgSubagentStartInputSchema,
  SubagentStopInputSchema as PkgSubagentStopInputSchema,
  TaskCreatedInputSchema as PkgTaskCreatedInputSchema,
  TeammateIdleInputSchema as PkgTeammateIdleInputSchema,
  UserPromptSubmitInputSchema as PkgUserPromptSubmitInputSchema,
  WorktreeCreateInputSchema as PkgWorktreeCreateInputSchema,
  WorktreeRemoveInputSchema as PkgWorktreeRemoveInputSchema,
  ToolInputCommand,
  ToolInputFilePath,
} from "agent-hook-schemas/claude"
import {
  CodexHookInputBaseSchema as PkgCodexHookInputBaseSchema,
  CodexPostToolUseInputSchema as PkgCodexPostToolUseInputSchema,
  CodexPreToolUseInputSchema as PkgCodexPreToolUseInputSchema,
  CodexSessionStartInputSchema as PkgCodexSessionStartInputSchema,
  CodexStopInputSchema as PkgCodexStopInputSchema,
  CodexUserPromptSubmitInputSchema as PkgCodexUserPromptSubmitInputSchema,
} from "agent-hook-schemas/codex"
import { ToolCallCoreSchema } from "agent-hook-schemas/common"
import {
  GeminiAfterAgentInputSchema as PkgGeminiAfterAgentInputSchema,
  GeminiAfterModelInputSchema as PkgGeminiAfterModelInputSchema,
  GeminiAfterToolInputSchema as PkgGeminiAfterToolInputSchema,
  GeminiBeforeAgentInputSchema as PkgGeminiBeforeAgentInputSchema,
  GeminiBeforeModelInputSchema as PkgGeminiBeforeModelInputSchema,
  GeminiBeforeToolInputSchema as PkgGeminiBeforeToolInputSchema,
  GeminiBeforeToolSelectionInputSchema as PkgGeminiBeforeToolSelectionInputSchema,
  GeminiHookCommandOutputSchema as PkgGeminiHookCommandOutputSchema,
  GeminiNotificationInputSchema as PkgGeminiNotificationInputSchema,
  GeminiPreCompressInputSchema as PkgGeminiPreCompressInputSchema,
  GeminiSessionEndInputSchema as PkgGeminiSessionEndInputSchema,
  GeminiSessionStartInputSchema as PkgGeminiSessionStartInputSchema,
} from "agent-hook-schemas/gemini"
import { z } from "zod"
import { isJsonLikeRecord } from "./utils/hook-json-helpers.ts"
import { getHookSpecificOutput } from "./utils/hook-specific-output.ts"

// Re-export typed tool input parsers for direct consumer use
export { ParseEditToolInput, ParseWriteToolInput, ToolInputCommand, ToolInputFilePath }

/**
 * Make all fields of a `z.looseObject` schema optional.
 * The upstream package marks some fields as required (`session_id`, `cwd`),
 * but swiz uses `.optional()` everywhere for resilient parsing — hooks must
 * tolerate missing fields rather than rejecting payloads.
 */
function allOptional<T extends z.ZodObject>(schema: T) {
  return schema.partial().catchall(z.unknown())
}

// ─── Primitive field schemas ──────────────────────────────────────────────────
// Single-field building blocks reused across every hook envelope.
// Use as `CwdSchema.optional()` inside `z.looseObject({})`.
// These remain `z.string()` (not enums) for forward compatibility — swiz hooks
// must accept unknown event names and permission modes from future agent versions.

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
    const out: Record<string, unknown> = {}
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
 * Field set derived from `HookInputBaseSchema` (`agent-hook-schemas/claude`) via
 * `.partial().shape` destructuring — confirms field names match the upstream spec.
 * Wrapped in `z.looseObject` (not `allOptional()`) to preserve clean TypeScript
 * types for downstream `.extend().transform()` chains. `hook_event_name` and
 * `permission_mode` are overridden to `z.string()` for forward compatibility.
 */
export const hookBaseSchema = z.looseObject({
  ...PkgHookInputBaseSchema.partial().shape,
  hook_event_name: HookEventNameSchema.optional(),
  // Override package enum — swiz must accept unknown permission modes
  permission_mode: PermissionModeSchema.optional(),
})
export type HookBase = z.infer<typeof hookBaseSchema>

/**
 * Shared envelope fields present on every tool-use hook event.
 * Extended by `fileEditHookInputSchema`, `shellHookInputSchema`,
 * `toolHookInputSchema`, and `skillToolInputSchema`.
 * Tool fields derived from `ToolCallCoreSchema` (`agent-hook-schemas/common`).
 */
const toolHookBaseObjectSchema = hookBaseSchema.extend({
  ...ToolCallCoreSchema.partial().shape,
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

const nfkcSchema = z.string().transform(nfkc)

const shellHookToolInputSchema = z
  .looseObject({
    command: nfkcSchema,
  })
  .optional()

/**
 * Shell tool_input payload — used by hooks that inspect shell commands.
 * Covers Bash, Shell, run_shell_command and equivalent cross-agent tools.
 */
export const shellHookInputSchema = toolHookBaseObjectSchema.extend({
  tool_input: shellHookToolInputSchema,
})

export type ShellHookInput = z.infer<typeof shellHookInputSchema>

/**
 * Base PreToolUse / PostToolUse hook input envelope.
 * Mirrors the `ToolHookInput` interface in hook-utils.ts with runtime validation.
 */
export const toolHookInputSchema = toolHookBaseObjectSchema.transform((val) => {
  if (val.tool_input) {
    val.tool_input = nfkcDeep(val.tool_input) as Record<string, unknown>
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
 * Field set derived from `PostToolUseInputSchema` (`agent-hook-schemas/claude`) via
 * `.partial().shape` — uses `z.looseObject` for clean types in `.transform()` chain.
 */
export const postToolUseHookInputSchema = z
  .looseObject({
    ...PkgPostToolUseInputSchema.partial().shape,
    // Override package enum — swiz must accept unknown permission modes
    permission_mode: PermissionModeSchema.optional(),
    // Override package literal — allow PostToolUseFailure events routed through postToolUse
    hook_event_name: HookEventNameSchema.optional(),
    // Override package JsonObject — MCP tools may return arrays, strings, or null
    tool_response: z.unknown().optional(),
  })
  .transform((val) => {
    if (val.tool_input) {
      val.tool_input = nfkcDeep(val.tool_input) as Record<string, unknown>
    }
    return val
  })

export type PostToolUseHookInput = z.infer<typeof postToolUseHookInputSchema>

/**
 * Stop / SubagentStop hook input envelope.
 * Mirrors the `StopHookInput` interface in hook-utils.ts with runtime validation.
 * Backed by `StopInputSchema` from `agent-hook-schemas/claude`.
 */
export const stopHookInputSchema = allOptional(PkgStopInputSchema)

export type StopHookInput = z.infer<typeof stopHookInputSchema>

/**
 * PreCompact hook input envelope (and legacy session-shaped events).
 * For SessionStart, prefer {@link sessionStartHookInputSchema}.
 * For UserPromptSubmit, prefer {@link userPromptSubmitHookInputSchema}.
 * Backed by `PreCompactInputSchema` from `agent-hook-schemas/claude`.
 */
export const sessionHookInputSchema = allOptional(PkgPreCompactInputSchema)

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

// ─── Updated existing schemas with missing fields ───────────────────────────

/**
 * Stop / SubagentStop hook input envelope (extended).
 * Backed by `SubagentStopInputSchema` from `agent-hook-schemas/claude` which
 * includes `last_assistant_message`, `agent_transcript_path`, `agent_id`, `agent_type`.
 */
export const stopHookExtendedInputSchema = allOptional(PkgSubagentStopInputSchema)

export type StopHookExtendedInput = z.infer<typeof stopHookExtendedInputSchema>

/**
 * SessionStart hook input envelope.
 * Backed by `SessionStartInputSchema` from `agent-hook-schemas/claude`.
 */
export const sessionStartHookInputSchema = allOptional(PkgSessionStartInputSchema)

export type SessionStartHookInput = z.infer<typeof sessionStartHookInputSchema>

/**
 * UserPromptSubmit hook input envelope.
 * Backed by `UserPromptSubmitInputSchema` from `agent-hook-schemas/claude`.
 */
export const userPromptSubmitHookInputSchema = allOptional(PkgUserPromptSubmitInputSchema)

export type UserPromptSubmitHookInput = z.infer<typeof userPromptSubmitHookInputSchema>

// ─── New hook event input schemas ───────────────────────────────────────────

/**
 * Notification hook input envelope.
 * Backed by `NotificationInputSchema` from `agent-hook-schemas/claude`.
 */
export const notificationHookInputSchema = allOptional(PkgNotificationInputSchema)

export type NotificationHookInput = z.infer<typeof notificationHookInputSchema>

/**
 * PermissionRequest hook input envelope.
 * Backed by `PermissionRequestInputSchema` from `agent-hook-schemas/claude`.
 */
export const permissionRequestHookInputSchema = allOptional(PkgPermissionRequestInputSchema)

export type PermissionRequestHookInput = z.infer<typeof permissionRequestHookInputSchema>

/**
 * PostToolUseFailure hook input envelope.
 * Backed by `PostToolUseFailureInputSchema` from `agent-hook-schemas/claude`.
 */
export const postToolUseFailureHookInputSchema = allOptional(PkgPostToolUseFailureInputSchema)

export type PostToolUseFailureHookInput = z.infer<typeof postToolUseFailureHookInputSchema>

/**
 * SubagentStart hook input envelope.
 * Backed by `SubagentStartInputSchema` from `agent-hook-schemas/claude`.
 */
export const subagentStartHookInputSchema = allOptional(PkgSubagentStartInputSchema)

export type SubagentStartHookInput = z.infer<typeof subagentStartHookInputSchema>

/**
 * TaskCreated / TaskCompleted hook input envelope.
 * Backed by `TaskCreatedInputSchema` from `agent-hook-schemas/claude`.
 */
export const taskEventHookInputSchema = allOptional(PkgTaskCreatedInputSchema)

export type TaskEventHookInput = z.infer<typeof taskEventHookInputSchema>

/**
 * TeammateIdle hook input envelope.
 * Backed by `TeammateIdleInputSchema` from `agent-hook-schemas/claude`.
 */
export const teammateIdleHookInputSchema = allOptional(PkgTeammateIdleInputSchema)

export type TeammateIdleHookInput = z.infer<typeof teammateIdleHookInputSchema>

/**
 * StopFailure hook input envelope.
 * Backed by `StopFailureInputSchema` from `agent-hook-schemas/claude`.
 */
export const stopFailureHookInputSchema = allOptional(PkgStopFailureInputSchema)

export type StopFailureHookInput = z.infer<typeof stopFailureHookInputSchema>

/**
 * InstructionsLoaded hook input envelope.
 * Backed by `InstructionsLoadedInputSchema` from `agent-hook-schemas/claude`.
 */
export const instructionsLoadedHookInputSchema = allOptional(PkgInstructionsLoadedInputSchema)

export type InstructionsLoadedHookInput = z.infer<typeof instructionsLoadedHookInputSchema>

/**
 * ConfigChange hook input envelope.
 * Backed by `ConfigChangeInputSchema` from `agent-hook-schemas/claude`.
 */
export const configChangeHookInputSchema = allOptional(PkgConfigChangeInputSchema)

export type ConfigChangeHookInput = z.infer<typeof configChangeHookInputSchema>

/**
 * CwdChanged hook input envelope.
 * Backed by `CwdChangedInputSchema` from `agent-hook-schemas/claude`.
 */
export const cwdChangedHookInputSchema = allOptional(PkgCwdChangedInputSchema)

export type CwdChangedHookInput = z.infer<typeof cwdChangedHookInputSchema>

/**
 * FileChanged hook input envelope.
 * Backed by `FileChangedInputSchema` from `agent-hook-schemas/claude`.
 */
export const fileChangedHookInputSchema = allOptional(PkgFileChangedInputSchema)

export type FileChangedHookInput = z.infer<typeof fileChangedHookInputSchema>

/**
 * WorktreeCreate hook input envelope.
 * Backed by `WorktreeCreateInputSchema` from `agent-hook-schemas/claude`.
 */
export const worktreeCreateHookInputSchema = allOptional(PkgWorktreeCreateInputSchema)

export type WorktreeCreateHookInput = z.infer<typeof worktreeCreateHookInputSchema>

/**
 * WorktreeRemove hook input envelope.
 * Backed by `WorktreeRemoveInputSchema` from `agent-hook-schemas/claude`.
 */
export const worktreeRemoveHookInputSchema = allOptional(PkgWorktreeRemoveInputSchema)

export type WorktreeRemoveHookInput = z.infer<typeof worktreeRemoveHookInputSchema>

/**
 * PostCompact hook input envelope.
 * Backed by `PostCompactInputSchema` from `agent-hook-schemas/claude`.
 */
export const postCompactHookInputSchema = allOptional(PkgPostCompactInputSchema)

export type PostCompactHookInput = z.infer<typeof postCompactHookInputSchema>

/**
 * Elicitation hook input envelope.
 * Backed by `ElicitationInputSchema` from `agent-hook-schemas/claude`.
 */
export const elicitationHookInputSchema = allOptional(PkgElicitationInputSchema)

export type ElicitationHookInput = z.infer<typeof elicitationHookInputSchema>

/**
 * ElicitationResult hook input envelope.
 * Backed by `ElicitationResultInputSchema` from `agent-hook-schemas/claude`.
 */
export const elicitationResultHookInputSchema = allOptional(PkgElicitationResultInputSchema)

export type ElicitationResultHookInput = z.infer<typeof elicitationResultHookInputSchema>

/**
 * SessionEnd hook input envelope.
 * Backed by `SessionEndInputSchema` from `agent-hook-schemas/claude`.
 */
export const sessionEndHookInputSchema = allOptional(PkgSessionEndInputSchema)

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
 * Backed by `GeminiSessionStartInputSchema` from `agent-hook-schemas/gemini`.
 */
export const geminiSessionStartInputSchema = allOptional(PkgGeminiSessionStartInputSchema)

export type GeminiSessionStartInput = z.infer<typeof geminiSessionStartInputSchema>

/**
 * Gemini SessionEnd hook input envelope.
 * Backed by `GeminiSessionEndInputSchema` from `agent-hook-schemas/gemini`.
 */
export const geminiSessionEndInputSchema = allOptional(PkgGeminiSessionEndInputSchema)

export type GeminiSessionEndInput = z.infer<typeof geminiSessionEndInputSchema>

/**
 * Gemini BeforeAgent hook input envelope.
 * Backed by `GeminiBeforeAgentInputSchema` from `agent-hook-schemas/gemini`.
 */
export const geminiBeforeAgentInputSchema = allOptional(PkgGeminiBeforeAgentInputSchema)

export type GeminiBeforeAgentInput = z.infer<typeof geminiBeforeAgentInputSchema>

/**
 * Gemini AfterAgent hook input envelope.
 * Backed by `GeminiAfterAgentInputSchema` from `agent-hook-schemas/gemini`.
 */
export const geminiAfterAgentInputSchema = allOptional(PkgGeminiAfterAgentInputSchema)

export type GeminiAfterAgentInput = z.infer<typeof geminiAfterAgentInputSchema>

/**
 * Gemini BeforeModel hook input envelope.
 * Backed by `GeminiBeforeModelInputSchema` from `agent-hook-schemas/gemini`.
 */
export const geminiBeforeModelInputSchema = allOptional(PkgGeminiBeforeModelInputSchema)

export type GeminiBeforeModelInput = z.infer<typeof geminiBeforeModelInputSchema>

/**
 * Gemini AfterModel hook input envelope.
 * Backed by `GeminiAfterModelInputSchema` from `agent-hook-schemas/gemini`.
 */
export const geminiAfterModelInputSchema = allOptional(PkgGeminiAfterModelInputSchema)

export type GeminiAfterModelInput = z.infer<typeof geminiAfterModelInputSchema>

/**
 * Gemini BeforeToolSelection hook input envelope.
 * Backed by `GeminiBeforeToolSelectionInputSchema` from `agent-hook-schemas/gemini`.
 */
export const geminiBeforeToolSelectionInputSchema = allOptional(
  PkgGeminiBeforeToolSelectionInputSchema
)

export type GeminiBeforeToolSelectionInput = z.infer<typeof geminiBeforeToolSelectionInputSchema>

/**
 * Gemini BeforeTool hook input envelope.
 * Fires before a tool executes. `matcher` is regex against tool name.
 * Can block tool or rewrite arguments.
 * Derived from `GeminiBeforeToolInputSchema` (`agent-hook-schemas/gemini`) + NFKC.
 */
export const geminiBeforeToolInputSchema = allOptional(PkgGeminiBeforeToolInputSchema).transform(
  (val) => {
    if (val.tool_input) {
      val.tool_input = nfkcDeep(val.tool_input) as Record<string, unknown>
    }
    return val
  }
)

export type GeminiBeforeToolInput = z.infer<typeof geminiBeforeToolInputSchema>

/**
 * Gemini AfterTool hook input envelope.
 * Fires after a tool executes. Can block result or add context.
 * `matcher` is regex against tool name.
 * Derived from `GeminiAfterToolInputSchema` (`agent-hook-schemas/gemini`) + NFKC.
 */
export const geminiAfterToolInputSchema = allOptional(PkgGeminiAfterToolInputSchema).transform(
  (val) => {
    if (val.tool_input) {
      val.tool_input = nfkcDeep(val.tool_input) as Record<string, unknown>
    }
    return val
  }
)

export type GeminiAfterToolInput = z.infer<typeof geminiAfterToolInputSchema>

/**
 * Gemini PreCompress hook input envelope.
 * Backed by `GeminiPreCompressInputSchema` from `agent-hook-schemas/gemini`.
 */
export const geminiPreCompressInputSchema = allOptional(PkgGeminiPreCompressInputSchema)

export type GeminiPreCompressInput = z.infer<typeof geminiPreCompressInputSchema>

/**
 * Gemini Notification hook input envelope.
 * Derived from `GeminiNotificationInputSchema` (`agent-hook-schemas/gemini`) via
 * `allOptional()`, with `notification_type` overridden to `z.string()` — the package
 * restricts it to enum `"ToolPermission"`, but swiz accepts any string for forward compat.
 */
export const geminiNotificationInputSchema = allOptional(PkgGeminiNotificationInputSchema).extend({
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
 * Derived from `GeminiHookCommandOutputSchema` (`agent-hook-schemas/gemini`) which
 * covers decision, flow-control, and hookSpecificOutput fields. Local refinement
 * ensures at least one known control field is present (empty `{}` rejected).
 */
export const geminiHookOutputSchema = PkgGeminiHookCommandOutputSchema.refine(
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
 * Base input fields for Codex hook envelopes.
 * Derived from `CodexHookInputBaseSchema` (`agent-hook-schemas/codex`).
 * Codex uses nullable `transcript_path` (null when no transcript exists).
 */
const codexHookBaseSchema = allOptional(PkgCodexHookInputBaseSchema)

export const codexCommonInputSchema = codexHookBaseSchema

export type CodexCommonInput = z.infer<typeof codexCommonInputSchema>

/**
 * Codex SessionStart hook input envelope.
 * Backed by `CodexSessionStartInputSchema` from `agent-hook-schemas/codex`.
 */
export const codexSessionStartInputSchema = allOptional(PkgCodexSessionStartInputSchema)

export type CodexSessionStartInput = z.infer<typeof codexSessionStartInputSchema>

/**
 * Codex PreToolUse hook input envelope.
 * Derived from `CodexPreToolUseInputSchema` (`agent-hook-schemas/codex`) + NFKC.
 * Currently only fires for `Bash` tool. Includes `turn_id` and `tool_use_id`.
 */
export const codexPreToolUseInputSchema = allOptional(PkgCodexPreToolUseInputSchema).transform(
  (val) => {
    if (val.tool_input) {
      val.tool_input = nfkcDeep(val.tool_input) as Record<string, unknown>
    }
    return val
  }
)

export type CodexPreToolUseInput = z.infer<typeof codexPreToolUseInputSchema>

/**
 * Codex PostToolUse hook input envelope.
 * Derived from `CodexPostToolUseInputSchema` (`agent-hook-schemas/codex`) + NFKC.
 * Currently only fires for `Bash` tool. Includes `tool_response`.
 */
export const codexPostToolUseInputSchema = allOptional(PkgCodexPostToolUseInputSchema).transform(
  (val) => {
    if (val.tool_input) {
      val.tool_input = nfkcDeep(val.tool_input) as Record<string, unknown>
    }
    return val
  }
)

export type CodexPostToolUseInput = z.infer<typeof codexPostToolUseInputSchema>

/**
 * Codex UserPromptSubmit hook input envelope.
 * Backed by `CodexUserPromptSubmitInputSchema` from `agent-hook-schemas/codex`.
 */
export const codexUserPromptSubmitInputSchema = allOptional(PkgCodexUserPromptSubmitInputSchema)

export type CodexUserPromptSubmitInput = z.infer<typeof codexUserPromptSubmitInputSchema>

/**
 * Codex Stop hook input envelope.
 * Backed by `CodexStopInputSchema` from `agent-hook-schemas/codex`.
 */
export const codexStopInputSchema = allOptional(PkgCodexStopInputSchema)

export type CodexStopInput = z.infer<typeof codexStopInputSchema>

/**
 * Codex hook output envelope.
 * Supports common output fields (`continue`, `stopReason`, `systemMessage`,
 * `suppressOutput`) plus `decision`/`reason` and `hookSpecificOutput`.
 * Alternative blocking: exit code 2 + reason on stderr.
 * Kept local — package per-event wire schemas are strict (`additionalProperties: false`),
 * swiz needs loose validation with the control-field refinement.
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
        const hso = getHookSpecificOutput(o as Record<string, unknown>)
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
function stopHookOutputHasReasonOrStopReason(o: Record<string, unknown>): boolean {
  const r = typeof o.reason === "string" && o.reason.trim()
  const s = typeof o.stopReason === "string" && o.stopReason.trim()
  return Boolean(r || s)
}

function stopHookOutputHasBlockDecision(o: Record<string, unknown>): boolean {
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
function stopHookOutputContinueValid(o: Record<string, unknown>): boolean {
  if (o.continue === false) {
    return typeof o.stopReason === "string" && o.stopReason.trim().length > 0
  }
  if (o.continue === true) return true
  return stopHookOutputHasBlockDecision(o)
}

/** Stop / SubagentStop: `decision: "block"` / `"deny"` requires **`reason`** (not `stopReason` alone). */
function stopHookOutputBlockDecisionRequiresReason(o: Record<string, unknown>): boolean {
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
