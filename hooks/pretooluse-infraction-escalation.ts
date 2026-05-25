#!/usr/bin/env bun

//
// Infraction escalation: a graduated consequence for ignoring a hard block.
//
// The advisory context an agent reads is humanised per-call prose with no stable
// key, so "did the agent comply with the message" can't be checked. What can be
// checked is retry-after-block: re-issuing a tool call a PreToolUse hook already
// DENIED, instead of doing what the block asked.
//
//   • 1st retry of a blocked action → yellow card (escalating advisory; the next
//     retry will hard-block).
//   • 2nd+ retry → red card (hard deny that refuses the tool until the agent does
//     the required action instead of retrying).
//
// This does NOT fire on the first block (whichever hook denied it owns that), and
// it does NOT fire on healthy-but-improvable advisory state — only on a concrete,
// already-denied action being repeated. Pure transcript scan, no state files.

import {
  assessInfraction,
  collectBlockedAttempts,
  resolveCurrentAttempt,
} from "../src/infractions.ts"
import {
  buildContextHookOutput,
  preToolUseDeny,
  runSwizHookAsMain,
  type SwizHookOutput,
  type SwizToolHook,
} from "../src/SwizHook.ts"
import { toolHookInputSchema } from "../src/schemas.ts"
import { readSessionLines } from "../src/utils/transcript.ts"

function describeAction(toolName: string, key: string): string {
  if (toolName === "Bash") return `the command \`${key}\``
  if (toolName === "Edit" || toolName === "Write") return `edits to ${key}`
  return `this ${toolName} call`
}

function yellowCardMessage(toolName: string, key: string): string {
  return (
    `You already tried ${describeAction(toolName, key)} once and a guard blocked it. ` +
    `Do not retry the same call — do what the block asked first (the deny message above it spells out the required step). ` +
    `If you retry this again unchanged, it will be hard-blocked.`
  )
}

function redCardMessage(toolName: string, key: string, priorDenialCount: number): string {
  return (
    `Blocked. You have retried ${describeAction(toolName, key)} ${priorDenialCount} times after it was denied, without doing what the block required.\n\n` +
    `Stop retrying this call. Re-read the original deny message and take the action it asked for instead. ` +
    `If you genuinely believe the block is wrong, use the /re-assess skill — do not keep re-issuing the same call.`
  )
}

export async function evaluatePretooluseInfractionEscalation(
  input: object
): Promise<SwizHookOutput> {
  const hookInput = toolHookInputSchema.parse(input)

  const current = resolveCurrentAttempt({
    tool_name: hookInput.tool_name,
    tool_input: hookInput.tool_input as Record<string, any> | undefined,
  })
  if (!current) return {}

  const transcriptPath = hookInput.transcript_path ?? ""
  if (!transcriptPath) return {}

  const lines = await readSessionLines(transcriptPath)
  if (lines.length === 0) return {}

  const blockedAttempts = collectBlockedAttempts(lines)
  if (blockedAttempts.length === 0) return {}

  const nowMs =
    typeof hookInput._testNowMs === "number" && Number.isFinite(hookInput._testNowMs)
      ? hookInput._testNowMs
      : Date.now()

  const assessment = assessInfraction(current, blockedAttempts, nowMs)

  if (assessment.level === "red") {
    return preToolUseDeny(
      redCardMessage(assessment.toolName, assessment.key, assessment.priorDenialCount)
    )
  }
  if (assessment.level === "yellow") {
    return buildContextHookOutput(
      "PreToolUse",
      yellowCardMessage(assessment.toolName, assessment.key)
    )
  }
  return {}
}

const pretooluseInfractionEscalation: SwizToolHook = {
  name: "pretooluse-infraction-escalation",
  event: "preToolUse",
  matcher: "Edit|Write|Bash",
  timeout: 5,
  run(input) {
    return evaluatePretooluseInfractionEscalation(input)
  },
}

export default pretooluseInfractionEscalation

if (import.meta.main) {
  await runSwizHookAsMain(pretooluseInfractionEscalation)
}
