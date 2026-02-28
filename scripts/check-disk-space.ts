#!/usr/bin/env bun
// Preflight check: abort if less than 256 MB of free disk space.
// Used by lefthook pre-commit and pre-push to fail fast before
// ENOSPC conditions can masquerade as code regressions.

const MIN_MB = 256

const proc = Bun.spawnSync(["df", "-k", "."], { stdout: "pipe", stderr: "pipe" })
const output = new TextDecoder().decode(proc.stdout).trim()
const line = output.split("\n")[1]?.split(/\s+/)
const availKB = Number(line?.[3])

if (Number.isNaN(availKB)) {
  console.error("disk-space check: could not parse df output")
  process.exit(1)
}

const availMB = Math.floor(availKB / 1024)
if (availMB < MIN_MB) {
  console.error(
    `ERROR: Less than ${MIN_MB} MB free (${availMB} MB available). Free disk space before continuing.`
  )
  process.exit(1)
}
