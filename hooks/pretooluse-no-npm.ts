#!/usr/bin/env bun
// PreToolUse hook: Guide npm/npx/yarn/pnpm → bun equivalents
// bun is the project-standard runtime and package manager.
// Also catches pnpm for full coverage — swiz enforces bun everywhere.

import { denyPreToolUse, isShellTool } from "./hook-utils.ts";

interface Mapping {
  match: (subcmd: string, args: string) => boolean;
  from: string;
  to: string;
}

const NPM_MAPPINGS: Mapping[] = [
  {
    match: (s, a) => (s === "install" || s === "i") && a.includes("-g"),
    from: "npm install -g <pkg>",
    to: "bun add -g <pkg>",
  },
  {
    match: (s, a) => (s === "install" || s === "i") && (a.includes("-D") || a.includes("--save-dev")),
    from: "npm install -D <pkg>",
    to: "bun add -D <pkg>",
  },
  {
    match: (s, a) => (s === "install" || s === "i") && a.trim().length > 0,
    from: "npm install <pkg>",
    to: "bun add <pkg>",
  },
  {
    match: (s) => s === "install" || s === "i",
    from: "npm install",
    to: "bun install",
  },
  {
    match: (s) => s === "ci",
    from: "npm ci",
    to: "bun install --frozen-lockfile",
  },
  {
    match: (s) => ["uninstall", "remove", "rm", "un", "r"].includes(s),
    from: "npm uninstall <pkg>",
    to: "bun remove <pkg>",
  },
  {
    match: (s) => s === "run",
    from: "npm run <script>",
    to: "bun run <script>",
  },
  {
    match: (s) => s === "start",
    from: "npm start",
    to: "bun run start",
  },
  {
    match: (s) => s === "test" || s === "t",
    from: "npm test",
    to: "bun test",
  },
  {
    match: (s) => ["update", "up", "upgrade"].includes(s),
    from: "npm update",
    to: "bun update",
  },
  {
    match: (s) => s === "exec",
    from: "npm exec <cmd>",
    to: "bunx <cmd>",
  },
  {
    match: (s) => s === "link",
    from: "npm link",
    to: "bun link",
  },
  {
    match: () => true,
    from: "npm <subcmd>",
    to: "bun <subcmd>",
  },
];

const YARN_MAPPINGS: Mapping[] = [
  {
    match: (s, a) => s === "add" && a.includes("-D"),
    from: "yarn add -D <pkg>",
    to: "bun add -D <pkg>",
  },
  {
    match: (s, a) => s === "add" && a.includes("-g"),
    from: "yarn global add <pkg>",
    to: "bun add -g <pkg>",
  },
  {
    match: (s) => s === "add",
    from: "yarn add <pkg>",
    to: "bun add <pkg>",
  },
  {
    match: (s) => ["remove", "unlink"].includes(s),
    from: "yarn remove <pkg>",
    to: "bun remove <pkg>",
  },
  {
    match: (s) => s === "install" || s === "",
    from: "yarn install",
    to: "bun install",
  },
  {
    match: (s) => s === "upgrade",
    from: "yarn upgrade",
    to: "bun update",
  },
  {
    match: (s) => s === "dlx",
    from: "yarn dlx <pkg>",
    to: "bunx <pkg>",
  },
  {
    match: (s) => s === "exec",
    from: "yarn exec <cmd>",
    to: "bunx <cmd>",
  },
  {
    match: (s) => s === "run",
    from: "yarn run <script>",
    to: "bun run <script>",
  },
  {
    match: () => true,
    from: "yarn <script>",
    to: "bun <script>",
  },
];

const PNPM_MAPPINGS: Mapping[] = [
  {
    match: (s, a) => s === "add" && a.includes("-D"),
    from: "pnpm add -D <pkg>",
    to: "bun add -D <pkg>",
  },
  {
    match: (s, a) => s === "add" && a.includes("-g"),
    from: "pnpm add -g <pkg>",
    to: "bun add -g <pkg>",
  },
  {
    match: (s) => s === "add",
    from: "pnpm add <pkg>",
    to: "bun add <pkg>",
  },
  {
    match: (s) => ["remove", "unlink"].includes(s),
    from: "pnpm remove <pkg>",
    to: "bun remove <pkg>",
  },
  {
    match: (s) => s === "install" || s === "i",
    from: "pnpm install",
    to: "bun install",
  },
  {
    match: (s) => s === "dlx",
    from: "pnpm dlx <pkg>",
    to: "bunx <pkg>",
  },
  {
    match: (s) => s === "exec",
    from: "pnpm exec <cmd>",
    to: "bunx <cmd>",
  },
  {
    match: (s) => s === "run",
    from: "pnpm run <script>",
    to: "bun run <script>",
  },
  {
    match: () => true,
    from: "pnpm <script>",
    to: "bun <script>",
  },
];

function extractTokens(command: string): { pkg: string; subcmd: string; rest: string } | null {
  const m = command.match(/(?:^|[|;&])\s*(npm|npx|yarn|pnpm|pnpx)\s*(\S*)(.*?)(?=[|;&]|$)/);
  if (!m) return null;
  return { pkg: m[1].toLowerCase(), subcmd: m[2].toLowerCase(), rest: m[3].trim() };
}

function findMapping(mappings: Mapping[], subcmd: string, rest: string): Mapping | undefined {
  return mappings.find((m) => m.match(subcmd, rest));
}

function deny(from: string, to: string, extra?: string): void {
  const lines = [
    `Use bun instead. bun is the project-standard runtime and package manager.`,
    ``,
    `  ${from}  →  ${to}`,
  ];
  if (extra) lines.push(``, extra);
  lines.push(``, `Monorepo targeting: bun --filter <app> <script>`);
  denyPreToolUse(lines.join("\n"));
}

const input = await Bun.stdin.json();
if (!isShellTool(input?.tool_name ?? "")) process.exit(0);

const command: string = input?.tool_input?.command ?? "";

// npx → bunx
if (/(?:^|[|;&])\s*npx\s/.test(command)) {
  const tokens = extractTokens(command);
  const pkg = tokens?.subcmd ?? "<pkg>";
  deny(`npx ${pkg}`, `bunx ${pkg}`);
  process.exit(0);
}

// pnpx → bunx
if (/(?:^|[|;&])\s*pnpx\s/.test(command)) {
  const tokens = extractTokens(command);
  const pkg = tokens?.subcmd ?? "<pkg>";
  deny(`pnpx ${pkg}`, `bunx ${pkg}`);
  process.exit(0);
}

// npm commands
if (/(?:^|[|;&])\s*npm\s/.test(command)) {
  const tokens = extractTokens(command);
  if (tokens) {
    const mapping = findMapping(NPM_MAPPINGS, tokens.subcmd, tokens.rest);
    deny(mapping?.from ?? `npm ${tokens.subcmd}`, mapping?.to ?? `bun ${tokens.subcmd}`);
    process.exit(0);
  }
}

// yarn commands
if (/(?:^|[|;&])\s*yarn\s/.test(command)) {
  const tokens = extractTokens(command);
  if (tokens) {
    const mapping = findMapping(YARN_MAPPINGS, tokens.subcmd, tokens.rest);
    deny(mapping?.from ?? `yarn ${tokens.subcmd}`, mapping?.to ?? `bun ${tokens.subcmd}`);
    process.exit(0);
  }
}

// pnpm commands
if (/(?:^|[|;&])\s*pnpm\s/.test(command)) {
  const tokens = extractTokens(command);
  if (tokens) {
    const mapping = findMapping(PNPM_MAPPINGS, tokens.subcmd, tokens.rest);
    deny(mapping?.from ?? `pnpm ${tokens.subcmd}`, mapping?.to ?? `bun ${tokens.subcmd}`);
    process.exit(0);
  }
}
