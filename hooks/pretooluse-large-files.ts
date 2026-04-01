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
//
// Dual-mode: exports a SwizFileEditHook for inline dispatch and remains
// executable as a standalone script for backwards compatibility and testing.

import {
  preToolUseAllow,
  preToolUseDeny,
  runSwizHookAsMain,
  type SwizFileEditHook,
} from "../src/SwizHook.ts"
import {
  DEFAULT_LARGE_FILE_SIZE_KB,
  getEffectiveSwizSettings,
  readProjectSettings,
  readSwizSettings,
  resolveNumericSetting,
} from "../src/settings.ts"
import { isEditTool, isWriteTool } from "../src/tool-matchers.ts"
import { computeProjectedContent } from "../src/utils/edit-projection.ts"
import { fileEditHookInputSchema } from "./schemas.ts"

/** Find .gitattributes content searching cwd and up to 5 parent directories. */
async function findGitattributesLfsLines(cwd: string): Promise<string[]> {
  let dir = cwd
  for (let i = 0; i < 5; i++) {
    const attrPath = `${dir}/.gitattributes`
    const file = Bun.file(attrPath)
    if (await file.exists()) {
      const content = await file.text()
      return content.split("\n").filter((l) => l.includes("filter=lfs"))
    }
    const parent = dir.split("/").slice(0, -1).join("/")
    if (!parent || parent === dir) break
    dir = parent
  }
  return []
}

/** Returns true if the repo has any Git LFS tracking rules in .gitattributes. */
async function repoHasLfs(cwd: string): Promise<boolean> {
  const lfsLines = await findGitattributesLfsLines(cwd)
  return lfsLines.some((l) => {
    const pattern = l.split(/\s+/)[0]
    return pattern && !pattern.startsWith("#")
  })
}

/**
 * Returns true if the given file path is covered by a Git LFS rule in
 * the .gitattributes file at the repo root (or the provided cwd).
 */
async function isLfsTracked(filePath: string, cwd: string): Promise<boolean> {
  const lfsLines = await findGitattributesLfsLines(cwd)
  for (const line of lfsLines) {
    const pattern = line.split(/\s+/)[0]
    if (!pattern || pattern.startsWith("#")) continue
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")
    if (new RegExp(escaped).test(filePath)) return true
  }
  return false
}

async function checkFileSizeAllowed(
  toolName: string,
  filePath: string,
  toolInput: Record<string, any>,
  cwd: string
): Promise<{ allowed: boolean; projectedKb?: number; sizeLimitKb?: number }> {
  if (!isEditTool(toolName) && !isWriteTool(toolName)) {
    return { allowed: true }
  }

  const sizeLimitKb = await resolveNumericSetting(
    cwd,
    "largeFileSizeKb",
    DEFAULT_LARGE_FILE_SIZE_KB
  )
  const sizeLimitBytes = sizeLimitKb * 1024
  const projectedContent = await computeProjectedContent(toolName, filePath, toolInput)
  if (projectedContent === null) return { allowed: true }

  const projectedBytes = new TextEncoder().encode(projectedContent).length

  if (projectedBytes <= sizeLimitBytes) {
    return { allowed: true }
  }

  if (await isLfsTracked(filePath, cwd)) {
    return { allowed: true }
  }

  const projectedKb = Math.round(projectedBytes / 1024)
  return { allowed: false, projectedKb, sizeLimitKb }
}

const pretooluseLargeFiles: SwizFileEditHook = {
  name: "pretooluse-large-files",
  event: "preToolUse",
  matcher: "Edit|Write|NotebookEdit",
  timeout: 5,

  async run(input) {
    const parsed = fileEditHookInputSchema.parse(input)

    const toolName = parsed.tool_name ?? ""
    const filePath = parsed.tool_input?.file_path ?? ""
    const cwd = parsed.cwd ?? process.cwd()

    // Skip large-file enforcement in collaborative repos unless LFS is already configured
    const [globalSettings, projectSettings] = await Promise.all([
      readSwizSettings(),
      readProjectSettings(cwd),
    ])
    const effective = getEffectiveSwizSettings(globalSettings, null, projectSettings)
    if (effective.collaborationMode === "team" && !(await repoHasLfs(cwd))) {
      return preToolUseAllow("")
    }

    const check = await checkFileSizeAllowed(toolName, filePath, parsed.tool_input ?? {}, cwd)

    if (check.allowed) {
      return preToolUseAllow("")
    }

    const projectedKb = check.projectedKb!
    const sizeLimitKb = check.sizeLimitKb!

    return preToolUseDeny(
      [
        `Large file write blocked: result would be ${projectedKb}KB (limit: ${sizeLimitKb}KB).`,
        "",
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
    )
  },
}

export default pretooluseLargeFiles

// ─── Standalone execution (file-based dispatch / manual testing) ────────────
if (import.meta.main) await runSwizHookAsMain(pretooluseLargeFiles)
