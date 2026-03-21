#!/usr/bin/env bun

// SessionStart hook: Inject project health snapshot as additionalContext

import { join } from "node:path"
import { getHomeDir } from "../src/home.ts"
import { sessionHookInputSchema } from "./schemas.ts"
import { readSessionStartStateInfo } from "./sessionstart-state-utils.ts"
import {
  emitContext,
  ghJson,
  git,
  hasGhCli,
  isGitHubRemote,
  isGitRepo,
} from "./utils/hook-utils.ts"

interface PluginEnvRequirement {
  plugin: string
  envVar: string
}

const KNOWN_PLUGIN_ENV: PluginEnvRequirement[] = [
  {
    plugin: "github@claude-plugins-official",
    envVar: "GITHUB_PERSONAL_ACCESS_TOKEN",
  },
  {
    plugin: "greptile@claude-plugins-official",
    envVar: "GREPTILE_API_KEY",
  },
]

async function checkPluginEnv(): Promise<string[]> {
  const warnings: string[] = []
  const settingsPath = join(getHomeDir(), ".claude", "settings.json")

  let enabledPlugins: Record<string, boolean> = {}
  try {
    const settings = (await Bun.file(settingsPath).json()) as {
      enabledPlugins?: Record<string, boolean>
    }
    enabledPlugins = settings.enabledPlugins ?? {}
  } catch {
    return warnings
  }

  for (const req of KNOWN_PLUGIN_ENV) {
    if (!enabledPlugins[req.plugin]) continue
    if (process.env[req.envVar]) continue
    warnings.push(`${req.plugin}: missing ${req.envVar}`)
  }

  return warnings
}

async function collectGitStatus(cwd: string): Promise<string> {
  const branch = await git(["branch", "--show-current"], cwd)
  const porcelain = await git(["status", "--porcelain"], cwd)
  const uncommitted = porcelain ? porcelain.split("\n").length : 0
  const ahead = (await git(["rev-list", "--count", "@{upstream}..HEAD"], cwd)) || "?"
  return `Git: branch=${branch}, uncommitted=${uncommitted}, unpushed=${ahead}.`
}

async function collectPrInfo(cwd: string): Promise<string | null> {
  const prs = await ghJson<Array<{ reviewDecision?: string }>>(
    ["pr", "list", "--state", "open", "--limit", "5", "--json", "number,title,reviewDecision"],
    cwd
  )
  if (!prs?.length) return null
  const changesReq = prs.filter((p) => p.reviewDecision === "CHANGES_REQUESTED").length
  let info = `PRs: ${prs.length} open`
  if (changesReq > 0) info += `, ${changesReq} need changes`
  return `${info}.`
}

async function collectCiInfo(branch: string, cwd: string): Promise<string | null> {
  const runs = await ghJson<Array<{ status: string; conclusion: string; workflowName: string }>>(
    ["run", "list", "--branch", branch, "--limit", "1", "--json", "status,conclusion,workflowName"],
    cwd
  )
  const run = runs?.[0]
  if (!run) return null
  const detail = run.status === "completed" ? run.conclusion : run.status
  return `CI (${run.workflowName}): ${detail}.`
}

async function collectGitHubParts(cwd: string, branch: string): Promise<string[]> {
  if (!hasGhCli()) return []
  const parts: string[] = []
  const prInfo = await collectPrInfo(cwd)
  if (prInfo) parts.push(prInfo)
  if (branch) {
    const ciInfo = await collectCiInfo(branch, cwd)
    if (ciInfo) parts.push(ciInfo)
  }
  return parts
}

async function main(): Promise<void> {
  const input = sessionHookInputSchema.parse(await Bun.stdin.json())
  const cwd = input.cwd
  if (!cwd) return

  const parts: string[] = []

  const pluginWarnings = await checkPluginEnv()
  if (pluginWarnings.length > 0) {
    parts.push(`[ENV] ${pluginWarnings.join(" | ")}`)
  }

  const stateInfo = await readSessionStartStateInfo(cwd)
  if (stateInfo) {
    parts.push(`State: ${stateInfo.state} → [${stateInfo.transitions.join(", ")}]`)
  }

  if (!(await isGitRepo(cwd)) || !(await isGitHubRemote(cwd))) {
    if (parts.length > 0) await emitContext("SessionStart", parts.join(" "), cwd)
    return
  }

  parts.push(await collectGitStatus(cwd))

  const branch = await git(["branch", "--show-current"], cwd)
  parts.push(...(await collectGitHubParts(cwd, branch)))

  if (parts.length > 0) await emitContext("SessionStart", parts.join(" "), cwd)
}

if (import.meta.main) void main()
