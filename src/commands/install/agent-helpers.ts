import { orderBy } from "lodash-es"
import type { AgentDef } from "../../agents.ts"
import { BOLD, CYAN, DIM, GREEN, RED, RESET, YELLOW } from "../../ansi.ts"
import { isManagedSwizCommand, isSwizCommand, LEGACY_HOOK_DIRS } from "../../swiz-hook-commands.ts"
import { formatUnifiedDiff } from "../../utils/diff-utils.ts"
import { backup, readFileText, readJsonFile } from "../../utils/file-utils.ts"
import { collectCommands, mergeConfig } from "./config-helpers.ts"

export function logUnconfigurableAgent(agent: AgentDef): void {
  console.log(`  ${BOLD}${agent.name}${RESET} → ${YELLOW}hooks not yet user-configurable${RESET}`)
  console.log(
    `  ${DIM}${agent.name} ships user hook events (Stop, UserPromptSubmit, SessionStart) plus internal tool hooks (BeforeToolUse, AfterToolUse) but no`
  )
  console.log(
    `  settings file format for user hooks. Tool mappings are tracked for when this ships.${RESET}\n`
  )
}

export function extractOldHooks(
  existing: Record<string, any>,
  agent: AgentDef
): Record<string, any> {
  const raw = agent.wrapsHooks
    ? (((existing as Record<string, any>).hooks as Record<string, any>) ?? {})
    : ((existing[agent.hooksKey] as Record<string, any>) ?? {})
  return typeof raw === "object" && !Array.isArray(raw) ? raw : {}
}

export function buildProposedAgentSettings(
  existing: Record<string, any>,
  agent: AgentDef,
  config: Record<string, unknown[]>
): string {
  const proposed = agent.wrapsHooks
    ? { ...agent.wrapsHooks, hooks: config }
    : { ...existing, [agent.hooksKey]: config }
  return JSON.stringify(proposed, null, 2)
}

export function reportDryRunAgentInstall(
  agent: AgentDef,
  oldHooks: Record<string, any>,
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

  const sections: Array<{
    items: string[] | Set<string>
    color: string
    prefix: string
    label: string
  }> = [
    { items: added, color: GREEN, prefix: "+", label: "hook(s) added" },
    { items: removed, color: RED, prefix: "-", label: "hook(s) removed" },
    { items: legacyCmds, color: YELLOW, prefix: "↻", label: "legacy hook(s) replaced by swiz" },
  ]
  for (const { items, color, prefix, label } of sections) {
    const arr = Array.isArray(items) ? items : [...items]
    if (arr.length === 0) continue
    console.log(`    ${color}${prefix} ${arr.length} ${label}:${RESET}`)
    for (const c of arr) console.log(`      ${color}${prefix} ${c}${RESET}`)
    console.log()
  }
  if (kept.length) console.log(`    ${DIM}  ${kept.length} swiz hook(s) unchanged${RESET}\n`)
  if (userCmds.size) console.log(`    ${CYAN}  ${userCmds.size} user hook(s) preserved${RESET}\n`)
  if (!oldText && newText)
    console.log(`    ${GREEN}+ new file (${newText.split("\n").length} lines)${RESET}\n`)

  console.log(formatUnifiedDiff(agent.settingsPath, oldText, newText))
}

export async function writeAgentSettings(agent: AgentDef, newText: string): Promise<void> {
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

export async function installAgent(agent: AgentDef, dryRun: boolean): Promise<void> {
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
