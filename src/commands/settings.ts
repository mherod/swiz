import { dirname, join } from "node:path"
import {
  getEffectiveSwizSettings,
  getSwizSettingsPath,
  readSwizSettings,
  writeSwizSettings,
} from "../settings.ts"
import { findSessions, projectKeyFromCwd } from "../transcript-utils.ts"
import type { Command } from "../types.ts"

type BooleanSettingKey = "autoContinue" | "pushGate" | "sandboxedEdits" | "speak"
type NumericSettingKey = "prAgeGateMinutes"
type SettingKey = BooleanSettingKey | NumericSettingKey
type Action = "show" | "enable" | "disable" | "set"

interface ParsedSettingsArgs {
  action: Action
  settingArg?: string
  settingValue?: string
  targetDir: string
  sessionRequested: boolean
  sessionQuery: string | null
}

const HOME = process.env.HOME ?? "~"
const PROJECTS_DIR = join(HOME, ".claude", "projects")

function usage(): string {
  return (
    "Usage: swiz settings [show | enable <setting> | disable <setting> | set <setting> <value>] [--session [id]] [--dir <path>]\n" +
    "Supported settings: auto-continue, push-gate, sandboxed-edits, speak, pr-age-gate (minutes, 0 to disable)"
  )
}

function parseSetting(raw: string | undefined): SettingKey {
  if (!raw) throw new Error(`Missing setting name.\n${usage()}`)
  const value = raw.trim().toLowerCase()
  if (value === "auto-continue" || value === "autocontinue" || value === "auto_continue") {
    return "autoContinue"
  }
  if (
    value === "pr-age-gate" ||
    value === "pragegate" ||
    value === "pr_age_gate" ||
    value === "pragegateminutes" ||
    value === "pr-age-gate-minutes"
  ) {
    return "prAgeGateMinutes"
  }
  if (value === "push-gate" || value === "pushgate" || value === "push_gate") {
    return "pushGate"
  }
  if (value === "sandboxed-edits" || value === "sandboxededits" || value === "sandboxed_edits") {
    return "sandboxedEdits"
  }
  if (value === "speak" || value === "tts") {
    return "speak"
  }
  throw new Error(`Unknown setting: ${raw}\n${usage()}`)
}

function isNumericSetting(key: SettingKey): key is NumericSettingKey {
  return key === "prAgeGateMinutes"
}

function parseSettingsArgs(args: string[]): ParsedSettingsArgs {
  const positionals: string[] = []
  let targetDir = process.cwd()
  let sessionRequested = false
  let sessionQuery: string | null = null

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg) continue
    const next = args[i + 1]

    if (arg === "--dir" || arg === "-d") {
      if (!next || next.startsWith("-")) throw new Error(`Missing value for ${arg}.\n${usage()}`)
      targetDir = next
      i++
      continue
    }

    if (arg === "--session" || arg === "-s") {
      sessionRequested = true
      if (next && !next.startsWith("-")) {
        sessionQuery = next
        i++
      }
      continue
    }

    positionals.push(arg)
  }

  const rawAction = (positionals[0] ?? "show").toLowerCase()
  if (
    rawAction !== "show" &&
    rawAction !== "enable" &&
    rawAction !== "disable" &&
    rawAction !== "set"
  ) {
    throw new Error(`Unknown subcommand: ${positionals[0]}\n${usage()}`)
  }

  return {
    action: rawAction as Action,
    settingArg: positionals[1],
    settingValue: positionals[2],
    targetDir,
    sessionRequested,
    sessionQuery,
  }
}

async function resolveSessionId(query: string | null, targetDir: string): Promise<string> {
  const projectKey = projectKeyFromCwd(targetDir)
  const projectDir = join(PROJECTS_DIR, projectKey)
  const sessions = await findSessions(projectDir)

  if (sessions.length === 0) {
    throw new Error(`No sessions found for: ${targetDir}\n(looked in: ${projectDir})`)
  }

  if (!query) return sessions[0]!.id

  const match = sessions.find((s) => s.id.startsWith(query))
  if (match) return match.id

  const available = sessions.map((s) => `  ${s.id}`).join("\n")
  throw new Error(`No session matching: ${query}\nAvailable sessions:\n${available}`)
}

function printSettings(
  effective: {
    autoContinue: boolean
    prAgeGateMinutes: number
    pushGate: boolean
    sandboxedEdits: boolean
    speak: boolean
    source: "global" | "session"
  },
  path: string | null,
  fileExists: boolean,
  sessionId: string | null
): void {
  console.log("\n  swiz settings\n")
  if (!path) {
    console.log("  config: unavailable (HOME not set)")
  } else {
    const sourceLabel = fileExists ? "custom" : "defaults"
    console.log(`  config: ${path} (${sourceLabel})`)
  }
  if (sessionId) console.log(`  scope: session ${sessionId}`)
  const scopeLabel = effective.source === "session" ? "session override" : "global/default"
  console.log(
    `  auto-continue:   ${effective.autoContinue ? "enabled" : "disabled"} (${scopeLabel})`
  )
  const ageGateLabel =
    effective.prAgeGateMinutes > 0 ? `${effective.prAgeGateMinutes} minutes` : "disabled"
  console.log(`  pr-age-gate:     ${ageGateLabel} (global)`)
  console.log(`  push-gate:       ${effective.pushGate ? "enabled" : "disabled"} (global)`)
  console.log(`  sandboxed-edits: ${effective.sandboxedEdits ? "enabled" : "disabled"} (global)`)
  console.log(`  speak:           ${effective.speak ? "enabled" : "disabled"} (global)\n`)
}

async function showSettings(parsed: ParsedSettingsArgs): Promise<void> {
  const sessionId = parsed.sessionRequested
    ? await resolveSessionId(parsed.sessionQuery, parsed.targetDir)
    : null
  const settings = await readSwizSettings({ strict: true })
  const effective = getEffectiveSwizSettings(settings, sessionId)
  const path = getSwizSettingsPath()
  const fileExists = path ? await Bun.file(path).exists() : false
  printSettings(effective, path, fileExists, sessionId)
}

async function setBooleanSetting(enabled: boolean, parsed: ParsedSettingsArgs): Promise<void> {
  const key = parseSetting(parsed.settingArg)
  if (isNumericSetting(key)) {
    throw new Error(
      `"${parsed.settingArg}" is a numeric setting. Use: swiz settings set ${parsed.settingArg} <value>\n${usage()}`
    )
  }
  const sessionId = parsed.sessionRequested
    ? await resolveSessionId(parsed.sessionQuery, parsed.targetDir)
    : null
  const current = await readSwizSettings({ strict: true })
  const next = sessionId
    ? {
        ...current,
        sessions: {
          ...current.sessions,
          [sessionId]: {
            ...(current.sessions[sessionId] ?? { autoContinue: current.autoContinue }),
            [key]: enabled,
          },
        },
      }
    : { ...current, [key]: enabled }
  const path = await writeSwizSettings(next)
  console.log(
    `\n  ${enabled ? "Enabled" : "Disabled"} ${parsed.settingArg ?? key}${sessionId ? ` for session ${sessionId}` : ""}`
  )
  console.log(`  Saved: ${path}\n`)

  // Test TTS immediately when enabling speak
  if (enabled && key === "speak") {
    const speakScript = join(dirname(Bun.main), "hooks", "speak.ts")
    try {
      const proc = Bun.spawn(["bun", speakScript, "TTS enabled"], {
        stdout: "pipe",
        stderr: "pipe",
      })
      await proc.exited
      // Silent failure is OK — if TTS doesn't work, user discovers it when assistant speaks
    } catch {
      // Ignore errors during verification
    }
  }
}

async function setNumericSetting(parsed: ParsedSettingsArgs): Promise<void> {
  const key = parseSetting(parsed.settingArg)
  if (!parsed.settingValue) {
    throw new Error(
      `Missing value. Usage: swiz settings set ${parsed.settingArg} <number>\n${usage()}`
    )
  }
  const value = parseInt(parsed.settingValue, 10)
  if (isNaN(value) || value < 0) {
    throw new Error(
      `Invalid value "${parsed.settingValue}". Must be a non-negative integer.\n${usage()}`
    )
  }
  const current = await readSwizSettings({ strict: true })
  const next = { ...current, [key]: value }
  const path = await writeSwizSettings(next)
  const label = key === "prAgeGateMinutes" && value === 0 ? "disabled" : `${value}`
  console.log(`\n  Set ${parsed.settingArg} = ${label}`)
  console.log(`  Saved: ${path}\n`)
}

export const settingsCommand: Command = {
  name: "settings",
  description: "View and modify swiz global and per-session settings",
  usage:
    "swiz settings [show | enable <setting> | disable <setting>] [--session [id]] [--dir <path>]",
  options: [
    { flags: "show", description: "Show current effective settings (default action)" },
    { flags: "enable auto-continue", description: "Enable stop auto-continue behavior" },
    { flags: "disable auto-continue", description: "Disable stop auto-continue behavior" },
    {
      flags: "enable sandboxed-edits",
      description: "Block file edits outside cwd and /tmp (default: enabled)",
    },
    {
      flags: "disable sandboxed-edits",
      description: "Allow file edits anywhere on the filesystem",
    },
    { flags: "enable speak", description: "Enable TTS narrator (speaks assistant text aloud)" },
    { flags: "disable speak", description: "Disable TTS narrator (default: disabled)" },
    {
      flags: "set pr-age-gate <minutes>",
      description: "Set PR merge grace period in minutes (0 to disable, default: 10)",
    },
    {
      flags: "--session, -s [id]",
      description: "Target session scope (latest for --dir by default, or prefix match by id)",
    },
    { flags: "--dir, -d <path>", description: "Target project directory for session lookup" },
  ],
  async run(args) {
    const parsed = parseSettingsArgs(args)
    switch (parsed.action) {
      case "show":
        return showSettings(parsed)
      case "enable":
        return setBooleanSetting(true, parsed)
      case "disable":
        return setBooleanSetting(false, parsed)
      case "set":
        return setNumericSetting(parsed)
    }
  },
}
