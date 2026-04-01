#!/usr/bin/env bun

// PreToolUse hook: Block edits to src/manifest.ts that change stop hook order
// without updating src/manifest.test.ts expectations. Prevents failed pushes
// caused by manifest/test order divergence.
//
// Dual-mode: exports a SwizFileEditHook for inline dispatch and remains
// executable as a standalone script for backwards compatibility and testing.

import {
  preToolUseAllow,
  preToolUseDeny,
  runSwizHookAsMain,
  type SwizFileEditHook,
} from "../src/SwizHook.ts"
import { computeProjectedContent, isFileEditForPath } from "../src/utils/edit-projection.ts"
import { type FileEditHookInput, fileEditHookInputSchema } from "./schemas.ts"

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

/** Returns deny reason string, or null if order is valid or check cannot run. */
async function checkOrderAgainstTest(
  projectedOrder: string[],
  cwd: string
): Promise<string | null> {
  const testPath = `${cwd}/src/manifest.test.ts`
  let testSource: string
  try {
    testSource = await Bun.file(testPath).text()
  } catch {
    return null // fail open
  }

  const expectedOrder = extractTestExpectations(testSource)
  if (expectedOrder.length === 0) return null // no assertions — fail open

  const divergences = buildOrderDivergences(projectedOrder, expectedOrder)
  if (divergences.length === 0) return null

  return (
    `Manifest stop hook order diverges from test expectations.\n\n` +
    `Divergences:\n${divergences.join("\n")}\n\n` +
    `You must also update src/manifest.test.ts to match the new order.\n` +
    `Edit the "stop event hooks appear in correct order" test to reflect ` +
    `the new positions before committing.`
  )
}

const pretooluseManiOrderValidation: SwizFileEditHook = {
  name: "pretooluse-manifest-order-validation",
  event: "preToolUse",
  matcher: "Edit|Write|NotebookEdit",
  timeout: 5,

  async run(rawInput) {
    const input = fileEditHookInputSchema.parse(rawInput)
    if (!isFileEditForPath(input, "src/manifest.ts")) return preToolUseAllow("")

    try {
      const denyReason = await validateManifestOrder(input)
      return denyReason ? await preToolUseDeny(denyReason) : preToolUseAllow("")
    } catch {
      return preToolUseAllow("")
    }
  },
}

async function validateManifestOrder(input: FileEditHookInput): Promise<string | null> {
  const toolName = input.tool_name ?? ""
  const filePath = input.tool_input?.file_path ?? ""
  const projectedContent = await computeProjectedContent(toolName, filePath, input.tool_input ?? {})
  if (projectedContent === null) return null

  const projectedOrder = extractStopHookOrder(projectedContent)
  if (projectedOrder.length === 0) return null

  return await checkOrderAgainstTest(projectedOrder, input.cwd ?? process.cwd())
}

export default pretooluseManiOrderValidation

// ─── Standalone execution (file-based dispatch / manual testing) ────────────
if (import.meta.main) await runSwizHookAsMain(pretooluseManiOrderValidation)
