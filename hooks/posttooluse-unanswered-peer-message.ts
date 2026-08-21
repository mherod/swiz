#!/usr/bin/env bun

/**
 * PostToolUse hook: remind the session when a peer's message is still unanswered.
 *
 * The SendMessage gate can only catch messages being sent. The expensive failure is the mirror
 * of it — receiving a peer's question and working straight through without replying — and no
 * gate on sending can see that, because the defect is that nothing was sent.
 *
 * Fires on any tool call, after a few have passed since the message arrived, so a session that
 * is already composing its reply is not nagged mid-answer.
 */

import {
  buildContextHookOutput,
  runSwizHookAsMain,
  type SwizHook,
  type SwizHookOutput,
} from "../src/SwizHook.ts"
import type { ToolHookInput } from "../src/schemas.ts"
import {
  findUnansweredPeerMessages,
  formatUnansweredPeerContext,
} from "../src/unanswered-peer-messages.ts"

/** Tool calls that must pass before the reminder fires. */
const MIN_TOOL_CALLS = 3

export async function evaluatePosttooluseUnansweredPeerMessage(
  input: ToolHookInput
): Promise<SwizHookOutput> {
  const transcriptPath = (input as { transcript_path?: unknown }).transcript_path
  if (typeof transcriptPath !== "string" || !transcriptPath) return {}

  let text: string
  try {
    text = await Bun.file(transcriptPath).text()
  } catch {
    // A missing or unreadable transcript is not a coordination signal; stay quiet.
    return {}
  }

  const unanswered = findUnansweredPeerMessages(text.split("\n"))
  const context = formatUnansweredPeerContext(unanswered, MIN_TOOL_CALLS)
  return context ? buildContextHookOutput("PostToolUse", context) : {}
}

const posttooluseUnansweredPeerMessage: SwizHook = {
  name: "posttooluse-unanswered-peer-message",
  event: "postToolUse",
  cooldownSeconds: 120,
  cooldownMode: "always",
  timeout: 5,
  run(input: ToolHookInput) {
    return evaluatePosttooluseUnansweredPeerMessage(input)
  },
}

export default posttooluseUnansweredPeerMessage

if (import.meta.main) {
  await runSwizHookAsMain(posttooluseUnansweredPeerMessage)
}
