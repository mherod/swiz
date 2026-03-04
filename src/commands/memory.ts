import { existsSync, readdirSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import { AGENTS, type AgentDef } from "../agents.ts"
import { detectCurrentAgent } from "../detect.ts"
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

function printSource(source: MemorySource, index: number): void {
  const exists = existsSync(source.path)
  const marker = exists ? `${GREEN}✓${RESET}` : `${DIM}✗${RESET}`
  const pathDisplay = exists ? source.path : `${DIM}${source.path}${RESET}`

  console.log(`  ${index + 1}. ${marker} ${BOLD}${source.label}${RESET}`)
  console.log(`     ${pathDisplay}`)

  if (exists) {
    const size = fileSize(source.path)
    console.log(`     ${DIM}${size}${RESET}`)
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

    console.log(
      `  ${BOLD}Rule hierarchy${RESET} ${DIM}(${existingCount}/${sources.length} files present)${RESET}\n`
    )

    for (const [i, source] of sources.entries()) {
      printSource(source, i)
    }
  },
}
