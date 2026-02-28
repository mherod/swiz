/**
 * README accuracy regression tests.
 *
 * Guards against three failure modes discovered after the 2026-02-28 README
 * refresh:
 *
 *  1. Hook filenames listed in README tables that don't exist on disk.
 *  2. Section headings claiming a count that doesn't match the actual table rows.
 *  3. README totals drifting from the canonical hook manifest.
 *
 * Runs as part of `bun test` so CI catches drift automatically.
 */

import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { manifest } from "./manifest.ts"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const README_PATH = join(ROOT, "README.md")
const HOOKS_DIR = join(ROOT, "hooks")

// ─── Parse README ────────────────────────────────────────────────────────────

function parseReadme(text: string): {
  sectionCounts: Record<string, number>
  headingClaims: Record<string, number>
  referencedHooks: string[]
} {
  const lines = text.split("\n")
  const sectionCounts: Record<string, number> = {}
  const headingClaims: Record<string, number> = {}
  const referencedHooks: string[] = []

  const SECTION_NAMES = ["Stop", "PreToolUse", "PostToolUse", "SessionStart", "UserPromptSubmit"]

  let currentSection = ""
  let inFence = false

  for (const line of lines) {
    const ls = line.trim()

    // Track fenced code blocks so bash `#` comments aren't read as headings
    if (ls.startsWith("```")) {
      inFence = !inFence
      continue
    }
    if (inFence) continue

    // Detect section headings: ### Stop (14), ### PreToolUse (12), etc.
    for (const name of SECTION_NAMES) {
      const m = ls.match(new RegExp(`^### ${name}\\s*\\((\\d+)\\)`))
      if (m) {
        currentSection = name
        headingClaims[name] = parseInt(m[1] ?? "0", 10)
        sectionCounts[name] = 0
        break
      }
    }

    // Reset section on any other ##-level heading
    if (ls.startsWith("## ") || (ls.startsWith("### ") && !SECTION_NAMES.some((n) => ls.includes(`### ${n}`)))) {
      if (!SECTION_NAMES.some((n) => ls.match(new RegExp(`^### ${n}`)))) {
        currentSection = ""
      }
    }

    // Count table rows that mention a hook filename
    if (currentSection && ls.startsWith("|") && ls.includes(".ts") && !/^\|[-| :]+\|/.test(ls)) {
      sectionCounts[currentSection] = (sectionCounts[currentSection] ?? 0) + 1
    }

    // Collect all hook filenames referenced anywhere in the document
    const hookMatches = line.matchAll(
      /`((?:stop|pretooluse|posttooluse|sessionstart|userpromptsubmit)-[a-z-]+\.ts)`/g
    )
    for (const m of hookMatches) {
      if (m[1]) referencedHooks.push(m[1])
    }
  }

  return { sectionCounts, headingClaims, referencedHooks }
}

// ─── Derive ground truth from manifest ───────────────────────────────────────

function manifestCountsByEvent(): Record<string, number> {
  const EVENT_TO_SECTION: Record<string, string> = {
    stop: "Stop",
    preToolUse: "PreToolUse",
    postToolUse: "PostToolUse",
    sessionStart: "SessionStart",
    userPromptSubmit: "UserPromptSubmit",
  }
  const counts: Record<string, number> = {}
  for (const group of manifest) {
    const section = EVENT_TO_SECTION[group.event]
    if (!section) continue
    counts[section] = (counts[section] ?? 0) + group.hooks.length
  }
  return counts
}

function manifestHookFiles(): Set<string> {
  const files = new Set<string>()
  for (const group of manifest) {
    for (const hook of group.hooks) {
      files.add(hook.file)
    }
  }
  return files
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("README hook accuracy", () => {
  const readmeText = readFileSync(README_PATH, "utf8")
  const { sectionCounts, headingClaims, referencedHooks } = parseReadme(readmeText)
  const manifestCounts = manifestCountsByEvent()
  const manifestFiles = manifestHookFiles()

  test("all hook filenames referenced in README exist on disk", () => {
    const unique = [...new Set(referencedHooks)]
    const missing = unique.filter((f) => !existsSync(join(HOOKS_DIR, f)))
    expect(missing).toEqual([])
  })

  test("all hook filenames referenced in README are registered in the manifest", () => {
    const unique = [...new Set(referencedHooks)]
    // Only flag hooks that follow the naming convention but are absent from manifest
    const unregistered = unique.filter((f) => !manifestFiles.has(f))
    expect(unregistered).toEqual([])
  })

  test("section heading counts match actual table row counts", () => {
    const mismatches: string[] = []
    for (const [section, claimed] of Object.entries(headingClaims)) {
      const actual = sectionCounts[section] ?? 0
      if (actual !== claimed) {
        mismatches.push(`${section}: heading says ${claimed}, table has ${actual}`)
      }
    }
    expect(mismatches).toEqual([])
  })

  test("section table row counts match manifest hook counts", () => {
    const mismatches: string[] = []
    for (const [section, manifestCount] of Object.entries(manifestCounts)) {
      const tableCount = sectionCounts[section] ?? 0
      if (tableCount !== manifestCount) {
        mismatches.push(`${section}: manifest has ${manifestCount}, README table has ${tableCount}`)
      }
    }
    expect(mismatches).toEqual([])
  })

  test("total hook count in README intro matches manifest total", () => {
    const manifestTotal = [...manifestFiles].length
    const introMatch = readmeText.match(/\*\*(\d+) hooks\b/)
    if (!introMatch) {
      // No bold count line found — skip rather than fail (format may have changed)
      return
    }
    const introClaimed = parseInt(introMatch[1] ?? "0", 10)
    expect(introClaimed).toBe(manifestTotal)
  })
})
