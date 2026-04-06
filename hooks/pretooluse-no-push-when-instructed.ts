#!/usr/bin/env bun
// PreToolUse hook: Block `git push` when the current transcript contains an
// explicit "do not push" instruction (e.g. from a skill or user message)
// without a subsequent explicit push-approval signal.
//
// Skills such as /commit include "DO NOT push to remote without approval" in
// their content. This hook detects those instructions and hard-blocks the push
// unless approval appears AFTER the blocking instruction in the transcript.
//
// Approval signals (must appear AFTER the "do not push" instruction):
//   - An explicit USER message ("go ahead and push", "/push", "push now", etc.)
//
// Both blocking and approval are restricted to user-role entries. This prevents
// the agent's own reasoning from self-approving a push it was told not to do.
//
// NOT accepted as approval (all machine-generated):
//   - Stop-hook action plans ("Push N commit(s) to") — system messages
//   - Skill content (e.g. /push skill header) — auto-loaded by the agent
//   - Assistant reasoning ("I'll go ahead and push") — agent-generated text
//
// Dual-mode: exports a SwizHook for inline dispatch and remains
// executable as a standalone script for backwards compatibility and testing.

import {
  preToolUseAllow,
  preToolUseDeny,
  runSwizHookAsMain,
  type SwizHook,
  type SwizHookOutput,
} from "../src/SwizHook.ts"
import type { ToolHookInput } from "../src/schemas.ts"
import { scanPushGateFromJsonlLines } from "../src/transcript-push-gate.ts"

async function isPushGateActive(input: ToolHookInput): Promise<boolean> {
  const injected = (input as Record<string, any>)._effectiveSettings as
    | Record<string, any>
    | undefined
  if (injected && typeof injected.pushGate !== "undefined") {
    return injected.pushGate === true
  }

  const { getSwizSettingsPath, readSwizSettings } = await import("../src/settings.ts")
  const path = getSwizSettingsPath()
  if (!path) return false
  const file = Bun.file(path)
  if (!(await file.exists())) return false
  try {
    const settings = await readSwizSettings({ strict: true })
    return settings.pushGate
  } catch {
    // Parse failure on a present file → fail-closed: keep the gate active.
    return true
  }
}

async function isPushCommand(input: ToolHookInput): Promise<boolean> {
  const { isShellTool, GIT_PUSH_RE } = await import("../src/utils/hook-utils.ts")
  if (!isShellTool(input?.tool_name ?? "")) return false
  const command: string = (input?.tool_input?.command as string) ?? ""
  return GIT_PUSH_RE.test(command)
}

const pretoolusNoPushWhenInstructed: SwizHook = {
  name: "pretooluse-no-push-when-instructed",
  event: "preToolUse",
  matcher: "Bash",
  timeout: 5,

  async run(input: ToolHookInput): Promise<SwizHookOutput> {
    if (!(await isPushGateActive(input))) return preToolUseAllow("")
    if (!(await isPushCommand(input))) return preToolUseAllow("")

    const transcriptPath: string = input?.transcript_path ?? ""
    if (!transcriptPath) return preToolUseAllow("")

    const { readSessionLines } = await import("../src/utils/hook-utils.ts")
    const state = scanPushGateFromJsonlLines(await readSessionLines(transcriptPath))

    if (!state.blockingLine) return preToolUseAllow("No 'do not push' instruction found")
    if (state.approvedAfter) return preToolUseAllow("Push approved by user after instruction")

    return preToolUseDeny(
      `BLOCKED: git push is prohibited by an explicit instruction in this session.\n\n` +
        `Instruction found in transcript:\n` +
        `  "${state.blockingLine}"\n\n` +
        `The /commit skill and other workflows include "DO NOT push" directives that must\n` +
        `be respected. Pushing without explicit approval after seeing that instruction is\n` +
        `a procedural violation.\n\n` +
        `To push, you must receive explicit user approval first (e.g. the user invokes\n` +
        `/push or says "go ahead and push"). Do not attempt to rationalise around this.`
    )
  },
}

export default pretoolusNoPushWhenInstructed

if (import.meta.main) {
  await runSwizHookAsMain(pretoolusNoPushWhenInstructed)
}
