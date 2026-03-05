/**
 * Duplicate pattern scanner for issue-guidance consolidation.
 *
 * Detects when issue-guidance patterns are inlined instead of using the
 * canonical buildIssueGuidance() helper in hooks/hook-utils.ts.
 *
 * Patterns detected:
 * - "gh issue create --repo" invocations with repo slugs
 * - "file an issue" language suggesting external repo filing
 * - Cross-repo guidance text that should use buildIssueGuidance()
 *
 * Purpose: Prevent duplicate guidance text proliferation and ensure
 * consistent messaging across all sandbox enforcement hooks.
 */

import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"

export interface PatternMatch {
  file: string
  line: number
  text: string
  pattern: string
}

export interface ScanResult {
  matches: PatternMatch[]
  filesScanned: number
}

/**
 * Patterns that suggest buildIssueGuidance() should be used but isn't.
 * Each pattern represents text that's likely duplicated.
 */
const DUPLICATE_PATTERNS = [
  // Inline "gh issue create --repo" with specific repo slug (not placeholder)
  /gh\s+issue\s+create\s+--repo\s+([a-z0-9_-]+\/[a-z0-9_-]+)/gi,

  // Language suggesting filing an issue on external repo
  /file\s+an\s+issue\s+(?:on\s+)?(?:the\s+)?(?:target|external)\s+repo/gi,

  // Generic "file an issue instead" phrasing for file edits outside project
  /file\s+an\s+issue\s+(?:on\s+)?(?:the\s+)?(?:target|external)?\s*repo\s+instead/gi,

  // Cross-repo issue guidance phrasing
  /consider\s+filing\s+an\s+issue\s+(?:on\s+)?(?:the\s+)?target\s+repo/gi,

  // Pattern matching buildIssueGuidance-style guidance but inline
  /If\s+(?:this\s+change\s+)?(?:you\s+need\s+to\s+)?(?:you\s+)?(?:edit|need).*?file\s+an\s+issue/gi,
]

/**
 * Exceptions: files that legitimately need to contain these patterns
 * (e.g., the buildIssueGuidance implementation itself, or tests for it).
 */
const EXCEPTION_PATTERNS = [
  /hook-utils\.ts/, // Contains the canonical buildIssueGuidance()
  /.*\.test\.ts$/, // Tests may reference the patterns
  /scanner.*\.test\.ts$/, // Tests for this scanner itself
  /manifest\.ts/, // Documents hook structure
  /README\.md/, // Documentation may reference patterns
]

/**
 * Check if a file path should be scanned.
 */
function shouldScanFile(filePath: string): boolean {
  // Skip non-source files
  if (!filePath.match(/\.(ts|tsx|js|jsx)$/)) {
    return false
  }

  // Skip node_modules
  if (filePath.includes("node_modules")) {
    return false
  }

  // Skip exceptions
  for (const pattern of EXCEPTION_PATTERNS) {
    if (pattern.test(filePath)) {
      return false
    }
  }

  return true
}

/**
 * Find all lines matching a pattern in text content.
 */
function findMatches(text: string, pattern: RegExp, filePath: string): PatternMatch[] {
  const matches: PatternMatch[] = []
  const lines = text.split("\n")

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line === undefined) continue

    // Reset regex lastIndex for each line to ensure per-line matching
    pattern.lastIndex = 0

    if (pattern.test(line)) {
      matches.push({
        file: filePath,
        line: i + 1, // Line numbers are 1-based
        text: line.trim(),
        pattern: pattern.source,
      })
    }
  }

  return matches
}

/**
 * Scan a directory recursively for duplicate issue-guidance patterns.
 */
export async function scanForDuplicatePatterns(directory: string): Promise<ScanResult> {
  const matches: PatternMatch[] = []
  let filesScanned = 0

  async function scanDirectory(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true })

    for (const entry of entries) {
      const fullPath = join(dir, entry.name)

      // Skip hidden directories and common exclusions
      if (entry.name.startsWith(".") || entry.name === "node_modules") {
        continue
      }

      if (entry.isDirectory()) {
        await scanDirectory(fullPath)
      } else if (entry.isFile()) {
        if (!shouldScanFile(fullPath)) {
          continue
        }

        try {
          const content = await readFile(fullPath, "utf-8")
          filesScanned++

          for (const pattern of DUPLICATE_PATTERNS) {
            const patternMatches = findMatches(content, pattern, fullPath)
            matches.push(...patternMatches)
          }
        } catch {}
      }
    }
  }

  await scanDirectory(directory)

  return { matches, filesScanned }
}

/**
 * Format scan results as a readable report.
 */
export function formatScanResults(result: ScanResult): string {
  if (result.matches.length === 0) {
    return `✓ No duplicate patterns found (scanned ${result.filesScanned} files)`
  }

  const grouped = new Map<string, PatternMatch[]>()
  for (const match of result.matches) {
    if (!grouped.has(match.file)) {
      grouped.set(match.file, [])
    }
    const fileMatches = grouped.get(match.file)
    if (fileMatches) {
      fileMatches.push(match)
    }
  }

  let report = `⚠ Found ${result.matches.length} potential duplicate pattern(s) in ${grouped.size} file(s):\n\n`

  for (const [file, fileMatches] of grouped) {
    report += `  ${file}\n`
    for (const match of fileMatches) {
      report += `    Line ${match.line}: ${match.text.substring(0, 60)}${match.text.length > 60 ? "..." : ""}\n`
      report += `    → This may need buildIssueGuidance() consolidation\n\n`
    }
  }

  report += "ACTION: Review matches and consolidate using buildIssueGuidance() in hook-utils.ts\n"

  return report
}
