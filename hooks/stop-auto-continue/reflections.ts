#!/usr/bin/env bun
// Reflection persistence module for stop-auto-continue hook
// Handles writing agent-extracted reflections to project MEMORY.md

import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { getHomeDir } from "../../src/home.ts"
import { projectKeyFromCwd } from "../../src/project-key.ts"

const HOME = getHomeDir()
const PROJECTS_DIR = join(HOME, ".claude", "projects")

/**
 * Locate the project directory from a given cwd.
 * Returns the project directory path if found, null otherwise.
 * Tries both derived lookup and fallback scan of PROJECTS_DIR.
 */
export async function findProjectDir(cwd: string): Promise<string | null> {
  const projectKey = projectKeyFromCwd(cwd)
  const derived = join(PROJECTS_DIR, projectKey)
  try {
    await readdir(derived)
    return derived
  } catch {}

  // Fallback: scan project dirs for one that matches this CWD
  try {
    const dirs = await readdir(PROJECTS_DIR)
    for (const dir of dirs) {
      if (projectKey === dir) return join(PROJECTS_DIR, dir)
    }
  } catch {}

  return null
}

/**
 * Write agent-extracted reflections to the project's MEMORY.md file.
 * Deduplicates against existing content and respects a ~200-line cap.
 * Never throws — failures are silently swallowed.
 */
export async function writeReflections(cwd: string, reflections: string[]): Promise<void> {
  try {
    const projectDir = await findProjectDir(cwd)
    if (!projectDir) return

    const memoryDir = join(projectDir, "memory")
    try {
      await readdir(memoryDir)
    } catch {
      return
    }

    const memoryFile = join(memoryDir, "MEMORY.md")

    let existing = ""
    if (await Bun.file(memoryFile).exists()) {
      existing = await Bun.file(memoryFile).text()
    }

    // Deduplicate against existing content — strip DO/DON'T prefix before comparing
    // so "DO: Always use bun" matches "- **DO**: Always use bun" in memory
    const existingLower = existing.toLowerCase()
    const newReflections = reflections.filter((r) => {
      const text = r.replace(/^(DO|DON'T):\s*/i, "")
      const core = text.toLowerCase().slice(0, 60)
      return !existingLower.includes(core)
    })

    if (newReflections.length === 0) return

    // Check line count won't exceed ~200
    const currentLines = existing.split("\n").length
    if (currentLines + newReflections.length + 3 > 200) return

    // Append as prescriptive directives
    let append = "\n\n## Confirmed Patterns\n\n"
    if (existing.includes("## Confirmed Patterns")) {
      append = "\n"
    }
    for (const r of newReflections) {
      const match = r.match(/^(DO|DON'T):\s*(.+)/i)
      if (match) {
        const prefix = match[1]!.toUpperCase()
        const text = match[2]!
        append += `- **${prefix}**: ${text}\n`
      } else {
        append += `- **DO**: ${r}\n`
      }
    }

    await Bun.write(memoryFile, existing + append)
  } catch {
    // Never block on memory write failure
  }
}
