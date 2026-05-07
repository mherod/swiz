#!/usr/bin/env bun

/**
 * SessionStart hook: Remind the agent that WebSearch is available for tasks
 * where it would help — error-message validation, framework version-specific
 * behaviours, third-party API quirks, security best-practice verification.
 *
 * Only emitted for Claude (the only agent that exposes a WebSearch tool).
 * Other agents (Codex, Cursor, Gemini) get no-op output.
 *
 * See #577.
 */

import { detectCurrentAgentFromHookPayload } from "../src/agent-paths.ts"
import type { SwizHook, SwizHookOutput } from "../src/SwizHook.ts"
import { buildContextHookOutput, runSwizHookAsMain } from "../src/SwizHook.ts"
import { sessionStartHookInputSchema } from "../src/schemas.ts"

const SUGGESTION = [
  "WebSearch reminder: prefer WebSearch over guessing when:",
  "  • An error message is unfamiliar or framework-version specific.",
  "  • Validating a fix against current docs (Next.js, React, Firebase, AWS, …).",
  "  • Checking known issues, security advisories, or API quirks.",
  "  • Confirming a library's current public API before writing against it.",
  "Cite the exact error / framework + version in the query.",
].join("\n")

export function evaluateSessionstartWebSearchSuggester(input: unknown): SwizHookOutput {
  const hookInput = sessionStartHookInputSchema.parse(input)
  const raw = hookInput as Record<string, unknown>

  // Only Claude exposes a WebSearch tool today. Skip the suggestion for
  // agents that don't expose a WebSearch-equivalent surface.
  const agent = detectCurrentAgentFromHookPayload(raw)
  if (agent && agent.id !== "claude") return {}

  return buildContextHookOutput("SessionStart", SUGGESTION)
}

const sessionstartWebSearchSuggester: SwizHook = {
  name: "sessionstart-websearch-suggester",
  event: "sessionStart",
  timeout: 5,
  run(input) {
    return evaluateSessionstartWebSearchSuggester(input)
  },
}

export default sessionstartWebSearchSuggester

if (import.meta.main) {
  await runSwizHookAsMain(sessionstartWebSearchSuggester)
}
