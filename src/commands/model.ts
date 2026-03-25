import { existsSync } from "node:fs"
import {
  effectiveClaudeModelFromLayers,
  readClaudeSettingsObject,
  readModelFromClaudeSettings,
  resolveClaudeSettingsPath,
  writeClaudeSettingsWithMutation,
} from "../claude-model-settings.ts"
import { getHomeDirOrNull } from "../home.ts"
import type { Command } from "../types.ts"

/** Documented Claude Code model aliases (full IDs and custom strings are also valid). */
export const CLAUDE_MODEL_ALIASES = [
  "default",
  "sonnet",
  "opus",
  "haiku",
  "sonnet[1m]",
  "opus[1m]",
  "opusplan",
] as const

type ClaudeSettingsScope = "global" | "project" | "local"

interface ParsedModelArgs {
  action: "show" | "set" | "unset" | "aliases"
  value?: string
  scope: ClaudeSettingsScope
  targetDir: string
}

function usage(): string {
  return [
    "swiz model [show | set <value> | unset | aliases] [--global | --project | --local] [--dir <path>]",
    "",
    'Reads or writes the top-level "model" field in Claude Code settings.json (same shape as ~/.claude/settings.json).',
    "Scopes:",
    "  --global   ~/.claude/settings.json (default for set/unset)",
    "  --project  <dir>/.claude/settings.json",
    "  --local    <dir>/.claude/settings.local.json",
    "  --dir      Project root for --project / --local (default: cwd)",
    "",
    "Runtime precedence (Claude Code): ANTHROPIC_MODEL env, then merged settings (local > project > user).",
    `Aliases (also accepts full model IDs, ARNs, etc.): ${CLAUDE_MODEL_ALIASES.join(", ")}`,
  ].join("\n")
}

type ModelScope = ParsedModelArgs["scope"]

const SCOPE_FLAGS: Record<string, ModelScope> = {
  "--global": "global",
  "-g": "global",
  "--project": "project",
  "-p": "project",
  "--local": "local",
  "-l": "local",
}

function tokenizeModelArgs(args: string[]): {
  positionals: string[]
  scope: ModelScope
  targetDir: string
} {
  const positionals: string[] = []
  let scope: ModelScope = "global"
  let targetDir = process.cwd()

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    const scopeVal = SCOPE_FLAGS[a]
    if (scopeVal) {
      scope = scopeVal
      continue
    }
    if (a === "--dir" || a === "-d") {
      const next = args[i + 1]
      if (!next || next.startsWith("-")) throw new Error(`Missing value for ${a}.\n${usage()}`)
      targetDir = next
      i++
      continue
    }
    if (a.startsWith("-")) throw new Error(`Unknown flag: ${a}\n${usage()}`)
    positionals.push(a)
  }
  return { positionals, scope, targetDir }
}

const SUBCOMMAND_MAP: Record<string, ParsedModelArgs["action"]> = {
  aliases: "aliases",
  show: "show",
  list: "show",
  unset: "unset",
  clear: "unset",
}

function resolveModelAction(
  positionals: string[],
  scope: ModelScope,
  targetDir: string
): ParsedModelArgs {
  const sub = (positionals[0] ?? "show").toLowerCase()
  const mapped = SUBCOMMAND_MAP[sub]
  if (mapped) return { action: mapped, scope, targetDir }

  if (sub === "set") {
    const value = positionals[1]
    if (!value?.trim()) throw new Error(`Missing model value for set.\n${usage()}`)
    return { action: "set", value: value.trim(), scope, targetDir }
  }
  if (positionals.length === 1 && !SUBCOMMAND_MAP[sub]) {
    return { action: "set", value: positionals[0]!.trim(), scope, targetDir }
  }
  throw new Error(`Unexpected arguments.\n${usage()}`)
}

async function showModel(
  globalPath: string,
  projectPath: string,
  localPath: string
): Promise<void> {
  const envModel = process.env.ANTHROPIC_MODEL?.trim()
  if (envModel) console.log(`ANTHROPIC_MODEL (env): ${envModel}`)

  const [gObj, pObj, lObj] = await Promise.all([
    readClaudeSettingsObject(globalPath),
    readClaudeSettingsObject(projectPath),
    readClaudeSettingsObject(localPath),
  ])

  console.log(`Global (${globalPath}): ${readModelFromClaudeSettings(gObj) ?? "(not set)"}`)
  console.log(`Project (${projectPath}): ${readModelFromClaudeSettings(pObj) ?? "(not set)"}`)
  console.log(`Local (${localPath}): ${readModelFromClaudeSettings(lObj) ?? "(not set)"}`)

  const eff = effectiveClaudeModelFromLayers(gObj, pObj, lObj)
  console.log(
    envModel
      ? `Effective (env overrides file merge): ${envModel}`
      : `Effective (files only): ${eff ?? "(not set — Claude Code tier default)"}`
  )
}

async function unsetModel(scope: ModelScope, targetDir: string, home: string): Promise<void> {
  const path = resolveClaudeSettingsPath(scope, targetDir, home)
  if (!existsSync(path)) {
    console.log(`No file at ${path}; nothing to unset.`)
    return
  }
  await writeClaudeSettingsWithMutation(path, (obj) => {
    delete obj.model
  })
  console.log(`Removed "model" from ${path}`)
}

function parseModelArgs(args: string[]): ParsedModelArgs {
  const { positionals, scope, targetDir } = tokenizeModelArgs(args)
  return resolveModelAction(positionals, scope, targetDir)
}

export const modelCommand: Command = {
  name: "model",
  description: "Show or set Claude Code default model in settings.json",
  usage: usage(),
  options: [
    {
      flags: "--global, -g",
      description: "Target ~/.claude/settings.json (default for set/unset)",
    },
    { flags: "--project, -p", description: "Target <dir>/.claude/settings.json" },
    { flags: "--local, -l", description: "Target <dir>/.claude/settings.local.json" },
    { flags: "--dir, -d <path>", description: "Project directory for --project / --local" },
  ],
  run: async (args: string[]) => {
    const home = getHomeDirOrNull()
    if (!home) throw new Error("HOME is not set; cannot resolve ~/.claude/settings.json.")

    const parsed = parseModelArgs(args)

    if (parsed.action === "aliases") {
      for (const a of CLAUDE_MODEL_ALIASES) console.log(a)
      return
    }

    const globalPath = resolveClaudeSettingsPath("global", parsed.targetDir, home)
    const projectPath = resolveClaudeSettingsPath("project", parsed.targetDir, home)
    const localPath = resolveClaudeSettingsPath("local", parsed.targetDir, home)

    switch (parsed.action) {
      case "show":
        return showModel(globalPath, projectPath, localPath)
      case "unset":
        return unsetModel(parsed.scope, parsed.targetDir, home)
      case "set": {
        const path = resolveClaudeSettingsPath(parsed.scope, parsed.targetDir, home)
        await writeClaudeSettingsWithMutation(path, (obj) => {
          obj.model = parsed.value!
        })
        console.log(`Set "model" to ${JSON.stringify(parsed.value)} in ${path}`)
        return
      }
    }
  },
}
