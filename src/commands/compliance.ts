import {
  COMPLIANCE_SCENARIOS,
  COMPLIANCE_SCOPE,
  type ComplianceOptions,
  type ComplianceReport,
  runHookCompliance,
} from "../hook-compliance.ts"
import type { Command } from "../types.ts"

export interface ComplianceArgs extends ComplianceOptions {
  json: boolean
  list: boolean
}

function parseTimeout(value: string): number {
  const seconds = Number(value)
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 300) {
    throw new Error("--timeout must be an integer between 1 and 300 seconds")
  }
  return seconds * 1000
}

function applyComplianceValue(flag: string, value: string, result: ComplianceArgs): void {
  switch (flag) {
    case "--agent":
      if (value !== "claude") {
        throw new Error("Only --agent claude currently supports controlled SDK hook tests.")
      }
      break
    case "--model":
      result.model = value
      break
    case "--scenario":
      if (value !== "stop" && value !== "pre-tool-use") {
        throw new Error("--scenario must be stop or pre-tool-use")
      }
      result.scenario = value
      break
    case "--timeout":
      result.timeoutMs = parseTimeout(value)
      break
    default:
      throw new Error(`Unknown compliance argument: ${flag}`)
  }
}

export function parseComplianceArgs(args: string[]): ComplianceArgs {
  const result: ComplianceArgs = { timeoutMs: 60_000, json: false, list: false }
  for (let i = 0; i < args.length; i++) {
    const argument = args[i]!
    if (argument === "--json" || argument === "--list") {
      result[argument === "--json" ? "json" : "list"] = true
      continue
    }
    const equals = argument.indexOf("=")
    const flag = equals < 0 ? argument : argument.slice(0, equals)
    const value = equals < 0 ? args[++i] : argument.slice(equals + 1)
    if (!value?.trim() || value.startsWith("--")) throw new Error(`Missing value for ${flag}`)
    applyComplianceValue(flag, value, result)
  }
  return result
}

export function formatComplianceReport(report: ComplianceReport): string {
  return [
    `Hook compliance: ${report.status.toUpperCase()} (${report.agent})`,
    report.scope,
    ...report.results.map(
      (result) => `${result.status.toUpperCase()} ${result.scenario}: ${result.detail}`
    ),
  ].join("\n")
}

export const complianceCommand: Command = {
  name: "compliance",
  description: "Test whether an agent follows controlled hook instructions",
  usage:
    "swiz compliance [--agent claude] [--scenario <name>] [--model <id>] [--timeout <seconds>] [--json]",
  options: [
    {
      flags: "--agent <name>",
      description: "Agent under test (currently claude; no provider fallback)",
    },
    { flags: "--scenario <name>", description: "stop or pre-tool-use (default: both)" },
    { flags: "--model <id>", description: "Claude model override" },
    {
      flags: "--timeout <seconds>",
      description: "Time limit per scenario, 1–300 seconds (default: 60)",
    },
    { flags: "--list", description: "List scenarios without starting an agent or spending tokens" },
    { flags: "--json", description: "Print structured results; exit 1 unless every test passes" },
  ],
  async run(args) {
    const options = parseComplianceArgs(args)
    if (options.list) {
      const scenarios = COMPLIANCE_SCENARIOS.filter(
        ({ id }) => !options.scenario || id === options.scenario
      )
      const output = options.json
        ? JSON.stringify({ agent: "claude", scope: COMPLIANCE_SCOPE, scenarios }, null, 2)
        : [
            COMPLIANCE_SCOPE,
            ...scenarios.map(({ id, description }) => `${id}: ${description}`),
          ].join("\n")
      process.stdout.write(`${output}\n`)
      return
    }
    const report = await runHookCompliance(options)
    process.stdout.write(
      `${options.json ? JSON.stringify(report, null, 2) : formatComplianceReport(report)}\n`
    )
    if (report.status !== "pass") process.exitCode = 1
  },
}
