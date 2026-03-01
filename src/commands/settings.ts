import { join } from "node:path"
import {
  getEffectiveSwizSettings,
  getSwizSettingsPath,
  readSwizSettings,
  writeSwizSettings,
} from "../settings.ts"
import { findSessions, projectKeyFromCwd } from "../transcript-utils.ts"
import type { Command } from "../types.ts"

type SettingKey = "autoContinue" | "pushGate"
type Action = "show" | "enable" | "disable"

interface ParsedSettingsArgs {
  action: Action
  settingArg?: string
  targetDir: string
  sessionRequested: boolean
  sessionQuery: string | null
}

const HOME = process.env.HOME ?? "~"
const PROJECTS_DIR = join(HOME, ".claude", "projects")

function usage(): string {
  return (
    "Usage: swiz settings [show | enable <setting> | disable <setting>] [--session [id]] [--dir <path>]\n" +
    "Supported settings: auto-continue, push-gate"
  )
}

function parseSetting(raw: string | undefined): SettingKey {
  if (!raw) throw new Error(`Missing setting name.\n${usage()}`)
  const value = raw.trim().toLowerCase()
  if (value === "auto-continue" || value === "autocontinue" || value === "auto_continue") {
    return "autoContinue"
  }
  if (value === "push-gate" || value === "pushgate" || value === "push_gate") {
    return "pushGate"
  }
  throw new Error(`Unknown setting: ${raw}\n${usage()}`)
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
  if (rawAction !== "show" && rawAction !== "enable" && rawAction !== "disable") {
    throw new Error(`Unknown subcommand: ${positionals[0]}\n${usage()}`)
  }

  return {
    action: rawAction,
    settingArg: positionals[1],
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
  autoContinue: boolean,
  pushGate: boolean,
  path: string | null,
  fileExists: boolean,
  sessionId: string | null,
  source: "global" | "session"
): void {
  console.log("\n  swiz settings\n")
  if (!path) {
    console.log("  config: unavailable (HOME not set)")
  } else {
    const source = fileExists ? "custom" : "defaults"
    console.log(`  config: ${path} (${source})`)
  }
  if (sessionId) console.log(`  scope: session ${sessionId}`)
  const sourceLabel = source === "session" ? "session override" : "global/default"
  console.log(`  auto-continue: ${autoContinue ? "enabled" : "disabled"} (${sourceLabel})`)
  console.log(`  push-gate:     ${pushGate ? "enabled" : "disabled"} (global)\n`)
}

async function showSettings(parsed: ParsedSettingsArgs): Promise<void> {
  const sessionId = parsed.sessionRequested
    ? await resolveSessionId(parsed.sessionQuery, parsed.targetDir)
    : null
  const settings = await readSwizSettings({ strict: true })
  const effective = getEffectiveSwizSettings(settings, sessionId)
  const path = getSwizSettingsPath()
  const fileExists = path ? await Bun.file(path).exists() : false
  printSettings(
    effective.autoContinue,
    effective.pushGate,
    path,
    fileExists,
    sessionId,
    effective.source
  )
}

async function setSetting(enabled: boolean, parsed: ParsedSettingsArgs): Promise<void> {
  const key = parseSetting(parsed.settingArg)
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
    `\n  ${enabled ? "Enabled" : "Disabled"} auto-continue${sessionId ? ` for session ${sessionId}` : ""}`
  )
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
        return setSetting(true, parsed)
      case "disable":
        return setSetting(false, parsed)
    }
  },
}
