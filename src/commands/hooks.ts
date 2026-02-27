import { join } from "node:path"
import { AGENTS, type AgentDef } from "../agents.ts"
import type { Command } from "../types.ts"

// ─── Types ──────────────────────────────────────────────────────────────────

interface HookEntry {
  type?: "command" | "agent" | "prompt"
  command?: string
  prompt?: string
  model?: string
  timeout?: number
  async?: boolean
  statusMessage?: string
  matcher?: string
}

interface HookMatcher {
  matcher?: string
  hooks: HookEntry[]
}

type HooksConfig = Record<string, HookMatcher[]>

interface LoadedSettings {
  source: string
  agent: AgentDef
  hooks: HooksConfig
}

// ─── Normalization ──────────────────────────────────────────────────────────

function normalizeFlatHooks(raw: Record<string, HookEntry[]>): HooksConfig {
  const result: HooksConfig = {}
  for (const [event, entries] of Object.entries(raw)) {
    const groups = new Map<string, HookEntry[]>()
    for (const entry of entries) {
      const key = entry.matcher ?? ""
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(entry)
    }
    result[event] = [...groups.entries()].map(([matcher, hooks]) => ({
      ...(matcher ? { matcher } : {}),
      hooks,
    }))
  }
  return result
}

// ─── Settings loading ───────────────────────────────────────────────────────

function settingsPaths(agent: AgentDef): string[] {
  const paths = [agent.settingsPath]
  if (agent.id === "claude") {
    const HOME = process.env.HOME ?? "~"
    paths.push(join(HOME, ".claude", "settings.local.json"))
    paths.push(".claude/settings.json")
    paths.push(".claude/settings.local.json")
  } else if (agent.id === "cursor") {
    paths.push(".cursor/hooks.json")
  } else if (agent.id === "gemini") {
    paths.push(".gemini/settings.json")
  }
  return paths
}

async function loadAllSettings(): Promise<LoadedSettings[]> {
  const results: LoadedSettings[] = []

  for (const agent of AGENTS) {
    for (const path of settingsPaths(agent)) {
      const resolved = path.startsWith("/") ? path : join(process.cwd(), path)
      const file = Bun.file(resolved)
      if (!(await file.exists())) continue
      try {
        const json = await file.json()
        const raw = json.hooks ?? json[agent.hooksKey]
        if (!raw) continue

        const hooks = agent.configStyle === "flat" ? normalizeFlatHooks(raw) : (raw as HooksConfig)

        results.push({ source: resolved, agent, hooks })
      } catch {}
    }
  }

  return results
}

// ─── Display helpers ────────────────────────────────────────────────────────

function resolveScriptPath(command: string): string | null {
  const expanded = command.replace(/\$HOME/g, process.env.HOME ?? "~")
  const parts = expanded.split(/\s+/)
  const script = parts.find((p) => /\.(sh|ts|js)$/.test(p))
  return script ?? null
}

function shortName(command: string): string {
  const script = resolveScriptPath(command)
  if (script) return script.split("/").pop()!
  if (command.length > 60) return command.slice(0, 57) + "..."
  return command
}

async function listEvents(allSettings: LoadedSettings[]) {
  if (allSettings.length === 0) {
    console.log("No hook settings found.")
    return
  }

  for (const { source, agent, hooks } of allSettings) {
    console.log(`\n  ${agent.name} (${source})\n`)
    for (const [event, matchers] of Object.entries(hooks)) {
      const hookCount = matchers.reduce((n, m) => n + m.hooks.length, 0)
      console.log(`    ${event.padEnd(22)} ${hookCount} hook(s)`)
    }
  }
  console.log()
}

async function showEvent(allSettings: LoadedSettings[], eventName: string) {
  let found = false

  for (const { source, agent, hooks } of allSettings) {
    const key = Object.keys(hooks).find((k) => k.toLowerCase() === eventName.toLowerCase())
    if (!key) continue
    found = true

    const matchers = hooks[key]!
    console.log(`\n  ${key} hooks — ${agent.name} (${source})\n`)

    for (const group of matchers) {
      const matchLabel = group.matcher ? `[${group.matcher}]` : "[*]"
      for (const hook of group.hooks) {
        const flags: string[] = []
        if (hook.timeout) flags.push(`${hook.timeout}s`)
        if (hook.async) flags.push("async")
        if (hook.type === "agent") flags.push(`agent:${hook.model ?? "default"}`)
        const flagStr = flags.length ? ` (${flags.join(", ")})` : ""

        const hookType = hook.type ?? "command"
        if (hookType === "command" && hook.command) {
          console.log(`    ${matchLabel.padEnd(22)} ${shortName(hook.command)}${flagStr}`)
        } else if (hookType === "agent") {
          const label = hook.statusMessage ?? "agent hook"
          console.log(`    ${matchLabel.padEnd(22)} ${label}${flagStr}`)
        } else if (hookType === "prompt" && hook.prompt) {
          const preview = hook.prompt.length > 50 ? hook.prompt.slice(0, 47) + "..." : hook.prompt
          console.log(`    ${matchLabel.padEnd(22)} [prompt] ${preview}${flagStr}`)
        }
      }
    }
  }

  if (!found) {
    throw new Error(
      `No hooks found for event: ${eventName}\nRun "swiz hooks" to see available events.`
    )
  }
  console.log()
}

async function showScript(allSettings: LoadedSettings[], scriptQuery: string) {
  for (const { hooks } of allSettings) {
    for (const matchers of Object.values(hooks)) {
      for (const group of matchers) {
        for (const hook of group.hooks) {
          if (hook.type !== "command" && hook.type !== undefined) continue
          if (!hook.command) continue
          const name = shortName(hook.command)
          if (!name.includes(scriptQuery)) continue

          const scriptPath = resolveScriptPath(hook.command)
          if (!scriptPath) {
            console.log(`  Inline command: ${hook.command}\n`)
            return
          }

          const file = Bun.file(scriptPath)
          if (!(await file.exists())) {
            throw new Error(`Script not found: ${scriptPath}`)
          }

          console.log(await file.text())
          return
        }
      }
    }
  }

  throw new Error(`No hook script matching: ${scriptQuery}`)
}

// ─── Command ────────────────────────────────────────────────────────────────

export const hooksCommand: Command = {
  name: "hooks",
  description: "Inspect agent hooks (Claude Code, Cursor, Gemini CLI)",
  usage: "swiz hooks [event] [script-name]",
  async run(args) {
    const allSettings = await loadAllSettings()
    const [first, second] = args

    if (!first) {
      await listEvents(allSettings)
    } else if (!second) {
      await showEvent(allSettings, first)
    } else {
      await showScript(allSettings, second)
    }
  },
}
