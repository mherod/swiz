import { orderBy } from "lodash-es"
import { AGENTS, type AgentDef, getAgentByFlag, translateEvent } from "../agents.ts"
import { BOLD, CYAN, DIM, GREEN, RED, RESET, YELLOW } from "../ansi.ts"
import {
  getLaunchAgentPlistPath,
  loadLaunchAgentSync,
  SWIZ_PR_POLL_LABEL,
  unloadLaunchAgentSync,
} from "../launch-agents.ts"
import { DISPATCH_TIMEOUTS, manifest } from "../manifest.ts"
import { loadAllPlugins, pluginErrorHint, pluginResultsToJson } from "../plugins.ts"
import { readProjectSettings } from "../settings.ts"
import {
  HOOKS_DIR,
  isManagedSwizCommand,
  isSwizCommand,
  LEGACY_HOOK_DIRS,
} from "../swiz-hook-commands.ts"
import { swizPrPollErrorLogPath, swizPrPollLogPath } from "../temp-paths.ts"
import type { Command } from "../types.ts"

// ─── Config generators ──────────────────────────────────────────────────────
// manifest and DISPATCH_TIMEOUTS imported from ../manifest.ts

// Strip swiz-managed and legacy hooks from a nested matcher group array,
// returning only user-defined entries.
function stripManagedFromNestedGroups(groups: unknown[]): unknown[] {
  const kept: unknown[] = []
  for (const group of groups) {
    const g = group as Record<string, unknown>
    if (Array.isArray(g.hooks)) {
      const userHooks = g.hooks.filter(
        (h) => !isManagedSwizCommand((h as Record<string, unknown>).command)
      )
      if (userHooks.length > 0) {
        kept.push({ ...g, hooks: userHooks })
      }
    } else if (!isManagedSwizCommand(g.command)) {
      kept.push(group)
    }
  }
  return kept
}

// Strip swiz-managed and legacy hooks from a flat hook array.
function stripManagedFromFlatList(entries: unknown[]): unknown[] {
  return entries.filter((e) => !isManagedSwizCommand((e as Record<string, unknown>).command))
}

function mergeNestedConfig(
  agent: AgentDef,
  existingHooks: Record<string, unknown>
): Record<string, unknown[]> {
  const merged: Record<string, unknown[]> = {}

  // Preserve all existing events (including ones swiz doesn't touch)
  for (const [event, groups] of Object.entries(existingHooks)) {
    if (!Array.isArray(groups)) continue
    const userGroups = stripManagedFromNestedGroups(groups)
    if (userGroups.length > 0) merged[event] = userGroups
  }

  // Add one dispatch entry per unique canonical event (skip scheduled events — not agent events)
  const seenEvents = new Set<string>()
  for (const group of manifest) {
    if (group.scheduled) continue
    if (seenEvents.has(group.event)) continue
    seenEvents.add(group.event)
    if (!supportsAgentEvent(agent, group.event)) continue

    const eventName = translateEvent(group.event, agent)
    if (!merged[eventName]) merged[eventName] = []

    const timeoutScale = agent.id === "gemini" ? 1000 : 1
    const timeout = (DISPATCH_TIMEOUTS[group.event] ?? 30) * timeoutScale
    const cmd = `command -v swiz >/dev/null 2>&1 || exit 0; swiz dispatch ${group.event} ${eventName}`
    merged[eventName]!.push({
      hooks: [{ type: "command", command: cmd, timeout, statusMessage: "Swizzling..." }],
    })
  }

  return merged
}

function supportsAgentEvent(agent: AgentDef, canonicalEvent: string): boolean {
  const unsupported = new Set(agent.unsupportedEvents ?? [])
  return !unsupported.has(canonicalEvent) && canonicalEvent in agent.eventMap
}

function mergeFlatConfig(
  agent: AgentDef,
  existingHooks: Record<string, unknown>
): Record<string, unknown[]> {
  const merged: Record<string, unknown[]> = {}

  // Preserve user hooks
  for (const [event, entries] of Object.entries(existingHooks)) {
    if (!Array.isArray(entries)) continue
    const userEntries = stripManagedFromFlatList(entries)
    if (userEntries.length > 0) merged[event] = userEntries
  }

  // Add one dispatch entry per unique canonical event (skip scheduled events — not agent events)
  const seenEvents = new Set<string>()
  for (const group of manifest) {
    if (group.scheduled) continue
    if (seenEvents.has(group.event)) continue
    seenEvents.add(group.event)
    if (!supportsAgentEvent(agent, group.event)) continue

    const eventName = translateEvent(group.event, agent)
    if (!merged[eventName]) merged[eventName] = []

    const timeoutScale = agent.id === "gemini" ? 1000 : 1
    const timeout = (DISPATCH_TIMEOUTS[group.event] ?? 30) * timeoutScale
    const cmd = `command -v swiz >/dev/null 2>&1 || exit 0; swiz dispatch ${group.event} ${eventName}`
    merged[eventName]!.push({ command: cmd, timeout, statusMessage: "Swizzling..." })
  }

  return merged
}

function mergeConfig(
  agent: AgentDef,
  existingHooks: Record<string, unknown>
): Record<string, unknown[]> {
  return agent.configStyle === "nested"
    ? mergeNestedConfig(agent, existingHooks)
    : mergeFlatConfig(agent, existingHooks)
}

// ─── Diff ────────────────────────────────────────────────────────────────────

interface DiffHunk {
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  lines: string[]
}

function computeLCS(a: string[], b: string[]): number[][] {
  const m = a.length
  const n = b.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (a[i] === b[j]) dp[i]![j] = dp[i + 1]![j + 1]! + 1
      else dp[i]![j] = Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
    }
  }
  return dp
}

type DiffOp = { type: "equal" | "delete" | "insert"; line: string }

function diffLines(oldText: string, newText: string): DiffOp[] {
  const a = oldText.split("\n")
  const b = newText.split("\n")
  const dp = computeLCS(a, b)
  const ops: DiffOp[] = []

  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ type: "equal", line: a[i]! })
      i++
      j++
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      ops.push({ type: "delete", line: a[i]! })
      i++
    } else {
      ops.push({ type: "insert", line: b[j]! })
      j++
    }
  }
  while (i < a.length) {
    ops.push({ type: "delete", line: a[i]! })
    i++
  }
  while (j < b.length) {
    ops.push({ type: "insert", line: b[j]! })
    j++
  }
  return ops
}

function formatUnifiedDiff(
  path: string,
  oldText: string,
  newText: string,
  contextLines = 3
): string {
  if (oldText === newText) return `  ${DIM}${path}: no changes${RESET}\n`

  const ops = diffLines(oldText, newText)
  const hunks: DiffHunk[] = []

  let oldLine = 0
  let newLine = 0

  const tagged = ops.map((op) => {
    const entry = { ...op, oldLine: 0, newLine: 0 }
    if (op.type === "equal") {
      entry.oldLine = ++oldLine
      entry.newLine = ++newLine
    } else if (op.type === "delete") {
      entry.oldLine = ++oldLine
    } else {
      entry.newLine = ++newLine
    }
    return entry
  })

  const changeIndices = tagged.map((t, i) => (t.type !== "equal" ? i : -1)).filter((i) => i >= 0)

  if (changeIndices.length === 0) return `  ${DIM}${path}: no changes${RESET}\n`

  let hunkStart = -1
  let hunkEnd = -1

  for (const ci of changeIndices) {
    const lo = Math.max(0, ci - contextLines)
    const hi = Math.min(tagged.length - 1, ci + contextLines)

    if (hunkStart === -1) {
      hunkStart = lo
      hunkEnd = hi
    } else if (lo <= hunkEnd + 1) {
      hunkEnd = hi
    } else {
      hunks.push(buildHunk(tagged, hunkStart, hunkEnd))
      hunkStart = lo
      hunkEnd = hi
    }
  }
  if (hunkStart !== -1) hunks.push(buildHunk(tagged, hunkStart, hunkEnd))

  const lines: string[] = []
  lines.push(`  ${BOLD}--- ${path}${RESET}`)
  lines.push(`  ${BOLD}+++ ${path} (proposed)${RESET}`)

  for (const hunk of hunks) {
    lines.push(
      `  ${CYAN}@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@${RESET}`
    )
    lines.push(...hunk.lines)
  }

  return `${lines.join("\n")}\n`
}

function buildHunk(
  tagged: Array<DiffOp & { oldLine: number; newLine: number }>,
  start: number,
  end: number
): DiffHunk {
  const lines: string[] = []
  let oldStart = 0
  let oldCount = 0
  let newStart = 0
  let newCount = 0

  for (let i = start; i <= end; i++) {
    const t = tagged[i]!
    if (t.type === "equal") {
      if (!oldStart) oldStart = t.oldLine
      if (!newStart) newStart = t.newLine
      oldCount++
      newCount++
      lines.push(`  ${DIM} ${t.line}${RESET}`)
    } else if (t.type === "delete") {
      if (!oldStart) oldStart = t.oldLine
      oldCount++
      lines.push(`  ${RED}-${t.line}${RESET}`)
    } else {
      if (!newStart) newStart = t.newLine
      newCount++
      lines.push(`  ${GREEN}+${t.line}${RESET}`)
    }
  }

  return {
    oldStart: oldStart || 1,
    oldCount,
    newStart: newStart || 1,
    newCount,
    lines,
  }
}

// ─── File I/O ───────────────────────────────────────────────────────────────

async function readFileText(path: string): Promise<string> {
  const f = Bun.file(path)
  return (await f.exists()) ? await f.text() : ""
}

async function readJsonFile(path: string): Promise<Record<string, unknown>> {
  const f = Bun.file(path)
  return (await f.exists()) ? await f.json() : {}
}

async function backup(path: string): Promise<boolean> {
  const file = Bun.file(path)
  if (await file.exists()) {
    await Bun.write(`${path}.bak`, await file.text())
    return true
  }
  return false
}

// ─── Hook command collection ─────────────────────────────────────────────────

function collectNestedHooks(hooks: unknown[], cmds: Set<string>): void {
  for (const h of hooks) {
    const hh = h as Record<string, unknown>
    if (hh.command) cmds.add(String(hh.command))
  }
}

function collectCommands(hooks: Record<string, unknown>): Set<string> {
  const cmds = new Set<string>()
  for (const entries of Object.values(hooks)) {
    if (!Array.isArray(entries)) continue
    for (const entry of entries) {
      const e = entry as Record<string, unknown>
      if (e.command) cmds.add(String(e.command))
      if (Array.isArray(e.hooks)) collectNestedHooks(e.hooks, cmds)
    }
  }
  return cmds
}

// ─── Per-agent install ───────────────────────────────────────────────────────

function logUnconfigurableAgent(agent: AgentDef): void {
  console.log(`  ${BOLD}${agent.name}${RESET} → ${YELLOW}hooks not yet user-configurable${RESET}`)
  console.log(`  ${DIM}${agent.name} has hooks infrastructure (AfterAgent, AfterToolUse) but no`)
  console.log(
    `  settings file format for user hooks. Tool mappings are tracked for when this ships.${RESET}\n`
  )
}

function extractOldHooks(
  existing: Record<string, unknown>,
  agent: AgentDef
): Record<string, unknown> {
  const raw = agent.wrapsHooks
    ? (((existing as Record<string, unknown>).hooks as Record<string, unknown>) ?? {})
    : ((existing[agent.hooksKey] as Record<string, unknown>) ?? {})
  return typeof raw === "object" && !Array.isArray(raw) ? raw : {}
}

function buildProposedAgentSettings(
  existing: Record<string, unknown>,
  agent: AgentDef,
  config: Record<string, unknown[]>
): string {
  const proposed = agent.wrapsHooks
    ? { ...agent.wrapsHooks, hooks: config }
    : { ...existing, [agent.hooksKey]: config }
  return JSON.stringify(proposed, null, 2)
}

function reportDryRunAgentInstall(
  agent: AgentDef,
  oldHooks: Record<string, unknown>,
  config: Record<string, unknown[]>,
  oldText: string,
  newText: string
): void {
  const oldCmds = collectCommands(oldHooks)
  const allNewCmds = collectCommands(config)
  const swizCmds = new Set([...allNewCmds].filter((c) => isSwizCommand(c)))
  const userCmds = new Set([...oldCmds].filter((c) => !isManagedSwizCommand(c)))
  const legacyCmds = orderBy(
    [...oldCmds].filter((c) => LEGACY_HOOK_DIRS.some((d) => c.includes(d))),
    [(command) => command],
    ["asc"]
  )

  const added = orderBy(
    [...swizCmds].filter((c) => !oldCmds.has(c)),
    [(command) => command],
    ["asc"]
  )
  const removed = orderBy(
    [...oldCmds].filter((c) => isSwizCommand(c) && !swizCmds.has(c)),
    [(command) => command],
    ["asc"]
  )
  const kept = orderBy(
    [...swizCmds].filter((c) => oldCmds.has(c)),
    [(command) => command],
    ["asc"]
  )

  if (added.length) {
    console.log(`    ${GREEN}+ ${added.length} hook(s) added:${RESET}`)
    for (const c of added) console.log(`      ${GREEN}+ ${c}${RESET}`)
    console.log()
  }
  if (removed.length) {
    console.log(`    ${RED}- ${removed.length} hook(s) removed:${RESET}`)
    for (const c of removed) console.log(`      ${RED}- ${c}${RESET}`)
    console.log()
  }
  if (legacyCmds.length) {
    console.log(`    ${YELLOW}↻ ${legacyCmds.length} legacy hook(s) replaced by swiz:${RESET}`)
    for (const c of legacyCmds) console.log(`      ${YELLOW}↻ ${c}${RESET}`)
    console.log()
  }
  if (kept.length) {
    console.log(`    ${DIM}  ${kept.length} swiz hook(s) unchanged${RESET}\n`)
  }
  if (userCmds.size) {
    console.log(`    ${CYAN}  ${userCmds.size} user hook(s) preserved${RESET}\n`)
  }
  if (!oldText && newText) {
    console.log(`    ${GREEN}+ new file (${newText.split("\n").length} lines)${RESET}\n`)
  }

  console.log(formatUnifiedDiff(agent.settingsPath, oldText, newText))
}

async function writeAgentSettings(agent: AgentDef, newText: string): Promise<void> {
  await backup(agent.settingsPath)
  await Bun.write(agent.settingsPath, `${newText}\n`)

  // Verify the write persisted (some agents watch and revert their settings)
  await new Promise((r) => setTimeout(r, 1500))
  const verify = await readFileText(agent.settingsPath)
  const persisted = verify.trimEnd() === newText

  if (persisted) {
    console.log(`    ✓ written (backup at ${agent.settingsPath}.bak)\n`)
    return
  }

  console.log(`    ✓ written, but ${YELLOW}reverted by running ${agent.name} process${RESET}`)
  console.log(
    `    ${DIM}Close all ${agent.name} sessions first, then re-run swiz install.${RESET}\n`
  )
}

async function installAgent(agent: AgentDef, dryRun: boolean) {
  if (!agent.hooksConfigurable) {
    logUnconfigurableAgent(agent)
    return
  }

  console.log(`  ${BOLD}${agent.name}${RESET} → ${agent.settingsPath}\n`)

  const existing = await readJsonFile(agent.settingsPath)
  const oldText = (await readFileText(agent.settingsPath)).trimEnd()
  const oldHooks = extractOldHooks(existing, agent)
  const config = mergeConfig(agent, oldHooks)
  const newText = buildProposedAgentSettings(existing, agent, config)

  if (dryRun) {
    reportDryRunAgentInstall(agent, oldHooks, config, oldText, newText)
    return
  }
  await writeAgentSettings(agent, newText)
}

// ─── Command ────────────────────────────────────────────────────────────────

function checkBunAvailable(): boolean {
  try {
    const proc = Bun.spawnSync(["bun", "--version"])
    return proc.exitCode === 0
  } catch {
    return false
  }
}

// ─── Status line configuration ───────────────────────────────────────────────

const STATUS_LINE_CMD = "command -v swiz >/dev/null 2>&1 || exit 0; swiz status-line"

async function installStatusLine(dryRun: boolean): Promise<void> {
  const claudeAgent = AGENTS.find((a) => a.id === "claude")
  if (!claudeAgent) return

  const settingsPath = claudeAgent.settingsPath
  const existing = await readJsonFile(settingsPath)
  const oldText = (await readFileText(settingsPath)).trimEnd()

  const current = existing.statusLine as Record<string, unknown> | undefined
  const alreadySet = current?.command === STATUS_LINE_CMD

  if (dryRun) {
    if (alreadySet) {
      console.log(`  ${DIM}statusLine: already configured${RESET}\n`)
    } else {
      console.log(`  ${GREEN}+ statusLine: swiz status-line${RESET}\n`)
      const proposed = { ...existing, statusLine: { type: "command", command: STATUS_LINE_CMD } }
      const newText = JSON.stringify(proposed, null, 2)
      console.log(formatUnifiedDiff(settingsPath, oldText, newText))
    }
    return
  }

  if (alreadySet) {
    console.log(`  ${DIM}statusLine: already configured${RESET}\n`)
    return
  }

  await backup(settingsPath)
  const proposed = { ...existing, statusLine: { type: "command", command: STATUS_LINE_CMD } }
  await Bun.write(settingsPath, `${JSON.stringify(proposed, null, 2)}\n`)
  console.log(`  ${GREEN}✓${RESET} statusLine configured in ${settingsPath}\n`)
}

// ─── PR poll LaunchAgent ─────────────────────────────────────────────────────

const PR_POLL_LABEL = SWIZ_PR_POLL_LABEL
const PR_POLL_PLIST = getLaunchAgentPlistPath(PR_POLL_LABEL)

function buildPrPollPlist(bunBin: string, indexPath: string): string {
  const logPath = swizPrPollLogPath()
  const errorLogPath = swizPrPollErrorLogPath()
  const projectCwd = process.cwd()
  const shellQuotedCwd = projectCwd.replaceAll("'", "'\"'\"'")

  // Route prPoll through daemon dispatch first; fallback to standalone dispatch.
  const payload = JSON.stringify({ cwd: projectCwd })
  const dispatchUrl = "http://localhost:7943/dispatch?event=prPoll&hookEventName=prPoll"
  const curlCmd = `curl -sSf -X POST "${dispatchUrl}" -d '${payload}' -H 'Content-Type: application/json'`
  const fallbackCmd = `cd '${shellQuotedCwd}' && '${bunBin}' '${indexPath}' dispatch prPoll`

  const cmd = `${curlCmd} > /dev/null 2>>${errorLogPath} || ${fallbackCmd} >>${logPath} 2>>${errorLogPath}`

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${PR_POLL_LABEL}</string>
\t<key>ProgramArguments</key>
\t<array>
\t\t<string>/bin/sh</string>
\t\t<string>-c</string>
\t\t<string>${cmd}</string>
\t</array>
\t<key>StartInterval</key>
\t<integer>300</integer>
\t<key>RunAtLoad</key>
\t<false/>
\t<key>StandardOutPath</key>
\t<string>${logPath}</string>
\t<key>StandardErrorPath</key>
\t<string>${errorLogPath}</string>
</dict>
</plist>
`
}

async function installPrPoll(dryRun: boolean): Promise<void> {
  const bunBin = Bun.which("bun") ?? "bun"
  const indexPath = Bun.main
  const plistContent = buildPrPollPlist(bunBin, indexPath)

  const existingContent = await readFileText(PR_POLL_PLIST)
  const alreadyCurrent = existingContent.trim() === plistContent.trim()

  if (dryRun) {
    if (alreadyCurrent) {
      console.log(`  ${DIM}prPoll LaunchAgent: already installed${RESET}\n`)
    } else {
      console.log(`  ${GREEN}+ prPoll LaunchAgent: ${PR_POLL_PLIST}${RESET}\n`)
      console.log(formatUnifiedDiff(PR_POLL_PLIST, existingContent, plistContent))
    }
    return
  }

  if (alreadyCurrent) {
    console.log(`  ${DIM}prPoll LaunchAgent: already installed${RESET}\n`)
    return
  }

  await Bun.write(PR_POLL_PLIST, plistContent)
  unloadLaunchAgentSync(PR_POLL_PLIST)
  const loadExitCode = loadLaunchAgentSync(PR_POLL_PLIST)
  if (loadExitCode !== 0) {
    console.log(
      `  ${YELLOW}⚠${RESET} prPoll LaunchAgent written but launchctl load failed — reload manually:\n` +
        `    launchctl load ${PR_POLL_PLIST}\n`
    )
  } else {
    console.log(`  ${GREEN}✓${RESET} prPoll LaunchAgent installed and loaded:\n`)
    console.log(`    ${DIM}${PR_POLL_PLIST}${RESET}`)
    console.log(`    Polls every 5 minutes for new PR review/comment notifications.\n`)
  }
}

// ─── Git mergetool configuration ─────────────────────────────────────────────

async function installMergeTool(dryRun: boolean): Promise<void> {
  const configs = [
    ["merge.tool", "swiz"],
    ["mergetool.swiz.cmd", 'swiz mergetool "$BASE" "$LOCAL" "$REMOTE" "$MERGED"'],
    ["mergetool.swiz.trustExitCode", "true"],
  ]

  if (dryRun) {
    console.log("  Git mergetool configuration (global):\n")
    for (const [key, value] of configs) {
      console.log(`    ${GREEN}+ git config --global ${key} ${value}${RESET}`)
    }
    console.log()
    return
  }

  for (const [key, value] of configs) {
    if (!key || !value) continue
    const proc = Bun.spawnSync(["git", "config", "--global", key, value])
    if (proc.exitCode !== 0) {
      throw new Error(`Failed to set git config ${key}`)
    }
  }

  console.log(`  ${GREEN}✓${RESET} Git mergetool configured globally:\n`)
  console.log(`    merge.tool = swiz`)
  console.log(`    mergetool.swiz.cmd = swiz mergetool "$BASE" "$LOCAL" "$REMOTE" "$MERGED"`)
  console.log(`    mergetool.swiz.trustExitCode = true\n`)
}

// ─── Command ────────────────────────────────────────────────────────────────

interface InstallRunOptions {
  jsonOutput: boolean
  dryRun: boolean
  mergeTool: boolean
  statusLine: boolean
  prPoll: boolean
  targets: AgentDef[]
}

function parseInstallRunOptions(args: string[]): InstallRunOptions {
  const jsonOutput = args.includes("--json")
  return {
    jsonOutput,
    dryRun: jsonOutput || args.includes("--dry-run"),
    mergeTool: args.includes("--merge-tool"),
    statusLine: args.includes("--status-line"),
    prPoll: args.includes("--pr-poll"),
    targets: getAgentByFlag(args),
  }
}

function hasAnyAgentFlag(args: string[]): boolean {
  return args.some((arg) => AGENTS.some((agent) => `--${agent.id}` === arg))
}

function shouldInstallHooks(args: string[], opts: InstallRunOptions): boolean {
  return !opts.mergeTool || hasAnyAgentFlag(args)
}

async function runOptionalInstallSteps(opts: InstallRunOptions): Promise<void> {
  if (opts.mergeTool) await installMergeTool(opts.dryRun)
  if (opts.statusLine) await installStatusLine(opts.dryRun)
  if (opts.prPoll) await installPrPoll(opts.dryRun)
}

function logPluginResults(
  pluginResults: Awaited<ReturnType<typeof loadAllPlugins>>,
  jsonOutput: boolean
): boolean {
  if (jsonOutput) {
    console.log(JSON.stringify(pluginResultsToJson(pluginResults), null, 2))
    return true
  }

  console.log(`  Plugins:`)
  for (const result of pluginResults) {
    if (result.errorCode) {
      console.log(`    ${YELLOW}⚠ ${result.name}${RESET} (${pluginErrorHint(result.errorCode)})`)
      continue
    }

    const hookCount = result.hooks.reduce((n, g) => n + g.hooks.length, 0)
    console.log(`    ${GREEN}✓${RESET} ${result.name} (${hookCount} hook(s))`)
  }
  console.log()
  return false
}

async function processPluginOutput(cwd: string, jsonOutput: boolean): Promise<boolean> {
  const projectSettings = await readProjectSettings(cwd)
  if (projectSettings?.plugins?.length) {
    const pluginResults = await loadAllPlugins(projectSettings.plugins, cwd)
    return logPluginResults(pluginResults, jsonOutput)
  }

  if (jsonOutput) {
    console.log("[]")
    return true
  }

  return false
}

async function installHooksForTargets(args: string[], opts: InstallRunOptions): Promise<boolean> {
  if (!shouldInstallHooks(args, opts)) return false

  console.log(`  Hooks: ${HOOKS_DIR}`)
  console.log(`  Agents: ${opts.targets.map((a) => a.name).join(", ")}\n`)

  const shouldReturn = await processPluginOutput(process.cwd(), opts.jsonOutput)
  if (shouldReturn) return true

  for (const agent of opts.targets) {
    await installAgent(agent, opts.dryRun)
  }
  return false
}

export const installCommand: Command = {
  name: "install",
  description: "Install swiz hooks into agent settings",
  usage: `swiz install [${AGENTS.map((a) => `--${a.id}`).join("] [")}] [--dry-run] [--merge-tool]`,
  options: [
    ...AGENTS.map((a) => ({ flags: `--${a.id}`, description: `Install for ${a.name} only` })),
    { flags: "--dry-run", description: "Preview changes without writing to disk" },
    { flags: "--merge-tool", description: "Configure swiz as the global Git mergetool" },
    { flags: "--status-line", description: "Install swiz status-line into Claude Code settings" },
    {
      flags: "--pr-poll",
      description: "Install LaunchAgent that polls PR reviews/comments every 5min",
    },
    { flags: "--json", description: "Output plugin status as JSON (implies --dry-run)" },
    { flags: "(no flags)", description: "Install for all detected agents" },
  ],
  async run(args) {
    const opts = parseInstallRunOptions(args)

    if (!checkBunAvailable()) {
      throw new Error(
        `\n  ${RED}✗ bun is not installed or not on PATH.${RESET}\n` +
          `  swiz hooks require bun to run. Install it first:\n\n` +
          `    curl -fsSL https://bun.sh/install | bash`
      )
    }

    console.log(`\n  swiz install${opts.dryRun ? " (dry run)" : ""}\n`)
    await runOptionalInstallSteps(opts)
    if (await installHooksForTargets(args, opts)) return
    if (opts.dryRun) {
      console.log("  No changes written.\n")
    }
  },
}
