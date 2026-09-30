import { resolve } from "node:path"
import { canonicalClaimPath } from "../session-file-claims.ts"
import type { SessionFileOwnership } from "./session-file-ownership.ts"

/**
 * Explicit disowns are statements a session makes about authorship
 * (`FileOwnership` with `action: "disown"`). They take no lease, so the
 * session's own transcript is the record: another session never inherits them.
 */
export async function readDisownedPaths(
  transcriptPath: string | undefined,
  cwd: string
): Promise<Set<string>> {
  const disowned = new Set<string>()
  if (!transcriptPath) return disowned
  let text: string
  try {
    text = await Bun.file(transcriptPath).text()
  } catch {
    return disowned
  }
  for (const line of text.split("\n")) {
    if (!line.includes("FileOwnership") || !line.includes("disown")) continue
    for (const path of disownPathsInLine(line)) {
      try {
        disowned.add(canonicalClaimPath(resolve(cwd, path)))
      } catch {}
    }
  }
  return disowned
}

interface ToolUseBlock {
  type?: unknown
  name?: unknown
  input?: { action?: unknown; paths?: unknown }
}

function isDisownCall(block: ToolUseBlock): boolean {
  return (
    block?.type === "tool_use" &&
    typeof block.name === "string" &&
    block.name.endsWith("FileOwnership") &&
    block.input?.action === "disown"
  )
}

/** Paths named by FileOwnership disown calls in one transcript line. */
function disownPathsInLine(line: string): string[] {
  let content: unknown
  try {
    content = JSON.parse(line)?.message?.content
  } catch {
    return []
  }
  if (!Array.isArray(content)) return []
  return (content as ToolUseBlock[])
    .filter(isDisownCall)
    .flatMap((block) => (Array.isArray(block.input?.paths) ? block.input.paths : []))
    .filter((path): path is string => typeof path === "string" && !!path.trim())
}

interface ApplyDisownsOptions {
  gitRoot: string
  disowned: ReadonlySet<string>
  /** Lists the files inside an untracked directory entry such as `newdir/`. */
  expandDirectory?: (dir: string) => Promise<string[]>
}

async function isDisowned(file: string, options: ApplyDisownsOptions): Promise<boolean> {
  if (!file.endsWith("/")) {
    try {
      return options.disowned.has(canonicalClaimPath(resolve(options.gitRoot, file)))
    } catch {
      return false
    }
  }
  const files = (await options.expandDirectory?.(file)) ?? []
  if (files.length === 0) return false
  for (const child of files) if (!(await isDisowned(child, options))) return false
  return true
}

/**
 * Move unattributed files this session disowned into `editedByOthers`, so
 * stop gates leave them uncommitted for their owner. Positive attribution
 * (own edits or leases) always outranks a disown.
 */
export async function applyDisowns(
  ownership: SessionFileOwnership,
  options: ApplyDisownsOptions
): Promise<SessionFileOwnership> {
  if (options.disowned.size === 0 || ownership.unattributed.length === 0) return ownership
  const unattributed: string[] = []
  const disowned: string[] = []
  for (const file of ownership.unattributed) {
    if (await isDisowned(file, options)) disowned.push(file)
    else unattributed.push(file)
  }
  if (disowned.length === 0) return ownership
  return {
    editedByUs: ownership.editedByUs,
    editedByOthers: [...ownership.editedByOthers, ...disowned],
    unattributed,
  }
}
