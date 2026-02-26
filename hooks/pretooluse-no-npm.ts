#!/usr/bin/env bun
// PreToolUse hook: Redirect wrong package managers to the project's preferred one.
// Detects bun/pnpm/yarn/npm from lockfiles and blocks all others.

import {
  denyPreToolUse,
  isShellTool,
  detectPackageManager,
  detectPkgRunner,
  type PackageManager,
} from "./hook-utils.ts";

const PM = detectPackageManager();

// Equivalent subcommands across package managers
interface CmdMap {
  install: string;
  add: string;
  addDev: string;
  addGlobal: string;
  remove: string;
  run: string;
  test: string;
  exec: string;
  dlx: string;
  update: string;
  ci: string;
}

const CMD: Record<PackageManager, CmdMap> = {
  bun: {
    install: "bun install",
    add: "bun add <pkg>",
    addDev: "bun add -D <pkg>",
    addGlobal: "bun add -g <pkg>",
    remove: "bun remove <pkg>",
    run: "bun run <script>",
    test: "bun test",
    exec: "bunx <cmd>",
    dlx: "bunx <pkg>",
    update: "bun update",
    ci: "bun install --frozen-lockfile",
  },
  pnpm: {
    install: "pnpm install",
    add: "pnpm add <pkg>",
    addDev: "pnpm add -D <pkg>",
    addGlobal: "pnpm add -g <pkg>",
    remove: "pnpm remove <pkg>",
    run: "pnpm run <script>",
    test: "pnpm test",
    exec: "pnpm exec <cmd>",
    dlx: "pnpm dlx <pkg>",
    update: "pnpm update",
    ci: "pnpm install --frozen-lockfile",
  },
  yarn: {
    install: "yarn install",
    add: "yarn add <pkg>",
    addDev: "yarn add -D <pkg>",
    addGlobal: "yarn global add <pkg>",
    remove: "yarn remove <pkg>",
    run: "yarn run <script>",
    test: "yarn test",
    exec: "yarn exec <cmd>",
    dlx: "yarn dlx <pkg>",
    update: "yarn upgrade",
    ci: "yarn install --frozen-lockfile",
  },
  npm: {
    install: "npm install",
    add: "npm install <pkg>",
    addDev: "npm install -D <pkg>",
    addGlobal: "npm install -g <pkg>",
    remove: "npm uninstall <pkg>",
    run: "npm run <script>",
    test: "npm test",
    exec: "npm exec <cmd>",
    dlx: "npx <pkg>",
    update: "npm update",
    ci: "npm ci",
  },
};

function deny(from: string, to: string): void {
  const pmLabel = PM ?? "the project's package manager";
  denyPreToolUse(
    `Use ${pmLabel} instead. This project uses ${pmLabel} (detected from lockfile).\n\n` +
    `  ${from}  →  ${to}`
  );
}

function classifySubcmd(subcmd: string, args: string): keyof CmdMap | null {
  if ((subcmd === "install" || subcmd === "i") && args.includes("-g")) return "addGlobal";
  if ((subcmd === "install" || subcmd === "i") && (args.includes("-D") || args.includes("--save-dev"))) return "addDev";
  if ((subcmd === "install" || subcmd === "i" || subcmd === "add") && args.trim().length > 0) return "add";
  if (subcmd === "install" || subcmd === "i" || subcmd === "") return "install";
  if (subcmd === "ci") return "ci";
  if (["uninstall", "remove", "rm", "un", "r", "unlink"].includes(subcmd)) return "remove";
  if (subcmd === "run" || subcmd === "start") return "run";
  if (subcmd === "test" || subcmd === "t") return "test";
  if (subcmd === "exec") return "exec";
  if (subcmd === "dlx") return "dlx";
  if (["update", "up", "upgrade"].includes(subcmd)) return "update";
  return null;
}

const input = await Bun.stdin.json();
if (!isShellTool(input?.tool_name ?? "")) process.exit(0);

const command: string = input?.tool_input?.command ?? "";

// No lockfile found — can't enforce, allow everything
if (!PM) process.exit(0);

const target = CMD[PM];

// Extract the package manager being invoked
const m = command.match(/(?:^|[|;&])\s*(npm|npx|yarn|pnpm|pnpx|bunx?)\s*(\S*)(.*?)(?=[|;&]|$)/);
if (!m) process.exit(0);

const invoked = m[1].toLowerCase();
const subcmd = m[2]?.toLowerCase() ?? "";
const rest = m[3]?.trim() ?? "";

// If they're using the project's PM, allow it
if (invoked === PM) process.exit(0);
if (PM === "bun" && (invoked === "bun" || invoked === "bunx")) process.exit(0);
if (PM === "pnpm" && invoked === "pnpx") process.exit(0);

// Package runners: npx/pnpx/bunx/yarn dlx
if (invoked === "npx" || invoked === "pnpx" || invoked === "bunx") {
  deny(`${invoked} <pkg>`, target.dlx);
}

// Map the subcmd to the equivalent in the project PM
const kind = classifySubcmd(subcmd, rest);
if (kind) {
  const fromPM = invoked as PackageManager;
  const fromCmd = CMD[fromPM]?.[kind] ?? `${invoked} ${subcmd}`;
  deny(fromCmd, target[kind]);
}

// Catch-all
deny(`${invoked} ${subcmd}`, `${PM} ${subcmd}`);
