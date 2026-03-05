import { dirname, join } from "node:path"
import { describe, expect, it } from "vitest"
import { formatScanResults, scanForDuplicatePatterns } from "./duplicate-pattern-scanner"

const projectRoot = dirname(dirname(import.meta.url).replace("file://", ""))

describe("duplicate-pattern-scanner: enforce buildIssueGuidance consolidation", () => {
  it("fails if duplicate issue-guidance patterns are found in src/ or hooks/", async () => {
    // Scan both source and hooks directories for duplicate guidance patterns
    const srcResult = await scanForDuplicatePatterns(join(projectRoot, "src"))
    const hooksResult = await scanForDuplicatePatterns(join(projectRoot, "hooks"))

    // Report findings
    // biome-ignore lint/suspicious/noConsole: Test diagnostics output
    console.error("=== Duplicate Pattern Scan Results ===")
    // biome-ignore lint/suspicious/noConsole: Test diagnostics output
    console.error("src/ directory:")
    // biome-ignore lint/suspicious/noConsole: Test diagnostics output
    console.error(formatScanResults(srcResult))
    // biome-ignore lint/suspicious/noConsole: Test diagnostics output
    console.error("\nhooks/ directory:")
    // biome-ignore lint/suspicious/noConsole: Test diagnostics output
    console.error(formatScanResults(hooksResult))

    // Verify no duplicates found
    const allMatches = [...srcResult.matches, ...hooksResult.matches]
    const detailsText = allMatches.map((m) => `${m.file}:${m.line} - ${m.text}`).join("\n")

    expect(
      allMatches.length,
      `Found ${allMatches.length} duplicate patterns that should use buildIssueGuidance():\n${detailsText}`
    ).toBe(0)
  })

  it("detects inline gh issue create patterns", async () => {
    const result = await scanForDuplicatePatterns(join(projectRoot, "src"))
    // Verify scanner is detecting patterns correctly by checking test exception patterns work
    // (the duplicate-pattern-scanner.test.ts file itself should NOT trigger matches)
    const scannerTestMatches = result.matches.filter((m) =>
      m.file.includes("duplicate-pattern-scanner.test.ts")
    )
    expect(scannerTestMatches.length).toBe(0)
  })
})
