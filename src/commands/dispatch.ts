import { appendFileSync } from "node:fs"
import { dirname, join } from "node:path"
import {
  isEditTool,
  isNotebookTool,
  isShellTool,
  isTaskCreateTool,
  isTaskTool,
  isWriteTool,
} from "../../hooks/hook-utils.ts"
import { CONFIGURABLE_AGENTS } from "../agents.ts"
import { type HookGroup, manifest, validateDispatchRoutes } from "../manifest.ts"
import type { Command } from "../types.ts"

const SWIZ_ROOT = dirname(Bun.main)
const HOOKS_DIR = join(SWIZ_ROOT, "hooks")
const LOG_PATH = "/tmp/swiz-dispatch.log"

// ─── Debug logger ────────────────────────────────────────────────────────────

function log(msg: string): void {
  try {
    appendFileSync(LOG_PATH, `${msg}\n`)
  } catch {
    // Never let logging break dispatch
  }
}

function logHeader(
  event: string,
  hookEventName: string,
  toolName?: string,
  trigger?: string
): void {
  const ts = new Date().toISOString()
  log(`\n── ${ts} ── ${event} (hookEventName=${hookEventName}) ──`)
  if (toolName) log(`   tool: ${toolName}`)
  if (trigger) log(`   trigger: ${trigger}`)
}

// ─── Cross-agent matcher ─────────────────────────────────────────────────────
// Agents use different tool names (Bash/Shell/run_shell_command). Match using
// the same equivalence sets from hook-utils so dispatch is agent-agnostic.

function toolMatchesToken(toolName: string, token: string): boolean {
  if (toolName === token) return true
  if (isShellTool(toolName) && isShellTool(token)) return true
  if (isEditTool(toolName) && isEditTool(token)) return true
  if (isWriteTool(toolName) && isWriteTool(token)) return true
  if (isNotebookTool(toolName) && isNotebookTool(token)) return true
  if (isTaskTool(toolName) && isTaskTool(token)) return true
  if (isTaskCreateTool(toolName) && isTaskCreateTool(token)) return true
  return false
}

function groupMatches(
  group: HookGroup,
  toolName: string | undefined,
  trigger: string | undefined
): boolean {
  if (!group.matcher) return true
  // SessionStart uses trigger types (startup/compact) not tool names
  if (trigger !== undefined) return group.matcher === trigger
  if (!toolName) return false
  return group.matcher.split("|").some((part) => toolMatchesToken(toolName, part.trim()))
}

// ─── Hook execution ──────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT = 10 // seconds

async function runHook(
  file: string,
  payloadStr: string,
  timeoutSec?: number
): Promise<Record<string, unknown> | null> {
  const cmd = file.endsWith(".ts") ? ["bun", join(HOOKS_DIR, file)] : [join(HOOKS_DIR, file)]

  const proc = Bun.spawn(cmd, {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })

  proc.stdin.write(payloadStr)
  proc.stdin.end()

  const deadline = (timeoutSec ?? DEFAULT_TIMEOUT) * 1000
  const timer = setTimeout(() => {
    log(`   ⏱ TIMEOUT (${timeoutSec ?? DEFAULT_TIMEOUT}s) — killing ${file}`)
    proc.kill()
  }, deadline)

  const [output, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited
  clearTimeout(timer)

  const exitCode = proc.exitCode
  const trimmed = output.trim()

  if (stderr.trim()) log(`   stderr: ${stderr.trim().slice(0, 500)}`)
  if (exitCode !== 0) log(`   exit=${exitCode}`)
  if (trimmed) log(`   stdout: ${trimmed.slice(0, 500)}`)

  if (!trimmed) return null
  try {
    return JSON.parse(trimmed) as Record<string, unknown>
  } catch {
    log(`   ⚠ invalid JSON: ${trimmed.slice(0, 200)}`)
    return null
  }
}

// ─── Response classification ─────────────────────────────────────────────────

function isDeny(resp: Record<string, unknown>): boolean {
  if (resp.decision === "deny") return true
  const hso = resp.hookSpecificOutput as Record<string, unknown> | undefined
  return hso?.permissionDecision === "deny"
}

function isAllowWithReason(resp: Record<string, unknown>): boolean {
  const hso = resp.hookSpecificOutput as Record<string, unknown> | undefined
  return hso?.permissionDecision === "allow" && typeof hso?.permissionDecisionReason === "string"
}

function extractAllowReason(resp: Record<string, unknown>): string | null {
  const hso = resp.hookSpecificOutput as Record<string, unknown> | undefined
  if (hso?.permissionDecision === "allow" && typeof hso?.permissionDecisionReason === "string") {
    return hso.permissionDecisionReason as string
  }
  return null
}

function isBlock(resp: Record<string, unknown>): boolean {
  return resp.decision === "block"
}

function extractContext(resp: Record<string, unknown>): string | null {
  const hso = resp.hookSpecificOutput as Record<string, unknown> | undefined
  const ctx = hso?.additionalContext ?? resp.systemMessage
  return typeof ctx === "string" ? ctx : null
}

// ─── Dispatch strategies ─────────────────────────────────────────────────────

/** Fire all async hooks immediately without awaiting — they run in the background
 *  regardless of whether a blocking hook short-circuits the pipeline. */
function launchAsyncHooks(groups: HookGroup[], payloadStr: string): void {
  for (const group of groups) {
    for (const hook of group.hooks) {
      if (hook.async) {
        log(`   → ${hook.file} [async, fire-and-forget]`)
        runHook(hook.file, payloadStr, hook.timeout).catch(() => {})
      }
    }
  }
}

/** PreToolUse: short-circuit on first deny; collect and merge allow-with-reason hints.
 *  Async hooks are launched first so they run even if a deny short-circuits. */
async function runPreToolUse(groups: HookGroup[], payloadStr: string): Promise<void> {
  launchAsyncHooks(groups, payloadStr)
  const hints: string[] = []
  for (const group of groups) {
    for (const hook of group.hooks) {
      if (hook.async) continue
      log(`   → ${hook.file}${group.matcher ? ` [${group.matcher}]` : ""}`)
      const resp = await runHook(hook.file, payloadStr, hook.timeout)
      if (resp && isDeny(resp)) {
        log(`   ✗ DENY from ${hook.file}`)
        console.log(JSON.stringify(resp))
        return
      }
      if (resp && isAllowWithReason(resp)) {
        const reason = extractAllowReason(resp)
        if (reason) {
          hints.push(reason)
          log(`   ~ ${hook.file} (hint: ${reason.slice(0, 100)})`)
          continue
        }
      }
      log(`   ✓ ${hook.file} (${resp ? "allow" : "no output"})`)
    }
  }
  // Forward collected hints as a single allow-with-reason response
  if (hints.length > 0) {
    log(`   result: passed with ${hints.length} hint(s)`)
    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          permissionDecisionReason: hints.join("\n\n"),
        },
      })
    )
    return
  }
  log(`   result: all passed`)
}

/** Stop / PostToolUse: short-circuit and forward the first block.
 *  Async hooks are launched first so they run even if a blocker short-circuits. */
async function runBlocking(groups: HookGroup[], payloadStr: string): Promise<void> {
  launchAsyncHooks(groups, payloadStr)
  for (const group of groups) {
    for (const hook of group.hooks) {
      if (hook.async) continue
      log(`   → ${hook.file}${group.matcher ? ` [${group.matcher}]` : ""}`)
      const resp = await runHook(hook.file, payloadStr, hook.timeout)
      if (resp && isBlock(resp)) {
        log(`   ✗ BLOCK from ${hook.file}`)
        console.log(JSON.stringify(resp))
        return
      }
      log(`   ✓ ${hook.file} (${resp ? "ok" : "no output"})`)
    }
  }
  log(`   result: all passed`)
}

/** SessionStart / UserPromptSubmit: run all hooks, merge additionalContext.
 *  Async hooks are launched first as fire-and-forget. */
async function runContext(
  groups: HookGroup[],
  payloadStr: string,
  eventName: string
): Promise<void> {
  launchAsyncHooks(groups, payloadStr)
  const contexts: string[] = []
  for (const group of groups) {
    for (const hook of group.hooks) {
      if (hook.async) continue
      log(`   → ${hook.file}${group.matcher ? ` [${group.matcher}]` : ""}`)
      const resp = await runHook(hook.file, payloadStr, hook.timeout)
      if (!resp) {
        log(`   ✓ ${hook.file} (no output)`)
        continue
      }
      const ctx = extractContext(resp)
      if (ctx) {
        contexts.push(ctx)
        log(`   ✓ ${hook.file} (context: ${ctx.slice(0, 100)})`)
      } else {
        log(`   ✓ ${hook.file} (no context extracted)`)
      }
    }
  }
  if (contexts.length === 0) {
    log(`   result: no contexts to merge`)
    return
  }
  const output = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext: contexts.join("\n\n"),
    },
  })
  log(`   result: merged ${contexts.length} context(s), hookEventName=${eventName}`)
  console.log(output)
}

// ─── Dispatch routing table ─────────────────────────────────────────────────
// Maps canonical event names to their dispatch strategy.
// Exported so tests can cross-check against manifest events and agent event maps.

export type DispatchStrategy = "preToolUse" | "blocking" | "context"

export const DISPATCH_ROUTES: Record<string, DispatchStrategy> = {
  preToolUse: "preToolUse",
  stop: "blocking",
  postToolUse: "blocking",
  sessionStart: "context",
  userPromptSubmit: "context",
  preCompact: "context",
}

// ─── Command ────────────────────────────────────────────────────────────────

export const dispatchCommand: Command = {
  name: "dispatch",
  description: "Fan out a hook event to all matching scripts (used by agent configs)",
  usage: "swiz dispatch <event> [agentEventName]",
  options: [
    {
      flags: "<event>",
      description:
        "Canonical event name (preToolUse | postToolUse | stop | sessionStart | userPromptSubmit)",
    },
    {
      flags: "[agentEventName]",
      description: "Agent-translated event name injected into hook output (default: <event>)",
    },
  ],
  async run(args) {
    validateDispatchRoutes(DISPATCH_ROUTES, CONFIGURABLE_AGENTS)

    const canonicalEvent = args[0]
    if (!canonicalEvent) {
      throw new Error("Usage: swiz dispatch <event> [agentEventName]")
    }
    // args[1] is the agent-translated event name (e.g. "UserPromptSubmit" for Claude Code).
    // Falls back to canonicalEvent so hookEventName always matches the registering config.
    const hookEventName = args[1] ?? canonicalEvent

    const payloadStr = await new Response(Bun.stdin).text()
    let payload: Record<string, unknown> = {}
    let parseError = false
    try {
      payload = JSON.parse(payloadStr) as Record<string, unknown>
    } catch {
      parseError = true
    }

    const toolName = (payload.tool_name ?? payload.toolName) as string | undefined
    // SessionStart sends a trigger type; only use it for that event
    const trigger =
      canonicalEvent === "sessionStart"
        ? ((payload.trigger ?? payload.hook_event_name) as string | undefined)
        : undefined

    logHeader(canonicalEvent, hookEventName, toolName, trigger)
    log(`   payload: ${payloadStr.length} bytes${parseError ? " ⚠ INVALID JSON" : ""}`)
    if (payloadStr.length === 0) {
      log(`   ⚠ EMPTY STDIN — no payload received from agent`)
    } else {
      const keys = Object.keys(payload)
      log(`   keys: ${keys.join(", ")}`)
      if (!payload.session_id) log(`   ⚠ missing session_id`)
      if (
        !payload.tool_name &&
        !payload.toolName &&
        canonicalEvent !== "sessionStart" &&
        canonicalEvent !== "subagentStart" &&
        canonicalEvent !== "subagentStop" &&
        canonicalEvent !== "userPromptSubmit" &&
        canonicalEvent !== "stop"
      )
        log(`   ⚠ missing tool_name`)
    }

    const matchingGroups = manifest.filter(
      (g) => g.event === canonicalEvent && groupMatches(g, toolName, trigger)
    )

    log(
      `   matched ${matchingGroups.length} group(s) from ${manifest.filter((g) => g.event === canonicalEvent).length} total`
    )

    if (matchingGroups.length === 0) return

    const strategy = DISPATCH_ROUTES[canonicalEvent] ?? "blocking"
    switch (strategy) {
      case "preToolUse":
        await runPreToolUse(matchingGroups, payloadStr)
        break
      case "blocking":
        await runBlocking(matchingGroups, payloadStr)
        break
      case "context":
        await runContext(matchingGroups, payloadStr, hookEventName)
        break
    }
  },
}
