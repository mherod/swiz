import { findAllProviderSessions } from "../transcript-utils.ts"
import type { Command } from "../types.ts"

const BOLD = "\x1b[1m"
const DIM = "\x1b[2m"
const RESET = "\x1b[0m"

export const sessionCommand: Command = {
  name: "session",
  description: "Show the current Claude Code session ID",
  usage: "swiz session [--list] [--dir <path>]",
  options: [
    { flags: "--list, -l", description: "List all sessions for the project with timestamps" },
    { flags: "--dir, -d <path>", description: "Target project directory (default: cwd)" },
  ],
  async run(args) {
    const listOnly = args.includes("--list") || args.includes("-l")
    const dirIdx = args.findIndex((a) => a === "--dir" || a === "-d")
    const targetDir = dirIdx !== -1 && args[dirIdx + 1] ? args[dirIdx + 1]! : process.cwd()

    const sessions = await findAllProviderSessions(targetDir)

    if (sessions.length === 0) {
      throw new Error(`No sessions found for: ${targetDir}\n(checked all configured providers)`)
    }

    if (listOnly) {
      console.log(`\n  ${BOLD}Sessions${RESET} ${DIM}(${targetDir})${RESET}\n`)
      for (const s of sessions) {
        const d = new Date(s.mtime)
        const label = d.toLocaleString([], { dateStyle: "short", timeStyle: "short" })
        console.log(`  ${s.id}  ${DIM}${label}${RESET}`)
      }
      console.log()
      return
    }

    console.log(sessions[0]!.id)
  },
}
