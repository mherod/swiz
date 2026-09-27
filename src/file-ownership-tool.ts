import { statSync } from "node:fs"
import { isAbsolute, relative, resolve, sep } from "node:path"
import { z } from "zod"
import { getIssueStore, type IssueStore } from "./issue-store.ts"
import type { McpToolInput } from "./mcp-tool-core.ts"
import { projectKeyFromCwd } from "./project-key.ts"
import { canonicalClaimPath, fileClaimProjectKey } from "./session-file-claims.ts"
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
      "Exact file paths relative to the project or absolute within it. Required for mutations; optional list filter. No globs."
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
  recentEdits: z.array(
    z.object({ file_path: z.string(), session_id: z.string(), updated_at: z.number() })
  ),
})
export type FileOwnershipResult = z.infer<typeof fileOwnershipResultSchema>
const inputSchema = z.strictObject(fileOwnershipInputSchema)
type OwnershipInput = z.infer<typeof inputSchema>

function isWithinProject(cwd: string, path: string): boolean {
  const rel = relative(cwd, path)
  return !!rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

function scopedPath(cwd: string, path: string): string {
  if (!path.trim() || path.includes("\0") || /[*?[\]{}]/.test(path)) {
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
  }
  return absolute
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

function applyOwnershipAction(store: IssueStore, input: OwnershipInput, root: string, now: number) {
  const projectKey = fileClaimProjectKey(root)
  const action = input.action ?? "list"
  if (action === "list") {
    return {
      ok: true,
      claims: store.fileClaims
        .list(projectKey, now)
        .filter((claim) => !input.paths || input.paths.includes(claim.file_path)),
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
    now,
  })
}

/** Explicit leases and observed edits remain separate: release never erases attribution. */
export function manageFileOwnership(
  raw: McpToolInput,
  cwd: string,
  now = Date.now()
): FileOwnershipResult {
  const input = validateOwnershipInput(raw)
  const action = input.action ?? "list"
  if (!isAbsolute(cwd) || canonicalClaimPath(cwd) === sep)
    throw new Error("A resolved project directory is required")
  const root = canonicalClaimPath(cwd)
  if (!statSync(root).isDirectory()) throw new Error("Project directory does not exist")
  const paths = input.paths
    ? [...new Set(input.paths.map((path) => scopedPath(root, path)))]
    : undefined
  const store = getIssueStore()
  if (store.isNoOp)
    throw new Error("Ownership store is unavailable; no files were claimed or released")
  // Resolve all read/validation work before mutating, so a failed call cannot hide a successful claim.
  const recentEdits = store
    .listOtherSessionEdits(projectKeyFromCwd(cwd), "", now - CONCURRENT_EDIT_WINDOW_MS)
    .map((edit) => ({ ...edit, file_path: canonicalClaimPath(resolve(cwd, edit.file_path)) }))
    .filter((edit) => !paths || paths.includes(edit.file_path))
  const result = applyOwnershipAction(store, { ...input, paths }, root, now)
  return { action, cwd: root, sessionId: input.sessionId, ...result, recentEdits }
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
  if (result.recentEdits.length)
    lines.push(
      "Recent recorded edits (independent of leases):",
      ...result.recentEdits.map(
        (edit) =>
          `${relative(result.cwd, edit.file_path)} — ${edit.session_id}; ${new Date(edit.updated_at).toISOString()}`
      )
    )
  return lines.join("\n")
}
