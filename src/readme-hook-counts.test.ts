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

// ─── Test helpers ────────────────────────────────────────────────────────────

/** Simple seeded LCG PRNG — reproducible across runs, no external deps. */
function makePrng(seed: number) {
  let s = seed | 0
  return () => {
    s = Math.imul(1664525, s) + 1013904223 | 0
    return (s >>> 0) / 0x100000000
  }
}

const SECTION_NAMES = ["Stop", "PreToolUse", "PostToolUse", "SessionStart", "UserPromptSubmit"] as const
const HOOK_PREFIXES: Record<string, string> = {
  Stop: "stop",
  PreToolUse: "pretooluse",
  PostToolUse: "posttooluse",
  SessionStart: "sessionstart",
  UserPromptSubmit: "userpromptsubmit",
}

// Letter suffixes for generated hook names — avoids digits which the
// referencedHooks regex [a-z-]+ intentionally does not match.
const LETTER_SUFFIXES = [
  "alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta",
  "iota", "kappa", "lambda", "mu", "nu", "xi", "omicron", "pi",
]

/** Build a syntactically correct README section with N hook rows. */
function buildSection(section: string, count: number, claimedCount = count): string {
  const prefix = HOOK_PREFIXES[section] ?? "stop"
  const rows = Array.from(
    { length: count },
    (_, i) => `| \`${prefix}-${LETTER_SUFFIXES[i % LETTER_SUFFIXES.length]}.ts\` | description ${i} |`
  )
  return [`### ${section} (${claimedCount})`, "| Hook | What it does |", "|------|-------------|", ...rows].join("\n")
}

/** Wrap a string in a code fence. */
function fence(content: string, lang = "bash"): string {
  return ["```" + lang, content, "```"].join("\n")
}

// ─── Parser unit tests (synthetic inputs) ────────────────────────────────────

describe("parseReadme parser", () => {
  test("counts table rows only outside code fences", () => {
    const text = [
      "### Stop (1)",
      "| `stop-real.ts` | actual hook |",
      "```bash",
      "| `stop-fake.ts` | example inside fence — should not count |",
      "```",
    ].join("\n")
    const { sectionCounts } = parseReadme(text)
    expect(sectionCounts["Stop"]).toBe(1)
  })

  test("does not add hook filenames inside code fences to referencedHooks", () => {
    const text = [
      "### Stop (1)",
      "| `stop-real.ts` | actual hook |",
      "```bash",
      "bun hooks/stop-fake.ts",
      "```",
    ].join("\n")
    const { referencedHooks } = parseReadme(text)
    expect(referencedHooks).toContain("stop-real.ts")
    expect(referencedHooks).not.toContain("stop-fake.ts")
  })

  test("heading without parenthetical count is not added to headingClaims", () => {
    // If the format changes from '### Stop (14)' to '### Stop', headingClaims
    // stays empty for that section. The manifest-comparison test then catches
    // the missing rows because sectionCounts will also be 0 (no section is
    // activated without a matching count heading).
    const text = ["### Stop", "| `stop-foo.ts` | desc |"].join("\n")
    const { headingClaims, sectionCounts } = parseReadme(text)
    expect(headingClaims["Stop"]).toBeUndefined()
    expect(sectionCounts["Stop"]).toBeUndefined()
  })

  test("## heading resets section so subsequent rows are not miscounted", () => {
    const text = [
      "### Stop (1)",
      "| `stop-real.ts` | desc |",
      "## Commands",
      "| `stop-fake.ts` | inside Commands section, not Stop |",
    ].join("\n")
    const { sectionCounts } = parseReadme(text)
    expect(sectionCounts["Stop"]).toBe(1)
  })

  test("duplicate hook filename in a table increments row count twice", () => {
    // Duplicates inflate sectionCounts above the manifest count — the
    // manifest-comparison test will catch this, but preserving raw counts
    // lets callers also detect duplicates directly.
    const text = [
      "### Stop (2)",
      "| `stop-foo.ts` | first entry |",
      "| `stop-foo.ts` | duplicate entry |",
    ].join("\n")
    const { sectionCounts, referencedHooks } = parseReadme(text)
    expect(sectionCounts["Stop"]).toBe(2)
    expect(referencedHooks.filter((f) => f === "stop-foo.ts")).toHaveLength(2)
  })

  test("multiple sections are tracked independently", () => {
    const text = [
      "### Stop (2)",
      "| `stop-a.ts` | desc |",
      "| `stop-b.ts` | desc |",
      "### PreToolUse (1)",
      "| `pretooluse-a.ts` | desc |",
    ].join("\n")
    const { sectionCounts, headingClaims } = parseReadme(text)
    expect(sectionCounts["Stop"]).toBe(2)
    expect(headingClaims["Stop"]).toBe(2)
    expect(sectionCounts["PreToolUse"]).toBe(1)
    expect(headingClaims["PreToolUse"]).toBe(1)
  })

  test("unclosed code fence causes all subsequent rows to be ignored", () => {
    // An unclosed fence is a documentation bug, but the parser must not crash.
    // Rows after the missing closing fence are silently ignored — this test
    // documents that behaviour so future readers know it's intentional.
    const text = [
      "### Stop (1)",
      "| `stop-before.ts` | counted |",
      "```bash",
      "| `stop-after.ts` | NOT counted — fence never closed |",
    ].join("\n")
    const { sectionCounts } = parseReadme(text)
    expect(sectionCounts["Stop"]).toBe(1)
  })

  test("alternating fence open/close restores section tracking", () => {
    const text = [
      "### Stop (2)",
      "| `stop-a.ts` | before fence |",
      "```bash",
      "inside fence — ignored",
      "```",
      "| `stop-b.ts` | after fence — should still count |",
    ].join("\n")
    const { sectionCounts } = parseReadme(text)
    expect(sectionCounts["Stop"]).toBe(2)
  })
})

// ─── Live README tests ────────────────────────────────────────────────────────

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

  test("no section table contains duplicate hook filenames", () => {
    // Duplicates would inflate sectionCounts above the manifest count (caught
    // by the manifest-comparison test), but surfacing them here gives a clearer
    // failure message pointing at the specific file and section.
    const hooksBySection: Record<string, string[]> = {}
    let currentSection = ""
    let inFence = false
    for (const line of readmeText.split("\n")) {
      const ls = line.trim()
      if (ls.startsWith("```")) { inFence = !inFence; continue }
      if (inFence) continue
      for (const name of ["Stop", "PreToolUse", "PostToolUse", "SessionStart", "UserPromptSubmit"]) {
        if (ls.match(new RegExp(`^### ${name}`))) { currentSection = name; break }
      }
      if (ls.startsWith("## ")) currentSection = ""
      if (currentSection && ls.startsWith("|") && ls.includes(".ts") && !/^\|[-| :]+\|/.test(ls)) {
        const m = ls.match(/`((?:stop|pretooluse|posttooluse|sessionstart|userpromptsubmit)-[a-z-]+\.ts)`/)
        if (m?.[1]) {
          hooksBySection[currentSection] ??= []
          ;(hooksBySection[currentSection] as string[]).push(m[1])
        }
      }
    }
    const duplicates: string[] = []
    for (const [section, hooks] of Object.entries(hooksBySection)) {
      const seen = new Set<string>()
      for (const h of hooks) {
        if (seen.has(h)) duplicates.push(`${section}: ${h}`)
        seen.add(h)
      }
    }
    expect(duplicates).toEqual([])
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

// ─── Property-based tests ─────────────────────────────────────────────────────

describe("parseReadme properties", () => {
  // Property 1: sectionCounts[s] is always a non-negative integer
  test("sectionCounts values are always non-negative for any generated input", () => {
    const rng = makePrng(0xdeadbeef)
    for (let trial = 0; trial < 200; trial++) {
      const sections = SECTION_NAMES.filter(() => rng() > 0.3)
      const parts: string[] = []
      for (const s of sections) {
        const count = Math.floor(rng() * 8)
        parts.push(buildSection(s, count))
      }
      if (rng() > 0.5) parts.splice(Math.floor(rng() * (parts.length || 1)), 0, fence("some content"))
      if (rng() > 0.5) parts.splice(Math.floor(rng() * (parts.length || 1)), 0, "## Other\n\nProse.")
      const { sectionCounts } = parseReadme(parts.join("\n\n"))
      for (const count of Object.values(sectionCounts)) {
        expect(count).toBeGreaterThanOrEqual(0)
      }
    }
  })

  // Property 2: referencedHooks.length >= total section row counts
  test("total referenced hooks is at least the sum of all section row counts", () => {
    const rng = makePrng(0xcafebabe)
    for (let trial = 0; trial < 100; trial++) {
      const sections = SECTION_NAMES.filter(() => rng() > 0.4)
      const parts = sections.map((s) => buildSection(s, Math.floor(rng() * 5) + 1))
      const { sectionCounts, referencedHooks } = parseReadme(parts.join("\n\n"))
      const totalRows = Object.values(sectionCounts).reduce((a, b) => a + b, 0)
      expect(referencedHooks.length).toBeGreaterThanOrEqual(totalRows)
    }
  })

  // Property 3: parseReadme is pure — identical input always yields identical output
  test("output is deterministic across multiple calls with the same input", () => {
    const rng = makePrng(0xfeedface)
    for (let trial = 0; trial < 50; trial++) {
      const text = SECTION_NAMES.filter(() => rng() > 0.5)
        .map((s) => buildSection(s, Math.floor(rng() * 6)))
        .join("\n\n")
      const r1 = parseReadme(text)
      const r2 = parseReadme(text)
      expect(r1.sectionCounts).toEqual(r2.sectionCounts)
      expect(r1.headingClaims).toEqual(r2.headingClaims)
      expect(r1.referencedHooks).toEqual(r2.referencedHooks)
    }
  })

  // Property 4: wrapping an entire section in a code fence zeros its count
  test("section rows inside a code fence always produce a count of zero", () => {
    const rng = makePrng(0xbeefdead)
    for (const section of SECTION_NAMES) {
      for (let trial = 0; trial < 10; trial++) {
        const count = Math.floor(rng() * 6) + 1
        const text = fence(buildSection(section, count))
        const { sectionCounts } = parseReadme(text)
        expect(sectionCounts[section] ?? 0).toBe(0)
      }
    }
  })

  // Property 5: well-formed sections always satisfy headingClaims[s] === sectionCounts[s]
  test("well-formed sections always have matching heading claim and table row count", () => {
    const rng = makePrng(0x12345678)
    for (let trial = 0; trial < 100; trial++) {
      const counts: Partial<Record<string, number>> = {}
      const parts: string[] = []
      for (const s of SECTION_NAMES) {
        if (rng() > 0.4) {
          const n = Math.floor(rng() * 8)
          counts[s] = n
          parts.push(buildSection(s, n))
        }
      }
      const { sectionCounts, headingClaims } = parseReadme(parts.join("\n\n"))
      for (const [s, n] of Object.entries(counts)) {
        expect(headingClaims[s]).toBe(n)
        expect(sectionCounts[s]).toBe(n)
      }
    }
  })

  // Property 6: adding N rows to a section increases its count by exactly N
  test("adding extra rows to a section always increases the count by that amount", () => {
    const rng = makePrng(0xabcdef01)
    for (const section of SECTION_NAMES) {
      const prefix = HOOK_PREFIXES[section] ?? "stop"
      for (let trial = 0; trial < 20; trial++) {
        const base = Math.floor(rng() * 5)
        const extra = Math.floor(rng() * 4) + 1
        const extraRows = Array.from(
          { length: extra },
          (_, i) => `| \`${prefix}-extra-${LETTER_SUFFIXES[i % LETTER_SUFFIXES.length]}.ts\` | extra ${i} |`
        ).join("\n")
        const text = `${buildSection(section, base)}\n${extraRows}`
        const { sectionCounts } = parseReadme(text)
        expect(sectionCounts[section]).toBe(base + extra)
      }
    }
  })
})

// ─── Mutation tests ───────────────────────────────────────────────────────────

describe("parseReadme mutations", () => {
  // Baseline: a two-row Stop section with a correct heading
  const BASE = buildSection("Stop", 2)

  test("removing a row decreases count by 1", () => {
    const lines = BASE.split("\n")
    const mutated = lines.slice(0, lines.length - 1).join("\n")
    const { sectionCounts } = parseReadme(mutated)
    expect(sectionCounts["Stop"]).toBe(1)
  })

  test("adding an extra row increases count by 1", () => {
    const mutated = BASE + "\n| `stop-extra.ts` | injected row |"
    const { sectionCounts } = parseReadme(mutated)
    expect(sectionCounts["Stop"]).toBe(3)
  })

  test("changing heading number changes headingClaims but not sectionCounts", () => {
    const mutated = BASE.replace("### Stop (2)", "### Stop (99)")
    const { headingClaims, sectionCounts } = parseReadme(mutated)
    expect(headingClaims["Stop"]).toBe(99)
    expect(sectionCounts["Stop"]).toBe(2)
  })

  test("removing parenthetical count drops section from both headingClaims and sectionCounts", () => {
    const mutated = BASE.replace("### Stop (2)", "### Stop")
    const { headingClaims, sectionCounts } = parseReadme(mutated)
    expect(headingClaims["Stop"]).toBeUndefined()
    expect(sectionCounts["Stop"]).toBeUndefined()
  })

  test("inserting H4 between rows does not reset the section tracker", () => {
    const mutated = BASE + "\n#### Sub-detail\n| `stop-after-h4.ts` | still in Stop |"
    const { sectionCounts } = parseReadme(mutated)
    expect(sectionCounts["Stop"]).toBe(3)
  })

  test("inserting ## heading mid-section resets tracker and excludes trailing rows", () => {
    const mutated = BASE + "\n## Commands\n| `stop-orphan.ts` | not in Stop |"
    const { sectionCounts } = parseReadme(mutated)
    expect(sectionCounts["Stop"]).toBe(2)
  })

  test("wrapping only the data rows in a code fence zeros the count", () => {
    const [heading, ...rest] = BASE.split("\n")
    const mutated = [heading, fence(rest.join("\n"))].join("\n")
    const { sectionCounts } = parseReadme(mutated)
    expect(sectionCounts["Stop"]).toBe(0)
  })

  test("renaming hook prefix causes filenames to not appear in referencedHooks", () => {
    const mutated = BASE.replace(/`stop-/g, "`hook-")
    const { referencedHooks } = parseReadme(mutated)
    expect(referencedHooks.filter((f) => f.startsWith("hook-"))).toHaveLength(0)
    expect(referencedHooks.filter((f) => f.startsWith("stop-"))).toHaveLength(0)
  })

  test("duplicate row appears in referencedHooks twice", () => {
    const mutated = BASE + "\n| `stop-alpha.ts` | duplicate |"
    const { referencedHooks } = parseReadme(mutated)
    expect(referencedHooks.filter((f) => f === "stop-alpha.ts")).toHaveLength(2)
  })

  test("interleaved fences restore section tracking after each closing fence", () => {
    const text = [
      "### Stop (3)",
      "| `stop-a.ts` | before first fence |",
      fence("example one"),
      "| `stop-b.ts` | between fences |",
      fence("example two"),
      "| `stop-c.ts` | after second fence |",
    ].join("\n")
    const { sectionCounts } = parseReadme(text)
    expect(sectionCounts["Stop"]).toBe(3)
  })

  test("mismatched heading count with zero rows yields headingClaims mismatch", () => {
    const text = "### Stop (5)\n| Hook | What it does |\n|------|-------------|"
    const { headingClaims, sectionCounts } = parseReadme(text)
    expect(headingClaims["Stop"]).toBe(5)
    expect(sectionCounts["Stop"]).toBe(0)
    expect(headingClaims["Stop"]).not.toBe(sectionCounts["Stop"])
  })
})
