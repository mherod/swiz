#!/usr/bin/env bun

//
// Infraction escalation: a graduated consequence for ignoring a hard block.
//
// The advisory context an agent reads is humanised per-call prose with no stable
// key, so "did the agent comply with the message" can't be checked. What can be
// checked is retry-after-block: re-issuing a tool call a PreToolUse hook already
// DENIED, instead of doing what the block asked.
//
// Modelled as a GTA-style wanted level (see src/infractions.ts):
//   • ★1 yellow   — 1st retry of a blocked action (advisory; next retry hard-blocks).
//   • ★2 red      — 2nd+ retry (hard deny; do the required action, not the retry).
//   • ★3 cooldown — the event right after a red card is held once with a human
//     explanation, then the session continues.
// De-escalates to clear on good behaviour (a successful action, switching away) and
// as denials age out of the window.
//
// This does NOT fire on the first block (whichever hook denied it owns that), and
// it does NOT fire on healthy-but-improvable advisory state — only on a concrete,
// already-denied action being repeated. Pure transcript scan, no state files.

import { COOLDOWN_MARKER, evaluateInfraction, resolveCurrentAttempt } from "../src/infractions.ts"
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
    `Take the action that block asked for instead of retrying — the deny message above it spells out the required step. ` +
    `Retrying this again unchanged will hard-block it.`
  )
}

function redCardMessage(toolName: string, key: string, priorDenialCount: number): string {
  return (
    `Blocked. You have retried ${describeAction(toolName, key)} ${priorDenialCount} times after it was denied, without taking the action the block required.\n\n` +
    `Stop retrying this call. Re-read the original deny message and take the action it asked for. ` +
    `If you genuinely believe the block is wrong, use the /re-assess skill rather than re-issuing the same call.`
  )
}

function cooldownMessage(): string {
  // Must contain COOLDOWN_MARKER verbatim so a later scan knows this hold was served.
  return (
    `Hold on — you're ${COOLDOWN_MARKER}. A hard block just landed, so this next step pauses for one beat.\n\n` +
    `Re-read what that block asked for and line up the right next action. This hold clears after this single step — then carry on normally.`
  )
}

export async function evaluatePretooluseInfractionEscalation(
  input: object
): Promise<SwizHookOutput> {
  const hookInput = toolHookInputSchema.parse(input)

  const current = resolveCurrentAttempt({
    tool_name: hookInput.tool_name,
    tool_input: hookInput.tool_input as Record<string, unknown> | undefined,
  })
  if (!current) return {}

  const transcriptPath = hookInput.transcript_path ?? ""
  if (!transcriptPath) return {}

  const lines = await readSessionLines(transcriptPath)
  if (lines.length === 0) return {}

  const nowMs =
    typeof hookInput._testNowMs === "number" && Number.isFinite(hookInput._testNowMs)
      ? hookInput._testNowMs
      : Date.now()

  const assessment = evaluateInfraction(lines, current, nowMs)

  if (assessment.level === "red") {
    return preToolUseDeny(
      redCardMessage(assessment.toolName, assessment.key, assessment.priorDenialCount)
    )
  }
  if (assessment.level === "cooldown") {
    return preToolUseDeny(cooldownMessage())
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
