import { join } from "node:path"
import { BOLD, DIM, GREEN, RED, RESET, YELLOW } from "../ansi.ts"
import { debugLog, stderrLog } from "../debug.ts"
import { SWIZ_ROOT } from "../swiz-hook-commands.ts"
import type { Command } from "../types.ts"
import { isDaemonReady } from "./daemon/daemon-admin.ts"
import { runDoctorChecks } from "./doctor/check-runner.ts"
import { DIAGNOSTIC_CHECKS } from "./doctor/checks"
import {
  findMissingConfigScriptPaths,
  fixMissingConfigScripts,
} from "./doctor/checks/shared-scripts.ts"
import { autoCleanup, runCleanupCommand } from "./doctor/cleanup.ts"
import {
  displayPath,
  fixInvalidSkillEntries,
  fixSkillConflicts,
  fixStalePluginCache,
  type InvalidSkillEntry,
  type PluginCacheInfo,
  SKILL_PLACEHOLDER_CATEGORY,
  type SkillConflict,
} from "./doctor/fix.ts"
import type { CheckResult } from "./doctor/types.ts"

export { checkAgentConfigSync } from "./doctor/checks/agent-config-sync.ts"
export { DEFAULT_ALLOWED_SKILL_CATEGORIES } from "./doctor/checks/invalid-skill-entries.ts"
export { truncateJsonlFile } from "./doctor/cleanup.ts"
export {
  type CleanupArgs,
  decodeProjectPath,
  parseCleanupArgs,
  walkDecode,
} from "./doctor/cleanup-path.ts"

const DOCTOR_CHECK_TIMEOUT_MS = 60_000
const AUTO_CLEANUP_TIMEOUT_MS = 75_000

class DoctorTimeoutError extends Error {
  constructor(label: string, timeoutMs: number) {
    super(`${label} timed out after ${timeoutMs}ms`)
    this.name = "DoctorTimeoutError"
  }
}

async function runWithTimeout<T>(
  label: string,
  timeoutMs: number,
  task: () => Promise<T>
): Promise<T> {
  const start = Date.now()
  debugLog("doctor", `Starting ${label} (timeout ${timeoutMs}ms)`)
  let timerId: ReturnType<typeof setTimeout> | undefined
  try {
    const timerPromise = new Promise<never>((_, reject) => {
      timerId = setTimeout(() => reject(new DoctorTimeoutError(label, timeoutMs)), timeoutMs)
    })
    const taskPromise = task()
    return await Promise.race([taskPromise, timerPromise])
  } finally {
    if (timerId) clearTimeout(timerId)
    const elapsed = Date.now() - start
    debugLog("doctor", `${label} finished after ${elapsed}ms`)
  }
}

// ─── Auto-fix logic ─────────────────────────────────────────────────────────

interface AutoFixContext {
  fix: boolean
  results: CheckResult[]
  skillConflicts: SkillConflict[]
  invalidSkillEntries: InvalidSkillEntry[]
  pluginCacheInfos: PluginCacheInfo[]
}

async function fixStaleConfigs(results: CheckResult[]): Promise<void> {
  const staleConfigs = results.filter(
    (r) =>
      r.name.endsWith("config sync") && r.status === "warn" && r.detail.includes("missing dispatch")
  )
  if (staleConfigs.length === 0) return
  console.log(`  ${BOLD}Auto-fixing stale configs...${RESET}\n`)
  const proc = Bun.spawn(["bun", "run", join(SWIZ_ROOT, "index.ts"), "install"], {
    stdout: "inherit",
    stderr: "inherit",
  })
  await proc.exited
  if (proc.exitCode === 0) {
    console.log(`  ${GREEN}✓ Configs updated successfully${RESET}\n`)
  } else {
    console.log(`  ${RED}✗ Install failed (exit ${proc.exitCode})${RESET}\n`)
  }
}

async function fixMissingConfigs(): Promise<void> {
  const missingConfigPaths = await findMissingConfigScriptPaths()
  if (missingConfigPaths.length === 0) return
  console.log(`  ${BOLD}Registering missing config scripts...${RESET}\n`)
  const regResult = await fixMissingConfigScripts(missingConfigPaths)
  for (const item of regResult.registered) {
    console.log(`  ${GREEN}✓${RESET} Registered stub: ${displayPath(item.path)}`)
  }
  for (const item of regResult.failed) {
    console.log(`  ${RED}✗${RESET} Failed to register ${displayPath(item.path)}: ${item.error}`)
  }
  if (regResult.registered.length > 0) console.log()
}

async function fixInvalidSkills(entries: InvalidSkillEntry[]): Promise<void> {
  if (entries.length === 0) return
  console.log(`  ${BOLD}Auto-fixing invalid skill entries...${RESET}\n`)
  const r = await fixInvalidSkillEntries(entries)
  for (const item of r.generated) {
    console.log(
      `  ${GREEN}✓${RESET} ${item.name}: generated default ${displayPath(item.skillPath)}`
    )
  }
  for (const item of r.nameFixed) {
    console.log(
      `  ${GREEN}✓${RESET} ${item.name}: updated name "${item.oldName}" → "${item.name}" in ${displayPath(item.skillPath)}`
    )
  }
  for (const item of r.categoryFixed) {
    console.log(
      `  ${GREEN}✓${RESET} ${item.name}: added category "${SKILL_PLACEHOLDER_CATEGORY}" to ${displayPath(item.skillPath)}`
    )
  }
  for (const item of r.failed) {
    console.log(
      `  ${RED}✗${RESET} ${item.name}: could not fix ${displayPath(item.originalDir)} (${item.error})`
    )
  }
  if (r.generated.length > 0 || r.nameFixed.length > 0 || r.categoryFixed.length > 0) {
    console.log()
  }
}

async function handleAutoFixes(ctx: AutoFixContext): Promise<void> {
  const { fix, results, skillConflicts, invalidSkillEntries, pluginCacheInfos } = ctx
  const hasStaleConfigs = results.some(
    (r) =>
      r.name.endsWith("config sync") && r.status === "warn" && r.detail.includes("missing dispatch")
  )
  if (fix) {
    await fixStaleConfigs(results)
    await fixMissingConfigs()
    const skillConflictMessages = await fixSkillConflicts(skillConflicts, fix)
    if (skillConflictMessages.length > 0) {
      console.log(`  ${BOLD}Skill conflicts detected${RESET}. Removing overridden versions...\n`)
      for (const message of skillConflictMessages) {
        console.log(`  ${GREEN}✓${RESET} ${message}`)
      }
      console.log()
    }
    await fixInvalidSkills(invalidSkillEntries)
    const pluginCacheMessages = await fixStalePluginCache(pluginCacheInfos)
    if (pluginCacheMessages.length > 0) {
      console.log(`  ${BOLD}Syncing plugin cache...${RESET}\n`)
      for (const message of pluginCacheMessages) {
        if (message.startsWith("Restart ")) {
          console.log(`  ${DIM}${message}${RESET}`)
        } else if (message.includes(": copied") || message.includes(": updated")) {
          console.log(`  ${GREEN}✓${RESET} ${message}`)
        } else {
          console.log(`  ${RED}✗${RESET} ${message}`)
        }
      }
      console.log()
    }
    try {
      await runWithTimeout("auto-cleanup", AUTO_CLEANUP_TIMEOUT_MS, autoCleanup)
    } catch (err) {
      const message =
        err instanceof DoctorTimeoutError
          ? `  ${YELLOW}Warning: auto-cleanup timed out after ${AUTO_CLEANUP_TIMEOUT_MS}ms${RESET}`
          : `  ${YELLOW}Warning: auto-cleanup failed: ${err}${RESET}`
      stderrLog("auto-cleanup", message)
    }
    return
  }
  if (hasStaleConfigs || invalidSkillEntries.length > 0 || pluginCacheInfos.length > 0) {
    const fixables = [
      hasStaleConfigs ? "stale configs" : null,
      invalidSkillEntries.length > 0 ? "invalid skill entries" : null,
      pluginCacheInfos.length > 0 ? "stale plugin cache" : null,
    ]
      .filter(Boolean)
      .join(" and ")
    console.log(`  ${YELLOW}${fixables} detected. Run: swiz doctor --fix${RESET}\n`)
  }
}

/** Best-effort daemon notification after fixing issues (similar to settings write). */
async function notifyDaemon(jsonOutput: boolean): Promise<void> {
  if (await isDaemonReady()) {
    if (!jsonOutput) console.log("  Daemon notified of changes.")
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── Command ────────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

export const doctorCommand: Command = {
  name: "doctor",
  description: "Check environment health, fix issues, and clean up old session data",
  usage: "swiz doctor [--fix] | swiz doctor clean [--older-than <time>] [--dry-run]",
  options: [
    { flags: "--fix", description: "Auto-fix stale agent configs by running swiz install" },
    {
      flags: "clean",
      description: "Remove old Claude Code session data and Gemini backup artifacts",
    },
    { flags: "--older-than <time>", description: "Cleanup window (e.g. 30, 7d, 48h)" },
    { flags: "--task-older-than <time>", description: "Separate window for task files" },
    { flags: "--project <name>", description: "Filter by project name or path" },
    { flags: "--dry-run", description: "Show what would be removed without trashing" },
    {
      flags: "--skip-trash",
      description: "Hard delete instead of moving to Trash (skips .bak backups)",
    },
  ],
  async run(args) {
    if (args[0] === "clean") {
      await runCleanupCommand(args.slice(1))
      return
    }
    await runWithTimeout("diagnostic checks", DOCTOR_CHECK_TIMEOUT_MS, () =>
      runDoctorChecks(args, {
        allChecks: DIAGNOSTIC_CHECKS,
        handleAutoFixes,
        notifyDaemon,
      })
    )
  },
}
