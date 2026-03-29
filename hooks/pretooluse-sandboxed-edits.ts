#!/usr/bin/env bun

// PreToolUse hook: Block file edits outside the session's cwd and temporary directories.
// Enabled by default; disable with: swiz settings disable sandboxed-edits

import { realpath } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { getHomeDirOrNull } from "../src/home.ts"
import { readProjectSettings, readSwizSettings } from "../src/settings.ts"
import { getDefaultBranch } from "../src/utils/git-utils.ts"
import {
  allowPreToolUse,
  buildIssueGuidance,
  denyPreToolUse,
  git,
  isFileEditTool,
  isGitHubHost,
  isGitRepo,
  parseRemoteUrl,
} from "../src/utils/hook-utils.ts"
import { toolHookInputSchema } from "./schemas.ts"

const input = toolHookInputSchema.parse(await Bun.stdin.json())

if (!isFileEditTool(input.tool_name ?? "")) process.exit(0)

const filePath: string = (input.tool_input?.file_path as string | undefined) ?? ""
if (!filePath) process.exit(0)

const settings = await readSwizSettings()
if (!settings.sandboxedEdits) process.exit(0)

// When trunk mode is enabled, block edits if the current branch is not the
// default branch. This prevents accidental work on stale feature branches
// when the project expects all commits on the trunk.
const hookCwd = input.cwd ?? process.cwd()
if (await isGitRepo(hookCwd)) {
  const project = await readProjectSettings(hookCwd)
  if (project?.trunkMode) {
    const defaultBranch = await getDefaultBranch(hookCwd)
    const currentBranch = (await git(["branch", "--show-current"], hookCwd)).trim()
    if (currentBranch && currentBranch !== defaultBranch) {
      denyPreToolUse(
        [
          "Trunk mode is enabled — file edits are blocked on non-default branches.",
          "",
          `  Current branch: ${currentBranch}`,
          `  Default branch: ${defaultBranch}`,
          "",
          `Switch to the default branch first: git checkout ${defaultBranch}`,
        ].join("\n")
      )
    }
  }
}

// Block direct edits to swiz config files even when the path is within the sandbox.
// Agents must use `swiz settings` / `swiz state` — direct JSON edits bypass all
// setting validation, schema enforcement, and hook-level guards.
const SWIZ_CONFIG_RE = /(?:^|[/\\])\.swiz[/\\][^/\\]+\.json$/
if (SWIZ_CONFIG_RE.test(filePath)) {
  denyPreToolUse(
    [
      "Editing swiz config files directly is not permitted.",
      "",
      `  Attempted: ${filePath}`,
      "",
      "Use the swiz CLI instead:",
      "  swiz settings set <key> <value>",
      "  swiz settings enable <setting>",
      "  swiz settings disable <setting>",
      "  swiz state set <state>",
    ].join("\n")
  )
}

/**
 * Resolve the canonical (real) path for any path, whether or not it exists.
 *
 * Algorithm:
 *   1. Attempt fs.realpath() on the full path — succeeds for existing paths,
 *      following every symlink in the chain recursively (handles chained symlinks).
 *   2. If the path doesn't exist, walk up to the nearest existing ancestor,
 *      realpath() that ancestor, then re-append the remaining segments.
 *
 * This ensures ALL path comparisons operate in a consistent canonical namespace,
 * preventing bypass via:
 *   - Chained symlinks  (link1→link2→/outside): realpath() follows every hop
 *   - Symlinks in allowed roots (tmpdir→/private/tmp on macOS): all roots use
 *     the same resolution so isWithin() comparisons are always apples-to-apples
 *   - New-file creation through a symlink dir (cwd/link/new.ts where link→/etc):
 *     realpath(cwd/link) resolves to /etc before the non-existent file segment
 */
async function resolveCanonical(p: string): Promise<string> {
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
  const prefix = parent.endsWith("/") ? parent : `${parent}/`
  return child === parent || child.startsWith(prefix)
}

// All paths are resolved through resolveCanonical so the isWithin() check
// operates in a uniform canonical namespace — no mix of logical and real paths.
const cwd = await resolveCanonical(input.cwd ?? process.cwd())
const target = await resolveCanonical(filePath)

// /tmp is a symlink on macOS (/tmp → /private/tmp); resolveCanonical gives the
// real path so the namespace stays consistent with the resolved target.
const tmp = await resolveCanonical(tmpdir())
const tmpLiteral = await resolveCanonical("/tmp")
// ~/.claude/projects/ is always allowed: Claude Code stores per-project
// auto-memory files there (e.g. memory/MEMORY.md). Blocking it creates a
// deadlock with the memory-enforcement hook.
// resolveCanonical walks up to HOME (which exists) when .claude/projects
// hasn't been created yet, ensuring the prefix always matches the target's
// canonical form.
const homeDir = getHomeDirOrNull()
const claudeProjectsDir = homeDir ? await resolveCanonical(`${homeDir}/.claude/projects`) : null
const allowedRoots = [cwd, tmp, tmpLiteral, ...(claudeProjectsDir ? [claudeProjectsDir] : [])]

if (allowedRoots.some((root) => isWithin(root, target))) {
  allowPreToolUse(`File is within sandbox: ${target.split("/").slice(-2).join("/")}`)
}

// Discover if the blocked path lives inside a different GitHub repo.
// dirname(target) is already canonical so the git walk identifies the true
// owning repo even when the path arrived through symlinks.
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
  const remote = parseRemoteUrl(remoteUrl)
  if (remote && (await isGitHubHost(remote.host))) {
    crossRepoHint = [
      "",
      `The blocked path is inside a different repository: ${remote.slug}`,
      buildIssueGuidance(remote.slug, { crossRepo: true, hostname: remote.host }),
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
    buildIssueGuidance(null),
    crossRepoHint,
  ]
    .filter(Boolean)
    .join("\n")
)
