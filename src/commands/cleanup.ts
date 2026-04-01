// Thin re-export — all cleanup logic now lives in doctor.ts.
// This file preserves the public API for existing tests and the `swiz cleanup` alias.

export type { CleanupArgs } from "./doctor.ts"
export {
  decodeProjectPath,
  parseCleanupArgs,
  runCleanupCommand,
  walkDecode,
} from "./doctor.ts"

import type { Command } from "../types.ts"
import { runCleanupCommand } from "./doctor.ts"

export const cleanupCommand: Command = {
  name: "cleanup",
  description: "Remove old Claude Code/Junie session data and Gemini backup artifacts",
  usage:
    "swiz cleanup [--older-than <time>] [--task-older-than <time>] [--dry-run] [--project <name>] [--junie-only]",
  options: [
    {
      flags: "--older-than <time>",
      description:
        "Remove Claude/Junie sessions older than this time: days (30, 7d) or hours (48h). Default: 30",
    },
    { flags: "--dry-run", description: "Show what would be removed without deleting" },
    {
      flags: "--project <name>",
      description: "Limit Claude/Junie cleanup to a specific project directory name",
    },
    {
      flags: "--task-older-than <time>",
      description:
        "Also remove completed/cancelled task files older than this time (days/hours). Example: 30d, 168h",
    },
    {
      flags: "--junie-only",
      description: "Only scan and clean up Junie sessions",
    },
  ],

  async run(args: string[]) {
    await runCleanupCommand(args)
  },
}
