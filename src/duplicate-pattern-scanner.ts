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
import { isNodeModulesPath, NODE_MODULES_DIR } from "./node-modules-path.ts"

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

  // "file a GitHub issue on X" variant
  /file\s+a?\s+GitHub\s+issue\s+on\s+(?:[a-z0-9_-]+\/[a-z0-9_-]+|that\s+repo)/gi,

  // "file them as GitHub issues" variant
  /file\s+them\s+as\s+GitHub\s+issues/gi,

  // Hardcoded "gh issue create --title" command (without --repo placeholder)
  /gh\s+issue\s+create\s+--title\s+"[^"]+"\s+--body/gi,
]

const SOURCE_FILE_RE = /\.(ts|tsx|js|jsx)$/
const SKIPPED_DIR_NAMES = new Set([NODE_MODULES_DIR])
const PREVIEW_MAX_CHARS = 60

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
  /duplicate-pattern-scanner\.ts/, // This scanner itself (contains pattern definitions)
  /pretooluse-sandbox-guidance-consolidation\.ts/, // PreToolUse hook (contains pattern definitions)
]

function isExceptionPath(filePath: string): boolean {
  return EXCEPTION_PATTERNS.some((pattern) => pattern.test(filePath))
}

/**
 * Check if a file path should be scanned.
 */
function shouldScanFile(filePath: string): boolean {
  if (!SOURCE_FILE_RE.test(filePath)) return false
  if (isNodeModulesPath(filePath)) return false
  return !isExceptionPath(filePath)
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

    // Preserve behavior with global regexes by resetting lastIndex per line.
    pattern.lastIndex = 0
    if (!pattern.test(line)) continue

    matches.push({
      file: filePath,
      line: i + 1, // Line numbers are 1-based
      text: line.trim(),
      pattern: pattern.source,
    })
  }

  return matches
}

function shouldSkipEntry(name: string): boolean {
  return name.startsWith(".") || SKIPPED_DIR_NAMES.has(name)
}

function appendGroupedMatch(grouped: Map<string, PatternMatch[]>, match: PatternMatch): void {
  const fileMatches = grouped.get(match.file)
  if (fileMatches) {
    fileMatches.push(match)
    return
  }
  grouped.set(match.file, [match])
}

function truncatePreview(text: string, maxChars = PREVIEW_MAX_CHARS): string {
  return text.length > maxChars ? `${text.substring(0, maxChars)}...` : text
}

function formatGroupedMatches(grouped: Map<string, PatternMatch[]>): string {
  let report = ""
  for (const [file, fileMatches] of grouped) {
    report += `  ${file}\n`
    for (const match of fileMatches) {
      report += `    Line ${match.line}: ${truncatePreview(match.text)}\n`
      report += `    → This may need buildIssueGuidance() consolidation\n\n`
    }
  }
  return report
}

/**
 * Read and scan one file for duplicate pattern matches.
 * Returns null when the file cannot be read.
 */
async function scanFile(filePath: string): Promise<PatternMatch[] | null> {
  try {
    const content = await readFile(filePath, "utf-8")
    const matches: PatternMatch[] = []
    for (const pattern of DUPLICATE_PATTERNS) {
      matches.push(...findMatches(content, pattern, filePath))
    }
    return matches
  } catch {
    return null
  }
}

async function scanDirectoryRecursive(
  dir: string,
  result: { matches: PatternMatch[]; filesScanned: number }
): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true })

  for (const entry of entries) {
    if (shouldSkipEntry(entry.name)) continue
    const fullPath = join(dir, entry.name)

    if (entry.isDirectory()) {
      await scanDirectoryRecursive(fullPath, result)
      continue
    }

    if (!entry.isFile() || !shouldScanFile(fullPath)) continue

    const fileMatches = await scanFile(fullPath)
    if (fileMatches === null) continue

    result.filesScanned++
    result.matches.push(...fileMatches)
  }
}

/**
 * Scan a directory recursively for duplicate issue-guidance patterns.
 */
export async function scanForDuplicatePatterns(directory: string): Promise<ScanResult> {
  const result: ScanResult = { matches: [], filesScanned: 0 }
  await scanDirectoryRecursive(directory, result)
  return result
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
    appendGroupedMatch(grouped, match)
  }

  let report = `⚠ Found ${result.matches.length} potential duplicate pattern(s) in ${grouped.size} file(s):\n\n`
  report += formatGroupedMatches(grouped)
  report += "ACTION: Review matches and consolidate using buildIssueGuidance() in hook-utils.ts\n"
  return report
}
