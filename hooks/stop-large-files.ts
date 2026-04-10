#!/usr/bin/env bun

// Stop hook: Block stop if large files exceeding the configured threshold were committed without LFS.
// Threshold is configurable via `swiz settings set large-file-size-kb <N>`.
//
// Dual-mode: SwizStopHook for inline dispatch + subprocess via runSwizHookAsMain.

import type { SwizHookOutput, SwizStopHook } from "../src/SwizHook.ts"
import { runSwizHookAsMain } from "../src/SwizHook.ts"
import { type StopHookInput, stopHookInputSchema } from "../src/schemas.ts"
import {
  DEFAULT_LARGE_FILE_SIZE_KB,
  getEffectiveSwizSettings,
  readProjectSettings,
  readSwizSettings,
  resolveNumericSetting,
} from "../src/settings.ts"
import { blockStopObj, git, isGitRepo, recentHeadRange } from "../src/utils/hook-utils.ts"

/** Parse one line of `git ls-tree` output into [name, blobHash]. */
function parseLsTreeLine(line: string): [string, string] | null {
  const match = line.match(/^(\S+)\s+blob\s+(\S+)\s+(.*)$/)
  if (match) return [match[3]!, match[2]!]
  return null
}

/** Parse per-blob size from `git cat-file --batch` output. */
function parseCatFileBatch(raw: string): Map<string, number> {
  const sizes = new Map<string, number>()
  for (const line of raw.split("\n")) {
    const m = line.match(/^([0-9a-f]{40}) blob (\d+)$/)
    if (m) sizes.set(m[1]!, parseInt(m[2]!, 10))
  }
  return sizes
}

/** If the file exceeds the size limit and isn't LFS-tracked, return the reason string. */
function classifyFileSize(
  hash: string,
  name: string,
  sizes: Map<string, number>,
  limitKb: number,
  gitattributes: string
): string | null {
  const byteSize = sizes.get(hash)
  if (!byteSize) return null
  const sizeKb = Math.floor(byteSize / 1024)
  if (sizeKb < limitKb) return null
  if (isLfsTracked(name, gitattributes)) return null
  return `${sizeKb}KB — ${name}`
}

function isLfsTracked(name: string, gitattributes: string): boolean {
  if (!gitattributes.includes("filter=lfs")) return false
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(escaped).test(gitattributes)
}

async function checkFileSizes(
  fileCandidates: string[],
  cwd: string,
  sizeLimitKb: number,
  gitattributes: string | null
): Promise<string[]> {
  if (fileCandidates.length === 0) return []

  // Batch git ls-tree for all files
  const treeRaw = await git(["ls-tree", "HEAD", "--", ...fileCandidates], cwd)
  if (!treeRaw) return []

  const entries = treeRaw
    .split("\n")
    .map(parseLsTreeLine)
    .filter((e): e is [string, string] => e !== null)
  const validEntries = entries.filter(([, h]) => h !== "0000000000000000000000000000000000000000")
  if (validEntries.length === 0) return []

  // Batch git cat-file --batch for all blob sizes
  const batchInput = `${validEntries.map(([, h]) => h).join("\n")}\n`
  const catProc = Bun.spawn(["git", "cat-file", "--batch"], {
    cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  await catProc.stdin!.write(new TextEncoder().encode(batchInput))
  await catProc.stdin!.end()
  await catProc.exited
  const catRaw = await new Response(catProc.stdout).text()
  if (catRaw.trim().length === 0) return []

  const sizes = parseCatFileBatch(catRaw)
  const largeFiles: string[] = []

  const limit = sizeLimitKb
  const attributes = gitattributes ?? ""
  for (const [name, hash] of validEntries) {
    const result = classifyFileSize(hash, name, sizes, limit, attributes)
    if (!result) continue
    largeFiles.push(result)
    if (largeFiles.length >= 10) break
  }
  return largeFiles
}

function isAllowed(filePath: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
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
  if (addedFiles.length === 0) return []

  // Read .gitattributes once (cached for all files)
  const gitattributes = await git(["show", "HEAD:.gitattributes"], cwd)

  // Filter allowed files before batching
  const candidates =
    allowPatterns.length > 0 ? addedFiles.filter((f) => !isAllowed(f, allowPatterns)) : addedFiles

  return await checkFileSizes(candidates, cwd, sizeLimitKb, gitattributes)
}

function formatLargeFilesReason(largeFiles: string[], sizeLimitKb: number): string {
  let reason = `Large files (>${sizeLimitKb}KB) committed without Git LFS tracking.\n\n`
  reason += "Files:\n"
  for (const f of largeFiles) reason += `  ${f}\n`
  reason +=
    "\nConsider adding these to Git LFS or removing them from the repository. Large committed files bloat git history permanently."
  return reason
}

export async function evaluateStopLargeFiles(input: StopHookInput): Promise<SwizHookOutput> {
  const parsed = stopHookInputSchema.parse(input)
  const cwd = parsed.cwd ?? process.cwd()

  if (!(await isGitRepo(cwd))) return {}

  const [globalSettings, projectSettings] = await Promise.all([
    readSwizSettings(),
    readProjectSettings(cwd),
  ])
  const effective = getEffectiveSwizSettings(globalSettings, null, projectSettings)
  if (effective.collaborationMode === "team") {
    const gitattributes = await git(["show", "HEAD:.gitattributes"], cwd)
    if (!gitattributes?.includes("filter=lfs")) return {}
  }

  const sizeLimitKb = await resolveNumericSetting(
    cwd,
    "largeFileSizeKb",
    DEFAULT_LARGE_FILE_SIZE_KB
  )
  const allowPatterns = projectSettings?.largeFileAllowPatterns ?? []
  const largeFiles = await findLargeFiles(cwd, sizeLimitKb, allowPatterns)
  if (largeFiles.length === 0) return {}

  return blockStopObj(formatLargeFilesReason(largeFiles, sizeLimitKb))
}

const stopLargeFiles: SwizStopHook = {
  name: "stop-large-files",
  event: "stop",
  timeout: 10,

  run(input) {
    return evaluateStopLargeFiles(input)
  },
}

export default stopLargeFiles

if (import.meta.main) {
  await runSwizHookAsMain(stopLargeFiles)
}
