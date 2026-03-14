#!/usr/bin/env bun
// Stop hook: Block stop if large files exceeding the configured threshold were committed without LFS.
// Threshold is configurable via `swiz settings set large-file-size-kb <N>`.

import { DEFAULT_LARGE_FILE_SIZE_KB, resolveNumericSetting } from "../src/settings.ts"
import { blockStop, git, isGitRepo, recentHeadRange } from "./hook-utils.ts"
import { stopHookInputSchema } from "./schemas.ts"

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

async function findLargeFiles(cwd: string, sizeLimitKb: number): Promise<string[]> {
  const range = await recentHeadRange(cwd, 10)
  const addedRaw = await git(["log", "--diff-filter=A", "--name-only", "--format=", range], cwd)
  if (!addedRaw) return []

  const addedFiles = addedRaw.split("\n").filter((l) => l.trim())
  const largeFiles: string[] = []

  for (const filePath of addedFiles) {
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

  const sizeLimitKb = await resolveNumericSetting(
    cwd,
    "largeFileSizeKb",
    DEFAULT_LARGE_FILE_SIZE_KB
  )
  const largeFiles = await findLargeFiles(cwd, sizeLimitKb)
  if (largeFiles.length === 0) return

  blockStop(formatLargeFilesReason(largeFiles, sizeLimitKb), { includeUpdateMemoryAdvice: false })
}

if (import.meta.main) void main()
