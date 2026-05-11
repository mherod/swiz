#!/usr/bin/env bun

// PreToolUse hook: Block file edits outside the session's cwd and temporary directories.
// Enabled by default; disable with: swiz settings disable sandboxed-edits
//
// Dual-mode: exports a SwizFileEditHook for inline dispatch and remains
// executable as a standalone script for backwards compatibility and testing.

import { tmpdir } from "node:os"
import { dirname } from "node:path"
import { git, isGitHubHost, isGitRepo, parseRemoteUrl } from "../src/git-helpers.ts"
import { getHomeDirOrNull } from "../src/home.ts"
import { runSwizHookAsMain, type SwizFileEditHook, type SwizHookOutput } from "../src/SwizHook.ts"
import { fileEditHookInputSchema } from "../src/schemas.ts"
import { readProjectSettings, readSwizSettings } from "../src/settings.ts"
import { isFileEditTool } from "../src/tool-matchers.ts"
import { getDefaultBranch } from "../src/utils/git-utils.ts"
import { preToolUseAllow, preToolUseDeny } from "../src/utils/hook-utils.ts"
import { buildIssueGuidance } from "../src/utils/inline-hook-helpers.ts"
import { isHiddenTopLevelHomePath, resolveCanonical } from "./sandbox-path-utils.ts"

function isWithin(parent: string, child: string): boolean {
  const normalizedParent = parent.replace(/\\/g, "/")
  const normalizedChild = child.replace(/\\/g, "/")
  const prefix = normalizedParent.endsWith("/") ? normalizedParent : `${normalizedParent}/`
  return normalizedChild === normalizedParent || normalizedChild.startsWith(prefix)
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

  const allowedRoots = [cwd, tmp, tmpLiteral]

  if (allowedRoots.some((root) => isWithin(root, target))) {
    return preToolUseAllow(
      `Continue in sandboxed-edit mode: ${target.split("/").slice(-2).join("/")} is within the session sandbox.`
    )
  }

  return null
}

/**
 * Checks if the target path is a hidden top-level home-directory path.
 * Hidden paths are blocked unless the dispatch was launched from that same
 * hidden root (or a child of it).
 */
async function checkHiddenHomePath(target: string, cwd: string): Promise<SwizHookOutput | null> {
  const homeDir = getHomeDirOrNull()
  if (!homeDir) return null
  const canonicalHome = await resolveCanonical(homeDir)
  if (!isHiddenTopLevelHomePath(target, canonicalHome)) return null

  const normalizedTarget = target.replace(/\\/g, "/")
  const normalizedHome = canonicalHome.replace(/\\/g, "/").replace(/\/$/, "")
  const hiddenRoot = `${normalizedHome}/${normalizedTarget.slice(normalizedHome.length + 1).split("/")[0]}`
  if (isWithin(hiddenRoot, cwd)) return null

  return preToolUseDeny(
    [
      "Hidden home-directory edits are blocked in sandbox mode.",
      "",
      `  Attempted: ${target}`,
      `  Session cwd: ${cwd}`,
      "",
      "You can only edit hidden home-directory paths when the sandbox dispatcher",
      "is running inside that same hidden root.",
    ].join("\n")
  )
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

    // 3. Check for blocked hidden home-directory paths before broad sandbox roots.
    const hiddenHomePathResult = await checkHiddenHomePath(target, cwd)
    if (hiddenHomePathResult) return hiddenHomePathResult

    // 4. Check allowed sandbox roots (CWD, tmp)
    const rootsResult = await checkAllowedRoots(target, cwd)
    if (rootsResult) return rootsResult

    // 5. Provide guidance for blocked paths
    const crossRepoHint = await getCrossRepoHint(target, cwd)

    return preToolUseDeny(
      [
        "File edit blocked: path is outside the session sandbox.",
        "",
        `  Attempted: ${target}`,
        `  Session cwd: ${cwd}`,
        "",
        "Sandboxed-edits mode is enabled: only edits within the current project directory or temporary directories are allowed.",
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
