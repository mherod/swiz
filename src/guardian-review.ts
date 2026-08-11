import { z } from "zod"
import type { JsonLike } from "./schemas.ts"
import { tryParseJsonLine } from "./utils/jsonl.ts"
import { escapeRegex } from "./utils/shell-patterns.ts"

export type SandboxAttemptEvidence =
  | "not-attempted"
  | "succeeded"
  | "permission-failed"
  | "failed"
  | "unknown"

export interface GuardianReviewContext {
  requested: true
  source: "codex-transcript"
  priorSandboxAttempt: SandboxAttemptEvidence
  recentGitAddGuardianDenialCount: number
}

interface CodexToolCall {
  callId: string
  escalated: boolean
  lineIndex: number
  outputAttributable: boolean
}

const jsonLikeSchema: z.ZodType<JsonLike> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonLikeSchema),
    z.record(z.string(), jsonLikeSchema),
  ])
)

const codexResponseItemSchema = z.looseObject({
  timestamp: z.union([z.string(), z.number()]).optional(),
  type: z.literal("response_item"),
  payload: z.looseObject({
    type: z.enum([
      "function_call",
      "custom_tool_call",
      "function_call_output",
      "custom_tool_call_output",
    ]),
    name: z.string().optional(),
    input: jsonLikeSchema.optional(),
    arguments: jsonLikeSchema.optional(),
    call_id: z.string().optional(),
    id: z.string().optional(),
    output: jsonLikeSchema.optional(),
  }),
})

const execCommandInputSchema = z.looseObject({
  cmd: z.string().optional(),
  command: z.string().optional(),
  sandbox_permissions: z.string().optional(),
})

const guardianReviewContextSchema = z.object({
  requested: z.literal(true),
  source: z.literal("codex-transcript"),
  priorSandboxAttempt: z.enum([
    "not-attempted",
    "succeeded",
    "permission-failed",
    "failed",
    "unknown",
  ]),
  recentGitAddGuardianDenialCount: z.int().nonnegative().default(0),
})

type CodexResponseItem = z.infer<typeof codexResponseItemSchema>
type CodexResponsePayload = CodexResponseItem["payload"]
type ExecCommandInput = z.infer<typeof execCommandInputSchema>

const ESCALATION_PROPERTY_RE =
  /(?:^|[,{]\s*)(?:["']sandbox_permissions["']|sandbox_permissions)\s*:\s*["']require_escalated["']/m
const PERMISSION_FAILURE_RE =
  /operation not permitted|permission denied|read-only file system|sandbox(?:ed)?\s+(?:denied|blocked|restriction)|network (?:is )?unreachable|could not resolve host|name or service not known/i
const SUCCESS_RE =
  /["']exit_code["']\s*:\s*0\b|(?:^|\n|\\n)\s*exit\s*=\s*0\b|(?:^|\n)[^\n]*(?:push|upload|write|command|operation) succeeded\b/im
const FAILURE_RE =
  /["']exit_code["']\s*:\s*[1-9]\d*\b|(?:^|\n|\\n)\s*exit\s*=\s*[1-9]\d*\b|process exited with code [1-9]\d*|script failed|(?:^|\n|\\n)\s*fatal:\s+/i
const TOOL_CALL_TYPES = new Set<CodexResponsePayload["type"]>(["function_call", "custom_tool_call"])
export const GIT_ADD_GUARDIAN_DENIAL_LIMIT = 3
export const GIT_ADD_GUARDIAN_DENIAL_WINDOW_MS = 60_000
export const GIT_ADD_GUARDIAN_DENIAL_MARKER = "Guardian review avoided: this `git add` retry"
const GIT_ADD_GUARDIAN_DENIAL_OUTPUT_PREFIX = `Script error:\nCommand blocked by PreToolUse hook: ${GIT_ADD_GUARDIAN_DENIAL_MARKER}`

function parseResponseItem(line: string): CodexResponseItem | null {
  const result = codexResponseItemSchema.safeParse(tryParseJsonLine(line))
  return result.success ? result.data : null
}

function parseToolInput(value: JsonLike | undefined): ExecCommandInput | null {
  const direct = execCommandInputSchema.safeParse(value)
  if (direct.success) return direct.data
  if (typeof value !== "string") return null
  try {
    const parsed = execCommandInputSchema.safeParse(JSON.parse(value))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

function isDirectExecCommand(name: string): boolean {
  return name === "exec_command" || name === "functions.exec_command"
}

function isExecWrapper(name: string): boolean {
  return name === "exec" || name === "functions.exec"
}

function wrapperReferencesCommand(code: string, command: string): boolean {
  if (!command) return false
  const serializedCommand = escapeRegex(JSON.stringify(command))
  const commandProperty = new RegExp(
    `(?:^|[{,]\\s*)(?:cmd|command|["']cmd["']|["']command["'])\\s*:\\s*${serializedCommand}(?=\\s*[,}])`,
    "m"
  )
  return commandProperty.test(code)
}

function directMatchingToolCall(
  payload: CodexResponsePayload,
  callId: string,
  lineIndex: number,
  command: string
): CodexToolCall | null {
  const rawInput = payload.type === "custom_tool_call" ? payload.input : payload.arguments
  const input = parseToolInput(rawInput)
  if (!input || (input.cmd ?? input.command ?? "") !== command) return null
  return {
    callId,
    escalated: input.sandbox_permissions === "require_escalated",
    lineIndex,
    outputAttributable: true,
  }
}

function wrapperMatchingToolCall(
  payload: CodexResponsePayload,
  callId: string,
  lineIndex: number,
  command: string
): CodexToolCall | null {
  const rawInput = payload.type === "custom_tool_call" ? payload.input : payload.arguments
  if (typeof rawInput !== "string" || !wrapperReferencesCommand(rawInput, command)) return null
  return {
    callId,
    escalated: ESCALATION_PROPERTY_RE.test(rawInput),
    lineIndex,
    outputAttributable:
      (rawInput.match(/\btools\.(?:functions\.)?exec_command\s*\(/g) ?? []).length === 1,
  }
}

function selectToolCallExtractor(name: string): typeof directMatchingToolCall | null {
  if (isDirectExecCommand(name)) return directMatchingToolCall
  return isExecWrapper(name) ? wrapperMatchingToolCall : null
}

function extractMatchingToolCall(
  line: string,
  lineIndex: number,
  command: string
): CodexToolCall | null {
  const payload = parseResponseItem(line)?.payload
  if (!payload || !TOOL_CALL_TYPES.has(payload.type)) return null

  const name = payload.name ?? ""
  const callId = payload.call_id ?? payload.id ?? ""
  const extractCall = selectToolCallExtractor(name)
  return callId && extractCall ? extractCall(payload, callId, lineIndex, command) : null
}

function parseTimestampMs(value: string | number | undefined): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value !== "string" || !value.trim()) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function extractOutputRecord(line: string): [string, string, number | null] | null {
  const item = parseResponseItem(line)
  const payload = item?.payload
  if (
    !payload ||
    (payload.type !== "function_call_output" && payload.type !== "custom_tool_call_output") ||
    !payload.call_id
  ) {
    return null
  }
  try {
    const output = payload.output ?? ""
    return [
      payload.call_id,
      `${JSON.stringify(output)}\n${flattenOutputText(output)}`,
      parseTimestampMs(item.timestamp),
    ]
  } catch {
    return [payload.call_id, String(payload.output ?? ""), parseTimestampMs(item.timestamp)]
  }
}

function flattenOutputText(value: JsonLike): string {
  if (value === null) return ""
  if (Array.isArray(value)) return value.map(flattenOutputText).join("\n")
  if (typeof value === "object") return Object.values(value).map(flattenOutputText).join("\n")
  return String(value)
}

function collectOutputText(lines: string[]): Map<string, string> {
  const outputs = new Map<string, string>()
  for (const line of lines) {
    const record = extractOutputRecord(line)
    if (record) outputs.set(record[0], record[1])
  }
  return outputs
}

function isGitAddGuardianDenialOutput(payload: CodexResponsePayload): boolean {
  const blocks = Array.isArray(payload.output) ? payload.output : [payload.output ?? ""]
  return blocks.some((block) => {
    const text =
      block && typeof block === "object" && !Array.isArray(block) && typeof block.text === "string"
        ? block.text
        : flattenOutputText(block)
    return text.startsWith(GIT_ADD_GUARDIAN_DENIAL_OUTPUT_PREFIX)
  })
}

function countRecentGitAddGuardianDenials(lines: string[], nowMs: number): number {
  let count = 0
  for (const line of lines) {
    const item = parseResponseItem(line)
    const payload = item?.payload
    if (
      !payload ||
      (payload.type !== "function_call_output" && payload.type !== "custom_tool_call_output") ||
      !isGitAddGuardianDenialOutput(payload)
    ) {
      continue
    }

    const timestampMs = parseTimestampMs(item.timestamp)
    if (
      timestampMs !== null &&
      timestampMs >= nowMs - GIT_ADD_GUARDIAN_DENIAL_WINDOW_MS &&
      timestampMs <= nowMs
    ) {
      count++
    }
  }
  return count
}

function classifyPriorSandboxAttempt(output: string | undefined): SandboxAttemptEvidence {
  if (!output) return "unknown"
  if (SUCCESS_RE.test(output)) return "succeeded"
  if (PERMISSION_FAILURE_RE.test(output) && FAILURE_RE.test(output)) return "permission-failed"
  if (FAILURE_RE.test(output)) return "failed"
  return "unknown"
}

/** Correlate the current shell command with Codex's latest escalation-bearing tool call. */
export function detectGuardianReviewRequest(
  sessionLines: string[],
  command: string,
  nowMs: number = Date.now()
): GuardianReviewContext | null {
  const matchingCalls: CodexToolCall[] = []
  for (let i = 0; i < sessionLines.length; i++) {
    const call = extractMatchingToolCall(sessionLines[i] ?? "", i, command)
    if (call) matchingCalls.push(call)
  }

  const current = matchingCalls.at(-1)
  if (!current?.escalated) return null

  const previousSandboxed = matchingCalls
    .slice(0, -1)
    .reverse()
    .find(
      (call) => !call.escalated && call.outputAttributable && call.lineIndex < current.lineIndex
    )
  const priorSandboxAttempt = previousSandboxed
    ? classifyPriorSandboxAttempt(collectOutputText(sessionLines).get(previousSandboxed.callId))
    : "not-attempted"

  return {
    requested: true,
    source: "codex-transcript",
    priorSandboxAttempt,
    recentGitAddGuardianDenialCount: countRecentGitAddGuardianDenials(sessionLines, nowMs),
  }
}

export function enrichPayloadWithGuardianReview(
  payload: object,
  summary: { sessionLines?: string[] } | null,
  nowMs: number = Date.now()
): GuardianReviewContext | null {
  Reflect.deleteProperty(payload, "_guardianReview")
  const toolInput = execCommandInputSchema.safeParse(Reflect.get(payload, "tool_input"))
  const command = toolInput.success ? (toolInput.data.command ?? toolInput.data.cmd ?? "") : ""
  if (!command || !summary?.sessionLines) return null

  const context = detectGuardianReviewRequest(summary.sessionLines, command, nowMs)
  if (context) Reflect.set(payload, "_guardianReview", context)
  return context
}

export function getGuardianReviewContext(input: object): GuardianReviewContext | null {
  const parsed = guardianReviewContextSchema.safeParse(Reflect.get(input, "_guardianReview"))
  return parsed.success ? parsed.data : null
}
