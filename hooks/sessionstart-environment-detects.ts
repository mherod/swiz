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

interface InjectedTerminal {
  app?: string
  name?: string
}

function formatInjectedTerminal(injected: InjectedTerminal | undefined): string | null {
  if (!injected || typeof injected !== "object") return null
  const terminal = String(injected.name ?? injected.app ?? "unknown")
  return injected.app ? `${terminal} (${String(injected.app)})` : terminal
}

function formatDetectedAgent(agent: ReturnType<typeof detectCurrentAgent>): string {
  return agent ? `${agent.name} (id=${agent.id})` : "none (no env/parent match)"
}

function formatPayloadValue(value: unknown): string {
  return value === undefined || value === null ? "—" : String(value)
}

function formatTerminalLine(
  injected: InjectedTerminal | undefined,
  environment: ReturnType<typeof detectEnvironment>
): string {
  return (
    formatInjectedTerminal(injected) ??
    `${environment.terminal.name} (app=${environment.terminal.app})`
  )
}

function formatShellLine(environment: ReturnType<typeof detectEnvironment>): string {
  return environment.shell.path
    ? `${environment.shell.name} — ${environment.shell.path}`
    : environment.shell.name
}

export async function evaluateSessionstartEnvironmentDetects(
  input: unknown
): Promise<SwizHookOutput> {
  const hookInput = sessionStartHookInputSchema.parse(input)
  const cwd = hookInput.cwd ?? process.cwd()

  const extended = hookInput as Record<string, unknown>
  const injected = extended._terminal as InjectedTerminal | undefined

  const processAgent = detectCurrentAgent()
  const [frameworks, stacks, ciProviders] = await Promise.all([
    detectFrameworks(cwd),
    detectProjectStack(cwd),
    detectCiProviders(cwd),
  ])

  const frameworkList = [...frameworks].sort()
  const ciList = [...ciProviders].sort()

  const env = detectEnvironment()

  const lines: string[] = [
    "Environment detected for this session:",
    `- Detected agent: ${formatDetectedAgent(processAgent)}`,
    `- Payload: agent_type=${formatPayloadValue(hookInput.agent_type)}, model=${formatPayloadValue(hookInput.model)}, source=${formatPayloadValue(hookInput.source)}, matcher=${formatPayloadValue(hookInput.matcher)}, trigger=${formatPayloadValue(hookInput.trigger)}`,
    `- Session: session_id=${formatPayloadValue(hookInput.session_id)}`,
    `- Working directory: ${cwd}`,
    `- Project stacks: ${formatList([...stacks], "none detected")}`,
    `- Frameworks / ecosystems: ${formatList(frameworkList, "none detected")}`,
    `- CI config signals: ${formatList(ciList, "none detected")}`,
    `- Terminal: ${formatTerminalLine(injected, env)}`,
    `- Shell: ${formatShellLine(env)}`,
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
