/**
 * Static analysis test: ensures all pretooluse hooks that read
 * `new_string`, `content`, or `old_string` from tool_input use
 * `fileEditHookInputSchema` (which auto-normalizes with NFKC via
 * its `.transform()`) or explicitly call `.normalize("NFKC")`.
 *
 * Hooks that only do word-counting or JSON.parse (where homoglyphs
 * break the format itself) can be explicitly exempted below.
 */

import { describe, expect, test } from "bun:test"
import { readdir } from "node:fs/promises"
import { join } from "node:path"

const HOOKS_DIR = join(import.meta.dir, "..", "hooks")

// Hooks that read new_string/content but are exempt from NFKC for documented reasons
const EXEMPT_HOOKS = new Set([
  // Word counting only — normalizing would break string.replace against file content
  "pretooluse-claude-md-word-limit.ts",
  // JSON.parse + key check — homoglyphs produce invalid JSON (safe)
  "pretooluse-no-direct-deps.ts",
])

const CONTENT_ACCESS_RE = /tool_input\?\.(new_string|content|old_string)/

describe("NFKC normalization enforcement", () => {
  test("all content-inspecting pretooluse hooks use fileEditHookInputSchema or explicit NFKC", async () => {
    const files = await readdir(HOOKS_DIR)
    const hooks = files.filter(
      (f) => f.startsWith("pretooluse-") && f.endsWith(".ts") && !f.includes(".test.")
    )

    const violations: string[] = []

    for (const hook of hooks) {
      if (EXEMPT_HOOKS.has(hook)) continue

      const src = await Bun.file(join(HOOKS_DIR, hook)).text()
      if (!CONTENT_ACCESS_RE.test(src)) continue

      // Option 1: Uses fileEditHookInputSchema (has NFKC transform built in)
      const usesSchema = src.includes("fileEditHookInputSchema")
      // Option 2: Explicit .normalize("NFKC") call (Biome may split across lines)
      const usesExplicit = /\.normalize\(\s*["']NFKC["']\s*\)/.test(src)

      if (!usesSchema && !usesExplicit) {
        violations.push(hook)
      }
    }

    expect(violations).toEqual([])
  })
})
