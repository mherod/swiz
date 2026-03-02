import { issueState } from "../../hooks/hook-utils.ts"
import type { Command } from "../types.ts"

function usage(): string {
  return (
    "Usage: swiz issue <subcommand> <number> [options]\n" +
    "Subcommands: close, comment\n" +
    "  swiz issue close <number>\n" +
    "  swiz issue comment <number> --body <text>"
  )
}

async function closeIssue(number: string): Promise<void> {
  const cwd = process.cwd()
  const state = await issueState(number, cwd)

  if (state !== "OPEN") {
    console.log(`  Issue #${number} is already ${state ?? "unknown"} — skipping close.`)
    return
  }

  const proc = Bun.spawn(["gh", "issue", "close", number], {
    cwd,
    stdout: "inherit",
    stderr: "inherit",
  })
  await proc.exited
  if (proc.exitCode !== 0) {
    throw new Error(`gh issue close failed with exit code ${proc.exitCode}`)
  }
}

async function commentOnIssue(number: string, body: string): Promise<void> {
  const cwd = process.cwd()
  const state = await issueState(number, cwd)

  if (state !== "OPEN") {
    console.log(`  Issue #${number} is already ${state ?? "unknown"} — skipping comment.`)
    return
  }

  const proc = Bun.spawn(["gh", "issue", "comment", number, "--body", body], {
    cwd,
    stdout: "inherit",
    stderr: "inherit",
  })
  await proc.exited
  if (proc.exitCode !== 0) {
    throw new Error(`gh issue comment failed with exit code ${proc.exitCode}`)
  }
}

export const issueCommand: Command = {
  name: "issue",
  description: "Interact with GitHub issues (guards against operating on closed issues)",
  usage: "swiz issue <close|comment> <number> [--body <text>]",
  options: [
    { flags: "close <number>", description: "Close an issue (skips if already closed)" },
    {
      flags: "comment <number> --body <text>",
      description: "Comment on an issue (skips if already closed)",
    },
    { flags: "--body, -b <text>", description: "Comment body (required for comment subcommand)" },
  ],
  async run(args) {
    const sub = args[0]
    const number = args[1]

    if (!sub || !number) {
      throw new Error(`Missing arguments.\n${usage()}`)
    }

    if (sub === "close") {
      return closeIssue(number)
    }

    if (sub === "comment") {
      let body: string | undefined
      for (let i = 2; i < args.length; i++) {
        if ((args[i] === "--body" || args[i] === "-b") && args[i + 1]) {
          body = args[i + 1]
          break
        }
      }
      if (!body) {
        throw new Error(`--body is required for the comment subcommand.\n${usage()}`)
      }
      return commentOnIssue(number, body)
    }

    throw new Error(`Unknown subcommand: ${sub}\n${usage()}`)
  },
}
