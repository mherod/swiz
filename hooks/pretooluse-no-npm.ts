#!/usr/bin/env bun
// PreToolUse hook: Redirect only implausible package-manager usage.
// Main guardrail: prevent blind npm/npx usage when project signals indicate a non-npm setup.

import {
  denyPreToolUse,
  detectPackageManager,
  isShellTool,
  type PackageManager,
} from "./hook-utils.ts"
import { SHELL_SEGMENT_BOUNDARY } from "./utils/shell-patterns.ts"

const PM = detectPackageManager()

// Equivalent subcommands across package managers
interface CmdMap {
  install: string
  add: string
  addDev: string
  addGlobal: string
  remove: string
  run: string
  test: string
  exec: string
  dlx: string
  update: string
  ci: string
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
}

function deny(from: string, to: string): void {
  const pmLabel = PM ?? "the project's package manager"
  denyPreToolUse(
    `Use ${pmLabel} instead. Project signals suggest ${pmLabel} is the expected package manager.\n\n` +
      `  ${from}  →  ${to}`
  )
}

const SUBCMD_MAP: Record<string, keyof CmdMap> = {
  ci: "ci",
  exec: "exec",
  dlx: "dlx",
  run: "run",
  start: "run",
  test: "test",
  t: "test",
  update: "update",
  up: "update",
  upgrade: "update",
}

const REMOVE_SUBCMDS = new Set(["uninstall", "remove", "rm", "un", "r", "unlink"])
const INSTALL_SUBCMDS = new Set(["install", "i", "add"])

function classifySubcmd(subcmd: string, args: string): keyof CmdMap | null {
  if (INSTALL_SUBCMDS.has(subcmd)) {
    if (args.includes("-g")) return "addGlobal"
    if (args.includes("-D") || args.includes("--save-dev")) return "addDev"
    if (args.trim().length > 0 || subcmd === "add") return "add"
    return "install"
  }
  if (subcmd === "") return "install"
  if (REMOVE_SUBCMDS.has(subcmd)) return "remove"
  return SUBCMD_MAP[subcmd] ?? null
}

/**
 * Decide whether this invocation is implausible enough to redirect.
 *
 * We intentionally focus on npm/npx because accidental npm usage is the most
 * common lockfile-drift source. bun/pnpm are generally acceptable choices in
 * modern repos and should not be hard-redirected by default.
 */
function isImplausibleInvocation(invoked: string): boolean {
  if (!PM) return false
  if (invoked === "npm" || invoked === "npx") return PM !== "npm"
  // Yarn is usually implausible in bun/pnpm projects.
  if (invoked === "yarn") return PM === "bun" || PM === "pnpm"
  return false
}

const PM_INVOKE_RE = new RegExp(
  `${SHELL_SEGMENT_BOUNDARY}\\s*(npm|npx|yarn|pnpm|pnpx|bunx?)\\s*(\\S*)(.*?)(?=[|;&]|$)`
)

const PACKAGE_RUNNERS = new Set(["npx", "pnpx", "bunx"])

async function main() {
  const input = await Bun.stdin.json()
  if (!isShellTool(input?.tool_name ?? "")) process.exit(0)
  if (!PM) process.exit(0)

  const command: string = input?.tool_input?.command ?? ""
  const m = command.match(PM_INVOKE_RE)
  if (!m) process.exit(0)

  const invoked = (m[1] ?? "").toLowerCase()
  if (!isImplausibleInvocation(invoked)) process.exit(0)

  const subcmd = m[2]?.toLowerCase() ?? ""
  const rest = m[3]?.trim() ?? ""
  const target = CMD[PM]

  if (PACKAGE_RUNNERS.has(invoked)) {
    deny(`${invoked} <pkg>`, target.dlx)
  }

  const kind = classifySubcmd(subcmd, rest)
  if (kind) {
    const fromPM = invoked as PackageManager
    const fromCmd = CMD[fromPM]?.[kind] ?? `${invoked} ${subcmd}`
    deny(fromCmd, target[kind])
  }

  deny(`${invoked} ${subcmd}`, `${PM} ${subcmd}`)
}

if (import.meta.main) {
  void main()
}
