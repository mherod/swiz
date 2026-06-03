#!/usr/bin/env bun

import { unlink } from "node:fs/promises"
import { join } from "node:path"
import { git } from "../src/git-helpers.ts"
import { runSwizHookAsMain, type SwizHook, type SwizHookOutput } from "../src/SwizHook.ts"
import type { PostToolHookInput } from "../src/schemas.ts"
import { resolveSafeSessionId } from "../src/session-id.ts"
import { TMP_ROOT } from "../src/temp-paths.ts"
import { isShellTool } from "../src/tool-matchers.ts"
import { isBackgroundCommand } from "../src/utils/inline-hook-helpers.ts"

export async function evaluate(input: PostToolHookInput): Promise<SwizHookOutput> {
  if (!input.tool_name || !isShellTool(input.tool_name)) return {}

  const command = String(input.tool_input?.command ?? "")
  if (isBackgroundCommand(input, command)) return {}

  const sessionId = resolveSafeSessionId(input.session_id) || "default"
  const sentinelPath = join(TMP_ROOT, `swiz-test-start-${sessionId}.json`)

  const file = Bun.file(sentinelPath)
  if (await file.exists()) {
    try {
      const data = JSON.parse(await file.text())
      // Clean up the sentinel immediately so we do not double-count
      await unlink(sentinelPath).catch(() => {})

      if (typeof data.startTime === "number") {
        const elapsedMs = Date.now() - data.startTime

        const cwd = input.cwd ?? process.cwd()
        const repoRoot = await git(["rev-parse", "--show-toplevel"], cwd)
        const projectRoot = repoRoot || cwd
        const statsPath = join(projectRoot, ".swiz", "test-execution-stats.json")

        let stats = { totalTimeMs: 0, count: 0 }
        const statsFile = Bun.file(statsPath)
        if (await statsFile.exists()) {
          try {
            const raw = await statsFile.text()
            const existing = JSON.parse(raw)
            if (typeof existing.totalTimeMs === "number" && typeof existing.count === "number") {
              stats = existing
            }
          } catch {
            // Use defaults if corrupt
          }
        }

        stats.totalTimeMs += elapsedMs
        stats.count += 1
        const averageMs = stats.totalTimeMs / stats.count
        const averageSeconds = averageMs / 1000

        await Bun.write(statsPath, JSON.stringify(stats, null, 2))

        const currentSeconds = elapsedMs / 1000
        return {
          systemMessage: `Test run took ${currentSeconds.toFixed(2)}s. Average test execution time updated: ${averageSeconds.toFixed(2)}s (based on ${stats.count} runs).`,
        }
      }
    } catch {
      // Non-fatal
    }
  }

  return {}
}

const posttooluseMeasureTestTime: SwizHook<PostToolHookInput> = {
  name: "posttooluse-measure-test-time",
  event: "postToolUse",
  matcher: "Bash",
  timeout: 5,

  run(input) {
    return evaluate(input)
  },
}

export default posttooluseMeasureTestTime

if (import.meta.main) {
  await runSwizHookAsMain(posttooluseMeasureTestTime as SwizHook<Record<string, any>>)
}
