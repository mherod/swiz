#!/usr/bin/env bun

/**
 * SessionStart hook: inject swiz runtime and project stack detects into session context.
 */

import {
  detectCiProviders,
  detectCurrentAgent,
  detectEnvironment,
  isRunningInAgent,
} from "../src/detect.ts"
import { detectFrameworks, detectProjectStack } from "../src/detect-frameworks.ts"
import type { SwizHook, SwizHookOutput } from "../src/SwizHook.ts"
import { buildContextHookOutput, runSwizHookAsMain } from "../src/SwizHook.ts"
import { sessionStartHookInputSchema } from "../src/schemas.ts"

function formatList(items: string[], emptyLabel: string): string {
  return items.length > 0 ? items.join(", ") : emptyLabel
}

export async function evaluateSessionstartEnvironmentDetects(
  input: unknown
): Promise<SwizHookOutput> {
  const hookInput = sessionStartHookInputSchema.parse(input)
  const cwd = hookInput.cwd ?? process.cwd()

  const extended = hookInput as Record<string, unknown>
  const injected = extended._terminal as { app?: string; name?: string } | undefined

  const processAgent = detectCurrentAgent()
  const [frameworks, stacks, ciProviders] = await Promise.all([
    detectFrameworks(cwd),
    detectProjectStack(cwd),
    detectCiProviders(cwd),
  ])

  const frameworkList = [...frameworks].sort()
  const ciList = [...ciProviders].sort()

  const terminalFromPayload =
    injected && typeof injected === "object"
      ? `${String(injected.name ?? injected.app ?? "unknown")}${injected.app ? ` (${String(injected.app)})` : ""}`
      : null

  const env = detectEnvironment()
  const terminalLine = terminalFromPayload ?? `${env.terminal.name} (app=${env.terminal.app})`
  const shellLine = `${env.shell.name}${env.shell.path ? ` — ${env.shell.path}` : ""}`

  const lines: string[] = [
    "Swiz environment detects (from hook process and project tree):",
    `- Swiz-detected agent: ${processAgent ? `${processAgent.name} (id=${processAgent.id})` : "none (no env/parent match)"}`,
    `- Payload: agent_type=${hookInput.agent_type ?? "—"}, model=${hookInput.model ?? "—"}, source=${hookInput.source ?? "—"}, matcher=${hookInput.matcher ?? "—"}, trigger=${hookInput.trigger ?? "—"}`,
    `- Session: session_id=${hookInput.session_id ?? "—"}`,
    `- Working directory: ${cwd}`,
    `- Project stacks: ${formatList([...stacks], "none detected")}`,
    `- Frameworks / ecosystems: ${formatList(frameworkList, "none detected")}`,
    `- CI config signals: ${formatList(ciList, "none detected")}`,
    `- Terminal: ${terminalLine}`,
    `- Shell: ${shellLine}`,
    `- isRunningInAgent(): ${isRunningInAgent() ? "true" : "false"}`,
  ]

  return buildContextHookOutput("SessionStart", lines.join("\n"))
}

const sessionstartEnvironmentDetects: SwizHook<Record<string, any>> = {
  name: "sessionstart-environment-detects",
  event: "sessionStart",
  matcher: "startup",
  timeout: 5,
  run(input) {
    return evaluateSessionstartEnvironmentDetects(input)
  },
}

export default sessionstartEnvironmentDetects

if (import.meta.main) {
  await runSwizHookAsMain(sessionstartEnvironmentDetects)
}
