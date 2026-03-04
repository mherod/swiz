import { dirname, join } from "node:path"
import { AGENTS, type AgentDef, getAgentByFlag, translateEvent } from "../agents.ts"
import { DISPATCH_TIMEOUTS, manifest } from "../manifest.ts"
import { loadAllPlugins } from "../plugins.ts"
import { readProjectSettings } from "../settings.ts"
import type { Command } from "../types.ts"

const SWIZ_ROOT = dirname(Bun.main)
const HOOKS_DIR = join(SWIZ_ROOT, "hooks")

// ─── ANSI ────────────────────────────────────────────────────────────────────

const RED = "\x1b[31m"
const GREEN = "\x1b[32m"
const DIM = "\x1b[2m"
const CYAN = "\x1b[36m"
const RESET = "\x1b[0m"
const BOLD = "\x1b[1m"

// ─── Config generators ──────────────────────────────────────────────────────
// manifest and DISPATCH_TIMEOUTS imported from ../manifest.ts

// Paths that swiz supersedes — hooks at these locations are replaced by swiz equivalents.
const LEGACY_HOOK_DIRS = ["$HOME/.claude/hooks/", `${process.env.HOME}/.claude/hooks/`]

function isSwizCommand(cmd: unknown): boolean {
  if (typeof cmd !== "string") return false
  return (
    cmd.includes(HOOKS_DIR) ||
    cmd.includes(join(SWIZ_ROOT, "index.ts")) ||
    cmd.includes("swiz dispatch")
  )
}

function isLegacySwizCommand(cmd: unknown): boolean {
  if (typeof cmd !== "string") return false
  return LEGACY_HOOK_DIRS.some((dir) => cmd.includes(dir))
}

function isManagedCommand(cmd: unknown): boolean {
  return isSwizCommand(cmd) || isLegacySwizCommand(cmd)
}

// Strip swiz-managed and legacy hooks from a nested matcher group array,
// returning only user-defined entries.
function stripManagedFromNestedGroups(groups: unknown[]): unknown[] {
  const kept: unknown[] = []
  for (const group of groups) {
    const g = group as Record<string, unknown>
    if (Array.isArray(g.hooks)) {
      const userHooks = g.hooks.filter(
        (h) => !isManagedCommand((h as Record<string, unknown>).command)
      )
      if (userHooks.length > 0) {
        kept.push({ ...g, hooks: userHooks })
      }
    } else if (!isManagedCommand(g.command)) {
      kept.push(group)
    }
  }
  return kept
}

// Strip swiz-managed and legacy hooks from a flat hook array.
function stripManagedFromFlatList(entries: unknown[]): unknown[] {
  return entries.filter((e) => !isManagedCommand((e as Record<string, unknown>).command))
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

  // Add one dispatch entry per unique canonical event
  const seenEvents = new Set<string>()
  for (const group of manifest) {
    if (seenEvents.has(group.event)) continue
    seenEvents.add(group.event)

    const eventName = translateEvent(group.event, agent)
    if (!merged[eventName]) merged[eventName] = []

    const timeout = DISPATCH_TIMEOUTS[group.event] ?? 30
    const cmd = `command -v swiz >/dev/null 2>&1 || exit 0; swiz dispatch ${group.event} ${eventName}`
    merged[eventName].push({
      hooks: [{ type: "command", command: cmd, timeout, statusMessage: "Swizzling..." }],
    })
  }

  return merged
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

  // Add one dispatch entry per unique canonical event
  const seenEvents = new Set<string>()
  for (const group of manifest) {
    if (seenEvents.has(group.event)) continue
    seenEvents.add(group.event)

    const eventName = translateEvent(group.event, agent)
    if (!merged[eventName]) merged[eventName] = []

    const timeout = DISPATCH_TIMEOUTS[group.event] ?? 30
    const cmd = `command -v swiz >/dev/null 2>&1 || exit 0; swiz dispatch ${group.event} ${eventName}`
    merged[eventName].push({ command: cmd, timeout, statusMessage: "Swizzling..." })
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

function collectCommands(hooks: Record<string, unknown>): Set<string> {
  const cmds = new Set<string>()
  for (const entries of Object.values(hooks)) {
    if (!Array.isArray(entries)) continue
    for (const entry of entries) {
      const e = entry as Record<string, unknown>
      if (e.command) cmds.add(String(e.command))
      if (Array.isArray(e.hooks)) {
        for (const h of e.hooks) {
          const hh = h as Record<string, unknown>
          if (hh.command) cmds.add(String(hh.command))
        }
      }
    }
  }
  return cmds
}

// ─── Per-agent install ───────────────────────────────────────────────────────

async function installAgent(agent: AgentDef, dryRun: boolean) {
  if (!agent.hooksConfigurable) {
    const YELLOW = "\x1b[33m"
    console.log(`  ${BOLD}${agent.name}${RESET} → ${YELLOW}hooks not yet user-configurable${RESET}`)
    console.log(`  ${DIM}${agent.name} has hooks infrastructure (AfterAgent, AfterToolUse) but no`)
    console.log(
      `  settings file format for user hooks. Tool mappings are tracked for when this ships.${RESET}\n`
    )
    return
  }

  console.log(`  ${BOLD}${agent.name}${RESET} → ${agent.settingsPath}\n`)

  const existing = await readJsonFile(agent.settingsPath)
  const oldText = (await readFileText(agent.settingsPath)).trimEnd()

  // For wrapped configs (Cursor), hooks live inside the wrapper
  const oldHooksRaw = agent.wrapsHooks
    ? (((existing as Record<string, unknown>).hooks as Record<string, unknown>) ?? {})
    : ((existing[agent.hooksKey] as Record<string, unknown>) ?? {})
  const oldHooks = typeof oldHooksRaw === "object" && !Array.isArray(oldHooksRaw) ? oldHooksRaw : {}

  const config = mergeConfig(agent, oldHooks)

  let proposed: Record<string, unknown>
  let newText: string

  if (agent.wrapsHooks) {
    proposed = { ...agent.wrapsHooks, hooks: config }
    newText = JSON.stringify(proposed, null, 2)
  } else {
    proposed = { ...existing, [agent.hooksKey]: config }
    newText = JSON.stringify(proposed, null, 2)
  }

  if (dryRun) {
    const oldCmds = collectCommands(oldHooks)
    const allNewCmds = collectCommands(config)
    const swizCmds = new Set([...allNewCmds].filter((c) => isSwizCommand(c)))
    const userCmds = new Set([...oldCmds].filter((c) => !isManagedCommand(c)))
    const legacyCmds = [...oldCmds].filter((c) => LEGACY_HOOK_DIRS.some((d) => c.includes(d)))

    const added = [...swizCmds].filter((c) => !oldCmds.has(c))
    const removed = [...oldCmds].filter((c) => isSwizCommand(c) && !swizCmds.has(c))
    const kept = [...swizCmds].filter((c) => oldCmds.has(c))

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
      const YELLOW = "\x1b[33m"
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
    return
  }

  await backup(agent.settingsPath)
  await Bun.write(agent.settingsPath, `${newText}\n`)

  // Verify the write persisted (some agents watch and revert their settings)
  await new Promise((r) => setTimeout(r, 1500))
  const verify = await readFileText(agent.settingsPath)
  const persisted = verify.trimEnd() === newText

  if (persisted) {
    console.log(`    ✓ written (backup at ${agent.settingsPath}.bak)\n`)
  } else {
    const YELLOW = "\x1b[33m"
    console.log(`    ✓ written, but ${YELLOW}reverted by running ${agent.name} process${RESET}`)
    console.log(
      `    ${DIM}Close all ${agent.name} sessions first, then re-run swiz install.${RESET}\n`
    )
  }
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

export const installCommand: Command = {
  name: "install",
  description: "Install swiz hooks into agent settings",
  usage: `swiz install [${AGENTS.map((a) => `--${a.id}`).join("] [")}] [--dry-run] [--merge-tool]`,
  options: [
    ...AGENTS.map((a) => ({ flags: `--${a.id}`, description: `Install for ${a.name} only` })),
    { flags: "--dry-run", description: "Preview changes without writing to disk" },
    { flags: "--merge-tool", description: "Configure swiz as the global Git mergetool" },
    { flags: "(no flags)", description: "Install for all detected agents" },
  ],
  async run(args) {
    const dryRun = args.includes("--dry-run")
    const mergeTool = args.includes("--merge-tool")
    const targets = getAgentByFlag(args)

    if (!checkBunAvailable()) {
      throw new Error(
        `\n  ${RED}✗ bun is not installed or not on PATH.${RESET}\n` +
          `  swiz hooks require bun to run. Install it first:\n\n` +
          `    curl -fsSL https://bun.sh/install | bash`
      )
    }

    console.log(`\n  swiz install${dryRun ? " (dry run)" : ""}\n`)

    if (mergeTool) {
      await installMergeTool(dryRun)
    }

    // Skip hook installation if only --merge-tool was requested
    if (!mergeTool || args.some((a) => AGENTS.some((ag) => `--${ag.id}` === a))) {
      console.log(`  Hooks: ${HOOKS_DIR}`)
      console.log(`  Agents: ${targets.map((a) => a.name).join(", ")}\n`)

      // Report loaded plugins (dry-run or not)
      const cwd = process.cwd()
      const projectSettings = await readProjectSettings(cwd)
      if (projectSettings?.plugins?.length) {
        const pluginResults = await loadAllPlugins(projectSettings.plugins, cwd)
        const YELLOW = "\x1b[33m"
        console.log(`  Plugins:`)
        for (const result of pluginResults) {
          if (result.error) {
            console.log(`    ${YELLOW}⚠ ${result.name}: ${result.error}${RESET}`)
          } else {
            const hookCount = result.hooks.reduce((n, g) => n + g.hooks.length, 0)
            console.log(`    ${GREEN}✓${RESET} ${result.name} (${hookCount} hook(s))`)
          }
        }
        console.log()
      }

      for (const agent of targets) {
        await installAgent(agent, dryRun)
      }
    }

    if (dryRun) {
      console.log("  No changes written.\n")
    }
  },
}
