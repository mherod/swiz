import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { describe, expect, it } from "vitest"

// ─── debugLog enforcement ──────────────────────────────────────────────────
// Prevents diagnostic stderr from bypassing the shared `debugLog` utility
// in `src/debug.ts`. All non-user-facing console.error/console.warn calls
// must use `debugLog` so they stay silent by default (gated on SWIZ_DEBUG).
//
// Files that legitimately produce user-facing stderr are allowlisted below.
// Adding a file here requires justification — it must be intentional CLI
// output, not diagnostic logging.

const SRC_ROOT = join(import.meta.dirname ?? ".", "..")

/** Files in src/ that legitimately use console.error for user-facing output. */
const STDERR_ALLOWLIST = new Set([
  // CLI error handler — unknown command, uncaught exception
  "src/cli.ts",
  // CI failure/error status reporting with exit codes
  "src/commands/ci-wait.ts",
  // Interactive merge progress indicators (→ Gathering..., ✓ Resolved)
  "src/commands/mergetool.ts",
  // User-invoked replay trace (`swiz dispatch replay`)
  "src/commands/dispatch.ts",
  // The shared debug utility itself
  "src/debug.ts",
])

/** Collect all .ts files under src/, excluding test files. */
function collectSourceFiles(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      files.push(...collectSourceFiles(full))
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      files.push(full)
    }
  }
  return files
}

describe("debugLog enforcement", () => {
  const srcDir = join(SRC_ROOT, "src")
  const sourceFiles = collectSourceFiles(srcDir)

  it("finds source files to scan", () => {
    expect(sourceFiles.length).toBeGreaterThan(5)
  })

  it("no non-allowlisted file uses console.error or console.warn", () => {
    const violations: string[] = []

    for (const filePath of sourceFiles) {
      const rel = relative(SRC_ROOT, filePath)
      if (STDERR_ALLOWLIST.has(rel)) continue

      const content = readFileSync(filePath, "utf8")
      const lines = content.split("\n")

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!
        // Skip comments (single-line // and block /* */ content)
        const trimmed = line.trim()
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue

        if (/\bconsole\.(error|warn)\b/.test(line)) {
          violations.push(`${rel}:${i + 1}: ${trimmed}`)
        }
      }
    }

    expect(
      violations,
      `Found console.error/console.warn in non-allowlisted files. ` +
        `Use \`import { debugLog } from "./debug.ts"\` instead.\n\n` +
        violations.map((v) => `  ${v}`).join("\n")
    ).toEqual([])
  })

  it("all non-allowlisted files that import debugLog use src/debug.ts", () => {
    const wrongImports: string[] = []

    for (const filePath of sourceFiles) {
      const rel = relative(SRC_ROOT, filePath)
      if (STDERR_ALLOWLIST.has(rel)) continue
      if (rel === "src/debug.ts") continue

      const content = readFileSync(filePath, "utf8")

      // Check for local debugLog definitions (should import from debug.ts)
      if (/(?:const|let|var)\s+debugLog\b/.test(content)) {
        wrongImports.push(`${rel}: defines local debugLog instead of importing from debug.ts`)
      }
    }

    expect(
      wrongImports,
      `Found local debugLog definitions. Use \`import { debugLog } from "./debug.ts"\` instead.\n\n` +
        wrongImports.map((v) => `  ${v}`).join("\n")
    ).toEqual([])
  })

  it("allowlisted files actually exist", () => {
    for (const rel of STDERR_ALLOWLIST) {
      const full = join(SRC_ROOT, rel)
      expect(statSync(full).isFile(), `Allowlisted file missing: ${rel}`).toBe(true)
    }
  })
})
