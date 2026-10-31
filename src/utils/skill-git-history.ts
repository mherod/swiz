import { existsSync } from "node:fs"
import { getGitClient } from "../git/client.ts"

// ─── Per-skill git history ───────────────────────────────────────────────────
//
// Skill roots such as ~/.claude/skills are often git checkouts. Their history is
// the strongest evidence of which side of a sync conflict is newer: a copy whose
// bytes match an older commit is stale, whatever its mtime says.

export interface SkillFileVersion {
  /** Commit that introduced this content. */
  sha: string
  /** Commit time in epoch milliseconds. */
  date: number
  /** Git blob id of the content. */
  blob: string
}

export interface SkillFileRemoval {
  sha: string
  date: number
}

export interface SkillHistory {
  /** Versions of a skill-relative path on HEAD, newest first; empty when untracked. */
  versions(relativePath: string): Promise<SkillFileVersion[]>
  /**
   * The commit that deleted a path, when deletion is its newest recorded event.
   * A file merely missing from a dirty checkout is not a recorded removal.
   */
  removal(relativePath: string): Promise<SkillFileRemoval | null>
  /** Text of a historical blob; "" when it cannot be read. */
  readBlob(blob: string): Promise<string>
}

export const EMPTY_SKILL_HISTORY: SkillHistory = {
  versions: () => Promise.resolve([]),
  removal: () => Promise.resolve(null),
  readBlob: () => Promise.resolve(""),
}

/** Git's object id for file content, computed without spawning git. */
export function gitBlobId(bytes: Uint8Array): string {
  const hasher = new Bun.CryptoHasher("sha1")
  hasher.update(`blob ${bytes.byteLength}\u0000`)
  hasher.update(bytes)
  return hasher.digest("hex")
}

const ZERO_BLOB_RE = /^0+$/

export interface ParsedSkillLog {
  versions: Map<string, SkillFileVersion[]>
  removals: Map<string, SkillFileRemoval>
}

/**
 * Parse `git log --format=C%x09%H%x09%ct --raw --no-abbrev` output into
 * skill-relative path → versions (newest first) and paths whose newest event is
 * a deletion. Raw paths are relative to the repository root, so `prefix` (from
 * `rev-parse --show-prefix`) is stripped.
 */
export function parseSkillLog(output: string, prefix: string): ParsedSkillLog {
  const parsed: ParsedSkillLog = { versions: new Map(), removals: new Map() }
  const seen = new Set<string>()
  let commit: SkillFileRemoval | null = null
  for (const line of output.split("\n")) {
    if (line.startsWith("C\t")) {
      const [, sha = "", seconds = "0"] = line.split("\t")
      commit = { sha, date: Number(seconds) * 1000 }
    } else if (line.startsWith(":") && commit) {
      recordRawLine(parsed, seen, { line, prefix, commit })
    }
  }
  return parsed
}

/** Record one `:old new oldBlob newBlob status\tpath` line; newest events arrive first. */
function recordRawLine(
  parsed: ParsedSkillLog,
  seen: Set<string>,
  entry: { line: string; prefix: string; commit: SkillFileRemoval }
): void {
  const { line, prefix, commit } = entry
  const tab = line.indexOf("\t")
  const blob = line.slice(0, tab).split(" ")[3] ?? ""
  const repoPath = line.slice(tab + 1)
  if (!repoPath.startsWith(prefix)) return
  const relativePath = repoPath.slice(prefix.length)
  const newest = !seen.has(relativePath)
  seen.add(relativePath)
  if (ZERO_BLOB_RE.test(blob)) {
    if (newest) parsed.removals.set(relativePath, commit)
    return
  }
  const list = parsed.versions.get(relativePath) ?? []
  list.push({ ...commit, blob })
  parsed.versions.set(relativePath, list)
}

/** Load HEAD history for one skill directory; outside git, untracked, or missing it is empty. */
export async function loadSkillHistory(skillDir: string): Promise<SkillHistory> {
  try {
    return await readSkillHistory(skillDir)
  } catch {
    // git missing or an unusable cwd: no history is evidence of nothing.
    return EMPTY_SKILL_HISTORY
  }
}

async function readSkillHistory(skillDir: string): Promise<SkillHistory> {
  if (!existsSync(skillDir)) return EMPTY_SKILL_HISTORY
  const client = getGitClient()
  const prefix = await client.run(["rev-parse", "--show-prefix"], { cwd: skillDir })
  if (prefix.exitCode !== 0) return EMPTY_SKILL_HISTORY
  const log = await client.run(
    [
      "-c",
      "core.quotePath=false",
      "log",
      "--format=C%x09%H%x09%ct",
      "--raw",
      "--no-abbrev",
      "--no-renames",
      "--",
      ".",
    ],
    { cwd: skillDir }
  )
  if (log.exitCode !== 0) return EMPTY_SKILL_HISTORY
  const { versions, removals } = parseSkillLog(log.stdout, prefix.stdout.trim())
  if (versions.size === 0 && removals.size === 0) return EMPTY_SKILL_HISTORY

  const blobs = new Map<string, Promise<string>>()
  return {
    versions: (relativePath) => Promise.resolve(versions.get(relativePath) ?? []),
    removal: (relativePath) => Promise.resolve(removals.get(relativePath) ?? null),
    readBlob(blob) {
      let text = blobs.get(blob)
      if (!text) {
        text = client
          .run(["cat-file", "blob", blob], { cwd: skillDir })
          .then((result) => (result.exitCode === 0 ? result.stdout : ""))
        blobs.set(blob, text)
      }
      return text
    },
  }
}

/** Defer loading until a file actually needs history evidence. */
export function lazySkillHistory(skillDir: string): SkillHistory {
  let loaded: Promise<SkillHistory> | null = null
  const get = () => (loaded ??= loadSkillHistory(skillDir))
  return {
    versions: async (relativePath) => (await get()).versions(relativePath),
    removal: async (relativePath) => (await get()).removal(relativePath),
    readBlob: async (blob) => (await get()).readBlob(blob),
  }
}
