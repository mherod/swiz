#!/usr/bin/env bun
/**
 * CI script: Detect `permissions:` changes in GitHub Actions workflow files.
 *
 * Reads a unified diff (from stdin or git) of .github/workflows/*.yml files
 * and fails if any added lines contain `permissions:` keywords.
 *
 * Usage:
 *   git diff origin/main...HEAD -- '.github/workflows/*.yml' | bun scripts/check-workflow-permissions.ts
 *   bun scripts/check-workflow-permissions.ts --base origin/main
 *
 * Exit codes:
 *   0 — no permission changes detected
 *   1 — permission changes found (prints details to stderr)
 */

/** Match added lines containing a `permissions:` YAML key. */
const PERMISSIONS_RE = /^\s*permissions\s*:/

/**
 * Parse a unified diff and return added `permissions:` lines with file context.
 * Exported for testability.
 */
export function detectPermissionChanges(
  diff: string
): Array<{ file: string; line: string; lineNumber: number }> {
  const results: Array<{ file: string; line: string; lineNumber: number }> = []
  let currentFile = ""
  let lineNumber = 0

  for (const rawLine of diff.split("\n")) {
    // Track current file from diff headers: +++ b/path/to/file
    if (rawLine.startsWith("+++ b/")) {
      currentFile = rawLine.slice(6)
      continue
    }

    // Track line numbers from hunk headers: @@ -a,b +c,d @@
    const hunkMatch = rawLine.match(/^@@ -\d+(?:,\d+)? \+(\d+)/)
    if (hunkMatch?.[1]) {
      lineNumber = parseInt(hunkMatch[1], 10)
      continue
    }

    // Only inspect added lines (start with +, not +++ header)
    if (rawLine.startsWith("+") && !rawLine.startsWith("+++")) {
      const content = rawLine.slice(1) // Remove the leading +
      if (PERMISSIONS_RE.test(content)) {
        results.push({ file: currentFile, line: content.trim(), lineNumber })
      }
      lineNumber++
    } else if (!rawLine.startsWith("-")) {
      // Context lines (no prefix) advance the line counter
      lineNumber++
    }
  }

  return results
}

// CLI entry point
if (import.meta.main) {
  const args = process.argv.slice(2)
  let diff: string

  const baseIdx = args.indexOf("--base")
  if (baseIdx !== -1 && args[baseIdx + 1]) {
    // Generate diff from git
    const base = args[baseIdx + 1]!
    const proc = Bun.spawn(["git", "diff", `${base}...HEAD`, "--", ".github/workflows/*.yml"], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    await proc.exited
    if (proc.exitCode !== 0) {
      console.error(`git diff failed: ${stderr.trim()}`)
      process.exit(1)
    }
    diff = stdout
  } else {
    // Read diff from stdin
    diff = await new Response(Bun.stdin.stream()).text()
  }

  if (!diff.trim()) {
    // No workflow file changes — nothing to check
    console.error("OK: no workflow file changes detected")
    process.exit(0)
  }

  const violations = detectPermissionChanges(diff)

  if (violations.length === 0) {
    console.error("OK: workflow changes do not modify permissions")
    process.exit(0)
  }

  console.error("ERROR: Workflow permission changes detected on PR branch.\n")
  console.error("GitHub Actions `permissions:` changes made in a PR branch do NOT take")
  console.error("effect until merged. They silently activate upon merge, bypassing review.\n")
  for (const v of violations) {
    console.error(`  ${v.file}:${v.lineNumber}: ${v.line}`)
  }
  console.error("\nTo change workflow permissions, modify them directly on the default branch")
  console.error("or use repository Settings → Actions → General → Workflow permissions.")
  process.exit(1)
}
