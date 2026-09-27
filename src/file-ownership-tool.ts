import { statSync } from "node:fs"
import { isAbsolute, relative, resolve, sep } from "node:path"
import { z } from "zod"
import { getIssueStore, type IssueStore } from "./issue-store.ts"
import type { McpToolInput } from "./mcp-tool-core.ts"
import {
  LEGACY_EDIT_HISTORY_WARNING,
  resolveSessionEditPath,
  sessionEditProjectKeys,
} from "./session-edit-identity.ts"
import {
  canonicalClaimPath,
  fileClaimIdentity,
  fileClaimProjectKey,
} from "./session-file-claims.ts"
import { CONCURRENT_EDIT_WINDOW_MS } from "./utils/session-file-ownership.ts"

export const fileOwnershipInputSchema = {
  action: z
    .enum(["list", "claim", "hold", "release"])
    .optional()
    .describe(
      "Defaults to list. claim reserves files; hold renews existing owned leases; release frees them."
    ),
  sessionId: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe(
      "Your actual agent session ID, matching hook session_id. Required for mutations; never use a shared project ID."
    ),
  paths: z
    .array(z.string().min(1))
    .min(1)
    .max(100)
    .optional()
    .describe(
      "Exact file paths relative to the project or absolute within it. Literal brackets are supported; no globs. New or duplicate paths return warnings. Required for mutations; optional list filter."
    ),
  lane: z
    .string()
    .trim()
    .max(200)
    .optional()
    .describe("Short work-lane label, e.g. authentication. Retained when omitted on renewal."),
  leaseSeconds: z
    .number()
    .int()
    .min(60)
    .max(7200)
    .optional()
    .describe("Lease duration for claim/hold: 60–7200 seconds, default 1800. Renew before expiry."),
}

const claimSchema = z.object({
  project_key: z.string(),
  file_path: z.string(),
  session_id: z.string(),
  lane: z.string(),
  claimed_at: z.number(),
  updated_at: z.number(),
  expires_at: z.number(),
})

export const fileOwnershipResultSchema = z.object({
  action: z.enum(["list", "claim", "hold", "release"]),
  cwd: z.string(),
  sessionId: z.string().optional(),
  ok: z.boolean(),
  claims: z.array(claimSchema),
  conflicts: z.array(claimSchema),
  missing: z.array(z.string()),
  released: z.array(z.string()),
  nonexistentPaths: z.array(z.string()),
  duplicates: z.array(z.string()),
  recentEdits: z.array(
    z.object({ file_path: z.string(), session_id: z.string(), updated_at: z.number() })
  ),
  unresolvedEdits: z.array(z.object({ file_path: z.string(), error: z.string() })),
  historyWarnings: z.array(z.string()),
})
export type FileOwnershipResult = z.infer<typeof fileOwnershipResultSchema>
const inputSchema = z.strictObject(fileOwnershipInputSchema)
type OwnershipInput = z.infer<typeof inputSchema>

function isWithinProject(cwd: string, path: string): boolean {
  const rel = relative(cwd, path)
  return !!rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

function scopedPath(cwd: string, path: string): { path: string; exists: boolean } {
  if (!path.trim() || path.includes("\0") || /[*?]/.test(path)) {
    throw new Error("paths must name exact files, without globs or empty values")
  }
  const absolute = canonicalClaimPath(resolve(cwd, path))
  if (!isWithinProject(cwd, absolute)) {
    throw new Error(`File is outside the project directory: ${path}`)
  }
  try {
    if (statSync(absolute).isDirectory())
      throw new Error(`Expected a file, not a directory: ${path}`)
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") throw error
    return { path: absolute, exists: false }
  }
  return { path: absolute, exists: true }
}

function resolveOwnershipSelection(cwd: string, input: string[] | undefined) {
  const paths = new Map<string, string>()
  const nonexistentPaths: string[] = []
  const duplicates: string[] = []
  for (const raw of input ?? []) {
    const selected = scopedPath(cwd, raw)
    const identity = fileClaimIdentity(selected.path)
    if (paths.has(identity)) {
      duplicates.push(raw)
      continue
    }
    paths.set(identity, selected.path)
    if (!selected.exists) nonexistentPaths.push(selected.path)
  }
  return { paths: input ? [...paths.values()] : undefined, nonexistentPaths, duplicates }
}

function validateOwnershipInput(raw: McpToolInput): OwnershipInput {
  const input = inputSchema.parse(raw)
  const action = input.action ?? "list"
  if (action !== "list" && (!input.sessionId || !input.paths)) {
    throw new Error("sessionId and paths are required for claim, hold and release")
  }
  if (
    (action === "list" || action === "release") &&
    (input.leaseSeconds !== undefined || input.lane !== undefined)
  ) {
    throw new Error("lane and leaseSeconds apply only to claim and hold")
  }
  return input
}

function applyOwnershipAction(
  store: IssueStore,
  input: OwnershipInput,
  root: string,
  clock: () => number
) {
  const projectKey = fileClaimProjectKey(root)
  const action = input.action ?? "list"
  if (action === "list") {
    const selected = input.paths ? new Set(input.paths.map(fileClaimIdentity)) : undefined
    return {
      ok: true,
      claims: store.fileClaims
        .list(projectKey, clock())
        .filter((claim) => !selected || selected.has(fileClaimIdentity(claim.file_path))),
      conflicts: [],
      missing: [],
      released: [],
    }
  }
  return store.fileClaims.mutate({
    projectKey,
    sessionId: input.sessionId!,
    paths: input.paths!,
    action,
    lane: input.lane,
    leaseMs: (input.leaseSeconds ?? 1800) * 1000,
    clock,
  })
}

/** Historical paths may have become inaccessible; they cannot invalidate a live selection. */
function resolveRecentEdits(
  store: IssueStore,
  cwd: string,
  paths: string[] | undefined,
  now: number
) {
  const recentEdits = new Map<string, FileOwnershipResult["recentEdits"][number]>()
  const unresolvedEdits: FileOwnershipResult["unresolvedEdits"] = []
  const selected = paths ? new Set(paths.map(fileClaimIdentity)) : undefined
  const rows = sessionEditProjectKeys(cwd).flatMap((key) =>
    store.listOtherSessionEdits(key, "", now - CONCURRENT_EDIT_WINDOW_MS)
  )
  for (const edit of rows) {
    try {
      const path = resolveSessionEditPath(cwd, edit.file_path)
      if (!path || (selected && !selected.has(fileClaimIdentity(path)))) continue
      const key = `${edit.session_id}\0${path}`
      const previous = recentEdits.get(key)
      if (!previous || previous.updated_at < edit.updated_at)
        recentEdits.set(key, { ...edit, file_path: path })
    } catch (error) {
      const code = (error as { code?: string }).code
      unresolvedEdits.push({ file_path: edit.file_path, error: code ?? "Path resolution failed" })
    }
  }
  return {
    recentEdits: [...recentEdits.values()].sort(
      (a, b) =>
        b.updated_at - a.updated_at ||
        a.file_path.localeCompare(b.file_path) ||
        a.session_id.localeCompare(b.session_id)
    ),
    unresolvedEdits,
    historyWarnings: [LEGACY_EDIT_HISTORY_WARNING],
  }
}

/** Explicit leases and observed edits remain separate: release never erases attribution. */
export function manageFileOwnership(
  raw: McpToolInput,
  cwd: string,
  time: number | (() => number) = Date.now
): FileOwnershipResult {
  const clock = typeof time === "number" ? () => time : time
  const input = validateOwnershipInput(raw)
  const action = input.action ?? "list"
  if (!isAbsolute(cwd) || canonicalClaimPath(cwd) === sep)
    throw new Error("A resolved project directory is required")
  const root = canonicalClaimPath(cwd)
  if (!statSync(root).isDirectory()) throw new Error("Project directory does not exist")
  const { paths, ...diagnostics } = resolveOwnershipSelection(root, input.paths)
  const store = getIssueStore()
  if (store.isNoOp)
    throw new Error("Ownership store is unavailable; no files were claimed or released")
  // Resolve all read/validation work before mutating, so a failed call cannot hide a successful claim.
  const history = resolveRecentEdits(store, cwd, paths, clock())
  const result = applyOwnershipAction(store, { ...input, paths }, root, clock)
  return { action, cwd: root, sessionId: input.sessionId, ...result, ...history, ...diagnostics }
}

function renderOwnershipHistory(result: FileOwnershipResult): string[] {
  const lines = [...result.historyWarnings]
  if (result.recentEdits.length)
    lines.push(
      "Recent recorded edits (independent of leases):",
      ...result.recentEdits.map(
        (edit) =>
          `${relative(result.cwd, edit.file_path)} — ${edit.session_id}; ${new Date(edit.updated_at).toISOString()}`
      )
    )
  if (result.unresolvedEdits.length)
    lines.push(
      "Some recorded paths could not be resolved; history is incomplete:",
      ...result.unresolvedEdits.map(
        (edit) => `${relative(result.cwd, edit.file_path)} — ${edit.error}`
      )
    )
  return lines
}

function renderSelectionWarnings(result: FileOwnershipResult): string[] {
  const lines: string[] = []
  if (result.nonexistentPaths.length)
    lines.push(
      `Selected files do not exist yet; check the spelling: ${result.nonexistentPaths.map((path) => relative(result.cwd, path)).join(", ")}.`
    )
  if (result.duplicates.length)
    lines.push(`Duplicate paths ignored after normalisation: ${result.duplicates.join(", ")}.`)
  return lines
}

export function renderFileOwnership(result: FileOwnershipResult): string {
  const lines = [
    `FileOwnership ${result.action}: ${result.ok ? "ok" : "no changes; batch refused"}.`,
  ]
  for (const claim of result.claims) {
    lines.push(
      `${relative(result.cwd, claim.file_path)} — ${claim.session_id}${claim.lane ? ` (${claim.lane})` : ""}; held until ${new Date(claim.expires_at).toISOString()}`
    )
  }
  if (result.conflicts.length)
    lines.push(
      "Peer leases cannot be changed. Coordinate a release with the owner or retry after expiry."
    )
  if (result.missing.length)
    lines.push(
      `No active lease to renew: ${result.missing.map((path) => relative(result.cwd, path)).join(", ")}. Use claim to reacquire.`
    )
  if (result.action === "release")
    lines.push(`Released ${result.released.length} lease(s). Edit history is preserved.`)
  if (result.action === "list" && !result.claims.length)
    lines.push("No active leases for this selection.")
  lines.push(...renderSelectionWarnings(result), ...renderOwnershipHistory(result))
  return lines.join("\n")
}
