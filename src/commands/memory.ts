import { existsSync, readdirSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import { AGENTS, type AgentDef } from "../agents.ts"
import { detectCurrentAgent } from "../detect.ts"
import {
  DEFAULT_MEMORY_LINE_THRESHOLD,
  DEFAULT_MEMORY_WORD_THRESHOLD,
  readProjectSettings,
  readSwizSettings,
  resolveMemoryThresholds,
} from "../settings.ts"
import { projectKeyFromCwd } from "../transcript-utils.ts"
import type { Command } from "../types.ts"

function home(): string {
  return process.env.HOME ?? "~"
}

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

/**
 * Returns the ordered list of rule/memory sources for an agent and target directory.
 * Sources are listed in precedence order: project-local first, then global.
 */
export function getMemorySources(agent: AgentDef, targetDir: string): MemorySource[] {
  const sources: MemorySource[] = []

  switch (agent.id) {
    case "claude": {
      // 1. Project-local CLAUDE.md
      sources.push({ label: "Project rules", path: join(targetDir, "CLAUDE.md") })

      // 2. Project-scoped memory (via ~/.claude/projects/<key>/memory/MEMORY.md)
      const projectKey = projectKeyFromCwd(targetDir)
      const projectMemory = join(home(), ".claude", "projects", projectKey, "memory", "MEMORY.md")
      sources.push({ label: "Project memory", path: projectMemory })

      // 3. Additional memory files in the project memory directory
      const memoryDir = join(home(), ".claude", "projects", projectKey, "memory")
      if (existsSync(memoryDir)) {
        try {
          for (const entry of readdirSync(memoryDir)) {
            if (entry === "MEMORY.md") continue
            if (!entry.endsWith(".md")) continue
            sources.push({
              label: `Project memory (${entry})`,
              path: join(memoryDir, entry),
            })
          }
        } catch {
          // Ignore read errors
        }
      }

      // 4. Global CLAUDE.md
      sources.push({ label: "Global rules", path: join(home(), ".claude", "CLAUDE.md") })
      break
    }

    case "cursor": {
      // 1. Project .cursorrules
      sources.push({ label: "Project rules (.cursorrules)", path: join(targetDir, ".cursorrules") })

      // 2. Project .cursor/rules/ directory
      const projectRulesDir = join(targetDir, ".cursor", "rules")
      if (existsSync(projectRulesDir)) {
        try {
          for (const entry of readdirSync(projectRulesDir)) {
            if (!entry.endsWith(".md") && !entry.endsWith(".mdc")) continue
            sources.push({
              label: `Project rule (${entry})`,
              path: join(projectRulesDir, entry),
            })
          }
        } catch {
          // Ignore read errors
        }
      } else {
        sources.push({ label: "Project rules dir", path: projectRulesDir })
      }

      // 3. Global ~/.cursor/rules/
      const globalRulesDir = join(home(), ".cursor", "rules")
      if (existsSync(globalRulesDir)) {
        try {
          for (const entry of readdirSync(globalRulesDir)) {
            if (!entry.endsWith(".md") && !entry.endsWith(".mdc")) continue
            sources.push({
              label: `Global rule (${entry})`,
              path: join(globalRulesDir, entry),
            })
          }
        } catch {
          // Ignore read errors
        }
      } else {
        sources.push({ label: "Global rules dir", path: globalRulesDir })
      }
      break
    }

    case "gemini": {
      // 1. Project GEMINI.md
      sources.push({ label: "Project rules", path: join(targetDir, "GEMINI.md") })

      // 2. Project .gemini/GEMINI.md
      sources.push({
        label: "Project rules (.gemini/)",
        path: join(targetDir, ".gemini", "GEMINI.md"),
      })

      // 3. Global ~/.gemini/GEMINI.md
      sources.push({ label: "Global rules", path: join(home(), ".gemini", "GEMINI.md") })
      break
    }

    case "codex": {
      // 1. Project AGENTS.md
      sources.push({ label: "Project rules", path: join(targetDir, "AGENTS.md") })

      // 2. Global ~/.codex/instructions.md
      sources.push({
        label: "Global instructions",
        path: join(home(), ".codex", "instructions.md"),
      })
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

async function getFileStats(
  path: string
): Promise<{ lines: number; words: number; chars: number } | null> {
  try {
    const file = Bun.file(path)
    const size = file.size

    // Empty file edge case
    if (size === 0) {
      return { lines: 0, words: 0, chars: 0 }
    }

    // Guard against binary files: check first 512 bytes for null bytes
    const headerBuffer = await file.slice(0, 512).arrayBuffer()
    const headerView = new Uint8Array(headerBuffer)
    for (let i = 0; i < headerView.length; i++) {
      if (headerView[i] === 0) {
        return null // Binary file detected
      }
    }

    // Read and parse file for stats
    const content = await file.text()
    const chars = content.length

    // Count lines (handle CRLF and LF)
    let lines = 0
    let words = 0
    let inWord = false

    for (let i = 0; i < content.length; i++) {
      const char = content.charAt(i)

      // Line counting: count newlines, add 1 if content doesn't end with newline
      if (char === "\n") {
        lines++
      }

      // Word counting: track whitespace boundaries
      const isWhitespace = /\s/.test(char)
      if (!isWhitespace && !inWord) {
        words++
        inWord = true
      } else if (isWhitespace) {
        inWord = false
      }
    }

    // If file doesn't end with newline, add 1 to line count
    if (content.length > 0 && content[content.length - 1] !== "\n") {
      lines++
    }

    return { lines, words, chars }
  } catch {
    return null
  }
}

async function printSource(
  source: MemorySource,
  index: number,
  thresholds: { lines: number; words: number }
): Promise<void> {
  const exists = existsSync(source.path)
  const marker = exists ? `${GREEN}✓${RESET}` : `${DIM}✗${RESET}`
  const pathDisplay = exists ? source.path : `${DIM}${source.path}${RESET}`

  console.log(`  ${index + 1}. ${marker} ${BOLD}${source.label}${RESET}`)
  console.log(`     ${pathDisplay}`)

  if (exists) {
    const size = fileSize(source.path)
    const stats = await getFileStats(source.path)

    let statsStr = size
    let statusIndicator = ""
    if (stats) {
      statsStr += ` · ${stats.lines} lines · ${stats.words} words · ${stats.chars} chars`

      // Check against thresholds
      const lineWarning = stats.lines > thresholds.lines * 0.9 && stats.lines <= thresholds.lines
      const lineExceeded = stats.lines > thresholds.lines
      const wordWarning = stats.words > thresholds.words * 0.9 && stats.words <= thresholds.words
      const wordExceeded = stats.words > thresholds.words

      if (lineExceeded || wordExceeded) {
        statusIndicator = ` ${YELLOW}⚠${RESET}`
      } else if (lineWarning || wordWarning) {
        statusIndicator = ` ${DIM}→${RESET}`
      }
    }
    console.log(`     ${DIM}${statsStr}${RESET}${statusIndicator}`)
  }

  console.log()
}

// ─── Command ─────────────────────────────────────────────────────────────────

export const memoryCommand: Command = {
  name: "memory",
  description: "Show hierarchical rule/memory files for the detected agent",
  usage: "swiz memory [--dir <path>] [--claude|--cursor|--gemini|--codex]",
  options: [
    { flags: "--dir, -d <path>", description: "Target project directory (default: cwd)" },
    { flags: "--claude", description: "Force Claude Code agent" },
    { flags: "--cursor", description: "Force Cursor agent" },
    { flags: "--gemini", description: "Force Gemini CLI agent" },
    { flags: "--codex", description: "Force Codex CLI agent" },
  ],
  async run(args: string[]) {
    // Parse --dir / -d flag
    const dirIdx = args.findIndex((a) => a === "--dir" || a === "-d")
    const dirArg = dirIdx >= 0 ? args[dirIdx + 1] : undefined
    const targetDir = resolve(dirArg ?? process.cwd())

    // Parse agent override flags
    const explicitAgent = AGENTS.find((a) => args.includes(`--${a.id}`))

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
    const thresholds = resolveMemoryThresholds(
      projectSettings,
      {
        memoryLineThreshold: userSettings?.memoryLineThreshold,
        memoryWordThreshold: userSettings?.memoryWordThreshold,
      },
      {
        memoryLineThreshold: DEFAULT_MEMORY_LINE_THRESHOLD,
        memoryWordThreshold: DEFAULT_MEMORY_WORD_THRESHOLD,
      }
    )

    console.log(
      `  ${BOLD}Rule hierarchy${RESET} ${DIM}(${existingCount}/${sources.length} files present)${RESET}\n`
    )
    console.log(
      `  ${DIM}Thresholds: ${thresholds.memoryLineThreshold} lines · ${thresholds.memoryWordThreshold} words${RESET}\n`
    )

    for (const [i, source] of sources.entries()) {
      await printSource(source, i, {
        lines: thresholds.memoryLineThreshold,
        words: thresholds.memoryWordThreshold,
      })
    }
  },
}
