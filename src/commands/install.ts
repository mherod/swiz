import { AGENTS, getAgentByFlag, hasAnyAgentFlag } from "../agents.ts"
import { BOLD, DIM, GREEN, RED, RESET, YELLOW } from "../ansi.ts"
import { getHomeDirOrNull } from "../home.ts"
import { loadAllPlugins, pluginErrorHint, pluginResultsToJson } from "../plugins.ts"
import { pauseSessionstartSelfHeal } from "../sessionstart-self-heal-state.ts"
import { readProjectSettings, writeProjectSettings } from "../settings.ts"
import { HOOKS_DIR } from "../swiz-hook-commands.ts"
import type { Command } from "../types.ts"
import { DAEMON_PORT } from "./daemon/daemon-admin.ts"
import { agentConfigSyncCheck } from "./doctor/checks/agent-config-sync.ts"
import { configScriptsCheck } from "./doctor/checks/config-scripts.ts"
import { scriptPermissionsCheck } from "./doctor/checks/script-permissions.ts"
import type { CheckResult, DiagnosticCheck, DiagnosticContext } from "./doctor/types.ts"
import { installAgent } from "./install/agent-helpers.ts"
import {
  installDaemonForCli,
  installDaemonLaunchAgent,
  uninstallDaemonForCli,
  uninstallDaemonLaunchAgent,
} from "./install/daemon-helpers.ts"
import type { InstallRunOptions } from "./install/types.ts"
import {
  installSwizAsMcpServer,
  MCP_MANAGED_AGENT_IDS,
  uninstallSwizAsMcpServer,
} from "./manage.ts"
import { uninstallSwizFromAgents } from "./uninstall.ts"
export { installDaemonLaunchAgent, uninstallDaemonLaunchAgent }

import {
  installMergeTool,
  installStatusLine,
  uninstallMergeTool,
  uninstallStatusLine,
} from "./install/optional-helpers.ts"

// ─── Command Helpers ─────────────────────────────────────────────────────────

function checkBunAvailable(): boolean {
  try {
    const proc = Bun.spawnSync(["bun", "--version"])
    return proc.exitCode === 0
  } catch {
    return false
  }
}

function parseInstallRunOptions(args: string[]): InstallRunOptions {
  const jsonOutput = args.includes("--json")
  const daemon = args.includes("--daemon")
  const portIdx = args.indexOf("--port")
  const rawPort = portIdx !== -1 ? Number(args[portIdx + 1]) : Number.NaN
  const daemonPort = daemon && Number.isFinite(rawPort) ? rawPort : DAEMON_PORT

  return {
    jsonOutput,
    dryRun: jsonOutput || args.includes("--dry-run"),
    uninstall: args.includes("--uninstall"),
    mergeTool: args.includes("--merge-tool"),
    statusLine: args.includes("--status-line"),
    daemon,
    daemonPort,
    targets: getAgentByFlag(args),
  }
}

/** True when `install --uninstall` should remove every swiz integration (no scope flags). */
function isFullUninstall(opts: InstallRunOptions): boolean {
  return opts.uninstall && !opts.mergeTool && !opts.statusLine && !opts.daemon
}

function shouldInstallHooks(args: string[], opts: InstallRunOptions): boolean {
  return (!opts.mergeTool && !opts.daemon) || hasAnyAgentFlag(args)
}

async function runOptionalInstallSteps(opts: InstallRunOptions): Promise<void> {
  if (opts.mergeTool) await installMergeTool(opts.dryRun)
  if (opts.statusLine) await installStatusLine(opts.dryRun)
  if (opts.daemon) await installDaemonForCli(opts.daemonPort, opts.dryRun)
}

async function installSwizMcpServerStep(args: string[], opts: InstallRunOptions): Promise<void> {
  if (!shouldInstallHooks(args, opts)) return
  const home = getHomeDirOrNull()
  if (!home) return
  const { updated, skipped } = await installSwizAsMcpServer(
    MCP_MANAGED_AGENT_IDS,
    home,
    false,
    opts.dryRun
  )
  if (updated.length === 0 && skipped.length === 0) return
  console.log(`  MCP server "swiz":`)
  for (const entry of updated) {
    console.log(`    ${GREEN}${opts.dryRun ? "+" : "✓"}${RESET} ${entry}`)
  }
  for (const entry of skipped) {
    console.log(`    ${DIM}· ${entry} (already registered)${RESET}`)
  }
  console.log()
}

async function uninstallSwizMcpServerStep(args: string[], opts: InstallRunOptions): Promise<void> {
  if (!isFullUninstall(opts) && !shouldInstallHooks(args, opts)) return
  const home = getHomeDirOrNull()
  if (!home) return
  const { removed } = await uninstallSwizAsMcpServer(
    MCP_MANAGED_AGENT_IDS,
    home,
    false,
    opts.dryRun
  )
  if (removed.length === 0) return
  console.log(`  MCP server "swiz":`)
  for (const entry of removed) {
    console.log(`    ${YELLOW}${opts.dryRun ? "-" : "✗"}${RESET} ${entry}`)
  }
  console.log()
}

async function runOptionalUninstallSteps(opts: InstallRunOptions): Promise<void> {
  const all = isFullUninstall(opts)
  // Tear down daemon first — it holds hot-reloaded hook modules in memory.
  if (all || opts.daemon) await uninstallDaemonForCli(opts.dryRun)
  if (all || opts.mergeTool) await uninstallMergeTool(opts.dryRun)
  if (all || opts.statusLine) await uninstallStatusLine(opts.dryRun)
}

function logPluginResults(
  pluginResults: Awaited<ReturnType<typeof loadAllPlugins>>,
  jsonOutput: boolean
): boolean {
  if (jsonOutput) {
    console.log(JSON.stringify(pluginResultsToJson(pluginResults), null, 2))
    return true
  }

  console.log(`  Plugins:`)
  for (const result of pluginResults) {
    if (result.errorCode) {
      console.log(`    ${YELLOW}⚠ ${result.name}${RESET} (${pluginErrorHint(result.errorCode)})`)
      continue
    }

    const hookCount = result.hooks.reduce((n, g) => n + g.hooks.length, 0)
    console.log(`    ${GREEN}✓${RESET} ${result.name} (${hookCount} hook(s))`)
  }
  console.log()
  return false
}

async function processPluginOutput(cwd: string, jsonOutput: boolean): Promise<boolean> {
  const projectSettings = await readProjectSettings(cwd)
  if (projectSettings?.plugins?.length) {
    const pluginResults = await loadAllPlugins(projectSettings.plugins, cwd)
    return logPluginResults(pluginResults, jsonOutput)
  }

  if (jsonOutput) {
    console.log("[]")
    return true
  }

  return false
}

async function installHooksForTargets(args: string[], opts: InstallRunOptions): Promise<boolean> {
  if (!shouldInstallHooks(args, opts)) return false

  console.log(`  Hooks: ${HOOKS_DIR}`)
  console.log(`  Agents: ${opts.targets.map((a) => a.name).join(", ")}\n`)

  const shouldReturn = await processPluginOutput(process.cwd(), opts.jsonOutput)
  if (shouldReturn) return true

  for (const agent of opts.targets) {
    await installAgent(agent, opts.dryRun)
  }
  return false
}

async function uninstallHooksForTargets(args: string[], opts: InstallRunOptions): Promise<void> {
  if (!isFullUninstall(opts) && !shouldInstallHooks(args, opts)) return

  console.log(`  Hooks: ${HOOKS_DIR}`)
  console.log(`  Agents: ${opts.targets.map((a) => a.name).join(", ")}\n`)

  await uninstallSwizFromAgents(opts.targets, opts.dryRun)
}

async function installProjectHooks(dryRun: boolean): Promise<void> {
  const settings = await readProjectSettings(process.cwd())
  if (!settings) return

  const requiredEvents = ["commitMsg", "preCommit", "prePush"]
  const existingEvents = new Set((settings.hooks ?? []).map((g) => g.event))
  const missingEvents = requiredEvents.filter((e) => !existingEvents.has(e))

  if (missingEvents.length === 0) {
    console.log(`  ${DIM}Project hooks: already configured in .swiz/config.json${RESET}\n`)
    return
  }

  if (dryRun) {
    console.log(
      `  ${GREEN}+ Project hooks: add ${missingEvents.join(", ")} to .swiz/config.json${RESET}\n`
    )
    return
  }

  const newHooks = [...(settings.hooks ?? [])]
  for (const event of missingEvents) {
    newHooks.push({ event, hooks: [] })
  }

  await writeProjectSettings(process.cwd(), { hooks: newHooks })
  console.log(
    `  ${GREEN}✓${RESET} Project hooks configured in .swiz/config.json (${missingEvents.join(", ")})\n`
  )
}

const VERIFY_CHECKS: DiagnosticCheck[] = [
  agentConfigSyncCheck,
  configScriptsCheck,
  scriptPermissionsCheck,
]

function printVerifyResult(result: CheckResult): void {
  const icon =
    result.status === "pass"
      ? `${GREEN}✓${RESET}`
      : result.status === "warn"
        ? `${YELLOW}!${RESET}`
        : `${RED}✗${RESET}`
  const detailColor = result.status === "fail" ? RED : result.status === "warn" ? YELLOW : DIM
  console.log(`    ${icon} ${BOLD}${result.name}${RESET}  ${detailColor}${result.detail}${RESET}`)
}

async function verifyInstallation(dryRun: boolean): Promise<void> {
  if (dryRun) return
  console.log(`  ${BOLD}Post-install verification:${RESET}`)
  const ctx: DiagnosticContext = { fix: false, store: {} }
  const results: CheckResult[] = []
  for (const check of VERIFY_CHECKS) {
    const r = await check.run(ctx)
    if (Array.isArray(r)) results.push(...r)
    else results.push(r)
  }
  for (const r of results) printVerifyResult(r)
  const failures = results.filter((r) => r.status === "fail").length
  const warnings = results.filter((r) => r.status === "warn").length
  const passes = results.filter((r) => r.status === "pass").length
  const summary =
    `${GREEN}${passes} passed${RESET}` +
    (warnings > 0 ? `, ${YELLOW}${warnings} warning(s)${RESET}` : "") +
    (failures > 0 ? `, ${RED}${failures} failure(s) — run: swiz doctor${RESET}` : "")
  console.log(`    ${summary}\n`)
}

async function uninstallProjectHooks(dryRun: boolean): Promise<void> {
  const settings = await readProjectSettings(process.cwd())
  if (!settings?.hooks?.length) return

  const managedEvents = new Set(["commitMsg", "preCommit", "prePush"])
  const pruned = settings.hooks.filter(
    (g) => !(managedEvents.has(g.event) && (!g.hooks || g.hooks.length === 0))
  )
  const removedCount = settings.hooks.length - pruned.length

  if (removedCount === 0) {
    console.log(`  ${DIM}Project hooks: no managed empty groups to remove${RESET}\n`)
    return
  }

  if (dryRun) {
    console.log(
      `  ${YELLOW}- Project hooks: remove ${removedCount} empty managed group(s) from .swiz/config.json${RESET}\n`
    )
    return
  }

  await writeProjectSettings(process.cwd(), { hooks: pruned })
  console.log(
    `  ${YELLOW}✗${RESET} Project hooks: removed ${removedCount} managed group(s) from .swiz/config.json\n`
  )
}

// ─── Entry Point ─────────────────────────────────────────────────────────────

export const installCommand: Command = {
  name: "install",
  description: "Install swiz hooks into agent settings",
  usage: `swiz install [${AGENTS.map((a) => `--${a.id}`).join("] [")}] [--dry-run] [--merge-tool] [--daemon [--port <n>]] [--uninstall]`,
  options: [
    ...AGENTS.map((a) => ({ flags: `--${a.id}`, description: `Install for ${a.name} only` })),
    { flags: "--dry-run", description: "Preview changes without writing to disk" },
    {
      flags: "--uninstall",
      description:
        "Remove all swiz integration (hooks, mergetool, status-line, daemon); add flags below to limit scope",
    },
    { flags: "--merge-tool", description: "Configure swiz as the global Git mergetool" },
    { flags: "--status-line", description: "Install swiz status-line into Claude Code settings" },
    { flags: "--daemon", description: "Install swiz daemon as a LaunchAgent (default port 7943)" },
    { flags: "--port <port>", description: "Port for daemon when using --daemon (default: 7943)" },
    { flags: "--json", description: "Output plugin status as JSON (implies --dry-run)" },
    { flags: "(no flags)", description: "Install for all detected agents" },
  ],
  async run(args) {
    const opts = parseInstallRunOptions(args)

    if (!checkBunAvailable()) {
      throw new Error(
        `\n  ${RED}✗ bun is not installed or not on PATH.${RESET}\n` +
          `  swiz hooks require bun to run. Install it first:\n\n` +
          `    curl -fsSL https://bun.sh/install | bash`
      )
    }

    if (opts.uninstall) {
      console.log(`\n  swiz install --uninstall${opts.dryRun ? " (dry run)" : ""}\n`)
      await runOptionalUninstallSteps(opts)
      await uninstallSwizMcpServerStep(args, opts)
      await uninstallHooksForTargets(args, opts)
      if (isFullUninstall(opts)) await uninstallProjectHooks(opts.dryRun)
      if (!opts.dryRun && isFullUninstall(opts)) await pauseSessionstartSelfHeal()
      if (opts.dryRun) {
        console.log("  No changes written.\n")
      }
      return
    }

    console.log(`\n  swiz install${opts.dryRun ? " (dry run)" : ""}\n`)
    await runOptionalInstallSteps(opts)
    await installProjectHooks(opts.dryRun)
    await installSwizMcpServerStep(args, opts)
    if (await installHooksForTargets(args, opts)) return
    if (opts.dryRun) {
      console.log("  No changes written.\n")
    } else if (shouldInstallHooks(args, opts)) {
      await verifyInstallation(opts.dryRun)
    }
  },
}
