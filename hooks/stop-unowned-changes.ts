#!/usr/bin/env bun

/**
 * Stop hook: block stop while uncommitted files in the project directory have
 * no owning session.
 *
 * A file is owned when this or another live session has a recorded edit or an
 * active FileOwnership lease for it. Anything else is ambiguous: nobody is
 * accountable for committing it. The agent must resolve each such file
 * explicitly — `claim` it (then commit it) or `disown` it (leave it for its
 * owner). Discovery failures fail open: an unknown ownership state is not
 * evidence against the agent.
 *
 * Dual-mode: SwizStopHook for inline dispatch + subprocess via runSwizHookAsMain.
 */

import { git } from "../src/git-helpers.ts"
import type { SwizHookOutput, SwizStopHook } from "../src/SwizHook.ts"
import { runSwizHookAsMain } from "../src/SwizHook.ts"
import type { StopHookInput } from "../src/schemas.ts"
import { stopHookInputSchema } from "../src/schemas.ts"
import { blockStopObj } from "../src/utils/hook-response.ts"
import { applyDisowns, readDisownedPaths } from "../src/utils/session-file-disowns.ts"
import { resolveSessionFileOwnershipResult } from "../src/utils/session-file-ownership.ts"

const MAX_LISTED_FILES = 30

/**
 * Dirty files under `cwd`, relative to the repository root, with untracked
 * directories expanded to their files (leases and disowns name files).
 */
export function parseDirtyFiles(porcelainZ: string): string[] {
  const fields = porcelainZ.split("\0")
  const files: string[] = []
  for (let index = 0; index < fields.length; index++) {
    const entry = fields[index]!
    if (entry.startsWith("? ")) files.push(entry.slice(2))
    else if (entry.startsWith("1 ")) files.push(entry.split(" ").slice(8).join(" "))
    else if (entry.startsWith("u ")) files.push(entry.split(" ").slice(10).join(" "))
    else if (entry.startsWith("2 ")) {
      files.push(entry.split(" ").slice(9).join(" "))
      index++ // The next field is the rename source path.
    }
  }
  return files.filter(Boolean)
}

export function buildUnownedChangesReason(files: readonly string[], sessionId: string): string {
  const listed = files.slice(0, MAX_LISTED_FILES).map((file) => `  - ${file}`)
  if (files.length > MAX_LISTED_FILES) {
    listed.push(`  ... and ${files.length - MAX_LISTED_FILES} more file(s)`)
  }
  const paths = JSON.stringify(files.slice(0, MAX_LISTED_FILES))
  return [
    `Uncommitted changes in this project have no owning session (${files.length} file(s)):`,
    ...listed,
    "",
    "No session has a recorded edit or an active lease for these files, so nobody is accountable for committing them.",
    "Resolve every file explicitly with the FileOwnership tool before stopping:",
    `  - Yours: FileOwnership { action: "claim", sessionId: "${sessionId}", paths: [...] }, then commit them.`,
    `  - Not yours: FileOwnership { action: "disown", sessionId: "${sessionId}", paths: [...] }, and leave them uncommitted for their owner.`,
    `Listed paths: ${paths}`,
    "Inspect each file (git diff -- <path>) before deciding. Do not stage, revert or delete a file you have not claimed.",
  ].join("\n")
}

export async function evaluateStopUnownedChanges(input: StopHookInput): Promise<SwizHookOutput> {
  const parsed = stopHookInputSchema.parse(input)
  const cwd = parsed.cwd
  const sessionId = parsed.session_id
  if (!cwd || !sessionId) return {}

  const gitRoot = (await git(["rev-parse", "--show-toplevel"], cwd)).trim()
  if (!gitRoot) return {}
  const status = await git(
    ["--no-optional-locks", "status", "--porcelain=v2", "-z", "--untracked-files=all", "--", "."],
    cwd
  )
  const files = parseDirtyFiles(status)
  if (files.length === 0) return {}

  const result = await resolveSessionFileOwnershipResult(cwd, sessionId, files)
  if (!result.known) return {}
  const ownership = await applyDisowns(result.ownership, {
    gitRoot,
    disowned: await readDisownedPaths(parsed.transcript_path, cwd),
  })
  if (ownership.unattributed.length === 0) return {}
  return blockStopObj(buildUnownedChangesReason(ownership.unattributed, sessionId))
}

const stopUnownedChanges: SwizStopHook = {
  name: "stop-unowned-changes",
  event: "stop",
  timeout: 10,

  run(input) {
    return evaluateStopUnownedChanges(input)
  },
}

export default stopUnownedChanges

if (import.meta.main) {
  await runSwizHookAsMain(stopUnownedChanges)
}
