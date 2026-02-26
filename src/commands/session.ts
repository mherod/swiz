import { join } from "node:path";
import type { Command } from "../types.ts";
import { findSessions, projectKeyFromCwd } from "../transcript-utils.ts";

const HOME = process.env.HOME ?? "~";
const PROJECTS_DIR = join(HOME, ".claude", "projects");

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

export const sessionCommand: Command = {
  name: "session",
  description: "Show the current Claude Code session ID",
  usage: "swiz session [--list] [--dir <path>]",
  async run(args) {
    const listOnly = args.includes("--list") || args.includes("-l");
    const dirIdx = args.findIndex((a) => a === "--dir" || a === "-d");
    const targetDir = dirIdx !== -1 && args[dirIdx + 1]
      ? args[dirIdx + 1]!
      : process.cwd();

    const projectKey = projectKeyFromCwd(targetDir);
    const projectDir = join(PROJECTS_DIR, projectKey);
    const sessions = await findSessions(projectDir);

    if (sessions.length === 0) {
      throw new Error(`No sessions found for: ${targetDir}\n(looked in: ${projectDir})`);
    }

    if (listOnly) {
      console.log(`\n  ${BOLD}Sessions${RESET} ${DIM}(${targetDir})${RESET}\n`);
      for (const s of sessions) {
        const d = new Date(s.mtime);
        const label = d.toLocaleString([], { dateStyle: "short", timeStyle: "short" });
        console.log(`  ${s.id}  ${DIM}${label}${RESET}`);
      }
      console.log();
      return;
    }

    console.log(sessions[0]!.id);
  },
};
