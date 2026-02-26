import { join, dirname } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import type { Command } from "../types.ts";

const SWIZ_ROOT = dirname(Bun.main);
const SHIM_PATH = join(SWIZ_ROOT, "hooks", "shim.sh");
const HOME = process.env.HOME ?? "~";

const MARKER_START = "# >>> swiz shim >>>";
const MARKER_END = "# <<< swiz shim <<<";

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

interface ShellProfile {
  name: string;
  path: string;
  description: string;
}

function detectProfiles(): ShellProfile[] {
  const shell = process.env.SHELL ?? "";
  const profiles: ShellProfile[] = [];

  if (shell.endsWith("zsh")) {
    profiles.push(
      {
        name: ".zshenv",
        path: join(HOME, ".zshenv"),
        description: "all zsh invocations (interactive + non-interactive)",
      },
      {
        name: ".zshrc",
        path: join(HOME, ".zshrc"),
        description: "interactive zsh only",
      },
    );
  }

  if (shell.endsWith("bash") || !shell.endsWith("zsh")) {
    profiles.push({
      name: ".bashrc",
      path: join(HOME, ".bashrc"),
      description: "interactive bash only",
    });
  }

  return profiles;
}

function shimBlock(): string {
  return [
    MARKER_START,
    `[ -f "${SHIM_PATH}" ] && source "${SHIM_PATH}"`,
    MARKER_END,
  ].join("\n");
}

async function readProfile(path: string): Promise<string> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return "";
  }
}

function hasShimBlock(content: string): boolean {
  return content.includes(MARKER_START);
}

function removeShimBlock(content: string): string {
  const lines = content.split("\n");
  const result: string[] = [];
  let inside = false;

  for (const line of lines) {
    if (line.includes(MARKER_START)) {
      inside = true;
      continue;
    }
    if (line.includes(MARKER_END)) {
      inside = false;
      continue;
    }
    if (!inside) result.push(line);
  }

  return result.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

async function showStatus() {
  const profiles = detectProfiles();
  const shell = process.env.SHELL ?? "unknown";

  console.log(`\n  ${BOLD}swiz shim${RESET}\n`);
  console.log(`  Shell: ${shell}`);
  console.log(`  Shim:  ${SHIM_PATH}\n`);

  let anyInstalled = false;

  for (const profile of profiles) {
    const exists = await Bun.file(profile.path).exists();
    if (!exists) {
      console.log(`  ${DIM}${profile.name}: not found${RESET}`);
      continue;
    }

    const content = await readProfile(profile.path);
    const installed = hasShimBlock(content);

    if (installed) {
      console.log(`  ${GREEN}●${RESET} ${profile.name}: ${GREEN}installed${RESET} ${DIM}(${profile.description})${RESET}`);
      anyInstalled = true;
    } else {
      console.log(`  ${DIM}○${RESET} ${profile.name}: not installed ${DIM}(${profile.description})${RESET}`);
    }
  }

  if (!anyInstalled) {
    console.log(`\n  ${DIM}Run \`swiz shim install\` to add the shim to your shell profile.${RESET}`);
  }

  console.log(`\n  ${DIM}The shim intercepts commands like grep, npm, sed, and node, enforcing${RESET}`);
  console.log(`  ${DIM}project conventions at the shell level — works with any agent.${RESET}`);
  console.log(`\n  ${DIM}In agent context (non-interactive shell): commands are blocked.${RESET}`);
  console.log(`  ${DIM}In human context (interactive shell):     warnings only, command proceeds.${RESET}`);
  console.log(`\n  ${DIM}Bypass: SWIZ_BYPASS=1 <command>, or: command <command>${RESET}\n`);
}

async function install(args: string[]) {
  const profiles = detectProfiles();
  const dryRun = args.includes("--dry-run");

  // Let user pick profile, default to the broadest one
  let targetName = args.find((a) => a.startsWith("."))?.replace(/^\./, ".");
  let target: ShellProfile | undefined;

  if (targetName) {
    target = profiles.find((p) => p.name === targetName);
    if (!target) {
      throw new Error(`Unknown profile: ${targetName}\nAvailable: ${profiles.map((p) => p.name).join(", ")}`);
    }
  } else {
    // Default: .zshenv for zsh (broadest coverage), .bashrc for bash
    target = profiles[0];
  }

  if (!target) {
    throw new Error("Could not determine shell profile.");
  }

  console.log(`\n  ${BOLD}swiz shim install${dryRun ? " (dry run)" : ""}${RESET}\n`);
  console.log(`  Target: ${target.path} ${DIM}(${target.description})${RESET}\n`);

  const content = await readProfile(target.path);

  if (hasShimBlock(content)) {
    // Replace existing block (in case path changed)
    const cleaned = removeShimBlock(content);
    const updated = cleaned.trimEnd() + "\n\n" + shimBlock() + "\n";

    if (dryRun) {
      console.log(`  ${YELLOW}↻ Replacing existing shim block${RESET}\n`);
      console.log(`  ${DIM}${shimBlock()}${RESET}\n`);
    } else {
      await writeFile(target.path, updated, "utf-8");
      console.log(`  ${YELLOW}↻ Replaced existing shim block in ${target.name}${RESET}\n`);
    }
  } else {
    const updated = content.trimEnd() + "\n\n" + shimBlock() + "\n";

    if (dryRun) {
      console.log(`  ${GREEN}+ Adding shim block:${RESET}\n`);
      console.log(`  ${DIM}${shimBlock()}${RESET}\n`);
    } else {
      await writeFile(target.path, updated, "utf-8");
      console.log(`  ${GREEN}✓ Added shim block to ${target.name}${RESET}\n`);
    }
  }

  if (!dryRun) {
    console.log(`  ${DIM}Restart your shell or run:  source ${target.path}${RESET}\n`);
    console.log(`  Shimmed commands: grep, egrep, fgrep, find, sed, awk,`);
    console.log(`                    npm, npx, yarn, pnpm, node, ts-node,`);
    console.log(`                    python, python3, rm\n`);
    console.log(`  ${DIM}Agent context → blocked. Interactive → warning only.${RESET}`);
    console.log(`  ${DIM}Bypass: SWIZ_BYPASS=1 <command>, or: command <command>${RESET}\n`);
  } else {
    console.log(`  No changes written.\n`);
  }
}

async function uninstall(args: string[]) {
  const profiles = detectProfiles();
  const dryRun = args.includes("--dry-run");
  let removed = 0;

  console.log(`\n  ${BOLD}swiz shim uninstall${dryRun ? " (dry run)" : ""}${RESET}\n`);

  for (const profile of profiles) {
    const exists = await Bun.file(profile.path).exists();
    if (!exists) continue;

    const content = await readProfile(profile.path);
    if (!hasShimBlock(content)) continue;

    if (dryRun) {
      console.log(`  ${RED}- Would remove shim from ${profile.name}${RESET}`);
    } else {
      const cleaned = removeShimBlock(content);
      await writeFile(profile.path, cleaned, "utf-8");
      console.log(`  ${GREEN}✓ Removed shim from ${profile.name}${RESET}`);
    }
    removed++;
  }

  if (removed === 0) {
    console.log(`  ${DIM}No shim blocks found in any profile.${RESET}`);
  } else if (!dryRun) {
    console.log(`\n  ${DIM}Restart your shell to apply changes.${RESET}`);
  }
  console.log();
}

export const shimCommand: Command = {
  name: "shim",
  description: "Install shell-level command interception for agents",
  usage: "swiz shim [install | uninstall | status] [--dry-run]",
  async run(args) {
    const subcommand = args[0];
    const rest = args.slice(1);

    switch (subcommand) {
      case "install":
        return install(rest);
      case "uninstall":
        return uninstall(rest);
      case "status":
      case undefined:
        return showStatus();
      default:
        throw new Error(`Unknown subcommand: ${subcommand}\nUsage: swiz shim [install | uninstall | status] [--dry-run]`);
    }
  },
};
