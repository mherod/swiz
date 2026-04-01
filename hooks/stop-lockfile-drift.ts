#!/usr/bin/env bun
// Stop hook: Block stop if package.json was modified but lockfile was not
//
// Dual-mode: SwizStopHook for inline dispatch + subprocess via runSwizHookAsMain.

import { dirname, join } from "node:path"
import { isNodeModulesPath } from "../src/node-modules-path.ts"
import { runSwizHookAsMain } from "../src/RunSwizHookAsMain.ts"
import type { SwizHookOutput, SwizStopHook } from "../src/SwizHook.ts"
import { stopLockfileDriftBlockedFlagPath } from "../src/temp-paths.ts"
import { blockStopObj, git, isGitRepo, recentHeadRange } from "../src/utils/hook-utils.ts"
import { type StopHookInput, stopHookInputSchema } from "./schemas.ts"

const LOCKFILE_MAP: Record<string, string> = {
  "pnpm-lock.yaml": "pnpm install",
  "shrinkwrap.yaml": "pnpm install",
  "yarn.lock": "yarn install",
  "package-lock.json": "npm install",
  "npm-shrinkwrap.json": "npm install",
}

interface LockfileInfo {
  lockfile: string
  installCmd: string
}

async function detectLockfile(cwd: string, pkgDir: string): Promise<LockfileInfo | null> {
  for (const [lf, cmd] of Object.entries(LOCKFILE_MAP)) {
    const lfPath = pkgDir === "." ? lf : join(pkgDir, lf)
    if (await Bun.file(join(cwd, lfPath)).exists()) {
      return { lockfile: lfPath, installCmd: cmd }
    }
  }
  return null
}

async function rootLockfileCovers(cwd: string, changedFiles: Set<string>): Promise<boolean> {
  for (const rootLf of Object.keys(LOCKFILE_MAP)) {
    if ((await Bun.file(join(cwd, rootLf)).exists()) && changedFiles.has(rootLf)) {
      return true
    }
  }
  return false
}

function depsActuallyChanged(pkgDiff: string): boolean {
  const lines = pkgDiff.split("\n")
  const depsChanged = lines.some(
    (line) =>
      line.startsWith("+") &&
      !line.startsWith("+++") &&
      /(dependencies|devDependencies|peerDependencies|optionalDependencies)/.test(line)
  )
  const depLineAdded = lines.some(
    (line) => line.startsWith("+") && !line.startsWith("+++") && /^\+\s+"[^"]+": "[^"]+"/.test(line)
  )
  return depsChanged || depLineAdded
}

async function findDriftedPackages(
  cwd: string,
  changedFiles: Set<string>,
  changedPkgs: string[],
  range: string
): Promise<string[]> {
  const drifted: string[] = []

  for (const pkgFile of changedPkgs) {
    const pkgDir = dirname(pkgFile)

    const lockfileInfo = await detectLockfile(cwd, pkgDir)
    if (!lockfileInfo) continue
    const { lockfile, installCmd } = lockfileInfo

    if (changedFiles.has(lockfile)) continue

    if (pkgDir !== "." && (await rootLockfileCovers(cwd, changedFiles))) continue

    const pkgDiff = await git(["diff", range, "--", pkgFile], cwd)
    if (!pkgDiff) continue

    if (depsActuallyChanged(pkgDiff)) {
      drifted.push(`${pkgFile} (lockfile: ${lockfile}) — run: ${installCmd}`)
    }
  }

  return drifted
}

export async function evaluateStopLockfileDrift(input: StopHookInput): Promise<SwizHookOutput> {
  const parsed = stopHookInputSchema.parse(input)
  const cwd = parsed.cwd ?? process.cwd()
  const sessionId = parsed.session_id

  if (sessionId) {
    const sentinel = stopLockfileDriftBlockedFlagPath(sessionId)
    if (await Bun.file(sentinel).exists()) return {}
  }

  if (!(await isGitRepo(cwd))) return {}

  const range = await recentHeadRange(cwd, 10)

  const changedRaw = await git(["diff", "--name-only", range], cwd)
  if (!changedRaw) return {}

  const changedFiles = new Set(changedRaw.split("\n").filter((l) => l.trim()))

  const changedPkgs = [...changedFiles].filter(
    (f) => f.endsWith("package.json") && !isNodeModulesPath(f)
  )

  if (changedPkgs.length === 0) return {}

  const drifted = await findDriftedPackages(cwd, changedFiles, changedPkgs, range)

  if (drifted.length === 0) return {}

  if (sessionId) {
    await Bun.write(stopLockfileDriftBlockedFlagPath(sessionId), "")
  }

  let reason = "Package dependency changes detected without lockfile updates.\n\n"
  reason += "Drifted packages:\n"
  for (const d of drifted) reason += `  ${d}\n`
  reason += "\nRun the install command to regenerate the lockfile, then commit it before stopping."

  return blockStopObj(reason)
}

const stopLockfileDrift: SwizStopHook = {
  name: "stop-lockfile-drift",
  event: "stop",
  timeout: 10,

  run(input) {
    return evaluateStopLockfileDrift(input)
  },
}

export default stopLockfileDrift

if (import.meta.main) {
  await runSwizHookAsMain(stopLockfileDrift)
}
