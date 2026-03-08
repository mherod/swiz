import { existsSync, statSync } from "node:fs"
import { resolve } from "node:path"
import { countFileWords, formatActionPlan } from "../../hooks/hook-utils.ts"
import { AGENTS, type AgentDef } from "../agents.ts"
import { BOLD, CYAN, DIM, GREEN, RESET, YELLOW } from "../ansi.ts"
import { detectCurrentAgent } from "../detect.ts"
import {
  compactionChecklistSteps,
  manualCompactionFallback,
} from "../memory-compaction-guidance.ts"
import { getProviderAdapter } from "../provider-adapters.ts"
import {
  DEFAULT_MEMORY_LINE_THRESHOLD,
  DEFAULT_MEMORY_WORD_THRESHOLD,
  readProjectSettings,
  readSwizSettings,
  resolveMemoryThresholds,
} from "../settings.ts"
import { skillAdvice } from "../skill-utils.ts"
import type { Command } from "../types.ts"

// ─── Agent memory hierarchy definitions ─────────────────────────────────────

export interface MemorySource {
  label: string
  path: string
}

interface SourceThresholds {
  lines: number
  words: number
}

interface FileStats {
  lines: number
  words: number
  chars: number
}

interface SourceCheckResult {
  exceeded: boolean
  label: string
  path: string
}

interface ParsedMemoryArgs {
  strict: boolean
  view: boolean
  targetDir: string
  allAgents: boolean
  explicitAgent: AgentDef | undefined
}

const DEFAULT_THRESHOLD_INPUT = {
  memoryLineThreshold: DEFAULT_MEMORY_LINE_THRESHOLD,
  memoryWordThreshold: DEFAULT_MEMORY_WORD_THRESHOLD,
}
const WARNING_THRESHOLD_FACTOR = 0.9

/**
 * Returns the ordered list of rule/memory sources for an agent and target directory.
 * Sources are listed in precedence order: project-local first, then global.
 */
export function getMemorySources(agent: AgentDef, targetDir: string): MemorySource[] {
  const adapter = getProviderAdapter(agent)
  if (!adapter) return []

  return adapter.getMemorySources(targetDir)
}

// ─── Display helpers ─────────────────────────────────────────────────────────

function fileSize(path: string): string {
  try {
    const s = statSync(path)
    if (s.size < 1024) return `${s.size}B`
    if (s.size < 1024 * 1024) return `${(s.size / 1024).toFixed(1)}KB`
    return `${(s.size / (1024 * 1024)).toFixed(1)}MB`
  } catch {
    return "?"
  }
}

function isPresentMemoryFile(path: string): boolean {
  try {
    const stats = statSync(path)
    return stats.isFile() && stats.size > 0
  } catch {
    return false
  }
}

function getThresholdStatus(
  stats: FileStats,
  thresholds: SourceThresholds
): { exceeded: boolean; indicator: string } {
  const lineExceeded = stats.lines > thresholds.lines
  const wordExceeded = stats.words > thresholds.words
  if (lineExceeded || wordExceeded) {
    return { exceeded: true, indicator: ` ${YELLOW}⚠${RESET}` }
  }

  const lineWarning = stats.lines > thresholds.lines * WARNING_THRESHOLD_FACTOR
  const wordWarning = stats.words > thresholds.words * WARNING_THRESHOLD_FACTOR
  if (lineWarning || wordWarning) {
    return { exceeded: false, indicator: ` ${DIM}→${RESET}` }
  }

  return { exceeded: false, indicator: "" }
}

async function printSource(
  source: MemorySource,
  index: number,
  thresholds: SourceThresholds,
  options: { compact?: boolean } = {}
): Promise<SourceCheckResult> {
  if (options.compact) {
    const size = fileSize(source.path)
    let exceeded = false
    let details = size
    let statusIndicator = ""
    const stats = await countFileWords(source.path)
    if (stats) {
      details += ` · ${stats.lines} lines · ${stats.words} words`
      const status = getThresholdStatus(stats, thresholds)
      exceeded = status.exceeded
      statusIndicator = status.indicator
    }
    console.log(`    - ${source.path} ${DIM}(${details})${RESET}${statusIndicator}`)

    return {
      exceeded,
      label: source.label,
      path: source.path,
    }
  }

  const exists = existsSync(source.path)
  const marker = exists ? `${GREEN}✓${RESET}` : `${DIM}✗${RESET}`
  const pathDisplay = exists ? source.path : `${DIM}${source.path}${RESET}`

  console.log(`  ${index + 1}. ${marker} ${BOLD}${source.label}${RESET}`)
  console.log(`     ${pathDisplay}`)

  let exceeded = false
  if (exists) {
    const size = fileSize(source.path)
    const stats = await countFileWords(source.path)

    let statsStr = size
    let statusIndicator = ""
    if (stats) {
      statsStr += ` · ${stats.lines} lines · ${stats.words} words · ${stats.chars} chars`
      const status = getThresholdStatus(stats, thresholds)
      exceeded = status.exceeded
      statusIndicator = status.indicator
    }
    console.log(`     ${DIM}${statsStr}${RESET}${statusIndicator}`)
  }

  console.log()

  return {
    exceeded,
    label: source.label,
    path: source.path,
  }
}

async function printSourceContent(source: MemorySource): Promise<void> {
  console.log(`     ${DIM}----- contents: ${source.path} -----${RESET}`)
  try {
    const content = await Bun.file(source.path).text()
    process.stdout.write(content)
    if (!content.endsWith("\n")) {
      process.stdout.write("\n")
    }
  } catch {
    console.log(`     ${YELLOW}(unable to read file content)${RESET}`)
  }
  console.log(`     ${DIM}----- end contents -----${RESET}`)
}

function parseMemoryArgs(args: string[]): ParsedMemoryArgs {
  const dirIdx = args.findIndex((arg) => arg === "--dir" || arg === "-d")
  const dirArg = dirIdx >= 0 ? args[dirIdx + 1] : undefined
  const explicitAgents = AGENTS.filter((agent) => args.includes(`--${agent.id}`))
  const allAgents = args.includes("--all")

  if (allAgents && explicitAgents.length > 0) {
    throw new Error("`--all` cannot be combined with an explicit agent flag.")
  }
  if (explicitAgents.length > 1) {
    throw new Error("Specify at most one agent: --claude, --cursor, --gemini, or --codex.")
  }

  return {
    targetDir: resolve(dirArg ?? process.cwd()),
    strict: args.includes("--strict"),
    view: args.includes("--view"),
    allAgents,
    explicitAgent: explicitAgents[0],
  }
}

function resolveThresholdSets(
  projectSettings: Awaited<ReturnType<typeof readProjectSettings>>,
  userSettings: Awaited<ReturnType<typeof readSwizSettings>>
): {
  project: ReturnType<typeof resolveMemoryThresholds>
  global: ReturnType<typeof resolveMemoryThresholds>
} {
  const userThresholdInputs = {
    memoryLineThreshold: userSettings?.memoryLineThreshold,
    memoryWordThreshold: userSettings?.memoryWordThreshold,
  }

  return {
    project: resolveMemoryThresholds(projectSettings, userThresholdInputs, DEFAULT_THRESHOLD_INPUT),
    global: resolveMemoryThresholds({}, userThresholdInputs, DEFAULT_THRESHOLD_INPUT),
  }
}

// ─── Command ─────────────────────────────────────────────────────────────────

export const memoryCommand: Command = {
  name: "memory",
  description: "Show hierarchical rule/memory files for one or all agents",
  usage:
    "swiz memory [--dir <path>] [--strict] [--view] [--all|--claude|--cursor|--gemini|--codex]",
  options: [
    { flags: "--dir, -d <path>", description: "Target project directory (default: cwd)" },
    { flags: "--strict", description: "Exit with error if any memory file exceeds its threshold" },
    { flags: "--view", description: "Print full content for each included memory file" },
    {
      flags: "--all",
      description:
        "Show all agents (default when no agent context is detected and no agent flag is provided)",
    },
    { flags: "--claude", description: "Force Claude Code agent" },
    { flags: "--cursor", description: "Force Cursor agent" },
    { flags: "--gemini", description: "Force Gemini CLI agent" },
    { flags: "--codex", description: "Force Codex CLI agent" },
  ],
  async run(args: string[]) {
    const { targetDir, strict, view, allAgents, explicitAgent } = parseMemoryArgs(args)
    const detectedAgent = detectCurrentAgent()
    const targetAgents = allAgents
      ? AGENTS
      : explicitAgent
        ? [explicitAgent]
        : detectedAgent
          ? [detectedAgent]
          : AGENTS
    const showingAllAgents = targetAgents.length > 1

    console.log(`\n  ${BOLD}swiz memory${RESET}`)
    if (showingAllAgents) {
      console.log(`  Agents: ${CYAN}all${RESET}`)
    } else {
      console.log(`  Agent: ${CYAN}${targetAgents[0]!.name}${RESET}`)
    }
    console.log(`  Target: ${targetDir}\n`)

    // Read thresholds from project and user settings
    const projectSettings = await readProjectSettings(targetDir)
    const userSettings = await readSwizSettings({ strict: false })
    const thresholdSets = resolveThresholdSets(projectSettings, userSettings)
    const projectThresholds = thresholdSets.project
    const globalThresholds = thresholdSets.global

    const exceededFiles: Array<SourceCheckResult & { agentName: string }> = []

    let renderedAgentCount = 0
    for (const [agentIndex, agent] of targetAgents.entries()) {
      const sources = getMemorySources(agent, targetDir)
      if (sources.length === 0) {
        if (showingAllAgents) continue
        console.log(`  ${YELLOW}No memory sources defined for ${agent.name}${RESET}\n`)
        continue
      }

      const existingSources = sources.filter((source) => isPresentMemoryFile(source.path))
      if (existingSources.length === 0) {
        if (showingAllAgents) continue
        console.log(`  ${YELLOW}No memory files found for ${agent.name}${RESET}\n`)
        continue
      }

      if (showingAllAgents) {
        if (renderedAgentCount > 0) {
          console.log()
        }
        console.log(`  ${BOLD}${agent.name}${RESET}`)
        console.log(
          `  ${DIM}Thresholds: ${projectThresholds.memoryLineThreshold} lines · ${projectThresholds.memoryWordThreshold} words${RESET}`
        )
      }

      if (!showingAllAgents) {
        console.log(
          `  ${BOLD}Rule hierarchy${RESET} ${DIM}(${existingSources.length} files present)${RESET}\n`
        )
        console.log(
          `  ${DIM}Thresholds: ${projectThresholds.memoryLineThreshold} lines · ${projectThresholds.memoryWordThreshold} words${RESET}\n`
        )
      }

      const globalHome = getProviderAdapter(agent)?.getHomeDir() ?? ""
      for (const [sourceIndex, source] of existingSources.entries()) {
        // Use global thresholds for sources in the global home directory
        const isGlobal = globalHome.length > 0 && source.path.startsWith(globalHome)
        const thresholds = isGlobal ? globalThresholds : projectThresholds

        const result = await printSource(
          source,
          sourceIndex,
          {
            lines: thresholds.memoryLineThreshold,
            words: thresholds.memoryWordThreshold,
          },
          { compact: showingAllAgents }
        )

        if (view) {
          await printSourceContent(source)
        }

        if (result.exceeded) {
          exceededFiles.push({ ...result, agentName: agent.name })
        }
      }

      renderedAgentCount++

      if (!showingAllAgents && agentIndex < targetAgents.length - 1) {
        console.log()
      }
    }

    if (strict && exceededFiles.length > 0) {
      const fileList = exceededFiles
        .map((f) => `  - ${f.agentName}: ${f.label} (${f.path})`)
        .join("\n")

      const compactAdvice = skillAdvice(
        "compact-memory",
        "Use the /compact-memory skill to reduce each file below thresholds.",
        manualCompactionFallback("each file")
      )
      const compactionChecklist = formatActionPlan(
        compactionChecklistSteps("Re-check each file after edits with `wc -l` and `wc -w`."),
        { header: "Compaction checklist:" }
      ).trimEnd()

      const guidance = [
        `Memory file(s) exceed size thresholds:\n${fileList}`,
        `\nThresholds: ${projectThresholds.memoryLineThreshold} lines, ${projectThresholds.memoryWordThreshold} words`,
        `\n${compactAdvice}`,
        `\n${compactionChecklist}`,
      ].join("\n")

      throw new Error(guidance)
    }
  },
}
