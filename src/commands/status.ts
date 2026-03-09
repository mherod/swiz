import { readdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { AGENTS, type AgentDef } from "../agents.ts"
import { detectCurrentAgent } from "../detect.ts"
import { getHomeDir } from "../home.ts"
import { readStateData, STATE_TRANSITIONS, TERMINAL_STATES } from "../settings.ts"
import { getDefaultTaskRoots } from "../task-roots.ts"
import type { Command } from "../types.ts"

const SWIZ_ROOT = dirname(Bun.main)
const HOOKS_DIR = join(SWIZ_ROOT, "hooks")

import { BOLD, CYAN, DIM, GREEN, RED, RESET, YELLOW } from "../ansi.ts"

function isSwizManaged(cmd: string): boolean {
  return (
    cmd.includes(HOOKS_DIR) ||
    cmd.includes(join(SWIZ_ROOT, "index.ts")) ||
    cmd.includes("swiz dispatch")
  )
}

function collectSwizCommands(hooks: Record<string, unknown>): Set<string> {
  const cmds = new Set<string>()
  for (const entries of Object.values(hooks)) {
    if (!Array.isArray(entries)) continue
    for (const entry of entries) {
      const e = entry as Record<string, unknown>
      if (typeof e.command === "string" && isSwizManaged(e.command)) {
        cmds.add(e.command)
      }
      if (Array.isArray(e.hooks)) {
        for (const h of e.hooks) {
          const hh = h as Record<string, unknown>
          if (typeof hh.command === "string" && isSwizManaged(hh.command)) {
            cmds.add(hh.command)
          }
        }
      }
    }
  }
  return cmds
}

function countAllHooks(hooks: Record<string, unknown>): number {
  let total = 0
  for (const entries of Object.values(hooks)) {
    if (!Array.isArray(entries)) continue
    for (const entry of entries) {
      const e = entry as Record<string, unknown>
      if (Array.isArray(e.hooks)) {
        total += e.hooks.length
      } else {
        total++
      }
    }
  }
  return total
}

async function checkAgent(agent: AgentDef) {
  const file = Bun.file(agent.settingsPath)
  const binaryProc = Bun.spawnSync(["which", agent.binary])
  const binaryInstalled = binaryProc.exitCode === 0
  const binaryPath = binaryInstalled ? new TextDecoder().decode(binaryProc.stdout).trim() : null

  const settingsExist = await file.exists()

  console.log(`  ${BOLD}${agent.name}${RESET}`)

  if (binaryPath) {
    console.log(`    Binary:   ${GREEN}✓${RESET} ${binaryPath}`)
  } else {
    console.log(`    Binary:   ${DIM}not found${RESET}`)
  }

  if (!settingsExist) {
    console.log(`    Settings: ${DIM}${agent.settingsPath} (not found)${RESET}`)
    console.log(`    Hooks:    ${RED}not installed${RESET}`)
    console.log()
    return
  }

  console.log(`    Settings: ${GREEN}✓${RESET} ${agent.settingsPath}`)

  if (!agent.hooksConfigurable) {
    console.log(`    Hooks:    ${YELLOW}not yet user-configurable${RESET} (tool mappings tracked)`)
    console.log()
    return
  }

  try {
    const json = await file.json()
    const hooks = json[agent.hooksKey] ?? json.hooks

    if (!hooks || typeof hooks !== "object") {
      console.log(`    Hooks:    ${YELLOW}no hooks configured${RESET}`)
      console.log()
      return
    }

    const hooksObj = hooks as Record<string, unknown>
    const totalHooks = countAllHooks(hooksObj)
    const swizCmds = collectSwizCommands(hooksObj)
    const swizCount = swizCmds.size
    const otherCount = totalHooks - swizCount

    if (swizCount > 0) {
      console.log(
        `    Hooks:    ${GREEN}✓ ${swizCount} swiz hook(s)${RESET}` +
          (otherCount > 0 ? ` + ${CYAN}${otherCount} other${RESET}` : "")
      )

      const events = new Set<string>()
      for (const [event, entries] of Object.entries(hooksObj)) {
        if (!Array.isArray(entries)) continue
        for (const entry of entries) {
          const e = entry as Record<string, unknown>
          const hasSwiz = (list: unknown[]) =>
            list.some(
              (h) =>
                typeof (h as Record<string, unknown>).command === "string" &&
                isSwizManaged((h as Record<string, unknown>).command as string)
            )
          if (Array.isArray(e.hooks) && hasSwiz(e.hooks)) events.add(event)
          else if (typeof e.command === "string" && isSwizManaged(e.command)) events.add(event)
        }
      }
      console.log(`    Events:   ${[...events].join(", ")}`)
    } else {
      console.log(`    Hooks:    ${YELLOW}${totalHooks} hook(s), none from swiz${RESET}`)
    }
  } catch {
    console.log(`    Hooks:    ${RED}failed to parse settings${RESET}`)
  }

  console.log()
}

// ─── Project Health Panel ─────────────────────────────────────────────────────

interface ProjectHealth {
  state: string | null
  isTerminal: boolean
  allowedTransitions: string[]
  branch: string | null
  uncommittedFiles: number
  aheadBehind: { ahead: number; behind: number } | null
  openTasks: number | null
  ciStatus: string | null
  ciConclusion: string | null
}

async function spawnLine(cmd: string[]): Promise<string> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" })
  const out = await new Response(proc.stdout).text()
  await proc.exited
  return out.trim()
}

async function getOpenTaskCount(cwd: string): Promise<number | null> {
  try {
    const home = getHomeDir()
    const { tasksDir: tasksRoot, projectsDir: projectsRoot } = getDefaultTaskRoots(home)
    const { projectKeyFromCwd } = await import("../project-key.ts")
    const { readSessionMeta } = await import("../tasks/task-repository.ts")
    const key = projectKeyFromCwd(cwd)
    const sessionIdsPath = join(projectsRoot, key)
    let sessionIds: string[] = []
    try {
      sessionIds = await readdir(sessionIdsPath)
    } catch {
      return null
    }
    let open = 0
    for (const sessionId of sessionIds) {
      // Fast path: read the lightweight .session-meta.json index written by writeTask.
      const meta = await readSessionMeta(sessionId, tasksRoot)
      if (meta !== null) {
        open += meta.openCount
        continue
      }
      // Fallback: index missing — read every task file (pre-index sessions or corruption).
      const sessionDir = join(tasksRoot, sessionId)
      let files: string[]
      try {
        files = await readdir(sessionDir)
      } catch {
        continue
      }
      for (const file of files) {
        if (!file.endsWith(".json") || file.startsWith(".")) continue
        try {
          const task = (await Bun.file(join(sessionDir, file)).json()) as {
            status?: string
          }
          if (task.status === "pending" || task.status === "in_progress") open++
        } catch {}
      }
    }
    return open
  } catch {
    return null
  }
}

async function getProjectHealth(cwd: string): Promise<ProjectHealth> {
  const [stateData, branch, statusOut, aheadBehind] = await Promise.all([
    readStateData(cwd).catch(() => null),
    spawnLine(["git", "-C", cwd, "branch", "--show-current"]).catch(() => null),
    spawnLine(["git", "-C", cwd, "status", "--porcelain"]).catch(() => null),
    spawnLine([
      "git",
      "-C",
      cwd,
      "rev-list",
      "--left-right",
      "--count",
      "@{upstream}...HEAD",
    ]).catch(() => null),
  ])

  const uncommittedFiles = statusOut ? statusOut.split("\n").filter(Boolean).length : 0
  let ahead = 0
  let behind = 0
  let aheadBehindResult: { ahead: number; behind: number } | null = null
  if (aheadBehind) {
    const parts = aheadBehind.split(/\s+/)
    behind = parseInt(parts[0] ?? "0", 10) || 0
    ahead = parseInt(parts[1] ?? "0", 10) || 0
    aheadBehindResult = { ahead, behind }
  }

  const openTasks = await getOpenTaskCount(cwd)

  // CI: get latest run on this branch (best-effort, no block on failure)
  let ciStatus: string | null = null
  let ciConclusion: string | null = null
  if (branch) {
    try {
      const ciOut = await spawnLine([
        "gh",
        "run",
        "list",
        "--branch",
        branch,
        "--limit",
        "1",
        "--json",
        "status,conclusion",
        "--jq",
        '.[0] | .status + "|" + .conclusion',
      ])
      if (ciOut && ciOut !== "null|null") {
        const [s, c] = ciOut.split("|")
        ciStatus = s ?? null
        ciConclusion = c ?? null
      }
    } catch {}
  }

  const state = stateData?.state ?? null
  const isTerminal = state ? TERMINAL_STATES.includes(state as never) : false
  const allowedTransitions = state ? (STATE_TRANSITIONS[state as never] ?? []) : []

  return {
    state,
    isTerminal,
    allowedTransitions,
    branch,
    uncommittedFiles,
    aheadBehind: aheadBehindResult,
    openTasks,
    ciStatus,
    ciConclusion,
  }
}

function renderHealthPanel(health: ProjectHealth): void {
  console.log(`  ${BOLD}Project Health${RESET}\n`)

  // State
  if (health.state) {
    const termTag = health.isTerminal ? ` ${DIM}(terminal)${RESET}` : ""
    console.log(`    State:     ${CYAN}${health.state}${RESET}${termTag}`)
    if (health.allowedTransitions.length > 0) {
      console.log(`    Nexts:     ${DIM}${health.allowedTransitions.join(", ")}${RESET}`)
    }
  } else {
    console.log(`    State:     ${DIM}not set${RESET}`)
  }

  // Git
  const branchStr = health.branch ?? `${DIM}unknown${RESET}`
  console.log(`    Branch:    ${GREEN}${branchStr}${RESET}`)
  if (health.uncommittedFiles > 0) {
    console.log(`    Changes:   ${YELLOW}${health.uncommittedFiles} uncommitted file(s)${RESET}`)
  } else {
    console.log(`    Changes:   ${GREEN}clean${RESET}`)
  }
  if (health.aheadBehind) {
    const { ahead, behind } = health.aheadBehind
    if (ahead === 0 && behind === 0) {
      console.log(`    Remote:    ${GREEN}in sync${RESET}`)
    } else {
      const parts: string[] = []
      if (ahead > 0) parts.push(`${YELLOW}${ahead} ahead${RESET}`)
      if (behind > 0) parts.push(`${RED}${behind} behind${RESET}`)
      console.log(`    Remote:    ${parts.join(", ")}`)
    }
  }

  // Tasks
  if (health.openTasks !== null) {
    if (health.openTasks === 0) {
      console.log(`    Tasks:     ${GREEN}none open${RESET}`)
    } else {
      console.log(`    Tasks:     ${YELLOW}${health.openTasks} open${RESET}`)
    }
  }

  // CI
  if (health.ciStatus) {
    const conclusion = health.ciConclusion
    let ciLine: string
    if (health.ciStatus === "completed" && conclusion === "success") {
      ciLine = `${GREEN}✓ success${RESET}`
    } else if (health.ciStatus === "in_progress" || health.ciStatus === "queued") {
      ciLine = `${YELLOW}⏳ ${health.ciStatus}${RESET}`
    } else if (conclusion === "failure" || conclusion === "cancelled") {
      ciLine = `${RED}✗ ${conclusion}${RESET}`
    } else {
      ciLine = `${DIM}${health.ciStatus}${conclusion ? ` / ${conclusion}` : ""}${RESET}`
    }
    console.log(`    CI:        ${ciLine}`)
  } else {
    console.log(`    CI:        ${DIM}no recent run${RESET}`)
  }

  console.log()
}

export const statusCommand: Command = {
  name: "status",
  description: "Show swiz installation status across agents",
  usage: "swiz status [--json]",
  async run(args) {
    const cwd = process.cwd()
    const jsonMode = args.includes("--json")

    if (jsonMode) {
      const health = await getProjectHealth(cwd)
      console.log(JSON.stringify(health, null, 2))
      return
    }

    console.log(`\n  ${BOLD}swiz status${RESET}\n`)

    const current = detectCurrentAgent()
    if (current) {
      console.log(`  Running inside: ${GREEN}${current.name}${RESET}\n`)
    }

    console.log(`  Hooks directory: ${HOOKS_DIR}\n`)

    for (const agent of AGENTS) {
      await checkAgent(agent)
    }

    renderHealthPanel(await getProjectHealth(cwd))
  },
}
