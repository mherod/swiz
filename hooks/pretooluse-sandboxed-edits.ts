#!/usr/bin/env bun

// PreToolUse hook: Block file edits outside the session's cwd and temporary directories.
// Enabled by default; disable with: swiz settings disable sandboxed-edits

import { realpath } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { readSwizSettings } from "../src/settings.ts"
import { denyPreToolUse, git, isFileEditTool, type ToolHookInput } from "./hook-utils.ts"

const input = (await Bun.stdin.json()) as ToolHookInput

if (!isFileEditTool(input.tool_name ?? "")) process.exit(0)

const filePath: string = (input.tool_input?.file_path as string | undefined) ?? ""
if (!filePath) process.exit(0)

const settings = await readSwizSettings()
if (!settings.sandboxedEdits) process.exit(0)

/** Resolve real path following all symlinks; falls back to resolve() on failure. */
async function realpathOrResolve(p: string): Promise<string> {
  try {
    return await realpath(p)
  } catch {
    return resolve(p)
  }
}

/**
 * Resolve the real path of a file that may not yet exist.
 * Walks up to the nearest existing ancestor, realpaths it, then re-appends
 * the remaining path segments. This blocks symlink escapes even for new files:
 * if a symlink inside cwd points to /etc, writing cwd/link/new-file is blocked
 * because realpath(cwd/link) resolves to /etc before the non-existent segment.
 */
async function resolveTarget(p: string): Promise<string> {
  const absolute = resolve(p)
  try {
    return await realpath(absolute)
  } catch {
    let dir = dirname(absolute)
    let rest = basename(absolute)
    while (dir !== dirname(dir)) {
      try {
        const realDir = await realpath(dir)
        return join(realDir, rest)
      } catch {
        rest = join(basename(dir), rest)
        dir = dirname(dir)
      }
    }
    return absolute
  }
}

function isWithin(parent: string, child: string): boolean {
  const prefix = parent.endsWith("/") ? parent : parent + "/"
  return child === parent || child.startsWith(prefix)
}

// Resolve all paths to their real (symlink-free) equivalents so that a
// symlink inside an allowed root cannot escape to a path outside it.
const cwd = await realpathOrResolve(resolve(input.cwd ?? process.cwd()))
const target = await resolveTarget(filePath)

const tmp = await realpathOrResolve(tmpdir())
// /tmp is a symlink on macOS (/tmp -> /private/tmp); realpath ensures the
// namespace is consistent between allowedRoots and resolved target paths.
const tmpLiteral = await realpathOrResolve("/tmp")
// ~/.claude/projects/ is always allowed: Claude Code stores per-project
// auto-memory files there (e.g. memory/MEMORY.md). Blocking it creates a
// deadlock with the memory-enforcement hook.
// Realpath HOME itself (which exists) so the prefix matches resolveTarget()
// output even when .claude/projects hasn't been created yet.
const homeReal = process.env.HOME ? await realpathOrResolve(process.env.HOME) : null
const claudeProjectsDir = homeReal ? `${homeReal}/.claude/projects` : null
const allowedRoots = [cwd, tmp, tmpLiteral, ...(claudeProjectsDir ? [claudeProjectsDir] : [])]

if (allowedRoots.some((root) => isWithin(root, target))) process.exit(0)

// Discover if the blocked path lives inside a different GitHub repo.
// Use dirname(target) — target is already the realpath, so the git walk
// correctly identifies the true owning repo even through symlinks.
let targetDir = dirname(target)
{
  const { stat } = await import("node:fs/promises")
  while (targetDir !== dirname(targetDir)) {
    try {
      await stat(targetDir)
      break
    } catch {
      targetDir = dirname(targetDir)
    }
  }
}
const repoRoot = await git(["rev-parse", "--show-toplevel"], targetDir)
let crossRepoHint = ""
if (repoRoot && repoRoot !== cwd) {
  const remoteUrl = await git(["remote", "get-url", "origin"], repoRoot)
  const match = remoteUrl.match(/github\.com[/:]([^/]+\/[^\s.]+?)(?:\.git)?$/)
  if (match?.[1]) {
    const slug = match[1]
    crossRepoHint = [
      "",
      `The blocked path is inside a different repository: ${slug}`,
      "If this change is needed, consider filing an issue there so the repo can triage it:",
      `  gh issue create --repo ${slug} --title "..." --body "..."`,
    ].join("\n")
  }
}

denyPreToolUse(
  [
    "File edit blocked: path is outside the session sandbox.",
    "",
    `  Attempted: ${target}`,
    `  Session cwd: ${cwd}`,
    "",
    "Only edits within the current project directory or temporary directories are allowed.",
    "If you need to edit a file outside the project, disable the sandbox:",
    "  swiz settings disable sandboxed-edits",
    crossRepoHint,
  ]
    .filter(Boolean)
    .join("\n")
)
