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

export async function evaluateSessionstartSelfHeal(input: unknown): Promise<SwizHookOutput> {
  sessionStartHookInputSchema.parse(input)

  if (await isSessionstartSelfHealPaused()) return {}

  const swizRoot = dirname(dirname(import.meta.path))
  const currentHash = await computeManifestHash(swizRoot)
  if (!currentHash) return {}

  const storedHash = await readStoredHash()

  if (storedHash === currentHash) return {}

  const installed = await runInstall(swizRoot)
  if (!installed) return {}

  await writeHash(currentHash)

  const isFirstInstall = storedHash === null
  const message = isFirstInstall
    ? "swiz install: initial agent config written."
    : "swiz self-healed: manifest changed, agent configs updated."

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
