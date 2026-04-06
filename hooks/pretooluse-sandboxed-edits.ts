#!/usr/bin/env bun

// PreToolUse hook: Block file edits outside the session's cwd and temporary directories.
// Enabled by default; disable with: swiz settings disable sandboxed-edits
//
// Dual-mode: exports a SwizFileEditHook for inline dispatch and remains
// executable as a standalone script for backwards compatibility and testing.

import { realpath } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { git, isGitHubHost, isGitRepo, parseRemoteUrl } from "../src/git-helpers.ts"
import { getHomeDirOrNull } from "../src/home.ts"
import {
  preToolUseAllow,
  preToolUseDeny,
  runSwizHookAsMain,
  type SwizFileEditHook,
  type SwizHookOutput,
} from "../src/SwizHook.ts"
import { fileEditHookInputSchema } from "../src/schemas.ts"
import { readProjectSettings, readSwizSettings } from "../src/settings.ts"
import { isFileEditTool } from "../src/tool-matchers.ts"
import { getDefaultBranch } from "../src/utils/git-utils.ts"
import { buildIssueGuidance } from "../src/utils/inline-hook-helpers.ts"

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

/**
 * Validates whether file edits are allowed on the current branch when trunk mode is enabled.
 */
async function checkTrunkMode(cwd: string): Promise<SwizHookOutput | null> {
  if (!(await isGitRepo(cwd))) return null

  const project = await readProjectSettings(cwd)
  if (!project?.trunkMode) return null

  const defaultBranch = await getDefaultBranch(cwd)
  const currentBranch = (await git(["branch", "--show-current"], cwd)).trim()

  if (currentBranch && currentBranch !== defaultBranch) {
    return preToolUseDeny(
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

  return null
}

/**
 * Blocks direct edits to swiz config files.
 */
function checkSwizConfigEdit(filePath: string): SwizHookOutput | null {
  const SWIZ_CONFIG_RE = /(?:^|[/\\])\.swiz[/\\][^/\\]+\.json$/
  if (!SWIZ_CONFIG_RE.test(filePath)) return null

  return preToolUseDeny(
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
 * Checks if a target path is within the allowed sandbox roots (CWD, tmp, etc.).
 */
async function checkAllowedRoots(target: string, cwd: string): Promise<SwizHookOutput | null> {
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
    return preToolUseAllow(`File is within sandbox: ${target.split("/").slice(-2).join("/")}`)
  }

  return null
}

/**
 * Checks if the target path is a well-known home-directory config file.
 */
async function checkWellKnownConfig(target: string): Promise<SwizHookOutput | null> {
  const homeDir = getHomeDirOrNull()
  if (!homeDir) return null

  // Well-known home-dir config files that workflows legitimately need to modify
  // (e.g. `~/.npmrc` for npm auth). These are allowed individually to keep the
  // sandbox tight — full home-dir access is NOT granted.
  // See: https://github.com/mherod/swiz/issues/421
  const WELL_KNOWN_CONFIG_FILES = [
    ".npmrc",
    ".yarnrc",
    ".yarnrc.yml",
    ".gitconfig",
    ".gemrc",
    ".curlrc",
    ".wgetrc",
    ".netrc",
    ".docker/config.json",
    ".config/gh/config.yml",
    ".ssh/config",
    ".ssh/known_hosts",
  ]

  for (const configPath of WELL_KNOWN_CONFIG_FILES) {
    const canonical = await resolveCanonical(join(homeDir, configPath))
    if (target === canonical) {
      return preToolUseAllow(`Well-known config file: ~/${configPath}`)
    }
  }

  return null
}

/**
 * Identifies if the blocked path belongs to a different repository and provides guidance.
 */
async function getCrossRepoHint(target: string, cwd: string): Promise<string> {
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
  if (repoRoot && repoRoot !== cwd) {
    const remoteUrl = await git(["remote", "get-url", "origin"], repoRoot)
    const remote = parseRemoteUrl(remoteUrl)
    if (remote && (await isGitHubHost(remote.host))) {
      return [
        "",
        `The blocked path is inside a different repository: ${remote.slug}`,
        buildIssueGuidance(remote.slug, { crossRepo: true, hostname: remote.host }),
      ].join("\n")
    }
  }

  return ""
}

const pretooluseSandboxedEdits: SwizFileEditHook = {
  name: "pretooluse-sandboxed-edits",
  event: "preToolUse",
  matcher: "Edit|Write|NotebookEdit",
  timeout: 5,

  async run(input): Promise<SwizHookOutput> {
    const parsed = fileEditHookInputSchema.parse(input)

    if (!isFileEditTool(parsed.tool_name ?? "")) return preToolUseAllow("")

    const filePath: string = (parsed.tool_input?.file_path as string | undefined) ?? ""
    if (!filePath) return preToolUseAllow("")

    const settings = await readSwizSettings()
    if (!settings.sandboxedEdits) return preToolUseAllow("")

    const hookCwd = parsed.cwd ?? process.cwd()

    // 1. Check trunk mode
    const trunkResult = await checkTrunkMode(hookCwd)
    if (trunkResult) return trunkResult

    // 2. Block direct edits to swiz config files
    const configResult = checkSwizConfigEdit(filePath)
    if (configResult) return configResult

    // All paths are resolved through resolveCanonical so the isWithin() check
    // operates in a uniform canonical namespace — no mix of logical and real paths.
    const cwd = await resolveCanonical(hookCwd)
    const target = await resolveCanonical(filePath)

    // 3. Check allowed sandbox roots (CWD, tmp, claude projects)
    const rootsResult = await checkAllowedRoots(target, cwd)
    if (rootsResult) return rootsResult

    // 4. Check well-known home-dir config files
    const configFilesResult = await checkWellKnownConfig(target)
    if (configFilesResult) return configFilesResult

    // 5. Provide guidance for blocked paths
    const crossRepoHint = await getCrossRepoHint(target, cwd)

    return preToolUseDeny(
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
  },
}

export default pretooluseSandboxedEdits

if (import.meta.main) {
  await runSwizHookAsMain(pretooluseSandboxedEdits)
}
