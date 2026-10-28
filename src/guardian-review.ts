import { z } from "zod"
import type { JsonLike } from "./schemas.ts"
import { tryParseJsonLine } from "./utils/jsonl.ts"
import { parseTimestampMs } from "./utils/timestamp.ts"

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

interface SandboxOutputEvidence {
  text: string
  exitCodes: number[]
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

const WRAPPER_TOKENS_RE =
  /\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|[\w$]+|[^\s]/g
const PERMISSION_FAILURE_RE =
  /operation not permitted|permission denied|read-only file system|sandbox(?:ed)?\s+(?:denied|blocked|restriction)|network (?:is )?unreachable|could not resolve host|name or service not known/i
const OS_PERMISSION_ERROR_RE =
  /(?:^|\n|\\n)\s*(?:error:\s*)?(?:EPERM|EACCES)(?=\s*(?::|,|$))|\b(?:EPERM|EACCES):\s|\b(?:code|errno)\s*[:=]\s*["']?(?:EPERM|EACCES)\b/im
const SUCCESS_RE =
  /["']exit_code["']\s*:\s*0\b|(?:^|\n|\\n)\s*exit\s*=\s*0\b|(?:^|\n)[^\n]*(?:push|upload|write|command|operation) succeeded\b/im
const FAILURE_RE =
  /["']exit_code["']\s*:\s*[1-9]\d*\b|(?:^|\n|\\n)\s*exit\s*=\s*[1-9]\d*\b|process exited with code [1-9]\d*|script failed|(?:^|\n|\\n)\s*fatal:\s+/i
const TOOL_CALL_TYPES = new Set<CodexResponsePayload["type"]>(["function_call", "custom_tool_call"])
export const GIT_ADD_GUARDIAN_DENIAL_LIMIT = 3
export const GIT_ADD_GUARDIAN_DENIAL_MARKER = "Guardian review avoided: this `git add` retry"
/** Code literals survive both hook voice variation and final-envelope humanising. */
export const GIT_ADD_GUARDIAN_DENIAL_TOKEN = "`swiz:guardian-git-add-denial`"
const PRE_TOOL_USE_DENIAL_OUTPUT_PREFIX = "Script error:\nCommand blocked by PreToolUse hook: "
const MAX_ENCODED_OUTPUT_DEPTH = 2

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

function wrapperObjectEnd(tokens: string[], start: number): number {
  let depth = 0
  for (let index = start; index < tokens.length; index++) {
    if (tokens[index] === "{") depth++
    if (tokens[index] === "}" && --depth === 0) return index
  }
  return -1
}

function wrapperJsonToken(token: string, next: string | undefined): string {
  if (/^['`]/.test(token)) {
    /** Dynamic strings and JavaScript-only escapes cannot establish a command. */
    if (token.includes("${") || /\\[^\\'`]/.test(token)) return token
    return JSON.stringify(token.slice(1, -1).replace(/\\([\\'`])/g, "$1"))
  }
  return /^[a-zA-Z_$][\w$]*$/.test(token) && next === ":" ? JSON.stringify(token) : token
}

function wrapperCallObjectStart(tokens: string[], index: number): number {
  if (tokens[index] !== "tools" || tokens[index - 1] === ".") return -1
  const prefix = tokens.slice(index, index + 6).join("")
  if (prefix.startsWith("tools.functions.exec_command(")) return index + 6
  return prefix.startsWith("tools.exec_command(") ? index + 4 : -1
}

function wrapperLiteralInput(tokens: string[], start: number): ExecCommandInput | null {
  const end = tokens[start] === "{" ? wrapperObjectEnd(tokens, start) : -1
  if (end < 0 || tokens[end + 1] !== ")") return null
  const json = tokens
    .slice(start, end + 1)
    .filter((token, offset, all) => token !== "," || !["}", "]"].includes(all[offset + 1] ?? ""))
    .map((token, offset, all) => wrapperJsonToken(token, all[offset + 1]))
    .join("")
  return parseToolInput(json)
}

/** Read literal call arguments only; never execute transcript code or infer dynamic values. */
function wrapperExecInputs(code: string): Array<ExecCommandInput | null> {
  const tokens = (code.match(WRAPPER_TOKENS_RE) ?? []).filter(
    (token) => !/^\/(?:\/|\*)/.test(token)
  )
  const inputs: Array<ExecCommandInput | null> = []
  for (let index = 0; index < tokens.length; index++) {
    const start = wrapperCallObjectStart(tokens, index)
    if (start >= 0) inputs.push(wrapperLiteralInput(tokens, start))
  }
  return inputs
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
  if (typeof rawInput !== "string" || !command) return null
  const inputs = wrapperExecInputs(rawInput)
  const matching = inputs.filter((input) => (input?.cmd ?? input?.command) === command)
  if (matching.length !== 1) return null
  return {
    callId,
    escalated: matching[0]?.sandbox_permissions === "require_escalated",
    lineIndex,
    outputAttributable: inputs.length === 1,
  }
}

function selectToolCallExtractor(name: string): typeof directMatchingToolCall | null {
  if (isDirectExecCommand(name)) return directMatchingToolCall
  return isExecWrapper(name) ? wrapperMatchingToolCall : null
}

function shellCallMetadata(line: string): {
  payload: CodexResponsePayload
  callId: string
  extractCall: typeof directMatchingToolCall
} | null {
  const payload = parseResponseItem(line)?.payload
  if (!payload || !TOOL_CALL_TYPES.has(payload.type)) return null
  const extractCall = selectToolCallExtractor(payload.name ?? "")
  const callId = payload.call_id ?? payload.id ?? ""
  return extractCall && callId ? { payload, callId, extractCall } : null
}

function collectMatchingToolCalls(
  lines: string[],
  command: string
): { calls: CodexToolCall[]; latestCallId: string } {
  const calls: CodexToolCall[] = []
  let latestCallId = ""
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const metadata = shellCallMetadata(lines[lineIndex] ?? "")
    if (!metadata) continue
    const { payload, callId, extractCall } = metadata
    latestCallId = callId
    const call = extractCall(payload, callId, lineIndex, command)
    if (call) calls.push(call)
  }
  return { calls, latestCallId }
}

function parseExitCode(value: JsonLike): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value
  if (typeof value !== "string" || !/^\d+$/.test(value.trim())) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}

function appendObjectOutputEvidence(
  value: Record<string, JsonLike>,
  textParts: string[],
  exitCodes: number[],
  encodedDepth: number
): void {
  for (const [key, item] of Object.entries(value)) {
    const exitCode = key === "exit_code" ? parseExitCode(item) : null
    if (exitCode !== null) exitCodes.push(exitCode)
    appendOutputEvidence(item, textParts, exitCodes, encodedDepth)
  }
}

function appendEncodedStringEvidence(
  value: string,
  textParts: string[],
  exitCodes: number[],
  encodedDepth: number
): void {
  if (encodedDepth >= MAX_ENCODED_OUTPUT_DEPTH) return
  try {
    const parsed = jsonLikeSchema.safeParse(JSON.parse(value))
    if (parsed.success && parsed.data !== value) {
      appendOutputEvidence(parsed.data, textParts, exitCodes, encodedDepth + 1)
    }
  } catch {
    // Historical transcript strings are commonly plain text rather than JSON.
  }
}

function appendOutputEvidence(
  value: JsonLike,
  textParts: string[],
  exitCodes: number[],
  encodedDepth = 0
): void {
  if (value === null) return
  if (Array.isArray(value)) {
    for (const item of value) appendOutputEvidence(item, textParts, exitCodes, encodedDepth)
    return
  }
  if (typeof value === "object") {
    appendObjectOutputEvidence(value, textParts, exitCodes, encodedDepth)
    return
  }

  textParts.push(String(value))
  if (typeof value === "string") {
    appendEncodedStringEvidence(value, textParts, exitCodes, encodedDepth)
  }
}

function buildOutputEvidence(value: JsonLike): SandboxOutputEvidence {
  const textParts: string[] = []
  const exitCodes: number[] = []
  appendOutputEvidence(value, textParts, exitCodes)
  return { text: textParts.join("\n"), exitCodes }
}

function extractOutputRecord(line: string): [string, SandboxOutputEvidence, number | null] | null {
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
    return [payload.call_id, buildOutputEvidence(output), parseTimestampMs(item.timestamp)]
  } catch {
    return [
      payload.call_id,
      { text: String(payload.output ?? ""), exitCodes: [] },
      parseTimestampMs(item.timestamp),
    ]
  }
}

function flattenOutputText(value: JsonLike): string {
  return buildOutputEvidence(value).text
}

function collectOutputEvidence(lines: string[]): Map<string, SandboxOutputEvidence> {
  const outputs = new Map<string, SandboxOutputEvidence>()
  for (const line of lines) {
    const record = extractOutputRecord(line)
    if (record) outputs.set(record[0], record[1])
  }
  return outputs
}

function isGitAddGuardianDenialOutput(payload: CodexResponsePayload): boolean {
  if (payload.type !== "function_call_output" && payload.type !== "custom_tool_call_output") {
    return false
  }
  const blocks = Array.isArray(payload.output) ? payload.output : [payload.output ?? ""]
  return blocks.some((block) => {
    const text =
      block && typeof block === "object" && !Array.isArray(block) && typeof block.text === "string"
        ? block.text
        : flattenOutputText(block)
    if (!text.startsWith(PRE_TOOL_USE_DENIAL_OUTPUT_PREFIX)) return false
    const reason = text.slice(PRE_TOOL_USE_DENIAL_OUTPUT_PREFIX.length)
    return (
      reason.includes(GIT_ADD_GUARDIAN_DENIAL_TOKEN) ||
      reason.startsWith(GIT_ADD_GUARDIAN_DENIAL_MARKER)
    )
  })
}

function countRecentGitAddGuardianDenials(
  lines: string[],
  matchingCalls: CodexToolCall[],
  nowMs: number
): number {
  const eligibleCalls = new Map(
    matchingCalls.filter((call) => call.outputAttributable).map((call) => [call.callId, call])
  )
  const deniedCalls = new Set<string>()
  for (const line of lines) {
    const output = eligibleGuardianOutput(line, eligibleCalls, nowMs)
    if (!output) continue
    const { call, payload } = output
    if (classifyPriorSandboxAttempt(buildOutputEvidence(payload.output ?? "")) === "succeeded") {
      deniedCalls.clear()
    } else if (call.escalated && isGitAddGuardianDenialOutput(payload)) {
      deniedCalls.add(call.callId)
    }
  }
  return deniedCalls.size
}

function eligibleGuardianOutput(
  line: string,
  calls: Map<string, CodexToolCall>,
  nowMs: number
): { call: CodexToolCall; payload: CodexResponsePayload } | null {
  const item = parseResponseItem(line)
  if (!item || TOOL_CALL_TYPES.has(item.payload.type)) return null
  const call = calls.get(item.payload.call_id ?? "")
  const timestampMs = parseTimestampMs(item.timestamp)
  if (!call || timestampMs === null || timestampMs > nowMs) return null
  return { call, payload: item.payload }
}

function classifyPriorSandboxAttempt(
  output: SandboxOutputEvidence | undefined
): SandboxAttemptEvidence {
  if (!output) return "unknown"
  const hasSuccessfulExit = output.exitCodes.includes(0)
  const hasFailedExit = output.exitCodes.some((code) => code > 0)
  const hasOsPermissionError = OS_PERMISSION_ERROR_RE.test(output.text)
  const hasPermissionFailure = PERMISSION_FAILURE_RE.test(output.text) || hasOsPermissionError
  const hasFailure = hasFailedExit || FAILURE_RE.test(output.text) || hasOsPermissionError

  if (hasSuccessfulExit || SUCCESS_RE.test(output.text)) return "succeeded"
  if (hasPermissionFailure && hasFailure) return "permission-failed"
  if (hasFailure) return "failed"
  return "unknown"
}

/** Correlate the current shell command with Codex's latest escalation-bearing tool call. */
export function detectGuardianReviewRequest(
  sessionLines: string[],
  command: string,
  nowMs: number = Date.now()
): GuardianReviewContext | null {
  const { calls: matchingCalls, latestCallId } = collectMatchingToolCalls(sessionLines, command)

  const current = matchingCalls.at(-1)
  if (!current?.escalated || current.callId !== latestCallId) return null

  const previousSandboxed = matchingCalls
    .slice(0, -1)
    .reverse()
    .find(
      (call) => !call.escalated && call.outputAttributable && call.lineIndex < current.lineIndex
    )
  const priorSandboxAttempt = previousSandboxed
    ? classifyPriorSandboxAttempt(collectOutputEvidence(sessionLines).get(previousSandboxed.callId))
    : "not-attempted"

  return {
    requested: true,
    source: "codex-transcript",
    priorSandboxAttempt,
    recentGitAddGuardianDenialCount: countRecentGitAddGuardianDenials(
      sessionLines.slice(0, current.lineIndex),
      matchingCalls.slice(0, -1),
      nowMs
    ),
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
