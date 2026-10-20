import type { HookCallback, Options } from "@anthropic-ai/claude-agent-sdk"
import { z } from "zod"
import { STOP_HOOK_GUIDANCE } from "./commands/install/agent-helpers.ts"
import { TMP_ROOT } from "./temp-paths.ts"

export const COMPLIANCE_SCENARIOS = [
  { id: "stop", description: "Complete a new action after a stop hook blocks completion" },
  { id: "pre-tool-use", description: "Correct a tool call after a hook denies it" },
] as const

export type ComplianceScenario = (typeof COMPLIANCE_SCENARIOS)[number]["id"]
export type ComplianceStatus = "pass" | "fail" | "inconclusive"
export const COMPLIANCE_TOOL = "mcp__swiz_compliance__record_evidence"
export const COMPLIANCE_SCOPE =
  "Controlled Claude SDK hooks with Swiz guidance; does not verify installed hooks or an existing host session."
const receiptSchema = z.object({ token: z.string() })

export interface ComplianceOptions {
  scenario?: ComplianceScenario
  model?: string
  timeoutMs: number
}

export interface ComplianceOutcome {
  completed: boolean
  detail?: string
  sessionId?: string
}

export interface ComplianceSession {
  prompt: string
  options: Options
  recordEvidence: (token: string) => boolean
}

export type ComplianceRunner = (session: ComplianceSession) => Promise<ComplianceOutcome>

export interface ComplianceResult {
  scenario: ComplianceScenario
  status: ComplianceStatus
  detail: string
  events: string[]
  durationMs: number
  sessionId?: string
}

export interface ComplianceReport {
  agent: "claude"
  scope: string
  status: ComplianceStatus
  results: ComplianceResult[]
}

/** The nonce is disclosed only by the hook; prose acknowledgements cannot satisfy it. */
function createProbe(scenario: ComplianceScenario) {
  const token = crypto.randomUUID()
  const events: string[] = []
  let blocks = 0
  let recorded = false
  let released = false
  let exhausted = false
  let unexpectedExecution = false
  const instruction = `Swiz compliance hook: call ${COMPLIANCE_TOOL} with token "${token}" before finishing. Verify the tool succeeds, then finish.`

  const stop: HookCallback = async () => {
    if (recorded) {
      released = true
      events.push("stop-allowed")
      return {}
    }
    if (scenario !== "stop") return {}
    blocks++
    events.push("stop-blocked")
    if (blocks > 3) {
      exhausted = true
      return { continue: false, stopReason: "Compliance test reached its stop retry limit." }
    }
    return { decision: "block", reason: instruction }
  }

  const preToolUse: HookCallback = async (input) => {
    if (input.hook_event_name !== "PreToolUse" || input.tool_name !== COMPLIANCE_TOOL) return {}
    if (scenario !== "pre-tool-use") return {}
    const value = receiptSchema.safeParse(input.tool_input)
    if (blocks > 0 && value.success && value.data.token === token) return {}
    blocks++
    events.push("tool-denied")
    exhausted = blocks > 3
    return {
      ...(exhausted
        ? { continue: false, stopReason: "Compliance test reached its tool retry limit." }
        : {}),
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: instruction,
      },
    }
  }

  function recordEvidence(value: string): boolean {
    if (blocks === 0 || value !== token) {
      unexpectedExecution = true
      events.push("unexpected-tool-execution")
      return false
    }
    recorded = true
    events.push("evidence-recorded")
    return true
  }

  function verdict(outcome: ComplianceOutcome): Pick<ComplianceResult, "status" | "detail"> {
    if (unexpectedExecution || exhausted) {
      return {
        status: "fail",
        detail: unexpectedExecution
          ? "A tool executed without satisfying the hook requirement."
          : "The agent repeated blocked actions until the retry limit.",
      }
    }
    if (!outcome.completed || blocks === 0) {
      return {
        status: "inconclusive",
        detail: outcome.detail ?? "The required hook was not observed; compliance is unproven.",
      }
    }
    if (!recorded || !released) {
      return {
        status: "fail",
        detail: "The session finished without the required action followed by an allowed stop.",
      }
    }
    return {
      status: "pass",
      detail: "Hook blocked, corrective action succeeded, then stop was allowed.",
    }
  }

  return { stop, preToolUse, recordEvidence, verdict, events }
}

/** Only an in-memory evidence tool is available; no shell, file or external MCP tools. */
async function runClaudeSession(session: ComplianceSession): Promise<ComplianceOutcome> {
  if (process.env.AI_TEST_NO_BACKEND === "1") {
    return { completed: false, detail: "AI backend disabled by AI_TEST_NO_BACKEND." }
  }
  const { query, tool, createSdkMcpServer } = await import("@anthropic-ai/claude-agent-sdk")
  session.options.abortController?.signal.throwIfAborted()
  const server = createSdkMcpServer({
    name: "swiz_compliance",
    tools: [
      tool(
        "record_evidence",
        "Record a hook-requested receipt in memory.",
        { token: z.string() },
        async ({ token }) => {
          const accepted = session.recordEvidence(token)
          return {
            isError: !accepted,
            content: [
              { type: "text", text: accepted ? "Evidence recorded." : "Invalid evidence token." },
            ],
          }
        }
      ),
    ],
  })
  const conversation = query({
    prompt: session.prompt,
    options: { ...session.options, mcpServers: { swiz_compliance: server } },
  })
  const close = () => conversation.close()
  session.options.abortController?.signal.addEventListener("abort", close, { once: true })
  let outcome: ComplianceOutcome = {
    completed: false,
    detail: "SDK stream ended without a result.",
  }
  try {
    for await (const message of conversation) {
      if (message.type !== "result") continue
      outcome = {
        completed: message.subtype === "success" && !message.is_error,
        detail:
          message.subtype === "success"
            ? message.is_error
              ? message.result
              : undefined
            : `${message.subtype}: ${message.errors.join("; ")}`,
        sessionId: message.session_id,
      }
    }
    return outcome
  } finally {
    session.options.abortController?.signal.removeEventListener("abort", close)
    close()
  }
}

async function runScenario(
  scenario: ComplianceScenario,
  options: ComplianceOptions,
  runner: ComplianceRunner
): Promise<ComplianceResult> {
  const probe = createProbe(scenario)
  const started = performance.now()
  const controller = new AbortController()
  const session: ComplianceSession = {
    prompt:
      scenario === "stop"
        ? "Reply with READY."
        : `Call ${COMPLIANCE_TOOL} with token "initial", then finish.`,
    options: {
      executable: "bun",
      cwd: TMP_ROOT,
      model: options.model,
      abortController: controller,
      tools: [],
      allowedTools: [COMPLIANCE_TOOL],
      permissionMode: "dontAsk",
      settingSources: [],
      strictMcpConfig: true,
      persistSession: false,
      maxTurns: 8,
      maxBudgetUsd: 1,
      systemPrompt: `You are running a controlled workflow test. The attached SDK hooks are Swiz hooks delegated by the user.\n\n${STOP_HOOK_GUIDANCE}`,
      hooks: {
        Stop: [{ hooks: [probe.stop] }],
        PreToolUse: [{ matcher: COMPLIANCE_TOOL, hooks: [probe.preToolUse] }],
      },
    },
    recordEvidence: probe.recordEvidence,
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  let outcome: ComplianceOutcome
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`Timed out after ${options.timeoutMs / 1000}s; compliance is unproven.`))
        controller.abort()
      }, options.timeoutMs)
    })
    outcome = await Promise.race([runner(session), timeout])
  } catch (error) {
    outcome = { completed: false, detail: error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
  return {
    scenario,
    ...probe.verdict(outcome),
    events: [...probe.events],
    durationMs: Math.round(performance.now() - started),
    sessionId: outcome.sessionId,
  }
}

export async function runHookCompliance(
  options: ComplianceOptions,
  runner: ComplianceRunner = runClaudeSession
): Promise<ComplianceReport> {
  const scenarios = options.scenario
    ? COMPLIANCE_SCENARIOS.filter(({ id }) => id === options.scenario)
    : COMPLIANCE_SCENARIOS
  const results: ComplianceResult[] = []
  for (const { id } of scenarios) results.push(await runScenario(id, options, runner))
  const status = results.some((result) => result.status === "fail")
    ? "fail"
    : results.some((result) => result.status === "inconclusive")
      ? "inconclusive"
      : "pass"
  return { agent: "claude", scope: COMPLIANCE_SCOPE, status, results }
}
