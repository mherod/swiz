import { readdir, stat } from "node:fs/promises"
import { join } from "node:path"
import type { Command } from "../types.ts"

const HOME = process.env.HOME ?? "~"
const PROJECTS_DIR = join(HOME, ".claude", "projects")

// Matches standard UUID v4 — session dirs only; named dirs (memory/, etc.) never match
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// ─── ANSI ────────────────────────────────────────────────────────────────────

const RESET = "\x1b[0m"
const BOLD = "\x1b[1m"
const DIM = "\x1b[2m"
const GREEN = "\x1b[32m"
const YELLOW = "\x1b[33m"

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)}GB`
}

async function dirSize(dirPath: string): Promise<number> {
  let total = 0
  try {
    const entries = await readdir(dirPath, { withFileTypes: true })
    for (const entry of entries) {
      const p = join(dirPath, entry.name)
      if (entry.isDirectory()) {
        total += await dirSize(p)
      } else {
        try {
          total += (await stat(p)).size
        } catch {
          // skip unreadable files
        }
      }
    }
  } catch {
    // skip unreadable dirs
  }
  return total
}

async function trashDir(path: string): Promise<boolean> {
  const proc = Bun.spawn(["trash", path], { stdout: "pipe", stderr: "pipe" })
  await proc.exited
  return proc.exitCode === 0
}

// ─── Session discovery ───────────────────────────────────────────────────────

interface SessionInfo {
  path: string
  birthtimeMs: number
  sizeBytes: number
}

async function findSessions(
  projectDir: string,
  cutoffMs: number
): Promise<{ keep: SessionInfo[]; old: SessionInfo[] }> {
  const keep: SessionInfo[] = []
  const old: SessionInfo[] = []

  let entries: string[]
  try {
    entries = await readdir(projectDir)
  } catch {
    return { keep, old }
  }

  for (const entry of entries) {
    if (!UUID_RE.test(entry)) continue
    const sessionPath = join(projectDir, entry)
    let s: Awaited<ReturnType<typeof stat>>
    try {
      s = await stat(sessionPath)
    } catch {
      continue
    }
    if (!s.isDirectory()) continue

    const info: SessionInfo = {
      path: sessionPath,
      birthtimeMs: s.birthtimeMs,
      sizeBytes: await dirSize(sessionPath),
    }

    if (s.birthtimeMs < cutoffMs) {
      old.push(info)
    } else {
      keep.push(info)
    }
  }

  return { keep, old }
}

// ─── Command ─────────────────────────────────────────────────────────────────

export const cleanupCommand: Command = {
  name: "cleanup",
  description: "Remove old Claude Code session data from ~/.claude/projects/",
  usage: "cleanup [--older-than <days>] [--dry-run] [--project <name>]",

  async run(args: string[]) {
    let olderThanDays = 30
    let dryRun = false
    let projectFilter: string | undefined

    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!
      if (arg === "--dry-run") {
        dryRun = true
      } else if (arg === "--older-than" && args[i + 1]) {
        const days = parseInt(args[++i]!, 10)
        if (isNaN(days) || days < 1) {
          throw new Error("--older-than requires a positive integer (days)")
        }
        olderThanDays = days
      } else if (arg === "--project" && args[i + 1]) {
        projectFilter = args[++i]
      }
    }

    const cutoffMs = Date.now() - olderThanDays * 24 * 60 * 60 * 1000

    // Discover project dirs
    let projectNames: string[]
    try {
      const entries = await readdir(PROJECTS_DIR, { withFileTypes: true })
      projectNames = entries
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .filter((name) => !projectFilter || name === projectFilter)
        .sort()
    } catch {
      console.log(`No projects directory found at ${PROJECTS_DIR}`)
      return
    }

    if (projectFilter && projectNames.length === 0) {
      throw new Error(`Project "${projectFilter}" not found in ${PROJECTS_DIR}`)
    }

    // Scan each project
    interface ProjectResult {
      name: string
      keep: SessionInfo[]
      old: SessionInfo[]
    }

    const results: ProjectResult[] = []
    for (const name of projectNames) {
      const { keep, old } = await findSessions(join(PROJECTS_DIR, name), cutoffMs)
      if (keep.length > 0 || old.length > 0) {
        results.push({ name, keep, old })
      }
    }

    if (results.length === 0) {
      console.log(`No session directories found (older than ${olderThanDays} days).`)
      return
    }

    // Print table
    console.log()
    console.log(`  ${BOLD}~/.claude/projects/${RESET}`)

    let totalOldCount = 0
    let totalOldBytes = 0

    for (const { name, keep, old } of results) {
      const total = keep.length + old.length
      const oldBytes = old.reduce((sum, s) => sum + s.sizeBytes, 0)
      totalOldCount += old.length
      totalOldBytes += oldBytes

      const trashPart =
        old.length > 0
          ? `${YELLOW}${old.length} trashable${RESET} (${formatBytes(oldBytes)})`
          : `${DIM}0 trashable${RESET}`
      console.log(
        `    ${name.padEnd(44)} ${String(total).padStart(3)} sessions  →  ${keep.length} kept, ${trashPart}`
      )
    }

    console.log()

    if (totalOldCount === 0) {
      console.log(`  ${GREEN}No sessions older than ${olderThanDays} days found.${RESET}`)
      return
    }

    console.log(
      `  Total: ${BOLD}${totalOldCount} sessions${RESET} trashable, ~${formatBytes(totalOldBytes)}`
    )
    console.log()

    if (dryRun) {
      console.log(`  ${DIM}Run without --dry-run to proceed.${RESET}`)
      return
    }

    // Trash sessions
    console.log(`  Moving ${totalOldCount} session(s) to Trash...`)
    let succeeded = 0
    let failed = 0

    for (const { old } of results) {
      for (const session of old) {
        if (await trashDir(session.path)) succeeded++
        else failed++
      }
    }

    console.log()
    console.log(
      `  ${GREEN}${BOLD}Done.${RESET} ${succeeded} session(s) moved to Trash (~${formatBytes(totalOldBytes)} reclaimed).`
    )
    if (failed > 0) {
      console.log(
        `  ${YELLOW}${failed} session(s) could not be trashed — is the \`trash\` CLI installed?${RESET}`
      )
    }
  },
}
