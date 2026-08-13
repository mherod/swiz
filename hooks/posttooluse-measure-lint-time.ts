#!/usr/bin/env bun

import { runSwizHookAsMain, type SwizHook, type SwizHookOutput } from "../src/SwizHook.ts"
import type { PostToolHookInput } from "../src/schemas.ts"
import { evaluateCompletedMeasurement } from "./measure-execution-time.ts"

export async function evaluate(input: PostToolHookInput): Promise<SwizHookOutput> {
  return await evaluateCompletedMeasurement(input, { kind: "lint", label: "Lint" })
}

const posttooluseMeasureLintTime: SwizHook<PostToolHookInput> = {
  name: "posttooluse-measure-lint-time",
  event: "postToolUse",
  matcher: "Bash",
  timeout: 5,

  run(input) {
    return evaluate(input)
  },
}

export default posttooluseMeasureLintTime

if (import.meta.main) {
  await runSwizHookAsMain(posttooluseMeasureLintTime as SwizHook<Record<string, any>>)
}
