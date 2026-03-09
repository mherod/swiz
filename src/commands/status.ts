import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { AGENTS, type AgentDef } from "../agents.ts"
import { BOLD, CYAN, DIM, GREEN, RED, RESET, YELLOW } from "../ansi.ts"
import { detectCurrentAgent } from "../detect.ts"
import { getHomeDir } from "../home.ts"
import { readStateData, STATE_TRANSITIONS, TERMINAL_STATES } from "../settings.ts"
import { HOOKS_DIR, isSwizCommand } from "../swiz-hook-commands.ts"
import { getDefaultTaskRoots } from "../task-roots.ts"
import type { Command } from "../types.ts"

function forEachHookEntry(
  hooks: Record<string, unknown>,
  visit: (event: string, entry: Record<string, unknown>) => void
): void {
  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) continue
    for (const rawEntry of entries) {
      visit(event, rawEntry as Record<string, unknown>)
    }
  }
}

function entryContainsSwizCommand(entry: Record<string, unknown>): boolean {
  if (isSwizCommand(entry.command)) return true
  if (!Array.isArray(entry.hooks)) return false
  return entry.hooks.some((rawHook) => isSwizCommand((rawHook as Record<string, unknown>).command))
}

function collectSwizCommands(hooks: Record<string, unknown>): Set<string> {
  const cmds = new Set<string>()
  forEachHookEntry(hooks, (_event, entry) => {
    if (isSwizCommand(entry.command)) cmds.add(String(entry.command))
    if (!Array.isArray(entry.hooks)) return
    for (const rawHook of entry.hooks) {
      const nestedHook = rawHook as Record<string, unknown>
      if (isSwizCommand(nestedHook.command)) cmds.add(String(nestedHook.command))
    }
  })
  return cmds
}

function countAllHooks(hooks: Record<string, unknown>): number {
  let total = 0
  forEachHookEntry(hooks, (_event, entry) => {
    total += Array.isArray(entry.hooks) ? entry.hooks.length : 1
  })
  return total
}

function parseAheadBehind(raw: string | null): { ahead: number; behind: number } | null {
  if (!raw) return null
  const parts = raw.split(/\s+/)
  return {
    behind: parseInt(parts[0] ?? "0", 10) || 0,
    ahead: parseInt(parts[1] ?? "0", 10) || 0,
  }
}

function parseCiStatus(raw: string): { status: string | null; conclusion: string | null } {
  if (!raw || raw === "null|null") return { status: null, conclusion: null }
  const [status, conclusion] = raw.split("|")
  return { status: status ?? null, conclusion: conclusion ?? null }
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
      forEachHookEntry(hooksObj, (event, entry) => {
        if (entryContainsSwizCommand(entry)) events.add(event)
      })
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

async function countOpenTasksForSession(sessionId: string, tasksRoot: string): Promise<number> {
  const { readSessionMeta } = await import("../tasks/task-repository.ts")
  // Fast path: read the lightweight .session-meta.json index written by writeTask.
  const meta = await readSessionMeta(sessionId, tasksRoot)
  if (meta !== null) return meta.openCount
  // Fallback: index missing — read every task file (pre-index sessions or corruption).
  const sessionDir = join(tasksRoot, sessionId)
  let files: string[]
  try {
    files = await readdir(sessionDir)
  } catch {
    return 0
  }
  let open = 0
  for (const file of files) {
    if (!file.endsWith(".json") || file.startsWith(".")) continue
    try {
      const task = (await Bun.file(join(sessionDir, file)).json()) as { status?: string }
      if (task.status === "pending" || task.status === "in_progress") open++
    } catch {}
  }
  return open
}

async function getOpenTaskCount(cwd: string): Promise<number | null> {
  try {
    const home = getHomeDir()
    const { tasksDir: tasksRoot, projectsDir: projectsRoot } = getDefaultTaskRoots(home)
    const { projectKeyFromCwd } = await import("../project-key.ts")
    const key = projectKeyFromCwd(cwd)

    // Collect session IDs from the project transcript index, stripping .jsonl extension.
    const sessionIdsPath = join(projectsRoot, key)
    const indexedSessionIds = new Set<string>()
    try {
      for (const f of await readdir(sessionIdsPath)) {
        if (f.endsWith(".jsonl")) indexedSessionIds.add(f.slice(0, -6))
      }
    } catch {
      // Project directory missing — fall through to compaction-gap scan below.
    }

    // Collect all session IDs referenced by any project directory (for compaction-gap detection).
    const allProjectSessionIds = new Set<string>()
    try {
      for (const projectDir of await readdir(projectsRoot)) {
        try {
          for (const f of await readdir(join(projectsRoot, projectDir))) {
            if (f.endsWith(".jsonl")) allProjectSessionIds.add(f.slice(0, -6))
          }
        } catch {}
      }
    } catch {}

    // Union: indexed sessions for this project + task-dir sessions not yet in any project index
    // (compaction-gap sessions whose transcript hasn't been written yet).
    let taskDirEntries: string[]
    try {
      taskDirEntries = await readdir(tasksRoot)
    } catch {
      taskDirEntries = []
    }
    const sessionIds = new Set(indexedSessionIds)
    for (const s of taskDirEntries) {
      if (!allProjectSessionIds.has(s)) sessionIds.add(s)
    }

    if (sessionIds.size === 0) return null

    let open = 0
    for (const sessionId of sessionIds) {
      open += await countOpenTasksForSession(sessionId, tasksRoot)
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
  const aheadBehindResult = parseAheadBehind(aheadBehind)

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
      const ci = parseCiStatus(ciOut)
      ciStatus = ci.status
      ciConclusion = ci.conclusion
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
