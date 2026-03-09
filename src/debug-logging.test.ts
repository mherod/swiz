import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { describe, expect, it } from "vitest"

// ─── console usage enforcement ─────────────────────────────────────────────
// Guards ALL console methods in src/ behind explicit allowlists.
// - console.error/console.warn → STDERR_ALLOWLIST (diagnostic → use debugLog)
// - console.log/console.info   → STDOUT_ALLOWLIST (CLI commands only)
//
// Adding a file to either allowlist requires a justification comment.
// Non-command files must use `debugLog` from `src/debug.ts` for diagnostics
// and must not produce stdout/stderr directly.

const SRC_ROOT = join(import.meta.dirname ?? ".", "..")

/** Files in src/ that legitimately use console.error for user-facing output. */
const STDERR_ALLOWLIST = new Set([
  // CLI error handler — unknown command, uncaught exception
  "src/cli.ts",
  // CI failure/error status reporting with exit codes
  "src/commands/ci-wait.ts",
  // push-ci failure reporting (CI conclusion !== "success")
  "src/commands/push-ci.ts",
  // Interactive merge progress indicators (→ Gathering..., ✓ Resolved)
  "src/commands/mergetool.ts",
  // User-invoked replay trace (`swiz dispatch replay`)
  "src/commands/dispatch.ts",
  // Dispatch replay ANSI trace output (extracted from dispatch.ts)
  "src/dispatch/replay.ts",
  // settings enable --force prints a warning about conflicting settings
  "src/commands/settings.ts",
  // manage validate emits validation failures to stderr
  "src/commands/manage.ts",
  // The shared debug utility itself
  "src/debug.ts",
])

/** Files in src/ that legitimately use console.log/console.info for CLI output. */
const STDOUT_ALLOWLIST = new Set([
  // CLI command implementations — each produces user-facing terminal output
  "src/commands/ci-wait.ts",
  "src/commands/cleanup.ts",
  // cross-repo-issue — prints filed issue URL and location to user
  "src/commands/cross-repo-issue.ts",
  "src/commands/compact.ts",
  "src/commands/continue.ts",
  "src/commands/dispatch.ts",
  // Dispatch engine structured JSON output to stdout (extracted from dispatch.ts)
  "src/dispatch/engine.ts",
  // Dispatch replay JSON trace output (extracted from dispatch.ts)
  "src/dispatch/replay.ts",
  "src/commands/doctor.ts",
  "src/commands/help.ts",
  "src/commands/hooks.ts",
  // idea — generates and prints creative issue proposal from Gemini
  "src/commands/idea.ts",
  "src/commands/install.ts",
  "src/commands/issue.ts",
  "src/commands/memory.ts",
  // manage command prints MCP list/show/add/remove output
  "src/commands/manage.ts",
  "src/commands/push-ci.ts",
  "src/commands/push-wait.ts",
  // reflect — prints prompt (--print-prompt) and reflection output to user
  "src/commands/reflect.ts",
  "src/commands/sentiment.ts",
  "src/commands/session.ts",
  "src/commands/settings.ts",
  "src/commands/shim.ts",
  "src/commands/skill.ts",
  "src/commands/state.ts",
  "src/commands/status-line.ts",
  "src/commands/status.ts",
  "src/commands/tasks.ts",
  // task-renderer — formats and prints task lists to user-facing terminal output
  "src/tasks/task-renderer.ts",
  "src/commands/transcript.ts",
  "src/commands/uninstall.ts",
  // Usage report — human-readable terminal output
  "src/commands/usage.ts",
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

  it("no non-allowlisted file uses console.log or console.info", () => {
    const violations: string[] = []

    for (const filePath of sourceFiles) {
      const rel = relative(SRC_ROOT, filePath)
      if (STDOUT_ALLOWLIST.has(rel)) continue

      const content = readFileSync(filePath, "utf8")
      const lines = content.split("\n")

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!
        const trimmed = line.trim()
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue

        if (/\bconsole\.(log|info)\b/.test(line)) {
          violations.push(`${rel}:${i + 1}: ${trimmed}`)
        }
      }
    }

    expect(
      violations,
      `Found console.log/console.info in non-allowlisted files. ` +
        `CLI output belongs in src/commands/ files only. ` +
        `For diagnostics, use \`import { debugLog } from "./debug.ts"\`.\n\n` +
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
      expect(statSync(full).isFile(), `STDERR_ALLOWLIST file missing: ${rel}`).toBe(true)
    }
    for (const rel of STDOUT_ALLOWLIST) {
      const full = join(SRC_ROOT, rel)
      expect(statSync(full).isFile(), `STDOUT_ALLOWLIST file missing: ${rel}`).toBe(true)
    }
  })
})
