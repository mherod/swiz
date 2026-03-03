import { dirname, join } from "node:path"
import { AGENTS, type AgentDef, getAgentByFlag } from "../agents.ts"
import type { Command } from "../types.ts"

const SWIZ_ROOT = dirname(Bun.main)
const HOOKS_DIR = join(SWIZ_ROOT, "hooks")

const BOLD = "\x1b[1m"
const DIM = "\x1b[2m"
const RED = "\x1b[31m"
const GREEN = "\x1b[32m"
const RESET = "\x1b[0m"

function removeSwizHooks(obj: unknown): unknown {
  if (Array.isArray(obj)) {
    return obj.map((item) => removeSwizHooks(item)).filter((item) => item !== null)
  }
  if (obj && typeof obj === "object") {
    const rec = obj as Record<string, unknown>

    if (typeof rec.command === "string" && rec.command.includes(HOOKS_DIR)) {
      return null
    }

    if (Array.isArray(rec.hooks)) {
      const filtered = rec.hooks.filter((h) => {
        const hh = h as Record<string, unknown>
        return !(typeof hh.command === "string" && hh.command.includes(HOOKS_DIR))
      })
      if (filtered.length === 0) return null
      return { ...rec, hooks: filtered }
    }

    const result: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(rec)) {
      result[k] = removeSwizHooks(v)
    }
    return result
  }
  return obj
}

function cleanEmptyEvents(hooks: Record<string, unknown[]>): Record<string, unknown[]> {
  const result: Record<string, unknown[]> = {}
  for (const [event, entries] of Object.entries(hooks)) {
    const cleaned = entries.filter((e) => e !== null)
    if (cleaned.length > 0) result[event] = cleaned
  }
  return result
}

async function uninstallAgent(agent: AgentDef, dryRun: boolean) {
  if (!agent.hooksConfigurable) {
    console.log(
      `  ${BOLD}${agent.name}${RESET}: ${DIM}hooks not user-configurable — skipped${RESET}\n`
    )
    return
  }

  const file = Bun.file(agent.settingsPath)
  if (!(await file.exists())) {
    console.log(`  ${BOLD}${agent.name}${RESET}: ${DIM}no settings file${RESET}\n`)
    return
  }

  const json = await file.json()
  const _hooksKey = agent.wrapsHooks ? "hooks" : agent.hooksKey
  const hooks = agent.wrapsHooks ? json.hooks : json[agent.hooksKey]

  if (!hooks || typeof hooks !== "object") {
    console.log(`  ${BOLD}${agent.name}${RESET}: ${DIM}no hooks configured${RESET}\n`)
    return
  }

  const cleaned = cleanEmptyEvents(removeSwizHooks(hooks) as Record<string, unknown[]>)

  let proposed: Record<string, unknown>
  if (agent.wrapsHooks) {
    proposed = { ...agent.wrapsHooks, hooks: cleaned }
  } else {
    proposed = { ...json, [agent.hooksKey]: cleaned }
  }

  const _oldText = JSON.stringify(json, null, 2)
  const newText = JSON.stringify(proposed, null, 2)

  const oldCount = countSwizHooks(hooks as Record<string, unknown>)

  if (oldCount === 0) {
    console.log(`  ${BOLD}${agent.name}${RESET}: ${DIM}no swiz hooks found${RESET}\n`)
    return
  }

  console.log(`  ${BOLD}${agent.name}${RESET}: ${RED}removing ${oldCount} swiz hook(s)${RESET}`)

  if (dryRun) {
    console.log(`    ${DIM}(dry run — no changes)${RESET}\n`)
    return
  }

  await Bun.write(`${agent.settingsPath}.bak`, await file.text())
  await Bun.write(agent.settingsPath, `${newText}\n`)
  console.log(`    ${GREEN}✓${RESET} written (backup at ${agent.settingsPath}.bak)\n`)
}

function countSwizHooks(hooks: Record<string, unknown>): number {
  let count = 0
  for (const entries of Object.values(hooks)) {
    if (!Array.isArray(entries)) continue
    for (const entry of entries) {
      const e = entry as Record<string, unknown>
      if (typeof e.command === "string" && e.command.includes(HOOKS_DIR)) {
        count++
      }
      if (Array.isArray(e.hooks)) {
        for (const h of e.hooks) {
          const hh = h as Record<string, unknown>
          if (typeof hh.command === "string" && hh.command.includes(HOOKS_DIR)) {
            count++
          }
        }
      }
    }
  }
  return count
}

export const uninstallCommand: Command = {
  name: "uninstall",
  description: "Remove swiz hooks from agent settings",
  usage: `swiz uninstall [${AGENTS.map((a) => `--${a.id}`).join("] [")}] [--dry-run]`,
  options: [
    ...AGENTS.map((a) => ({ flags: `--${a.id}`, description: `Uninstall from ${a.name} only` })),
    { flags: "--dry-run", description: "Preview changes without writing to disk" },
    { flags: "(no flags)", description: "Uninstall from all agents" },
  ],
  async run(args) {
    const dryRun = args.includes("--dry-run")
    const targets = getAgentByFlag(args)

    console.log(`\n  swiz uninstall${dryRun ? " (dry run)" : ""}\n`)

    for (const agent of targets) {
      await uninstallAgent(agent, dryRun)
    }
  },
}
