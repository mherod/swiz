#!/usr/bin/env bun

// SessionStart hook: Inject project health snapshot as additionalContext

import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  ghJson,
  git,
  hasGhCli,
  isGitHubRemote,
  isGitRepo,
  type SessionHookInput,
} from "./hook-utils.ts"

interface PluginEnvRequirement {
  plugin: string
  envVar: string
  fix: string
}

const KNOWN_PLUGIN_ENV: PluginEnvRequirement[] = [
  {
    plugin: "github@claude-plugins-official",
    envVar: "GITHUB_PERSONAL_ACCESS_TOKEN",
    fix: "Run: gh auth token | pbcopy, then add GITHUB_PERSONAL_ACCESS_TOKEN to ~/.claude/settings.json env block",
  },
  {
    plugin: "greptile@claude-plugins-official",
    envVar: "GREPTILE_API_KEY",
    fix: "Get a key at https://app.greptile.com and add GREPTILE_API_KEY to ~/.claude/settings.json env block",
  },
]

function checkPluginEnv(): string[] {
  const warnings: string[] = []
  const settingsPath = join(process.env.HOME ?? "~", ".claude", "settings.json")

  let enabledPlugins: Record<string, boolean> = {}
  try {
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"))
    enabledPlugins = settings.enabledPlugins ?? {}
  } catch {
    return warnings
  }

  for (const req of KNOWN_PLUGIN_ENV) {
    if (!enabledPlugins[req.plugin]) continue
    if (process.env[req.envVar]) continue
    warnings.push(`Plugin "${req.plugin}" is enabled but ${req.envVar} is not set. ${req.fix}`)
  }

  return warnings
}

async function main(): Promise<void> {
  const input = (await Bun.stdin.json()) as SessionHookInput
  const cwd = input.cwd
  if (!cwd) return

  const parts: string[] = []

  // Plugin environment health — runs regardless of git context
  const pluginWarnings = checkPluginEnv()
  if (pluginWarnings.length > 0) {
    parts.push(`[ENV] ${pluginWarnings.join(" | ")}`)
  }

  if (!(await isGitRepo(cwd)) || !(await isGitHubRemote(cwd))) {
    if (parts.length > 0) {
      console.log(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "SessionStart",
            additionalContext: parts.join(" "),
          },
        })
      )
    }
    return
  }

  // Git status summary
  const branch = await git(["branch", "--show-current"], cwd)
  const porcelain = await git(["status", "--porcelain"], cwd)
  const uncommitted = porcelain ? porcelain.split("\n").length : 0
  const ahead = (await git(["rev-list", "--count", "@{upstream}..HEAD"], cwd)) || "?"

  parts.push(`Git: branch=${branch}, uncommitted=${uncommitted}, unpushed=${ahead}.`)

  // Open PRs (fast, limit output)
  if (hasGhCli()) {
    const prs = await ghJson<Array<{ reviewDecision?: string }>>(
      ["pr", "list", "--state", "open", "--limit", "5", "--json", "number,title,reviewDecision"],
      cwd
    )
    if (prs?.length) {
      const changesReq = prs.filter((p) => p.reviewDecision === "CHANGES_REQUESTED").length
      let prInfo = `PRs: ${prs.length} open`
      if (changesReq > 0) prInfo += `, ${changesReq} need changes`
      parts.push(`${prInfo}.`)
    }

    // Latest CI on current branch
    if (branch) {
      const runs = await ghJson<
        Array<{
          status: string
          conclusion: string
          workflowName: string
        }>
      >(
        [
          "run",
          "list",
          "--branch",
          branch,
          "--limit",
          "1",
          "--json",
          "status,conclusion,workflowName",
        ],
        cwd
      )
      const run = runs?.[0]
      if (run) {
        if (run.status === "completed") {
          parts.push(`CI (${run.workflowName}): ${run.conclusion}.`)
        } else {
          parts.push(`CI (${run.workflowName}): ${run.status}.`)
        }
      }
    }
  }

  if (parts.length === 0) return

  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: parts.join(" "),
      },
    })
  )
}

main()
