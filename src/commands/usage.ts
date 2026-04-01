import { basename, join } from "node:path"
import { BOLD, DIM, RESET } from "../ansi.ts"
import { getHomeDirOrNull } from "../home.ts"
import type { Command } from "../types.ts"

const DEFAULT_TOP = 10

interface SkillUsageStat {
  usageCount?: number
}

interface ModelUsageStat {
  inputTokens?: number
  outputTokens?: number
  cacheReadInputTokens?: number
  cacheCreationInputTokens?: number
  costUSD?: number
}

interface ProjectUsageStat {
  lastCost?: number
  lastTotalInputTokens?: number
  lastTotalOutputTokens?: number
  lastTotalCacheReadInputTokens?: number
  lastTotalCacheCreationInputTokens?: number
  lastModelUsage?: Record<string, ModelUsageStat>
}

interface ClaudeUsageFile {
  numStartups?: number
  installMethod?: string
  autoUpdates?: boolean
  promptQueueUseCount?: number
  mcpServers?: Record<string, any>
  projects?: Record<string, ProjectUsageStat>
  skillUsage?: Record<string, SkillUsageStat>
}

interface ParsedUsageArgs {
  filePath?: string
  asJson: boolean
  top: number
}

interface NamedMetric {
  name: string
  value: number
}

interface ModelAggregate {
  model: string
  input: number
  output: number
  cacheRead: number
  cacheCreate: number
  cost: number
}

interface UsageTotals {
  input: number
  output: number
  cacheRead: number
  cacheCreate: number
  cost: number
  outputToInputRatio: number | null
  cacheReadToInputRatio: number | null
}

export interface UsageReport {
  generatedAt: string
  sourcePath: string
  startups: number
  installMethod: string | null
  autoUpdates: boolean | null
  promptQueueUseCount: number
  projectCount: number
  mcpServers: string[]
  topSkills: NamedMetric[]
  topProjectsByCost: NamedMetric[]
  topProjectsByOutput: NamedMetric[]
  modelUsage: ModelAggregate[]
  totals: UsageTotals
}

function numberOrZero(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function usageText(): string {
  return (
    "Usage: swiz usage [--file <path>] [--top <n>] [--json]\n" +
    "  --file, -f <path>   Path to Claude usage JSON (default: ~/.claude.json)\n" +
    "  --top, -n <number>  Number of rows to show per ranking (default: 10)\n" +
    "  --json              Emit machine-readable JSON summary"
  )
}

function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid value for ${flag}: "${value}"\n${usageText()}`)
  }
  return parsed
}

export function parseUsageArgs(args: string[]): ParsedUsageArgs {
  let filePath: string | undefined
  let asJson = false
  let top = DEFAULT_TOP

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg) continue

    if (arg === "--json") {
      asJson = true
      continue
    }

    if (arg === "--file" || arg === "-f") {
      const value = args[i + 1]
      if (!value) {
        throw new Error(`Missing value for ${arg}\n${usageText()}`)
      }
      filePath = value
      i++
      continue
    }

    if (arg === "--top" || arg === "-n") {
      const value = args[i + 1]
      if (!value) {
        throw new Error(`Missing value for ${arg}\n${usageText()}`)
      }
      top = parsePositiveInteger(value, arg)
      i++
      continue
    }

    throw new Error(`Unknown argument: ${arg}\n${usageText()}`)
  }

  return { filePath, asJson, top }
}

function topN(entries: NamedMetric[], n: number): NamedMetric[] {
  return entries
    .filter((entry) => entry.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, n)
}

function aggregateModels(projects: Record<string, ProjectUsageStat>): ModelAggregate[] {
  const byModel = new Map<string, ModelAggregate>()

  for (const project of Object.values(projects)) {
    const modelUsage = project.lastModelUsage ?? {}
    for (const [model, usage] of Object.entries(modelUsage)) {
      const existing = byModel.get(model) ?? {
        model,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheCreate: 0,
        cost: 0,
      }

      existing.input += numberOrZero(usage.inputTokens)
      existing.output += numberOrZero(usage.outputTokens)
      existing.cacheRead += numberOrZero(usage.cacheReadInputTokens)
      existing.cacheCreate += numberOrZero(usage.cacheCreationInputTokens)
      existing.cost += numberOrZero(usage.costUSD)

      byModel.set(model, existing)
    }
  }

  return Array.from(byModel.values()).sort((a, b) => b.cost - a.cost)
}

function buildTotals(projects: Record<string, ProjectUsageStat>): UsageTotals {
  let input = 0
  let output = 0
  let cacheRead = 0
  let cacheCreate = 0
  let cost = 0

  for (const project of Object.values(projects)) {
    input += numberOrZero(project.lastTotalInputTokens)
    output += numberOrZero(project.lastTotalOutputTokens)
    cacheRead += numberOrZero(project.lastTotalCacheReadInputTokens)
    cacheCreate += numberOrZero(project.lastTotalCacheCreationInputTokens)
    cost += numberOrZero(project.lastCost)
  }

  return {
    input,
    output,
    cacheRead,
    cacheCreate,
    cost,
    outputToInputRatio: input > 0 ? output / input : null,
    cacheReadToInputRatio: input > 0 ? cacheRead / input : null,
  }
}

function projectName(path: string): string {
  const value = basename(path)
  return value.length > 0 ? value : path
}

export function buildUsageReport(
  data: ClaudeUsageFile,
  sourcePath: string,
  top: number
): UsageReport {
  const projects = data.projects ?? {}
  const skills = data.skillUsage ?? {}
  const mcpServers = Object.keys(data.mcpServers ?? {})

  const topSkills = topN(
    Object.entries(skills).map(([name, stat]) => ({
      name,
      value: numberOrZero(stat.usageCount),
    })),
    top
  )

  const topProjectsByCost = topN(
    Object.entries(projects).map(([path, project]) => ({
      name: projectName(path),
      value: numberOrZero(project.lastCost),
    })),
    top
  )

  const topProjectsByOutput = topN(
    Object.entries(projects).map(([path, project]) => ({
      name: projectName(path),
      value: numberOrZero(project.lastTotalOutputTokens),
    })),
    top
  )

  return {
    generatedAt: new Date().toISOString(),
    sourcePath,
    startups: numberOrZero(data.numStartups),
    installMethod: data.installMethod ?? null,
    autoUpdates: typeof data.autoUpdates === "boolean" ? data.autoUpdates : null,
    promptQueueUseCount: numberOrZero(data.promptQueueUseCount),
    projectCount: Object.keys(projects).length,
    mcpServers,
    topSkills,
    topProjectsByCost,
    topProjectsByOutput,
    modelUsage: aggregateModels(projects),
    totals: buildTotals(projects),
  }
}

function formatInt(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value)
}

function formatMoney(value: number): string {
  return `$${value.toFixed(2)}`
}

function formatRatio(value: number | null): string {
  if (value === null) return "n/a"
  return `${value.toFixed(2)}x`
}

function formatPath(path: string): string {
  const home = getHomeDirOrNull()
  if (home && path.startsWith(home)) {
    return `~${path.slice(home.length)}`
  }
  return path
}

function printRanked(
  title: string,
  items: NamedMetric[],
  formatter: (value: number) => string
): void {
  console.log(`\n  ${BOLD}${title}${RESET}`)
  if (items.length === 0) {
    console.log(`  ${DIM}(no data)${RESET}`)
    return
  }
  for (const [index, item] of items.entries()) {
    console.log(`  ${index + 1}. ${item.name}  ${DIM}${formatter(item.value)}${RESET}`)
  }
}

function printModelUsage(rows: ModelAggregate[]): void {
  console.log(`\n  ${BOLD}Model Usage${RESET}`)
  if (rows.length === 0) {
    console.log(`  ${DIM}(no data)${RESET}`)
    return
  }

  for (const row of rows) {
    console.log(
      `  - ${row.model}  ${DIM}${formatMoney(row.cost)} · out ${formatInt(row.output)} · in ${formatInt(
        row.input
      )}${RESET}`
    )
  }
}

async function readUsageFile(path: string): Promise<ClaudeUsageFile> {
  const file = Bun.file(path)
  if (!(await file.exists())) {
    throw new Error(`Claude usage file not found: ${path}`)
  }

  let parsed: unknown
  try {
    parsed = await file.json()
  } catch {
    throw new Error(`Failed to parse JSON: ${path}`)
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid JSON structure in: ${path}`)
  }

  return parsed as ClaudeUsageFile
}

function defaultUsagePath(): string {
  const home = getHomeDirOrNull()
  if (!home) {
    throw new Error(`HOME is not set. Pass --file <path>.\n${usageText()}`)
  }
  return join(home, ".claude.json")
}

function printReport(report: UsageReport): void {
  console.log(`\n  ${BOLD}swiz usage${RESET}\n`)
  console.log(`  File: ${DIM}${formatPath(report.sourcePath)}${RESET}`)
  console.log(`  Startups: ${report.startups}`)
  console.log(`  Install: ${report.installMethod ?? "unknown"}`)
  console.log(
    `  Auto updates: ${report.autoUpdates === null ? "unknown" : String(report.autoUpdates)}`
  )
  console.log(`  Projects tracked: ${report.projectCount}`)
  console.log(`  Prompt queue uses: ${report.promptQueueUseCount}`)
  console.log(
    `  MCP servers: ${
      report.mcpServers.length > 0 ? report.mcpServers.join(", ") : `${DIM}(none)${RESET}`
    }`
  )

  printRanked("Top Skills", report.topSkills, (value) => formatInt(value))
  printRanked("Top Projects By Cost", report.topProjectsByCost, (value) => formatMoney(value))
  printRanked("Top Projects By Output Tokens", report.topProjectsByOutput, (value) =>
    formatInt(value)
  )
  printModelUsage(report.modelUsage)

  console.log(`\n  ${BOLD}Totals${RESET}`)
  console.log(`  Input tokens: ${formatInt(report.totals.input)}`)
  console.log(`  Output tokens: ${formatInt(report.totals.output)}`)
  console.log(`  Cache read tokens: ${formatInt(report.totals.cacheRead)}`)
  console.log(`  Cache create tokens: ${formatInt(report.totals.cacheCreate)}`)
  console.log(`  Estimated cost: ${formatMoney(report.totals.cost)}`)
  console.log(`  Output/Input ratio: ${formatRatio(report.totals.outputToInputRatio)}`)
  console.log(`  CacheRead/Input ratio: ${formatRatio(report.totals.cacheReadToInputRatio)}`)
  console.log()
}

export const usageCommand: Command = {
  name: "usage",
  description: "Summarize Claude usage data from ~/.claude.json",
  usage: "swiz usage [--file <path>] [--top <n>] [--json]",
  options: [
    { flags: "--file, -f <path>", description: "Path to usage JSON (default: ~/.claude.json)" },
    { flags: "--top, -n <number>", description: "Rows per ranking section (default: 10)" },
    { flags: "--json", description: "Emit machine-readable JSON report" },
  ],
  async run(args) {
    const parsedArgs = parseUsageArgs(args)
    const sourcePath = parsedArgs.filePath ?? defaultUsagePath()
    const data = await readUsageFile(sourcePath)
    const report = buildUsageReport(data, sourcePath, parsedArgs.top)

    if (parsedArgs.asJson) {
      console.log(JSON.stringify(report, null, 2))
      return
    }

    printReport(report)
  },
}
