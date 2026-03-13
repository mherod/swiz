import { readdirSync, statSync } from "node:fs"
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

/**
 * Files in src/ that legitimately use console.error/console.warn.
 * Each entry MUST include a non-empty justification string explaining why
 * console.error is appropriate rather than debugLog.
 */
const STDERR_ALLOWLIST = new Map<string, string>([
  ["src/cli.ts", "CLI error handler — unknown command, uncaught exception"],
  ["src/commands/ci-wait.ts", "CI failure/error status reporting with exit codes"],
  [
    "src/commands/daemon.ts",
    "daemon status subcommand — reports unreachable daemon or error responses",
  ],
  ["src/commands/push-ci.ts", "push-ci failure reporting (CI conclusion !== 'success')"],
  [
    "src/commands/mergetool.ts",
    "Interactive merge progress indicators (→ Gathering..., ✓ Resolved)",
  ],
  ["src/commands/dispatch.ts", "User-invoked replay trace (`swiz dispatch replay`)"],
  ["src/dispatch/replay.ts", "Dispatch replay ANSI trace output (extracted from dispatch.ts)"],
  [
    "src/commands/settings.ts",
    "settings enable --force prints a warning about conflicting settings",
  ],
  ["src/commands/manage.ts", "manage validate emits validation failures to stderr"],
  ["src/debug.ts", "The shared debug utility itself"],
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
  // daemon — prints LaunchAgent install/uninstall status and server URL
  "src/commands/daemon.ts",
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
  // task-service — business logic that produces user-facing status output (create/update/adopt confirmations)
  "src/tasks/task-service.ts",
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

  it("no non-allowlisted file uses console.error or console.warn", async () => {
    const violations: string[] = []

    for (const filePath of sourceFiles) {
      const rel = relative(SRC_ROOT, filePath)
      if (STDERR_ALLOWLIST.has(rel)) continue

      const content = await Bun.file(filePath).text()
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

  it("no non-allowlisted file uses console.log or console.info", async () => {
    const violations: string[] = []

    for (const filePath of sourceFiles) {
      const rel = relative(SRC_ROOT, filePath)
      if (STDOUT_ALLOWLIST.has(rel)) continue

      const content = await Bun.file(filePath).text()
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

  it("all non-allowlisted files that import debugLog use src/debug.ts", async () => {
    const wrongImports: string[] = []

    for (const filePath of sourceFiles) {
      const rel = relative(SRC_ROOT, filePath)
      if (STDERR_ALLOWLIST.has(rel)) continue
      if (rel === "src/debug.ts") continue

      const content = await Bun.file(filePath).text()

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
    for (const rel of STDERR_ALLOWLIST.keys()) {
      const full = join(SRC_ROOT, rel)
      expect(statSync(full).isFile(), `STDERR_ALLOWLIST file missing: ${rel}`).toBe(true)
    }
    for (const rel of STDOUT_ALLOWLIST) {
      const full = join(SRC_ROOT, rel)
      expect(statSync(full).isFile(), `STDOUT_ALLOWLIST file missing: ${rel}`).toBe(true)
    }
  })

  it("every STDERR_ALLOWLIST entry has a non-empty justification", () => {
    const missing: string[] = []
    for (const [rel, justification] of STDERR_ALLOWLIST) {
      if (!justification || justification.trim().length === 0) {
        missing.push(rel)
      }
    }
    expect(
      missing,
      `STDERR_ALLOWLIST entries missing justification. Add a non-empty reason string explaining why console.error is appropriate:\n\n` +
        missing.map((r) => `  "${r}": ""  // ← add justification here`).join("\n")
    ).toEqual([])
  })

  it("STDERR_ALLOWLIST files use stderrLog instead of bare console.error", async () => {
    // src/debug.ts is exempt — it defines stderrLog itself using console.error
    const EXEMPT = new Set(["src/debug.ts"])
    const violations: string[] = []

    for (const rel of STDERR_ALLOWLIST.keys()) {
      if (EXEMPT.has(rel)) continue
      const full = join(SRC_ROOT, rel)
      const content = await Bun.file(full).text()
      const lines = content.split("\n")

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!
        const trimmed = line.trim()
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue

        if (/\bconsole\.(error|warn)\b/.test(line)) {
          violations.push(`${rel}:${i + 1}: ${trimmed}`)
        }
      }
    }

    expect(
      violations,
      `STDERR_ALLOWLIST files must use stderrLog() from debug.ts instead of bare console.error/console.warn.\n` +
        `Replace: console.error(msg) → stderrLog("reason", msg)\n\n` +
        violations.map((v) => `  ${v}`).join("\n")
    ).toEqual([])
  })

  it("stdout-only files must not import or call stderrLog", async () => {
    // Stdout-only files are discovered DYNAMICALLY at test time by diffing the two
    // allowlists: any file in STDOUT_ALLOWLIST but NOT in STDERR_ALLOWLIST is
    // stdout-only. No static list is maintained — adding a new file to STDOUT_ALLOWLIST
    // automatically brings it under this constraint without any extra manual step.
    //
    // Files in STDOUT_ALLOWLIST but NOT STDERR_ALLOWLIST must never call stderrLog —
    // errors belong on stdout as structured output or should not be emitted at all.
    // e.g. src/dispatch/engine.ts emits JSON to stdout only; stderrLog there would
    // mix stderr into the structured output stream.
    const violations: string[] = []

    for (const rel of STDOUT_ALLOWLIST) {
      if (STDERR_ALLOWLIST.has(rel)) continue // dual-listed files are allowed stderrLog

      const full = join(SRC_ROOT, rel)
      const content = await Bun.file(full).text()
      const lines = content.split("\n")

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!
        const trimmed = line.trim()
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue

        if (/\bstderrLog\b/.test(line)) {
          violations.push(`${rel}:${i + 1}: ${trimmed}`)
        }
      }
    }

    expect(
      violations,
      `stdout-only files (in STDOUT_ALLOWLIST but not STDERR_ALLOWLIST) must not use stderrLog.\n` +
        `These files emit structured output to stdout; mixing stderr would corrupt the stream.\n` +
        `To allow stderrLog in a file, add it to STDERR_ALLOWLIST with a justification.\n\n` +
        violations.map((v) => `  ${v}`).join("\n")
    ).toEqual([])
  })
})
