#!/usr/bin/env bun

// PreToolUse hook: Block edits to src/manifest.ts that change stop hook order
// without updating src/manifest.test.ts expectations. Prevents failed pushes
// caused by manifest/test order divergence.

import {
  allowPreToolUse,
  computeProjectedContent,
  denyPreToolUse,
  isEditTool,
  isWriteTool,
} from "./utils/hook-utils.ts"

/** Extract stop hook filenames from manifest source in order. */
function extractStopHookOrder(source: string): string[] {
  // Match the stop event block and extract file strings from hooks array
  const stopMatch = source.match(/event:\s*["']stop["'][\s\S]*?hooks:\s*\[([\s\S]*?)\]\s*,?\s*\}/)
  if (!stopMatch?.[1]) return []

  const fileMatches = [...stopMatch[1].matchAll(/file:\s*["']([^"']+)["']/g)]
  return fileMatches.map((m) => m[1]).filter((f): f is string => !!f)
}

/** Extract expected order assertions from manifest test source. */
function extractTestExpectations(source: string): string[] {
  // Match expect(files[N]).toBe("...") patterns in the order test
  const orderTestMatch = source.match(/stop event hooks appear in correct order[\s\S]*?(?=\n\s*\})/)
  if (!orderTestMatch) return []

  const expectMatches = [
    ...orderTestMatch[0].matchAll(/expect\(files\[(\d+)\]\)\.toBe\(["']([^"']+)["']\)/g),
  ]
  // Sort by index to preserve expected order
  return expectMatches
    .sort((a, b) => Number(a[1]) - Number(b[1]))
    .map((m) => m[2])
    .filter((f): f is string => !!f)
}

function buildOrderDivergences(projectedOrder: string[], expectedOrder: string[]): string[] {
  const divergences: string[] = []
  for (let i = 0; i < expectedOrder.length; i++) {
    if (projectedOrder[i] !== expectedOrder[i]) {
      divergences.push(
        `  Position ${i}: manifest has "${projectedOrder[i] ?? "(missing)"}", test expects "${expectedOrder[i]}"`
      )
    }
  }
  return divergences
}

async function main() {
  const input = (await Bun.stdin.json()) as {
    tool_name?: string
    tool_input?: {
      file_path?: string
      old_string?: string
      new_string?: string
      content?: string
    }
    cwd?: string
  }

  const toolName = input.tool_name ?? ""
  const filePath = input.tool_input?.file_path ?? ""

  // Only fire on manifest.ts edits
  if (!filePath.endsWith("src/manifest.ts")) {
    process.exit(0)
  }

  if (!isEditTool(toolName) && !isWriteTool(toolName)) {
    process.exit(0)
  }

  try {
    const projectedContent = await computeProjectedContent(
      toolName,
      filePath,
      input.tool_input ?? {}
    )
    if (projectedContent === null) {
      allowPreToolUse("")
    }

    const projectedOrder = extractStopHookOrder(projectedContent)
    if (projectedOrder.length === 0) {
      // Could not parse — fail open
      allowPreToolUse("")
    }

    // Read the test file
    const cwd = input.cwd ?? process.cwd()
    const testPath = `${cwd}/src/manifest.test.ts`
    let testSource: string
    try {
      testSource = await Bun.file(testPath).text()
    } catch {
      // No test file — fail open
      allowPreToolUse("")
    }

    const expectedOrder = extractTestExpectations(testSource)
    if (expectedOrder.length === 0) {
      // No order assertions found — fail open
      allowPreToolUse("")
    }

    const divergences = buildOrderDivergences(projectedOrder, expectedOrder)
    if (divergences.length > 0) {
      denyPreToolUse(
        `Manifest stop hook order diverges from test expectations.\n\n` +
          `Divergences:\n${divergences.join("\n")}\n\n` +
          `You must also update src/manifest.test.ts to match the new order.\n` +
          `Edit the "stop event hooks appear in correct order" test to reflect ` +
          `the new positions before committing.`
      )
    }

    allowPreToolUse("")
  } catch {
    // Fail open on any error
    process.exit(0)
  }
}

if (import.meta.main) {
  main().catch(() => process.exit(0))
}
