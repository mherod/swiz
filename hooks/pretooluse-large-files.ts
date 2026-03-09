#!/usr/bin/env bun
// PreToolUse hook: Block file writes that would create/update a file exceeding
// the large-file threshold (500KB) without Git LFS tracking.
//
// Mirrors the size limit from stop-large-files.ts so both hooks stay in sync.
// For Write: measures content directly.
// For Edit: reads current file, applies old→new replacement, measures result.
// For NotebookEdit: skipped (final size not determinable pre-write).
//
// LFS exemption: reads .gitattributes from disk (not from git history) so
// uncommitted LFS rules added in the same session are respected.

import {
  DEFAULT_LARGE_FILE_SIZE_KB,
  readProjectSettings,
  readSwizSettings,
} from "../src/settings.ts"
import { allowPreToolUse, denyPreToolUse, isEditTool, isWriteTool } from "./hook-utils.ts"
import { fileEditHookInputSchema } from "./schemas.ts"

/** Resolve the large-file size limit: project > global > default (500KB). */
async function resolveSizeLimitKb(cwd: string): Promise<number> {
  const [globalSettings, projectSettings] = await Promise.all([
    readSwizSettings(),
    readProjectSettings(cwd),
  ])
  return (
    projectSettings?.largeFileSizeKb ?? globalSettings.largeFileSizeKb ?? DEFAULT_LARGE_FILE_SIZE_KB
  )
}

/**
 * Returns true if the given file path is covered by a Git LFS rule in
 * the .gitattributes file at the repo root (or the provided cwd).
 */
async function isLfsTracked(filePath: string, cwd: string): Promise<boolean> {
  // Look for .gitattributes in cwd and its parents (up to 5 levels)
  let dir = cwd
  for (let i = 0; i < 5; i++) {
    const attrPath = `${dir}/.gitattributes`
    const file = Bun.file(attrPath)
    if (await file.exists()) {
      const content = await file.text()
      // Only care about lines that reference LFS
      const lfsLines = content.split("\n").filter((l) => l.includes("filter=lfs"))
      for (const line of lfsLines) {
        const pattern = line.split(/\s+/)[0]
        if (!pattern || pattern.startsWith("#")) continue
        // Convert gitattributes glob to a simple regex:
        // *.ext → any file ending with .ext
        // Handles: *.png, **/*.png, path/to/*.bin
        const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")
        if (new RegExp(escaped).test(filePath)) return true
      }
      break
    }
    const parent = dir.split("/").slice(0, -1).join("/")
    if (!parent || parent === dir) break
    dir = parent
  }
  return false
}

async function main() {
  const input = fileEditHookInputSchema.parse(await Bun.stdin.json())

  const toolName = input.tool_name ?? ""
  const filePath = input.tool_input?.file_path ?? ""
  const cwd = input.cwd ?? process.cwd()

  // Only guard Edit and Write (NotebookEdit: final size not determinable)
  if (!isEditTool(toolName) && !isWriteTool(toolName)) {
    allowPreToolUse("")
  }

  const sizeLimitKb = await resolveSizeLimitKb(cwd)
  const sizeLimitBytes = sizeLimitKb * 1024

  // Read current file content for size projection
  let currentContent = ""
  try {
    currentContent = await Bun.file(filePath).text()
  } catch {
    // File doesn't exist yet (Write to new file)
    currentContent = ""
  }

  // Project content after the edit
  let projectedContent: string
  if (isEditTool(toolName)) {
    const oldString = input.tool_input?.old_string ?? ""
    const newString = input.tool_input?.new_string ?? ""
    projectedContent = currentContent.replace(oldString, newString)
  } else {
    // Write: use the new content directly
    projectedContent = input.tool_input?.content ?? ""
  }

  const projectedBytes = new TextEncoder().encode(projectedContent).length

  if (projectedBytes <= sizeLimitBytes) {
    allowPreToolUse("")
  }

  // File would exceed limit — check if it's LFS-tracked
  if (await isLfsTracked(filePath, cwd)) {
    allowPreToolUse("")
  }

  const projectedKb = Math.round(projectedBytes / 1024)
  const currentBytes = new TextEncoder().encode(currentContent).length
  const currentKb = Math.round(currentBytes / 1024)

  const reason = [
    `Large file write blocked: result would be ${projectedKb}KB (limit: ${sizeLimitKb}KB).`,
    "",
    `Current size: ${currentKb}KB`,
    `Projected size: ${projectedKb}KB`,
    `Limit: ${sizeLimitKb}KB`,
    "",
    "Options:",
    '  1. Track this file with Git LFS: git lfs track "<pattern>" && git add .gitattributes',
    "  2. Split large content across multiple smaller files",
    "  3. Store large binary assets outside the repository (cloud storage, CDN)",
    "",
    "If this file should be LFS-tracked, add the pattern to .gitattributes first,",
    "then retry the write.",
  ].join("\n")

  denyPreToolUse(reason)
}

if (import.meta.main) {
  main().catch((e) => {
    console.error("Hook error:", e)
    process.exit(1)
  })
}
