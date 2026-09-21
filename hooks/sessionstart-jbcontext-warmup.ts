#!/usr/bin/env bun

/**
 * SessionStart hook: trigger background index warmup and inject jbcontext status into session context.
 */

import {
  detectJbcontext,
  type JbcontextDetection,
  triggerJbcontextIndex,
} from "../src/jbcontext.ts"
import type { SwizHook, SwizHookOutput } from "../src/SwizHook.ts"
import { buildContextHookOutput, runSwizHookAsMain } from "../src/SwizHook.ts"
import { sessionStartHookInputSchema } from "../src/schemas.ts"

function formatJbcontextContext(cwd: string, isIndexed: boolean, indicesCount: number): string {
  if (!isIndexed || indicesCount === 0) {
    return (
      `JetBrains Context: semantic index warmup initiated in background for ${cwd}. ` +
      `Use jbcontext search or MCP tool code_search for semantic code discovery.`
    )
  }
  return (
    `JetBrains Context: semantic code search active for ${cwd} (${indicesCount} index snapshot(s) available). ` +
    `Use jbcontext search or MCP tool code_search for semantic code discovery.`
  )
}

function resolveWarmupCwd(input: unknown): string {
  const parsed = sessionStartHookInputSchema.safeParse(input)
  if (parsed.success && parsed.data.cwd) {
    return parsed.data.cwd
  }
  return process.cwd()
}

function isIndexMissing(detection: JbcontextDetection): boolean {
  if (detection.project?.indexed !== true) return true
  const indices = detection.project?.indices
  return !indices || indices.length === 0
}

function launchWarmup(detection: JbcontextDetection, cwd: string): void {
  void triggerJbcontextIndex({
    binaryPath: detection.binaryPath ?? undefined,
    projectPath: cwd,
    silent: true,
  }).catch(() => {})
}

export async function evaluateSessionstartJbcontextWarmup(input: unknown): Promise<SwizHookOutput> {
  const cwd = resolveWarmupCwd(input)
  const detection = await detectJbcontext({
    projectPath: cwd,
    checkProject: true,
    timeoutMs: 2000,
  })

  if (!detection.available || !detection.configured) {
    return {}
  }

  const missing = isIndexMissing(detection)
  if (missing) {
    launchWarmup(detection, cwd)
  }

  const indicesCount = detection.project?.indices?.length ?? 0
  return buildContextHookOutput("SessionStart", formatJbcontextContext(cwd, !missing, indicesCount))
}

const sessionstartJbcontextWarmup: SwizHook<Record<string, any>> = {
  name: "sessionstart-jbcontext-warmup",
  event: "sessionStart",
  matcher: "startup",
  timeout: 5,
  run(input) {
    return evaluateSessionstartJbcontextWarmup(input)
  },
}

export default sessionstartJbcontextWarmup

if (import.meta.main) {
  await runSwizHookAsMain(sessionstartJbcontextWarmup)
}
