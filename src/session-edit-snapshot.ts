import { resolve } from "node:path"
import { getGitClient } from "./git/client.ts"
import type { PostToolHookInput, ToolHookInput } from "./schemas.ts"
import { resolveSessionEditPath } from "./session-edit-identity.ts"
import type { FileSnapshot } from "./session-edit-observations.ts"
import { canonicalClaimPath, fileClaimProjectKey } from "./session-file-claims.ts"
import { extractFileEditTargetPaths, isFileEditTool, isShellTool } from "./tool-matchers.ts"

export const SESSION_EDIT_OBSERVATION_MATCHER =
  "Edit|Write|NotebookEdit|Bash|exec|functions.exec|wait|functions.wait|write_stdin|functions.write_stdin"

export interface EditObservationIdentity {
  cwd: string
  project: string
  session: string
  tool: string
}

export function editObservationIdentity(input: ToolHookInput): EditObservationIdentity | null {
  const { cwd, session_id: session } = input
  const tool = input.tool_use_id ?? input.call_id
  if (!cwd || !session || typeof tool !== "string" || !tool.trim()) return null
  return { cwd, session, tool, project: fileClaimProjectKey(cwd) }
}

export function failedEditResponse(input: PostToolHookInput): boolean {
  if (input.hook_event_name === "PostToolUseFailure") return true
  const response = input.tool_response
  if (!response || typeof response !== "object" || Array.isArray(response)) return false
  return (
    response.isError === true ||
    response.is_error === true ||
    (typeof response.exit_code === "number" && response.exit_code !== 0)
  )
}

export function isObservedEditTool(name: string): boolean {
  return (
    isFileEditTool(name) ||
    isShellTool(name) ||
    SESSION_EDIT_OBSERVATION_MATCHER.split("|").includes(name)
  )
}

export function editContinuationInput(input: ToolHookInput): string | null {
  const args = input.tool_input
  if (!args || typeof args !== "object") return null
  if (typeof args.cell_id === "string") return `cell:${args.cell_id}`
  if ((input.tool_name ?? "").endsWith("write_stdin") && typeof args.session_id === "number")
    return `process:${args.session_id}`
  return null
}

export function editContinuationOutput(
  response: PostToolHookInput["tool_response"]
): string | null {
  if (typeof response === "string") {
    const cell = /Script running with cell ID ([\w-]+)/.exec(response)?.[1]
    return cell ? `cell:${cell}` : null
  }
  if (!response || typeof response !== "object" || Array.isArray(response)) return null
  if (typeof response.session_id === "number" && response.exit_code == null)
    return `process:${response.session_id}`
  return typeof response.cell_id === "string" ? `cell:${response.cell_id}` : null
}

export function explicitEditTargets(input: ToolHookInput): string[] {
  if (!isFileEditTool(input.tool_name ?? "")) return []
  return extractFileEditTargetPaths(input.tool_input ?? {})
}

function checkDeadline(deadline: number): void {
  if (performance.now() > deadline) throw new Error("File observation timed out")
}

async function fingerprintFile(path: string, deadline: number): Promise<string | null> {
  try {
    const file = Bun.file(path)
    const stat = await file.stat()
    if (!stat.isFile()) return null
    if (stat.size > 64 * 1024 * 1024) throw new Error("File exceeds observation size limit")
    const hash = new Bun.CryptoHasher("sha256")
    const reader = file.stream().getReader()
    try {
      for (;;) {
        checkDeadline(deadline)
        const { done, value } = await reader.read()
        if (done) break
        hash.update(value)
      }
    } finally {
      await reader.cancel()
      reader.releaseLock()
    }
    const finalStat = await Bun.file(path).stat()
    if (stat.mtimeMs !== finalStat.mtimeMs || stat.size !== finalStat.size)
      throw new Error("File changed while capturing observation")
    return `${stat.mode}:${hash.digest("hex")}`
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") throw error
    return null
  }
}

/** A whole-worktree snapshot catches dynamic scripts without interpreting or executing them. */
export async function captureEditSnapshot(
  cwd: string,
  extraPaths: string[] = []
): Promise<FileSnapshot> {
  const root = canonicalClaimPath(cwd)
  const listing = await getGitClient().run(
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: root }
  )
  if (listing.exitCode !== 0) throw new Error("Cannot enumerate worktree files")
  const paths = [...new Set([...listing.stdout.split("\0").filter(Boolean), ...extraPaths])]
  if (paths.length > 100_000) throw new Error("Worktree exceeds observation file limit")
  const snapshot: FileSnapshot = Object.create(null)
  const deadline = performance.now() + 5_000
  let next = 0
  const results = await Promise.allSettled(
    Array.from({ length: 16 }, async () => {
      while (next < paths.length) {
        const relative = paths[next++]!
        checkDeadline(deadline)
        const path = resolveSessionEditPath(root, resolve(root, relative))
        if (!path) continue
        snapshot[path] = await fingerprintFile(path, deadline)
      }
    })
  )
  const failed = results.find((result) => result.status === "rejected")
  if (failed?.status === "rejected") throw failed.reason
  return snapshot
}
