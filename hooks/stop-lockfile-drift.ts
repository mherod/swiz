#!/usr/bin/env bun
// Stop hook: Block stop if package.json was modified but lockfile was not

import { dirname, join } from "node:path"
import { blockStop, git, isGitRepo, recentHeadRange } from "./hook-utils.ts"
import { stopHookInputSchema } from "./schemas.ts"

const LOCKFILE_MAP: Record<string, string> = {
  "pnpm-lock.yaml": "pnpm install",
  "shrinkwrap.yaml": "pnpm install",
  "yarn.lock": "yarn install",
  "package-lock.json": "npm install",
  "npm-shrinkwrap.json": "npm install",
}

async function main(): Promise<void> {
  const input = stopHookInputSchema.parse(await Bun.stdin.json())
  const cwd = input.cwd ?? process.cwd()
  const sessionId = input.session_id

  // Only block once per session
  if (sessionId) {
    const sentinel = `/tmp/stop-lockfile-drift-blocked-${sessionId}.flag`
    if (await Bun.file(sentinel).exists()) return
  }

  if (!(await isGitRepo(cwd))) return

  const range = await recentHeadRange(cwd, 10)

  const changedRaw = await git(["diff", "--name-only", range], cwd)
  if (!changedRaw) return

  const changedFiles = new Set(changedRaw.split("\n").filter((l) => l.trim()))

  // Find changed package.json files (not in node_modules)
  const changedPkgs = [...changedFiles].filter(
    (f) => f.endsWith("package.json") && !f.includes("node_modules")
  )

  if (changedPkgs.length === 0) return

  const drifted: string[] = []

  for (const pkgFile of changedPkgs) {
    const pkgDir = dirname(pkgFile)

    // Detect which lockfile should exist alongside this package.json
    let lockfile = ""
    let installCmd = ""
    for (const [lf, cmd] of Object.entries(LOCKFILE_MAP)) {
      const lfPath = pkgDir === "." ? lf : join(pkgDir, lf)
      if (await Bun.file(join(cwd, lfPath)).exists()) {
        lockfile = lfPath
        installCmd = cmd
        break
      }
    }
    if (!lockfile) continue

    // Check if lockfile was also changed
    if (changedFiles.has(lockfile)) continue

    // In monorepos, check if root lockfile covers this sub-package
    if (pkgDir !== ".") {
      let rootCovers = false
      for (const rootLf of Object.keys(LOCKFILE_MAP)) {
        if ((await Bun.file(join(cwd, rootLf)).exists()) && changedFiles.has(rootLf)) {
          rootCovers = true
          break
        }
      }
      if (rootCovers) continue
    }

    // Check if deps actually changed (not just scripts/version)
    const pkgDiff = await git(["diff", range, "--", pkgFile], cwd)
    if (!pkgDiff) continue

    const depsChanged = pkgDiff
      .split("\n")
      .some(
        (line) =>
          line.startsWith("+") &&
          !line.startsWith("+++") &&
          /(dependencies|devDependencies|peerDependencies|optionalDependencies)/.test(line)
      )
    const depLineAdded = pkgDiff
      .split("\n")
      .some(
        (line) =>
          line.startsWith("+") && !line.startsWith("+++") && /^\+\s+"[^"]+": "[^"]+"/.test(line)
      )

    if (depsChanged || depLineAdded) {
      drifted.push(`${pkgFile} (lockfile: ${lockfile}) — run: ${installCmd}`)
    }
  }

  if (drifted.length === 0) return

  // Mark as blocked for this session
  if (sessionId) {
    await Bun.write(`/tmp/stop-lockfile-drift-blocked-${sessionId}.flag`, "")
  }

  let reason = "Package dependency changes detected without lockfile updates.\n\n"
  reason += "Drifted packages:\n"
  for (const d of drifted) reason += `  ${d}\n`
  reason += "\nRun the install command to regenerate the lockfile, then commit it before stopping."

  // Dependency/lockfile consistency is a quality gate, not memory-capture enforcement.
  blockStop(reason, { includeUpdateMemoryAdvice: false })
}

main()
