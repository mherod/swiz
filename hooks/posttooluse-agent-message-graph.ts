#!/usr/bin/env bun

/**
 * PostToolUse hook: record that one agent session messaged another.
 *
 * Inter-agent `SendMessage` is the only first-class signal that two sessions are collaborating,
 * and it is currently invisible to everything downstream — task stores are per-project,
 * transcripts are per-session, and a message leaves no trace in either.
 *
 * PostToolUse rather than PreToolUse: an association graph should record messages that were
 * actually sent, not ones a guard refused.
 *
 * Records the sender, the recipient address as written, and the body size. Never the body —
 * knowing two sessions exchanged 3kB is what a graph needs, and the incoming-capture JSONL
 * already sets that precedent by stripping tool inputs to key names and byte counts.
 */

import {
  type AgentMessageEdge,
  parseRecipient,
  recordAgentMessage,
} from "../src/agent-message-graph.ts"
import { runSwizHookAsMain, type SwizHook, type SwizHookOutput } from "../src/SwizHook.ts"
import type { ToolHookInput } from "../src/schemas.ts"

/**
 * The recipient field, tolerating the alias the wire payload carries.
 *
 * The documented SendMessage schema has `to`, but captured payloads also carry `recipient` with
 * an identical value. Reading both means a change on either side does not silently stop the
 * graph recording anything.
 */
function readRecipientAddress(toolInput: Record<string, unknown>): string | null {
  for (const key of ["to", "recipient"]) {
    const value = toolInput[key]
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return null
}

/**
 * Body size, preferring the real body over the preview.
 *
 * `content` looks like a body but is a ~50-character truncated preview of `message`, so measuring
 * it would understate every edge. Only `message` is a faithful length.
 */
function readMessageBytes(toolInput: Record<string, unknown>): number {
  const message = toolInput.message
  return typeof message === "string" ? Buffer.byteLength(message, "utf8") : 0
}

export function buildAgentMessageEdge(
  input: ToolHookInput,
  now = new Date()
): AgentMessageEdge | null {
  const raw = input as unknown as Record<string, unknown>
  const toolInput = (raw.tool_input ?? {}) as Record<string, unknown>
  const toAddress = readRecipientAddress(toolInput)
  if (!toAddress) return null

  const fromSessionId = typeof raw.session_id === "string" ? raw.session_id : ""
  const fromCwd = typeof raw.cwd === "string" ? raw.cwd : ""
  // Without both ends of the edge there is no association to record.
  if (!fromSessionId || !fromCwd) return null

  return {
    at: now.toISOString(),
    fromSessionId,
    fromCwd,
    toAddress,
    messageBytes: readMessageBytes(toolInput),
  }
}

export async function evaluatePosttooluseAgentMessageGraph(
  input: ToolHookInput
): Promise<SwizHookOutput> {
  const edge = buildAgentMessageEdge(input)
  if (edge) {
    // Parsed here only to keep malformed addresses out of the log; resolution to a project is
    // the reader's job, so the hook stays a cheap append.
    if (parseRecipient(edge.toAddress).kind !== "unknown") await recordAgentMessage(edge)
  }
  // Pure telemetry: never returns context, never blocks.
  return {}
}

const posttooluseAgentMessageGraph: SwizHook<ToolHookInput> = {
  name: "posttooluse-agent-message-graph",
  event: "postToolUse",
  timeout: 5,
  run(input) {
    return evaluatePosttooluseAgentMessageGraph(input)
  },
}

export default posttooluseAgentMessageGraph

if (import.meta.main) {
  await runSwizHookAsMain(posttooluseAgentMessageGraph)
}
