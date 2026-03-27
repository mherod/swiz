import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { getAgentSettingsSearchPaths } from "../agent-paths.ts"
import { AGENTS, type AgentDef } from "../agents.ts"
import { BOLD, CYAN, DIM, GREEN, RED, RESET, YELLOW } from "../ansi.ts"
import { detectCurrentAgent } from "../detect.ts"
import { getHomeDir } from "../home.ts"
import { readStateData, STATE_TRANSITIONS, TERMINAL_STATES } from "../settings.ts"
import { HOOKS_DIR, isSwizCommand } from "../swiz-hook-commands.ts"
import { createDefaultTaskStore } from "../task-roots.ts"
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

function printAgentBinary(agent: AgentDef): void {
  const binaryProc = Bun.spawnSync(["which", agent.binary])
  const binaryPath =
    binaryProc.exitCode === 0 ? new TextDecoder().decode(binaryProc.stdout).trim() : null
  console.log(`  ${BOLD}${agent.name}${RESET}`)
  console.log(
    binaryPath
      ? `    Binary:   ${GREEN}✓${RESET} ${binaryPath}`
      : `    Binary:   ${DIM}not found${RESET}`
  )
}

async function checkAgent(agent: AgentDef) {
  printAgentBinary(agent)

  const agentId = agent.id as "claude" | "cursor" | "gemini" | "codex"
  const settingsPaths = getAgentSettingsSearchPaths(agentId)
  const foundPaths: string[] = []
  const allHooks = new Map<string, Record<string, unknown>>()

  for (const path of settingsPaths) {
    const file = Bun.file(path)
    if (!(await file.exists())) continue
    foundPaths.push(path)
    try {
      const json = await file.json()
      const hooks = json[agent.hooksKey] ?? json.hooks
      if (hooks && typeof hooks === "object") {
        allHooks.set(path, hooks as Record<string, unknown>)
      }
    } catch {
      // Ignore parse errors, continue to next path
    }
  }

  if (foundPaths.length === 0) {
    console.log(`    Settings: ${DIM}${agent.settingsPath} (not found)${RESET}`)
    console.log(`    Hooks:    ${RED}not installed${RESET}`)
    console.log()
    return
  }

  console.log(`    Settings: ${GREEN}✓${RESET} ${foundPaths.join(", ")}`)

  if (!agent.hooksConfigurable) {
    console.log(`    Hooks:    ${YELLOW}not yet user-configurable${RESET} (tool mappings tracked)`)
    console.log()
    return
  }

  if (allHooks.size === 0) {
    console.log(`    Hooks:    ${YELLOW}no hooks configured${RESET}`)
    console.log()
    return
  }

  printAgentHooksInfo(allHooks)

  console.log()
}

function printAgentHooksInfo(allHooks: Map<string, Record<string, unknown>>): void {
  let totalHooks = 0
  const allSwizCmds = new Set<string>()
  const allEvents = new Set<string>()

  for (const hooksObj of allHooks.values()) {
    totalHooks += countAllHooks(hooksObj)
    for (const cmd of collectSwizCommands(hooksObj)) {
      allSwizCmds.add(cmd)
    }
    forEachHookEntry(hooksObj, (event, entry) => {
      if (entryContainsSwizCommand(entry)) allEvents.add(event)
    })
  }

  const swizCount = allSwizCmds.size
  const otherCount = totalHooks - swizCount

  if (swizCount > 0) {
    console.log(
      `    Hooks:    ${GREEN}✓ ${swizCount} swiz hook(s)${RESET}` +
        (otherCount > 0 ? ` + ${CYAN}${otherCount} other${RESET}` : "")
    )
    console.log(`    Events:   ${[...allEvents].join(", ")}`)
  } else {
    console.log(`    Hooks:    ${YELLOW}${totalHooks} hook(s), none from swiz${RESET}`)
  }
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

async function collectIndexedSessionIds(projectsRoot: string, key: string): Promise<Set<string>> {
  const sessionIdsPath = join(projectsRoot, key)
  const ids = new Set<string>()
  try {
    for (const f of await readdir(sessionIdsPath)) {
      if (f.endsWith(".jsonl")) ids.add(f.slice(0, -6))
    }
  } catch {}
  return ids
}

async function collectAllProjectSessionIds(projectsRoot: string): Promise<Set<string>> {
  const ids = new Set<string>()
  const projectDirs = await readdir(projectsRoot).catch(() => [] as string[])
  for (const projectDir of projectDirs) {
    const files = await readdir(join(projectsRoot, projectDir)).catch(() => [] as string[])
    for (const f of files) {
      if (f.endsWith(".jsonl")) ids.add(f.slice(0, -6))
    }
  }
  return ids
}

async function getOpenTaskCount(cwd: string): Promise<number | null> {
  try {
    const home = getHomeDir()
    const { tasksDir: tasksRoot, projectsDir: projectsRoot } = createDefaultTaskStore(home)
    const { projectKeyFromCwd } = await import("../project-key.ts")
    const key = projectKeyFromCwd(cwd)

    const indexedSessionIds = await collectIndexedSessionIds(projectsRoot, key)
    const allProjectSessionIds = await collectAllProjectSessionIds(projectsRoot)

    let taskDirEntries: string[]
    try {
      taskDirEntries = await readdir(tasksRoot)
    } catch {
      taskDirEntries = []
    }
    const sessionIds = new Set(indexedSessionIds)
    const { readSessionMeta: readMeta } = await import("../tasks/task-repository.ts")
    for (const s of taskDirEntries) {
      if (allProjectSessionIds.has(s)) continue
      const meta = await readMeta(s, tasksRoot)
      if (meta?.cwd !== undefined && meta.cwd !== cwd) continue
      sessionIds.add(s)
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

function renderRemoteLine(aheadBehind: { ahead: number; behind: number } | null): void {
  if (!aheadBehind) return
  const { ahead, behind } = aheadBehind
  if (ahead === 0 && behind === 0) {
    console.log(`    Remote:    ${GREEN}in sync${RESET}`)
    return
  }
  const parts: string[] = []
  if (ahead > 0) parts.push(`${YELLOW}${ahead} ahead${RESET}`)
  if (behind > 0) parts.push(`${RED}${behind} behind${RESET}`)
  console.log(`    Remote:    ${parts.join(", ")}`)
}

function formatCiLine(status: string | null, conclusion: string | null): string {
  if (!status) return `${DIM}no recent run${RESET}`
  if (status === "completed" && conclusion === "success") return `${GREEN}✓ success${RESET}`
  if (status === "in_progress" || status === "queued") return `${YELLOW}⏳ ${status}${RESET}`
  if (conclusion === "failure" || conclusion === "cancelled") return `${RED}✗ ${conclusion}${RESET}`
  return `${DIM}${status}${conclusion ? ` / ${conclusion}` : ""}${RESET}`
}

function renderHealthPanel(health: ProjectHealth): void {
  console.log(`  ${BOLD}Project Health${RESET}\n`)

  if (health.state) {
    const termTag = health.isTerminal ? ` ${DIM}(terminal)${RESET}` : ""
    console.log(`    State:     ${CYAN}${health.state}${RESET}${termTag}`)
    if (health.allowedTransitions.length > 0) {
      console.log(`    Nexts:     ${DIM}${health.allowedTransitions.join(", ")}${RESET}`)
    }
  } else {
    console.log(`    State:     ${DIM}not set${RESET}`)
  }

  console.log(`    Branch:    ${GREEN}${health.branch ?? `${DIM}unknown${RESET}`}${RESET}`)
  const changesLine =
    health.uncommittedFiles > 0
      ? `${YELLOW}${health.uncommittedFiles} uncommitted file(s)${RESET}`
      : `${GREEN}clean${RESET}`
  console.log(`    Changes:   ${changesLine}`)
  renderRemoteLine(health.aheadBehind)

  if (health.openTasks !== null) {
    const taskLine =
      health.openTasks === 0
        ? `${GREEN}none open${RESET}`
        : `${YELLOW}${health.openTasks} open${RESET}`
    console.log(`    Tasks:     ${taskLine}`)
  }

  console.log(`    CI:        ${formatCiLine(health.ciStatus, health.ciConclusion)}`)
  console.log()
}

export const statusCommand: Command = {
  name: "status",
  description: "Show swiz installation status across agents",
  usage: "swiz status [--json]",
  options: [{ flags: "--json", description: "Output project health as JSON" }],
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
