#!/usr/bin/env bun
// Stop hook: Block stop if large files (>500KB) were committed without LFS

import { blockStop, git, isGitRepo, recentHeadRange } from "./hook-utils.ts"
import { stopHookInputSchema } from "./schemas.ts"

const SIZE_LIMIT_KB = 500

async function checkFileSize(filePath: string, cwd: string): Promise<string | null> {
  const treeEntry = await git(["ls-tree", "HEAD", "--", filePath], cwd)
  if (!treeEntry) return null

  const blobHash = treeEntry.split(/\s+/)[2]
  if (!blobHash || blobHash === "0000000000000000000000000000000000000000") return null

  const sizeStr = await git(["cat-file", "-s", blobHash], cwd)
  const sizeKb = Math.floor(parseInt(sizeStr, 10) / 1024)
  if (Number.isNaN(sizeKb) || sizeKb < SIZE_LIMIT_KB) return null

  const gitattributes = await git(["show", "HEAD:.gitattributes"], cwd)
  if (gitattributes?.includes("filter=lfs")) {
    const escaped = filePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    if (new RegExp(escaped).test(gitattributes)) return null
  }

  return `${sizeKb}KB — ${filePath}`
}

async function findLargeFiles(cwd: string): Promise<string[]> {
  const range = await recentHeadRange(cwd, 10)
  const addedRaw = await git(["log", "--diff-filter=A", "--name-only", "--format=", range], cwd)
  if (!addedRaw) return []

  const addedFiles = addedRaw.split("\n").filter((l) => l.trim())
  const largeFiles: string[] = []

  for (const filePath of addedFiles) {
    const entry = await checkFileSize(filePath, cwd)
    if (entry) largeFiles.push(entry)
    if (largeFiles.length >= 10) break
  }
  return largeFiles
}

function formatLargeFilesReason(largeFiles: string[]): string {
  let reason = `Large files (>${SIZE_LIMIT_KB}KB) committed without Git LFS tracking.\n\n`
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

  const largeFiles = await findLargeFiles(cwd)
  if (largeFiles.length === 0) return

  blockStop(formatLargeFilesReason(largeFiles), { includeUpdateMemoryAdvice: false })
}

if (import.meta.main) void main()
