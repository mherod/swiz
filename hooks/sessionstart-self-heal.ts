#!/usr/bin/env bun
// SessionStart hook: Auto-reinstall swiz if the manifest has drifted since last install.

import { createHash } from "node:crypto"
import { mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { getHomeDir } from "../src/home.ts"
import type { SwizHook, SwizHookOutput } from "../src/SwizHook.ts"
import { buildContextHookOutput, runSwizHookAsMain } from "../src/SwizHook.ts"
import { isSessionstartSelfHealPaused } from "../src/sessionstart-self-heal-state.ts"
import { spawnWithTimeout } from "../src/utils/process-utils.ts"
import { sessionStartHookInputSchema } from "./schemas.ts"

const HASH_FILE = join(getHomeDir(), ".local", "share", "swiz", "manifest-hash")

async function computeManifestHash(swizRoot: string): Promise<string | null> {
  const manifestPath = join(swizRoot, "src", "manifest.ts")
  try {
    const content = await Bun.file(manifestPath).text()
    return createHash("sha256").update(content).digest("hex")
  } catch {
    return null
  }
}

async function readStoredHash(): Promise<string | null> {
  try {
    return (await Bun.file(HASH_FILE).text()).trim()
  } catch {
    return null
  }
}

async function writeHash(hash: string): Promise<void> {
  const dir = dirname(HASH_FILE)
  if (!(await Bun.file(dir).exists())) await mkdir(dir, { recursive: true })
  await Bun.write(HASH_FILE, hash)
}

const INSTALL_TIMEOUT_MS = 10_000

async function runInstall(swizRoot: string): Promise<boolean> {
  const args = ["bun", join(swizRoot, "index.ts"), "install"]

  if (process.env.GEMINI_CLI) {
    args.push("--gemini")
  } else if (process.env.CLAUDECODE) {
    args.push("--claude")
  }

  const result = await spawnWithTimeout(args, { cwd: swizRoot, timeoutMs: INSTALL_TIMEOUT_MS })
  return !result.timedOut && result.exitCode === 0
}

/**
 * Check whether settings.json has all expected swiz dispatch entries.
 * Returns the list of missing canonical event names, or empty if all present.
 */
async function findMissingDispatchEntries(): Promise<string[]> {
  const settingsPath = join(getHomeDir(), ".claude", "settings.json")
  try {
    const settings = (await Bun.file(settingsPath).json()) as Record<string, unknown>
    const hooks = ((settings.hooks as Record<string, unknown>) ?? {}) as Record<string, unknown>
    const dispatchRe = /swiz dispatch (\S+)/
    const installed = new Set<string>()

    for (const [, groups] of Object.entries(hooks)) {
      if (!Array.isArray(groups)) continue
      for (const group of groups) {
        const hookList = (group as Record<string, unknown>).hooks
        if (!Array.isArray(hookList)) continue
        for (const hook of hookList) {
          const cmd = (hook as Record<string, unknown>).command
          if (typeof cmd !== "string") continue
          const m = dispatchRe.exec(cmd)
          if (m?.[1]) installed.add(m[1])
        }
      }
    }

    // Scheduled events (preCommit, commitMsg, prePush, prPoll) use lefthook, not settings.json
    const { manifest } = await import("../src/manifest.ts")
    const missing: string[] = []
    for (const group of manifest) {
      if (group.scheduled) continue
      if (!installed.has(group.event)) missing.push(group.event)
    }
    return missing
  } catch {
    // Can't read settings — assume missing
    return ["unknown"]
  }
}

export async function evaluateSessionstartSelfHeal(input: unknown): Promise<SwizHookOutput> {
  sessionStartHookInputSchema.parse(input)

  if (await isSessionstartSelfHealPaused()) return {}

  const swizRoot = dirname(dirname(import.meta.path))
  const currentHash = await computeManifestHash(swizRoot)
  if (!currentHash) return {}

  const storedHash = await readStoredHash()
  const manifestChanged = storedHash !== currentHash

  // Check if dispatch entries are missing from settings.json even when manifest hasn't changed.
  // Claude Code can overwrite settings.json, removing swiz entries without changing the manifest.
  const missingEntries = manifestChanged ? [] : await findMissingDispatchEntries()
  const needsInstall = manifestChanged || missingEntries.length > 0

  if (!needsInstall) return {}

  const installed = await runInstall(swizRoot)
  if (!installed) return {}

  await writeHash(currentHash)

  const reason = manifestChanged
    ? "manifest changed"
    : `${missingEntries.length} missing dispatch entries (${missingEntries.join(", ")})`
  const message =
    storedHash === null
      ? "swiz install: initial agent config written."
      : `swiz self-healed: ${reason}, agent configs updated.`

  return buildContextHookOutput("SessionStart", message)
}

const sessionstartSelfHeal: SwizHook<Record<string, any>> = {
  name: "sessionstart-self-heal",
  event: "sessionStart",
  matcher: "startup",
  timeout: 15,
  run(input) {
    return evaluateSessionstartSelfHeal(input)
  },
}

export default sessionstartSelfHeal

if (import.meta.main) {
  await runSwizHookAsMain(sessionstartSelfHeal)
}
