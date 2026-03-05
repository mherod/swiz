import { expect, test } from "bun:test"
import { dirname, join } from "node:path"
import { formatScanResults, scanForDuplicatePatterns } from "./duplicate-pattern-scanner"

const projectRoot = dirname(dirname(import.meta.url).replace("file://", ""))

test("duplicate-pattern-scanner: detects no inlined guidance in src/ and hooks/", async () => {
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
  if (allMatches.length > 0) {
    const detailsText = allMatches.map((m) => `${m.file}:${m.line} - ${m.text}`).join("\n")
    expect.unreachable(
      `Found ${allMatches.length} duplicate patterns that should use buildIssueGuidance():\n${detailsText}`
    )
  }

  expect(allMatches.length).toBe(0)
})
