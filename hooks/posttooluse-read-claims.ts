#!/usr/bin/env bun

/**
 * When the agent reads a file that has uncommitted changes but no owner (no live edit record from
 * any session and no FileOwnership claim), claim it for the reading session. Reading dirty,
 * unattributed work is the strongest available signal that this session is picking it up; an
 * explicit claim lets ownership-aware gates attribute it instead of reporting it as unknown.
 *
 * Positive evidence only: files another session edited or claimed, files this session disowned,
 * and clean files are never claimed.
 */

import { relative, resolve } from "node:path"
import { git } from "../src/git-helpers.ts"
import {
  buildContextHookOutput,
  runSwizHookAsMain,
  type SwizHook,
  type SwizHookOutput,
} from "../src/SwizHook.ts"
import type { PostToolHookInput } from "../src/schemas.ts"
import { canonicalClaimPath, fileClaimProjectKey } from "../src/session-file-claims.ts"
import { getFileReadTargets } from "../src/tool-matchers.ts"
import { readDisownedPaths } from "../src/utils/session-file-disowns.ts"
import { resolveSessionFileOwnershipResult } from "../src/utils/session-file-ownership.ts"

/** Same lease the FileOwnership tool grants by default. */
export const READ_CLAIM_LEASE_MS = 30 * 60_000
export const READ_CLAIM_LANE = "read"

/** Canonical absolute paths with uncommitted changes (modified, staged or untracked). */
export async function dirtyPaths(cwd: string, paths: string[]): Promise<string[]> {
  if (paths.length === 0) return []
  const root = (await git(["rev-parse", "--show-toplevel"], cwd)).trim()
  if (!root) return []
  const pathspec = ["--", ...paths.map((path) => relative(root, path))]
  // Name-only lists, not porcelain status: `git()` trims output, which would eat the
  // significant leading space of an unstaged ` M path` entry.
  const lists = await Promise.all([
    git(["diff", "--name-only", "-z", ...pathspec], root),
    git(["diff", "--cached", "--name-only", "-z", ...pathspec], root),
    git(["ls-files", "--others", "--exclude-standard", "-z", ...pathspec], root),
  ])
  const dirty = new Set(
    lists
      .flatMap((list) => list.split("\0"))
      .filter(Boolean)
      .map((file) => canonicalClaimPath(resolve(root, file)))
  )
  return paths.filter((path) => dirty.has(path))
}

async function unownedDirtyReads(input: PostToolHookInput, cwd: string, sessionId: string) {
  const targets = getFileReadTargets(input.tool_name, input.tool_input ?? {})
  if (targets.length === 0) return []
  const absolute = [...new Set(targets.map((path) => canonicalClaimPath(resolve(cwd, path))))]
  const dirty = await dirtyPaths(cwd, absolute)
  if (dirty.length === 0) return []
  const result = await resolveSessionFileOwnershipResult(cwd, sessionId, dirty)
  if (!result.known) return []
  const disowned = await readDisownedPaths(input.transcript_path, cwd)
  return result.ownership.unattributed.filter((path) => !disowned.has(path))
}

export async function evaluatePosttooluseReadClaims(
  input: PostToolHookInput
): Promise<SwizHookOutput> {
  const sessionId = input.session_id
  if (!sessionId) return {}
  const cwd = input.cwd ?? process.cwd()
  try {
    const unowned = await unownedDirtyReads(input, cwd, sessionId)
    if (unowned.length === 0) return {}
    const { getIssueStore } = await import("../src/issue-store.ts")
    const store = getIssueStore()
    if (store.isNoOp) return {}
    const projectKey = fileClaimProjectKey(cwd)
    // One mutation per path: a peer claiming one file in the meantime must not void the rest.
    const claimed = unowned.filter(
      (path) =>
        store.fileClaims.mutate({
          projectKey,
          sessionId,
          paths: [path],
          action: "claim",
          leaseMs: READ_CLAIM_LEASE_MS,
          lane: READ_CLAIM_LANE,
        }).ok
    )
    if (claimed.length === 0) return {}
    const list = claimed.map((path) => relative(cwd, path)).join(", ")
    return buildContextHookOutput(
      "PostToolUse",
      `Claimed ${claimed.length} unowned file(s) with uncommitted changes that this session just read: ${list}. Release with FileOwnership action "release" if this work belongs to someone else.`,
      { rephrase: false }
    )
  } catch {
    return {}
  }
}

const hook: SwizHook<PostToolHookInput> = {
  name: "posttooluse-read-claims",
  event: "postToolUse",
  timeout: 10,
  // Writes FileOwnership claims that ownership-aware gates read.
  sideEffect: true,
  run: evaluatePosttooluseReadClaims,
}

export default hook
if (import.meta.main) await runSwizHookAsMain(hook)
