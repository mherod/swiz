import {
  buildBrowserPolicyFixture,
  collectEnforcementReport,
  replayBrowserPolicy,
} from "../enforcement-evidence.ts"
import type { Command } from "../types.ts"

function optionValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  if (index < 0) return undefined
  const next = args[index + 1]
  if (!next || next.startsWith("--")) throw new Error(`Missing value for ${flag}`)
  return next
}

async function runFileAction(action: string, args: string[]): Promise<void> {
  if (action !== "export" && action !== "replay")
    throw new Error(`Unknown enforcement action: ${action}`)
  const path = optionValue(args, "--file")
  if (!path) throw new Error(`${action} requires --file <capture.json>`)
  const file = Bun.file(path)
  if (file.size > 2 * 1024 * 1024) throw new Error("Capture exceeds 2 MiB")
  const payload = await file.json()
  const output =
    action === "export" ? buildBrowserPolicyFixture(payload) : await replayBrowserPolicy(payload)
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
}

export const enforcementCommand: Command = {
  name: "enforcement",
  description: "Inspect observed decisions or safely replay the browser CLI policy",
  usage:
    "swiz enforcement [--session <id>] [--since-minutes <n>] [--json] | swiz enforcement <export|replay> --file <capture.json>",
  options: [
    { flags: "--session <id>", description: "Inspect one session in the current project" },
    { flags: "--since-minutes <n>", description: "Evidence window (default 20 minutes)" },
    { flags: "--json", description: "Print structured evidence" },
    { flags: "--file <path>", description: "Read a capture, tool payload or exported fixture" },
  ],
  async run(args) {
    const action = args[0]?.startsWith("--") ? undefined : args[0]
    if (action) return runFileAction(action, args)
    const minutes = Number(optionValue(args, "--since-minutes") ?? 20)
    if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 1440)
      throw new Error("--since-minutes must be between 0 and 1440")
    const report = await collectEnforcementReport({
      cwd: process.cwd(),
      sessionId: optionValue(args, "--session"),
      sinceMs: minutes * 60_000,
    })
    if (args.includes("--json")) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
      return
    }
    const lines = [
      report.state,
      report.note,
      `Capture retention: ${report.captureRetentionMs / 60_000} minutes; requested window: ${minutes} minutes.`,
    ]
    for (const session of report.sessions)
      lines.push(
        `${session.agent} ${session.sessionId}: ${session.evidence} evidence at ${session.lastObservedAt}; ${session.denied} denied, ${session.passed} passed, ${session.unknown} unknown; resolved shell observed: ${session.resolvedShellObserved}`
      )
    process.stdout.write(`${lines.join("\n")}\n`)
  },
}
