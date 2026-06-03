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
import { isIncompleteTaskStatus } from "../tasks/task-repository.ts"
import type { Command } from "../types.ts"

const STATUS_GIT_TIMEOUT_MS = 800
const STATUS_CI_TIMEOUT_MS = 1_000
const STATUS_DEFAULT_SPAWN_TIMEOUT_MS = 1_000

function forEachHookEntry(
  hooks: Record<string, any>,
  visit: (event: string, entry: Record<string, any>) => void
): void {
  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) continue
    for (const rawEntry of entries) {
      visit(event, rawEntry as Record<string, any>)
    }
  }
}

function entryContainsSwizCommand(entry: Record<string, any>): boolean {
  if (isSwizCommand(entry.command)) return true
  if (!Array.isArray(entry.hooks)) return false
  return entry.hooks.some((rawHook) => isSwizCommand((rawHook as Record<string, any>).command))
}

function collectSwizCommands(hooks: Record<string, any>): Set<string> {
  const cmds = new Set<string>()
  forEachHookEntry(hooks, (_event, entry) => {
    if (isSwizCommand(entry.command)) cmds.add(String(entry.command))
    if (!Array.isArray(entry.hooks)) return
    for (const rawHook of entry.hooks) {
      const nestedHook = rawHook as Record<string, any>
      if (isSwizCommand(nestedHook.command)) cmds.add(String(nestedHook.command))
    }
  })
  return cmds
}

function countAllHooks(hooks: Record<string, any>): number {
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

function formatAgentBinary(agent: AgentDef): string[] {
  const binaryPath = Bun.which(agent.binary)
  return [
    `  ${BOLD}${agent.name}${RESET}`,
    binaryPath
      ? `    Binary:   ${GREEN}✓${RESET} ${binaryPath}`
      : `    Binary:   ${DIM}not found${RESET}`,
  ]
}

async function readAgentSettings(
  agent: AgentDef,
  path: string
): Promise<{ path: string; hooks: Record<string, any> | null } | null> {
  const file = Bun.file(path)
  if (!(await file.exists())) return null

  try {
    const json = await file.json()
    const hooks = json[agent.hooksKey] ?? json.hooks
    return {
      path,
      hooks: hooks && typeof hooks === "object" ? (hooks as Record<string, any>) : null,
    }
  } catch {
    return { path, hooks: null }
  }
}

async function collectAgentStatus(agent: AgentDef): Promise<string[]> {
  const lines = formatAgentBinary(agent)

  const settingsPaths = getAgentSettingsSearchPaths(agent.id)
  const foundPaths: string[] = []
  const allHooks = new Map<string, Record<string, any>>()

  const settingsResults = await Promise.all(
    settingsPaths.map((path) => readAgentSettings(agent, path))
  )
  for (const result of settingsResults) {
    if (!result) continue
    foundPaths.push(result.path)
    if (result.hooks) allHooks.set(result.path, result.hooks)
  }

  if (foundPaths.length === 0) {
    lines.push(`    Settings: ${DIM}${agent.settingsPath} (not found)${RESET}`)
    lines.push(`    Hooks:    ${RED}not installed${RESET}`)
    lines.push("")
    return lines
  }

  lines.push(`    Settings: ${GREEN}✓${RESET} ${foundPaths.join(", ")}`)

  if (!agent.hooksConfigurable) {
    lines.push(`    Hooks:    ${YELLOW}not yet user-configurable${RESET} (tool mappings tracked)`)
    lines.push("")
    return lines
  }

  if (allHooks.size === 0) {
    lines.push(`    Hooks:    ${YELLOW}no hooks configured${RESET}`)
    lines.push("")
    return lines
  }

  lines.push(...formatAgentHooksInfo(allHooks))
  lines.push("")
  return lines
}

function formatAgentHooksInfo(allHooks: Map<string, Record<string, any>>): string[] {
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
    return [
      `    Hooks:    ${GREEN}✓ ${swizCount} swiz hook(s)${RESET}` +
        (otherCount > 0 ? ` + ${CYAN}${otherCount} other${RESET}` : ""),
      `    Events:   ${[...allEvents].join(", ")}`,
    ]
  }
  return [`    Hooks:    ${YELLOW}${totalHooks} hook(s), none from swiz${RESET}`]
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
  testStats: {
    totalTimeMs: number
    count: number
    averageMs: number
    assessment: "negligible" | "significant"
  } | null
  lintStats: {
    totalTimeMs: number
    count: number
    averageMs: number
    assessment: "negligible" | "significant"
  } | null
}

interface ProjectHealthOptions {
  refreshCi?: boolean
}

interface CachedCiRun {
  databaseId?: number
  status?: string | null
  conclusion?: string | null
  createdAt?: string | null
}

async function spawnLine(cmd: string[], options: { timeoutMs?: number } = {}): Promise<string> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" })
  let timedOut = false
  const killTimer = setTimeout(() => {
    timedOut = true
    proc.kill()
  }, options.timeoutMs ?? STATUS_DEFAULT_SPAWN_TIMEOUT_MS)
  const [out] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited
  clearTimeout(killTimer)
  if (timedOut) return ""
  return out.trim()
}

function ciRunSortValue(run: CachedCiRun): number {
  const createdAtMs = run.createdAt ? Date.parse(run.createdAt) : Number.NaN
  if (Number.isFinite(createdAtMs)) return createdAtMs
  return typeof run.databaseId === "number" && Number.isFinite(run.databaseId) ? run.databaseId : 0
}

function latestCiRun(runs: CachedCiRun[] | null): CachedCiRun | null {
  if (!runs || runs.length === 0) return null
  return runs.reduce((latest, run) => (ciRunSortValue(run) > ciRunSortValue(latest) ? run : latest))
}

async function getCachedCiStatus(
  cwd: string,
  branch: string
): Promise<{ status: string | null; conclusion: string | null }> {
  try {
    const [{ getRepoSlug }, { getIssueStoreReader }] = await Promise.all([
      import("../git-helpers.ts"),
      import("../issue-store.ts"),
    ])
    const repo = await getRepoSlug(cwd)
    if (!repo) return { status: null, conclusion: null }
    const runs = await getIssueStoreReader().getCiBranchRuns<CachedCiRun>(repo, branch)
    const run = latestCiRun(runs)
    return {
      status: run?.status ?? null,
      conclusion: run?.conclusion ?? null,
    }
  } catch {
    return { status: null, conclusion: null }
  }
}

async function getLiveCiStatus(
  branch: string
): Promise<{ status: string | null; conclusion: string | null }> {
  try {
    const ciOut = await spawnLine(
      [
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
      ],
      { timeoutMs: STATUS_CI_TIMEOUT_MS }
    )
    return parseCiStatus(ciOut)
  } catch {
    return { status: null, conclusion: null }
  }
}

type ReadSessionMeta = typeof import("../tasks/task-repository.ts").readSessionMeta

async function countOpenTasksForSession(
  sessionId: string,
  tasksRoot: string,
  readSessionMeta: ReadSessionMeta
): Promise<number> {
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
  const taskFiles = files.filter((file) => file.endsWith(".json") && !file.startsWith("."))
  const counts = await Promise.all(
    taskFiles.map(async (file): Promise<number> => {
      try {
        const task = (await Bun.file(join(sessionDir, file)).json()) as { status?: string }
        return isIncompleteTaskStatus(task.status ?? "") ? 1 : 0
      } catch {
        return 0
      }
    })
  )
  return counts.reduce((sum, count) => sum + count, 0)
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

async function collectSessionIdsByMetaCwd(
  cwd: string,
  tasksRoot: string,
  readSessionMeta: ReadSessionMeta
): Promise<Set<string>> {
  let taskDirEntries: string[]
  try {
    taskDirEntries = await readdir(tasksRoot)
  } catch {
    return new Set()
  }
  const matches = await Promise.all(
    taskDirEntries.map(async (sessionId) => {
      const meta = await readSessionMeta(sessionId, tasksRoot)
      return meta?.cwd === cwd ? sessionId : null
    })
  )
  return new Set(matches.filter((sessionId): sessionId is string => sessionId !== null))
}

async function getOpenTaskCount(cwd: string): Promise<number | null> {
  try {
    const home = getHomeDir()
    const { tasksDir: tasksRoot, projectsDir: projectsRoot } = createDefaultTaskStore(home)
    const { projectKeyFromCwd } = await import("../project-key.ts")
    const key = projectKeyFromCwd(cwd)

    const indexedSessionIds = await collectIndexedSessionIds(projectsRoot, key)

    const { readSessionMeta: readMeta } = await import("../tasks/task-repository.ts")
    const sessionIds =
      indexedSessionIds.size > 0
        ? indexedSessionIds
        : await collectSessionIdsByMetaCwd(cwd, tasksRoot, readMeta)

    if (sessionIds.size === 0) return null
    const counts = await Promise.all(
      [...sessionIds].map((sessionId) => countOpenTasksForSession(sessionId, tasksRoot, readMeta))
    )
    return counts.reduce((sum, count) => sum + count, 0)
  } catch {
    return null
  }
}

async function readStatsFile(
  statsPath: string
): Promise<{ totalTimeMs: number; count: number } | null> {
  const file = Bun.file(statsPath)
  if (!(await file.exists())) return null
  try {
    const raw = await file.text()
    const parsed = JSON.parse(raw)
    if (
      typeof parsed.totalTimeMs === "number" &&
      typeof parsed.count === "number" &&
      parsed.count > 0
    ) {
      return { totalTimeMs: parsed.totalTimeMs, count: parsed.count }
    }
  } catch {}
  return null
}

async function getProjectHealth(
  cwd: string,
  options: ProjectHealthOptions = {}
): Promise<ProjectHealth> {
  const [stateData, branch, statusOut, aheadBehind, openTasks, repoRoot] = await Promise.all([
    readStateData(cwd).catch(() => null),
    spawnLine(["git", "-C", cwd, "branch", "--show-current"], {
      timeoutMs: STATUS_GIT_TIMEOUT_MS,
    }).catch(() => null),
    spawnLine(["git", "-C", cwd, "status", "--porcelain"], {
      timeoutMs: STATUS_GIT_TIMEOUT_MS,
    }).catch(() => null),
    spawnLine(["git", "-C", cwd, "rev-list", "--left-right", "--count", "@{upstream}...HEAD"], {
      timeoutMs: STATUS_GIT_TIMEOUT_MS,
    }).catch(() => null),
    getOpenTaskCount(cwd),
    spawnLine(["git", "-C", cwd, "rev-parse", "--show-toplevel"], {
      timeoutMs: STATUS_GIT_TIMEOUT_MS,
    }).catch(() => null),
  ])

  const uncommittedFiles = statusOut ? statusOut.split("\n").filter(Boolean).length : 0
  const aheadBehindResult = parseAheadBehind(aheadBehind)

  // CI: get latest run on this branch (best-effort, no block on failure)
  let ciStatus: string | null = null
  let ciConclusion: string | null = null
  if (branch && process.env.SWIZ_STATUS_SKIP_CI !== "1") {
    const ci = options.refreshCi
      ? await getLiveCiStatus(branch)
      : await getCachedCiStatus(cwd, branch)
    ciStatus = ci.status
    ciConclusion = ci.conclusion
  }

  const state = stateData?.state ?? null
  const isTerminal = state ? TERMINAL_STATES.includes(state as never) : false
  const allowedTransitions = state ? (STATE_TRANSITIONS[state as never] ?? []) : []

  const projectRoot = repoRoot || cwd
  const testStatsPath = join(projectRoot, ".swiz", "test-execution-stats.json")
  const lintStatsPath = join(projectRoot, ".swiz", "lint-execution-stats.json")

  const [testStatsData, lintStatsData] = await Promise.all([
    readStatsFile(testStatsPath),
    readStatsFile(lintStatsPath),
  ])

  const testStats = testStatsData
    ? {
        totalTimeMs: testStatsData.totalTimeMs,
        count: testStatsData.count,
        averageMs: testStatsData.totalTimeMs / testStatsData.count,
        assessment:
          testStatsData.totalTimeMs / testStatsData.count < 5000
            ? ("negligible" as const)
            : ("significant" as const),
      }
    : null

  const lintStats = lintStatsData
    ? {
        totalTimeMs: lintStatsData.totalTimeMs,
        count: lintStatsData.count,
        averageMs: lintStatsData.totalTimeMs / lintStatsData.count,
        assessment:
          lintStatsData.totalTimeMs / lintStatsData.count < 5000
            ? ("negligible" as const)
            : ("significant" as const),
      }
    : null

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
    testStats,
    lintStats,
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

  if (health.testStats) {
    const avgSec = (health.testStats.averageMs / 1000).toFixed(2)
    const runs = health.testStats.count
    const assessmentColor = health.testStats.assessment === "negligible" ? GREEN : RED
    const assessmentText = `${assessmentColor}${health.testStats.assessment}${RESET}`
    console.log(
      `    Avg Test:  ${avgSec}s (based on ${runs} run${runs === 1 ? "" : "s"}) [${assessmentText}]`
    )
  } else {
    console.log(`    Avg Test:  ${DIM}no runs recorded${RESET}`)
  }

  if (health.lintStats) {
    const avgSec = (health.lintStats.averageMs / 1000).toFixed(2)
    const runs = health.lintStats.count
    const assessmentColor = health.lintStats.assessment === "negligible" ? GREEN : RED
    const assessmentText = `${assessmentColor}${health.lintStats.assessment}${RESET}`
    console.log(
      `    Avg Lint:  ${avgSec}s (based on ${runs} run${runs === 1 ? "" : "s"}) [${assessmentText}]`
    )
  } else {
    console.log(`    Avg Lint:  ${DIM}no runs recorded${RESET}`)
  }

  console.log()
}

export const statusCommand: Command = {
  name: "status",
  description: "Show swiz installation status across agents",
  usage: "swiz status [--json] [--no-health] [--refresh-ci]",
  options: [
    { flags: "--json", description: "Output project health as JSON" },
    { flags: "--no-health", description: "Skip project health checks" },
    {
      flags: "--refresh-ci",
      description: "Refresh CI status from GitHub instead of cached sync data",
    },
  ],
  async run(args) {
    const cwd = process.cwd()
    const jsonMode = args.includes("--json")
    const noHealth = args.includes("--no-health")
    const refreshCi = args.includes("--refresh-ci")

    if (jsonMode) {
      const health = await getProjectHealth(cwd, { refreshCi })
      console.log(JSON.stringify(health, null, 2))
      return
    }

    console.log(`\n  ${BOLD}swiz status${RESET}\n`)

    const current = detectCurrentAgent()
    if (current) {
      console.log(`  Running inside: ${GREEN}${current.name}${RESET}\n`)
    }

    console.log(`  Hooks directory: ${HOOKS_DIR}\n`)

    const agentStatuses = await Promise.all(AGENTS.map((agent) => collectAgentStatus(agent)))
    for (const lines of agentStatuses) {
      for (const line of lines) console.log(line)
    }

    if (!noHealth) {
      renderHealthPanel(await getProjectHealth(cwd, { refreshCi }))
    }
  },
}
