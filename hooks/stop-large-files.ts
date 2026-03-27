#!/usr/bin/env bun
// Stop hook: Block stop if large files exceeding the configured threshold were committed without LFS.
// Threshold is configurable via `swiz settings set large-file-size-kb <N>`.

import {
  DEFAULT_LARGE_FILE_SIZE_KB,
  getEffectiveSwizSettings,
  readProjectSettings,
  readSwizSettings,
  resolveNumericSetting,
} from "../src/settings.ts"
import { stopHookInputSchema } from "./schemas.ts"
import { blockStop, git, isGitRepo, recentHeadRange } from "./utils/hook-utils.ts"

async function checkFileSize(
  filePath: string,
  cwd: string,
  sizeLimitKb: number
): Promise<string | null> {
  const treeEntry = await git(["ls-tree", "HEAD", "--", filePath], cwd)
  if (!treeEntry) return null

  const blobHash = treeEntry.split(/\s+/)[2]
  if (!blobHash || blobHash === "0000000000000000000000000000000000000000") return null

  const sizeStr = await git(["cat-file", "-s", blobHash], cwd)
  const sizeKb = Math.floor(parseInt(sizeStr, 10) / 1024)
  if (Number.isNaN(sizeKb) || sizeKb < sizeLimitKb) return null

  const gitattributes = await git(["show", "HEAD:.gitattributes"], cwd)
  if (gitattributes?.includes("filter=lfs")) {
    const escaped = filePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    if (new RegExp(escaped).test(gitattributes)) return null
  }

  return `${sizeKb}KB — ${filePath}`
}

/** Check if a file path matches any of the allow patterns (simple glob: * matches within segment, ** matches across segments). */
function isAllowed(filePath: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    // Convert simple glob to regex: ** → .*, * → [^/]*, ? → [^/]
    const re = new RegExp(
      `^${pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*/g, "⬛")
        .replace(/\*/g, "[^/]*")
        .replace(/⬛/g, ".*")
        .replace(/\?/g, "[^/]")}$`
    )
    if (re.test(filePath)) return true
  }
  return false
}

async function findLargeFiles(
  cwd: string,
  sizeLimitKb: number,
  allowPatterns: string[]
): Promise<string[]> {
  const range = await recentHeadRange(cwd, 10)
  const addedRaw = await git(["log", "--diff-filter=A", "--name-only", "--format=", range], cwd)
  if (!addedRaw) return []

  const addedFiles = addedRaw.split("\n").filter((l) => l.trim())
  const largeFiles: string[] = []

  for (const filePath of addedFiles) {
    if (allowPatterns.length > 0 && isAllowed(filePath, allowPatterns)) continue
    const entry = await checkFileSize(filePath, cwd, sizeLimitKb)
    if (entry) largeFiles.push(entry)
    if (largeFiles.length >= 10) break
  }
  return largeFiles
}

function formatLargeFilesReason(largeFiles: string[], sizeLimitKb: number): string {
  let reason = `Large files (>${sizeLimitKb}KB) committed without Git LFS tracking.\n\n`
  reason += "Files:\n"
  for (const f of largeFiles) reason += `  ${f}\n`
  reason +=
    "\nConsider adding these to Git LFS or removing them from the repository. Large committed files bloat git history permanently."
  return reason
}

async function main(): Promise<void> {
  const input = stopHookInputSchema.parse(await Bun.stdin.json())
  const cwd = input.cwd ?? process.cwd()

  if (!(await isGitRepo(cwd))) return

  // Skip large-file enforcement in collaborative repos unless LFS is already configured
  const [globalSettings, projectSettings] = await Promise.all([
    readSwizSettings(),
    readProjectSettings(cwd),
  ])
  const effective = getEffectiveSwizSettings(globalSettings, null, projectSettings)
  if (effective.collaborationMode === "team") {
    const gitattributes = await git(["show", "HEAD:.gitattributes"], cwd)
    if (!gitattributes?.includes("filter=lfs")) return
  }

  const sizeLimitKb = await resolveNumericSetting(
    cwd,
    "largeFileSizeKb",
    DEFAULT_LARGE_FILE_SIZE_KB
  )
  const allowPatterns = projectSettings?.largeFileAllowPatterns ?? []
  const largeFiles = await findLargeFiles(cwd, sizeLimitKb, allowPatterns)
  if (largeFiles.length === 0) return

  blockStop(formatLargeFilesReason(largeFiles, sizeLimitKb), { includeUpdateMemoryAdvice: false })
}

if (import.meta.main) void main()
