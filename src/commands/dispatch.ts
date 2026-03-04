import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import {
  computeTranscriptSummary,
  detectProjectStack,
  isEditTool,
  isNotebookTool,
  isShellTool,
  isTaskCreateTool,
  isTaskTool,
  isWriteTool,
} from "../../hooks/hook-utils.ts"
import { tryReplayPendingMutations } from "../issue-store.ts"
import { evalCondition, type HookGroup, manifest } from "../manifest.ts"
import { loadAllPlugins } from "../plugins.ts"
import {
  getEffectiveSwizSettings,
  readProjectSettings,
  readSwizSettings,
  resolveProjectHooks,
} from "../settings.ts"
import type { Command } from "../types.ts"

// ─── Replay trace types ──────────────────────────────────────────────────────

interface TraceEntry {
  file: string
  matcher?: string
  async: boolean
  startTime: number
  endTime?: number
  status: "pending" | "allow" | "allow-with-reason" | "deny" | "block" | "ok" | "no-output"
  reason?: string
  output?: string
  stderr?: string
}

const SWIZ_ROOT = dirname(Bun.main)
const HOOKS_DIR = join(SWIZ_ROOT, "hooks")
const LOG_PATH = "/tmp/swiz-dispatch.log"
const PR_MERGE_MODE_DISABLED_HOOKS = new Set([
  "posttooluse-pr-context.ts",
  "pretooluse-pr-age-gate.ts",
  "stop-branch-conflicts.ts",
  "stop-pr-description.ts",
  "stop-pr-changes-requested.ts",
  "stop-github-ci.ts",
])

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

// ─── Per-hook cooldown ───────────────────────────────────────────────────────
// Prevents noisy hooks from running more than once per cooldownSeconds window.
// Sentinel files are scoped per hook file + project cwd to avoid cross-project
// interference (e.g. stop-personal-repo-issues firing for repo A shouldn't
// suppress it for repo B).

export function hookCooldownPath(hookFile: string, cwd: string): string {
  const key = Bun.hash(hookFile + cwd).toString(16)
  return `/tmp/swiz-hook-cooldown-${key}.timestamp`
}

export function isWithinCooldown(hookFile: string, cooldownSeconds: number, cwd: string): boolean {
  const sentinelPath = hookCooldownPath(hookFile, cwd)
  if (!existsSync(sentinelPath)) return false
  try {
    const raw = readFileSync(sentinelPath, "utf8").trim()
    const lastRun = parseInt(raw, 10)
    if (Number.isNaN(lastRun)) return false
    return Date.now() - lastRun < cooldownSeconds * 1000
  } catch {
    return false
  }
}

export function markHookCooldown(hookFile: string, cwd: string): void {
  try {
    writeFileSync(hookCooldownPath(hookFile, cwd), String(Date.now()))
  } catch {
    // Non-fatal: if sentinel write fails the hook just runs again next time
  }
}

export function extractCwd(payloadStr: string): string {
  try {
    const parsed = JSON.parse(payloadStr) as Record<string, unknown>
    return (parsed.cwd as string) || ""
  } catch {
    return ""
  }
}

function countHooks(groups: HookGroup[]): number {
  return groups.reduce((total, group) => total + group.hooks.length, 0)
}

export function filterPrMergeModeHooks(groups: HookGroup[], prMergeMode: boolean): HookGroup[] {
  if (prMergeMode) return groups

  return groups
    .map((group) => {
      const hooks = group.hooks.filter((hook) => !PR_MERGE_MODE_DISABLED_HOOKS.has(hook.file))
      return hooks.length === group.hooks.length ? group : { ...group, hooks }
    })
    .filter((group) => group.hooks.length > 0)
}

export function filterDisabledHooks(groups: HookGroup[], disabledHooks: Set<string>): HookGroup[] {
  if (disabledHooks.size === 0) return groups

  return groups
    .map((group) => {
      const hooks = group.hooks.filter((hook) => !disabledHooks.has(hook.file))
      return hooks.length === group.hooks.length ? group : { ...group, hooks }
    })
    .filter((group) => group.hooks.length > 0)
}

/**
 * Filter hooks whose `stacks` list does not include any of the detected stacks.
 * Hooks without a `stacks` field are always included (backwards-compatible default).
 */
export function filterStackHooks(groups: HookGroup[], detectedStacks: string[]): HookGroup[] {
  if (detectedStacks.length === 0) return groups

  const stackSet = new Set(detectedStacks)
  return groups
    .map((group) => {
      const hooks = group.hooks.filter(
        (hook) => !hook.stacks || hook.stacks.some((s) => stackSet.has(s))
      )
      return hooks.length === group.hooks.length ? group : { ...group, hooks }
    })
    .filter((group) => group.hooks.length > 0)
}

async function applyHookSettingFilters(
  groups: HookGroup[],
  payload: Record<string, unknown>
): Promise<HookGroup[]> {
  const settings = await readSwizSettings()
  const cwd = (payload.cwd as string | undefined) ?? ""
  const projectSettings = cwd ? await readProjectSettings(cwd) : null
  const rawSessionId = payload.session_id ?? payload.sessionId
  const sessionId = typeof rawSessionId === "string" ? rawSessionId : null
  const effective = getEffectiveSwizSettings(settings, sessionId)

  const disabledSet = new Set([
    ...(settings.disabledHooks ?? []),
    ...(projectSettings?.disabledHooks ?? []),
  ])

  const detectedStacks = cwd ? detectProjectStack(cwd) : []
  const filtered = filterPrMergeModeHooks(groups, effective.prMergeMode)
  const stackFiltered = filterStackHooks(filtered, detectedStacks)
  return filterDisabledHooks(stackFiltered, disabledSet)
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
        if (!evalCondition(hook.condition)) {
          log(`   ⏭ ${hook.file} [condition false, skipping]`)
          continue
        }
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
  const cwd = extractCwd(payloadStr)
  const hints: string[] = []
  for (const group of groups) {
    for (const hook of group.hooks) {
      if (hook.async) continue
      if (!evalCondition(hook.condition)) {
        log(`   ⏭ ${hook.file} [condition false, skipping]`)
        continue
      }
      if (hook.cooldownSeconds && isWithinCooldown(hook.file, hook.cooldownSeconds, cwd)) {
        log(`   ⏭ ${hook.file} [cooldown active, skipping]`)
        continue
      }
      log(`   → ${hook.file}${group.matcher ? ` [${group.matcher}]` : ""}`)
      const resp = await runHook(hook.file, payloadStr, hook.timeout)
      if (hook.cooldownSeconds) markHookCooldown(hook.file, cwd)
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
  const cwd = extractCwd(payloadStr)
  for (const group of groups) {
    for (const hook of group.hooks) {
      if (hook.async) continue
      if (!evalCondition(hook.condition)) {
        log(`   ⏭ ${hook.file} [condition false, skipping]`)
        continue
      }
      if (hook.cooldownSeconds && isWithinCooldown(hook.file, hook.cooldownSeconds, cwd)) {
        log(`   ⏭ ${hook.file} [cooldown active, skipping]`)
        continue
      }
      log(`   → ${hook.file}${group.matcher ? ` [${group.matcher}]` : ""}`)
      const resp = await runHook(hook.file, payloadStr, hook.timeout)
      if (hook.cooldownSeconds) markHookCooldown(hook.file, cwd)
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
  const cwd = extractCwd(payloadStr)
  const contexts: string[] = []
  for (const group of groups) {
    for (const hook of group.hooks) {
      if (hook.async) continue
      if (!evalCondition(hook.condition)) {
        log(`   ⏭ ${hook.file} [condition false, skipping]`)
        continue
      }
      if (hook.cooldownSeconds && isWithinCooldown(hook.file, hook.cooldownSeconds, cwd)) {
        log(`   ⏭ ${hook.file} [cooldown active, skipping]`)
        continue
      }
      log(`   → ${hook.file}${group.matcher ? ` [${group.matcher}]` : ""}`)
      const resp = await runHook(hook.file, payloadStr, hook.timeout)
      if (hook.cooldownSeconds) markHookCooldown(hook.file, cwd)
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

// ─── Replay trace strategies ─────────────────────────────────────────────────

/** Replay PreToolUse with trace collection: short-circuit on first deny; collect hints. */
async function replayPreToolUse(groups: HookGroup[], payloadStr: string): Promise<TraceEntry[]> {
  const traces: TraceEntry[] = []
  for (const group of groups) {
    for (const hook of group.hooks) {
      if (hook.async) continue
      if (!evalCondition(hook.condition)) {
        log(`   ⏭ ${hook.file} [condition false, skipping]`)
        continue
      }
      const startTime = Date.now()
      const entry: TraceEntry = {
        file: hook.file,
        ...(group.matcher && { matcher: group.matcher }),
        async: false,
        startTime,
        status: "pending",
      }
      const resp = await runHook(hook.file, payloadStr, hook.timeout)
      entry.endTime = Date.now()
      if (resp && isDeny(resp)) {
        entry.status = "deny"
        entry.output = JSON.stringify(resp)
        traces.push(entry)
        return traces // Short-circuit on deny
      }
      if (resp && isAllowWithReason(resp)) {
        entry.status = "allow-with-reason"
        entry.reason = extractAllowReason(resp) ?? undefined
        traces.push(entry)
        continue
      }
      entry.status = resp ? "allow" : "no-output"
      traces.push(entry)
    }
  }
  return traces
}

/** Replay blocking (Stop/PostToolUse) with trace collection: short-circuit on first block. */
async function replayBlocking(groups: HookGroup[], payloadStr: string): Promise<TraceEntry[]> {
  const traces: TraceEntry[] = []
  for (const group of groups) {
    for (const hook of group.hooks) {
      if (hook.async) continue
      if (!evalCondition(hook.condition)) {
        log(`   ⏭ ${hook.file} [condition false, skipping]`)
        continue
      }
      const startTime = Date.now()
      const entry: TraceEntry = {
        file: hook.file,
        ...(group.matcher && { matcher: group.matcher }),
        async: false,
        startTime,
        status: "pending",
      }
      const resp = await runHook(hook.file, payloadStr, hook.timeout)
      entry.endTime = Date.now()
      if (resp && isBlock(resp)) {
        entry.status = "block"
        entry.output = JSON.stringify(resp)
        traces.push(entry)
        return traces // Short-circuit on block
      }
      entry.status = resp ? "ok" : "no-output"
      traces.push(entry)
    }
  }
  return traces
}

/** Replay context (SessionStart/UserPromptSubmit) with trace collection: run all hooks. */
async function replayContext(groups: HookGroup[], payloadStr: string): Promise<TraceEntry[]> {
  const traces: TraceEntry[] = []
  for (const group of groups) {
    for (const hook of group.hooks) {
      if (hook.async) continue
      if (!evalCondition(hook.condition)) {
        log(`   ⏭ ${hook.file} [condition false, skipping]`)
        continue
      }
      const startTime = Date.now()
      const entry: TraceEntry = {
        file: hook.file,
        ...(group.matcher && { matcher: group.matcher }),
        async: false,
        startTime,
        status: "pending",
      }
      const resp = await runHook(hook.file, payloadStr, hook.timeout)
      entry.endTime = Date.now()
      if (!resp) {
        entry.status = "no-output"
        traces.push(entry)
        continue
      }
      const ctx = extractContext(resp)
      entry.status = ctx ? "allow-with-reason" : "ok"
      if (ctx) entry.reason = ctx.slice(0, 200)
      traces.push(entry)
    }
  }
  return traces
}

// ─── Replay trace formatting ─────────────────────────────────────────────────

const BOLD = "\x1b[1m"
const DIM = "\x1b[2m"
const GREEN = "\x1b[32m"
const RED = "\x1b[31m"
const YELLOW = "\x1b[33m"
const RESET = "\x1b[0m"

function formatTrace(
  event: string,
  strategy: DispatchStrategy,
  matchedCount: number,
  traces: TraceEntry[],
  jsonMode: boolean
): void {
  if (jsonMode) {
    const blocked = traces.find((t) => t.status === "block" || t.status === "deny")
    console.log(
      JSON.stringify({
        event,
        strategy,
        matched_groups: matchedCount,
        hooks: traces.map((t) => ({
          file: t.file,
          ...(t.matcher && { matcher: t.matcher }),
          async: t.async,
          duration_ms: t.endTime !== undefined ? t.endTime - t.startTime : null,
          status: t.status,
          ...(t.reason && { reason: t.reason }),
        })),
        result: blocked
          ? { blocked: true, by: blocked.file, status: blocked.status }
          : { blocked: false },
      })
    )
    return
  }

  const hr = "━".repeat(50)
  console.error(`\n${BOLD}${hr}${RESET}`)
  console.error(`${BOLD}swiz dispatch replay:${RESET} ${event}`)
  console.error(`${DIM}strategy: ${strategy} | ${matchedCount} group(s) matched${RESET}`)
  console.error(`${BOLD}${hr}${RESET}\n`)

  traces.forEach((t, i) => {
    const ms = t.endTime !== undefined ? `${t.endTime - t.startTime}ms` : "?"
    const matcherStr = t.matcher ? ` ${DIM}[${t.matcher}]${RESET}` : ""
    const fileStr = `${BOLD}${t.file}${RESET}${matcherStr}`

    let statusStr: string
    switch (t.status) {
      case "deny":
        statusStr = `${RED}✗ DENY${RESET}`
        break
      case "block":
        statusStr = `${RED}✗ BLOCK${RESET}`
        break
      case "allow-with-reason":
        statusStr = `${YELLOW}~ hint${RESET}`
        break
      case "no-output":
        statusStr = `${DIM}– no output${RESET}`
        break
      default:
        statusStr = `${GREEN}✓ ${t.status}${RESET}`
    }

    console.error(`  ${i + 1}. ${fileStr}  ${DIM}${ms}${RESET}  ${statusStr}`)
    if ((t.status === "block" || t.status === "deny") && t.output) {
      try {
        const parsed = JSON.parse(t.output) as Record<string, unknown>
        const hso = parsed.hookSpecificOutput as Record<string, unknown> | undefined
        const reason =
          (parsed.reason as string | undefined) ??
          (parsed.message as string | undefined) ??
          (hso?.permissionDecisionReason as string | undefined) ??
          (hso?.additionalContext as string | undefined)
        if (reason) {
          const preview = reason.trim().split("\n").slice(0, 3).join("\n     ")
          console.error(`     ${DIM}${preview}${RESET}`)
        }
      } catch {
        console.error(`     ${DIM}${t.output.slice(0, 200)}${RESET}`)
      }
    }
    if (t.reason && t.status === "allow-with-reason") {
      const preview = t.reason.trim().split("\n").slice(0, 2).join("\n     ")
      console.error(`     ${DIM}${preview}${RESET}`)
    }
  })

  const blocked = traces.find((t) => t.status === "block" || t.status === "deny")
  console.error(`\n${BOLD}${hr}${RESET}`)
  if (blocked) {
    console.error(
      `${BOLD}Result:${RESET} ${RED}${blocked.status.toUpperCase()} by ${blocked.file}${RESET}`
    )
  } else {
    console.error(`${BOLD}Result:${RESET} ${GREEN}all passed${RESET}`)
  }
  console.error(`${BOLD}${hr}${RESET}\n`)
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
    {
      flags: "replay <event>",
      description: "Replay a captured payload and show a hook-by-hook trace",
    },
    {
      flags: "--json",
      description: "Output trace in machine-readable JSON format (replay mode only)",
    },
  ],
  async run(args) {
    // ─── Replay mode ─────────────────────────────────────────────────────
    if (args[0] === "replay") {
      const canonicalEvent = args[1]
      const jsonMode = args.includes("--json")
      if (!canonicalEvent) {
        throw new Error("Usage: swiz dispatch replay <event> [--json]")
      }

      const payloadStr = await new Response(Bun.stdin).text()
      let payload: Record<string, unknown> = {}
      try {
        payload = JSON.parse(payloadStr) as Record<string, unknown>
      } catch {}

      const toolName = (payload.tool_name ?? payload.toolName) as string | undefined
      const trigger =
        canonicalEvent === "sessionStart"
          ? ((payload.trigger ?? payload.hook_event_name) as string | undefined)
          : undefined

      const matchingGroups = manifest.filter(
        (g) => g.event === canonicalEvent && groupMatches(g, toolName, trigger)
      )
      const filteredGroups = await applyHookSettingFilters(matchingGroups, payload)

      const strategy = DISPATCH_ROUTES[canonicalEvent] ?? "blocking"

      let traces: TraceEntry[]
      switch (strategy) {
        case "preToolUse":
          traces = await replayPreToolUse(filteredGroups, payloadStr)
          break
        case "blocking":
          traces = await replayBlocking(filteredGroups, payloadStr)
          break
        case "context":
          traces = await replayContext(filteredGroups, payloadStr)
          break
      }

      formatTrace(canonicalEvent, strategy, filteredGroups.length, traces, jsonMode)
      return
    }

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

    // ── Best-effort: drain any offline issue mutations before hooks run ──
    const cwd = (payload.cwd as string) ?? process.cwd()
    await tryReplayPendingMutations(cwd)

    // ── Load plugin + project-local hooks and merge with built-in manifest ──
    let combinedManifest: HookGroup[] = [...manifest]
    const projectSettings = await readProjectSettings(cwd)
    if (projectSettings?.plugins?.length) {
      const pluginResults = await loadAllPlugins(projectSettings.plugins, cwd)
      const pluginHooks = pluginResults.flatMap((r) => r.hooks)
      for (const r of pluginResults) {
        if (r.error) log(`   ⚠ plugin ${r.name}: ${r.error}`)
      }
      if (pluginHooks.length > 0) {
        combinedManifest = [...combinedManifest, ...pluginHooks]
        log(`   loaded ${pluginHooks.length} plugin hook group(s)`)
      }
    }
    if (projectSettings?.hooks?.length) {
      const { resolved, warnings } = resolveProjectHooks(projectSettings.hooks, cwd)
      for (const w of warnings) log(`   ⚠ ${w}`)
      if (resolved.length > 0) {
        combinedManifest = [...combinedManifest, ...resolved]
        log(`   loaded ${resolved.length} project-local hook group(s)`)
      }
    }

    const matchingGroups = combinedManifest.filter(
      (g) => g.event === canonicalEvent && groupMatches(g, toolName, trigger)
    )
    const filteredGroups = await applyHookSettingFilters(matchingGroups, payload)

    log(
      `   matched ${matchingGroups.length} group(s) from ${combinedManifest.filter((g) => g.event === canonicalEvent).length} total`
    )
    const skippedHooks = countHooks(matchingGroups) - countHooks(filteredGroups)
    if (skippedHooks > 0) {
      log(`   skipped ${skippedHooks} PR-merge hook(s) (pr-merge-mode disabled)`)
    }

    if (filteredGroups.length === 0) return

    // ── Pre-compute transcript summary for hooks ──────────────────────────
    // Parse the transcript once and inject the summary into the payload so
    // individual hooks don't each re-read and re-parse the file.
    let enrichedPayloadStr = payloadStr
    const transcriptPath = payload.transcript_path as string | undefined
    if (transcriptPath && !parseError) {
      const summary = await computeTranscriptSummary(transcriptPath)
      if (summary) {
        const enriched = { ...payload, _transcriptSummary: summary }
        enrichedPayloadStr = JSON.stringify(enriched)
        log(
          `   transcript summary: ${summary.toolCallCount} tools, ${summary.bashCommands.length} cmds`
        )
      }
    }

    const strategy = DISPATCH_ROUTES[canonicalEvent] ?? "blocking"
    switch (strategy) {
      case "preToolUse":
        await runPreToolUse(filteredGroups, enrichedPayloadStr)
        break
      case "blocking":
        await runBlocking(filteredGroups, enrichedPayloadStr)
        break
      case "context":
        await runContext(filteredGroups, enrichedPayloadStr, hookEventName)
        break
    }
  },
}
