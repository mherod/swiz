#!/usr/bin/env bun
// SessionStart hook: Auto-reinstall swiz if the manifest has drifted since last install.
// Detects manifest changes by comparing a hash of src/manifest.ts to a stored hash.
// Runs at startup so agents always get up-to-date hook configurations.

import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { emitContext } from "./hook-utils.ts"

const HASH_FILE = join(process.env.HOME ?? "~", ".local", "share", "swiz", "manifest-hash")

function computeManifestHash(swizRoot: string): string | null {
  const manifestPath = join(swizRoot, "src", "manifest.ts")
  try {
    const content = readFileSync(manifestPath, "utf-8")
    return createHash("sha256").update(content).digest("hex")
  } catch {
    return null
  }
}

function readStoredHash(): string | null {
  try {
    return readFileSync(HASH_FILE, "utf-8").trim()
  } catch {
    return null
  }
}

function writeHash(hash: string): void {
  const dir = dirname(HASH_FILE)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(HASH_FILE, hash, "utf-8")
}

async function runInstall(swizRoot: string): Promise<boolean> {
  const args = ["bun", join(swizRoot, "index.ts"), "install"]

  if (process.env.GEMINI_CLI) {
    args.push("--gemini")
  } else if (process.env.CLAUDECODE) {
    args.push("--claude")
  } else if (process.env.SHELL?.includes("cursor") || process.env.TERM_PROGRAM === "Cursor") {
    // For Cursor, we usually install globally, but can target if needed.
    // By default, if no flag is specified, swiz install installs for all detected agents.
  }

  const proc = Bun.spawn(args, {
    cwd: swizRoot,
    stdout: "pipe",
    stderr: "pipe",
  })
  await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  await proc.exited
  return proc.exitCode === 0
}

async function main(): Promise<void> {
  await Bun.stdin.json() // consume stdin (required by hook protocol)

  // Resolve swiz root from the hook file location
  const swizRoot = dirname(dirname(import.meta.path))
  const currentHash = computeManifestHash(swizRoot)
  if (!currentHash) return

  const storedHash = readStoredHash()

  if (storedHash === currentHash) return

  // Manifest has changed — reinstall to sync agent configs
  const installed = await runInstall(swizRoot)
  if (!installed) return

  // Update stored hash so we don't reinstall again next session
  writeHash(currentHash)

  const isFirstInstall = storedHash === null
  const message = isFirstInstall
    ? "swiz install: initial agent config written."
    : "swiz self-healed: manifest changed, agent configs updated."

  emitContext("SessionStart", message)
}

main()
