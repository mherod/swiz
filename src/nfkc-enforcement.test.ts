/**
 * Static analysis test: ensures all pretooluse hooks that read
 * `new_string`, `content`, or `old_string` from tool_input / toolInput use
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
  // Projected content via string.replace — normalizing would break replace against file content
  "pretooluse-no-direct-deps.ts",
  // Line counting only — normalization cannot change a newline count
  "pretooluse-task-governance.ts",
])

const CONTENT_ACCESS_RE =
  /\b(?:tool_input|toolInput)\s*\??\.\s*(?:new_string|content|old_string)\b|(?:const|let|var)\s*\{[^}]*\b(?:new_string|content|old_string)\b[^}]*\}\s*=\s*(?:tool_input|toolInput)\b/

describe("NFKC normalization enforcement", () => {
  describe("CONTENT_ACCESS_RE pattern matching", () => {
    test("matches snake_case receiver with optional chaining", () => {
      expect(CONTENT_ACCESS_RE.test("const str = input.tool_input?.new_string")).toBe(true)
      expect(CONTENT_ACCESS_RE.test("const c = tool_input?.content")).toBe(true)
      expect(CONTENT_ACCESS_RE.test("const old = tool_input?.old_string")).toBe(true)
    })

    test("matches snake_case receiver with direct property access", () => {
      expect(CONTENT_ACCESS_RE.test("const str = tool_input.new_string")).toBe(true)
      expect(CONTENT_ACCESS_RE.test("const c = tool_input.content")).toBe(true)
    })

    test("matches camelCase receiver with optional chaining", () => {
      expect(CONTENT_ACCESS_RE.test("const str = toolInput?.new_string")).toBe(true)
      expect(CONTENT_ACCESS_RE.test("const c = toolInput?.content")).toBe(true)
      expect(CONTENT_ACCESS_RE.test("const old = toolInput?.old_string")).toBe(true)
    })

    test("matches camelCase receiver with direct property access", () => {
      expect(CONTENT_ACCESS_RE.test("const str = toolInput.new_string")).toBe(true)
      expect(CONTENT_ACCESS_RE.test("const c = toolInput.content")).toBe(true)
      expect(CONTENT_ACCESS_RE.test("const old = toolInput.old_string")).toBe(true)
    })

    test("matches destructuring from tool_input or toolInput", () => {
      expect(CONTENT_ACCESS_RE.test("const { new_string } = tool_input")).toBe(true)
      expect(CONTENT_ACCESS_RE.test("const { content, file_path } = toolInput")).toBe(true)
      expect(CONTENT_ACCESS_RE.test("let { old_string } = toolInput")).toBe(true)
    })

    test("does not match unrelated property accesses", () => {
      expect(CONTENT_ACCESS_RE.test("const c = message?.content")).toBe(false)
      expect(CONTENT_ACCESS_RE.test("const val = block.content")).toBe(false)
      expect(CONTENT_ACCESS_RE.test("const p = toolInput.file_path")).toBe(false)
    })
  })

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
