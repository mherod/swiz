#!/usr/bin/env bun

import { runSwizHookAsMain, type SwizHook, type SwizHookOutput } from "../src/SwizHook.ts"
import type { PostToolHookInput } from "../src/schemas.ts"
import { evaluateCompletedMeasurement } from "./measure-execution-time.ts"

export async function evaluate(input: PostToolHookInput): Promise<SwizHookOutput> {
  return await evaluateCompletedMeasurement(input, { kind: "test", label: "Test" })
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
