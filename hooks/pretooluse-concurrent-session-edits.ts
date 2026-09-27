#!/usr/bin/env bun

// PreToolUse hook: Flag files a concurrent agent session changed recently.
//
// Recent edits provide context; explicit peer leases prevent overlapping writes.

import { relative, resolve } from "node:path"
import {
  preToolUseAllowWithContext,
  preToolUseDeny,
  runSwizHookAsMain,
  type SwizHook,
  type SwizHookOutput,
} from "../src/SwizHook.ts"
import { type FileEditHookInput, fileEditHookInputSchema } from "../src/schemas.ts"
import { sessionEditProjectKeys } from "../src/session-edit-identity.ts"
import {
  canonicalClaimPath,
  fileClaimIdentity,
  fileClaimProjectKey,
} from "../src/session-file-claims.ts"
import { extractFileEditTargetPaths, isFileEditTool } from "../src/tool-matchers.ts"
import { buildConcurrentFileEditGuidance } from "../src/utils/concurrent-work-guidance.ts"
import { CONCURRENT_EDIT_WINDOW_MS } from "../src/utils/session-file-ownership.ts"

export { CONCURRENT_EDIT_WINDOW_MS } from "../src/utils/session-file-ownership.ts"

/** Render an absolute path relative to the project when it sits inside it. */
export function displayPathFor(cwd: string, filePath: string): string {
  if (!cwd) return filePath
  const rel = relative(cwd, filePath)
  return rel && !rel.startsWith("..") ? rel : filePath
}

export function formatConcurrentEditContext(displayPath: string, updatedAt: number): string {
  // A stable timestamp lets dispatch suppress the same overlap until a newer edit arrives.
  return buildConcurrentFileEditGuidance(displayPath, new Date(updatedAt).toISOString())
}

interface ConcurrentEditContext {
  cwd: string
  filePaths: string[]
  sessionId: string
}

function getConcurrentEditContext(input: FileEditHookInput): ConcurrentEditContext | null {
  const parsed = fileEditHookInputSchema.parse(input)
  if (!isFileEditTool(parsed.tool_name ?? "")) return null

  const cwd = parsed.cwd ?? ""
  const sessionId = parsed.session_id ?? ""
  const filePaths = extractFileEditTargetPaths(parsed.tool_input ?? {}).map((filePath) =>
    resolve(cwd, filePath)
  )
  if (filePaths.length === 0 || !cwd || !sessionId) return null
  return { cwd, filePaths, sessionId }
}

function findLatestConcurrentEdit(
  filePaths: string[],
  projectKeys: string[],
  sessionId: string,
  since: number,
  store: ReturnType<typeof import("../src/issue-store.ts").getIssueStore>
): { filePath: string; updatedAt: number } | undefined {
  const pendingOverlaps = filePaths.flatMap((filePath) => {
    const paths = [...new Set([filePath, canonicalClaimPath(filePath)])]
    const queries = projectKeys.flatMap((key) => paths.map((path) => ({ key, path })))
    const latest = queries
      .flatMap(({ key, path }) => store.listOtherSessionEditors(key, sessionId, path, since))
      .sort((a, b) => b.updated_at - a.updated_at)[0]
    if (!latest) return []
    const ownEditAt = Math.max(
      ...queries.map(
        ({ key, path }) => store.getSessionEditAt(key, sessionId, path) ?? Number.NEGATIVE_INFINITY
      )
    )
    if (ownEditAt >= latest.updated_at) return []
    return [{ filePath, updatedAt: latest.updated_at }]
  })
  pendingOverlaps.sort((a, b) => b.updatedAt - a.updatedAt)
  return pendingOverlaps[0]
}

export async function evaluatePretooluseConcurrentSessionEdits(
  input: FileEditHookInput,
  nowMs = Date.now()
): Promise<SwizHookOutput> {
  const editContext = getConcurrentEditContext(input)
  if (!editContext) return {}

  const { getIssueStore } = await import("../src/issue-store.ts")
  const projectKeys = sessionEditProjectKeys(editContext.cwd)

  const store = getIssueStore()
  if (store.isNoOp) return {}
  const peers = store.fileClaims
    .list(fileClaimProjectKey(editContext.cwd), nowMs)
    .filter((claim) => claim.session_id !== editContext.sessionId)
  let held = peers
  if (peers.length) {
    try {
      const targets = new Set(editContext.filePaths.map(fileClaimIdentity))
      held = peers.filter((claim) => targets.has(fileClaimIdentity(claim.file_path)))
    } catch {
      return preToolUseDeny(
        "File reservation identity could not be established. Inspect active FileOwnership leases before editing."
      )
    }
  }
  if (held.length) {
    return preToolUseDeny(
      [
        "These files have active reservations in another session:",
        ...held.map(
          (claim) =>
            `${displayPathFor(editContext.cwd, claim.file_path)} — ${claim.session_id}${claim.lane ? ` (${claim.lane})` : ""}; expires ${new Date(claim.expires_at).toISOString()}`
        ),
        "Continue in unclaimed files. Coordinate release with the owner, then use FileOwnership claim with your own sessionId before editing.",
      ].join("\n")
    )
  }
  const since = nowMs - CONCURRENT_EDIT_WINDOW_MS
  const latest = findLatestConcurrentEdit(
    editContext.filePaths,
    projectKeys,
    editContext.sessionId,
    since,
    store
  )
  if (!latest) return {}

  const context = formatConcurrentEditContext(
    displayPathFor(editContext.cwd, latest.filePath),
    latest.updatedAt
  )
  return preToolUseAllowWithContext("Concurrent work is normal — continue your task", context, {
    rephrase: false,
  })
}

const pretooluseConcurrentSessionEdits: SwizHook<FileEditHookInput> = {
  name: "pretooluse-concurrent-session-edits",
  event: "preToolUse",
  matcher: "Edit|Write",
  timeout: 5,

  run(input) {
    return evaluatePretooluseConcurrentSessionEdits(input)
  },
}

export default pretooluseConcurrentSessionEdits

if (import.meta.main) {
  await runSwizHookAsMain(pretooluseConcurrentSessionEdits)
}
