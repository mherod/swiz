#!/usr/bin/env bun
// PreToolUse hook: Guide npm/npx/yarn → pnpm equivalents
// pnpm is the project-standard package manager.
// pnpx is an alias for pnpm dlx (one-off package execution).

import { denyPreToolUse } from "./hook-utils.ts";

interface Mapping {
  match: (subcmd: string, args: string) => boolean;
  from: string;
  to: string;
}

const NPM_MAPPINGS: Mapping[] = [
  {
    match: (s, a) => (s === "install" || s === "i") && a.includes("-g"),
    from: "npm install -g <pkg>",
    to: "pnpm add -g <pkg>",
  },
  {
    match: (s, a) => (s === "install" || s === "i") && (a.includes("-D") || a.includes("--save-dev")),
    from: "npm install -D <pkg>",
    to: "pnpm add -D <pkg>",
  },
  {
    match: (s, a) => (s === "install" || s === "i") && a.trim().length > 0,
    from: "npm install <pkg>",
    to: "pnpm add <pkg>",
  },
  {
    match: (s) => s === "install" || s === "i",
    from: "npm install",
    to: "pnpm install",
  },
  {
    match: (s) => s === "ci",
    from: "npm ci",
    to: "pnpm install --frozen-lockfile",
  },
  {
    match: (s) => ["uninstall", "remove", "rm", "un", "r"].includes(s),
    from: "npm uninstall <pkg>",
    to: "pnpm remove <pkg>",
  },
  {
    match: (s) => s === "run",
    from: "npm run <script>",
    to: "pnpm <script>  (or pnpm run <script>)",
  },
  {
    match: (s) => s === "start",
    from: "npm start",
    to: "pnpm start",
  },
  {
    match: (s) => s === "test" || s === "t",
    from: "npm test",
    to: "pnpm test",
  },
  {
    match: (s) => s === "publish",
    from: "npm publish",
    to: "pnpm publish",
  },
  {
    match: (s) => s === "pack",
    from: "npm pack",
    to: "pnpm pack",
  },
  {
    match: (s) => ["update", "up", "upgrade"].includes(s),
    from: "npm update",
    to: "pnpm update",
  },
  {
    match: (s) => s === "outdated",
    from: "npm outdated",
    to: "pnpm outdated",
  },
  {
    match: (s) => s === "audit",
    from: "npm audit",
    to: "pnpm audit",
  },
  {
    match: (s) => s === "exec",
    from: "npm exec <cmd>",
    to: "pnpm exec <cmd>",
  },
  {
    match: (s) => s === "link",
    from: "npm link",
    to: "pnpm link",
  },
  {
    match: (s) => s === "list" || s === "ls",
    from: "npm list",
    to: "pnpm list",
  },
  {
    match: (s) => s === "dedupe",
    from: "npm dedupe",
    to: "pnpm dedupe",
  },
  {
    match: (s) => s === "rebuild",
    from: "npm rebuild",
    to: "pnpm rebuild",
  },
];

const YARN_MAPPINGS: Mapping[] = [
  {
    match: (s, a) => s === "add" && a.includes("-D"),
    from: "yarn add -D <pkg>",
    to: "pnpm add -D <pkg>",
  },
  {
    match: (s, a) => s === "add" && a.includes("-g"),
    from: "yarn global add <pkg>",
    to: "pnpm add -g <pkg>",
  },
  {
    match: (s) => s === "add",
    from: "yarn add <pkg>",
    to: "pnpm add <pkg>",
  },
  {
    match: (s) => ["remove", "unlink"].includes(s),
    from: "yarn remove <pkg>",
    to: "pnpm remove <pkg>",
  },
  {
    match: (s) => s === "install" || s === "",
    from: "yarn install",
    to: "pnpm install",
  },
  {
    match: (s) => s === "upgrade",
    from: "yarn upgrade",
    to: "pnpm update",
  },
  {
    match: (s) => s === "dlx",
    from: "yarn dlx <pkg>",
    to: "pnpm dlx <pkg>  (or pnpx <pkg>)",
  },
  {
    match: (s) => s === "exec",
    from: "yarn exec <cmd>",
    to: "pnpm exec <cmd>",
  },
  {
    match: (s) => s === "run",
    from: "yarn run <script>",
    to: "pnpm <script>",
  },
  {
    match: (s) => ["workspace", "workspaces"].includes(s),
    from: "yarn workspace <app> <script>",
    to: "pnpm --filter <app> <script>",
  },
  {
    match: () => true, // catch-all yarn <script>
    from: "yarn <script>",
    to: "pnpm <script>",
  },
];

function extractTokens(command: string): { subcmd: string; rest: string } | null {
  // Match the first npm/npx/yarn/pnpx invocation in a pipeline
  const m = command.match(/(?:^|[|;&])\s*(npm|npx|yarn|pnpx)\s*(\S*)(.*?)(?=[|;&]|$)/);
  if (!m) return null;
  return { subcmd: m[2].toLowerCase(), rest: m[3].trim() };
}

function findMapping(mappings: Mapping[], subcmd: string, rest: string): Mapping | undefined {
  return mappings.find((m) => m.match(subcmd, rest));
}

function deny(from: string, to: string, extra?: string): void {
  const lines = [
    `Use pnpm instead. pnpm is the project-standard package manager.`,
    ``,
    `  ${from}  →  ${to}`,
  ];
  if (extra) lines.push(``, extra);
  lines.push(``, `Monorepo targeting: pnpm --filter <app> <script>`);
  denyPreToolUse(lines.join("\n"));
}

const input = await Bun.stdin.json();
if (input?.tool_name !== "Bash") process.exit(0);

const command: string = input?.tool_input?.command ?? "";

// npx → pnpm dlx
if (/(?:^|[|;&])\s*npx\s/.test(command)) {
  const tokens = extractTokens(command);
  const pkg = tokens?.subcmd ?? "<pkg>";
  deny(`npx ${pkg}`, `pnpm dlx ${pkg}  (or pnpx ${pkg})`, `pnpx is an alias for pnpm dlx.`);
  process.exit(0);
}

// pnpx is fine — it's already the pnpm alias
if (/(?:^|[|;&])\s*pnpx\s/.test(command)) process.exit(0);

// npm commands
if (/(?:^|[|;&])\s*npm\s/.test(command)) {
  const tokens = extractTokens(command);
  if (tokens) {
    const mapping = findMapping(NPM_MAPPINGS, tokens.subcmd, tokens.rest);
    if (mapping) {
      deny(mapping.from, mapping.to);
    } else {
      deny(`npm ${tokens.subcmd}`, `pnpm ${tokens.subcmd}  (check pnpm docs for exact equivalent)`);
    }
    process.exit(0);
  }
}

// yarn commands
if (/(?:^|[|;&])\s*yarn\s/.test(command)) {
  const tokens = extractTokens(command);
  if (tokens) {
    const mapping = findMapping(YARN_MAPPINGS, tokens.subcmd, tokens.rest);
    if (mapping) {
      deny(mapping.from, mapping.to);
    } else {
      deny(`yarn ${tokens.subcmd}`, `pnpm ${tokens.subcmd}`);
    }
    process.exit(0);
  }
}
