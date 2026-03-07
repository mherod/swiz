import { join } from "node:path"
import { AGENTS, type AgentDef } from "../agents.ts"
import { CYAN as CYAN_H, DIM, RESET as RST } from "../ansi.ts"
import { manifest } from "../manifest.ts"
import { loadAllPlugins, pluginResultsToJson } from "../plugins.ts"
import { readProjectSettings, readSwizSettings, resolveProjectHooks } from "../settings.ts"
import type { Command } from "../types.ts"

async function buildDisabledSet(cwd: string): Promise<Set<string>> {
  const [globalSettings, projectSettings] = await Promise.all([
    readSwizSettings(),
    readProjectSettings(cwd),
  ])
  return new Set([
    ...(globalSettings.disabledHooks ?? []),
    ...(projectSettings?.disabledHooks ?? []),
  ])
}

// ─── Types ──────────────────────────────────────────────────────────────────

interface HookEntry {
  type?: "command" | "agent" | "prompt" | "http"
  command?: string
  prompt?: string
  url?: string
  headers?: Record<string, string>
  allowedEnvVars?: string[]
  model?: string
  timeout?: number
  async?: boolean
  statusMessage?: string
  matcher?: string
  condition?: string
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
  if (command.length > 60) return `${command.slice(0, 57)}...`
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

async function showEvent(allSettings: LoadedSettings[], eventName: string, cwd: string) {
  let found = false
  const disabled = await buildDisabledSet(cwd)

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
        if (hook.condition) flags.push(`if:${hook.condition}`)

        const hookType = hook.type ?? "command"
        if (hookType === "command" && hook.command) {
          const name = shortName(hook.command)
          if (disabled.has(name)) flags.push("disabled")
          const flagStr = flags.length ? ` (${flags.join(", ")})` : ""
          console.log(`    ${matchLabel.padEnd(22)} ${name}${flagStr}`)
        } else if (hookType === "agent") {
          const flagStr = flags.length ? ` (${flags.join(", ")})` : ""
          const label = hook.statusMessage ?? "agent hook"
          console.log(`    ${matchLabel.padEnd(22)} ${label}${flagStr}`)
        } else if (hookType === "prompt" && hook.prompt) {
          const flagStr = flags.length ? ` (${flags.join(", ")})` : ""
          const preview = hook.prompt.length > 50 ? `${hook.prompt.slice(0, 47)}...` : hook.prompt
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

// ─── Source view ─────────────────────────────────────────────────────────────

async function showSources(jsonOutput = false) {
  const cwd = process.cwd()

  // Built-in hooks
  const builtinByEvent = new Map<string, { file: string }[]>()
  for (const group of manifest) {
    const list = builtinByEvent.get(group.event) ?? []
    for (const hook of group.hooks) {
      list.push({ file: hook.file })
    }
    builtinByEvent.set(group.event, list)
  }

  // Plugin hooks
  const projectSettings = await readProjectSettings(cwd)
  const pluginResults = projectSettings?.plugins?.length
    ? await loadAllPlugins(projectSettings.plugins, cwd)
    : []

  if (jsonOutput) {
    console.log(JSON.stringify(pluginResultsToJson(pluginResults), null, 2))
    return
  }

  const failedPlugins = pluginResults.filter((r) => r.errorCode)
  const pluginByEvent = new Map<string, { file: string; plugin: string }[]>()
  for (const result of pluginResults) {
    if (result.errorCode) continue
    for (const group of result.hooks) {
      const list = pluginByEvent.get(group.event) ?? []
      for (const hook of group.hooks) {
        list.push({ file: hook.file, plugin: result.name })
      }
      pluginByEvent.set(group.event, list)
    }
  }

  // Project-local hooks
  const GREEN_H = "\x1b[32m"
  const localByEvent = new Map<string, { file: string }[]>()
  if (projectSettings?.hooks?.length) {
    const { resolved } = resolveProjectHooks(projectSettings.hooks, cwd)
    for (const group of resolved) {
      const list = localByEvent.get(group.event) ?? []
      for (const hook of group.hooks) {
        list.push({ file: hook.file })
      }
      localByEvent.set(group.event, list)
    }
  }

  const allEvents = new Set([
    ...builtinByEvent.keys(),
    ...pluginByEvent.keys(),
    ...localByEvent.keys(),
  ])

  console.log("\n  Hook sources:\n")
  for (const event of [...allEvents].sort()) {
    const builtins = builtinByEvent.get(event) ?? []
    const plugins = pluginByEvent.get(event) ?? []
    const locals = localByEvent.get(event) ?? []
    console.log(`  ${event} (${builtins.length + plugins.length + locals.length})`)
    for (const h of builtins) {
      const name = h.file.split("/").pop() ?? h.file
      console.log(`    ${DIM}built-in${RST}  ${name}`)
    }
    for (const h of plugins) {
      const name = h.file.split("/").pop() ?? h.file
      console.log(`    ${CYAN_H}${h.plugin}${RST}  ${name}`)
    }
    for (const h of locals) {
      const name = h.file.split("/").pop() ?? h.file
      console.log(`    ${GREEN_H}project${RST}   ${name}`)
    }
  }

  if (failedPlugins.length > 0) {
    const YELLOW_H = "\x1b[33m"
    console.log(`\n  Failed plugins:\n`)
    for (const r of failedPlugins) {
      console.log(`    ${YELLOW_H}⚠ ${r.name}${RST}  ${r.errorCode}`)
    }
  }
  console.log()
}

// ─── Command ────────────────────────────────────────────────────────────────

export const hooksCommand: Command = {
  name: "hooks",
  description: "Inspect agent hooks (Claude Code, Cursor, Gemini CLI)",
  usage: "swiz hooks [--source] [--json] [event] [script-name]",
  options: [
    { flags: "(no args)", description: "List all hook events and their hook counts" },
    { flags: "--source", description: "Show origin (built-in / plugin) for every hook" },
    { flags: "--json", description: "Output plugin status as JSON (use with --source)" },
    { flags: "<event>", description: "Show hooks registered for a specific event name" },
    { flags: "<event> <script>", description: "Print the source of a hook script by name" },
  ],
  async run(args) {
    const jsonOutput = args.includes("--json")

    if (args.includes("--source") || jsonOutput) {
      await showSources(jsonOutput)
      return
    }

    const allSettings = await loadAllSettings()
    const [first, second] = args

    if (!first) {
      await listEvents(allSettings)
    } else if (!second) {
      await showEvent(allSettings, first, process.cwd())
    } else {
      await showScript(allSettings, second)
    }
  },
}
