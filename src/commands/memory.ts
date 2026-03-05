import { existsSync, statSync } from "node:fs"
import { basename, join, resolve } from "node:path"
import { AGENTS, type AgentDef } from "../agents.ts"
import { detectCurrentAgent } from "../detect.ts"
import {
  getProviderHome,
  getProviderProjectFiles,
  getProviderProjectStateDir,
  getProviderRuleDirs,
  scanProviderRuleDir,
} from "../provider-utils.ts"
import {
  DEFAULT_MEMORY_LINE_THRESHOLD,
  DEFAULT_MEMORY_WORD_THRESHOLD,
  readProjectSettings,
  readSwizSettings,
  resolveMemoryThresholds,
} from "../settings.ts"
import { skillAdvice } from "../skill-utils.ts"
import type { Command } from "../types.ts"

const BOLD = "\x1b[1m"
const DIM = "\x1b[2m"
const GREEN = "\x1b[32m"
const YELLOW = "\x1b[33m"
const CYAN = "\x1b[36m"
const RESET = "\x1b[0m"

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
  targetDir: string
  explicitAgent: AgentDef | undefined
}

const DEFAULT_THRESHOLD_INPUT = {
  memoryLineThreshold: DEFAULT_MEMORY_LINE_THRESHOLD,
  memoryWordThreshold: DEFAULT_MEMORY_WORD_THRESHOLD,
}
const BINARY_SCAN_BYTES = 512
const WARNING_THRESHOLD_FACTOR = 0.9
const WHITESPACE_RE = /\s/

function pushSource(sources: MemorySource[], label: string, path: string): void {
  sources.push({ label, path })
}

function appendRuleFiles(
  sources: MemorySource[],
  agent: AgentDef,
  dirPath: string,
  labelForEntry: (entryName: string) => string
): void {
  const files = scanProviderRuleDir(agent, dirPath)
  for (const file of files) {
    pushSource(sources, labelForEntry(basename(file)), file)
  }
}

function appendCursorRuleDir(
  sources: MemorySource[],
  agent: AgentDef,
  dirPath: string | null,
  missingDirLabel: string,
  labelForEntry: (entryName: string) => string
): void {
  if (!dirPath) return

  if (!existsSync(dirPath)) {
    pushSource(sources, missingDirLabel, dirPath)
    return
  }

  appendRuleFiles(sources, agent, dirPath, labelForEntry)
}

/**
 * Returns the ordered list of rule/memory sources for an agent and target directory.
 * Sources are listed in precedence order: project-local first, then global.
 */
export function getMemorySources(agent: AgentDef, targetDir: string): MemorySource[] {
  const sources: MemorySource[] = []

  switch (agent.id) {
    case "claude": {
      // 1. Project-local CLAUDE.md
      pushSource(sources, "Project rules", join(targetDir, "CLAUDE.md"))

      // 2. Project-scoped memory (via ~/.claude/projects/<key>/memory/MEMORY.md)
      const memoryDir = getProviderProjectStateDir(agent, targetDir)
      const projectMemory = join(memoryDir, "MEMORY.md")
      pushSource(sources, "Project memory", projectMemory)

      // 3. Additional memory files in the project memory directory
      const memoryFiles = scanProviderRuleDir(agent, memoryDir).filter(
        (file) => file !== projectMemory
      )
      for (const file of memoryFiles) {
        pushSource(sources, `Project memory (${basename(file)})`, file)
      }

      // 4. Global CLAUDE.md
      const globalHome = getProviderHome(agent)
      pushSource(sources, "Global rules", join(globalHome, "CLAUDE.md"))
      break
    }

    case "cursor": {
      // 1. Project .cursorrules
      const projectFiles = getProviderProjectFiles(agent, targetDir)
      for (const file of projectFiles) {
        pushSource(sources, "Project rules (.cursorrules)", file)
      }

      // 2. Project .cursor/rules/ directory
      const ruleDirs = getProviderRuleDirs(agent, targetDir)
      appendCursorRuleDir(
        sources,
        agent,
        ruleDirs.project,
        "Project rules dir",
        (entryName) => `Project rule (${entryName})`
      )

      // 3. Global ~/.cursor/rules/
      appendCursorRuleDir(
        sources,
        agent,
        ruleDirs.global,
        "Global rules dir",
        (entryName) => `Global rule (${entryName})`
      )
      break
    }

    case "gemini": {
      // 1. Project GEMINI.md
      const projectFiles = getProviderProjectFiles(agent, targetDir)
      for (const file of projectFiles) {
        if (file.endsWith("GEMINI.md")) {
          const label = file.includes(".gemini") ? "Project rules (.gemini/)" : "Project rules"
          pushSource(sources, label, file)
        }
      }

      // 2. Global ~/.gemini/GEMINI.md
      const globalHome = getProviderHome(agent)
      pushSource(sources, "Global rules", join(globalHome, "GEMINI.md"))
      break
    }

    case "codex": {
      // 1. Project AGENTS.md
      const projectFiles = getProviderProjectFiles(agent, targetDir)
      for (const file of projectFiles) {
        pushSource(sources, "Project rules", file)
      }

      // 2. Global ~/.codex/AGENTS.md
      const globalHome = getProviderHome(agent)
      pushSource(sources, "Global rules", join(globalHome, "AGENTS.md"))

      // 3. Global ~/.codex/instructions.md
      pushSource(sources, "Global instructions", join(globalHome, "instructions.md"))

      // 4. Global ~/.codex/history.jsonl (Codex prompt/session context index)
      pushSource(sources, "Global history", join(globalHome, "history.jsonl"))
      break
    }

    default:
      break
  }

  return sources
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

function containsNullByte(buffer: Uint8Array): boolean {
  for (const byte of buffer) {
    if (byte === 0) return true
  }
  return false
}

function countTextStats(content: string): FileStats {
  let lines = 0
  let words = 0
  let inWord = false

  for (let i = 0; i < content.length; i++) {
    const char = content.charAt(i)
    if (char === "\n") {
      lines++
    }

    if (WHITESPACE_RE.test(char)) {
      inWord = false
      continue
    }

    if (!inWord) {
      words++
      inWord = true
    }
  }

  if (content.length > 0 && content[content.length - 1] !== "\n") {
    lines++
  }

  return {
    lines,
    words,
    chars: content.length,
  }
}

async function getFileStats(path: string): Promise<FileStats | null> {
  try {
    const file = Bun.file(path)

    // Empty file edge case
    if (file.size === 0) {
      return { lines: 0, words: 0, chars: 0 }
    }

    // Guard against binary files: check first 512 bytes for null bytes
    const headerBuffer = await file.slice(0, BINARY_SCAN_BYTES).arrayBuffer()
    const headerView = new Uint8Array(headerBuffer)
    if (containsNullByte(headerView)) {
      return null
    }

    return countTextStats(await file.text())
  } catch {
    return null
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
  thresholds: SourceThresholds
): Promise<SourceCheckResult> {
  const exists = existsSync(source.path)
  const marker = exists ? `${GREEN}✓${RESET}` : `${DIM}✗${RESET}`
  const pathDisplay = exists ? source.path : `${DIM}${source.path}${RESET}`

  console.log(`  ${index + 1}. ${marker} ${BOLD}${source.label}${RESET}`)
  console.log(`     ${pathDisplay}`)

  let exceeded = false
  if (exists) {
    const size = fileSize(source.path)
    const stats = await getFileStats(source.path)

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

function parseMemoryArgs(args: string[]): ParsedMemoryArgs {
  const dirIdx = args.findIndex((arg) => arg === "--dir" || arg === "-d")
  const dirArg = dirIdx >= 0 ? args[dirIdx + 1] : undefined

  return {
    targetDir: resolve(dirArg ?? process.cwd()),
    strict: args.includes("--strict"),
    explicitAgent: AGENTS.find((agent) => args.includes(`--${agent.id}`)),
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
  description: "Show hierarchical rule/memory files for the detected agent",
  usage: "swiz memory [--dir <path>] [--strict] [--claude|--cursor|--gemini|--codex]",
  options: [
    { flags: "--dir, -d <path>", description: "Target project directory (default: cwd)" },
    { flags: "--strict", description: "Exit with error if any memory file exceeds its threshold" },
    { flags: "--claude", description: "Force Claude Code agent" },
    { flags: "--cursor", description: "Force Cursor agent" },
    { flags: "--gemini", description: "Force Gemini CLI agent" },
    { flags: "--codex", description: "Force Codex CLI agent" },
  ],
  async run(args: string[]) {
    const { targetDir, strict, explicitAgent } = parseMemoryArgs(args)
    const agent = explicitAgent ?? detectCurrentAgent()

    if (!agent) {
      throw new Error(
        "No agent detected. Use --claude, --cursor, --gemini, or --codex to specify one."
      )
    }

    console.log(`\n  ${BOLD}swiz memory${RESET}`)
    console.log(`  Agent: ${CYAN}${agent.name}${RESET}`)
    console.log(`  Target: ${targetDir}\n`)

    const sources = getMemorySources(agent, targetDir)

    if (sources.length === 0) {
      console.log(`  ${YELLOW}No memory sources defined for ${agent.name}${RESET}\n`)
      return
    }

    const existingCount = sources.filter((s) => existsSync(s.path)).length

    // Read thresholds from project and user settings
    const projectSettings = await readProjectSettings(targetDir)
    const userSettings = await readSwizSettings({ strict: false })
    const thresholdSets = resolveThresholdSets(projectSettings, userSettings)
    const projectThresholds = thresholdSets.project
    const globalThresholds = thresholdSets.global

    const globalHome = getProviderHome(agent)

    console.log(
      `  ${BOLD}Rule hierarchy${RESET} ${DIM}(${existingCount}/${sources.length} files present)${RESET}\n`
    )
    console.log(
      `  ${DIM}Thresholds: ${projectThresholds.memoryLineThreshold} lines · ${projectThresholds.memoryWordThreshold} words${RESET}\n`
    )

    const exceededFiles: SourceCheckResult[] = []

    for (const [i, source] of sources.entries()) {
      // Use global thresholds for sources in the global home directory
      const isGlobal = source.path.startsWith(globalHome)
      const thresholds = isGlobal ? globalThresholds : projectThresholds

      const result = await printSource(source, i, {
        lines: thresholds.memoryLineThreshold,
        words: thresholds.memoryWordThreshold,
      })

      if (result.exceeded) {
        exceededFiles.push(result)
      }
    }

    if (strict && exceededFiles.length > 0) {
      const fileList = exceededFiles.map((f) => `  - ${f.label} (${f.path})`).join("\n")

      const compactAdvice = skillAdvice(
        "compact-memory",
        "Use the /compact-memory skill to reduce each file below thresholds.",
        "Compact manually: remove redundant modifiers, simplify compound phrases, consolidate repeated topics, convert narrative to DO/DON'T directives."
      )

      const guidance = [
        `Memory file(s) exceed size thresholds:\n${fileList}`,
        `\nThresholds: ${projectThresholds.memoryLineThreshold} lines, ${projectThresholds.memoryWordThreshold} words`,
        `\n${compactAdvice}`,
      ].join("\n")

      throw new Error(guidance)
    }
  },
}
